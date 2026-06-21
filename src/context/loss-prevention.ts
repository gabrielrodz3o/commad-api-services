// Prevención de pérdidas / fraude: señales de riesgo desde el reporte de descuadres
// de caja (cajeros con faltantes recurrentes, casos críticos). Solo lectura.
import { fetchReportForDomain } from './report-registry.js'

export async function lossPrevention(businessUnitId: number, locationIds: number[], period: { from?: string; to?: string }): Promise<any> {
  const r: any = await fetchReportForDomain('cash_over_short', { businessUnitId, locationIds, period })
  const k = r?.kpis || {}
  const cajeros = (r?.usuarios_problema || []).map((u: any) => ({
    cajero: u.user_name,
    cuadres: u.total_counts,
    faltantes_serios: u.serious_issues,
    tasa_problemas: u.serious_issue_rate,
    diferencia_neta: u.net_difference,
    promedio_descuadre: u.avg_absolute_diff,
  }))
  const criticos = (r?.casos_criticos || []).slice(0, 6).map((c: any) => ({
    caja: c.box_name, cajero: c.user_name, diferencia: c.difference, fecha: c.close_at,
  }))
  return {
    periodo: period,
    faltante_total: k.total_short,
    cuadres_con_faltante: k.count_short,
    cajeros_en_riesgo: cajeros, // ya viene ordenado por el reporte (peores primero)
    casos_criticos: criticos,
    nota: 'Prioriza cajeros con faltantes_serios recurrentes y diferencia_neta negativa: pueden ser error o fraude. Sugiere arqueos sorpresa.',
  }
}
