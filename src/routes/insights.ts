// POST /comandi/insights
// Body: { location_id | location_ids, domain, report }
// Análisis ejecutivo estructurado de un reporte ya calculado por el front.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { locationFields, normalizeLocationIds, resolveTenant } from '../lib/resolve.js'
import { TenantError } from '../db/tenant.js'
import { generateReportInsights } from '../context/report-insights.js'
import { fetchReportForDomain, domainSupportsFetch } from '../context/report-registry.js'
import { LLMError } from '../llm/provider.js'

const Body = z.object({
  ...locationFields,
  domain: z.string().min(1),
  // report es OPCIONAL: si la página ya lo calculó, lo pasa (fast-path, no recalcula).
  // Si no viene (flujo autónomo), Comandi lo trae del core.
  report: z.record(z.any()).optional(),
  period: z.object({ from: z.string().optional(), to: z.string().optional() }).nullish(),
})

export function insightsRoutes(app: FastifyInstance) {
  app.post('/comandi/insights', async (req, reply) => {
    const parsed = Body.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Body inválido', errors: parsed.error.flatten() })

    try {
      const locationIds = normalizeLocationIds(parsed.data)
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      // report: fast-path (lo pasó la página) o lo trae Comandi del core (autónomo).
      let report = parsed.data.report
      if (!report) {
        if (!domainSupportsFetch(parsed.data.domain)) {
          return reply.code(400).send({ success: false, message: `El dominio "${parsed.data.domain}" requiere que se envíe el reporte (sin fetch configurado).` })
        }
        report = await fetchReportForDomain(parsed.data.domain, {
          businessUnitId,
          locationIds,
          period: parsed.data.period,
        })
      }

      const insights = await generateReportInsights(config, parsed.data.domain, report, parsed.data.period)
      return { success: true, enabled: true, provider: config.provider, model: config.model, insights }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof LLMError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error generando insights' })
    }
  })
}
