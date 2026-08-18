## 2026-08-18 — Rutas de RRHH (acciones de empleo + liquidación)

- `src/routes/hr.ts` (nuevo, registrado en app.ts): `POST /comandi/hr/action-letter` (carta formal de acción de personal), `POST /comandi/hr/action-propose` (NL → acción estructurada con blindaje de ids contra las listas enviadas; propose→confirm), `POST /comandi/hr/explain-liquidation` (explicación legal Arts. 76/80/88/96/177/219-222) y `POST /comandi/hr/discharge-receipt` (recibo de descargo Art. 669 con total en letras).
- El CORE arma el contexto (RBAC empleados + datos reales) y mapea nombres→ids con pg_trgm; aquí solo tenant BYO-key + LLM + usage_log (endpoints: hr-action-letter/hr-action-propose/hr-explain-liquidation/hr-discharge-receipt).
- Probado en local con BU 3 (gpt-5.5). Consumidores en el core: server/api/hr/employees/[id]/ai-*.post.ts. FALTA deploy PROD.
## 2026-08-17 (tarde) — Inteligencia de catálogo (c205f33)

- `src/routes/catalog.ts`: `/comandi/catalog/classify` (categoría sugerida de la lista real del front, blindaje id válido) y `/comandi/catalog/suggest-recipe` (receta estándar: ingredientes genéricos + cantidades 1 unidad; el core mapea a inventario con pg_trgm).
- `vision.ts`: nota SIN imagen (bulk de items sin foto) + `allergens[]` en la respuesta.
- usage_log: catalog-classify / catalog-recipe. Probado con BU16 gpt-4o (mojito→COCTELES 0.95, club sandwich→7 ingredientes, tres leches→lácteos/huevo/gluten).

## 2026-08-17 — Visión de productos: nota desde la foto + mejora de imagen para catálogo

- `src/llm/provider.ts`: `TextOpts.image` opcional (base64+mime) → visión multimodal en `generateText` (OpenAI Responses `input_image` detail high / Anthropic bloque `image`).
- `src/routes/vision.ts` (nuevo, registrado en app.ts):
  - `POST /comandi/vision/product-note` — multipart (file `image` + `payload` JSON) o JSON con `image_url` (Comandi la descarga, cap 15MB, JPG/PNG/WEBP). Redacta la nota de catálogo del producto con el motor BYO-key de la empresa. usage_log endpoint `vision-note`.
  - `POST /comandi/vision/enhance-image` — gpt-image-1 `images.edit` (size 1024, quality medium, `input_fidelity: 'high'` para preservar logos/etiquetas): fondo blanco de estudio + color corregido. Solo OpenAI: llave de la empresa o `OPENAI_API_KEY` global (mismo fallback que voz). Devuelve `image_base64` PNG. usage_log endpoint `vision-enhance`.
- Probado end-to-end en dev (BU16 gpt-4o + gpt-image-1): nota real e imagen con marca intacta en ~20-40s. Consumidor: ProductsCreate.vue del core vía `useComandi.productNote()/enhanceImage()`.
- Pendiente: deploy PROD.
