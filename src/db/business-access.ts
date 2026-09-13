import { query } from './pool.js'
import { getUserLocationIds } from './access.js'
import { resolveBusinessUnit, TenantError } from './tenant.js'

export async function assertBusinessAccess(userId: number | null | undefined, businessUnitId: number, ids: number[], screen: string, action = 'read', companyWide = false) {
  if (!userId || !ids.length) throw new TenantError('Esta capacidad requiere un usuario y alcance explícitos.',403)
  const allowed = await getUserLocationIds(userId)
  if (ids.some(id => !allowed.includes(Number(id))) || Number(await resolveBusinessUnit(ids)) !== Number(businessUnitId)) throw new TenantError('Sin acceso a este alcance.',403)
  const permissions = await query<{ allowed: boolean }>(`
    SELECT COALESCE((SELECT bool_and(up.granted) FROM finances.user_permissions up
      JOIN finances.screens s ON s.id=up.screen_id JOIN finances.actions a ON a.id=up.action_id
      WHERE up.user_id=$1 AND up.status_id=1 AND s.status_id=1 AND s.code=$2 AND a.code=$3
        AND (up.expires_at IS NULL OR up.expires_at>now())),
      EXISTS(SELECT 1 FROM finances.user_profiles p
        CROSS JOIN LATERAL finances.fn_get_profile_effective_permissions(p.profile_id) eff
        JOIN finances.screens s ON s.id=eff.screen_id JOIN finances.actions a ON a.id=eff.action_id
        WHERE p.user_id=$1 AND p.status_id=1 AND eff.granted=true AND s.status_id=1 AND s.code=$2 AND a.code=$3
          AND (p.valid_from IS NULL OR p.valid_from<=now()) AND (p.valid_until IS NULL OR p.valid_until>now()))) AS allowed
    FROM common.users u WHERE u.use_id=$1 AND u.use_sta_id=1`, [userId,screen,action])
  if (!permissions[0]?.allowed) throw new TenantError('No tienes permiso para esta capacidad.',403)
  if (companyWide) {
    const branches = await query<{id:number}>('SELECT id FROM human_resource.locations WHERE business_unit_id=$1',[businessUnitId])
    if (branches.some(b => !ids.includes(Number(b.id)))) throw new TenantError('Este reporte es de toda la empresa. Requiere seleccionar todas sus sucursales y tener acceso a cada una.',403)
  }
}
