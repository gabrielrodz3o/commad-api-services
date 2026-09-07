import { registerAction, type PrepareResult } from './registry.js'
import type { ActionContext } from './context.js'
import { fetchFromCore } from '../core/client.js'
import { findAccountingAccounts, getManualJournalConfig } from '../db/accounting.js'

registerAction({
  type: 'create_accounting_journal_draft',
  description:
    'Propone un BORRADOR de asiento contable manual, nunca lo publica. Úsala solo cuando el usuario pida preparar/crear un asiento y proporcione concepto, fecha, cuentas y débitos/créditos. Las sumas deben cuadrar. Si faltan datos, pregunta antes. La confirmación crea únicamente un borrador para revisión del contador.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['effective_date', 'concept', 'lines'],
    properties: {
      effective_date: { type: 'string', description: 'Fecha contable YYYY-MM-DD.' },
      concept: { type: 'string', description: 'Concepto general claro y auditable.' },
      lines: {
        type: 'array', minItems: 2, maxItems: 20,
        items: {
          type: 'object', additionalProperties: false, required: ['account', 'debit', 'credit'],
          properties: {
            account: { type: 'string', description: 'Código o nombre exacto de la cuenta.' },
            debit: { type: 'number', minimum: 0 },
            credit: { type: 'number', minimum: 0 },
            note: { type: 'string' },
          },
        },
      },
    },
  },

  async prepare(args: any, ctx: ActionContext): Promise<PrepareResult> {
    if (!ctx.businessUnitId) return { ok: false, message: 'No se pudo determinar la empresa.' }
    const date = String(args?.effective_date || '')
    const concept = String(args?.concept || '').trim()
    const lines = Array.isArray(args?.lines) ? args.lines : []
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, message: 'Indica una fecha contable válida (YYYY-MM-DD).' }
    if (concept.length < 3) return { ok: false, message: 'Indica un concepto contable claro.' }
    if (lines.length < 2 || lines.length > 20) return { ok: false, message: 'El asiento requiere entre 2 y 20 líneas.' }

    const resolved: any[] = []
    for (const line of lines) {
      const debit = Math.round((Number(line?.debit) || 0) * 100) / 100
      const credit = Math.round((Number(line?.credit) || 0) * 100) / 100
      if ((debit > 0) === (credit > 0)) {
        return { ok: false, message: `La línea ${resolved.length + 1} debe tener débito o crédito, no ambos.` }
      }
      const hits = await findAccountingAccounts(ctx.businessUnitId, String(line?.account || ''))
      if (!hits.length) return { ok: false, message: `No encontré la cuenta "${line?.account}" en esta empresa.` }
      if (hits.length > 1 && hits[0].code !== String(line?.account || '').trim()) {
        return { ok: false, message: `La cuenta "${line?.account}" es ambigua: ${hits.map(hit => `${hit.code} ${hit.name}`).join(', ')}. Indica el código exacto.` }
      }
      const account = hits[0]
      resolved.push({ account_id: account.id, account_code: account.code, account_name: account.name, debit, credit, note: String(line?.note || '').trim() || null })
    }
    const totalDebit = resolved.reduce((sum, line) => sum + line.debit, 0)
    const totalCredit = resolved.reduce((sum, line) => sum + line.credit, 0)
    if (Math.abs(totalDebit - totalCredit) > 0.005) {
      return { ok: false, message: `El asiento no cuadra: débito ${totalDebit.toFixed(2)} vs crédito ${totalCredit.toFixed(2)}.` }
    }
    const journal = await getManualJournalConfig(ctx.businessUnitId)
    if (!journal) return { ok: false, message: 'La empresa no tiene diario ED o moneda funcional configurada.' }
    const detail = resolved.map(line => `${line.account_code} ${line.account_name}: ${line.debit ? `DB ${line.debit.toFixed(2)}` : `CR ${line.credit.toFixed(2)}`}`).join(' · ')
    return {
      ok: true,
      payload: { business_unit_id: ctx.businessUnitId, effective_date: date, concept, lines: resolved, journal },
      summary: `Crear borrador contable del ${date} por ${journal.currency_code} ${totalDebit.toFixed(2)} — ${concept}. ${detail}`,
    }
  },

  async execute(payload: any, ctx: ActionContext): Promise<any> {
    if (!ctx.userId) throw new Error('La acción requiere un usuario autenticado para auditar el borrador.')
    const response = await fetchFromCore<{ success: boolean; message?: string; data?: any }>(
      '/api/accounting/journal',
      {
        business_unit_id: payload.business_unit_id,
        effective_date: payload.effective_date,
        type_id: payload.journal.diary_type_id,
        currency_id: payload.journal.currency_id,
        note: `IA · ${payload.concept}`,
        status_id: 1,
        source: 'COMANDI_AI',
        lines: payload.lines.map((line: any) => ({
          account_id: line.account_id,
          entry_type_id: line.debit > 0 ? 1 : 2,
          amount: line.debit || line.credit,
          note: line.note,
        })),
      },
      { actorUserId: ctx.userId },
    )
    if (!response?.success || !response.data?.id) throw new Error(response?.message || 'El core rechazó el borrador contable')
    return { diary_book_id: response.data.id, status: 'DRAFT', url: `/accounting/journal/${response.data.id}` }
  },
})
