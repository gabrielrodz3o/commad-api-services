// CRUD de vínculos Telegram (schema comandi). El vínculo chat_id↔user_id es lo
// único que define "quién puede preguntar"; el RBAC se resuelve fresco en cada
// mensaje a partir del user_id.
import { randomInt } from 'node:crypto'
import { query } from './pool.js'

export interface TgLink { user_id: number }

/** Genera un código de un solo uso (6 dígitos, 10 min) atado al usuario. */
export async function createLinkCode(userId: number): Promise<string> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  await query(
    `INSERT INTO comandi.telegram_link_codes (code, user_id) VALUES ($1, $2)`,
    [code, userId],
  )
  return code
}

/** Consume un código válido y no expirado; devuelve el user_id o null. */
export async function consumeLinkCode(code: string): Promise<number | null> {
  const rows = await query<{ user_id: number }>(
    `UPDATE comandi.telegram_link_codes
       SET used_at = now()
     WHERE code = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [code.trim()],
  )
  return rows[0]?.user_id ?? null
}

/** Ata (o reasigna) un chat de Telegram a un usuario de COMAND. */
export async function linkChat(chatId: number, userId: number, tgUserId?: number, tgUsername?: string): Promise<void> {
  await query(
    `INSERT INTO comandi.telegram_links (chat_id, tg_user_id, tg_username, user_id, last_seen_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (chat_id) DO UPDATE
       SET user_id = EXCLUDED.user_id, tg_user_id = EXCLUDED.tg_user_id,
           tg_username = EXCLUDED.tg_username, last_seen_at = now()`,
    [chatId, tgUserId ?? null, tgUsername ?? null, userId],
  )
}

export async function getLinkByChat(chatId: number): Promise<TgLink | null> {
  const rows = await query<TgLink>('SELECT user_id FROM comandi.telegram_links WHERE chat_id = $1', [chatId])
  return rows[0] ?? null
}

export async function touchLink(chatId: number): Promise<void> {
  await query('UPDATE comandi.telegram_links SET last_seen_at = now() WHERE chat_id = $1', [chatId]).catch(() => {})
}

export async function unlinkChat(chatId: number): Promise<void> {
  await query('DELETE FROM comandi.telegram_links WHERE chat_id = $1', [chatId])
}

/** Chats vinculados a un usuario (para estado en la app y para el briefing). */
export async function getChatsByUser(userId: number): Promise<number[]> {
  const rows = await query<{ chat_id: number }>('SELECT chat_id FROM comandi.telegram_links WHERE user_id = $1', [userId])
  return rows.map((r) => Number(r.chat_id))
}

// ── Briefing proactivo ───────────────────────────────────────────────────────
export async function setBriefing(userId: number, enabled: boolean, hourLocal = 8): Promise<void> {
  const chats = await getChatsByUser(userId)
  for (const chatId of chats) {
    await query(
      `INSERT INTO comandi.telegram_briefings (chat_id, user_id, enabled, hour_local)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (chat_id) DO UPDATE SET enabled = EXCLUDED.enabled, hour_local = EXCLUDED.hour_local`,
      [chatId, userId, enabled, hourLocal],
    )
  }
}

export interface DueBriefing { chat_id: number; user_id: number }
/** Suscripciones activas cuya hora coincide y que no se enviaron hoy (hora local del server). */
export async function getDueBriefings(hourLocal: number): Promise<DueBriefing[]> {
  return query<DueBriefing>(
    `SELECT chat_id, user_id FROM comandi.telegram_briefings
      WHERE enabled = true AND hour_local = $1
        AND (last_sent_at IS NULL OR last_sent_at::date < now()::date)`,
    [hourLocal],
  )
}
export async function markBriefingSent(chatId: number): Promise<void> {
  await query('UPDATE comandi.telegram_briefings SET last_sent_at = now() WHERE chat_id = $1', [chatId])
}
