// Carga y valida las variables de entorno una sola vez al arrancar.
import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  PORT: z.coerce.number().default(4080),
  NODE_ENV: z.string().default('development'),

  COMANDI_SERVICE_TOKEN: z.string().min(1, 'COMANDI_SERVICE_TOKEN es obligatorio'),
  // Mismo secreto JWT que el core: permite que el frontend llame a Comandi directo
  // con el token de login del usuario (Comandi lo valida + aplica RBAC).
  JWT_SECRET: z.string().default(''),
  CORS_ORIGINS: z.string().default(''),

  // URL del core (Nuxt). Comandi lo llama server-to-server para TRAER reportes ya
  // calculados cuando trabaja sin pantalla (autónomo: WhatsApp/cron). Usa el
  // header x-internal-secret = JWT_SECRET (el core lo reconoce como interno).
  CORE_API_URL: z.string().default('http://localhost:3000'),

  DB_HOST: z.string(),
  DB_PORT: z.coerce.number().default(6432),
  DB_DATABASE: z.string(),
  DB_USER: z.string(),
  DB_PASSWORD: z.string(),

  OPENAI_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),

  // Telegram — bot de plataforma (fallback). Cada empresa puede traer el suyo
  // en business_units.telegram_bot_token. Vacío = canal Telegram deshabilitado.
  TELEGRAM_BOT_TOKEN: z.string().default(''),

  // CORS multi-tenant: además de CORS_ORIGINS (lista exacta), se permite cualquier
  // subdominio de estos sufijos (ej. pizzagetto.comandpos.com, cliente2.comandpos.com…).
  CORS_ORIGIN_SUFFIXES: z.string().default('.comandpos.com'),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('❌ Variables de entorno inválidas:\n', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
// Sufijos permitidos (subdominios). Se normalizan a algo tipo ".comandpos.com".
export const corsOriginSuffixes = env.CORS_ORIGIN_SUFFIXES
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => (s.startsWith('.') ? s : `.${s}`))

// ¿Se permite este origin? (sin origin = app nativa/curl → sí). Reutilizado por el
// plugin CORS y por la ruta de streaming, que escribe headers a mano.
export function isOriginAllowed(origin?: string | null): boolean {
  if (!origin) return true
  if (corsOrigins.includes(origin)) return true
  try {
    const host = new URL(origin).hostname
    return corsOriginSuffixes.some((suf) => host.endsWith(suf) || host === suf.slice(1))
  } catch {
    return false
  }
}
