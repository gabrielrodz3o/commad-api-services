// Motor AGÉNTICO de Comandi (tool-calling loop). El LLM PROPONE llamadas a
// herramientas; Comandi las EJECUTA (read-only por ahora) y le devuelve el
// resultado; el LLM puede encadenar varias y luego responde en lenguaje natural.
//
// El LLM nunca ejecuta nada: solo propone. Comandi dispone. Loop provider-agnóstico
// (OpenAI Chat Completions function-calling / Anthropic Messages tool-use).
import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import type { CompanyAIConfig } from '../db/tenant.js'
import { addUsage, type AIUsage } from './usage.js'

export interface Tool {
  name: string
  description: string
  input_schema: Record<string, any>
  run: (args: any) => Promise<any>
}

export interface AgentResult {
  answer: string
  steps: { tool: string; args: any }[]
  usage: AIUsage
}

export class AgentError extends Error { statusCode = 502 }

export interface HistoryTurn { role: 'user' | 'assistant'; content: string }

const MAX_STEPS = 6
const MAX_HISTORY = 8 // últimos N turnos (memoria conversacional acotada)

export async function runAgent(config: CompanyAIConfig, system: string, userMessage: string, tools: Tool[], history: HistoryTurn[] = []): Promise<AgentResult> {
  const steps: { tool: string; args: any }[] = []
  const byName = new Map(tools.map((t) => [t.name, t]))
  const hist = (history || [])
    .filter((h) => (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
    .slice(-MAX_HISTORY)

  const exec = async (name: string, args: any): Promise<string> => {
    steps.push({ tool: name, args })
    const tool = byName.get(name)
    if (!tool) return JSON.stringify({ error: `Herramienta desconocida: ${name}` })
    try {
      const result = await tool.run(args || {})
      return JSON.stringify(result ?? null)
    } catch (e: any) {
      return JSON.stringify({ error: e?.message || 'fallo ejecutando la herramienta' })
    }
  }

  const usage: AIUsage = { provider: config.provider, model: config.model, tokensIn: 0, tokensOut: 0 }

  try {
    const inner = config.provider === 'openai'
      ? await runOpenAI(config, system, userMessage, tools, exec, steps, hist, usage)
      : await runAnthropic(config, system, userMessage, tools, exec, steps, hist, usage)
    return { ...inner, usage }
  } catch (e: any) {
    console.error(`❌ Agent (${config.provider}/${config.model}):`, e?.message)
    throw new AgentError(`El motor de IA (${config.provider}) falló: ${e?.message || 'error'}`)
  }
}

// ── OpenAI (Chat Completions + function calling) ────────────────────────────
type InnerResult = { answer: string; steps: any[] }

async function runOpenAI(config: CompanyAIConfig, system: string, user: string, tools: Tool[], exec: (n: string, a: any) => Promise<string>, steps: any[], hist: HistoryTurn[], usage: AIUsage): Promise<InnerResult> {
  const client = new OpenAI({ apiKey: config.apiKey })
  const supportsTemp = config.model.startsWith('gpt-4o')
  const oaiTools = tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.input_schema } }))
  const messages: any[] = [
    { role: 'system', content: system },
    ...hist.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: user },
  ]

  for (let i = 0; i < MAX_STEPS; i++) {
    const res = await client.chat.completions.create({
      model: config.model,
      ...(supportsTemp ? { temperature: 0.2 } : {}),
      messages,
      tools: oaiTools,
      tool_choice: 'auto',
      max_completion_tokens: 2000,
    })
    addUsage(usage, res.usage)
    const msg = res.choices[0]?.message
    messages.push(msg)
    if (!msg?.tool_calls?.length) return { answer: msg?.content || '', steps }
    for (const tc of msg.tool_calls) {
      if (tc.type !== 'function') continue
      let args: any = {}
      try { args = JSON.parse(tc.function.arguments || '{}') } catch { /* args vacíos */ }
      const out = await exec(tc.function.name, args)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: out })
    }
  }
  return { answer: 'No pude terminar el análisis (límite de pasos).', steps }
}

// ── Anthropic (Messages + tool use) ─────────────────────────────────────────
async function runAnthropic(config: CompanyAIConfig, system: string, user: string, tools: Tool[], exec: (n: string, a: any) => Promise<string>, steps: any[], hist: HistoryTurn[], usage: AIUsage): Promise<InnerResult> {
  const client = new Anthropic({ apiKey: config.apiKey })
  const antTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as any }))
  const messages: any[] = [
    ...hist.map((h) => ({ role: h.role, content: h.content })),
    { role: 'user', content: user },
  ]

  for (let i = 0; i < MAX_STEPS; i++) {
    const res = await client.messages.create({ model: config.model, max_tokens: 2000, system, messages, tools: antTools })
    addUsage(usage, res.usage)
    messages.push({ role: 'assistant', content: res.content })
    if (res.stop_reason !== 'tool_use') {
      const answer = res.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim()
      return { answer, steps }
    }
    const toolResults: any[] = []
    for (const block of res.content.filter((b: any) => b.type === 'tool_use') as any[]) {
      const out = await exec(block.name, block.input)
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: out })
    }
    messages.push({ role: 'user', content: toolResults })
  }
  return { answer: 'No pude terminar el análisis (límite de pasos).', steps }
}
