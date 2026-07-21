import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'

export function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    let db = 'ok'
    try { await pool.query('SELECT 1') } catch { db = 'down' }
    return { service: 'comandi', status: 'ok', db, ts: new Date().toISOString() }
  })
  app.get('/ready', async (_req,reply) => { try { await pool.query('SELECT 1'); return {service:'command-api-services',status:'ready'} } catch { return reply.code(503).send({service:'command-api-services',status:'not_ready'}) } })
}
