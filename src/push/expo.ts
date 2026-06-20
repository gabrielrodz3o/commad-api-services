// Envío de notificaciones push vía Expo Push API (sin auth: el token ES la llave).
// https://docs.expo.dev/push-notifications/sending-notifications/
const EXPO_URL = 'https://exp.host/--/api/v2/push/send'

export async function sendExpoPush(
  tokens: string[],
  title: string,
  body: string,
  data: Record<string, any> = {},
): Promise<void> {
  const valid = tokens.filter((t) => t && t.startsWith('ExponentPushToken'))
  if (!valid.length) return
  const messages = valid.map((to) => ({ to, title, body, data, sound: 'default', priority: 'high' }))
  try {
    await fetch(EXPO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(messages),
    })
  } catch (e: any) {
    console.error('⚠️ Expo push falló:', e?.message)
  }
}
