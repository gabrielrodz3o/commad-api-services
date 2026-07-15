// Registro domain → endpoint del core, para que Comandi TRAIGA el reporte él mismo.
// El cálculo vive SOLO en el core (no se duplica SQL).
//
// `locationIds` = las sucursales elegidas (activa por defecto, o todas, o las que
// el usuario nombre). Cada dominio sabe cómo llamar su endpoint:
//   - multiLoc: el endpoint agrega por varias sucursales (location_ids[]).
//   - singleLoc: el endpoint solo acepta una sucursal (usa la primera elegida).
import { fetchFromCore } from '../core/client.js'

export interface FetchArgs {
  businessUnitId: number
  locationIds: number[]
  period?: { from?: string; to?: string } | null
}

type BodyBuilder = (a: FetchArgs) => Record<string, any>

// Varias sucursales (el endpoint filtra location_id = ANY(location_ids)).
const multiLoc: BodyBuilder = (a) => ({
  location_ids: a.locationIds,
  business_unit_id: a.businessUnitId,
  date_from: a.period?.from,
  date_to: a.period?.to,
})

// Una sucursal (endpoints que solo aceptan location_id). Usa la primera elegida.
const singleLoc: BodyBuilder = (a) => ({
  location_id: a.locationIds[0],
  business_unit_id: a.businessUnitId,
  date_from: a.period?.from,
  date_to: a.period?.to,
})

// Contabilidad: dato a nivel de UNIDAD DE NEGOCIO (no por sucursal).
const buLevel: BodyBuilder = (a) => ({
  business_unit_id: a.businessUnitId,
  date_from: a.period?.from,
  date_to: a.period?.to,
})

// Todos agregan por varias sucursales (location_ids[]); con una sola elegida = esa sucursal.
const REGISTRY: Record<string, { path: string; body: BodyBuilder; multi: boolean }> = {
  profit_loss: { path: '/api/restaurant/reports/pl-kpis', body: multiLoc, multi: true },
  cost_analysis: { path: '/api/restaurant/reports/cost-analysis', body: multiLoc, multi: true },
  cash_flow: { path: '/api/restaurant/reports/cash-flow', body: multiLoc, multi: true },
  dead_stock: { path: '/api/restaurant/reports/dead-stock', body: multiLoc, multi: true },
  reorder: { path: '/api/restaurant/reports/reorder-analysis', body: multiLoc, multi: true },
  inventory_turnover: { path: '/api/restaurant/reports/inventory-turnover', body: multiLoc, multi: true },
  accounts_receivable: { path: '/api/restaurant/reports/accounts-receivable', body: multiLoc, multi: true },
  accounts_payable: { path: '/api/restaurant/reports/accounts-payable', body: multiLoc, multi: true },
  break_even: { path: '/api/restaurant/reports/break-even', body: multiLoc, multi: true },
  cash_over_short: { path: '/api/restaurant/reports/cash-over-short', body: multiLoc, multi: true },
  audit: { path: '/api/restaurant/reports/audit-trail', body: multiLoc, multi: true },
  tips: { path: '/api/restaurant/reports/tips-analysis', body: multiLoc, multi: true },
  table_turnover: { path: '/api/restaurant/reports/table-turnover', body: multiLoc, multi: true },
  // Contabilidad general (mayor): estado de resultados, balance, gastos por cuenta,
  // utilidad contable, food cost. Nivel unidad de negocio.
  accounting: { path: '/api/accounting/comandi-context', body: buLevel, multi: false },
}

export function domainSupportsFetch(domain: string): boolean {
  return domain in REGISTRY
}
export function domainIsMultiLocation(domain: string): boolean {
  return REGISTRY[domain]?.multi ?? false
}

/** Trae el reporte calculado del core para un dominio. null si no está registrado. */
export async function fetchReportForDomain(domain: string, args: FetchArgs): Promise<any | null> {
  const entry = REGISTRY[domain]
  if (!entry) return null
  return await fetchFromCore(entry.path, entry.body(args))
}
