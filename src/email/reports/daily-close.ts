// Reporte "Cierre del día": ventas, formas de pago y cierres de caja de HOY
// (hora local RD). Ámbito: suscripción general (location_id NULL) → consolidado
// de todas las sucursales del BU; específica → solo esa sucursal.
// Semántica de facturas (igual que los reportes del core):
//   ventas = invoice_type_id 2, NC = 3 (resta), status_id = 1, DGII no rechazada.
import { query } from '../../db/pool.js'
import type { SubscriptionRow } from '../../db/notifications.js'
import { layout, dataTable, money, esc, heroStat, statTiles, sectionHead } from '../templates.js'

const TZ = 'America/Santo_Domingo'

export async function buildDailyCloseReport(sub: SubscriptionRow, names: { business: string; location: string | null }): Promise<{ subject: string; html: string }> {
  const scopeSql = sub.location_id ? 'AND i.location_id = $2' : ''
  const params: any[] = sub.location_id ? [sub.business_unit_id, sub.location_id] : [sub.business_unit_id]

  // Día objetivo del "cierre del día": el que YA CERRÓ. Si el reporte corre en la
  // mañana (antes del mediodía) resume AYER; si corre en la tarde/noche, HOY.
  // Evita el bug de enviar el día nuevo en ceros de madrugada.
  const localDate = `(now() AT TIME ZONE '${TZ}')::date`
  const TARGET = `(CASE WHEN (now() AT TIME ZONE '${TZ}')::time < TIME '12:00'
                        THEN (${localDate} - 1)
                        ELSE ${localDate} END)`

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
        AND i.created_date::date = ${TARGET}
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
        AND i.created_date::date = ${TARGET}
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
        AND be.close_at::date = ${TARGET}
      GROUP BY bx.name, l.description_long, u.use_fullname, be.close_at
      ORDER BY be.close_at`,
    params,
  )

  // Descuentos aplicados hoy (líneas de orden con descuento, cuentas del ámbito)
  const discScope = sub.location_id ? 'AND a.location_id = $1' : 'AND l.business_unit_id = $1'
  const discParam = sub.location_id ?? sub.business_unit_id
  const discounts = await query<any>(
    `SELECT COUNT(*)::int AS lines, COALESCE(SUM(od.discount_amount), 0) AS amount
       FROM restaurant.order_details od
       JOIN restaurant.orders o ON o.id = od.order_id
       JOIN restaurant.accounts a ON a.id = o.account_id
       JOIN human_resource.locations l ON l.id = a.location_id
      WHERE od.discount_amount > 0
        AND a.created_at::date = ${TARGET}
        ${discScope}`,
    [discParam],
  ).catch(() => [{ lines: 0, amount: 0 }])

  const totGross = sales.reduce((a, r) => a + Number(r.gross), 0)
  const totNc = sales.reduce((a, r) => a + Number(r.nc_amount), 0)
  const totInvoices = sales.reduce((a, r) => a + Number(r.invoices), 0)
  const net = totGross - totNc
  const avgTicket = totInvoices ? totGross / totInvoices : 0
  const discAmount = Number(discounts[0]?.amount) || 0
  const discLines = Number(discounts[0]?.lines) || 0

  const place = names.location ? `${names.business} — ${names.location}` : `${names.business} (todas las sucursales)`
  // Fecha mostrada = el día objetivo (el que cerró), consistente con las queries.
  const tdRows = await query<{ d: string }>(`SELECT to_char(${TARGET}, 'YYYY-MM-DD') AS d`).catch(() => [])
  const targetIso = tdRows[0]?.d || new Date().toISOString().slice(0, 10)
  const dateStr = new Date(`${targetIso}T12:00:00Z`).toLocaleDateString('es-DO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  const totBoxDiff = boxes.reduce((a, r) => a + Number(r.difference || 0), 0)

  // Hero: venta neta del día + contexto (bruta / NC).
  let body = heroStat({
    label: 'Venta neta del día',
    value: money(net),
    context: `Bruta ${money(totGross)}${totNc ? ` · Notas de crédito -${money(totNc)}` : ''}`,
  })

  // KPIs en tarjetas.
  body += statTiles([
    { label: 'Facturas emitidas', value: String(totInvoices) },
    { label: 'Ticket promedio', value: money(avgTicket) },
    { label: 'Descuentos', value: discAmount ? money(discAmount) : '—', color: discAmount ? '#d9480f' : '#111827' },
    { label: 'Diferencia de caja', value: Math.abs(totBoxDiff) >= 0.01 ? money(totBoxDiff) : 'Cuadrada', color: Math.abs(totBoxDiff) >= 0.01 ? '#c92a2a' : '#2f9e44' },
  ])

  if (!sub.location_id && sales.length > 1) {
    body += sectionHead('Venta por sucursal') +
      dataTable(
        ['Sucursal', 'Facturas', 'Bruta', 'NC', 'Neta'],
        sales.map((r) => [
          esc(r.location_name), String(r.invoices), money(r.gross),
          Number(r.nc_amount) ? `-${money(r.nc_amount)}` : '—',
          `<strong>${money(Number(r.gross) - Number(r.nc_amount))}</strong>`,
        ]),
        ['left', 'right', 'right', 'right', 'right'],
      )
  }

  if (payments.length) {
    const totPay = payments.reduce((a, r) => a + Number(r.amount), 0)
    body += sectionHead('Formas de pago') +
      dataTable(
        ['Forma de pago', 'Pagos', 'Monto'],
        [
          ...payments.map((r) => [esc(r.payment_type), String(r.payments), money(r.amount)]),
          [`<strong>Total</strong>`, '', `<strong>${money(totPay)}</strong>`],
        ],
        ['left', 'right', 'right'],
      )
  }

  if (boxes.length) {
    body += sectionHead('Cierres de caja') +
      dataTable(
        ['Caja', 'Sucursal', 'Cerró', 'Contado', 'Diferencia'],
        boxes.map((r) => [
          esc(r.box_name), esc(r.location_name), esc(r.closed_by || 'N/D'), money(r.total_closed),
          Math.abs(Number(r.difference)) >= 0.01
            ? `<span style="color:#c92a2a;font-weight:700">${money(r.difference)}</span>`
            : '<span style="color:#2f9e44">✔</span>',
        ]),
        ['left', 'left', 'left', 'right', 'right'],
      )
  } else {
    body += `<div style="margin-top:16px;font-size:12px;color:#868e96">Sin cierres de caja registrados ese día.</div>`
  }

  return {
    subject: `[${names.business}] Cierre del día — ${dateStr}${names.location ? ` — ${names.location}` : ''}`,
    html: layout({ kind: 'report', title: 'Cierre del día', subtitle: `${place} · ${dateStr}`, bodyHtml: body }),
  }
}
