// POST /comandi/ask
// Body: { location_id | location_ids, question }
// Chat de Comandi. Ahora usa el motor AGÉNTICO: responde sobre TODO el negocio
// (ventas, costos, caja, inventario, compras…) trayendo los datos que necesite.
// Se mantiene por compatibilidad; el copiloto principal usa /comandi/agent.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { locationFields, normalizeLocationIds, resolveTenant } from '../lib/resolve.js'
import { TenantError } from '../db/tenant.js'
import { comandiPersona } from '../llm/persona.js'
import { buildBusinessTools } from '../llm/tools.js'
import { runAgent, AgentError } from '../llm/agent.js'
import { logUsage } from '../db/usage-log.js'
import '../actions/index.js'

const Body = z.object({
  ...locationFields,
  question: z.string().min(1).max(2000),
})

const SYSTEM = comandiPersona(
  `Eres el copiloto del negocio de un restaurante. Respondes sobre TODO: ventas, costos, caja, inventario, compras/suplidores, cobros/pagos, propinas, mesas.
Reglas:
- Para datos REALES usa las herramientas (get_report para reportes; get_procurement_context para compras/proveedores). Puedes llamarlas varias veces y combinar.
- NO inventes cifras: básate solo en lo que devuelven las herramientas. Si no está, dilo.
- Español, conciso, montos en RD$ con separador de miles y viñetas al enumerar.`,
)

export function askRoutes(app: FastifyInstance) {
  app.post('/comandi/ask', async (req, reply) => {
    const parsed = Body.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Body inválido', errors: parsed.error.flatten() })

    try {
      const locationIds = normalizeLocationIds(parsed.data)
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const userId = req.actor?.type === 'user' ? req.actor.userId : null
      const tools = buildBusinessTools({
        businessUnitId,
        allowedLocationIds: locationIds,
        activeLocationId: locationIds[0],
        branches: [],
        userId,
      })
      const today = new Date().toISOString().slice(0, 10)
      // Sin sucursal activa (endpoint sin contexto de pantalla): por defecto consolida TODAS.
      const scope = `Sucursales de la empresa: ${locationIds.join(', ')}. Si el usuario no especifica sucursal, CONSIDERA TODAS (pasa location_ids=[${locationIds.join(',')}] en get_report).`
      const result = await runAgent(config, `${SYSTEM}\n\nHoy es ${today}.\n${scope}`, parsed.data.question, tools, [])
      logUsage({ businessUnitId, userId, endpoint: 'ask' }, result.usage, { steps: result.steps.length })

      return { success: true, enabled: true, provider: config.provider, model: config.model, answer: result.answer }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof AgentError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error procesando la pregunta' })
    }
  })
}
