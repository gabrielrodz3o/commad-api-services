// Resolución multi-empresa de Comandi.
//
// En cada request: location_ids → business_unit (deben ser TODAS de la misma
// empresa) → config de IA (motor/modelo/llave elegida en business.vue), leída
// FRESCA cada vez (con caché corto opcional para no martillar la tabla).
import { query } from './pool.js'
import { env } from '../config/env.js'

export type AIProvider = 'openai' | 'anthropic'

export interface CompanyAIConfig {
  businessUnitId: number
  provider: AIProvider
  model: string
  apiKey: string
}

export const AI_MODEL_WHITELIST: Record<AIProvider, string[]> = {
  openai: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-4o', 'gpt-4o-mini'],
  anthropic: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
}
const AI_DEFAULT_MODEL: Record<AIProvider, string> = {
  openai: 'gpt-5.4',
  anthropic: 'claude-sonnet-4-6',
}

export class TenantError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

/**
 * Resuelve la unidad de negocio a partir de las location_ids.
 * Regla confirmada: TODAS las locations de un request deben ser de la MISMA
 * empresa; si llegan de empresas distintas, se rechaza.
 */
export async function resolveBusinessUnit(locationIds: number[]): Promise<number> {
  if (!locationIds.length) throw new TenantError('Debes enviar al menos un location_id.')

  const rows = await query<{ business_unit_id: number }>(
    `SELECT DISTINCT business_unit_id
       FROM human_resource.locations
      WHERE id = ANY($1::int[]) AND business_unit_id IS NOT NULL`,
    [locationIds],
  )

  if (rows.length === 0) throw new TenantError('No se encontró la unidad de negocio para esas sucursales.', 404)
  if (rows.length > 1) {
    throw new TenantError('Las sucursales (location_ids) pertenecen a empresas distintas. Envía solo sucursales de la misma empresa.', 422)
  }
  return rows[0].business_unit_id
}

// Caché corto en memoria de la config (evita leer la tabla en cada turno del chat
// sin quedarse con llaves viejas). TTL configurable.
const CONFIG_TTL_MS = 60_000
const cache = new Map<number, { cfg: CompanyAIConfig | null; at: number }>()

function isProvider(p: any): p is AIProvider {
  return p === 'openai' || p === 'anthropic'
}

/**
 * Config de IA de la empresa. Devuelve null si la IA está deshabilitada o no hay
 * llave (ni propia ni fallback). Fallback a OPENAI/ANTHROPIC del entorno.
 */
export async function getAIConfig(businessUnitId: number): Promise<CompanyAIConfig | null> {
  const cached = cache.get(businessUnitId)
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.cfg

  const rows = await query(
    `SELECT ai_enabled, ai_provider, ai_model, openai_api_key, anthropic_api_key
       FROM human_resource.business_units WHERE id = $1`,
    [businessUnitId],
  )
  const row = rows[0]

  let cfg: CompanyAIConfig | null = null
  if (row && row.ai_enabled) {
    const provider: AIProvider = isProvider(row.ai_provider) ? row.ai_provider : 'openai'
    const model = row.ai_model && AI_MODEL_WHITELIST[provider].includes(row.ai_model)
      ? row.ai_model
      : AI_DEFAULT_MODEL[provider]
    const apiKey = (provider === 'openai'
      ? (row.openai_api_key || env.OPENAI_API_KEY)
      : (row.anthropic_api_key || env.ANTHROPIC_API_KEY)) || ''
    if (apiKey) cfg = { businessUnitId, provider, model, apiKey }
  }

  cache.set(businessUnitId, { cfg, at: Date.now() })
  return cfg
}
