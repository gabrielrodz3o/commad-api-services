// Contexto de compras para el chat de Comandi (porta procurement-context del core).
// Reúne, filtrado por business_unit, el snapshot real de compras y lo recorta.
import { query } from '../db/pool.js'

const num = (v: any) => Number(v || 0)
const sum = (arr: any[], k: string) => arr.reduce((s, x) => s + num(x[k]), 0)
const rows = (sql: string, params: any[] = []) =>
  query(sql, params).catch((e: any) => { console.warn('procurement ctx query falló:', e?.message); return [] as any[] })

export async function buildProcurementContext(businessUnitId: number) {
  const bu = businessUnitId
  const [topSuppliers, byCategory, byPeriod, maverick, pendingPRs, discrepancies, contracts, budget] = await Promise.all([
    rows(`SELECT supplier_name, SUM(total_spend) AS spend, SUM(po_count) AS pos
            FROM inventory.v_spend_cube WHERE business_unit_id = $1
            GROUP BY supplier_name ORDER BY spend DESC LIMIT 10`, [bu]),
    rows(`SELECT category_name, SUM(total_spend) AS spend
            FROM inventory.v_spend_cube WHERE business_unit_id = $1 AND category_name IS NOT NULL
            GROUP BY category_name ORDER BY spend DESC LIMIT 8`, [bu]),
    rows(`SELECT period, SUM(total_spend) AS spend
            FROM inventory.v_spend_cube WHERE business_unit_id = $1 AND period IS NOT NULL
            GROUP BY period ORDER BY period DESC LIMIT 6`, [bu]),
    rows(`SELECT supplier_name, total_spend, maverick_reason
            FROM inventory.v_maverick_spend WHERE business_unit_id = $1
            ORDER BY total_spend DESC LIMIT 10`, [bu]),
    rows(`SELECT code, priority, estimated_total
            FROM inventory.purchase_requisitions
           WHERE business_unit_id = $1 AND status IN ('SUBMITTED','IN_APPROVAL')
           ORDER BY priority DESC, requested_at DESC LIMIT 15`, [bu]),
    rows(`SELECT o.code AS order_code, e.name AS supplier, tm.match_status,
                 ROUND(tm.qty_variance_pct,2) AS qty_var, ROUND(tm.price_variance_pct,2) AS price_var, tm.variance_amount
            FROM inventory.three_way_match_log tm
            JOIN inventory.orders o ON o.id = tm.order_id
            LEFT JOIN finances.entities e ON e.id = o.supplier_id
           WHERE o.business_unit_id = $1 AND tm.match_status NOT IN ('MATCHED','MANUAL_OVERRIDE')
           ORDER BY tm.created_at DESC LIMIT 10`, [bu]),
    rows(`SELECT contract_number, supplier_name, days_until_expiry, alert_level
            FROM inventory.v_contracts_expiring
           WHERE alert_level IN ('DUE_SOON','EXPIRED','UPCOMING')
           ORDER BY days_until_expiry ASC LIMIT 10`),
    rows(`SELECT chart_of_account_id, SUM(total_committed) AS committed, SUM(available_to_consume) AS available
            FROM inventory.v_budget_availability WHERE business_unit_id = $1
            GROUP BY chart_of_account_id ORDER BY available DESC LIMIT 10`, [bu]),
  ])

  return {
    generado: new Date().toISOString(),
    totales: {
      spend_total: sum(topSuppliers, 'spend'),
      maverick_total: sum(maverick, 'total_spend'),
      presupuesto_disponible: sum(budget, 'available'),
      discrepancias_3wm: discrepancies.length,
      requisiciones_pendientes: pendingPRs.length,
      contratos_por_vencer: contracts.length,
    },
    top_suplidores: topSuppliers,
    spend_por_categoria: byCategory,
    tendencia_mensual: [...byPeriod].reverse(),
    maverick,
    requisiciones_pendientes: pendingPRs,
    discrepancias_3wm: discrepancies,
    contratos_por_vencer: contracts,
    presupuesto: budget,
  }
}
