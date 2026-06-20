// Ejecuta el copiloto agéntico para un usuario de COMAND (por su user_id), aplicando
// su RBAC. Reutilizado por el bot (mensajes) y por el briefing proactivo.
import { resolveUserScope } from '../lib/scope.js'
import { getAIConfig } from '../db/tenant.js'
import { buildBusinessTools, type ProposedAction } from '../llm/tools.js'
import { runAgent } from '../llm/agent.js'
import { comandiPersona } from '../llm/persona.js'
import { logUsage } from '../db/usage-log.js'
import '../actions/index.js'

const SYSTEM = comandiPersona(
  `Eres el copiloto del negocio de un restaurante, respondiendo por Telegram. Cubres TODO: ventas, costos, caja, inventario, compras, cobros/pagos, propinas, mesas.
Reglas:
- Para datos REALES usa las herramientas (get_report; get_procurement_context para compras). No inventes cifras.
- Español, MUY conciso (es chat móvil): pocas viñetas, montos en RD$. Sin tablas grandes.
- Si el usuario pide HACER algo, usa propose_*; no afirmes que quedó hecho: se confirma con botón.`,
)

export interface UserAnswer { enabled: boolean; answer: string; pending: ProposedAction | null }

export async function answerForUser(userId: number, question: string, endpoint = 'telegram'): Promise<UserAnswer> {
  const scope = await resolveUserScope(userId)
  if (!scope) return { enabled: true, answer: 'No tienes sucursales asignadas en COMAND.', pending: null }

  const config = await getAIConfig(scope.businessUnitId)
  if (!config) return { enabled: false, answer: 'La IA (Comandi) no está activada para tu empresa.', pending: null }

  const proposals: ProposedAction[] = []
  const tools = buildBusinessTools({
    businessUnitId: scope.businessUnitId,
    allowedLocationIds: scope.locationIds,
    activeLocationId: scope.locationIds[0],
    branches: [],
    userId,
    proposals,
  })
  const today = new Date().toISOString().slice(0, 10)
  const scopeLine = `Sucursales de la empresa: ${scope.locationIds.join(', ')}. Si no se especifica sucursal, CONSIDERA TODAS (pasa location_ids=[${scope.locationIds.join(',')}]).`
  const system = `${SYSTEM}\n\nHoy es ${today}.\n${scopeLine}`

  const result = await runAgent(config, system, question, tools, [])
  logUsage({ businessUnitId: scope.businessUnitId, userId, endpoint }, result.usage, { steps: result.steps.length })

  return { enabled: true, answer: result.answer, pending: proposals.length ? proposals[proposals.length - 1] : null }
}
