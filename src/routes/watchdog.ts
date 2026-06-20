// VIGILANTE proactivo.
//   POST /comandi/watchdog/check  (JWT usuario)   → corre las reglas y devuelve alertas
//   POST /comandi/watchdog/run    (token servicio) → cron/n8n: revisa a todos los
//        usuarios vinculados a Telegram y les empuja sus alertas (si hay).
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { locationFields, normalizeLocationIds, resolveTenant } from '../lib/resolve.js'
import { TenantError } from '../db/tenant.js'
import { runWatchdog, runWatchdogForUser, formatAlerts } from '../watchdog/run.js'
import { getAllLinks } from '../db/telegram.js'
import { getAllPushByUser } from '../db/push.js'
import { sendMessage } from '../telegram/api.js'
import { sendExpoPush } from '../push/expo.js'

export function watchdogRoutes(app: FastifyInstance) {
  // On-demand (para mostrar "qué necesita atención" en la app).
  app.post('/comandi/watchdog/check', async (req, reply) => {
    const parsed = z.object({ ...locationFields }).safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Body inválido' })
    try {
      const locationIds = normalizeLocationIds(parsed.data)
      const { businessUnitId } = await resolveTenant(parsed.data, req.actor)
      const alerts = await runWatchdog(businessUnitId, locationIds)
      return { success: true, count: alerts.length, alerts }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error en el vigilante' })
    }
  })

  // Cron: revisa a todos los suscriptores (Telegram + push móvil) y les empuja sus
  // alertas por TODOS sus canales. Una sola corrida del vigilante por usuario. Solo interno.
  app.post('/comandi/watchdog/run', async (req, reply) => {
    if (req.actor?.type !== 'service') return reply.code(403).send({ success: false, message: 'Solo interno' })

    const links = await getAllLinks()
    const pushByUser = await getAllPushByUser()
    const chatsByUser = new Map<number, number[]>()
    for (const l of links) {
      const arr = chatsByUser.get(l.user_id) || []
      arr.push(l.chat_id)
      chatsByUser.set(l.user_id, arr)
    }
    const users = new Set<number>([...chatsByUser.keys(), ...pushByUser.keys()])

    let alerted = 0
    for (const userId of users) {
      try {
        const alerts = await runWatchdogForUser(userId)
        if (!alerts.length) continue
        const msg = formatAlerts(alerts)
        for (const chatId of chatsByUser.get(userId) || []) await sendMessage(chatId, msg, { parse_mode: 'Markdown' })
        const tokens = pushByUser.get(userId) || []
        if (tokens.length) {
          const title = `🔔 ${alerts.length} alerta(s) de tu negocio`
          const body = alerts.slice(0, 3).map((a) => a.title).join(' · ')
          await sendExpoPush(tokens, title, body, { type: 'watchdog' })
        }
        alerted++
      } catch (e: any) {
        req.log.error({ user: userId, err: e?.message }, 'watchdog push falló')
      }
    }
    return { success: true, checked: users.size, alerted }
  })
}
