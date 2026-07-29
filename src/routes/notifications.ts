// Rutas del sistema de notificaciones por correo:
//   POST /comandi/notifications/run       (token de servicio) → tick del
//        dispatcher (watchers + outbox + reportes programados). Lo llama el
//        cron externo (n8n) cada 1–5 min. Idempotente.
//   POST /comandi/notifications/smtp-test (token de servicio; el core hace de
//        proxy autenticado) → verifica credenciales SMTP y envía un correo de
//        prueba. Acepta credenciales inline (override) para probar ANTES de
//        guardar; si no vienen, usa las guardadas de la compañía.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { env } from '../config/env.js'
import { query } from '../db/pool.js'
import { runNotificationsTick } from '../notifications/dispatcher.js'
import { getSmtpConfigForCompany, suppressEmail, type SmtpConfig } from '../db/notifications.js'
import { verifyAndTest } from '../email/smtp.js'

const OverrideSchema = z.object({
  smtp_host: z.string().min(1),
  smtp_port: z.coerce.number().int().min(1).max(65535),
  smtp_secure: z.boolean().default(false),
  smtp_user: z.string().min(1),
  smtp_password: z.string().min(1),
  from_email: z.string().email(),
  from_name: z.string().nullish(),
}).strict()

const SmtpTestBody = z.object({
  company_id: z.coerce.number().int().positive(),
  to_email: z.string().email(),
  override: OverrideSchema.optional(),
})

export function notificationRoutes(app: FastifyInstance) {
  app.post('/comandi/notifications/run', async (req, reply) => {
    if (req.actor?.type !== 'service') return reply.code(403).send({ success: false, message: 'Solo interno' })
    const out = await runNotificationsTick()
    return { success: true, ...out }
  })

  app.post('/comandi/notifications/smtp-test', async (req, reply) => {
    if (req.actor?.type !== 'service' && req.actor?.type !== 'user') {
      return reply.code(401).send({ success: false, message: 'No autorizado' })
    }
    const parsed = SmtpTestBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ success: false, message: 'Body inválido: ' + parsed.error.issues.map((i) => i.path.join('.')).join(', ') })
    }
    const { company_id, to_email, override } = parsed.data

    let config: SmtpConfig | null
    if (override) {
      config = {
        company_id,
        smtp_host: override.smtp_host,
        smtp_port: override.smtp_port,
        smtp_secure: !!override.smtp_secure,
        smtp_user: override.smtp_user,
        smtp_password: override.smtp_password,
        from_email: override.from_email,
        from_name: override.from_name || null,
        reply_to: null,
        is_active: true,
        daily_send_limit: 300,
        pos_base_url: null,
      }
    } else {
      if (!env.NOTIF_SMTP_ENC_KEY) {
        return reply.code(503).send({ success: false, message: 'NOTIF_SMTP_ENC_KEY no configurada en el servicio' })
      }
      config = await getSmtpConfigForCompany(company_id)
      if (!config) {
        return reply.code(404).send({ success: false, message: 'La compañía no tiene servidor SMTP configurado' })
      }
    }

    try {
      const result = await verifyAndTest(config, to_email)
      await query(
        `UPDATE notifications.company_smtp_config
            SET last_test_at = now(), last_test_ok = true, updated_at = now()
          WHERE company_id = $1`,
        [company_id],
      ).catch(() => {})
      return { success: true, message: `Correo de prueba enviado a ${to_email}`, message_id: result.messageId }
    } catch (e: any) {
      await query(
        `UPDATE notifications.company_smtp_config
            SET last_test_at = now(), last_test_ok = false, updated_at = now()
          WHERE company_id = $1`,
        [company_id],
      ).catch(() => {})
      const msg = String(e?.message || 'No se pudo conectar al servidor SMTP')
      return reply.code(422).send({ success: false, message: msg })
    }
  })

  // Webhook de Resend: rebotes duros y quejas de spam → suprimir el destinatario
  // para proteger la reputación del remitente (dejar de enviarle = menos spam).
  // Auth: secreto en la query (?token=NOTIF_WEBHOOK_SECRET). Fail-closed.
  app.post('/comandi/notifications/resend-webhook', async (req, reply) => {
    const token = (req.query as any)?.token || ''
    if (!env.NOTIF_WEBHOOK_SECRET || token !== env.NOTIF_WEBHOOK_SECRET) {
      return reply.code(401).send({ success: false, message: 'No autorizado' })
    }
    const body = req.body as any
    const type: string = body?.type || ''
    const data = body?.data || {}
    // Solo rebotes duros y quejas desactivan al destinatario.
    const suppress = type === 'email.bounced' || type === 'email.complained'
    if (!suppress) return { success: true, ignored: type || 'sin tipo' }

    const emails: string[] = Array.isArray(data.to) ? data.to
      : (typeof data.to === 'string' ? [data.to] : (data.email ? [data.email] : []))
    const reason = type === 'email.complained' ? 'complaint' : 'bounce'
    let n = 0
    for (const e of emails) {
      if (typeof e === 'string' && e.includes('@')) {
        await suppressEmail(e, reason, `resend:${type}`).catch(() => {})
        n++
      }
    }
    req.log.warn({ type, emails }, 'resend webhook: destinatarios suprimidos')
    return { success: true, suppressed: n, reason }
  })
}
