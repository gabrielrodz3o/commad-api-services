// Resuelve el alcance de un usuario de COMAND: su empresa (BU) DOMINANTE y las
// sucursales de esa empresa a las que tiene acceso (RBAC). Para usuarios multi-empresa
// se elige la BU con más sucursales accesibles. Usado por Telegram y el vigilante.
import { query } from '../db/pool.js'
import { getUserLocationIds } from '../db/access.js'

export interface UserScope {
  businessUnitId: number
  locationIds: number[]
}

export async function resolveUserScope(userId: number): Promise<UserScope | null> {
  const accessible = await getUserLocationIds(userId)
  if (!accessible.length) return null
  const rows = await query<{ business_unit_id: number; ids: number[] }>(
    `SELECT l.business_unit_id, array_agg(l.id) AS ids
       FROM human_resource.locations l
      WHERE l.id = ANY($1) AND l.business_unit_id IS NOT NULL
      GROUP BY l.business_unit_id
      ORDER BY count(*) DESC
      LIMIT 1`,
    [accessible],
  )
  if (!rows.length) return null
  return { businessUnitId: Number(rows[0].business_unit_id), locationIds: rows[0].ids.map(Number) }
}
