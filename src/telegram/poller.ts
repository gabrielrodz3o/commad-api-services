// Long-polling de Telegram (getUpdates). Simple y sin webhook público — ideal para
// arrancar. En prod con dominio se puede migrar a webhook. Drena el backlog al
// iniciar para no re-procesar mensajes viejos tras un reinicio.
import { telegramEnabled, getMe, getUpdates } from './api.js'
import { handleUpdate } from './handler.js'

let running = false

export async function startTelegramPoller(): Promise<void> {
  if (!telegramEnabled() || running) return
  try {
    const me: any = await getMe()
    console.log(`🤖 Telegram: bot @${me.username} conectado (long-polling)`)
  } catch (e: any) {
    console.error('⚠️ Telegram: getMe falló, canal deshabilitado:', e?.message)
    return
  }
  running = true
  let offset = 0

  // Drenar backlog: avanzar el offset sin procesar updates previos al arranque.
  try {
    const backlog = await getUpdates(0)
    if (backlog.length) offset = backlog[backlog.length - 1].update_id + 1
  } catch { /* ignora */ }

  void (async () => {
    while (running) {
      try {
        const updates = await getUpdates(offset)
        for (const u of updates) {
          offset = u.update_id + 1
          await handleUpdate(u)
        }
      } catch (e: any) {
        console.error('⚠️ Telegram poll:', e?.message)
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  })()
}

export function stopTelegramPoller(): void {
  running = false
}
