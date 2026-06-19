// Cliente HTTP al CORE (Nuxt). Solo para flujos AUTÓNOMOS de Comandi (sin pantalla):
// trae el reporte ya calculado del core en vez de recalcular SQL.
//
// Autenticación: header x-internal-secret = JWT_SECRET. El core lo reconoce como
// llamada interna (server/middleware/api-auth.ts) y la deja pasar.
import { env } from '../config/env.js'

export async function fetchFromCore<T = any>(path: string, body: Record<string, any>): Promise<T> {
  const res = await fetch(`${env.CORE_API_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-secret': env.JWT_SECRET,
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Core ${path} → ${res.status} ${txt.slice(0, 200)}`)
  }
  return (await res.json()) as T
}
