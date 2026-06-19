// Briefing proactivo: genera un resumen ejecutivo por usuario y lo envía a su
// Telegram. Lo dispara un cron externo (n8n) llamando POST /comandi/telegram/run-briefings.
import { getDueBriefings, markBriefingSent } from '../db/telegram.js'
import { answerForUser } from './run.js'
import { sendMessage } from './api.js'

const BRIEFING_PROMPT =
  'Dame un briefing ejecutivo MUY conciso del negocio HOY/esta semana: ventas y utilidad, food cost, caja y compras, y lo más urgente para revisar. Prioriza por impacto. Máximo 8 líneas.'

function clean(text: string): string {
  return (text || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s*/gm, '').replace(/^\s*[-*]\s+/gm, '• ').trim()
}

/** Envía el briefing a todas las suscripciones que toquen a esta hora local. */
export async function runDueBriefings(hourLocal: number): Promise<{ sent: number }> {
  const due = await getDueBriefings(hourLocal)
  let sent = 0
  for (const sub of due) {
    try {
      const res = await answerForUser(sub.user_id, BRIEFING_PROMPT, 'briefing')
      if (res.enabled) {
        await sendMessage(sub.chat_id, `☀️ *Briefing Comandi*\n\n${clean(res.answer)}`)
        await markBriefingSent(sub.chat_id)
        sent++
      }
    } catch (e: any) {
      console.error('⚠️ Briefing falló para chat', sub.chat_id, e?.message)
    }
  }
  return { sent }
}
