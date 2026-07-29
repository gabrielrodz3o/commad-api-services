// Acceso a datos del sistema de notificaciones por correo (schema `notifications`).
// Este servicio es el ÚNICO que escribe en notifications.outbox/deliveries/subscriptions
// (marks de estado). La config la escribe el core (Nuxt); aquí solo se lee.
import { pool, query } from './pool.js'
import { env } from '../config/env.js'

export interface SmtpConfig {
  company_id: number
  smtp_host: string
  smtp_port: number
  smtp_secure: boolean
  smtp_user: string
  smtp_password: string
  from_email: string
  from_name: string | null
  reply_to: string | null
  is_active: boolean
  daily_send_limit: number
  pos_base_url: string | null
}

export interface OutboxRow {
  id: string
  event_type_id: string
  event_code: string
  event_name: string
  has_threshold: boolean
  threshold_type: string | null
  business_unit_id: number
  location_id: number | null
  payload: any
  attempts: number
  created_at: string
}

export interface SubscriptionRow {
  id: string
  business_unit_id: number
  location_id: number | null
  event_type_id: string
  channel_email: boolean
  channel_app: boolean
  frequency: string
  send_time: string | null
  days_of_week: number[] | null
  day_of_month: number | null
  threshold_value: number | null
  is_enabled: boolean
  last_sent_at: string | null
  digest_minutes: number | null
  activated_at: string | null
  quiet_start: string | null
  quiet_end: string | null
  event_code?: string
  event_name?: string
  is_critical?: boolean
}

export interface Recipient { email: string; display_name: string | null; kind: 'to' | 'cc' | 'bcc' }

/** Config SMTP (descifrada) de la compañía. null si no hay o está inactiva. */
export async function getSmtpConfigForCompany(companyId: number): Promise<SmtpConfig | null> {
  if (!env.NOTIF_SMTP_ENC_KEY) return null
  const rows = await query<SmtpConfig>(
    `SELECT company_id, smtp_host, smtp_port, smtp_secure, smtp_user,
            notifications.pgp_sym_decrypt(smtp_password_enc, $2) AS smtp_password,
            from_email, from_name, reply_to, is_active,
            COALESCE(daily_send_limit, 300) AS daily_send_limit,
            pos_base_url
       FROM notifications.company_smtp_config
      WHERE company_id = $1 AND deleted_at IS NULL AND is_active`,
    [companyId, env.NOTIF_SMTP_ENC_KEY],
  )
  return rows[0] || null
}

/** Config SMTP de la compañía dueña de un business_unit. */
export async function getSmtpConfigForBusinessUnit(businessUnitId: number): Promise<SmtpConfig | null> {
  const rows = await query<{ company_id: number }>(
    `SELECT company_id FROM human_resource.business_units WHERE id = $1`,
    [businessUnitId],
  )
  const companyId = rows[0]?.company_id
  return companyId ? getSmtpConfigForCompany(companyId) : null
}

/**
 * Reclama un lote del outbox: marca `processing` con FOR UPDATE SKIP LOCKED
 * (seguro con pgbouncer: transacción explícita corta, sin advisory locks).
 */
export async function claimOutboxBatch(limit = 50): Promise<OutboxRow[]> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const res = await client.query(
      `UPDATE notifications.outbox o
          SET status = 'processing', attempts = o.attempts + 1
        WHERE o.id IN (
          SELECT id FROM notifications.outbox
           WHERE status IN ('pending', 'processing') AND next_attempt_at <= now()
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT $1
        )
        RETURNING o.id, o.event_type_id, o.business_unit_id, o.location_id,
                  o.payload, o.attempts, o.created_at`,
      [limit],
    )
    await client.query('COMMIT')
    if (!res.rows.length) return []
    const types = await query<{ id: string; code: string; name: string; has_threshold: boolean; threshold_type: string | null }>(
      `SELECT id, code, name, has_threshold, threshold_type FROM notifications.event_types`,
    )
    const byId = new Map(types.map((t) => [t.id, t]))
    return res.rows.map((r: any) => {
      const t = byId.get(r.event_type_id)
      return {
        ...r,
        event_code: t?.code || 'UNKNOWN',
        event_name: t?.name || r.event_type_id,
        has_threshold: !!t?.has_threshold,
        threshold_type: t?.threshold_type || null,
      }
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Suscripción aplicable a un evento del outbox (cascada: sucursal gana a general). */
export async function resolveSubscription(row: { business_unit_id: number; location_id: number | null; event_type_id: string }): Promise<SubscriptionRow | null> {
  const rows = await query<SubscriptionRow>(
    `SELECT s.*, et.is_critical, et.code AS event_code, et.name AS event_name
       FROM notifications.subscriptions s
       JOIN notifications.event_types et ON et.id = s.event_type_id
      WHERE s.business_unit_id = $1 AND s.event_type_id = $2
        AND (s.location_id = $3 OR s.location_id IS NULL)
      ORDER BY s.location_id NULLS LAST
      LIMIT 1`,
    [row.business_unit_id, row.event_type_id, row.location_id],
  )
  return rows[0] || null
}

/** Destinatarios activos, excluyendo los de la lista de supresión (rebotes/quejas). */
export async function getRecipients(subscriptionId: string): Promise<Recipient[]> {
  return query<Recipient>(
    `SELECT r.email, r.display_name, r.kind
       FROM notifications.recipients r
      WHERE r.subscription_id = $1 AND r.is_active
        AND NOT EXISTS (
          SELECT 1 FROM notifications.suppressed_emails se
           WHERE lower(se.email) = lower(r.email))
      ORDER BY r.created_at`,
    [subscriptionId],
  )
}

/** Correos enviados HOY (fecha local RD) por la compañía — para el circuit breaker. */
export async function countCompanyEmailsSentToday(companyId: number): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::int AS n
       FROM notifications.deliveries d
       JOIN notifications.subscriptions s ON s.id = d.subscription_id
       JOIN human_resource.business_units bu ON bu.id = s.business_unit_id
      WHERE bu.company_id = $1 AND d.channel = 'email' AND d.status = 'sent'
        AND (d.sent_at AT TIME ZONE 'America/Santo_Domingo')::date
            = (now() AT TIME ZONE 'America/Santo_Domingo')::date`,
    [companyId],
  )
  return Number(rows[0]?.n) || 0
}

/** ¿Ya se avisó hoy a esta compañía que se alcanzó el tope diario? */
export async function capWarningSentToday(companyId: number): Promise<boolean> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::int AS n
       FROM notifications.deliveries d
       JOIN notifications.subscriptions s ON s.id = d.subscription_id
       JOIN human_resource.business_units bu ON bu.id = s.business_unit_id
      WHERE bu.company_id = $1 AND d.subject LIKE '%Límite diario de correos%'
        AND (d.sent_at AT TIME ZONE 'America/Santo_Domingo')::date
            = (now() AT TIME ZONE 'America/Santo_Domingo')::date`,
    [companyId],
  )
  return (Number(rows[0]?.n) || 0) > 0
}

/** Agrega un correo a la lista de supresión y desactiva sus filas de destinatario. */
export async function suppressEmail(email: string, reason: string, detail?: string): Promise<void> {
  const e = email.trim().toLowerCase()
  if (!e) return
  await query(
    `INSERT INTO notifications.suppressed_emails (email, reason, detail)
     VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING`,
    [e, reason.slice(0, 30), detail || null],
  )
  await query(
    `UPDATE notifications.recipients SET is_active = false WHERE lower(email) = $1`,
    [e],
  )
}

/** Grupos de outbox pendiente (para digest y quiet hours), agrupados por ámbito. */
export interface OutboxGroup {
  event_type_id: string
  business_unit_id: number
  location_id: number | null
  ids: string[]
  payloads: any[]
  oldest: string
  n: number
}
export async function getPendingGroups(): Promise<OutboxGroup[]> {
  return query<OutboxGroup>(
    `SELECT event_type_id, business_unit_id, location_id,
            array_agg(id ORDER BY created_at) AS ids,
            json_agg(payload ORDER BY created_at) AS payloads,
            min(created_at) AS oldest,
            count(*)::int AS n
       FROM notifications.outbox
      WHERE status = 'pending' AND next_attempt_at <= now()
      GROUP BY event_type_id, business_unit_id, location_id`,
  )
}

/** Difiere filas del outbox (digest inmaduro / quiet hours). No cuenta como intento. */
export async function deferOutbox(ids: string[], nextAttemptAtSql: string, params: any[]): Promise<void> {
  if (!ids.length) return
  await query(
    `UPDATE notifications.outbox SET next_attempt_at = ${nextAttemptAtSql}
      WHERE id = ANY($${params.length + 1}::uuid[]) AND status = 'pending'`,
    [...params, ids],
  )
}

/** Marca varias filas del outbox con el mismo estado. */
export async function markOutboxMany(ids: string[], status: 'sent' | 'skipped' | 'failed', error?: string): Promise<void> {
  if (!ids.length) return
  await query(
    `UPDATE notifications.outbox SET status = $2, error_message = $3, processed_at = now()
      WHERE id = ANY($1::uuid[])`,
    [ids, status, error || null],
  )
}

export async function markOutbox(id: string, status: 'sent' | 'failed' | 'skipped', error?: string): Promise<void> {
  await query(
    `UPDATE notifications.outbox
        SET status = $2, error_message = $3, processed_at = now()
      WHERE id = $1`,
    [id, status, error || null],
  )
}

/** Reintento con backoff lineal (5 min × intento). A partir del 3º intento → failed. */
export async function scheduleRetryOrFail(id: string, attempts: number, error: string): Promise<void> {
  if (attempts >= 3) {
    await markOutbox(id, 'failed', error)
    return
  }
  await query(
    `UPDATE notifications.outbox
        SET status = 'pending', error_message = $2,
            next_attempt_at = now() + make_interval(mins => 5 * $3::int)
      WHERE id = $1`,
    [id, error, attempts],
  )
}

/**
 * Suscripciones programadas que tocan AHORA (hora local RD):
 *   - send_time ya pasó hoy
 *   - día correcto (days_of_week / day_of_month)
 *   - no se envió todavía hoy (guard last_sent_at, idempotente ante re-ticks)
 */
export async function getDueScheduled(): Promise<SubscriptionRow[]> {
  return query<SubscriptionRow>(
    `WITH local_now AS (
       SELECT now() AT TIME ZONE 'America/Santo_Domingo' AS ts
     )
     SELECT s.*, et.code AS event_code, et.name AS event_name, et.is_critical
       FROM notifications.subscriptions s
       JOIN notifications.event_types et ON et.id = s.event_type_id AND et.delivery_mode = 'scheduled'
       CROSS JOIN local_now n
      WHERE s.is_enabled
        AND s.channel_email
        AND s.frequency <> 'realtime'
        AND s.send_time IS NOT NULL
        AND n.ts::time >= s.send_time
        AND (
          s.frequency = 'daily'
          OR (s.frequency = 'weekly' AND (
                s.days_of_week IS NULL OR EXTRACT(dow FROM n.ts)::smallint = ANY(s.days_of_week)))
          OR (s.frequency = 'monthly' AND (
                s.day_of_month IS NULL OR EXTRACT(day FROM n.ts)::smallint = s.day_of_month))
        )
        AND (s.last_sent_at IS NULL
             OR (s.last_sent_at AT TIME ZONE 'America/Santo_Domingo')::date < n.ts::date)`,
  )
}

export async function markSubscriptionSent(id: string): Promise<void> {
  await query(`UPDATE notifications.subscriptions SET last_sent_at = now() WHERE id = $1`, [id])
}

export async function logDelivery(d: {
  outbox_id?: string | null
  subscription_id?: string | null
  channel: 'email' | 'app'
  recipient: string
  subject?: string | null
  status: 'sent' | 'failed'
  smtp_message_id?: string | null
  error_message?: string | null
}): Promise<void> {
  await query(
    `INSERT INTO notifications.deliveries
       (outbox_id, subscription_id, channel, recipient, subject, status, smtp_message_id, error_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [d.outbox_id || null, d.subscription_id || null, d.channel, d.recipient,
     d.subject || null, d.status, d.smtp_message_id || null, d.error_message || null],
  )
}

/** Nombre de sucursal / BU para armar asuntos de correo. */
export async function getLocationNames(businessUnitId: number, locationId: number | null): Promise<{ business: string; location: string | null }> {
  const rows = await query<{ business: string; location: string | null }>(
    `SELECT bu.description_short AS business, l.description_long AS location
       FROM human_resource.business_units bu
       LEFT JOIN human_resource.locations l ON l.id = $2
      WHERE bu.id = $1`,
    [businessUnitId, locationId],
  )
  return rows[0] || { business: `BU ${businessUnitId}`, location: locationId ? `Sucursal ${locationId}` : null }
}
