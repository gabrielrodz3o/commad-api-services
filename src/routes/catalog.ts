// Inteligencia de catálogo (creación/edición de productos):
//   POST /comandi/catalog/classify        → sugiere la categoría del producto (elige de la lista dada)
//   POST /comandi/catalog/suggest-recipe  → propone la receta estándar (ingredientes GENÉRICOS + cantidades);
//                                           el CORE hace el match contra inventory (pg_trgm) porque el scoping
//                                           de qué items son ingredientes válidos es regla de dominio del core.
//   POST /comandi/catalog/import/*        → importador inteligente de catálogo (abajo):
//                                           map-columns · classify · recipes
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

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORTADOR INTELIGENTE DE CATÁLOGO (onboarding con IA) — 3 pasos, uno por
// llamada, para que el core pueda mostrar progreso y el costo del LLM sea acotado:
//
//   POST /comandi/catalog/import/map-columns  → encabezados crudos → campos canónicos
//   POST /comandi/catalog/import/classify     → por fila: tipo (PRODUCTO/INSUMO/RECETA/
//                                               SERVICIO), unidad de medida REAL,
//                                               categoría padre/hija, pesable, desechable
//   POST /comandi/catalog/import/recipes      → por producto tipo RECETA: líneas de
//                                               receta escogiendo insumos de la LISTA
//                                               REAL (los del CSV + los del catálogo)
//
// Reglas duras (para que el core nunca reciba basura):
//  · La unidad SIEMPRE sale del catálogo real de unidades que manda el core.
//  · Los insumos de una receta se eligen por `k` (índice de la lista real). El
//    modelo solo inventa nombre cuando NO existe candidato → el core decide si
//    lo crea. Nunca se cuela un id inventado.
//  · El core valida todo otra vez; esto es una PROPUESTA revisable por el usuario.
// ═══════════════════════════════════════════════════════════════════════════════

/** Campos canónicos que entiende /api/inventory/catalog-import. */
const CANON_FIELDS = [
  'nombre', 'descripcion', 'tipo', 'categoria_padre', 'categoria',
  'precio', 'precio2', 'precio3', 'costo', 'itbis', 'unidad', 'peso',
  'plu', 'barcode', 'barcode2', 'oem', 'aftermarket', 'interno', 'marca',
  'min', 'max', 'stock', 'proveedor',
] as const

const MapColumnsBody = z.object({
  ...locationFields,
  headers: z.array(z.string().max(120)).min(1).max(60),
  samples: z.array(z.array(z.string().max(200))).max(8).optional(),
  business_type: z.coerce.number().int().min(1).max(9).nullable().optional(),
})

const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    columns: {
      type: 'array',
      maxItems: 60,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', description: 'Encabezado EXACTO del archivo, tal como te lo di.' },
          field: {
            type: ['string', 'null'],
            enum: [...CANON_FIELDS, null],
            description: 'Campo canónico al que corresponde, o null si la columna no sirve para el catálogo (proveedor, fecha, notas internas…).',
          },
          confidence: { type: 'number', description: 'Confianza 0 a 1.' },
        },
        required: ['source', 'field', 'confidence'],
      },
    },
    price_includes_tax: {
      type: ['boolean', 'null'],
      description: 'La columna que mapeaste a `precio` ¿ya incluye el ITBIS (precio al público)? true = incluye, false = es base imponible / sin impuesto, null = no hay pistas suficientes.',
    },
    price_tax_reason: { type: ['string', 'null'], description: 'En qué te basaste (encabezado, otra columna, o si fue el supuesto por defecto). Una frase.' },
    notes: { type: ['string', 'null'], description: 'Aviso corto para el usuario (columna dudosa, precio que parece costo, etc.) o null.' },
  },
  required: ['columns', 'price_includes_tax', 'price_tax_reason', 'notes'],
} as const

const BUSINESS_HINT: Record<number, string> = {
  1: 'restaurante (platos preparados, recetas y desechables)',
  2: 'supermercado / colmado (productos empacados y pesables, casi nunca recetas)',
  3: 'repuestos de vehículos (números de parte OEM/aftermarket, nunca recetas)',
  4: 'hotel',
  5: 'ferretería (materiales por unidad/medida, nunca recetas)',
  6: 'repostería / panadería (productos horneados con receta e insumos de masa)',
}

const bizLine = (t?: number | null) =>
  t && BUSINESS_HINT[t] ? `El negocio es un ${BUSINESS_HINT[t]}.` : 'El tipo de negocio no está definido.'

const MAP_SYSTEM = `Eres un ingeniero de datos que normaliza catálogos de productos para un punto de venta
dominicano. Recibes los encabezados crudos de un archivo (Excel/CSV de cualquier proveedor, en español o
inglés, con abreviaturas y errores) y unas filas de muestra. Devuelves a qué campo canónico corresponde
cada columna. Reglas:
· El NOMBRE del artículo suele venir como "descripcion", "descripcion articulo", "detalle", "articulo",
  "producto", "item", "concepto" → mapea eso al campo NOMBRE. Reserva el campo descripcion SOLO para una
  columna ADICIONAL de detalle/observación cuando ya existe otra columna con el nombre. Un archivo sin
  nombre es inútil: si dudas entre nombre y descripcion, elige nombre.
· "precio", "pvp", "venta", "p. público" → precio (precio de VENTA al público, con ITBIS incluido).
· "costo", "compra", "cost", "ult. costo" → costo. Si solo hay UNA columna de dinero y las muestras
  parecen costos de proveedor, mapéala a costo y avísalo en notes.
· "mayorista"/"precio 2" → precio2; "vip"/"precio 3" → precio3.
· Si hay DOS columnas del MISMO precio de venta (una con impuesto y otra sin), mapea a precio la que
  YA INCLUYE el impuesto ("PRECIO CON ITBIS", "TOTAL", "P. FINAL") y deja la otra en null; en ese caso
  price_includes_tax = true. El sistema guarda el precio al público.
· "um", "u/m", "unidad", "medida", "presentación" → unidad. "existencia", "cant", "stock" → stock.
· "familia", "grupo", "depto", "línea" → categoria_padre; "subcategoría", "sub" → categoria.
· "ean", "upc", "cod. barra" → barcode; "plu", "balanza" → plu; "ref", "sku", "código interno" → interno.
· Columna de IMPUESTO → itbis SOLO si es una TASA o una marca (18, 18%, 0.18, E/G, exento, gravado).
  Si la columna trae el MONTO del impuesto por fila (ej. 32.03 junto a un precio de 177.97), NO es itbis:
  déjala en null y usa eso como señal de que el precio es la base (price_includes_tax=false).
  No confundas ninguna de las dos con el precio.
· "proveedor", "suplidor", "suministrador", "vendor" → proveedor (el core lo cruza con sus proveedores).
· Cualquier columna que no sirva para el catálogo → field=null. Nunca inventes un campo que no esté en la lista.
Devuelve TODAS las columnas que te di, en el mismo orden, usando el encabezado EXACTO en source.

ADEMÁS decides price_includes_tax — si el precio de venta que mapeaste YA trae el ITBIS:
· Encabezados como "PVP", "PRECIO PÚBLICO", "PRECIO VENTA", "PRECIO CON ITBIS", "P. FINAL",
  "PRECIO TIENDA" → true (en República Dominicana el precio de mostrador se exhibe con impuesto).
· "PRECIO SIN ITBIS", "BASE", "BASE IMPONIBLE", "PRECIO NETO", "SUBTOTAL", "PRECIO ANTES DE IMPUESTO",
  o si hay DOS columnas de precio y una es visiblemente la otra + 18% (la menor es la base) → false.
· Si el archivo trae una columna de impuesto MONTO (no tasa) aparte del precio, casi siempre el precio
  es la base → false.
· Sin pistas → null (el sistema asume que incluye ITBIS y se lo avisa al usuario).
Explica tu razón en price_tax_reason.`

const ClassifyBulkBody = z.object({
  ...locationFields,
  business_type: z.coerce.number().int().min(1).max(9).nullable().optional(),
  units: z.array(z.string().min(1).max(60)).min(1).max(120),
  categories: z.array(z.object({ name: z.string().min(1).max(120), is_supply: z.boolean().optional() })).max(300).optional(),
  // Categorías CONTABLES reales de la empresa (finances.account_categories).
  account_categories: z.array(z.object({ id: z.coerce.number().int(), name: z.string().min(1).max(120) })).max(60).optional(),
  // Centros de producción REALES de la sucursal (restaurant.production_centers):
  // a dónde se imprime la comanda — bar, cocina caliente, cocina fría, pizzería…
  production_centers: z.array(z.object({ id: z.coerce.number().int(), name: z.string().min(1).max(120) })).max(40).optional(),
  rows: z.array(z.object({
    i: z.coerce.number().int().min(0),
    name: z.string().min(1).max(300),
    note: z.string().max(400).optional(),
    category: z.string().max(160).optional(),
    unit: z.string().max(60).optional(),
    price: z.coerce.number().nullable().optional(),
    cost: z.coerce.number().nullable().optional(),
  })).min(1).max(60),
})

const CLASSIFY_BULK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rows: {
      type: 'array',
      maxItems: 60,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          i: { type: 'integer', description: 'El mismo índice i que te di para esa fila.' },
          tipo: { type: 'string', enum: ['PRODUCTO', 'INSUMO', 'RECETA', 'SERVICIO'], description: 'PRODUCTO = se vende tal como se compra. INSUMO = materia prima que solo se consume dentro de recetas. RECETA = se vende pero se prepara con insumos. SERVICIO = no es físico.' },
          unidad: { type: 'string', description: 'Unidad de medida base, EXACTAMENTE una de la lista de unidades que te di.' },
          categoria_padre: { type: 'string', description: 'Categoría raíz en MAYÚSCULAS. Reutiliza una de las existentes si aplica.' },
          categoria: { type: 'string', description: 'Subcategoría en MAYÚSCULAS (o GENERAL si no hay una clara).' },
          pesable: { type: 'boolean', description: 'true si se vende por peso en balanza (queso, carne a granel).' },
          desechable: { type: 'boolean', description: 'true si es empaque/desechable (vaso, servilleta, funda).' },
          centro: { type: ['integer', 'null'], description: 'id EXACTO del centro de producción de la lista (a dónde se manda la comanda cuando se vende). null para INSUMO, SERVICIO, para lo que se despacha del mostrador sin preparación, o si no te dieron lista.' },
          contable: { type: ['integer', 'null'], description: 'id EXACTO de la categoría contable de la lista que te di (la que corresponde a este artículo). null si no te dieron lista o ninguna aplica. Nunca inventes ids.' },
          perecedero: { type: 'boolean', description: 'true si se daña con el tiempo y necesita control de vencimiento/lote (carnes, lácteos, vegetales, frutas, panadería, embutidos). false para secos, empaques, bebidas embotelladas, repuestos.' },
          contenido: { type: ['number', 'null'], description: 'Contenido de la presentación EXPRESADO EN LA UNIDAD QUE ELEGISTE, solo si el texto lo dice explícito: "VASO FOAM PQT 50" con unidad PAQUETE → 50; "CERVEZA CAJA 24" con unidad CAJA/CAJON → 24. Si la unidad ya es la de venta suelta (UNIDAD, LIBRA) o el contenido no está en el texto → null. NUNCA lo inventes.' },
          merma: { type: ['number', 'null'], description: 'Solo para INSUMO que pierde peso al limpiarse/pelarse: % de merma estándar (plátano ~30, yuca ~25, pechuga ~5). Si no aplica o no estás seguro → null.' },
          confianza: { type: 'number', description: 'Confianza 0 a 1.' },
        },
        required: ['i', 'tipo', 'unidad', 'categoria_padre', 'categoria', 'centro', 'contable', 'perecedero', 'pesable', 'desechable', 'contenido', 'merma', 'confianza'],
      },
    },
  },
  required: ['rows'],
} as const

const CLASSIFY_BULK_SYSTEM = `Clasificas filas de un catálogo que se va a cargar en un POS dominicano.
Para CADA fila decides:
1) tipo:
   · INSUMO → materia prima / ingrediente / empaque que NO se vende suelto al cliente y solo se consume
     dentro de recetas (harina, queso en bloque, aceite a granel, vasos, fundas, servilletas).
   · RECETA → se vende al cliente pero hay que prepararlo con varios insumos (platos, bebidas preparadas,
     panes, pizzas, combos armados en cocina). Si tiene precio de venta y es preparable, es RECETA.
   · PRODUCTO → se vende tal como se compra, sin preparación (refresco embotellado, galletas, un repuesto,
     un tornillo, una lata).
   · SERVICIO → no es un bien físico (delivery, instalación, mano de obra).
   Si la fila NO tiene precio de venta (o es 0) y sí costo, casi siempre es INSUMO.
2) unidad: la unidad base con la que se maneja en inventario, tomada EXACTAMENTE de la lista de unidades
   que te doy (son las del sistema; si el archivo dice "lb" usa LIBRA, "kg" KILOGRAMO, "gr" GRAMO,
   "und/pza/ea" UNIDAD, "gl" GALONES, "mt" METRO, "cj" CAJA/CAJON, "pqt" PAQUETE, "sco" SACO).
   Nunca inventes una unidad que no esté en la lista.
3) categoria_padre / categoria: jerarquía de máximo 2 niveles, en MAYÚSCULAS. Reutiliza las categorías
   existentes que te doy cuando encajen (mismo nombre exacto); si no, propone nombres cortos de negocio.
   Los INSUMOS van bajo categorías de insumo (ej. "INSUMOS" > "LACTEOS", "EMPAQUES" > "DESECHABLES").
4) centro: a qué CENTRO DE PRODUCCIÓN se manda la comanda, por id de la lista que te doy. Guíate por el
   nombre del centro y por lo que es el producto:
   · BAR / BARRA / CAFETERÍA → cerveza, ron, tragos, cócteles, jugos y batidas naturales, café, refrescos
     servidos en vaso, cualquier bebida preparada.
   · COCINA / COCINA CALIENTE / PARRILLA / FREIDORA → platos cocinados, guisos, frituras, parrilla, sopas.
   · COCINA FRÍA / PANTRY / ENSALADAS → ensaladas, sándwiches fríos, ceviches, postres fríos.
   · PIZZERÍA / HORNO / REPOSTERÍA → pizzas, pan, bizcochos, postres horneados.
   Si el producto se entrega tal como se compra y NO pasa por preparación (una botella de agua, un
   refresco embotellado que se saca de la nevera, un repuesto), o es INSUMO o SERVICIO → null.
   Si la lista solo tiene UN centro, úsalo para todo lo preparable.
5) contable: la categoría CONTABLE del artículo, elegida por id de la lista que te doy (así el gasto y
   el costo de venta caen en la cuenta correcta). Si no hay lista, null.
6) perecedero: si necesita control de vencimiento/lote.
7) contenido: SOLO si el nombre o la columna de presentación dice cuánto trae el empaque y la unidad
   elegida es de empaque (PAQUETE, CAJA/CAJON, SACO, FARDO, DOCENA, BULTOS). Si no, null.
8) merma: solo insumos que se pelan o limpian; si dudas, null.
No inventes filas ni cambies el índice i. Responde una entrada por cada fila recibida.`

const RecipesBulkBody = z.object({
  ...locationFields,
  business_type: z.coerce.number().int().min(1).max(9).nullable().optional(),
  products: z.array(z.object({
    i: z.coerce.number().int().min(0),
    name: z.string().min(1).max(300),
    note: z.string().max(400).optional(),
    price: z.coerce.number().nullable().optional(),
    unit: z.string().max(60).optional(),
  })).min(1).max(15),
  supplies: z.array(z.object({
    k: z.coerce.number().int().min(0),
    name: z.string().min(1).max(300),
    unit: z.string().max(60).optional(),
    // Contenido de la presentación (items.unit_quantity): un PAQUETE de 50 vasos
    // trae content=50 y el costeo divide el costo entre 50 → la cantidad de la
    // receta se expresa en unidades del CONTENIDO, no en empaques.
    content: z.coerce.number().positive().optional(),
    // Costo del insumo POR SU UNIDAD BASE. Sin esto el modelo no puede saber que
    // "1 PAQUETE de servilletas" son RD$85 en un plato que se vende a RD$190.
    cost: z.coerce.number().nonnegative().optional(),
    origin: z.enum(['csv', 'catalogo']).optional(),
  })).max(400).optional(),
  units: z.array(z.string().min(1).max(60)).min(1).max(120),
})

const RECIPES_BULK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    recipes: {
      type: 'array',
      maxItems: 15,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          i: { type: 'integer', description: 'El mismo índice i del producto.' },
          ingredients: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                k: { type: ['integer', 'null'], description: 'Índice k del insumo ELEGIDO de la lista de insumos disponibles. null solo si ningún insumo de la lista sirve.' },
                name: { type: 'string', description: 'Nombre del insumo. Si k no es null, copia el nombre de la lista. Si k es null, nombre genérico en español sin marca.' },
                quantity: { type: 'number', description: 'Cantidad para UNA unidad de venta, expresada en la unidad indicada. Realista para food-cost, nunca 0.' },
                unit: { type: 'string', description: 'Unidad de la cantidad. Si k no es null usa EXACTAMENTE la unidad base de ese insumo. Si k es null usa una de las unidades del sistema que te di.' },
                is_disposable: { type: 'boolean', description: 'true si es empaque/desechable, false si es ingrediente.' },
              },
              required: ['k', 'name', 'quantity', 'unit', 'is_disposable'],
            },
          },
          preparacion: { type: ['string', 'null'], description: 'Pasos de preparación numerados y cortos (máx 5 pasos, ~400 caracteres) para que cocina replique el plato igual siempre. null si el producto no se prepara.' },
          notes: { type: ['string', 'null'], description: 'Supuestos en una frase (porción asumida) o null.' },
        },
        required: ['i', 'ingredients', 'preparacion', 'notes'],
      },
    },
  },
  required: ['recipes'],
} as const

const RECIPES_BULK_SYSTEM = `Eres un chef costeador. Para cada producto que se va a vender, armas su RECETA
ESTÁNDAR para UNA unidad de venta usando SOLO insumos de la lista que te doy (escógelos por su índice k).
Reglas:
· Prefiere SIEMPRE un insumo de la lista antes que inventar uno. Elige el más específico que encaje
  (para "PIZZA PEPPERONI" usa la masa/queso/pepperoni de la lista, no "ingredientes varios").
· Cantidades realistas de food-cost en la unidad BASE del insumo elegido (si el insumo está en LIBRA,
  da la cantidad en libras: 0.25, no 113 gramos). Nunca "al gusto", nunca 0.
· ESCALA — lo más importante: la cantidad se MULTIPLICA por el costo que te doy. Si pones
  "1 PAQUETE" de servilletas de RD$85, le cargas 85 pesos a un solo plato. Una porción usa una
  FRACCIÓN del empaque: de un PAQUETE de vasos o servilletas se usa 0.01–0.05; de un SACO de
  harina o azúcar, 0.002–0.01; de un GALÓN de aceite o leche, 0.01–0.05.
· Solo cuando el insumo dice "de N unidades sueltas" la cantidad va en unidades sueltas
  (1 vaso de un paquete de 50 es 1). Si NO lo dice, "1" significa el EMPAQUE COMPLETO — casi
  nunca es lo correcto para una porción.
· CUADRA EL TOTAL: el costo de la receta debe quedar típicamente entre 20% y 40% del precio de
  venta, y nunca por encima del 60%. Si una sola línea se come más del 15% del precio, estás
  usando el empaque entero en vez de una porción: corrígela antes de responder.
· Incluye desechables (envase, vaso, servilleta) solo si el producto claramente los usa y están en la lista.
· Si el producto NO es preparable (un refresco embotellado, un repuesto), devuelve ingredients=[] y dilo en notes.
· preparacion: pasos numerados y cortos ("1. Majar el plátano con ajo... 2. ..."), lo que cocina necesita
  para que salga igual siempre. Sin florituras. null si no se prepara.
· No repitas el mismo insumo dos veces en la misma receta. Máximo 12 líneas por receta.`

/** Rutas del importador inteligente (se registran junto a las de catálogo). */
export function catalogImportRoutes(app: FastifyInstance) {
  // ── 1. Mapeo de columnas ───────────────────────────────────────────────────
  app.post('/comandi/catalog/import/map-columns', async (req, reply) => {
    const parsed = MapColumnsBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Datos inválidos', errors: parsed.error.flatten() })

    try {
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const { headers, samples = [] } = parsed.data
      const sampleBlock = samples.length
        ? `\n\nFilas de muestra (en el mismo orden de los encabezados):\n${samples.map((s) => s.join(' | ')).join('\n')}`
        : ''
      const userId = req.actor?.type === 'user' ? req.actor.userId : null

      const result = await generateJSON<{ columns: Array<{ source: string; field: string | null; confidence: number }>; price_includes_tax: boolean | null; price_tax_reason: string | null; notes: string | null }>({
        config,
        system: `${MAP_SYSTEM}\n${bizLine(parsed.data.business_type)}`,
        user: `Encabezados del archivo (${headers.length}):\n${headers.map((h, i) => `${i}: ${h}`).join('\n')}${sampleBlock}`,
        schema: MAP_SCHEMA,
        schemaName: 'catalog_column_mapping',
        maxTokens: 2000,
        usageMeta: { businessUnitId, userId, endpoint: 'catalog-import-map' },
      })

      // Blindaje: solo encabezados que existen y campos de la lista blanca; sin repetir campo.
      const known = new Set(headers)
      const used = new Set<string>()
      const columns = (result.columns || [])
        .filter((c) => c?.source && known.has(c.source))
        .map((c) => {
          const field = c.field && (CANON_FIELDS as readonly string[]).includes(c.field) && !used.has(c.field) ? c.field : null
          if (field) used.add(field)
          return { source: c.source, field, confidence: Math.max(0, Math.min(1, Number(c.confidence) || 0)) }
        })

      return {
        success: true, enabled: true, provider: config.provider, model: config.model, columns,
        price_includes_tax: typeof result.price_includes_tax === 'boolean' ? result.price_includes_tax : null,
        price_tax_reason: result.price_tax_reason || null,
        notes: result.notes || null,
      }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof LLMError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error mapeando las columnas' })
    }
  })

  // ── 2. Clasificación por fila (tipo + unidad + categorías) ─────────────────
  app.post('/comandi/catalog/import/classify', async (req, reply) => {
    const parsed = ClassifyBulkBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Datos inválidos', errors: parsed.error.flatten() })

    try {
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const { units, categories = [], rows } = parsed.data
      const catBlock = categories.length
        ? `\n\nCategorías que YA existen (reutilízalas si encajan; las marcadas [insumo] son de insumos):\n${categories.map((c) => `· ${c.name}${c.is_supply ? ' [insumo]' : ''}`).join('\n')}`
        : ''
      const pcBlock = (parsed.data.production_centers || []).length
        ? `\n\nCentros de producción de la sucursal (elige el id exacto para el campo centro):\n${parsed.data.production_centers!.map((c) => `${c.id}: ${c.name}`).join('\n')}`
        : ''
      const accBlock = (parsed.data.account_categories || []).length
        ? `\n\nCategorías CONTABLES (elige el id exacto para el campo contable):\n${parsed.data.account_categories!.map((a) => `${a.id}: ${a.name}`).join('\n')}`
        : ''
      const rowBlock = rows.map((r) => {
        const bits = [`i=${r.i}`, r.name]
        if (r.category) bits.push(`cat="${r.category}"`)
        if (r.unit) bits.push(`um="${r.unit}"`)
        if (r.price != null) bits.push(`precio=${r.price}`)
        if (r.cost != null) bits.push(`costo=${r.cost}`)
        if (r.note) bits.push(`desc="${r.note}"`)
        return bits.join(' | ')
      }).join('\n')
      const userId = req.actor?.type === 'user' ? req.actor.userId : null

      const result = await generateJSON<{ rows: Array<any> }>({
        config,
        system: `${CLASSIFY_BULK_SYSTEM}\n${bizLine(parsed.data.business_type)}`,
        user: `Unidades del sistema (usa una EXACTA):\n${units.join(', ')}${catBlock}${pcBlock}${accBlock}\n\nFilas a clasificar (${rows.length}):\n${rowBlock}`,
        schema: CLASSIFY_BULK_SCHEMA,
        schemaName: 'catalog_row_classification',
        // 11 campos por fila: con lotes de 30 filas hace falta holgura o el JSON
        // se corta a medio camino y el lote entero se pierde.
        maxTokens: 9000,
        usageMeta: { businessUnitId, userId, endpoint: 'catalog-import-classify' },
      })

      // Blindaje: índice recibido, unidad de la lista real, tipo válido.
      const wanted = new Map(rows.map((r) => [r.i, r]))
      const unitSet = new Map(units.map((u) => [u.toUpperCase().replace(/[^A-Z0-9]/g, ''), u]))
      const accIds = new Set((parsed.data.account_categories || []).map((a) => a.id))
      const pcIds = new Set((parsed.data.production_centers || []).map((c) => c.id))
      const out = (result.rows || [])
        .filter((r: any) => wanted.has(Number(r?.i)))
        .map((r: any) => {
          const uKey = String(r.unidad ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
          return {
            i: Number(r.i),
            tipo: ['PRODUCTO', 'INSUMO', 'RECETA', 'SERVICIO'].includes(r.tipo) ? r.tipo : 'PRODUCTO',
            unidad: unitSet.get(uKey) || null, // null = el core decide (respeta el CSV o UNIDAD)
            categoria_padre: String(r.categoria_padre ?? '').trim().toUpperCase() || null,
            categoria: String(r.categoria ?? '').trim().toUpperCase() || null,
            // Los ids deben existir en las listas enviadas (nunca uno inventado).
            centro: pcIds.has(Number(r.centro)) ? Number(r.centro) : null,
            contable: accIds.has(Number(r.contable)) ? Number(r.contable) : null,
            perecedero: !!r.perecedero,
            pesable: !!r.pesable,
            desechable: !!r.desechable,
            // contenido/merma: rangos sanos o null (el core no debe recibir basura).
            contenido: Number(r.contenido) > 0 && Number(r.contenido) <= 100000 ? Number(r.contenido) : null,
            merma: Number(r.merma) > 0 && Number(r.merma) < 90 ? Number(r.merma) : null,
            confianza: Math.max(0, Math.min(1, Number(r.confianza) || 0)),
          }
        })

      return { success: true, enabled: true, provider: config.provider, model: config.model, rows: out }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof LLMError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error clasificando las filas' })
    }
  })

  // ── 3. Recetas en lote (insumos elegidos de la lista REAL) ─────────────────
  app.post('/comandi/catalog/import/recipes', async (req, reply) => {
    const parsed = RecipesBulkBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Datos inválidos', errors: parsed.error.flatten() })

    try {
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const { products, supplies = [], units } = parsed.data
      const supplyBlock = supplies.length
        ? supplies.map((s) => `k=${s.k} · ${s.name}${s.unit ? ` (${s.unit}${s.content && s.content > 1 ? ` de ${s.content} unidades sueltas` : ''})` : ''}${s.cost ? ` — costo RD$${s.cost} por ${s.unit || 'unidad'}` : ''}${s.origin === 'csv' ? ' [nuevo en este archivo]' : ''}`).join('\n')
        : '(no hay insumos disponibles — devuelve k=null con nombres genéricos)'
      const prodBlock = products.map((p) => {
        const bits = [`i=${p.i}`, p.name]
        if (p.price != null) bits.push(`precio=${p.price}`)
        if (p.unit) bits.push(`um="${p.unit}"`)
        if (p.note) bits.push(`desc="${p.note}"`)
        return bits.join(' | ')
      }).join('\n')
      const userId = req.actor?.type === 'user' ? req.actor.userId : null

      const result = await generateJSON<{ recipes: Array<any> }>({
        config,
        system: `${RECIPES_BULK_SYSTEM}\n${bizLine(parsed.data.business_type)}`,
        user: `INSUMOS DISPONIBLES (elige por k):\n${supplyBlock}\n\nUnidades del sistema (solo si k=null):\n${units.join(', ')}\n\nPRODUCTOS A RECETAR (${products.length}):\n${prodBlock}`,
        schema: RECIPES_BULK_SCHEMA,
        schemaName: 'catalog_bulk_recipes',
        maxTokens: 6000,
        usageMeta: { businessUnitId, userId, endpoint: 'catalog-import-recipes' },
      })

      // Blindaje: i recibido, k existente, cantidad > 0, sin insumo repetido.
      const wanted = new Set(products.map((p) => p.i))
      const supplyByK = new Map(supplies.map((s) => [s.k, s]))
      const recipes = (result.recipes || [])
        .filter((r: any) => wanted.has(Number(r?.i)))
        .map((r: any) => {
          const seen = new Set<string>()
          const ingredients = (r.ingredients || [])
            .map((g: any) => {
              const k = g?.k == null ? null : Number(g.k)
              const supply = k != null ? supplyByK.get(k) : undefined
              const qty = Number(g?.quantity)
              if (!(qty > 0)) return null
              const name = supply?.name || String(g?.name ?? '').trim()
              if (!name) return null
              const key = supply ? `k:${k}` : `n:${name.toUpperCase()}`
              if (seen.has(key)) return null
              seen.add(key)
              return {
                k: supply ? k : null,
                name,
                quantity: qty,
                unit: supply?.unit || String(g?.unit ?? '').trim() || null,
                is_disposable: !!g?.is_disposable,
              }
            })
            .filter(Boolean)
            .slice(0, 12)
          const prep = typeof r.preparacion === 'string' ? r.preparacion.trim().slice(0, 1500) : ''
          return { i: Number(r.i), ingredients, preparacion: prep || null, notes: r.notes || null }
        })

      return { success: true, enabled: true, provider: config.provider, model: config.model, recipes }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof LLMError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error proponiendo las recetas' })
    }
  })
}
