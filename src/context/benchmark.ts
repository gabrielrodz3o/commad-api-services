// Benchmark entre sucursales: compara y rankea por food cost / ventas / margen.
// Reusa cost_analysis por sucursal (1 fetch por sucursal, on-demand). Solo lectura.
import { fetchReportForDomain } from './report-registry.js'

interface Branch { id: number; name: string }

export async function branchBenchmark(businessUnitId: number, branches: Branch[], period: { from?: string; to?: string }): Promise<any> {
  if (!branches.length) return { error: 'no hay sucursales para comparar' }
  if (branches.length < 2) return { nota: 'Solo hay una sucursal; no hay con qué comparar.', sucursales: [] }

  const rows = await Promise.all(
    branches.map(async (b) => {
      try {
        const r: any = await fetchReportForDomain('cost_analysis', { businessUnitId, locationIds: [b.id], period })
        const k = r?.kpis || {}
        return {
          sucursal: b.name,
          id: b.id,
          ventas: k.total_ventas,
          food_cost_pct: k.food_cost_percentage,
          margen_pct: k.margen_percentage,
        }
      } catch {
        return { sucursal: b.name, id: b.id, error: true }
      }
    }),
  )
  const valid = rows.filter((r: any) => !r.error && (r.ventas || 0) > 0)
  if (valid.length < 2) return { nota: 'No hay datos suficientes en al menos 2 sucursales.', sucursales: valid }

  const byFoodCost = [...valid].sort((a: any, b: any) => (b.food_cost_pct || 0) - (a.food_cost_pct || 0))
  const byVentas = [...valid].sort((a: any, b: any) => (b.ventas || 0) - (a.ventas || 0))
  return {
    periodo: period,
    sucursales: valid,
    peor_food_cost: byFoodCost[0],     // food cost más ALTO = peor
    mejor_food_cost: byFoodCost[byFoodCost.length - 1],
    mas_ventas: byVentas[0],
    nota: 'food_cost_pct más alto = peor. Señala cuántos puntos separan a la peor de la mejor y qué accionar.',
  }
}
