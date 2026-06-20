// Tokens de push (Expo) por usuario, para alertas proactivas a la app móvil.
import { query } from './pool.js'

export async function registerPushToken(userId: number, expoToken: string, platform?: string): Promise<void> {
  await query(
    `INSERT INTO comandi.push_tokens (user_id, expo_token, platform, last_seen_at)
     VALUES ($1,$2,$3, now())
     ON CONFLICT (expo_token) DO UPDATE
       SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, last_seen_at = now()`,
    [userId, expoToken, platform ?? null],
  )
}

export async function getTokensByUser(userId: number): Promise<string[]> {
  const rows = await query<{ expo_token: string }>('SELECT expo_token FROM comandi.push_tokens WHERE user_id = $1', [userId])
  return rows.map((r) => r.expo_token)
}

/** Todos los tokens agrupados por usuario — para el vigilante proactivo. */
export async function getAllPushByUser(): Promise<Map<number, string[]>> {
  const rows = await query<{ user_id: number; expo_token: string }>('SELECT user_id, expo_token FROM comandi.push_tokens')
  const map = new Map<number, string[]>()
  for (const r of rows) {
    const arr = map.get(Number(r.user_id)) || []
    arr.push(r.expo_token)
    map.set(Number(r.user_id), arr)
  }
  return map
}
