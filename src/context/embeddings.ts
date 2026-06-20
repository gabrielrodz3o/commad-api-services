// Embeddings con OpenAI (text-embedding-3-small, 1536 dims). Resuelve la llave:
// la de la empresa si usa OpenAI, si no la global (Anthropic no genera embeddings).
import OpenAI from 'openai'
import { getAIConfig } from '../db/tenant.js'
import { env } from '../config/env.js'

export async function resolveOpenAIKey(businessUnitId: number): Promise<string> {
  const cfg = await getAIConfig(businessUnitId).catch(() => null)
  if (cfg?.provider === 'openai' && cfg.apiKey) return cfg.apiKey
  return env.OPENAI_API_KEY || cfg?.apiKey || ''
}

export async function embed(text: string, businessUnitId: number): Promise<number[]> {
  const key = await resolveOpenAIKey(businessUnitId)
  if (!key) throw new Error('Sin llave de OpenAI para generar embeddings')
  const client = new OpenAI({ apiKey: key })
  const res = await client.embeddings.create({ model: 'text-embedding-3-small', input: text.slice(0, 8000) })
  return res.data[0].embedding
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}
