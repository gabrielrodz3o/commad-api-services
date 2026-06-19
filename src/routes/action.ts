// POST /comandi/action/execute  { confirm_token }   → ejecuta una acción propuesta
// POST /comandi/action/reject    { confirm_token }   → descarta una acción propuesta
//
// Seguridad: el token es de un solo uso, expira a los 15 min, y SOLO lo puede
// confirmar el MISMO usuario que lo propuso (RBAC). El write real lo hace el core.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { executeActionByToken, rejectActionByToken } from '../actions/execute.js'

const Body = z.object({ confirm_token: z.string().min(8) })

export function actionRoutes(app: FastifyInstance) {
  app.post('/comandi/action/execute', async (req, reply) => {
    const parsed = Body.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Falta confirm_token' })

    const userId = req.actor?.type === 'user' ? req.actor.userId : null
    const out = await executeActionByToken(parsed.data.confirm_token, userId)
    switch (out.status) {
      case 'ok': return { success: true, executed: true, summary: out.summary, result: out.result }
      case 'already': return { success: true, already: true, message: 'La acción ya se había ejecutado', result: out.result }
      case 'notfound': return reply.code(404).send({ success: false, message: 'Acción no encontrada' })
      case 'forbidden': return reply.code(403).send({ success: false, message: 'Esta acción fue propuesta por otro usuario' })
      case 'expired': return reply.code(410).send({ success: false, message: 'La propuesta expiró. Pídele a Comandi que la genere de nuevo.' })
      case 'badstate': return reply.code(409).send({ success: false, message: `La acción no está pendiente (estado: ${out.current})` })
      default: return reply.code(502).send({ success: false, message: `No se pudo ejecutar la acción: ${out.message}` })
    }
  })

  app.post('/comandi/action/reject', async (req, reply) => {
    const parsed = Body.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Falta confirm_token' })
    const ok = await rejectActionByToken(parsed.data.confirm_token)
    if (!ok) return reply.code(404).send({ success: false, message: 'Acción no encontrada' })
    return { success: true, rejected: true }
  })
}
