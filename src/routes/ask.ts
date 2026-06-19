// POST /comandi/ask
// Body: { location_id | location_ids, question }
// Chat de Comandi anclado en los datos reales de compras de la empresa.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { locationFields, resolveTenant } from '../lib/resolve.js'
import { TenantError } from '../db/tenant.js'
import { buildProcurementContext } from '../context/procurement.js'
import { comandiPersona } from '../llm/persona.js'
import { generateText, LLMError } from '../llm/provider.js'

const Body = z.object({
  ...locationFields,
  question: z.string().min(1).max(2000),
})

const SYSTEM = comandiPersona(
  `Actúas como el Copiloto de Compras (procurement). Respondes sobre spend, suplidores, maverick spend, contratos, requisiciones pendientes, discrepancias 3-way-match y presupuesto.
Reglas:
- Usa viñetas cuando enumeres. Montos en RD$ con separador de miles.
- Básate ÚNICAMENTE en los DATOS de contexto. Si no está, dilo; NO inventes cifras.
- Si detectas un riesgo u oportunidad, proponlo. No incluyas el JSON crudo.`,
)

export function askRoutes(app: FastifyInstance) {
  app.post('/comandi/ask', async (req, reply) => {
    const parsed = Body.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Body inválido', errors: parsed.error.flatten() })

    try {
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const context = await buildProcurementContext(businessUnitId)
      const answer = await generateText({
        config,
        system: SYSTEM,
        user: `Pregunta: "${parsed.data.question}"\n\nDATOS DE COMPRAS (JSON):\n${JSON.stringify(context)}`,
        maxTokens: 1200,
      })
      return { success: true, enabled: true, provider: config.provider, model: config.model, answer }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof LLMError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error procesando la pregunta' })
    }
  })
}
