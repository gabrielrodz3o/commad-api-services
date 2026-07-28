// Dispatcher del sistema de notificaciones por correo. Lo dispara un cron
// externo (n8n) vía POST /comandi/notifications/run cada 1–5 min (patrón
// briefings de Telegram). Cada tick, en orden:
//   1. WATCHERS   — detecta delivery/pedidos retrasados → inserta en outbox
//                   (dedupe_key único: cada orden alerta UNA sola vez).
//   2. OUTBOX     — procesa eventos pendientes (alertas realtime del core +
//                   watchers): resuelve suscripción/umbral/destinatarios,
//                   renderiza y envía por el SMTP de la compañía.
//   3. SCHEDULED  — reportes programados que tocan a esta hora (guard
//                   last_sent_at con claim atómico: idempotente ante re-ticks).
import { query } from '../db/pool.js'
import { env } from '../config/env.js'
import {
  claimOutboxBatch, resolveSubscription, getRecipients, markOutbox,
  scheduleRetryOrFail, getDueScheduled, getLocationNames,
  getSmtpConfigForBusinessUnit, logDelivery,
  type OutboxRow, type SubscriptionRow, type Recipient,
} from '../db/notifications.js'
import { sendEmail } from '../email/smtp.js'
import { renderEventEmail } from '../email/templates.js'
import { buildDailyCloseReport } from '../email/reports/daily-close.js'
import { buildCostChangesReport } from '../email/reports/cost-changes.js'
import { buildArApReport } from '../email/reports/ar-ap.js'

const TZ = 'America/Santo_Domingo'

// ─────────────────────────────────────────────────────────────────────────────
// Umbrales: valor efectivo = override de la suscripción ?? default del tipo.
// El valor a comparar sale del payload según el tipo de umbral.
// ─────────────────────────────────────────────────────────────────────────────
function thresholdValueFromPayload(thresholdType: string | null, payload: any): number | null {
  if (!thresholdType || !payload) return null
  if (thresholdType === 'amount') {
    const v = payload.amount ?? payload.total_discount ?? payload.total_amount ?? (payload.difference != null ? Math.abs(Number(payload.difference)) : null)
    return v == null ? null : Number(v)
  }
  if (thresholdType === 'percentage') return payload.percent == null ? null : Number(payload.percent)
  if (thresholdType === 'minutes') return payload.minutes == null ? null : Number(payload.minutes)
  return null
}

async function effectiveThreshold(sub: SubscriptionRow, eventTypeId: string): Promise<number | null> {
  if (sub.threshold_value != null) return Number(sub.threshold_value)
  const rows = await query<{ default_threshold_value: number | null }>(
    `SELECT default_threshold_value FROM notifications.event_types WHERE id = $1`, [eventTypeId],
  )
  return rows[0]?.default_threshold_value == null ? null : Number(rows[0].default_threshold_value)
}

function splitRecipients(recipients: Recipient[]): { to: string[]; cc: string[]; bcc: string[] } {
  return {
    to: recipients.filter((r) => r.kind === 'to').map((r) => r.email),
    cc: recipients.filter((r) => r.kind === 'cc').map((r) => r.email),
    bcc: recipients.filter((r) => r.kind === 'bcc').map((r) => r.email),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. WATCHERS — delivery / pedidos retrasados
// ─────────────────────────────────────────────────────────────────────────────
interface WatcherDef { code: 'DELIVERY_DELAYED' | 'ORDER_DELAYED'; isDelivery: boolean }
const WATCHERS: WatcherDef[] = [
  { code: 'DELIVERY_DELAYED', isDelivery: true },
  { code: 'ORDER_DELAYED', isDelivery: false },
]

async function runWatchers(): Promise<{ scanned: number; enqueued: number }> {
  let scanned = 0
  let enqueued = 0
  for (const w of WATCHERS) {
    // Suscripciones activas de este watcher (general o por sucursal)
    const subs = await query<SubscriptionRow & { event_type_id: string; default_threshold_value: number | null }>(
      `SELECT s.*, et.default_threshold_value
         FROM notifications.subscriptions s
         JOIN notifications.event_types et ON et.id = s.event_type_id AND et.code = $1
        WHERE s.is_enabled AND s.channel_email`,
      [w.code],
    )
    for (const sub of subs) {
      scanned++
      const threshold = sub.threshold_value != null
        ? Number(sub.threshold_value)
        : (sub as any).default_threshold_value != null ? Number((sub as any).default_threshold_value) : (w.isDelivery ? 45 : 30)

      // Órdenes activas (tracker 1-6) vencidas, de las últimas 24h.
      // Ámbito: sucursal específica o todas las del BU (respetando overrides:
      // si otra suscripción específica cubre una sucursal, esa manda — el
      // dedupe_key garantiza una sola alerta por orden aunque coincidan).
      const scopeSql = sub.location_id ? 'AND a.location_id = $2' : 'AND l.business_unit_id = $2'
      const scopeParam = sub.location_id ?? sub.business_unit_id
      const overdue = await query<any>(
        `SELECT a.id AS account_id, a.location_id, a.name AS account_name,
                a.status_tracker_id, ass.name AS status_name,
                a.created_at,
                COALESCE(e.name, 'Cliente sin nombre') AS customer_name,
                a.delivery_phone, a.delivery_address,
                d.use_fullname AS driver_name,
                tot.total_amount,
                FLOOR(EXTRACT(EPOCH FROM (now() - a.created_at)) / 60)::int AS minutes
           FROM restaurant.accounts a
           JOIN human_resource.locations l ON l.id = a.location_id
           LEFT JOIN restaurant.account_service_status ass ON ass.id = a.status_tracker_id
           LEFT JOIN finances.entities e ON e.id = a.customer_id
           LEFT JOIN common.users d ON d.use_id = a.assigned_driver_id
           LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(od.quantity * od.order_price - COALESCE(od.discount_amount, 0)), 0) AS total_amount
               FROM restaurant.orders o2
               JOIN restaurant.order_details od ON od.order_id = o2.id
              WHERE o2.account_id = a.id
           ) tot ON TRUE
          WHERE a.is_delivery = ${w.isDelivery ? 'TRUE' : 'FALSE'}
            ${w.isDelivery ? '' : 'AND a.status_tracker_id IS NOT NULL'}
            AND COALESCE(a.status_tracker_id, 1) BETWEEN 1 AND 6
            AND a.state_id IN (1, 2)
            AND a.created_at >= now() - interval '24 hours'
            AND a.created_at <= now() - make_interval(mins => $1::int)
            ${scopeSql.replace('$2', '$2')}`,
        [threshold, scopeParam],
      )
      for (const o of overdue) {
        const res = await query<any>(
          `INSERT INTO notifications.outbox (event_type_id, business_unit_id, location_id, payload, dedupe_key)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status <> 'failed'
           DO NOTHING
           RETURNING id`,
          [
            sub.event_type_id,
            sub.business_unit_id,
            o.location_id,
            JSON.stringify({
              account_id: o.account_id,
              order_code: o.account_name || `#${o.account_id}`,
              customer_name: o.customer_name,
              customer_phone: o.delivery_phone || null,
              address: o.delivery_address || null,
              driver_name: o.driver_name || null,
              total_amount: Number(o.total_amount) || null,
              status_name: o.status_name || null,
              ordered_at: o.created_at,
              minutes: o.minutes,
              threshold,
              status_tracker_id: o.status_tracker_id,
              _title: w.code === 'DELIVERY_DELAYED'
                ? `Delivery retrasado: ${o.minutes} min (${o.customer_name})`
                : `Pedido retrasado: ${o.minutes} min (${o.account_name || o.account_id})`,
            }),
            `${w.code}:account:${o.account_id}`,
          ],
        )
        if (res.length) enqueued++
      }
    }
  }
  return { scanned, enqueued }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. OUTBOX — alertas realtime + watchers
// ─────────────────────────────────────────────────────────────────────────────
async function processOutboxRow(row: OutboxRow): Promise<'sent' | 'skipped' | 'retry' | 'failed'> {
  const sub = await resolveSubscription(row)
  if (!sub || !sub.is_enabled || !sub.channel_email) {
    await markOutbox(row.id, 'skipped', 'Sin suscripción de correo activa para este evento/ámbito')
    return 'skipped'
  }

  // Umbral (si el tipo lo define y el payload trae el valor)
  if (row.has_threshold) {
    const threshold = await effectiveThreshold(sub, row.event_type_id)
    const value = thresholdValueFromPayload(row.threshold_type, row.payload)
    if (threshold != null && value != null && value < threshold) {
      await markOutbox(row.id, 'skipped', `Bajo el umbral (${value} < ${threshold})`)
      return 'skipped'
    }
  }

  const recipients = await getRecipients(sub.id)
  if (!recipients.length) {
    await markOutbox(row.id, 'skipped', 'La suscripción no tiene destinatarios')
    return 'skipped'
  }

  const smtp = await getSmtpConfigForBusinessUnit(row.business_unit_id)
  if (!smtp) {
    await markOutbox(row.id, 'skipped', 'La compañía no tiene servidor SMTP configurado/activo')
    return 'skipped'
  }

  const names = await getLocationNames(row.business_unit_id, row.location_id)
  const { subject, html } = renderEventEmail({
    eventCode: row.event_code,
    eventName: row.event_name,
    business: names.business,
    location: names.location,
    payload: row.payload,
    occurredAt: row.created_at,
  })

  const { to, cc, bcc } = splitRecipients(recipients)
  try {
    const result = await sendEmail(smtp, { to: to.length ? to : [...cc, ...bcc], cc, bcc, subject, html })
    for (const r of recipients) {
      await logDelivery({
        outbox_id: row.id, subscription_id: sub.id, channel: 'email',
        recipient: r.email, subject, status: 'sent', smtp_message_id: result.messageId,
      })
    }
    await markOutbox(row.id, 'sent')
    return 'sent'
  } catch (e: any) {
    const msg = String(e?.message || 'Error SMTP')
    for (const r of recipients) {
      await logDelivery({
        outbox_id: row.id, subscription_id: sub.id, channel: 'email',
        recipient: r.email, subject, status: 'failed', error_message: msg,
      })
    }
    await scheduleRetryOrFail(row.id, row.attempts, msg)
    return row.attempts >= 3 ? 'failed' : 'retry'
  }
}

async function processOutbox(): Promise<{ processed: number; sent: number; skipped: number; retried: number; failed: number }> {
  const batch = await claimOutboxBatch(50)
  const out = { processed: batch.length, sent: 0, skipped: 0, retried: 0, failed: 0 }
  for (const row of batch) {
    try {
      const r = await processOutboxRow(row)
      if (r === 'sent') out.sent++
      else if (r === 'skipped') out.skipped++
      else if (r === 'retry') out.retried++
      else out.failed++
    } catch (e: any) {
      console.error('⚠️ outbox row falló', row.id, e?.message)
      await scheduleRetryOrFail(row.id, row.attempts, String(e?.message || 'error')).catch(() => {})
      out.retried++
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. SCHEDULED — reportes programados
// ─────────────────────────────────────────────────────────────────────────────
async function buildScheduledEmail(sub: SubscriptionRow, names: { business: string; location: string | null }) {
  switch (sub.event_code) {
    case 'DAILY_CLOSE_REPORT':
      return buildDailyCloseReport(sub, names)
    case 'COST_INCREASE_REPORT':
      return buildCostChangesReport(sub, names, 'increases')
    case 'PRICE_COST_CHANGE_REPORT':
      return buildCostChangesReport(sub, names, 'all')
    case 'AR_AP_WEEKLY_REPORT':
      return buildArApReport(sub, names)
    default:
      return null
  }
}

async function runScheduled(): Promise<{ due: number; sent: number; empty: number; failed: number }> {
  const due = await getDueScheduled()
  const out = { due: due.length, sent: 0, empty: 0, failed: 0 }
  for (const sub of due) {
    // Claim atómico: si otro tick concurrente ya lo tomó hoy, saltar.
    const claimed = await query<any>(
      `UPDATE notifications.subscriptions
          SET last_sent_at = now()
        WHERE id = $1
          AND (last_sent_at IS NULL
               OR (last_sent_at AT TIME ZONE '${TZ}')::date < (now() AT TIME ZONE '${TZ}')::date)
        RETURNING id`,
      [sub.id],
    )
    if (!claimed.length) continue

    try {
      const recipients = await getRecipients(sub.id)
      if (!recipients.length) { out.empty++; continue }
      const smtp = await getSmtpConfigForBusinessUnit(sub.business_unit_id)
      if (!smtp) {
        await logDelivery({ subscription_id: sub.id, channel: 'email', recipient: '(sin envío)', status: 'failed', error_message: 'Compañía sin SMTP configurado' })
        out.failed++
        continue
      }
      const names = await getLocationNames(sub.business_unit_id, sub.location_id)
      const email = await buildScheduledEmail(sub, names)
      if (!email) { out.empty++; continue } // sin datos que reportar (ej. sin cambios de costo)

      const { to, cc, bcc } = splitRecipients(recipients)
      const result = await sendEmail(smtp, { to: to.length ? to : [...cc, ...bcc], cc, bcc, subject: email.subject, html: email.html })
      for (const r of recipients) {
        await logDelivery({
          subscription_id: sub.id, channel: 'email', recipient: r.email,
          subject: email.subject, status: 'sent', smtp_message_id: result.messageId,
        })
      }
      out.sent++
    } catch (e: any) {
      console.error('⚠️ reporte programado falló', sub.event_code, sub.id, e?.message)
      await logDelivery({
        subscription_id: sub.id, channel: 'email', recipient: '(sin envío)',
        status: 'failed', error_message: String(e?.message || 'error'),
      }).catch(() => {})
      out.failed++
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Tick completo (idempotente; lo llama el cron)
// ─────────────────────────────────────────────────────────────────────────────
export async function runNotificationsTick() {
  if (!env.NOTIF_SMTP_ENC_KEY) {
    return { disabled: true, reason: 'NOTIF_SMTP_ENC_KEY no configurada' }
  }
  const watchers = await runWatchers().catch((e) => { console.error('⚠️ watchers:', e?.message); return { scanned: 0, enqueued: 0 } })
  const outbox = await processOutbox().catch((e) => { console.error('⚠️ outbox:', e?.message); return { processed: 0, sent: 0, skipped: 0, retried: 0, failed: 0 } })
  const scheduled = await runScheduled().catch((e) => { console.error('⚠️ scheduled:', e?.message); return { due: 0, sent: 0, empty: 0, failed: 0 } })
  return { disabled: false, watchers, outbox, scheduled }
}
