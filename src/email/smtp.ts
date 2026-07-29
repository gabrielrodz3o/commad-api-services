// Cliente SMTP multi-tenant: un transport de nodemailer por compañía, cacheado
// 60s (patrón db/tenant.ts::getAIConfig — la config puede cambiar en caliente
// desde el core sin reiniciar el servicio).
import nodemailer, { type Transporter } from 'nodemailer'
import type { SmtpConfig } from '../db/notifications.js'

const cache = new Map<number, { transporter: Transporter; config: SmtpConfig; at: number }>()
const TTL_MS = 60_000

function buildTransporter(config: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: config.smtp_host,
    port: config.smtp_port,
    secure: config.smtp_secure, // true = 465 SSL; false = STARTTLS
    auth: { user: config.smtp_user, pass: config.smtp_password },
    connectionTimeout: 15_000,
    socketTimeout: 20_000,
  })
}

export function transporterFor(config: SmtpConfig): Transporter {
  const hit = cache.get(config.company_id)
  if (hit && Date.now() - hit.at < TTL_MS
    && hit.config.smtp_host === config.smtp_host
    && hit.config.smtp_user === config.smtp_user
    && hit.config.smtp_password === config.smtp_password
    && hit.config.smtp_port === config.smtp_port
    && hit.config.smtp_secure === config.smtp_secure) {
    return hit.transporter
  }
  const transporter = buildTransporter(config)
  cache.set(config.company_id, { transporter, config, at: Date.now() })
  return transporter
}

export interface SendResult { messageId: string | null }

export interface MailAttachment { filename: string; content: Buffer; contentType?: string }

/** Envía un correo con la config de la compañía. Lanza si el SMTP rechaza. */
export async function sendEmail(config: SmtpConfig, opts: {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  html: string
  attachments?: MailAttachment[]
}): Promise<SendResult> {
  const transporter = transporterFor(config)
  const info = await transporter.sendMail({
    from: config.from_name ? `"${config.from_name}" <${config.from_email}>` : config.from_email,
    replyTo: config.reply_to || undefined,
    to: opts.to,
    cc: opts.cc?.length ? opts.cc : undefined,
    bcc: opts.bcc?.length ? opts.bcc : undefined,
    subject: opts.subject,
    html: opts.html,
    attachments: opts.attachments?.length
      ? opts.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType }))
      : undefined,
  })
  return { messageId: info?.messageId || null }
}

/** Prueba de conexión + envío (para el botón "Enviar correo de prueba"). */
export async function verifyAndTest(config: SmtpConfig, toEmail: string): Promise<SendResult> {
  const transporter = buildTransporter(config) // sin cache: credenciales pueden ser tentativas
  await transporter.verify()
  const info = await transporter.sendMail({
    from: config.from_name ? `"${config.from_name}" <${config.from_email}>` : config.from_email,
    to: toEmail,
    subject: '✅ Prueba de correo — ComandPOS',
    html: `<div style="font-family:Arial,sans-serif;padding:16px">
      <h2 style="margin:0 0 8px">Servidor de correo configurado correctamente</h2>
      <p>Este es un correo de prueba del sistema de notificaciones de ComandPOS.</p>
      <p style="color:#888;font-size:12px">Servidor: ${config.smtp_host}:${config.smtp_port} — Remitente: ${config.from_email}</p>
    </div>`,
  })
  return { messageId: info?.messageId || null }
}
