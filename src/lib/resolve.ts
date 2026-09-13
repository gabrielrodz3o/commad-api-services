// Normaliza location_id|location_ids y resuelve (empresa + config de IA).
import { z } from 'zod'
import { resolveBusinessUnit, getAIConfig, TenantError, type CompanyAIConfig } from '../db/tenant.js'
import { getUserLocationIds } from '../db/access.js'
import type { Actor } from '../plugins/auth.js'

export const locationFields = {
  business_unit_id: z.coerce.number().int().positive().optional(),
  active_location_id: z.coerce.number().int().positive().optional(),
  location_id: z.coerce.number().int().positive().optional(),
  location_ids: z.array(z.coerce.number().int().positive()).optional(),
}

export function normalizeLocationIds(body: { location_id?: number; location_ids?: number[]; business_unit_id?: number; active_location_id?: number }): number[] {
  const ids = body.location_ids?.length ? body.location_ids : (body.location_id ? [body.location_id] : [])
  const unique = Array.from(new Set(ids))
  if (!unique.length) throw new TenantError('Falta location_id o location_ids.')
  return unique
}

export interface ResolvedTenant {
  businessUnitId: number
  config: CompanyAIConfig | null // null = IA no habilitada para esta empresa
}

export async function resolveTenant(
  body: { location_id?: number; location_ids?: number[]; business_unit_id?: number; active_location_id?: number },
  actor?: Actor,
): Promise<ResolvedTenant> {
  const locationIds = normalizeLocationIds(body)

  // RBAC: si quien llama es un USUARIO (frontend directo), verificar que tiene
  // acceso a esas sucursales. El token de servicio (core) ya hizo RBAC arriba.
  if (actor?.type === 'user') {
    const allowed = new Set(await getUserLocationIds(actor.userId))
    const denied = locationIds.filter((id) => !allowed.has(id))
    if (denied.length) {
      throw new TenantError(`Sin acceso a la(s) sucursal(es): ${denied.join(', ')}`, 403)
    }
  }

  const businessUnitId = await resolveBusinessUnit(locationIds)
  if (body.business_unit_id && Number(body.business_unit_id) !== Number(businessUnitId)) throw new TenantError('La empresa activa no corresponde a las sucursales.', 403)
  if (body.active_location_id && !locationIds.includes(Number(body.active_location_id))) {
    const activeBu = await resolveBusinessUnit([Number(body.active_location_id)])
    if (Number(activeBu) !== Number(businessUnitId)) throw new TenantError('La sucursal activa pertenece a otra empresa.', 403)
    if (actor?.type === 'user' && !(await getUserLocationIds(actor.userId)).includes(Number(body.active_location_id))) throw new TenantError('Sin acceso a la sucursal activa.',403)
  }
  const config = await getAIConfig(businessUnitId)
  return { businessUnitId, config }
}
