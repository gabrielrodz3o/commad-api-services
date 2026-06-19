// Comandi — servicio satélite de IA para ComandPOS.
// Orquesta el LLM (OpenAI/Claude por empresa) anclado en datos reales de Postgres.
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { env, corsOrigins } from './config/env.js'
import { registerAuth } from './plugins/auth.js'
import { healthRoutes } from './routes/health.js'
import { askRoutes } from './routes/ask.js'
import { insightsRoutes } from './routes/insights.js'
import { agentRoutes } from './routes/agent.js'

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

healthRoutes(app)
askRoutes(app)
insightsRoutes(app)
agentRoutes(app)

app.get('/', async () => ({ service: 'comandi', message: 'Comandi service up' }))

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' })
  console.log(`🤖 Comandi escuchando en http://0.0.0.0:${env.PORT}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
