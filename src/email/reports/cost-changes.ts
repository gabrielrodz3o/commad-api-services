// Reportes de cambios de costo/precio:
//   COST_INCREASE_REPORT     → solo AUMENTOS de costo del período (con % umbral opcional)
//   PRICE_COST_CHANGE_REPORT → todos los cambios de costo Y de precio de venta
// Fuentes (mismas del core get-price-cost-history): inventory.cost_update_log
// (excluye CASCADE_*/ERROR_TRIGGER y filas sin cambio real) e
// inventory.sale_price_change_log.
// El período cubre desde el último envío efectivo según la frecuencia
// (daily = 1 día, weekly = 7, monthly = 31).
import { query } from '../../db/pool.js'
import type { SubscriptionRow } from '../../db/notifications.js'
import { layout, dataTable, money, esc } from '../templates.js'

const TZ = 'America/Santo_Domingo'

function periodDays(sub: SubscriptionRow): number {
  if (sub.frequency === 'weekly') return 7
  if (sub.frequency === 'monthly') return 31
  return 1
}

export async function buildCostChangesReport(
  sub: SubscriptionRow,
  names: { business: string; location: string | null },
  mode: 'increases' | 'all',
): Promise<{ subject: string; html: string } | null> {
  const days = periodDays(sub)
  const minPercent = mode === 'increases' ? Number(sub.threshold_value) || 0 : null

  const costChanges = await query<any>(
    `SELECT it.name AS item_name,
            cul.created_at AS changed_at,
            cul.action_type,
            cul.old_cost, cul.new_cost,
            CASE WHEN COALESCE(cul.old_cost, 0) > 0
                 THEN ROUND((COALESCE(cul.new_cost, 0) - cul.old_cost) / cul.old_cost * 100, 2)
                 ELSE NULL END AS percent_change,
            COALESCE(e.name, '') AS supplier_name,
            COALESCE(u.use_fullname, 'SISTEMA') AS changed_by
       FROM inventory.cost_update_log cul
       JOIN inventory.items it ON it.id = cul.item_id
       LEFT JOIN finances.invoices inv ON inv.id = cul.invoice_id
       LEFT JOIN finances.entities e ON e.id = inv.entity_id
       LEFT JOIN common.users u ON u.use_id = cul.user_id
      WHERE (cul.business_unit_id = $1 OR cul.business_unit_id IS NULL)
        AND cul.action_type NOT IN ('CASCADE_START', 'CASCADE_END', 'ERROR_TRIGGER')
        AND cul.old_cost IS DISTINCT FROM cul.new_cost
        AND cul.created_at >= now() - make_interval(days => $2::int)
        ${mode === 'increases' ? 'AND COALESCE(cul.new_cost, 0) > COALESCE(cul.old_cost, 0)' : ''}
      ORDER BY cul.created_at DESC
      LIMIT 100`,
    [sub.business_unit_id, days],
  )

  const filteredCosts = minPercent
    ? costChanges.filter((c) => c.percent_change === null || Number(c.percent_change) >= minPercent)
    : costChanges

  const priceChanges = mode === 'all'
    ? await query<any>(
        `SELECT it.name AS item_name,
                spl.changed_at,
                spl.old_price, spl.new_price,
                cat.description AS catalogue_name,
                COALESCE(u.use_fullname, 'SISTEMA') AS changed_by
           FROM inventory.sale_price_change_log spl
           JOIN inventory.items it ON it.id = spl.item_id
           LEFT JOIN inventory.catalogues cat ON cat.id = spl.catalogue_id
           LEFT JOIN common.users u ON u.use_id = spl.changed_by
          WHERE spl.changed_at >= now() - make_interval(days => $1::int)
            AND (cat.business_unit_id = $2 OR cat.business_unit_id IS NULL)
          ORDER BY spl.changed_at DESC
          LIMIT 100`,
        [days, sub.business_unit_id],
      )
    : []

  if (!filteredCosts.length && !priceChanges.length) return null // nada que reportar → no enviar

  const fmtDate = (v: any) => new Date(v).toLocaleString('es-DO', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  const title = mode === 'increases' ? 'Costos aumentados' : 'Cambios de costo y precios'
  let body = ''

  if (filteredCosts.length) {
    body += `<div style="font-size:13px;font-weight:bold;color:#495057">Cambios de costo (${filteredCosts.length})</div>` +
      dataTable(
        ['Producto', 'Fecha', 'Anterior', 'Nuevo', '%', 'Origen'],
        filteredCosts.map((c) => [
          esc(c.item_name), fmtDate(c.changed_at), money(c.old_cost), money(c.new_cost),
          c.percent_change === null ? '—'
            : `<span style="color:${Number(c.percent_change) > 0 ? '#d9480f' : '#2f9e44'}">${Number(c.percent_change) > 0 ? '+' : ''}${esc(c.percent_change)}%</span>`,
          esc(c.supplier_name || c.changed_by),
        ]),
        ['left', 'left', 'right', 'right', 'right', 'left'],
      )
  }

  if (priceChanges.length) {
    body += `<div style="margin-top:18px;font-size:13px;font-weight:bold;color:#495057">Cambios de precio de venta (${priceChanges.length})</div>` +
      dataTable(
        ['Producto', 'Fecha', 'Anterior', 'Nuevo', 'Catálogo', 'Usuario'],
        priceChanges.map((c) => [
          esc(c.item_name), fmtDate(c.changed_at), money(c.old_price), money(c.new_price),
          esc(c.catalogue_name || '—'), esc(c.changed_by),
        ]),
        ['left', 'left', 'right', 'right', 'left', 'left'],
      )
  }

  const periodLabel = days === 1 ? 'últimas 24 horas' : `últimos ${days} días`
  return {
    subject: `[${names.business}] ${title} — ${periodLabel}`,
    html: layout({ kind: 'report', title, subtitle: `${names.business} · ${periodLabel}`, bodyHtml: body }),
  }
}
