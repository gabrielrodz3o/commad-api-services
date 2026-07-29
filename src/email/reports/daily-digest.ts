// Resumen diario consolidado (DAILY_DIGEST): un solo correo con todos los
// eventos de control del día — anulaciones, descuentos, cortesías, artículos
// borrados, mermas, cierres de caja y conteos — en una tabla. Alternativa al
// tiempo real para quien quiere un vistazo único a fin de día.
// Todo en hora local RD; scope por sucursal (general = todas las del BU).
import { query } from '../../db/pool.js'
import type { SubscriptionRow } from '../../db/notifications.js'
import { layout, dataTable, money } from '../templates.js'

const TZ = 'America/Santo_Domingo'

export async function buildDailyDigest(sub: SubscriptionRow, names: { business: string; location: string | null }): Promise<{ subject: string; html: string } | null> {
  // Sucursales del ámbito
  const locs = sub.location_id
    ? [sub.location_id]
    : (await query<{ id: number }>(`SELECT id FROM human_resource.locations WHERE business_unit_id = $1`, [sub.business_unit_id])).map((r) => r.id)
  if (!locs.length) return null

  const today = `(now() AT TIME ZONE '${TZ}')::date`

  const one = async (sql: string, params: any[]) => {
    try { return (await query<any>(sql, params))[0] || { n: 0, total: 0 } }
    catch (e: any) { console.warn('⚠️ daily-digest sub-query:', e?.message); return { n: 0, total: 0 } }
  }

  // Anulaciones de factura
  const anul = await one(
    `SELECT count(*)::int AS n, COALESCE(SUM(invoice_total::numeric), 0) AS total
       FROM finances.invoice_cancellation_log
      WHERE location_id = ANY($1::int[]) AND (cancellation_date AT TIME ZONE '${TZ}')::date = ${today}`,
    [locs],
  )
  // Descuentos
  const desc = await one(
    `SELECT count(*)::int AS n, COALESCE(SUM(dal.total_discount), 0) AS total
       FROM restaurant.discount_audit_log dal
       JOIN restaurant.accounts a ON a.id = dal.account_id
      WHERE a.location_id = ANY($1::int[]) AND (dal.created_at AT TIME ZONE '${TZ}')::date = ${today}`,
    [locs],
  )
  // Cortesías
  const cort = await one(
    `SELECT count(*)::int AS n, COALESCE(SUM(total_sale_price * COALESCE(currency_rate, 1)), 0) AS total
       FROM restaurant.courtesies
      WHERE location_id = ANY($1::int[]) AND cancelled_at IS NULL AND effective_date::date = ${today}`,
    [locs],
  )
  // Artículos borrados
  const del = await one(
    `SELECT count(*)::int AS n, COALESCE(SUM(odl.quantity * odl.order_price), 0) AS total
       FROM restaurant.order_details_deleted_log odl
       JOIN restaurant.orders o ON o.id = odl.order_id
       JOIN restaurant.accounts a ON a.id = o.account_id
      WHERE a.location_id = ANY($1::int[]) AND (odl.deleted_at AT TIME ZONE '${TZ}')::date = ${today}`,
    [locs],
  )
  // Mermas
  const waste = await one(
    `SELECT count(*)::int AS n, COALESCE(SUM(total_cost), 0) AS total
       FROM inventory.waste_headers
      WHERE location_id = ANY($1::int[]) AND cancelled_at IS NULL AND status_id <> 4 AND waste_date::date = ${today}`,
    [locs],
  )
  // Cierres de caja
  const boxes = await one(
    `SELECT count(*)::int AS n,
            COALESCE(SUM((SELECT COALESCE(SUM(bec.difference),0) FROM finances.box_entry_amount_by_currencies bec WHERE bec.box_entry_id = be.id AND bec.is_closed)), 0) AS total
       FROM finances.box_entries be
       JOIN finances.boxes bx ON bx.id = be.box_id
      WHERE bx.location_id = ANY($1::int[]) AND be.close_at IS NOT NULL AND be.close_at::date = ${today}`,
    [locs],
  )
  // Conteos de inventario cerrados
  const counts = await one(
    `SELECT count(*)::int AS n, 0 AS total
       FROM inventory.stock_count_sessions
      WHERE location_id = ANY($1::int[]) AND closed_at IS NOT NULL AND (closed_at AT TIME ZONE '${TZ}')::date = ${today}`,
    [locs],
  )

  const rows: string[][] = [
    ['🧾 Anulaciones de factura', String(anul.n), money(anul.total)],
    ['🏷️ Descuentos aplicados', String(desc.n), money(desc.total)],
    ['🎁 Cortesías', String(cort.n), money(cort.total)],
    ['🗑️ Artículos borrados', String(del.n), money(del.total)],
    ['♻️ Mermas', String(waste.n), money(waste.total)],
    ['💰 Cierres de caja', String(boxes.n), boxes.total ? money(boxes.total) + ' (dif.)' : '—'],
    ['📦 Conteos cerrados', String(counts.n), '—'],
  ]

  const totalEventos = Number(anul.n) + Number(desc.n) + Number(cort.n) + Number(del.n) + Number(waste.n) + Number(boxes.n) + Number(counts.n)
  const place = names.location ? `${names.business} — ${names.location}` : `${names.business} (todas las sucursales)`
  const dateStr = new Date().toLocaleDateString('es-DO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  const body = totalEventos === 0
    ? `<div style="font-size:14px;color:#2f9e44">✔ Día sin incidencias de control registradas.</div>`
    : `<div style="font-size:13px;margin-bottom:8px">Resumen de control del día (${totalEventos} evento${totalEventos === 1 ? '' : 's'}):</div>` +
      dataTable(['Concepto', 'Cantidad', 'Monto'], rows, ['left', 'right', 'right'])

  return {
    subject: `[${names.business}] Resumen del día — ${dateStr}`,
    html: layout({ kind: 'report', title: 'Resumen diario consolidado', subtitle: `${place} · ${dateStr}`, bodyHtml: body }),
  }
}
