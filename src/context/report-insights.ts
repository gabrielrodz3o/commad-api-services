// Motor genérico de insights de reportes (igual al del core, portado a Comandi).
// La página manda { location_ids, domain, report }; aquí se recorta el reporte y
// se pide a la IA un análisis estructurado con la voz de Comandi.
import { comandiPersona } from '../llm/persona.js'
import { generateJSON } from '../llm/provider.js'
import type { UsageMeta } from '../llm/usage.js'
import type { CompanyAIConfig } from '../db/tenant.js'

const DOMAIN_PROMPTS: Record<string, { label: string; role: string }> = {
  profit_loss: { label: 'P&L', role: 'Actúas como CFO/contralor de un restaurante. Te dan el P&L: ventas, costo de ventas, prime cost, gastos, márgenes y desempeño por canal.' },
  cash_flow: { label: 'Flujo de Caja', role: 'Actúas como tesorero. Te dan el flujo de caja por turnos, cajas y usuarios, y los movimientos.' },
  dead_stock: { label: 'Inventario Muerto', role: 'Actúas como gerente de inventario. Te dan el inventario sin rotación, aging y promociones sugeridas.' },
  reorder: { label: 'Reorden', role: 'Actúas como planificador de compras. Te dan artículos a reordenar con stock, consumo y riesgo de quiebre.' },
  cost_analysis: { label: 'Análisis de Costos', role: 'Actúas como consultor de control de costos (food cost, mermas, varianza, ingeniería de menú).' },
  procurement: { label: 'Compras', role: 'Actúas como director de compras (CPO): spend, suplidores, maverick, contratos, 3WM y presupuesto.' },
  inventory_turnover: { label: 'Rotación', role: 'Actúas como gerente de inventario: rotación por artículo/categoría y capital inmovilizado.' },
  accounts_receivable: { label: 'CxC', role: 'Actúas como gerente de cobranzas: aging de cuentas por cobrar por cliente.' },
  accounts_payable: { label: 'CxP', role: 'Actúas como gerente de cuentas por pagar: aging por proveedor.' },
  sales: { label: 'Ventas', role: 'Actúas como gerente de ventas de un restaurante. Te dan ventas por método de pago, tendencia diaria, movimientos de caja y KPIs. Explica los drivers del alza/baja y dónde enfocar.' },
  products_sold: { label: 'Productos Vendidos', role: 'Actúas como analista de menú. Te dan el mix de productos vendidos por categoría/producto y maridajes (con qué se vendieron). Identifica qué empujar y combos rentables.' },
  menu_engineering: { label: 'Ingeniería de Menú', role: 'Actúas como consultor de ingeniería de menú. Te dan los platos clasificados (Estrella/Caballo/Puzzle/Perro) con popularidad y margen. Da estrategia por cuadrante (re-precio, promo, rediseño, retirar).' },
  break_even: { label: 'Punto de Equilibrio', role: 'Actúas como contralor. Te dan el punto de equilibrio, costos fijos, métricas clave y análisis de sensibilidad. Interpreta qué tan lejos/cerca está el equilibrio y qué palancas moverlo (precio, costo, volumen).' },
  purchases: { label: 'Compras y Gastos', role: 'Actúas como gerente de compras/gastos. Te dan compras y gastos por tipo, nómina, serie temporal, top proveedores y comparativa por sucursal. Señala dónde recortar y concentraciones de riesgo.' },
  cash_over_short: { label: 'Cash Over/Short', role: 'Actúas como auditor interno. Te dan descuadres de caja (sobrantes/faltantes) por caja, cajero y turno. Detecta patrones sospechosos de faltantes recurrentes (posible fraude) y prioriza qué revisar.' },
  audit: { label: 'Audit Trail', role: 'Actúas como auditor. Te dan la bitácora de cambios críticos. Resume actividad inusual o riesgosa y di a quién/qué revisar.' },
  tips: { label: 'Propinas', role: 'Actúas como gerente de servicio. Te dan análisis de propinas por turno, mesero y método de pago. Señala desbalances y oportunidades.' },
  table_turnover: { label: 'Turnover de Mesas', role: 'Actúas como gerente de operaciones. Te dan rotación y eficiencia de mesas por zona. Identifica cuellos de botella y oportunidades de más turnos.' },
  courtesies: { label: 'Cortesías', role: 'Actúas como controller. Te dan las cortesías (items regalados) y su impacto económico. Detecta abuso/fugas y autorizadores con exceso.' },
  discounts: { label: 'Descuentos', role: 'Actúas como controller. Te dan descuentos autorizados por autorizador. Detecta abuso/fugas y concentraciones.' },
  price_changes: { label: 'Cambios de Precio', role: 'Actúas como analista de costos/precios. Te dan cambios de precio y cantidad. Señala impacto de inflación y cambios atípicos.' },
  waiter_sales: { label: 'Ventas por Mesero', role: 'Actúas como gerente de salón. Te dan ventas y propinas por mesero (y por categoría). Identifica top/bottom performers y dónde dar coaching.' },
  delivery: { label: 'Delivery', role: 'Actúas como gerente de delivery. Te dan KPIs: drivers, zonas, canales, SLA y tendencias. Señala problemas de servicio y oportunidades.' },
  call_center: { label: 'Call Center', role: 'Actúas como gerente de call center. Te dan operadores, estados, canales, reclamos por tipo y comparativa por sucursal. Señala cuellos y calidad.' },
  hr_analytics: { label: 'Analytics RRHH', role: 'Actúas como Director de RRHH / People Analytics. Te dan tendencias de costo laboral, rotación (turnover), headcount por departamento, horas extra y antigüedad (tenure) de la plantilla. Explica los drivers de la rotación y del costo laboral, qué departamentos están en riesgo y dónde actuar. Montos en RD$.' },
  payroll_anomalies: { label: 'Auditoría de Nómina', role: 'Actúas como auditor de nómina. Te dan empleados marcados por anomalías ANTES de confirmar la nómina: desviaciones vs histórico, neto cero, AFP/SFS faltante. Prioriza qué casos revisar primero por riesgo e impacto, explica patrones (posibles errores o fraude) y di qué corregir antes de pagar. Montos en RD$.' },
  payroll_forecast: { label: 'Forecast de Nómina', role: 'Actúas como contralor / FP&A. Te dan la proyección de costo patronal de nómina: run-rate anual, proyección a 12 meses, regalía pascual (salario #13) y crecimiento YoY. Interpreta la tendencia, los riesgos de sobrecosto y las palancas para controlarlo. Montos en RD$.' },
  waste: { label: 'Mermas', role: 'Actúas como gerente de inventario / control de mermas. Te dan la merma (desperdicio) por tipo, artículo y categoría con su costo. Identifica DÓNDE se concentra la pérdida, las causas probables (sobre-pedido, mala rotación, porciones, vencimiento) y cómo reducirla. Cuantifica el ahorro potencial. Montos en RD$.' },
  expiring: { label: 'Por Vencer', role: 'Actúas como gerente de inventario. Te dan los lotes VENCIDOS y POR VENCER con su valor. Prioriza qué usar/promocionar antes de que venza para evitar merma, señala el valor en riesgo y los artículos más urgentes. Montos en RD$.' },
  stock_count: { label: 'Conteo Físico', role: 'Actúas como auditor de inventario. Te dan el resultado de un conteo físico: contado vs sistema (teórico) por artículo, con su varianza y valor. Señala faltantes/sobrantes significativos (posible merma, robo o error de registro), prioriza qué revisar y estima el valor de la diferencia. Montos en RD$.' },
  inventory_overview: { label: 'Inventario', role: 'Actúas como gerente de inventario. Te dan la valoración del inventario (costo total, valor de venta, nº de artículos, capital inmovilizado). Señala exceso de stock, capital parado y oportunidades. Montos en RD$.' },
  abc_xyz: { label: 'Clasificación ABC-XYZ', role: 'Actúas como gerente de inventario / planificación de compras. Te dan la clasificación ABC-XYZ de los insumos: ABC por valor de consumo (A ≈ 80% del costo = los críticos), XYZ por variabilidad de la demanda (X estable, Y variable, Z errático), más los ítems críticos (A-Y, A-Z). Recomienda estrategia de stock/compra por cuadrante: vigila de cerca los A-Z (caros e impredecibles → más stock de seguridad), aplica JIT a los A-X, y evalúa descontinuar los C-Z. Montos en RD$.' },
}

export const REPORT_INSIGHTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resumen_ejecutivo', 'semaforo', 'score', 'hallazgos', 'recomendaciones', 'oportunidad_total_dop'],
  properties: {
    resumen_ejecutivo: { type: 'string' },
    semaforo: { type: 'string', enum: ['verde', 'amarillo', 'rojo'] },
    score: { type: 'integer', description: 'Salud general 0-100 (100 = excelente). Coherente con el semáforo: rojo<40, amarillo 40-69, verde>=70.' },
    hallazgos: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['titulo', 'detalle', 'severidad', 'impacto_dop'],
        properties: {
          titulo: { type: 'string' },
          detalle: { type: 'string' },
          severidad: { type: 'string', enum: ['alta', 'media', 'baja'] },
          impacto_dop: { type: 'number', description: 'Impacto económico estimado del hallazgo en DOP. 0 si no se puede estimar.' },
        },
      },
    },
    recomendaciones: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['accion', 'impacto', 'prioridad', 'ahorro_dop'],
        properties: {
          accion: { type: 'string' },
          impacto: { type: 'string' },
          prioridad: { type: 'string', enum: ['alta', 'media', 'baja'] },
          ahorro_dop: { type: 'number', description: 'Ahorro/ganancia estimada de aplicar la acción, en DOP. 0 si no se puede estimar.' },
        },
      },
    },
    oportunidad_total_dop: { type: 'number' },
  },
} as const

export function compactReport(value: any, maxItems = 15, depth = 0): any {
  if (depth > 6) return null
  if (Array.isArray(value)) return value.slice(0, maxItems).map((v) => compactReport(v, maxItems, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {}
    for (const k of Object.keys(value)) out[k] = compactReport(value[k], maxItems, depth + 1)
    return out
  }
  if (typeof value === 'string' && value.length > 400) return value.slice(0, 400) + '…'
  return value
}

function systemFor(domain: string): string {
  const d = DOMAIN_PROMPTS[domain] || { role: 'Actúas como analista de negocio de un restaurante.' }
  return comandiPersona(`${d.role}
Produce un análisis EJECUTIVO y PRESCRIPTIVO en DOP (RD$).
Reglas:
- Usa SOLO los datos dados; no inventes cifras. Cita nombres y montos concretos.
- Prioriza por impacto económico. Recomendaciones accionables y específicas.
- score: 0-100 de salud general, coherente con el semáforo (rojo<40, amarillo 40-69, verde>=70).
- impacto_dop / ahorro_dop: estima el monto en DOP a partir de los datos; pon 0 solo si es imposible estimarlo.
- oportunidad_total_dop ≈ suma de los ahorro_dop de las recomendaciones.`)
}

export interface ReportPeriod { from?: string; to?: string }

function periodLine(period?: ReportPeriod | null): string {
  if (!period) return ''
  const { from, to } = period
  if (from && to) return `\nPERÍODO ANALIZADO: ${from} a ${to}. Ancla TODO el análisis a este período y menciónalo en el resumen.`
  if (from) return `\nPERÍODO ANALIZADO: desde ${from}.`
  if (to) return `\nPERÍODO ANALIZADO: hasta ${to}.`
  return ''
}

export async function generateReportInsights(config: CompanyAIConfig, domain: string, report: any, period?: ReportPeriod | null, usageMeta?: UsageMeta) {
  return generateJSON({
    config,
    system: systemFor(domain),
    user: `Analiza estos datos y devuelve el análisis estructurado.${periodLine(period)}\n\nDATOS (JSON):\n${JSON.stringify(compactReport(report))}`,
    schema: REPORT_INSIGHTS_SCHEMA as any,
    schemaName: 'report_insights',
    maxTokens: 4096,
    usageMeta,
  })
}
