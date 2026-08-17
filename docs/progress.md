## 2026-08-17 — Visión de productos: nota desde la foto + mejora de imagen para catálogo

- `src/llm/provider.ts`: `TextOpts.image` opcional (base64+mime) → visión multimodal en `generateText` (OpenAI Responses `input_image` detail high / Anthropic bloque `image`).
- `src/routes/vision.ts` (nuevo, registrado en app.ts):
  - `POST /comandi/vision/product-note` — multipart (file `image` + `payload` JSON) o JSON con `image_url` (Comandi la descarga, cap 15MB, JPG/PNG/WEBP). Redacta la nota de catálogo del producto con el motor BYO-key de la empresa. usage_log endpoint `vision-note`.
  - `POST /comandi/vision/enhance-image` — gpt-image-1 `images.edit` (size 1024, quality medium, `input_fidelity: 'high'` para preservar logos/etiquetas): fondo blanco de estudio + color corregido. Solo OpenAI: llave de la empresa o `OPENAI_API_KEY` global (mismo fallback que voz). Devuelve `image_base64` PNG. usage_log endpoint `vision-enhance`.
- Probado end-to-end en dev (BU16 gpt-4o + gpt-image-1): nota real e imagen con marca intacta en ~20-40s. Consumidor: ProductsCreate.vue del core vía `useComandi.productNote()/enhanceImage()`.
- Pendiente: deploy PROD.
