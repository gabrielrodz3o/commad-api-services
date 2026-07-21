// Auth de Comandi. Dos identidades válidas:
//   1) Token de servicio (core proxy / otros satélites) → confianza total (ya hizo RBAC).
//   2) JWT de usuario (frontend directo) → validado con el JWT_SECRET del core;
//      luego las rutas aplican RBAC (que el usuario tenga acceso a esas sucursales).
import type { FastifyInstance } from 'fastify'
import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

export type Actor = { type: 'service' } | { type: 'user'; userId: number }

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor
  }
}

export function registerAuth(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS') return // preflight CORS
    if (req.url === '/health' || req.url === '/ready' || req.url === '/' || req.url.startsWith('/v1/mobile/')) return

    const header = req.headers['authorization'] || ''
    const token = header.startsWith('Bearer ')
      ? header.slice(7)
      : (req.headers['x-service-token'] as string) || ''

    if (!token) return reply.code(401).send({ success: false, message: 'No autorizado' })

    // 1) Token de servicio (server-to-server).
    if (token === env.COMANDI_SERVICE_TOKEN) {
      req.actor = { type: 'service' }
      return
    }

    // 2) JWT de usuario (frontend directo).
    if (env.JWT_SECRET) {
      try {
        const decoded = jwt.verify(token, env.JWT_SECRET) as any
        if (decoded?.userId) {
          req.actor = { type: 'user', userId: Number(decoded.userId) }
          return
        }
      } catch {
        /* cae al 401 de abajo */
      }
    }

    return reply.code(401).send({ success: false, message: 'No autorizado' })
  })
}
