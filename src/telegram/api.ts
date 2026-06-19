// Cliente del Bot API de Telegram. Usa el token de plataforma (env). Sin parse_mode
// por defecto: el texto del LLM puede traer markdown malformado que rompería el envío.
import { env } from '../config/env.js'

export const telegramEnabled = (): boolean => !!env.TELEGRAM_BOT_TOKEN

async function call<T = any>(method: string, body: Record<string, any>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json: any = await res.json().catch(() => ({}))
  if (!json?.ok) throw new Error(`Telegram ${method}: ${json?.description || res.status}`)
  return json.result as T
}

export interface InlineButton { text: string; callback_data: string }
export const inlineKeyboard = (rows: InlineButton[][]) => ({ reply_markup: { inline_keyboard: rows } })

export const getMe = () => call('getMe', {})

let botUsername = ''
export async function getBotUsername(): Promise<string> {
  if (botUsername) return botUsername
  try { botUsername = (await getMe())?.username || '' } catch { /* token inválido/red */ }
  return botUsername
}
export const getUpdates = (offset: number) =>
  call<any[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] })
export const sendMessage = (chatId: number, text: string, extra: Record<string, any> = {}) =>
  call('sendMessage', { chat_id: chatId, text, ...extra })
export const sendChatAction = (chatId: number, action = 'typing') =>
  call('sendChatAction', { chat_id: chatId, action }).catch(() => {})
export const answerCallbackQuery = (id: string, text?: string) =>
  call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => {})
export const editMessageText = (chatId: number, messageId: number, text: string, extra: Record<string, any> = {}) =>
  call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra }).catch(() => {})
