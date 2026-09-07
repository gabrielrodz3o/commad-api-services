import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const tools = readFileSync(new URL('../src/llm/tools.ts', import.meta.url), 'utf8')
const agent = readFileSync(new URL('../src/routes/agent.ts', import.meta.url), 'utf8')
const draft = readFileSync(new URL('../src/actions/accounting-journal-draft.ts', import.meta.url), 'utf8')

test('la IA consulta evidencia contable acotada por empresa', () => {
  assert.match(tools, /name: 'get_accounting_evidence'/)
  assert.match(tools, /business_unit_id: ctx\.businessUnitId/)
  assert.match(tools, /kind: args\.kind/)
  assert.match(tools, /identifier: args\.identifier/)
  assert.match(agent, /usa get_accounting_evidence después del reporte/)
})

test('las escrituras contables de IA continúan siendo solo propuestas de borrador', () => {
  assert.match(draft, /status_id: 1/)
  assert.match(draft, /source: 'COMANDI_AI'/)
  assert.match(tools, /PENDIENTE_DE_CONFIRMACION/)
})
