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
  countCompanyEmailsSentToday, capWarningSentToday,
  getPendingGroups, deferOutbox, markOutboxMany,
  type OutboxRow, type SubscriptionRow, type Recipient, type SmtpConfig,
} from '../db/notifications.js'
import { sendEmail } from '../email/smtp.js'
import { renderEventEmail, renderDigestEmail, layout } from '../email/templates.js'
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
// HIGIENE ANTI-SPAM
// ─────────────────────────────────────────────────────────────────────────────

/** Hora y fecha local RD, para quiet hours y comparaciones de ventana. */
async function getLocalNow(): Promise<{ time: string; ms: number }> {
  const r = await query<{ t: string; ms: string }>(
    `SELECT to_char(now() AT TIME ZONE '${TZ}', 'HH24:MI:SS') AS t,
            (extract(epoch from now()) * 1000)::bigint AS ms`,
  )
  return { time: r[0]?.t || '00:00:00', ms: Number(r[0]?.ms) || Date.now() }
}

/** ¿La hora local cae dentro del horario silencioso? Soporta ventana nocturna. */
function inQuietWindow(start: string | null, end: string | null, nowT: string): boolean {
  if (!start || !end) return false
  const s = start.slice(0, 8), e = end.slice(0, 8)
  if (s === e) return false
  return s < e ? (nowT >= s && nowT < e) : (nowT >= s || nowT < e)
}

/** Aviso único por día cuando una compañía alcanza su tope de correos. */
async function maybeSendCapWarning(smtp: SmtpConfig, recipients: Recipient[], subscriptionId: string): Promise<void> {
  try {
    if (await capWarningSentToday(smtp.company_id)) return
    if (!recipients.length) return
    const subject = `⚠️ Límite diario de correos alcanzado (${smtp.daily_send_limit})`
    const html = layout({
      kind: 'alert',
      title: 'Límite diario de correos alcanzado',
      bodyHtml: `<div style="font-size:14px">Se alcanzó el tope de <strong>${smtp.daily_send_limit}</strong> correos de notificación para hoy.
        Las notificaciones NO críticas restantes se suprimieron para proteger la reputación del remitente.
        Las alertas críticas (NCF, seguridad) siguen enviándose. El conteo se reinicia mañana.</div>`,
    })
    const { to, cc, bcc } = splitRecipients(recipients)
    const result = await sendEmail(smtp, { to: to.length ? to : [...cc, ...bcc], cc, bcc, subject, html })
    await logDelivery({ subscription_id: subscriptionId, channel: 'email', recipient: (to[0] || cc[0] || bcc[0] || 'n/d'), subject, status: 'sent', smtp_message_id: result.messageId })
  } catch (e: any) {
    console.warn('⚠️ no se pudo enviar aviso de tope diario:', e?.message)
  }
}

/**
 * Envía un correo aplicando el circuit breaker (tope diario por compañía).
 * Los eventos críticos ignoran el tope. Devuelve 'sent' o 'capped'.
 * Lanza si el SMTP falla (el llamador decide retry).
 */
async function deliverEmail(opts: {
  smtp: SmtpConfig
  recipients: Recipient[]
  subject: string
  html: string
  isCritical: boolean
  subscriptionId: string
  outboxId?: string | null
}): Promise<'sent' | 'capped'> {
  if (!opts.isCritical) {
    const sentToday = await countCompanyEmailsSentToday(opts.smtp.company_id)
    if (sentToday >= opts.smtp.daily_send_limit) {
      await maybeSendCapWarning(opts.smtp, opts.recipients, opts.subscriptionId)
      return 'capped'
    }
  }
  const { to, cc, bcc } = splitRecipients(opts.recipients)
  const result = await sendEmail(opts.smtp, { to: to.length ? to : [...cc, ...bcc], cc, bcc, subject: opts.subject, html: opts.html })
  for (const r of opts.recipients) {
    await logDelivery({
      outbox_id: opts.outboxId || null, subscription_id: opts.subscriptionId, channel: 'email',
      recipient: r.email, subject: opts.subject, status: 'sent', smtp_message_id: result.messageId,
    })
  }
  return 'sent'
}

const MAX_DIGEST_BATCH = 50

/**
 * Pre-pass del outbox: aplica quiet hours y digest ANTES del claim normal.
 *   - Grupos en horario silencioso (no críticos) → diferidos al fin de la ventana.
 *   - Grupos con digest: si el más viejo aún no cumple la ventana → diferidos;
 *     si maduró (o llegó a MAX_DIGEST_BATCH) → UN solo correo resumen.
 * Los grupos inmediatos (sin digest ni quiet) se dejan intactos para processOutbox.
 */
async function prepareOutboxGroups(): Promise<{ digestSent: number; quietDeferred: number; digestDeferred: number; capped: number }> {
  const out = { digestSent: 0, quietDeferred: 0, digestDeferred: 0, capped: 0 }
  const groups = await getPendingGroups()
  if (!groups.length) return out
  const now = await getLocalNow()

  for (const g of groups) {
    const sub = await resolveSubscription(g)
    if (!sub || !sub.is_enabled || !sub.channel_email) continue // processOutbox lo marcará skipped

    // Quiet hours (no críticos): diferir todo el grupo al fin de la ventana
    if (!sub.is_critical && inQuietWindow(sub.quiet_start, sub.quiet_end, now.time)) {
      const expr = `((CASE WHEN (now() AT TIME ZONE '${TZ}')::time < $1::time
                          THEN (now() AT TIME ZONE '${TZ}')::date
                          ELSE (now() AT TIME ZONE '${TZ}')::date + 1 END + $1::time) AT TIME ZONE '${TZ}')`
      await deferOutbox(g.ids, expr, [sub.quiet_end])
      out.quietDeferred += g.n
      continue
    }

    // Digest
    const digestMin = Number(sub.digest_minutes) || 0
    if (digestMin > 0) {
      const ageMin = (now.ms - new Date(g.oldest).getTime()) / 60000
      if (ageMin < digestMin && g.n < MAX_DIGEST_BATCH) {
        // Aún no madura: diferir hasta oldest + ventana
        await deferOutbox(g.ids, `$1::timestamptz + make_interval(mins => $2::int)`, [g.oldest, digestMin])
        out.digestDeferred += g.n
        continue
      }
      // Madura → un solo correo resumen
      try {
        const recipients = await getRecipients(sub.id)
        if (!recipients.length) { await markOutboxMany(g.ids, 'skipped', 'Sin destinatarios'); continue }
        const smtp = await getSmtpConfigForBusinessUnit(g.business_unit_id)
        if (!smtp) { await markOutboxMany(g.ids, 'skipped', 'Compañía sin SMTP'); continue }
        const names = await getLocationNames(g.business_unit_id, g.location_id)
        const place = names.location ? `${names.business} — ${names.location}` : names.business
        const items = (g.payloads || []).map((pl: any) => ({ title: pl?._title || sub.event_name || 'Notificación', at: null, body: pl?._body || null }))
        const { subject, html } = renderDigestEmail({ eventName: sub.event_name || 'Notificaciones', place, items })
        const res = await deliverEmail({ smtp, recipients, subject, html, isCritical: !!sub.is_critical, subscriptionId: sub.id })
        if (res === 'sent') { await markOutboxMany(g.ids, 'sent'); out.digestSent += g.n }
        else { await markOutboxMany(g.ids, 'skipped', 'Tope diario alcanzado'); out.capped += g.n }
      } catch (e: any) {
        // Fallo SMTP: reintentar el grupo en 5 min (sin perder eventos)
        await deferOutbox(g.ids, `now() + interval '5 minutes'`, [])
        console.warn('⚠️ digest falló, reprogramado:', e?.message)
      }
    }
  }
  return out
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

      // Órdenes vencidas SOLO DEL DÍA DE HOY (fecha local RD) — las cuentas de
      // días previos son zombis no accionables (el barrido de 24h disparó ~120
      // correos el 2026-07-28). Estados (restaurant.account_service_status):
      //   ORDER_DELAYED    → 1-4 (Nueva/Aceptada/Preparando/Lista): retraso del local.
      //   DELIVERY_DELAYED → 1-6, SOLO flota propia (external_plattform_id IS NULL).
      //     En Uber Eats/PedidosYa el reparto lo hace la plataforma: el
      //     restaurante solo controla hasta "Orden Lista", así que esas órdenes
      //     NO cuentan como delivery retrasado (el repartidor de la plataforma
      //     las busca). Se excluyen del watcher.
      //   7 Completada y 8-12 Canceladas/Problemas: jamás alertan.
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
            ${w.isDelivery ? 'AND a.external_plattform_id IS NULL' : 'AND a.status_tracker_id IS NOT NULL'}
            AND COALESCE(a.status_tracker_id, 1) BETWEEN 1 AND ${w.isDelivery ? 6 : 4}
            AND a.state_id IN (1, 2)
            AND (a.created_at AT TIME ZONE '${TZ}')::date = (now() AT TIME ZONE '${TZ}')::date
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
// 1b. WATCHERS DE NEGOCIO (ola 2) — NCF, cortesías, mermas, mora, PIN
//     Cada suscripción activa se evalúa por tick; el dedupe_key garantiza
//     UNA alerta por día/ventana/factura aunque el tick corra cada 2 min.
// ─────────────────────────────────────────────────────────────────────────────
const BUSINESS_WATCHER_CODES = ['NCF_RUNNING_OUT', 'COURTESY_HIGH', 'WASTE_HIGH', 'CUSTOMER_DELINQUENT', 'PIN_FAILED_ATTEMPTS'] as const

async function enqueueOutbox(sub: SubscriptionRow, locationId: number | null, payload: any, dedupeKey: string): Promise<boolean> {
  const res = await query<any>(
    `INSERT INTO notifications.outbox (event_type_id, business_unit_id, location_id, payload, dedupe_key)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status <> 'failed'
     DO NOTHING
     RETURNING id`,
    [sub.event_type_id, sub.business_unit_id, locationId, JSON.stringify(payload), dedupeKey],
  )
  return res.length > 0
}

async function runBusinessWatchers(): Promise<{ scanned: number; enqueued: number }> {
  let scanned = 0
  let enqueued = 0

  const subs = await query<SubscriptionRow & { event_code: string; default_threshold_value: number | null }>(
    `SELECT s.*, et.code AS event_code, et.default_threshold_value
       FROM notifications.subscriptions s
       JOIN notifications.event_types et ON et.id = s.event_type_id
      WHERE et.code = ANY($1) AND s.is_enabled AND s.channel_email`,
    [BUSINESS_WATCHER_CODES as unknown as string[]],
  )

  for (const sub of subs) {
    scanned++
    const threshold = sub.threshold_value != null
      ? Number(sub.threshold_value)
      : Number((sub as any).default_threshold_value) || 0
    // Ámbito: sucursal específica, o todas las del BU si la suscripción es general
    const locScope = sub.location_id != null
    try {
      switch (sub.event_code) {
        // ── NCF por agotarse: por tipo de comprobante, solo tipos con consumo
        //    reciente (45d) para no alertar series muertas. 1 alerta/día/tipo.
        case 'NCF_RUNNING_OUT': {
          const rows = await query<any>(
            `SELECT ivt.id AS type_id,
                    COALESCE(NULLIF(ivt.name, ''), ivt.code, 'Tipo ' || ivt.id) AS type_name,
                    COUNT(*) FILTER (WHERE s.invoice_id IS NULL AND s.is_active)::int AS remaining,
                    MIN(s.expiration_date) FILTER (WHERE s.invoice_id IS NULL AND s.is_active) AS next_expiration,
                    (now() AT TIME ZONE '${TZ}')::date AS local_date
               FROM finances.invoice_voucher_sequentials s
               JOIN finances.invoice_voucher_types ivt ON ivt.id = s.invoice_voucher_type_id
               LEFT JOIN finances.invoices i ON i.id = s.invoice_id
              WHERE s.business_unit_id = $1
              GROUP BY ivt.id, ivt.name, ivt.code
             HAVING COUNT(*) FILTER (WHERE s.invoice_id IS NULL AND s.is_active) < $2
                AND MAX(i.created_date) >= now() - interval '45 days'`,
            [sub.business_unit_id, threshold],
          )
          for (const r of rows) {
            const ok = await enqueueOutbox(sub, sub.location_id, {
              voucher_type: r.type_name,
              remaining: r.remaining,
              threshold,
              next_expiration: r.next_expiration,
              _title: r.remaining <= 0
                ? `🚨 NCF AGOTADOS: ${r.type_name}`
                : `NCF por agotarse: ${r.type_name} (quedan ${r.remaining})`,
            }, `NCF_RUNNING_OUT:bu${sub.business_unit_id}:type${r.type_id}:loc${sub.location_id ?? 'all'}:${r.local_date}`)
            if (ok) enqueued++
          }
          break
        }

        // ── Cortesías del día ≥ umbral (RD$). 1 alerta/día/ámbito.
        case 'COURTESY_HIGH': {
          const rows = await query<any>(
            `SELECT COUNT(*)::int AS courtesies,
                    COALESCE(SUM(c.total_sale_price * COALESCE(c.currency_rate, 1)), 0) AS total,
                    (now() AT TIME ZONE '${TZ}')::date AS local_date
               FROM restaurant.courtesies c
               JOIN human_resource.locations l ON l.id = c.location_id
              WHERE c.cancelled_at IS NULL
                AND c.effective_date::date = (now() AT TIME ZONE '${TZ}')::date
                AND ${locScope ? 'c.location_id = $1' : 'l.business_unit_id = $1'}
             HAVING COALESCE(SUM(c.total_sale_price * COALESCE(c.currency_rate, 1)), 0) >= $2`,
            [locScope ? sub.location_id : sub.business_unit_id, threshold],
          )
          if (rows.length) {
            const top = await query<any>(
              `SELECT c.total_sale_price AS amount, c.authorized_by_fullname, c.reason, c.waiter_fullname
                 FROM restaurant.courtesies c
                 JOIN human_resource.locations l ON l.id = c.location_id
                WHERE c.cancelled_at IS NULL
                  AND c.effective_date::date = (now() AT TIME ZONE '${TZ}')::date
                  AND ${locScope ? 'c.location_id = $1' : 'l.business_unit_id = $1'}
                ORDER BY c.total_sale_price DESC LIMIT 5`,
              [locScope ? sub.location_id : sub.business_unit_id],
            )
            const ok = await enqueueOutbox(sub, sub.location_id, {
              amount: Number(rows[0].total),
              courtesies: rows[0].courtesies,
              threshold,
              top,
              _title: `Cortesías del día: ${rows[0].courtesies} por RD$${Number(rows[0].total).toFixed(2)}`,
            }, `COURTESY_HIGH:loc${sub.location_id ?? 'bu' + sub.business_unit_id}:${rows[0].local_date}`)
            if (ok) enqueued++
          }
          break
        }

        // ── Merma del día ≥ umbral (costo RD$). 1 alerta/día/ámbito.
        case 'WASTE_HIGH': {
          const rows = await query<any>(
            `SELECT COUNT(*)::int AS wastes,
                    COALESCE(SUM(w.total_cost), 0) AS total,
                    (now() AT TIME ZONE '${TZ}')::date AS local_date
               FROM inventory.waste_headers w
              WHERE w.cancelled_at IS NULL AND w.status_id <> 4
                AND w.waste_date::date = (now() AT TIME ZONE '${TZ}')::date
                AND ${locScope ? 'w.location_id = $1' : 'w.business_unit_id = $1'}
             HAVING COALESCE(SUM(w.total_cost), 0) >= $2`,
            [locScope ? sub.location_id : sub.business_unit_id, threshold],
          )
          if (rows.length) {
            const ok = await enqueueOutbox(sub, sub.location_id, {
              amount: Number(rows[0].total),
              wastes: rows[0].wastes,
              threshold,
              _title: `Merma alta del día: RD$${Number(rows[0].total).toFixed(2)} en ${rows[0].wastes} registro(s)`,
            }, `WASTE_HIGH:loc${sub.location_id ?? 'bu' + sub.business_unit_id}:${rows[0].local_date}`)
            if (ok) enqueued++
          }
          break
        }

        // ── Cliente pasó a MOROSA: facturas a crédito que cruzan los 30 días
        //    vencidas (ventana 31-33d por si el tick no corrió un día).
        //    1 alerta por factura (dedupe permanente). Umbral = saldo mínimo.
        case 'CUSTOMER_DELINQUENT': {
          const rows = await query<any>(
            `SELECT i.id, i.invoice_number, i.expire_at, i.emission_date,
                    e.name AS client_name, e.document_id AS client_document,
                    (i.total_amount * i.currency_rate) - COALESCE((
                      SELECT SUM(ipd.payment_amount * ip.currency_rate)
                        FROM finances.invoice_payment_details ipd
                        JOIN finances.invoice_payments ip ON ip.id = ipd.invoice_payment_id
                       WHERE ipd.invoice_id = i.id AND ip.status_id <> 4
                    ), 0) AS pending
               FROM finances.invoices i
               JOIN finances.entities e ON e.id = i.entity_id
              WHERE ${locScope ? 'i.location_id = $1' : 'i.business_unit_id = $1'}
                AND i.status_id = 1 AND i.invoice_category_id = 2 AND i.invoice_type_id <> 1
                AND (CURRENT_DATE - i.expire_at) BETWEEN 31 AND 33
                AND (i.total_amount * i.currency_rate) - COALESCE((
                      SELECT SUM(ipd.payment_amount * ip.currency_rate)
                        FROM finances.invoice_payment_details ipd
                        JOIN finances.invoice_payments ip ON ip.id = ipd.invoice_payment_id
                       WHERE ipd.invoice_id = i.id AND ip.status_id <> 4
                    ), 0) >= GREATEST($2::numeric, 0.01)
              LIMIT 20`,
            [locScope ? sub.location_id : sub.business_unit_id, threshold],
          )
          for (const r of rows) {
            const ok = await enqueueOutbox(sub, sub.location_id, {
              invoice_id: r.id,
              invoice_number: r.invoice_number,
              client_name: r.client_name,
              client_document: r.client_document,
              pending: Number(r.pending),
              expire_at: r.expire_at,
              emitted_at: r.emission_date,
              days_overdue: 31,
              _title: `Cliente en MORA: ${r.client_name} (RD$${Number(r.pending).toFixed(2)})`,
            }, `CUSTOMER_DELINQUENT:invoice:${r.id}`)
            if (ok) enqueued++
          }
          break
        }

        // ── PIN fallidos: ≥ N intentos en 15 min. 1 alerta por ventana de 15 min.
        case 'PIN_FAILED_ATTEMPTS': {
          const rows = await query<any>(
            `SELECT COUNT(*)::int AS attempts,
                    COUNT(*) FILTER (WHERE p.reason = 'pin_incorrecto')::int AS wrong_pin,
                    COUNT(*) FILTER (WHERE p.reason = 'sin_perfil')::int AS no_profile,
                    COUNT(*) FILTER (WHERE p.reason = 'sin_acceso_sucursal')::int AS no_access,
                    FLOOR(EXTRACT(EPOCH FROM now()) / 900)::bigint AS bucket
               FROM notifications.pin_failure_log p
               ${locScope ? '' : 'JOIN human_resource.locations l ON l.id = p.location_id'}
              WHERE p.created_at >= now() - interval '15 minutes'
                AND ${locScope ? 'p.location_id = $1' : 'l.business_unit_id = $1'}
             HAVING COUNT(*) >= $2`,
            [locScope ? sub.location_id : sub.business_unit_id, Math.max(1, threshold)],
          )
          if (rows.length) {
            const r = rows[0]
            const ok = await enqueueOutbox(sub, sub.location_id, {
              attempts: r.attempts,
              wrong_pin: r.wrong_pin,
              no_profile: r.no_profile,
              no_access: r.no_access,
              window_minutes: 15,
              threshold: Math.max(1, threshold),
              _title: `🔒 ${r.attempts} intentos fallidos de PIN de supervisor en 15 min`,
            }, `PIN_FAILED_ATTEMPTS:loc${sub.location_id ?? 'bu' + sub.business_unit_id}:w${r.bucket}`)
            if (ok) enqueued++
          }
          break
        }
      }
    } catch (e: any) {
      console.error(`⚠️ watcher ${sub.event_code} falló (sub ${sub.id}):`, e?.message)
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

  // Guardia de backlog: no notificar eventos anteriores a la activación de la suscripción.
  if (sub.activated_at && new Date(row.created_at) < new Date(sub.activated_at)) {
    await markOutbox(row.id, 'skipped', 'Evento anterior a la activación de la suscripción')
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
    await markOutbox(row.id, 'skipped', 'La suscripción no tiene destinatarios (o todos suprimidos)')
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

  try {
    const res = await deliverEmail({
      smtp, recipients, subject, html,
      isCritical: !!sub.is_critical, subscriptionId: sub.id, outboxId: row.id,
    })
    if (res === 'capped') {
      await markOutbox(row.id, 'skipped', 'Tope diario de correos alcanzado')
      return 'skipped'
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

      // Los reportes programados también respetan el tope diario (salvo críticos).
      const res = await deliverEmail({
        smtp, recipients, subject: email.subject, html: email.html,
        isCritical: !!sub.is_critical, subscriptionId: sub.id,
      })
      if (res === 'capped') out.empty++
      else out.sent++
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
  const business = await runBusinessWatchers().catch((e) => { console.error('⚠️ business watchers:', e?.message); return { scanned: 0, enqueued: 0 } })
  // Pre-pass anti-spam (quiet hours + digest) ANTES del envío individual.
  const prepared = await prepareOutboxGroups().catch((e) => { console.error('⚠️ prepare (digest/quiet):', e?.message); return { digestSent: 0, quietDeferred: 0, digestDeferred: 0, capped: 0 } })
  const outbox = await processOutbox().catch((e) => { console.error('⚠️ outbox:', e?.message); return { processed: 0, sent: 0, skipped: 0, retried: 0, failed: 0 } })
  const scheduled = await runScheduled().catch((e) => { console.error('⚠️ scheduled:', e?.message); return { due: 0, sent: 0, empty: 0, failed: 0 } })
  return { disabled: false, watchers, business, prepared, outbox, scheduled }
}
