// Inserta telemetría de uso en comandi.usage_log. Fire-and-forget: NUNCA debe
// romper la respuesta al usuario — si el insert falla, solo se loguea por consola.
import { pool } from './pool.js'
import { estimateCostUsd, type AIUsage, type UsageMeta } from '../llm/usage.js'

export function logUsage(meta: UsageMeta, usage: AIUsage, opts: { steps?: number; ok?: boolean; meta?: Record<string, any> } = {}): void {
  const cost = estimateCostUsd(usage.model, usage.tokensIn, usage.tokensOut)
  pool
    .query(
      `INSERT INTO comandi.usage_log
         (business_unit_id, user_id, endpoint, provider, model, tokens_in, tokens_out, cost_usd, steps, ok, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        meta.businessUnitId ?? null,
        meta.userId ?? null,
        meta.endpoint,
        usage.provider,
        usage.model,
        usage.tokensIn,
        usage.tokensOut,
        cost,
        opts.steps ?? 0,
        opts.ok ?? true,
        JSON.stringify(opts.meta ?? {}),
      ],
    )
    .catch((e) => console.error('⚠️ usage_log insert falló:', e?.message))
}
