// Capa de abstracción del LLM (LLMProvider). Cambiar de proveedor sin tocar la
// lógica. Sin LangChain — SDKs oficiales.
//
//   generateText  → respuesta de texto libre (chat / resumen)
//   generateJSON  → respuesta estructurada validada contra un JSON Schema
//
// OpenAI  → Responses API (text.format json_schema para JSON)
// Claude  → Messages API (tool forzado para JSON)
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import type { CompanyAIConfig } from '../db/tenant.js'
import { addUsage, type AIUsage, type UsageMeta } from './usage.js'
import { logUsage } from '../db/usage-log.js'

export class LLMError extends Error {
  statusCode = 502
}

export interface TextOpts {
  config: CompanyAIConfig
  system: string
  user: string
  maxTokens?: number
  // Si viene, se registra el consumo en comandi.usage_log (costo por empresa).
  usageMeta?: UsageMeta
}

/** Registra el consumo de una llamada al LLM si se pidió (fire-and-forget). */
function record(opts: TextOpts, raw: any): void {
  if (!opts.usageMeta) return
  const usage: AIUsage = { provider: opts.config.provider, model: opts.config.model, tokensIn: 0, tokensOut: 0 }
  addUsage(usage, raw)
  logUsage(opts.usageMeta, usage)
}

export interface JsonOpts extends TextOpts {
  schema: Record<string, any>
  schemaName?: string
}

export async function generateText(opts: TextOpts): Promise<string> {
  const { config, system, user } = opts
  const maxTokens = opts.maxTokens ?? 1200
  try {
    if (config.provider === 'openai') {
      const client = new OpenAI({ apiKey: config.apiKey })
      const isGpt5 = config.model.startsWith('gpt-5')
      const supportsTemp = config.model.startsWith('gpt-4o')
      const res = await client.responses.create({
        model: config.model,
        ...(supportsTemp ? { temperature: 0.3 } : {}),
        ...(isGpt5 ? { reasoning: { effort: 'low' as const } } : {}),
        max_output_tokens: maxTokens,
        input: [
          { role: 'system', content: [{ type: 'input_text', text: system }] },
          { role: 'user', content: [{ type: 'input_text', text: user }] },
        ],
      })
      record(opts, res.usage)
      return res.output_text || ''
    }
    const client = new Anthropic({ apiKey: config.apiKey })
    const msg = await client.messages.create({
      model: config.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    })
    record(opts, msg.usage)
    return msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim()
  } catch (e: any) {
    console.error(`❌ LLM text (${config.provider}/${config.model}):`, e?.message)
    throw new LLMError(`El motor de IA (${config.provider}) falló: ${e?.message || 'error'}`)
  }
}

export async function generateJSON<T = any>(opts: JsonOpts): Promise<T> {
  const { config, system, user, schema } = opts
  const schemaName = opts.schemaName || 'structured_response'
  const maxTokens = opts.maxTokens ?? 4096
  try {
    if (config.provider === 'openai') {
      const client = new OpenAI({ apiKey: config.apiKey })
      const isGpt5 = config.model.startsWith('gpt-5')
      const supportsTemp = config.model.startsWith('gpt-4o')
      const res = await client.responses.create({
        model: config.model,
        ...(supportsTemp ? { temperature: 0.2 } : {}),
        ...(isGpt5 ? { reasoning: { effort: 'low' as const } } : {}),
        max_output_tokens: maxTokens,
        text: { format: { type: 'json_schema', name: schemaName, strict: true, schema: schema as any } },
        input: [
          { role: 'system', content: [{ type: 'input_text', text: system }] },
          { role: 'user', content: [{ type: 'input_text', text: user }] },
        ],
      })
      const raw = res.output_text
      if (!raw) throw new Error('Respuesta vacía (OpenAI)')
      record(opts, res.usage)
      return JSON.parse(raw) as T
    }
    const client = new Anthropic({ apiKey: config.apiKey })
    const msg = await client.messages.create({
      model: config.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [{ name: 'emit_result', description: 'Devuelve el resultado estructurado requerido.', input_schema: schema as any }],
      tool_choice: { type: 'tool', name: 'emit_result' },
    })
    const block = msg.content.find((b: any) => b.type === 'tool_use') as any
    if (!block) throw new Error('Sin tool_use (Claude)')
    record(opts, msg.usage)
    return block.input as T
  } catch (e: any) {
    console.error(`❌ LLM json (${config.provider}/${config.model}):`, e?.message)
    throw new LLMError(`El motor de IA (${config.provider}) falló: ${e?.message || 'error'}`)
  }
}
