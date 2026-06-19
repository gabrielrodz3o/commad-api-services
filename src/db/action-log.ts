// Bitácora de acciones de escritura (propose → confirm → execute) en comandi.action_log.
// El agente PROPONE (status 'proposed' + confirm_token de un solo uso). El usuario
// confirma → se EJECUTA contra el core y se marca 'executed'. Nada de negocio se
// muta sin confirmación explícita.
import { randomBytes } from 'node:crypto'
import { pool } from './pool.js'

export type ActionStatus = 'proposed' | 'confirmed' | 'executed' | 'rejected' | 'failed' | 'expired'

export interface ActionRow {
  id: string
  business_unit_id: number | null
  user_id: number | null
  action_type: string
  status: ActionStatus
  summary: string | null
  payload: any
  location_ids: number[] | null
  result: any
  error: string | null
  confirm_token: string
  channel: string
  expires_at: string
  created_at: string
  executed_at: string | null
}

export interface ProposeInput {
  businessUnitId: number | null
  userId: number | null
  actionType: string
  summary: string
  payload: Record<string, any>
  locationIds?: number[] | null
  channel?: 'web' | 'telegram'
}

/** Crea una acción 'proposed' con token de un solo uso (15 min). Devuelve la fila. */
export async function proposeAction(input: ProposeInput): Promise<ActionRow> {
  const token = randomBytes(18).toString('base64url')
  const { rows } = await pool.query<ActionRow>(
    `INSERT INTO comandi.action_log
       (business_unit_id, user_id, action_type, status, summary, payload, location_ids, confirm_token, channel)
     VALUES ($1,$2,$3,'proposed',$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      input.businessUnitId ?? null,
      input.userId ?? null,
      input.actionType,
      input.summary,
      JSON.stringify(input.payload ?? {}),
      input.locationIds && input.locationIds.length ? input.locationIds : null,
      token,
      input.channel ?? 'web',
    ],
  )
  return rows[0]
}

/** Busca una acción por su token. null si no existe. */
export async function getActionByToken(token: string): Promise<ActionRow | null> {
  const { rows } = await pool.query<ActionRow>('SELECT * FROM comandi.action_log WHERE confirm_token = $1', [token])
  return rows[0] ?? null
}

export async function markExecuted(id: string, result: any): Promise<void> {
  await pool.query(
    `UPDATE comandi.action_log SET status='executed', result=$2, executed_at=now() WHERE id=$1`,
    [id, JSON.stringify(result ?? {})],
  )
}

export async function markFailed(id: string, error: string): Promise<void> {
  await pool.query(`UPDATE comandi.action_log SET status='failed', error=$2 WHERE id=$1`, [id, error])
}

export async function markRejected(id: string): Promise<void> {
  await pool.query(`UPDATE comandi.action_log SET status='rejected' WHERE id=$1`, [id])
}
