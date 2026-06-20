// POST /comandi/usage  { location_ids, date_from?, date_to? }
// Consumo de IA de la empresa (BYO-key, control de gasto): agrega comandi.usage_log
// por la BU del usuario (RBAC). Devuelve totales + desglose por día / endpoint / modelo.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { locationFields, resolveTenant } from '../lib/resolve.js'
import { TenantError } from '../db/tenant.js'
import { query } from '../db/pool.js'

const Body = z.object({
  ...locationFields,
  date_from: z.string().optional(),
  date_to: z.string().optional(),
})

function firstOfMonth(): string {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), 1).toISOString().slice(0, 10)
}

export function usageRoutes(app: FastifyInstance) {
  app.post('/comandi/usage', async (req, reply) => {
    const parsed = Body.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Body inválido' })

    try {
      const { businessUnitId } = await resolveTenant(parsed.data, req.actor)
      const from = parsed.data.date_from || firstOfMonth()
      const to = parsed.data.date_to || new Date().toISOString().slice(0, 10)
      const args = [businessUnitId, from, to]
      const where = 'business_unit_id = $1 AND created_at::date BETWEEN $2 AND $3'

      const totals = await query(
        `SELECT count(*)::int AS requests,
                COALESCE(SUM(tokens_in),0)::int AS tokens_in,
                COALESCE(SUM(tokens_out),0)::int AS tokens_out,
                COALESCE(SUM(cost_usd),0)::float8 AS cost_usd,
                COALESCE(SUM(CASE WHEN ok THEN 0 ELSE 1 END),0)::int AS errores
           FROM comandi.usage_log WHERE ${where}`,
        args,
      )
      const byDay = await query(
        `SELECT created_at::date AS day, count(*)::int AS requests,
                COALESCE(SUM(tokens_in+tokens_out),0)::int AS tokens,
                COALESCE(SUM(cost_usd),0)::float8 AS cost_usd
           FROM comandi.usage_log WHERE ${where} GROUP BY 1 ORDER BY 1`,
        args,
      )
      const byEndpoint = await query(
        `SELECT endpoint, count(*)::int AS requests, COALESCE(SUM(cost_usd),0)::float8 AS cost_usd
           FROM comandi.usage_log WHERE ${where} GROUP BY 1 ORDER BY cost_usd DESC`,
        args,
      )
      const byModel = await query(
        `SELECT provider, model, count(*)::int AS requests,
                COALESCE(SUM(tokens_in+tokens_out),0)::int AS tokens,
                COALESCE(SUM(cost_usd),0)::float8 AS cost_usd
           FROM comandi.usage_log WHERE ${where} GROUP BY 1,2 ORDER BY cost_usd DESC`,
        args,
      )

      return { success: true, period: { from, to }, totals: totals[0], by_day: byDay, by_endpoint: byEndpoint, by_model: byModel }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error consultando el consumo de IA' })
    }
  })
}
