// Ejecución/descarte de una acción propuesta, reutilizable por la ruta HTTP
// (/comandi/action/execute) y por el bot de Telegram (botón Confirmar).
import { getActionByToken, markExecuted, markFailed, markRejected } from '../db/action-log.js'
import { getActionDef } from './registry.js'

export type ExecOutcome =
  | { status: 'ok'; summary: string | null; result: any }
  | { status: 'already'; result: any }
  | { status: 'notfound' }
  | { status: 'forbidden' }
  | { status: 'expired' }
  | { status: 'badstate'; current: string }
  | { status: 'error'; message: string }

/** Ejecuta la acción del token. `userId` (si viene) debe coincidir con quien la propuso. */
export async function executeActionByToken(token: string, userId: number | null): Promise<ExecOutcome> {
  const action = await getActionByToken(token)
  if (!action) return { status: 'notfound' }
  if (userId != null && action.user_id != null && Number(userId) !== Number(action.user_id)) return { status: 'forbidden' }
  if (action.status === 'executed') return { status: 'already', result: action.result }
  if (action.status !== 'proposed') return { status: 'badstate', current: action.status }
  if (new Date(action.expires_at).getTime() < Date.now()) {
    await markFailed(action.id, 'expirada').catch(() => {})
    return { status: 'expired' }
  }
  const def = getActionDef(action.action_type)
  if (!def) return { status: 'error', message: `Acción desconocida: ${action.action_type}` }

  const ctx = { businessUnitId: action.business_unit_id, userId: action.user_id, locationIds: action.location_ids }
  try {
    const result = await def.execute(action.payload, ctx)
    await markExecuted(action.id, result)
    return { status: 'ok', summary: action.summary, result }
  } catch (e: any) {
    await markFailed(action.id, e?.message || 'fallo ejecutando').catch(() => {})
    return { status: 'error', message: e?.message || 'fallo ejecutando' }
  }
}

export async function rejectActionByToken(token: string): Promise<boolean> {
  const action = await getActionByToken(token)
  if (!action) return false
  if (action.status === 'proposed') await markRejected(action.id)
  return true
}
