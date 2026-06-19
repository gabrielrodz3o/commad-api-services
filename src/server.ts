// Comandi — servicio satélite de IA para ComandPOS.
// Orquesta el LLM (OpenAI/Claude por empresa) anclado en datos reales de Postgres.
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { env, corsOrigins } from './config/env.js'
import { registerAuth } from './plugins/auth.js'
import { healthRoutes } from './routes/health.js'
import { askRoutes } from './routes/ask.js'
import { insightsRoutes } from './routes/insights.js'
import { agentRoutes } from './routes/agent.js'
import { actionRoutes } from './routes/action.js'
import { telegramRoutes } from './routes/telegram.js'
import { startTelegramPoller } from './telegram/poller.js'

const app = Fastify({
  logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
  bodyLimit: 5 * 1024 * 1024, // reportes pueden venir grandes
})

await app.register(cors, {
  origin: corsOrigins.length ? corsOrigins : false,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-service-token'],
})

registerAuth(app)

// Rate-limit: protege las llaves de IA (BYO-key) de abuso. El token de servicio
// (core/satélites) no se limita; usuarios y anónimos sí, por identidad o IP.
await app.register(rateLimit, {
  max: 40,
  timeWindow: '1 minute',
  allowList: (req) => req.actor?.type === 'service',
  keyGenerator: (req) => (req.actor?.type === 'user' ? `u:${req.actor.userId}` : (req.ip || 'anon')),
  errorResponseBuilder: () => ({ success: false, message: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' }),
})

healthRoutes(app)
askRoutes(app)
insightsRoutes(app)
agentRoutes(app)
actionRoutes(app)
telegramRoutes(app)

app.get('/', async () => ({ service: 'comandi', message: 'Comandi service up' }))

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' })
  console.log(`🤖 Comandi escuchando en http://0.0.0.0:${env.PORT}`)
  // Canal Telegram (long-polling) si hay token configurado. No bloquea el arranque.
  void startTelegramPoller()
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
