// Telemetría de uso del LLM: acumulación de tokens + estimación de costo.
// El costo es BEST-EFFORT (precios públicos aprox., USD por 1M de tokens) — sirve
// para control de gasto por empresa, no para facturación exacta.

export interface AIUsage {
  provider: string
  model: string
  tokensIn: number
  tokensOut: number
}

export interface UsageMeta {
  businessUnitId?: number | null
  userId?: number | null
  endpoint: string // 'agent' | 'insights' | 'ask' | 'briefing'
}

// USD por 1M de tokens [input, output]. Match por prefijo de modelo; default conservador.
const PRICES: Array<[prefix: string, inUsd: number, outUsd: number]> = [
  ['claude-opus', 5, 25],
  ['claude-sonnet', 3, 15],
  ['claude-haiku', 1, 5],
  ['gpt-5.5', 5, 15],
  ['gpt-5.4-mini', 0.25, 2],
  ['gpt-5.4', 3, 12],
  ['gpt-5', 2.5, 10],
  ['gpt-4o-mini', 0.15, 0.6],
  ['gpt-4o', 2.5, 10],
]
const DEFAULT_PRICE: [number, number] = [1, 3]

export function estimateCostUsd(model: string, tokensIn: number, tokensOut: number): number {
  const m = (model || '').toLowerCase()
  const hit = PRICES.find(([p]) => m.startsWith(p))
  const [inUsd, outUsd] = hit ? [hit[1], hit[2]] : DEFAULT_PRICE
  const cost = (tokensIn / 1_000_000) * inUsd + (tokensOut / 1_000_000) * outUsd
  return Math.round(cost * 1_000_000) / 1_000_000 // 6 decimales
}

/** Acumula tokens de una respuesta del LLM (formatos OpenAI y Anthropic). */
export function addUsage(acc: AIUsage, raw: any): void {
  if (!raw) return
  // OpenAI Chat/Responses: prompt_tokens/completion_tokens o input_tokens/output_tokens
  const tin = raw.prompt_tokens ?? raw.input_tokens ?? 0
  const tout = raw.completion_tokens ?? raw.output_tokens ?? 0
  acc.tokensIn += Number(tin) || 0
  acc.tokensOut += Number(tout) || 0
}
