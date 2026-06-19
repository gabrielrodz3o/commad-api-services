// POST /comandi/voice  (multipart: file 'audio' + field 'payload' JSON)
// Nota de voz → transcripción (OpenAI) → corre el agente con ese texto.
// Claude NO transcribe audio: si la empresa usa Claude, se transcribe con la
// llave OpenAI global (fallback) y el chat sigue con su motor configurado.
import type { FastifyInstance } from 'fastify'
import OpenAI, { toFile } from 'openai'
import { resolveTenant } from '../lib/resolve.js'
import { TenantError } from '../db/tenant.js'
import { env } from '../config/env.js'
import { runBusinessAgent, AgentBody } from './agent.js'
import { AgentError } from '../llm/agent.js'

async function transcribe(apiKey: string, buffer: Buffer, filename: string): Promise<string> {
  const client = new OpenAI({ apiKey })
  const file = await toFile(buffer, filename || 'audio.m4a')
  const res: any = await client.audio.transcriptions.create({ file, model: 'whisper-1' })
  return String(res?.text || '').trim()
}

export function voiceRoutes(app: FastifyInstance) {
  app.post('/comandi/voice', async (req, reply) => {
    // ── Leer multipart (audio + payload JSON) ──
    let audioBuf: Buffer | null = null
    let filename = 'audio.m4a'
    let payloadRaw = ''
    try {
      for await (const part of (req as any).parts()) {
        if (part.type === 'file') { audioBuf = await part.toBuffer(); filename = part.filename || filename }
        else if (part.fieldname === 'payload') payloadRaw = String(part.value || '')
      }
    } catch {
      return reply.code(400).send({ success: false, message: 'Multipart inválido' })
    }
    if (!audioBuf || !audioBuf.length) return reply.code(400).send({ success: false, message: 'Falta el audio' })

    let payload: any = {}
    try { payload = payloadRaw ? JSON.parse(payloadRaw) : {} } catch { return reply.code(400).send({ success: false, message: 'payload no es JSON' }) }

    try {
      // Config de la empresa (para resolver la llave de transcripción).
      const { config } = await resolveTenant(payload, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const oaiKey = config.provider === 'openai' ? config.apiKey : (env.OPENAI_API_KEY || config.apiKey)
      if (!oaiKey) return reply.code(503).send({ success: false, message: 'Transcripción de voz no disponible (falta llave de OpenAI).' })

      const transcript = await transcribe(oaiKey, audioBuf, filename)
      if (!transcript) return { success: true, transcript: '', answer: 'No entendí el audio. ¿Puedes repetirlo?', tools_used: [], pending_action: null }

      // Corre el agente con el texto transcrito.
      const parsed = AgentBody.safeParse({ ...payload, question: transcript })
      if (!parsed.success) return reply.code(400).send({ success: false, message: 'Datos de contexto inválidos' })

      const out = await runBusinessAgent(parsed.data, req.actor)
      if (!out.enabled) return { success: true, enabled: false, transcript, message: 'Comandi no está activado para esta empresa.' }
      return { success: true, transcript, ...out }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof AgentError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: e?.message || 'Error procesando la nota de voz' })
    }
  })
}
