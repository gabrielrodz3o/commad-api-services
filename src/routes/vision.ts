// Visión de productos (catálogo POS):
//   POST /comandi/vision/product-note   → redacta la nota/ficha del producto a partir de su foto
//   POST /comandi/vision/enhance-image  → devuelve la foto lista para catálogo (fondo blanco de estudio + color corregido)
//
// Ambos aceptan multipart (file 'image' + field 'payload' JSON) o solo payload
// con image_url (producto existente cuya foto ya vive en Spaces/PocketBase).
// La nota usa el motor BYO-key de la empresa (OpenAI o Claude). La MEJORA de
// imagen es solo OpenAI (gpt-image-1): si la empresa usa Claude se cae a la
// llave OpenAI global, igual que la transcripción de voz.
import type { FastifyInstance } from 'fastify'
import OpenAI, { toFile } from 'openai'
import { z } from 'zod'
import { locationFields, resolveTenant } from '../lib/resolve.js'
import { TenantError } from '../db/tenant.js'
import { env } from '../config/env.js'
import { generateText, LLMError } from '../llm/provider.js'
import { addUsage, type AIUsage } from '../llm/usage.js'
import { logUsage } from '../db/usage-log.js'

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_IMAGE_BYTES = 15 * 1024 * 1024

const NotePayload = z.object({
  ...locationFields,
  image_url: z.string().url().optional(),
  product_name: z.string().max(200).optional(),
  category: z.string().max(200).optional(),
  current_note: z.string().max(2000).optional(),
})

const EnhancePayload = z.object({
  ...locationFields,
  image_url: z.string().url().optional(),
})

interface ImageSource {
  buffer: Buffer
  mimeType: string
  filename: string
}

/** Lee el multipart: archivo 'image' (opcional) + field 'payload' (JSON). */
async function readMultipart(req: any): Promise<{ file: ImageSource | null; payload: any }> {
  let file: ImageSource | null = null
  let payloadRaw = ''
  if (req.isMultipart?.()) {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer()
        file = { buffer, mimeType: String(part.mimetype || 'image/jpeg'), filename: part.filename || 'photo.jpg' }
      } else if (part.fieldname === 'payload') {
        payloadRaw = String(part.value || '')
      }
    }
  } else {
    // JSON plano (solo image_url, sin archivo)
    return { file: null, payload: req.body ?? {} }
  }
  let payload: any = {}
  if (payloadRaw) payload = JSON.parse(payloadRaw)
  return { file, payload }
}

/** Resuelve la imagen: archivo subido o descarga de image_url (Spaces, etc.). */
async function resolveImage(file: ImageSource | null, imageUrl?: string): Promise<ImageSource> {
  if (file) {
    if (!ALLOWED_MIME.has(file.mimeType)) throw new TenantError(`Formato de imagen no soportado (${file.mimeType}). Usa JPG, PNG o WEBP.`, 400)
    if (file.buffer.length > MAX_IMAGE_BYTES) throw new TenantError('La imagen supera el máximo de 15MB.', 400)
    return file
  }
  if (!imageUrl) throw new TenantError('Falta la imagen (archivo o image_url).', 400)
  if (!/^https?:\/\//i.test(imageUrl)) throw new TenantError('image_url inválida.', 400)
  const res = await fetch(imageUrl)
  if (!res.ok) throw new TenantError(`No se pudo descargar la imagen (${res.status}).`, 422)
  const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim()
  const mimeType = ALLOWED_MIME.has(contentType) ? contentType : 'image/jpeg'
  const buffer = Buffer.from(await res.arrayBuffer())
  if (!buffer.length) throw new TenantError('La imagen descargada está vacía.', 422)
  if (buffer.length > MAX_IMAGE_BYTES) throw new TenantError('La imagen supera el máximo de 15MB.', 400)
  const filename = imageUrl.split('/').pop()?.split('?')[0] || 'photo.jpg'
  return { buffer, mimeType, filename }
}

const NOTE_SYSTEM = `Eres el redactor gastronómico de un restaurante dominicano. A partir de la FOTO de un producto
escribes su nota de catálogo/ficha para el sistema POS: qué es, ingredientes o componentes visibles,
presentación y porción aparente. Tono apetitoso pero profesional, en español, 2 a 4 oraciones,
máximo ~350 caracteres. SOLO describe lo que se ve o lo que el contexto confirma — no inventes
ingredientes ocultos, precios ni promociones. Devuelve ÚNICAMENTE el texto de la nota, sin comillas ni títulos.`

const ENHANCE_PROMPT = `Convierte esta foto en una imagen profesional de catálogo de restaurante:
recorta y centra el producto, ELIMINA por completo el fondo original y colócalo sobre un fondo blanco
puro de estudio con una sombra suave y natural debajo. Corrige el balance de blancos, mejora la
iluminación y realza los colores de forma natural (sin saturación artificial). El producto debe quedar
IDÉNTICO al original: misma forma, mismos ingredientes, mismas proporciones. No agregues ni quites
elementos, sin texto, sin marcas de agua, sin utilería nueva.`

export function visionRoutes(app: FastifyInstance) {
  // ── Nota / ficha técnica desde la foto ────────────────────────────────────
  app.post('/comandi/vision/product-note', async (req, reply) => {
    let file: ImageSource | null = null
    let payloadRaw: any = {}
    try {
      ;({ file, payload: payloadRaw } = await readMultipart(req))
    } catch {
      return reply.code(400).send({ success: false, message: 'Multipart/payload inválido' })
    }
    const parsed = NotePayload.safeParse(payloadRaw)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Datos inválidos', errors: parsed.error.flatten() })

    try {
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const image = await resolveImage(file, parsed.data.image_url)

      const context: string[] = []
      if (parsed.data.product_name) context.push(`Nombre del producto: ${parsed.data.product_name}`)
      if (parsed.data.category) context.push(`Categoría: ${parsed.data.category}`)
      if (parsed.data.current_note) context.push(`Nota actual (mejórala si aporta): ${parsed.data.current_note}`)
      const user = `${context.length ? context.join('\n') + '\n\n' : ''}Escribe la nota de catálogo de este producto a partir de la foto.`

      const userId = req.actor?.type === 'user' ? req.actor.userId : null
      const note = (await generateText({
        config,
        system: NOTE_SYSTEM,
        user,
        maxTokens: 500,
        image: { base64: image.buffer.toString('base64'), mimeType: image.mimeType },
        usageMeta: { businessUnitId, userId, endpoint: 'vision-note' },
      })).trim()

      if (!note) return reply.code(502).send({ success: false, message: 'El modelo no devolvió la nota.' })
      return { success: true, enabled: true, provider: config.provider, model: config.model, note }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof LLMError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error generando la nota del producto' })
    }
  })

  // ── "Mejorar para catálogo": fondo blanco de estudio + color corregido ────
  app.post('/comandi/vision/enhance-image', async (req, reply) => {
    let file: ImageSource | null = null
    let payloadRaw: any = {}
    try {
      ;({ file, payload: payloadRaw } = await readMultipart(req))
    } catch {
      return reply.code(400).send({ success: false, message: 'Multipart/payload inválido' })
    }
    const parsed = EnhancePayload.safeParse(payloadRaw)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Datos inválidos', errors: parsed.error.flatten() })

    try {
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      // gpt-image-1 es exclusivo de OpenAI: llave de la empresa o la global.
      const oaiKey = config.provider === 'openai' ? config.apiKey : (env.OPENAI_API_KEY || '')
      if (!oaiKey) return reply.code(503).send({ success: false, message: 'Mejora de imagen no disponible (falta llave de OpenAI).' })

      const image = await resolveImage(file, parsed.data.image_url)
      const client = new OpenAI({ apiKey: oaiKey })
      const res: any = await client.images.edit({
        model: 'gpt-image-1',
        image: await toFile(image.buffer, image.filename, { type: image.mimeType }),
        prompt: ENHANCE_PROMPT,
        size: '1024x1024',
        quality: 'medium',
        // Preserva logos, etiquetas y texto del producto original (sin esto
        // gpt-image-1 "redibuja" las marcas y el texto pequeño sale ilegible).
        input_fidelity: 'high',
        n: 1,
      })

      const b64 = res?.data?.[0]?.b64_json
      if (!b64) return reply.code(502).send({ success: false, message: 'El modelo no devolvió la imagen mejorada.' })

      // Consumo (best-effort): gpt-image-1 reporta tokens en usage.
      const userId = req.actor?.type === 'user' ? req.actor.userId : null
      const usage: AIUsage = { provider: 'openai', model: 'gpt-image-1', tokensIn: 0, tokensOut: 0 }
      addUsage(usage, res?.usage)
      logUsage({ businessUnitId, userId, endpoint: 'vision-enhance' }, usage)

      return { success: true, enabled: true, model: 'gpt-image-1', image_base64: b64, mime_type: 'image/png' }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      req.log.error(e)
      const msg = e?.status === 400 ? `OpenAI rechazó la imagen: ${e?.message || 'imagen inválida'}` : 'Error mejorando la imagen'
      return reply.code(e?.status === 400 ? 422 : 500).send({ success: false, message: msg })
    }
  })
}
