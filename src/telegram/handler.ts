// Procesa un update de Telegram: vinculación (/start <código>), preguntas (→ agente)
// y confirmación de acciones (botones inline). Solo chats PRIVADOS (1-a-1).
import { sendMessage, sendChatAction, answerCallbackQuery, editMessageText, inlineKeyboard } from './api.js'
import { consumeLinkCode, linkChat, getLinkByChat, touchLink, unlinkChat } from '../db/telegram.js'
import { answerForUser } from './run.js'
import { executeActionByToken, rejectActionByToken } from '../actions/execute.js'

const WELCOME =
  '👋 Soy *Comandi*, el copiloto de tu negocio.\n\nPara empezar, vincula tu cuenta: entra a COMAND → Comandi → "Vincular Telegram", genera tu código de 6 dígitos y envíamelo aquí (o /start <código>).'

// El texto del LLM trae markdown; sin parse_mode lo limpiamos para que se vea bien.
function clean(text: string): string {
  return (text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .trim()
}

export async function handleUpdate(u: any): Promise<void> {
  try {
    if (u.message) await handleMessage(u.message)
    else if (u.callback_query) await handleCallback(u.callback_query)
  } catch (e: any) {
    console.error('⚠️ Telegram handleUpdate:', e?.message)
  }
}

async function handleMessage(msg: any): Promise<void> {
  if (msg?.chat?.type !== 'private') return // solo DMs
  const chatId = msg.chat.id
  const text = String(msg.text || '').trim()
  if (!text) return

  if (text.startsWith('/start')) {
    const arg = text.split(/\s+/)[1]
    if (arg) return void tryLink(chatId, arg, msg.from)
    return void sendMessage(chatId, WELCOME)
  }
  if (text === '/desvincular' || text === '/stop') {
    await unlinkChat(chatId)
    return void sendMessage(chatId, '🔕 Desvinculé este chat. No recibirás más datos hasta volver a vincular.')
  }
  if (/^\d{6}$/.test(text)) return void tryLink(chatId, text, msg.from)

  const link = await getLinkByChat(chatId)
  if (!link) return void sendMessage(chatId, WELCOME)
  await touchLink(chatId)
  await sendChatAction(chatId, 'typing')
  try {
    const res = await answerForUser(link.user_id, text)
    if (res.pending) {
      await sendMessage(
        chatId,
        `${clean(res.answer)}\n\n⚠️ ${res.pending.summary}\n¿Confirmas?`,
        inlineKeyboard([[
          { text: '✅ Confirmar', callback_data: `x:${res.pending.token}` },
          { text: '✖️ Cancelar', callback_data: `r:${res.pending.token}` },
        ]]),
      )
    } else {
      await sendMessage(chatId, clean(res.answer) || '—')
    }
  } catch (e: any) {
    await sendMessage(chatId, `⚠️ ${e?.message || 'No pude responder'}`)
  }
}

async function tryLink(chatId: number, code: string, from: any): Promise<void> {
  const userId = await consumeLinkCode(code)
  if (!userId) {
    return void sendMessage(chatId, '❌ Código inválido o expirado. Genera uno nuevo en COMAND → Comandi → Vincular Telegram.')
  }
  await linkChat(chatId, userId, from?.id, from?.username)
  await sendMessage(chatId, '✅ ¡Vinculado! Pregúntame lo que sea: "¿cuánto vendí hoy?", "¿cómo está mi food cost?", "¿quiénes son mis top suplidores?"')
}

async function handleCallback(cb: any): Promise<void> {
  const chatId = cb?.message?.chat?.id
  const [kind, token] = String(cb?.data || '').split(':')
  if (!chatId || !token) return void answerCallbackQuery(cb.id)

  const link = await getLinkByChat(chatId)
  if (!link) return void answerCallbackQuery(cb.id, 'No estás vinculado')

  if (kind === 'r') {
    await rejectActionByToken(token)
    await answerCallbackQuery(cb.id, 'Cancelado')
    return void editMessageText(chatId, cb.message.message_id, '✖️ Acción cancelada.')
  }
  if (kind === 'x') {
    const out = await executeActionByToken(token, link.user_id)
    const msg =
      out.status === 'ok' ? '✅ Hecho.'
      : out.status === 'already' ? 'Ya estaba hecho.'
      : out.status === 'forbidden' ? 'No puedes confirmar esto.'
      : out.status === 'expired' ? 'La propuesta expiró.'
      : '⚠️ No se pudo ejecutar.'
    await answerCallbackQuery(cb.id, msg)
    return void editMessageText(chatId, cb.message.message_id, msg)
  }
  await answerCallbackQuery(cb.id)
}
