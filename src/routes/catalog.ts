// Inteligencia de catálogo (creación/edición de productos):
//   POST /comandi/catalog/classify        → sugiere la categoría del producto (elige de la lista dada)
//   POST /comandi/catalog/suggest-recipe  → propone la receta estándar (ingredientes GENÉRICOS + cantidades);
//                                           el CORE hace el match contra inventory (pg_trgm) porque el scoping
//                                           de qué items son ingredientes válidos es regla de dominio del core.
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { locationFields, resolveTenant } from '../lib/resolve.js'
import { TenantError } from '../db/tenant.js'
import { generateJSON, LLMError } from '../llm/provider.js'

const ClassifyBody = z.object({
  ...locationFields,
  product_name: z.string().min(2).max(200),
  note: z.string().max(2000).optional(),
  categories: z.array(z.object({ id: z.coerce.number().int(), name: z.string().min(1).max(200) })).min(1).max(300),
})

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category_id: { type: ['integer', 'null'], description: 'id de la categoría elegida de la lista, o null si ninguna aplica razonablemente.' },
    confidence: { type: 'number', description: 'Confianza 0 a 1.' },
    reason: { type: ['string', 'null'], description: 'Justificación corta (una frase).' },
  },
  required: ['category_id', 'confidence', 'reason'],
} as const

const RecipeBody = z.object({
  ...locationFields,
  product_name: z.string().min(2).max(200),
  note: z.string().max(2000).optional(),
})

const RECIPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ingredients: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'Nombre GENÉRICO del ingrediente en español, singular, sin marca (ej. "queso cheddar", "pan de hamburguesa", "carne molida de res").' },
          quantity: { type: 'number', description: 'Cantidad para UNA unidad de venta.' },
          unit: { type: 'string', enum: ['g', 'kg', 'ml', 'lt', 'und', 'oz', 'lb'], description: 'Unidad de la cantidad.' },
          is_disposable: { type: 'boolean', description: 'true si es empaque/desechable (envase, servilleta, cubierto), false si es ingrediente comestible.' },
        },
        required: ['name', 'quantity', 'unit', 'is_disposable'],
      },
    },
    notes: { type: ['string', 'null'], description: 'Aclaración corta de supuestos (porción asumida), o null.' },
  },
  required: ['ingredients', 'notes'],
} as const

const RECIPE_SYSTEM = `Eres un chef costeador de un restaurante dominicano. Dado el nombre (y descripción si hay)
de un producto del menú, propones su RECETA ESTÁNDAR para UNA unidad de venta: ingredientes con nombre
genérico en español (sin marcas) y cantidades realistas de food-cost (gramos/ml/unidades — nada de
"al gusto"). Incluye los desechables típicos del formato (envase para llevar, servilleta) marcados con
is_disposable=true solo cuando el producto claramente los usa. Si el producto NO es un plato/bebida
preparable (ej. un refresco embotellado, un repuesto), devuelve ingredients=[] y explica en notes.`

export function catalogRoutes(app: FastifyInstance) {
  // ── Sugerir categoría ──────────────────────────────────────────────────────
  app.post('/comandi/catalog/classify', async (req, reply) => {
    const parsed = ClassifyBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Datos inválidos', errors: parsed.error.flatten() })

    try {
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const list = parsed.data.categories.map((c) => `${c.id}: ${c.name}`).join('\n')
      const userId = req.actor?.type === 'user' ? req.actor.userId : null
      const result = await generateJSON<{ category_id: number | null; confidence: number; reason: string | null }>({
        config,
        system: `Clasificas productos de un punto de venta en UNA categoría de la lista dada.
Responde con el id EXACTO de la lista (no inventes ids). Si ninguna categoría aplica razonablemente, category_id=null.`,
        user: `Producto: ${parsed.data.product_name}${parsed.data.note ? `\nDescripción: ${parsed.data.note}` : ''}\n\nCategorías disponibles (id: nombre):\n${list}`,
        schema: CLASSIFY_SCHEMA,
        schemaName: 'product_classification',
        maxTokens: 300,
        usageMeta: { businessUnitId, userId, endpoint: 'catalog-classify' },
      })

      // Blindaje: el id debe existir en la lista enviada.
      const valid = result.category_id != null && parsed.data.categories.some((c) => c.id === result.category_id)
      return {
        success: true,
        enabled: true,
        category_id: valid ? result.category_id : null,
        confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
        reason: result.reason || null,
      }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof LLMError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error clasificando el producto' })
    }
  })

  // ── Sugerir receta (ingredientes genéricos; el core los mapea a inventario) ─
  app.post('/comandi/catalog/suggest-recipe', async (req, reply) => {
    const parsed = RecipeBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Datos inválidos', errors: parsed.error.flatten() })

    try {
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const userId = req.actor?.type === 'user' ? req.actor.userId : null
      const result = await generateJSON<{ ingredients: Array<{ name: string; quantity: number; unit: string; is_disposable: boolean }>; notes: string | null }>({
        config,
        system: RECIPE_SYSTEM,
        user: `Producto: ${parsed.data.product_name}${parsed.data.note ? `\nDescripción: ${parsed.data.note}` : ''}`,
        schema: RECIPE_SCHEMA,
        schemaName: 'standard_recipe',
        maxTokens: 1200,
        usageMeta: { businessUnitId, userId, endpoint: 'catalog-recipe' },
      })

      return { success: true, enabled: true, provider: config.provider, model: config.model, ingredients: result.ingredients || [], notes: result.notes || null }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof LLMError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error sugiriendo la receta' })
    }
  })
}
