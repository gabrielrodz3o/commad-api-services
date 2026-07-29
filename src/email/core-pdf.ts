// Obtiene PDFs generados por el core (Nuxt) para adjuntarlos a los correos.
// El core expone get-box-closure-pdf y acepta llamadas internas con el header
// x-internal-secret = JWT_SECRET (mismo secreto que comparten core y comandi).
// Best-effort: cualquier fallo devuelve null y el correo se envía SIN adjunto.
import { env } from '../config/env.js'

export interface EmailAttachment { filename: string; content: Buffer; contentType?: string }

async function fetchCorePdf(path: string): Promise<Buffer | null> {
  if (!env.CORE_API_URL || !env.JWT_SECRET) return null
  const url = `${env.CORE_API_URL.replace(/\/+$/, '')}${path}`
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 20_000)
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-internal-secret': env.JWT_SECRET, accept: 'application/pdf' },
      signal: ac.signal,
    }).finally(() => clearTimeout(timer))
    if (!res.ok) { console.warn(`⚠️ core PDF ${path} → HTTP ${res.status}`); return null }
    const ct = res.headers.get('content-type') || ''
    const buf = Buffer.from(await res.arrayBuffer())
    // Guard: si el core devolvió HTML/JSON (error), no adjuntar basura.
    if (!ct.includes('pdf') && buf.slice(0, 5).toString() !== '%PDF-') {
      console.warn(`⚠️ core PDF ${path} no es PDF (ct=${ct})`); return null
    }
    return buf
  } catch (e: any) {
    console.warn(`⚠️ no se pudo obtener PDF del core (${path}):`, e?.message)
    return null
  }
}

/** PDF del cierre de caja. null si no se pudo obtener. */
export async function boxClosurePdf(boxEntryId: number): Promise<EmailAttachment | null> {
  if (!Number.isInteger(boxEntryId) || boxEntryId <= 0) return null
  const buf = await fetchCorePdf(`/api/restaurant/boxes/get-box-closure-pdf?box_entry_id=${boxEntryId}`)
  return buf ? { filename: `cierre-caja-${boxEntryId}.pdf`, content: buf, contentType: 'application/pdf' } : null
}
