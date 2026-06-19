// Resolución de entidades (clientes/proveedores) para las acciones de escritura.
// Solo lectura; scope por empresa (business_unit_id).
import { query } from './pool.js'

export interface EntityHit {
  id: number
  name: string
}

/** Busca una entidad por id exacto o por nombre (ILIKE) dentro de la empresa. */
export async function findEntities(businessUnitId: number, term: string): Promise<EntityHit[]> {
  const t = (term || '').trim()
  if (!t) return []
  // Si es un id numérico, intenta match exacto primero.
  if (/^\d+$/.test(t)) {
    const byId = await query<EntityHit>(
      `SELECT id, name FROM finances.entities
       WHERE id = $1 AND business_unit_id = $2`,
      [Number(t), businessUnitId],
    )
    if (byId.length) return byId
  }
  return query<EntityHit>(
    `SELECT id, name FROM finances.entities
     WHERE business_unit_id = $1 AND name ILIKE '%' || $2 || '%'
     ORDER BY name LIMIT 6`,
    [businessUnitId, t],
  )
}
