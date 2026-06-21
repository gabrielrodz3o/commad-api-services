// Herramientas de negocio que Comandi expone al LLM (read-only por ahora).
// El cálculo vive en el core; estas tools solo lo traen. Las acciones de ESCRITURA
// se agregarán aquí después, con confirmación.
import { fetchReportForDomain, domainSupportsFetch } from '../context/report-registry.js'
import { compactReport } from '../context/report-insights.js'
import { buildProcurementContext } from '../context/procurement.js'
import { salesForecast } from '../context/forecast.js'
import { lossPrevention } from '../context/loss-prevention.js'
import { branchBenchmark } from '../context/benchmark.js'
import { embed } from '../context/embeddings.js'
import { searchKnowledge } from '../db/knowledge.js'
import type { Tool } from './agent.js'
import { listActions } from '../actions/registry.js'
import { proposeAction } from '../db/action-log.js'
import type { ActionContext } from '../actions/context.js'

// Acción propuesta por el agente (pendiente de confirmación del usuario).
export interface ProposedAction {
  token: string
  summary: string
  action_type: string
  expires_at: string
}

const REPORT_DOMAINS = [
  'profit_loss', 'cost_analysis', 'cash_flow', 'dead_stock', 'reorder', 'inventory_turnover',
  'accounts_receivable', 'accounts_payable', 'break_even', 'cash_over_short',
  'audit', 'tips', 'table_turnover',
]

export interface BusinessCtx {
  businessUnitId: number
  allowedLocationIds: number[]                 // sucursales accesibles (RBAC) de la empresa
  activeLocationId?: number                    // sucursal donde está navegando el usuario
  branches: { id: number; name: string }[]     // catálogo de sucursales (para resolver nombres)
  defaultPeriod?: { from?: string; to?: string } | null
  userId?: number | null                       // quién pregunta (para auditar acciones)
  proposals?: ProposedAction[]                 // sink: acciones de escritura propuestas este turno
}

export function buildBusinessTools(ctx: BusinessCtx): Tool[] {
  const allowed = new Set(ctx.allowedLocationIds || [])

  // Resuelve qué sucursales usar: las que pidió el LLM (validadas), o la activa por defecto.
  const resolveLocations = (requested?: number[]): number[] => {
    const req = (requested || []).map(Number).filter((id) => allowed.has(id))
    if (req.length) return req
    if (ctx.activeLocationId && allowed.has(ctx.activeLocationId)) return [ctx.activeLocationId]
    return ctx.allowedLocationIds.slice(0, 1)
  }

  const tools: Tool[] = [
    {
      name: 'get_report',
      description: 'Obtiene un reporte ya calculado del negocio. Para "¿cuánto vendí/gané/utilidad/ingresos?" usa SIEMPRE domain="profit_loss". food cost → cost_analysis; caja → cash_flow; etc. Pasa date_from/date_to según el período de la pregunta. Para el alcance de SUCURSALES usa location_ids: si el usuario no especifica, NO lo pongas (se usa la sucursal activa); si dice "todas/consolidado" pon todas; si nombra una, pon su id. Puedes llamarlo varias veces y combinar.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['domain'],
        properties: {
          domain: { type: 'string', enum: REPORT_DOMAINS, description: 'Tipo de reporte.' },
          date_from: { type: 'string', description: 'YYYY-MM-DD (opcional).' },
          date_to: { type: 'string', description: 'YYYY-MM-DD (opcional).' },
          location_ids: { type: 'array', items: { type: 'integer' }, description: 'Ids de las sucursales a incluir. Omitir = sucursal activa.' },
        },
      },
      run: async (args: any) => {
        if (!domainSupportsFetch(args.domain)) return { error: `dominio no disponible para consulta: ${args.domain}` }
        const locationIds = resolveLocations(args.location_ids)
        const period = {
          from: args.date_from || ctx.defaultPeriod?.from,
          to: args.date_to || ctx.defaultPeriod?.to,
        }
        const report = await fetchReportForDomain(args.domain, { businessUnitId: ctx.businessUnitId, locationIds, period })
        const usedNames = locationIds.map((id) => ctx.branches.find((b) => b.id === id)?.name || `Sucursal ${id}`)
        return { _sucursales_usadas: usedNames, ...compactReport(report, 12) }
      },
    },
    {
      name: 'get_procurement_context',
      description: 'Datos de COMPRAS / procurement de la empresa: spend total, top suplidores, maverick spend, requisiciones/órdenes pendientes, discrepancias 3-way-match, presupuesto. Úsalo para preguntas de compras, proveedores o gasto.',
      input_schema: { type: 'object', additionalProperties: false, properties: {} },
      run: async () => buildProcurementContext(ctx.businessUnitId),
    },
    {
      name: 'get_forecast',
      description: 'PRONÓSTICO de ventas para los próximos 7 días (promedio por día de semana, últimas 8 semanas). Úsalo para "¿cuánto venderé?", "¿qué preparar/comprar?", planificación de la semana. location_ids opcional (omitir = sucursal activa).',
      input_schema: {
        type: 'object', additionalProperties: false,
        properties: { location_ids: { type: 'array', items: { type: 'integer' }, description: 'Ids de sucursales. Omitir = activa.' } },
      },
      run: async (args: any) => salesForecast(resolveLocations(args?.location_ids)),
    },
    {
      name: 'get_loss_prevention',
      description: 'PREVENCIÓN DE PÉRDIDAS / FRAUDE: cajeros con faltantes de caja recurrentes, casos críticos de descuadre. Úsalo para "¿hay robo/fraude?", "¿qué cajero descuadra?", "¿dónde pierdo dinero?". location_ids opcional.',
      input_schema: {
        type: 'object', additionalProperties: false,
        properties: {
          location_ids: { type: 'array', items: { type: 'integer' }, description: 'Omitir = activa.' },
          date_from: { type: 'string', description: 'YYYY-MM-DD (opcional, default últimos 30 días).' },
          date_to: { type: 'string', description: 'YYYY-MM-DD (opcional).' },
        },
      },
      run: async (args: any) => {
        const period = {
          from: args?.date_from || ctx.defaultPeriod?.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
          to: args?.date_to || ctx.defaultPeriod?.to || new Date().toISOString().slice(0, 10),
        }
        return lossPrevention(ctx.businessUnitId, resolveLocations(args?.location_ids), period)
      },
    },
    {
      name: 'get_branch_benchmark',
      description: 'BENCHMARK entre SUCURSALES: compara y rankea las sucursales de la empresa por food cost, ventas y margen; señala la peor y la mejor. Úsalo para "¿cuál sucursal va peor/mejor?", "compara mis sucursales".',
      input_schema: {
        type: 'object', additionalProperties: false,
        properties: {
          date_from: { type: 'string', description: 'YYYY-MM-DD (opcional).' },
          date_to: { type: 'string', description: 'YYYY-MM-DD (opcional).' },
        },
      },
      run: async (args: any) => {
        const period = { from: args?.date_from || ctx.defaultPeriod?.from, to: args?.date_to || ctx.defaultPeriod?.to }
        return branchBenchmark(ctx.businessUnitId, ctx.branches, period)
      },
    },
    {
      name: 'get_knowledge',
      description: 'Consulta la BASE DE CONOCIMIENTO del negocio: políticas, procedimientos/SOPs, contratos, info que NO son datos numéricos. Úsalo para "¿cuál es la política de X?", "¿cómo se hace Y?", "¿qué dice el contrato con Z?". Devuelve los fragmentos más relevantes.',
      input_schema: {
        type: 'object', additionalProperties: false, required: ['query'],
        properties: { query: { type: 'string', description: 'Pregunta o tema a buscar.' } },
      },
      run: async (args: any) => {
        try {
          const vec = await embed(String(args?.query || ''), ctx.businessUnitId)
          const hits = (await searchKnowledge(ctx.businessUnitId, vec, 4)).filter((h) => h.score > 0.2)
          if (!hits.length) return { sin_resultados: true, nota: 'No hay nada en la base de conocimiento sobre eso.' }
          return { fragmentos: hits.map((h) => ({ titulo: h.title, contenido: h.content, score: Math.round(h.score * 100) / 100 })) }
        } catch (e: any) {
          return { error: e?.message || 'fallo en la búsqueda de conocimiento' }
        }
      },
    },
  ]

  // ── Acciones de ESCRITURA (propose-only): el agente propone, el usuario confirma ──
  const actionCtx: ActionContext = {
    businessUnitId: ctx.businessUnitId,
    userId: ctx.userId ?? null,
    locationIds: ctx.allowedLocationIds,
    activeLocationId: ctx.activeLocationId ?? null,
  }
  for (const def of listActions()) {
    tools.push({
      name: `propose_${def.type}`,
      description: def.description,
      input_schema: def.input_schema,
      run: async (args: any) => {
        const prep = await def.prepare(args || {}, actionCtx)
        if (!prep.ok) return { needs_clarification: prep.message }
        const row = await proposeAction({
          businessUnitId: ctx.businessUnitId,
          userId: ctx.userId ?? null,
          actionType: def.type,
          summary: prep.summary,
          payload: prep.payload,
          locationIds: ctx.allowedLocationIds,
          channel: 'web',
        })
        ctx.proposals?.push({ token: row.confirm_token, summary: prep.summary, action_type: def.type, expires_at: row.expires_at })
        return {
          proposed: true,
          summary: prep.summary,
          status: 'PENDIENTE_DE_CONFIRMACION',
          note: 'La acción NO está hecha todavía. Dile al usuario EXACTAMENTE qué vas a hacer (el resumen) y pídele que confirme con el botón. No afirmes que ya quedó hecha.',
        }
      },
    })
  }
  return tools
}
