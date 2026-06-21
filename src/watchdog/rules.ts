// Reglas del VIGILANTE. Cada regla recibe un reporte ya calculado (del core) y emite
// alertas si detecta algo que vale la pena avisar. Detección por umbrales (confiable);
// los umbrales son sensatos por defecto y se pueden afinar después por empresa.
export type Severity = 'alta' | 'media'
export interface Alert {
  domain: string
  severity: Severity
  title: string
  detail: string
}

const num = (v: any): number => (typeof v === 'number' ? v : Number(v) || 0)
const dop = (v: number): string => `RD$${num(v).toLocaleString('es-DO', { maximumFractionDigits: 0 })}`

export interface Rule {
  domain: string // dominio del report-registry a traer
  evaluate: (report: any) => Alert[]
}

export const RULES: Rule[] = [
  {
    domain: 'cost_analysis',
    evaluate: (r) => {
      const k = r?.kpis || {}
      const out: Alert[] = []
      const fc = num(k.food_cost_percentage)
      if (fc > 30) out.push({ domain: 'cost_analysis', severity: fc > 38 ? 'alta' : 'media', title: 'Food cost alto', detail: `Food cost en ${fc.toFixed(1)}% (meta < 30%).` })
      const mermas = num(k.total_mermas)
      if (mermas > 3000) out.push({ domain: 'cost_analysis', severity: mermas > 10000 ? 'alta' : 'media', title: 'Mermas elevadas', detail: `Mermas por ${dop(mermas)} en la semana.` })
      return out
    },
  },
  {
    domain: 'cash_over_short',
    evaluate: (r) => {
      const k = r?.kpis || {}
      const short = Math.abs(num(k.total_short))
      const criticos = Array.isArray(r?.casos_criticos) ? r.casos_criticos.length : 0
      const out: Alert[] = []
      if (short > 500 || criticos > 0) {
        out.push({ domain: 'cash_over_short', severity: short > 2000 || criticos > 1 ? 'alta' : 'media', title: 'Descuadres de caja', detail: `Faltantes por ${dop(short)}${criticos ? ` · ${criticos} caso(s) crítico(s)` : ''}.` })
      }
      // Fraude: cajero con faltantes serios RECURRENTES (posible robo o error sistemático).
      const reincidente = (r?.usuarios_problema || []).find((u: any) => num(u.serious_issues) >= 2 && num(u.net_difference) < 0)
      if (reincidente) {
        out.push({ domain: 'cash_over_short', severity: 'alta', title: 'Posible fraude en caja', detail: `${reincidente.user_name}: ${num(reincidente.serious_issues)} faltantes serios (neto ${dop(reincidente.net_difference)}). Revisa con arqueo sorpresa.` })
      }
      return out
    },
  },
  {
    domain: 'reorder',
    evaluate: (r) => {
      const k = r?.kpis || {}
      const out: Alert[] = []
      const so = num(k.stockouts)
      if (so > 0) out.push({ domain: 'reorder', severity: 'alta', title: 'Artículos agotados', detail: `${so} artículo(s) sin stock.` })
      const urg = num(k.urgentes)
      if (urg > 0) out.push({ domain: 'reorder', severity: 'media', title: 'Reorden urgente', detail: `${urg} artículo(s) por quebrar pronto.` })
      return out
    },
  },
  {
    domain: 'dead_stock',
    evaluate: (r) => {
      const k = r?.kpis || {}
      const val = num(k.obsolete_value) + num(k.critical_value)
      const out: Alert[] = []
      if (val > 5000) out.push({ domain: 'dead_stock', severity: val > 25000 ? 'alta' : 'media', title: 'Inventario sin rotación', detail: `${dop(val)} parado en inventario obsoleto/crítico.` })
      return out
    },
  },
]
