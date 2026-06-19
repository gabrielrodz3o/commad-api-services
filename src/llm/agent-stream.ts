// Variante STREAMING del motor agéntico. Emite eventos a medida que el LLM genera:
//   emit('status', { tool })  → empezó a ejecutar una herramienta
//   emit('token',  { text })  → fragmento del texto final (UX token-a-token)
// Devuelve {answer, steps, usage}. El 'done' lo emite la ruta (con pending_action).
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import type { CompanyAIConfig } from '../db/tenant.js'
import type { Tool, HistoryTurn } from './agent.js'
import { AgentError } from './agent.js'
import { addUsage, type AIUsage } from './usage.js'

export type StreamEmit = (event: string, data: any) => void
export interface StreamResult { answer: string; steps: { tool: string; args: any }[]; usage: AIUsage }

const MAX_STEPS = 6
const MAX_HISTORY = 8

export async function runAgentStream(
  config: CompanyAIConfig, system: string, userMessage: string, tools: Tool[], history: HistoryTurn[], emit: StreamEmit,
): Promise<StreamResult> {
  const steps: { tool: string; args: any }[] = []
  const byName = new Map(tools.map((t) => [t.name, t]))
  const hist = (history || [])
    .filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
    .slice(-MAX_HISTORY)
  const usage: AIUsage = { provider: config.provider, model: config.model, tokensIn: 0, tokensOut: 0 }

  const exec = async (name: string, args: any): Promise<string> => {
    steps.push({ tool: name, args })
    emit('status', { tool: name })
    const tool = byName.get(name)
    if (!tool) return JSON.stringify({ error: `Herramienta desconocida: ${name}` })
    try {
      return JSON.stringify((await tool.run(args || {})) ?? null)
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || 'fallo ejecutando la herramienta' })
    }
  }

  try {
    const answer = config.provider === 'openai'
      ? await streamOpenAI(config, system, userMessage, tools, exec, hist, usage, emit)
      : await streamAnthropic(config, system, userMessage, tools, exec, hist, usage, emit)
    return { answer, steps, usage }
  } catch (e: any) {
    console.error(`❌ AgentStream (${config.provider}/${config.model}):`, e?.message)
    throw new AgentError(`El motor de IA (${config.provider}) falló: ${e?.message || 'error'}`)
  }
}

// ── OpenAI (Chat Completions streaming + function calling) ──────────────────
async function streamOpenAI(config: CompanyAIConfig, system: string, user: string, tools: Tool[], exec: (n: string, a: any) => Promise<string>, hist: HistoryTurn[], usage: AIUsage, emit: StreamEmit): Promise<string> {
  const client = new OpenAI({ apiKey: config.apiKey })
  const supportsTemp = config.model.startsWith('gpt-4o')
  const oaiTools = tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }))
  const messages: any[] = [
    { role: 'system', content: system },
    ...hist.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: user },
  ]

  for (let i = 0; i < MAX_STEPS; i++) {
    const stream = await client.chat.completions.create({
      model: config.model,
      ...(supportsTemp ? { temperature: 0.2 } : {}),
      messages,
      tools: oaiTools,
      tool_choice: 'auto',
      max_completion_tokens: 2000,
      stream: true,
      stream_options: { include_usage: true },
    })

    let content = ''
    const acc: Record<number, { id: string; name: string; args: string }> = {}
    for await (const chunk of stream) {
      if (chunk.usage) addUsage(usage, chunk.usage)
      const d = chunk.choices[0]?.delta as any
      if (!d) continue
      if (d.content) { content += d.content; emit('token', { text: d.content }) }
      for (const tc of d.tool_calls || []) {
        const slot = (acc[tc.index] ||= { id: '', name: '', args: '' })
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name = tc.function.name
        if (tc.function?.arguments) slot.args += tc.function.arguments
      }
    }

    const toolCalls = Object.values(acc).filter((t) => t.name)
    if (!toolCalls.length) return content
    messages.push({ role: 'assistant', content: content || null, tool_calls: toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args || '{}' } })) })
    for (const t of toolCalls) {
      let args: any = {}
      try { args = JSON.parse(t.args || '{}') } catch { /* vacío */ }
      const out = await exec(t.name, args)
      messages.push({ role: 'tool', tool_call_id: t.id, content: out })
    }
  }
  return 'No pude terminar el análisis (límite de pasos).'
}

// ── Anthropic (Messages streaming + tool use) ───────────────────────────────
async function streamAnthropic(config: CompanyAIConfig, system: string, user: string, tools: Tool[], exec: (n: string, a: any) => Promise<string>, hist: HistoryTurn[], usage: AIUsage, emit: StreamEmit): Promise<string> {
  const client = new Anthropic({ apiKey: config.apiKey })
  const antTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as any }))
  const messages: any[] = [
    ...hist.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: user },
  ]

  for (let i = 0; i < MAX_STEPS; i++) {
    const stream = client.messages.stream({ model: config.model, max_tokens: 2000, system, messages, tools: antTools })
    stream.on('text', (t: string) => emit('token', { text: t }))
    const final = await stream.finalMessage()
    addUsage(usage, final.usage)
    messages.push({ role: 'assistant', content: final.content })
    if (final.stop_reason !== 'tool_use') {
      return final.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim()
    }
    const toolResults: any[] = []
    for (const block of final.content.filter((b: any) => b.type === 'tool_use') as any[]) {
      const out = await exec(block.name, block.input)
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out })
    }
    messages.push({ role: 'user', content: toolResults })
  }
  return 'No pude terminar el análisis (límite de pasos).'
}
