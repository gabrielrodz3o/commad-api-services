// Herramientas de negocio que Comandi expone al LLM (read-only por ahora).
// El cálculo vive en el core; estas tools solo lo traen. Las acciones de ESCRITURA
// se agregarán aquí después, con confirmación.
import { fetchReportForDomain, domainSupportsFetch } from '../context/report-registry.js'
import { compactReport } from '../context/report-insights.js'
import type { Tool } from './agent.js'

const REPORT_DOMAINS = [
  'profit_loss', 'cost_analysis', 'cash_flow', 'dead_stock', 'reorder', 'inventory_turnover',
  'accounts_receivable', 'accounts_payable', 'break_even', 'cash_over_short',
  'audit', 'tips', 'table_turnover',
]

export interface BusinessCtx {
  businessUnitId: number
  allowedLocationIds: number[]                 // sucursales accesibles (RBAC) de la empresa
  activeLocationId?: number                    // sucursal donde está navegando el usuario
  branches: { id: number; name: string }[]     // catálogo de sucursales (para resolver nombres)
  defaultPeriod?: { from?: string; to?: string } | null
}

export function buildBusinessTools(ctx: BusinessCtx): Tool[] {
  const allowed = new Set(ctx.allowedLocationIds || [])

  // Resuelve qué sucursales usar: las que pidió el LLM (validadas), o la activa por defecto.
  const resolveLocations = (requested?: number[]): number[] => {
    const req = (requested || []).map(Number).filter((id) => allowed.has(id))
    if (req.length) return req
    if (ctx.activeLocationId && allowed.has(ctx.activeLocationId)) return [ctx.activeLocationId]
    return ctx.allowedLocationIds.slice(0, 1)
  }

  return [
    {
      name: 'get_report',
      description: 'Obtiene un reporte ya calculado del negocio. Para "¿cuánto vendí/gané/utilidad/ingresos?" usa SIEMPRE domain="profit_loss". food cost → cost_analysis; caja → cash_flow; etc. Pasa date_from/date_to según el período de la pregunta. Para el alcance de SUCURSALES usa location_ids: si el usuario no especifica, NO lo pongas (se usa la sucursal activa); si dice "todas/consolidado" pon todas; si nombra una, pon su id. Puedes llamarlo varias veces y combinar.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['domain'],
        properties: {
          domain: { type: 'string', enum: REPORT_DOMAINS, description: 'Tipo de reporte.' },
          date_from: { type: 'string', description: 'YYYY-MM-DD (opcional).' },
          date_to: { type: 'string', description: 'YYYY-MM-DD (opcional).' },
          location_ids: { type: 'array', items: { type: 'integer' }, description: 'Ids de las sucursales a incluir. Omitir = sucursal activa.' },
        },
      },
      run: async (args: any) => {
        if (!domainSupportsFetch(args.domain)) return { error: `dominio no disponible para consulta: ${args.domain}` }
        const locationIds = resolveLocations(args.location_ids)
        const period = {
          from: args.date_from || ctx.defaultPeriod?.from,
          to: args.date_to || ctx.defaultPeriod?.to,
        }
        const report = await fetchReportForDomain(args.domain, { businessUnitId: ctx.businessUnitId, locationIds, period })
        const usedNames = locationIds.map((id) => ctx.branches.find((b) => b.id === id)?.name || `Sucursal ${id}`)
        return { _sucursales_usadas: usedNames, ...compactReport(report, 12) }
      },
    },
  ]
}
