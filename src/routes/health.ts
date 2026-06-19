import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'

export function healthRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    let db = 'ok'
    try { await pool.query('SELECT 1') } catch { db = 'down' }
    return { service: 'comandi', status: 'ok', db, ts: new Date().toISOString() }
  })
}
