// Base de conocimiento del negocio (RAG).
//   POST /comandi/knowledge        (JWT) { title?, content }  → ingesta (embed + guarda)
//   POST /comandi/knowledge/list   (JWT)                       → lista documentos
//   POST /comandi/knowledge/delete (JWT) { id }                → borra uno
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { locationFields, resolveTenant } from '../lib/resolve.js'
import { TenantError } from '../db/tenant.js'
import { embed } from '../context/embeddings.js'
import { addKnowledge, listKnowledge, deleteKnowledge } from '../db/knowledge.js'

export function knowledgeRoutes(app: FastifyInstance) {
  const Ingest = z.object({ ...locationFields, title: z.string().max(200).optional(), content: z.string().min(3).max(20000) })
  app.post('/comandi/knowledge', async (req, reply) => {
    const parsed = Ingest.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Falta el contenido' })
    try {
      const { businessUnitId } = await resolveTenant(parsed.data, req.actor)
      const userId = req.actor?.type === 'user' ? req.actor.userId : null
      const vec = await embed(`${parsed.data.title || ''}\n${parsed.data.content}`, businessUnitId)
      const id = await addKnowledge(businessUnitId, parsed.data.title || null, parsed.data.content, vec, userId)
      return { success: true, id }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: e?.message || 'Error guardando el documento' })
    }
  })

  app.post('/comandi/knowledge/list', async (req, reply) => {
    const parsed = z.object({ ...locationFields }).safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Body inválido' })
    try {
      const { businessUnitId } = await resolveTenant(parsed.data, req.actor)
      return { success: true, items: await listKnowledge(businessUnitId) }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      return reply.code(500).send({ success: false, message: 'Error' })
    }
  })

  app.post('/comandi/knowledge/delete', async (req, reply) => {
    const parsed = z.object({ ...locationFields, id: z.string().uuid() }).safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Falta id' })
    try {
      const { businessUnitId } = await resolveTenant(parsed.data, req.actor)
      await deleteKnowledge(businessUnitId, parsed.data.id)
      return { success: true }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      return reply.code(500).send({ success: false, message: 'Error' })
    }
  })
}
