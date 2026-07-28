// Reporte "Cierre del día": ventas, formas de pago y cierres de caja de HOY
// (hora local RD). Ámbito: suscripción general (location_id NULL) → consolidado
// de todas las sucursales del BU; específica → solo esa sucursal.
// Semántica de facturas (igual que los reportes del core):
//   ventas = invoice_type_id 2, NC = 3 (resta), status_id = 1, DGII no rechazada.
import { query } from '../../db/pool.js'
import type { SubscriptionRow } from '../../db/notifications.js'
import { layout, dataTable, kvTable, money, esc } from '../templates.js'

const TZ = 'America/Santo_Domingo'

export async function buildDailyCloseReport(sub: SubscriptionRow, names: { business: string; location: string | null }): Promise<{ subject: string; html: string }> {
  const scopeSql = sub.location_id ? 'AND i.location_id = $2' : ''
  const params: any[] = sub.location_id ? [sub.business_unit_id, sub.location_id] : [sub.business_unit_id]

  const sales = await query<any>(
    `SELECT l.description_long AS location_name,
            COUNT(*) FILTER (WHERE i.invoice_type_id = 2)::int AS invoices,
            COALESCE(SUM(i.total_amount * i.currency_rate) FILTER (WHERE i.invoice_type_id = 2), 0) AS gross,
            COUNT(*) FILTER (WHERE i.invoice_type_id = 3)::int AS credit_notes,
            COALESCE(SUM(i.total_amount * i.currency_rate) FILTER (WHERE i.invoice_type_id = 3), 0) AS nc_amount
       FROM finances.invoices i
       JOIN human_resource.locations l ON l.id = i.location_id
      WHERE i.business_unit_id = $1 ${scopeSql}
        AND i.status_id = 1
        AND i.invoice_type_id IN (2, 3)
        AND i.dgii_status IS DISTINCT FROM 'RECHAZADO'
        AND i.created_date::date = (now() AT TIME ZONE '${TZ}')::date
      GROUP BY l.description_long
      ORDER BY gross DESC`,
    params,
  )

  const payments = await query<any>(
    `SELECT ipt.name AS payment_type,
            COUNT(DISTINCT ip.id)::int AS payments,
            COALESCE(SUM(ipd.payment_amount * ip.currency_rate), 0) AS amount
       FROM finances.invoice_payment_details ipd
       JOIN finances.invoice_payments ip ON ip.id = ipd.invoice_payment_id AND ip.status_id <> 4
       JOIN finances.invoice_payment_types ipt ON ipt.id = ip.invoice_payment_type_id
       JOIN finances.invoices i ON i.id = ipd.invoice_id
      WHERE i.business_unit_id = $1 ${scopeSql}
        AND i.status_id = 1 AND i.invoice_type_id = 2
        AND i.created_date::date = (now() AT TIME ZONE '${TZ}')::date
      GROUP BY ipt.name
      ORDER BY amount DESC`,
    params,
  )

  const boxScope = sub.location_id ? 'AND bx.location_id = $2' : ''
  const boxes = await query<any>(
    `SELECT bx.name AS box_name, l.description_long AS location_name,
            u.use_fullname AS closed_by, be.close_at,
            COALESCE(SUM(bec.amount_closed) FILTER (WHERE bec.is_closed), 0) AS total_closed,
            COALESCE(SUM(bec.difference) FILTER (WHERE bec.is_closed), 0) AS difference
       FROM finances.box_entries be
       JOIN finances.boxes bx ON bx.id = be.box_id
       JOIN human_resource.locations l ON l.id = bx.location_id
       LEFT JOIN common.users u ON u.use_id = be.user_id
       LEFT JOIN finances.box_entry_amount_by_currencies bec ON bec.box_entry_id = be.id
      WHERE bx.business_unit_id = $1 ${boxScope}
        AND be.close_at IS NOT NULL
        AND be.close_at::date = (now() AT TIME ZONE '${TZ}')::date
      GROUP BY bx.name, l.description_long, u.use_fullname, be.close_at
      ORDER BY be.close_at`,
    params,
  )

  const totGross = sales.reduce((a, r) => a + Number(r.gross), 0)
  const totNc = sales.reduce((a, r) => a + Number(r.nc_amount), 0)
  const totInvoices = sales.reduce((a, r) => a + Number(r.invoices), 0)
  const net = totGross - totNc

  const place = names.location ? `${names.business} — ${names.location}` : `${names.business} (todas las sucursales)`
  const dateStr = new Date().toLocaleDateString('es-DO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  let body = kvTable([
    ['Facturas emitidas', String(totInvoices)],
    ['Venta bruta', money(totGross)],
    ['Notas de crédito', totNc ? `-${money(totNc)}` : money(0)],
    ['Venta neta', `<span style="font-size:16px">${money(net)}</span>`],
  ])

  if (!sub.location_id && sales.length > 1) {
    body += `<div style="margin-top:18px;font-size:13px;font-weight:bold;color:#495057">Por sucursal</div>` +
      dataTable(
        ['Sucursal', 'Facturas', 'Bruta', 'NC', 'Neta'],
        sales.map((r) => [
          esc(r.location_name), String(r.invoices), money(r.gross),
          Number(r.nc_amount) ? `-${money(r.nc_amount)}` : '—',
          money(Number(r.gross) - Number(r.nc_amount)),
        ]),
        ['left', 'right', 'right', 'right', 'right'],
      )
  }

  if (payments.length) {
    body += `<div style="margin-top:18px;font-size:13px;font-weight:bold;color:#495057">Formas de pago</div>` +
      dataTable(
        ['Forma de pago', 'Pagos', 'Monto'],
        payments.map((r) => [esc(r.payment_type), String(r.payments), money(r.amount)]),
        ['left', 'right', 'right'],
      )
  }

  if (boxes.length) {
    body += `<div style="margin-top:18px;font-size:13px;font-weight:bold;color:#495057">Cierres de caja</div>` +
      dataTable(
        ['Caja', 'Sucursal', 'Cerró', 'Contado', 'Diferencia'],
        boxes.map((r) => [
          esc(r.box_name), esc(r.location_name), esc(r.closed_by || 'N/D'), money(r.total_closed),
          Math.abs(Number(r.difference)) >= 0.01
            ? `<span style="color:#d9480f">${money(r.difference)}</span>`
            : '✔',
        ]),
        ['left', 'left', 'left', 'right', 'right'],
      )
  } else {
    body += `<div style="margin-top:18px;font-size:12px;color:#868e96">Sin cierres de caja registrados hoy.</div>`
  }

  return {
    subject: `[${names.business}] Cierre del día — ${dateStr}${names.location ? ` — ${names.location}` : ''}`,
    html: layout({ kind: 'report', title: 'Cierre del día', subtitle: `${place} · ${dateStr}`, bodyHtml: body }),
  }
}
