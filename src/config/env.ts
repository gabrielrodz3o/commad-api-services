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
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('❌ Variables de entorno inválidas:\n', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
