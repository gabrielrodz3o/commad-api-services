// Rutas de autenticación / seguridad de cuenta:
//   POST /comandi/auth/password-reset-email (token de servicio) → envía el
//        correo de "olvidé mi contraseña" usando la config SMTP de PLATAFORMA
//        (notifications.platform_smtp_config, no la de una empresa/tenant).
//        El core (Nuxt) genera y guarda el token; este servicio solo envía.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getPlatformSmtpConfig } from '../db/notifications.js'
import { sendEmail } from '../email/smtp.js'
import { passwordResetEmail } from '../email/templates.js'

const PasswordResetEmailBody = z.object({
  to_email: z.string().email(),
  fullname: z.string().min(1),
  reset_url: z.string().url(),
  expires_minutes: z.coerce.number().int().positive().default(45),
}).strict()

export function authRoutes(app: FastifyInstance) {
  app.post('/comandi/auth/password-reset-email', async (req, reply) => {
    if (req.actor?.type !== 'service') {
      return reply.code(403).send({ success: false, message: 'Solo interno' })
    }

    const parsed = PasswordResetEmailBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ success: false, message: 'Body inválido: ' + parsed.error.issues.map((i) => i.path.join('.')).join(', ') })
    }
    const { to_email, fullname, reset_url, expires_minutes } = parsed.data

    const config = await getPlatformSmtpConfig()
    if (!config) {
      return reply.code(503).send({ success: false, message: 'SMTP de plataforma no configurado (notifications.platform_smtp_config)' })
    }

    try {
      const { subject, html } = passwordResetEmail({ fullname, resetUrl: reset_url, expiresMinutes: expires_minutes })
      const result = await sendEmail(config, { to: [to_email], subject, html })
      return { success: true, message_id: result.messageId }
    } catch (e: any) {
      const msg = String(e?.message || 'No se pudo enviar el correo de reset de contraseña')
      req.log.error({ err: e, to_email }, 'password-reset-email: fallo de envío')
      return reply.code(422).send({ success: false, message: msg })
    }
  })
}
