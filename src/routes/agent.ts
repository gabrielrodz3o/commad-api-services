// POST /comandi/agent
// Body: { location_id | location_ids, question, period? }
// Copiloto AGÉNTICO: el LLM usa herramientas para traer datos reales (cualquier
// reporte, cualquier período) y razonar across-dominios antes de responder.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { locationFields, normalizeLocationIds, resolveTenant } from '../lib/resolve.js'
import { TenantError } from '../db/tenant.js'
import { comandiPersona } from '../llm/persona.js'
import { buildBusinessTools, type ProposedAction } from '../llm/tools.js'
import { runAgent, AgentError, type Tool } from '../llm/agent.js'
import { runAgentStream } from '../llm/agent-stream.js'
import { logUsage } from '../db/usage-log.js'
import type { CompanyAIConfig } from '../db/tenant.js'
import type { Actor } from '../plugins/auth.js'
import '../actions/index.js' // registra las acciones de escritura disponibles

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
- Si la pregunta abarca varias áreas (ej. "¿por qué bajó mi utilidad?"), trae los reportes relevantes y conecta los puntos.
- ACCIONES: si el usuario pide HACER algo (ej. "ponle una nota a X", "anota que..."), usa la herramienta propose_* correspondiente. Esas herramientas NO ejecutan: solo PROPONEN. Tras proponer, dile al usuario en una frase qué vas a hacer y que lo confirme con el botón; NUNCA afirmes que ya quedó hecho. Si la herramienta pide una aclaración (needs_clarification), pásasela al usuario.`,
)

type Parsed = z.infer<typeof Body>
interface Prepared {
  businessUnitId: number
  config: CompanyAIConfig
  system: string
  tools: Tool[]
  proposals: ProposedAction[]
  userId: number | null
}

// Monta tools + system + sink de propuestas (compartido por /agent y /agent/stream).
// Devuelve null si la empresa no tiene IA activada.
async function prepareRun(data: Parsed, actor?: Actor): Promise<Prepared | null> {
  const locationIds = normalizeLocationIds(data)
  const { businessUnitId, config } = await resolveTenant(data, actor)
  if (!config) return null

  const branches = (data.branches || []).filter((b) => locationIds.includes(b.id))
  const activeId = data.active_location_id && locationIds.includes(data.active_location_id)
    ? data.active_location_id
    : locationIds[0]

  const userId = actor?.type === 'user' ? actor.userId : null
  const proposals: ProposedAction[] = []
  const tools = buildBusinessTools({
    businessUnitId, allowedLocationIds: locationIds, activeLocationId: activeId,
    branches, defaultPeriod: data.period, userId, proposals,
  })

  const today = data.period?.to || new Date().toISOString().slice(0, 10)
  const branchList = branches.length
    ? branches.map((b) => `${b.id}: ${b.name}${b.id === activeId ? ' (ACTIVA)' : ''}`).join(' · ')
    : `${activeId} (activa)`
  const scopeRule = `
Sucursales de la empresa: ${branchList}.
ALCANCE: si el usuario NO menciona sucursal, usa SOLO la ACTIVA (no pongas location_ids en get_report). Si dice "todas"/"consolidado", pasa los ids de todas. Si nombra una sucursal, pasa su id. SIEMPRE menciona en tu respuesta qué sucursal(es) consideraste; si usaste solo la activa y hay más de una, ofrece al final el consolidado de todas.`
  const system = `${SYSTEM}\n\nHoy es ${today} (úsalo para "hoy", "semana pasada", "mes pasado", etc., y pasa las fechas a get_report).${scopeRule}`

  return { businessUnitId, config, system, tools, proposals, userId }
}

export function agentRoutes(app: FastifyInstance) {
  // ── No streaming (JSON) ────────────────────────────────────────────────────
  app.post('/comandi/agent', async (req, reply) => {
    const parsed = Body.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Body inválido', errors: parsed.error.flatten() })

    try {
      const p = await prepareRun(parsed.data, req.actor)
      if (!p) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const result = await runAgent(p.config, p.system, parsed.data.question, p.tools, parsed.data.history || [])
      logUsage({ businessUnitId: p.businessUnitId, userId: p.userId, endpoint: 'agent' }, result.usage, { steps: result.steps.length })

      return {
        success: true, enabled: true, provider: p.config.provider, model: p.config.model,
        answer: result.answer,
        tools_used: result.steps.map((s) => s.tool),
        pending_action: p.proposals.length ? p.proposals[p.proposals.length - 1] : null,
      }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof AgentError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error en el copiloto' })
    }
  })

  // ── Streaming (SSE token-a-token) ──────────────────────────────────────────
  app.post('/comandi/agent/stream', async (req, reply) => {
    const parsed = Body.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Body inválido' })

    let p: Prepared | null
    try {
      p = await prepareRun(parsed.data, req.actor)
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      throw e
    }
    if (!p) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    const send = (event: string, data: any) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    send('meta', { provider: p.config.provider, model: p.config.model })

    try {
      const result = await runAgentStream(p.config, p.system, parsed.data.question, p.tools, parsed.data.history || [], send)
      logUsage({ businessUnitId: p.businessUnitId, userId: p.userId, endpoint: 'agent' }, result.usage, { steps: result.steps.length })
      send('done', {
        answer: result.answer,
        tools_used: result.steps.map((s) => s.tool),
        pending_action: p.proposals.length ? p.proposals[p.proposals.length - 1] : null,
      })
    } catch (e: any) {
      send('error', { message: e?.message || 'Error en el copiloto' })
    } finally {
      reply.raw.end()
    }
    return reply
  })
}
