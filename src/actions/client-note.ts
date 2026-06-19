// Acción piloto: agregar una NOTA a un cliente (texto puro, reversible/soft-delete).
// El agente propone { client, body }; prepare() resuelve el cliente por nombre/id
// dentro de la empresa y arma el resumen; execute() la guarda vía el core.
import { registerAction, type PrepareResult } from './registry.js'
import type { ActionContext } from './context.js'
import { findEntities } from '../db/entities.js'
import { fetchFromCore } from '../core/client.js'

registerAction({
  type: 'add_client_note',
  description:
    'Agrega una nota de texto al expediente de un CLIENTE (ej. "recordarle que debe RD$X", "prefiere entrega en la tarde"). Úsala cuando el usuario pida dejar/anotar algo sobre un cliente. Pasa el nombre del cliente en "client" (o su id) y el texto en "body". NO ejecuta nada: solo propone; el usuario confirma.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['client', 'body'],
    properties: {
      client: { type: 'string', description: 'Nombre del cliente (o su id numérico).' },
      body: { type: 'string', description: 'Texto de la nota.' },
    },
  },

  async prepare(args: any, ctx: ActionContext): Promise<PrepareResult> {
    const body = String(args?.body ?? '').trim()
    if (!body) return { ok: false, message: 'La nota no puede estar vacía.' }
    if (!ctx.businessUnitId) return { ok: false, message: 'No se pudo determinar la empresa.' }

    const hits = await findEntities(ctx.businessUnitId, String(args?.client ?? ''))
    if (!hits.length) return { ok: false, message: `No encontré ningún cliente que coincida con "${args?.client}".` }
    if (hits.length > 1) {
      const opts = hits.map((h) => `${h.name} (id ${h.id})`).join(', ')
      return { ok: false, message: `Hay varios clientes posibles: ${opts}. ¿Cuál? (puedes pasar el id).` }
    }
    const client = hits[0]
    return {
      ok: true,
      payload: { entity_id: client.id, entity_name: client.name, body, note_type: 'client', business_unit_id: ctx.businessUnitId },
      summary: `Agregar nota al cliente "${client.name}": “${body}”`,
    }
  },

  async execute(payload: any, _ctx: ActionContext): Promise<any> {
    const res = await fetchFromCore<{ success: boolean; message?: string; data?: any }>(
      '/api/restaurant/client/notes',
      {
        entity_id: payload.entity_id,
        note_type: payload.note_type || 'client',
        body: payload.body,
        business_unit_id: payload.business_unit_id,
      },
    )
    if (!res?.success) throw new Error(res?.message || 'El core rechazó la nota')
    return { note_id: res.data?.id, client: payload.entity_name, body: payload.body }
  },
})
