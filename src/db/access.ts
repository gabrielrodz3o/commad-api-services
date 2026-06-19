// RBAC: sucursales (location_ids) a las que un usuario tiene acceso.
// Misma fuente que el core: finances.user_access.access (jsonb de location ids).
import { query } from './pool.js'

export async function getUserLocationIds(userId: number): Promise<number[]> {
  const rows = await query<{ loc: number }>(
    `SELECT (jsonb_array_elements_text(access::jsonb))::int AS loc
       FROM finances.user_access
      WHERE user_id = $1`,
    [userId],
  )
  return rows.map((r) => r.loc)
}
