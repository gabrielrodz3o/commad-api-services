// POST /comandi/agent
// Body: { location_id | location_ids, question, period? }
// Copiloto AGÉNTICO: el LLM usa herramientas para traer datos reales (cualquier
// reporte, cualquier período) y razonar across-dominios antes de responder.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { locationFields, normalizeLocationIds, resolveTenant } from '../lib/resolve.js'
import { TenantError } from '../db/tenant.js'
import { comandiPersona } from '../llm/persona.js'
import { buildBusinessTools } from '../llm/tools.js'
import { runAgent, AgentError } from '../llm/agent.js'

const Body = z.object({
  ...locationFields,
  question: z.string().min(1).max(2000),
  period: z.object({ from: z.string().optional(), to: z.string().optional() }).nullish(),
  // Sucursal activa (donde navega el usuario) + catálogo de sucursales (id+nombre).
  active_location_id: z.coerce.number().int().positive().optional(),
  branches: z.array(z.object({ id: z.coerce.number().int(), name: z.string() })).optional(),
  // Memoria conversacional: turnos previos (solo texto).
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).optional(),
})

const SYSTEM = comandiPersona(
  `Eres el copiloto del negocio de un restaurante. Respondes preguntas del dueño/gerente sobre TODO el negocio: ventas, costos, caja, inventario, compras, cobros/pagos, propinas, mesas, etc.
Reglas:
- Para obtener datos REALES usa la herramienta get_report (puedes llamarla varias veces, para distintos dominios o períodos, y combinar los resultados).
- NO inventes cifras: básate solo en lo que devuelven las herramientas. Si un dato no está disponible, dilo.
- Responde en español, conciso, con números concretos en RD$ y viñetas cuando enumeres.
- Si la pregunta abarca varias áreas (ej. "¿por qué bajó mi utilidad?"), trae los reportes relevantes y conecta los puntos.`,
)

export function agentRoutes(app: FastifyInstance) {
  app.post('/comandi/agent', async (req, reply) => {
    const parsed = Body.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Body inválido', errors: parsed.error.flatten() })

    try {
      const locationIds = normalizeLocationIds(parsed.data)
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const branches = (parsed.data.branches || []).filter((b) => locationIds.includes(b.id))
      const activeId = parsed.data.active_location_id && locationIds.includes(parsed.data.active_location_id)
        ? parsed.data.active_location_id
        : locationIds[0]

      const tools = buildBusinessTools({
        businessUnitId,
        allowedLocationIds: locationIds,
        activeLocationId: activeId,
        branches,
        defaultPeriod: parsed.data.period,
      })

      // Contexto: fecha de hoy + sucursales (para alcance correcto).
      const today = parsed.data.period?.to || new Date().toISOString().slice(0, 10)
      const branchList = branches.length
        ? branches.map((b) => `${b.id}: ${b.name}${b.id === activeId ? ' (ACTIVA)' : ''}`).join(' · ')
        : `${activeId} (activa)`
      const scopeRule = `
Sucursales de la empresa: ${branchList}.
ALCANCE: si el usuario NO menciona sucursal, usa SOLO la ACTIVA (no pongas location_ids en get_report). Si dice "todas"/"consolidado", pasa los ids de todas. Si nombra una sucursal, pasa su id. SIEMPRE menciona en tu respuesta qué sucursal(es) consideraste; si usaste solo la activa y hay más de una, ofrece al final el consolidado de todas.`
      const system = `${SYSTEM}\n\nHoy es ${today} (úsalo para "hoy", "semana pasada", "mes pasado", etc., y pasa las fechas a get_report).${scopeRule}`

      const result = await runAgent(config, system, parsed.data.question, tools, parsed.data.history || [])
      return {
        success: true,
        enabled: true,
        provider: config.provider,
        model: config.model,
        answer: result.answer,
        tools_used: result.steps.map((s) => s.tool),
      }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof AgentError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error en el copiloto' })
    }
  })
}
