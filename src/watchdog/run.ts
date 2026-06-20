// Motor del VIGILANTE: trae los reportes relevantes (del core, ya calculados — sin
// duplicar SQL ni cargar Nuxt de más: 1 pasada por corrida) y aplica las reglas.
import { fetchReportForDomain } from '../context/report-registry.js'
import { RULES, type Alert } from './rules.js'
import { resolveUserScope } from '../lib/scope.js'

function recentPeriod(days = 7): { from: string; to: string } {
  const to = new Date().toISOString().slice(0, 10)
  const d = new Date()
  d.setDate(d.getDate() - days)
  return { from: d.toISOString().slice(0, 10), to }
}

/** Corre las reglas para una empresa + sucursales. Devuelve las alertas (alta primero). */
export async function runWatchdog(businessUnitId: number, locationIds: number[]): Promise<Alert[]> {
  const period = recentPeriod(7)
  const domains = Array.from(new Set(RULES.map((r) => r.domain)))
  const reports: Record<string, any> = {}
  await Promise.all(
    domains.map(async (d) => {
      try { reports[d] = await fetchReportForDomain(d, { businessUnitId, locationIds, period }) } catch { reports[d] = null }
    }),
  )
  const alerts: Alert[] = []
  for (const rule of RULES) {
    const rep = reports[rule.domain]
    if (!rep) continue
    try { alerts.push(...rule.evaluate(rep)) } catch { /* regla defensiva: nunca tumbar el run */ }
  }
  return alerts.sort((a, b) => (a.severity === 'alta' ? 0 : 1) - (b.severity === 'alta' ? 0 : 1))
}

export async function runWatchdogForUser(userId: number): Promise<Alert[]> {
  const scope = await resolveUserScope(userId)
  if (!scope) return []
  return runWatchdog(scope.businessUnitId, scope.locationIds)
}

/** Formatea las alertas como mensaje (Telegram / texto). '' si no hay nada que avisar. */
export function formatAlerts(alerts: Alert[]): string {
  if (!alerts.length) return ''
  const icon = (s: string) => (s === 'alta' ? '🔴' : '🟠')
  const lines = alerts.map((a) => `${icon(a.severity)} *${a.title}* — ${a.detail}`)
  return `🔔 *Comandi — Alertas del negocio*\n(últimos 7 días)\n\n${lines.join('\n')}\n\nPregúntame cualquiera para ver el detalle.`
}
