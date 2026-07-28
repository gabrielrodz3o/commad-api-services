// Reporte semanal de Cuentas por Cobrar (CxC) y por Pagar (CxP).
// Misma semántica que los reportes del core (accounts-receivable/payable):
//   - facturas a crédito: invoice_category_id = 2, status_id = 1
//   - CxC = ventas pendientes de clientes; CxP = compras (invoice_type_id = 1)
//   - saldo = total − pagos no anulados (modelo derivado, sin ledger)
//   - aging por expire_at (VIGENTE / VENCIDA ≤30d / MOROSA >30d)
import { query } from '../../db/pool.js'
import type { SubscriptionRow } from '../../db/notifications.js'
import { layout, dataTable, kvTable, money, esc } from '../templates.js'

interface PendingRow {
  entity_name: string
  invoice_number: string
  emission_date: string | null
  expire_at: string | null
  total_dop: number
  pending_dop: number
  estado: string
}

async function pendingInvoices(businessUnitId: number, kind: 'ar' | 'ap'): Promise<PendingRow[]> {
  // CxC: facturas de venta a crédito (todo lo que no es compra); CxP: compras.
  const typeFilter = kind === 'ap' ? 'AND i.invoice_type_id = 1' : 'AND i.invoice_type_id <> 1'
  return query<PendingRow>(
    `SELECT e.name AS entity_name,
            i.invoice_number,
            i.emission_date,
            i.expire_at,
            (i.total_amount * i.currency_rate) AS total_dop,
            (i.total_amount * i.currency_rate) - COALESCE((
              SELECT SUM(ipd.payment_amount * ip.currency_rate)
                FROM finances.invoice_payment_details ipd
                JOIN finances.invoice_payments ip ON ip.id = ipd.invoice_payment_id
               WHERE ipd.invoice_id = i.id AND ip.status_id <> 4
            ), 0) AS pending_dop,
            CASE
              WHEN i.expire_at IS NULL THEN 'SIN VENCIMIENTO'
              WHEN CURRENT_DATE <= i.expire_at THEN 'VIGENTE'
              WHEN CURRENT_DATE - i.expire_at <= 30 THEN 'VENCIDA'
              ELSE 'MOROSA'
            END AS estado
       FROM finances.invoices i
       JOIN finances.entities e ON e.id = i.entity_id
      WHERE i.business_unit_id = $1
        AND i.status_id = 1
        AND i.invoice_category_id = 2
        ${typeFilter}
        AND i.total_amount > COALESCE((
          SELECT SUM(ipd.payment_amount)
            FROM finances.invoice_payment_details ipd
            JOIN finances.invoice_payments ip ON ip.id = ipd.invoice_payment_id
           WHERE ipd.invoice_id = i.id AND ip.status_id <> 4
        ), 0) + 0.01
      ORDER BY pending_dop DESC
      LIMIT 200`,
    [businessUnitId],
  )
}

function section(title: string, rows: PendingRow[]): string {
  const total = rows.reduce((a, r) => a + Number(r.pending_dop), 0)
  const byState = new Map<string, number>()
  for (const r of rows) byState.set(r.estado, (byState.get(r.estado) || 0) + Number(r.pending_dop))

  const estadoColor: Record<string, string> = { VIGENTE: '#2f9e44', VENCIDA: '#e8590c', MOROSA: '#c92a2a', 'SIN VENCIMIENTO': '#868e96' }
  let html = `<div style="font-size:14px;font-weight:bold;color:#343a40;margin-top:8px">${esc(title)}</div>` +
    kvTable([
      ['Documentos pendientes', String(rows.length)],
      ['Saldo total', `<span style="font-size:15px">${money(total)}</span>`],
      ...[...byState.entries()].map(([estado, amt]) =>
        [estado, `<span style="color:${estadoColor[estado] || '#495057'}">${money(amt)}</span>`] as [string, string]),
    ])

  if (rows.length) {
    html += `<div style="margin-top:10px;font-size:12px;font-weight:bold;color:#495057">Mayores saldos</div>` +
      dataTable(
        ['Entidad', 'Factura', 'Vence', 'Estado', 'Pendiente'],
        rows.slice(0, 15).map((r) => [
          esc(r.entity_name), esc(r.invoice_number),
          r.expire_at ? new Date(r.expire_at).toLocaleDateString('es-DO') : '—',
          `<span style="color:${estadoColor[r.estado] || '#495057'}">${esc(r.estado)}</span>`,
          money(r.pending_dop),
        ]),
        ['left', 'left', 'left', 'left', 'right'],
      )
  } else {
    html += `<div style="margin-top:6px;font-size:12px;color:#868e96">Sin documentos pendientes. ✔</div>`
  }
  return html
}

export async function buildArApReport(sub: SubscriptionRow, names: { business: string; location: string | null }): Promise<{ subject: string; html: string }> {
  const [ar, ap] = await Promise.all([
    pendingInvoices(sub.business_unit_id, 'ar'),
    pendingInvoices(sub.business_unit_id, 'ap'),
  ])

  const body =
    section('📥 Cuentas por Cobrar (clientes)', ar) +
    '<div style="height:16px"></div>' +
    section('📤 Cuentas por Pagar (proveedores)', ap)

  const dateStr = new Date().toLocaleDateString('es-DO', { timeZone: 'America/Santo_Domingo', day: 'numeric', month: 'long', year: 'numeric' })
  return {
    subject: `[${names.business}] Cuentas por cobrar y pagar — ${dateStr}`,
    html: layout({ kind: 'report', title: 'Cuentas por Cobrar y Pagar', subtitle: `${names.business} · ${dateStr}`, bodyHtml: body }),
  }
}
