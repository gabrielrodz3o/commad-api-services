// Rutas de Telegram:
//   POST /comandi/telegram/link-code  (JWT usuario) → genera código de vínculo
//   POST /comandi/telegram/status     (JWT usuario) → ¿este usuario está vinculado?
//   POST /comandi/telegram/briefing   (JWT usuario) → activa/desactiva briefing diario
//   POST /comandi/telegram/run-briefings (token de servicio) → lo llama el cron/n8n
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { telegramEnabled, getBotUsername } from '../telegram/api.js'
import { createLinkCode, getChatsByUser, setBriefing } from '../db/telegram.js'
import { runDueBriefings } from '../telegram/briefing.js'

export function telegramRoutes(app: FastifyInstance) {
  app.post('/comandi/telegram/link-code', async (req, reply) => {
    if (req.actor?.type !== 'user') return reply.code(401).send({ success: false, message: 'Requiere sesión de usuario' })
    if (!telegramEnabled()) return reply.code(503).send({ success: false, message: 'Telegram no está configurado en el servidor' })

    const code = await createLinkCode(req.actor.userId)
    const bot = await getBotUsername()
    return {
      success: true,
      code,
      bot_username: bot,
      deep_link: bot ? `https://t.me/${bot}?start=${code}` : null,
      expires_minutes: 10,
    }
  })

  app.post('/comandi/telegram/status', async (req, reply) => {
    if (req.actor?.type !== 'user') return reply.code(401).send({ success: false, message: 'Requiere sesión de usuario' })
    const chats = await getChatsByUser(req.actor.userId)
    return { success: true, linked: chats.length > 0, chats: chats.length, bot_username: await getBotUsername() }
  })

  const BriefingBody = z.object({ enabled: z.boolean(), hour_local: z.number().int().min(0).max(23).optional() })
  app.post('/comandi/telegram/briefing', async (req, reply) => {
    if (req.actor?.type !== 'user') return reply.code(401).send({ success: false, message: 'Requiere sesión de usuario' })
    const parsed = BriefingBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Body inválido' })
    await setBriefing(req.actor.userId, parsed.data.enabled, parsed.data.hour_local ?? 8)
    return { success: true, enabled: parsed.data.enabled }
  })

  // Disparado por cron/n8n cada hora (token de servicio). Envía a quienes toque.
  const RunBody = z.object({ hour_local: z.number().int().min(0).max(23).optional() })
  app.post('/comandi/telegram/run-briefings', async (req, reply) => {
    if (req.actor?.type !== 'service') return reply.code(403).send({ success: false, message: 'Solo interno' })
    const parsed = RunBody.safeParse(req.body || {})
    const hour = parsed.success && parsed.data.hour_local != null ? parsed.data.hour_local : new Date().getHours()
    const out = await runDueBriefings(hour)
    return { success: true, ...out, hour }
  })
}
