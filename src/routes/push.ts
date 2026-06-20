// POST /comandi/push/register  (JWT) { expo_token, platform? }
// La app móvil registra su token de Expo para recibir alertas proactivas.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { registerPushToken } from '../db/push.js'

const Body = z.object({
  expo_token: z.string().min(10),
  platform: z.string().max(20).optional(),
})

export function pushRoutes(app: FastifyInstance) {
  app.post('/comandi/push/register', async (req, reply) => {
    if (req.actor?.type !== 'user') return reply.code(401).send({ success: false, message: 'Requiere sesión de usuario' })
    const parsed = Body.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Falta expo_token' })
    await registerPushToken(req.actor.userId, parsed.data.expo_token, parsed.data.platform)
    return { success: true }
  })
}
