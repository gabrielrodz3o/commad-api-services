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
import { generateJSON, LLMError } from '../llm/provider.js'
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

const NOTE_SYSTEM = `Eres un redactor experto de fichas de producto para un sistema POS dominicano que atiende
restaurantes, colmados y comercios retail (repuestos, electrónica, ferretería, bebidas, etc.).
A partir de la FOTO del producto escribes la NOTA DE CATÁLOGO definitiva, adaptando el tono al rubro:
- Comida/bebida preparada → apetitoso y profesional: qué es, ingredientes/componentes visibles, presentación, porción aparente.
- Producto empacado/retail/repuesto → ficha técnica comercial: qué es, marca y modelo visibles, características, uso típico y compatibilidades SOLO si son visibles o notorias de esa marca/modelo.

REGLAS DE ORO:
1. "note" es SIEMPRE una nota de catálogo lista para publicar: NUNCA un descargo, disculpa ni comentario
   sobre la imagen ("la imagen muestra...", "no se aprecia...", "no coincide..." están PROHIBIDOS en note).
   El cliente final la leerá junto al producto — debe venderlo, no auditar la foto.
2. EL NOMBRE DEL PRODUCTO MANDA: la nota es del artículo indicado por el usuario.
   - Si la foto corresponde al nombre → úsala para enriquecer la nota (presentación, colores, detalles visibles).
   - Si la foto NO corresponde al nombre → IGNORA la foto y escribe la nota del artículo del nombre usando tu
     conocimiento real de esa marca/modelo (ej. "Bosch FC06199" = filtro de combustible: función, calidad OE,
     aplicación típica), marca image_matches_context=false y explica el descuadre SOLO en "observation"
     (ej.: "La foto parece un control inalámbrico, no el filtro Bosch del nombre — verifica la foto").
   - Sin nombre dado → describe el producto que muestra la foto.
3. No inventes especificaciones dudosas (medidas exactas, compatibilidades no confirmadas) ni precios/promos.
4. Español, 2 a 4 oraciones, máximo ~350 caracteres, sin emojis.`

const NOTE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    note: { type: 'string', description: 'Nota de catálogo lista para publicar (describe el producto de la foto).' },
    image_matches_context: { type: 'boolean', description: 'true si la foto corresponde al nombre/categoría dados (o si no se dio contexto).' },
    observation: { type: ['string', 'null'], description: 'Solo si hay descuadre foto↔nombre u otro problema: explicación corta para el usuario. Si todo bien, null.' },
  },
  required: ['note', 'image_matches_context', 'observation'],
} as const

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
      if (parsed.data.product_name) context.push(`Nombre del producto según el usuario: ${parsed.data.product_name}`)
      if (parsed.data.category) context.push(`Categoría según el usuario: ${parsed.data.category}`)
      if (parsed.data.current_note) context.push(`Nota actual (mejórala si aporta): ${parsed.data.current_note}`)
      const user = `${context.length ? context.join('\n') + '\n\n' : ''}Escribe la nota de catálogo del producto que aparece en la foto.`

      const userId = req.actor?.type === 'user' ? req.actor.userId : null
      const result = await generateJSON<{ note: string; image_matches_context: boolean; observation: string | null }>({
        config,
        system: NOTE_SYSTEM,
        user,
        schema: NOTE_SCHEMA,
        schemaName: 'product_catalogue_note',
        maxTokens: 700,
        image: { base64: image.buffer.toString('base64'), mimeType: image.mimeType },
        usageMeta: { businessUnitId, userId, endpoint: 'vision-note' },
      })

      const note = (result?.note || '').trim()
      if (!note) return reply.code(502).send({ success: false, message: 'El modelo no devolvió la nota.' })
      return {
        success: true,
        enabled: true,
        provider: config.provider,
        model: config.model,
        note,
        image_matches_context: result.image_matches_context !== false,
        observation: result.observation || null,
      }
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
