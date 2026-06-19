// Contexto de ejecución de una acción: quién la propone y su alcance (RBAC).
export interface ActionContext {
  businessUnitId: number | null
  userId: number | null
  locationIds: number[] | null   // sucursales accesibles del usuario (RBAC)
  activeLocationId?: number | null
}
