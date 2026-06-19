// Registro de ACCIONES DE ESCRITURA que Comandi puede proponer y, tras confirmación,
// ejecutar contra el CORE (el core hace el write real + su propio audit de negocio).
//
// Flujo: el agente llama la tool propose_<type> → prepare() valida + resuelve ids
// + arma el resumen legible → se guarda 'proposed' con token → el usuario confirma
// → execute() llama al core. Nada de negocio se muta sin confirmación.
import type { ActionContext } from './context.js'

// prepare() puede pedir aclaración (cliente ambiguo, falta dato) sin proponer nada.
export type PrepareResult =
  | { ok: true; payload: Record<string, any>; summary: string }
  | { ok: false; message: string }

export interface ActionDef {
  type: string
  description: string                   // para el LLM: cuándo y cómo usarla
  input_schema: Record<string, any>     // lo que el LLM propone
  prepare: (args: any, ctx: ActionContext) => Promise<PrepareResult>
  execute: (payload: any, ctx: ActionContext) => Promise<any> // llama al core
}

export const ACTIONS: Record<string, ActionDef> = {}

export function registerAction(def: ActionDef): void {
  ACTIONS[def.type] = def
}
export function getActionDef(type: string): ActionDef | null {
  return ACTIONS[type] ?? null
}
export function listActions(): ActionDef[] {
  return Object.values(ACTIONS)
}
