import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import multipart from '@fastify/multipart'
import { env, isOriginAllowed } from './config/env.js'
import { registerAuth } from './plugins/auth.js'
import { healthRoutes } from './routes/health.js'
import { askRoutes } from './routes/ask.js'
import { insightsRoutes } from './routes/insights.js'
import { agentRoutes } from './routes/agent.js'
import { actionRoutes } from './routes/action.js'
import { voiceRoutes } from './routes/voice.js'
import { usageRoutes } from './routes/usage.js'
import { watchdogRoutes } from './routes/watchdog.js'
import { knowledgeRoutes } from './routes/knowledge.js'
import { pushRoutes } from './routes/push.js'
import { telegramRoutes } from './routes/telegram.js'
import { mobileRoutes } from './modules/mobile/routes.js'


export async function buildApp() {
  const app = Fastify({ logger: { level: env.LOG_LEVEL }, bodyLimit: 5 * 1024 * 1024, trustProxy: true, genReqId: (req) => String(req.headers['x-request-id'] || crypto.randomUUID()) })
  await app.register(cors, { origin: (origin, cb) => cb(null, isOriginAllowed(origin)), methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'x-service-token', 'idempotency-key', 'x-request-id'], exposedHeaders: ['x-request-id'] })
  registerAuth(app)
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 10 } })
  await app.register(rateLimit, { max: 60, timeWindow: '1 minute', allowList: (req) => req.actor?.type === 'service', keyGenerator: (req) => req.actor?.type === 'user' ? `u:${req.actor.userId}` : req.ip, errorResponseBuilder: () => ({ success: false, code: 'RATE_LIMITED', message: 'Demasiadas solicitudes.' }) })
  app.setErrorHandler((error, req, reply) => { const err = error as any; const status = Math.min(599, Math.max(400, Number(err.statusCode) || 500)); if (status >= 500) req.log.error({ err }, 'request failed'); reply.code(status).send({ success: false, code: err.code || 'REQUEST_FAILED', message: status >= 500 ? 'Error interno del servidor' : String(err.message || 'Solicitud inválida'), request_id: req.id }) })
  app.addHook('onSend', async (req, reply, payload) => { reply.header('x-request-id', req.id); return payload })
  healthRoutes(app); askRoutes(app); insightsRoutes(app); agentRoutes(app); actionRoutes(app); voiceRoutes(app); usageRoutes(app); watchdogRoutes(app); knowledgeRoutes(app); pushRoutes(app); telegramRoutes(app); mobileRoutes(app)
  app.get('/', async () => ({ service: 'command-api-services', status: 'ok', environment: env.APP_ENV }))
  return app
}
