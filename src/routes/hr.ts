// Inteligencia de RRHH (acciones de empleo):
//   POST /comandi/hr/action-letter       → redacta la carta/acta formal de una acción registrada
//   POST /comandi/hr/action-propose      → interpreta una instrucción en lenguaje natural y propone
//                                          la acción estructurada (propose→confirm: NUNCA ejecuta;
//                                          el core valida y el usuario confirma en el formulario)
//   POST /comandi/hr/explain-liquidation → explica la estimación de liquidación (Código de Trabajo RD)
//
// El CORE arma el contexto (RBAC pantalla+ámbito, datos reales del empleado) y aquí
// solo se resuelve tenant/llave BYO-key y se corre el LLM. El match de nombres →
// ids de catálogo (depto/cargo/turno/sucursal) también vive en el core (pg_trgm).
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { locationFields, resolveTenant } from '../lib/resolve.js'
import { TenantError } from '../db/tenant.js'
import { generateText, generateJSON, LLMError } from '../llm/provider.js'

// ── Carta de acción ──────────────────────────────────────────────────────────

const LetterBody = z.object({
  ...locationFields,
  context: z.object({
    today: z.string(),
    company: z.object({ name: z.string().nullish(), business_unit: z.string().nullish() }),
    author: z.string().nullish(),
    employee: z.object({
      fullname: z.string(),
      employee_code: z.string().nullish(),
      job_title: z.string().nullish(),
      department: z.string().nullish(),
      location: z.string().nullish(),
      hire_date: z.string().nullish(),
      monthly_salary: z.number().nullish(),
    }),
    action: z.object({
      code: z.string().nullish(),
      description: z.string(),
      reason: z.string().nullish(),
      detail: z.string().nullish(),
      effective_date: z.string(),
      salary: z.number().nullish(),
      previous_salary: z.number().nullish(),
      notes: z.string().nullish(),
    }),
  }),
})

const LETTER_SYSTEM = `Eres un redactor senior de Recursos Humanos en República Dominicana.
Redactas la COMUNICACIÓN FORMAL (carta) que corresponde a una acción de personal ya registrada,
lista para imprimir en papel timbrado y firmar.

Reglas:
- Español formal dominicano. SOLO texto plano: nada de markdown, asteriscos ni numerales.
- Estructura: ciudad y fecha (usa la fecha de hoy del contexto), destinatario (el empleado con su
  cargo), asunto en mayúsculas, cuerpo, despedida, y bloques de firma al final
  ("Por la empresa" con el nombre de la empresa y "Recibido por" con el nombre del empleado,
  cada uno con su línea de firma "_____________________" y fecha).
- El TONO y CONTENIDO dependen del tipo de acción:
  · Vacaciones: notificación del disfrute (fecha de inicio efectiva) conforme al Art. 177+ del Código de Trabajo.
  · Cambio de remuneración: notificación del ajuste salarial (monto anterior → nuevo, fecha efectiva).
  · Traslado / cambio de datos: notificación del movimiento (nueva sucursal/departamento/cargo/turno).
  · Suspensión / amonestación: constancia disciplinaria seria, mencionando la razón y el derecho del
    empleado a presentar sus descargos.
  · Baja (terminación): comunicación de término de la relación laboral, indicando que las prestaciones
    laborales que apliquen se pagarán conforme al Código de Trabajo (NO inventes montos).
  · Permiso / licencia / incapacidad: constancia del período otorgado.
- Usa ÚNICAMENTE los datos del contexto. Si falta un dato necesario (ej. fecha de retorno),
  deja el espacio "[____]" para completar a mano. NO inventes cédulas, montos ni fechas.
- Extensión: una página como máximo.`

// ── Propuesta de acción desde lenguaje natural ───────────────────────────────

const ProposeBody = z.object({
  ...locationFields,
  instruction: z.string().min(3).max(600),
  context: z.object({
    today: z.string(),
    employee: z.object({
      fullname: z.string(),
      job_title: z.string().nullish(),
      department: z.string().nullish(),
      location: z.string().nullish(),
      shift: z.string().nullish(),
      monthly_salary: z.number().nullish(),
    }),
    allowed_actions: z.array(z.object({ id: z.coerce.number().int(), code: z.string().nullish(), description: z.string() })).min(1).max(30),
    reasons: z.array(z.object({ id: z.coerce.number().int(), action_id: z.coerce.number().int(), description: z.string() })).max(200),
  }),
})

const PROPOSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    employee_action_id: { type: ['integer', 'null'], description: 'id de la acción elegida de la lista allowed_actions, o null si la instrucción no corresponde a ninguna acción permitida.' },
    employee_action_reason_id: { type: ['integer', 'null'], description: 'id de una razón de la lista reasons QUE PERTENEZCA a la acción elegida (mismo action_id), o null si ninguna encaja claramente.' },
    effective_date: { type: ['string', 'null'], description: 'Fecha efectiva YYYY-MM-DD resuelta contra la fecha de hoy (ej. "desde el lunes" → fecha concreta). null si no se menciona.' },
    salary: { type: ['number', 'null'], description: 'Nuevo salario MENSUAL en DOP si la instrucción lo indica ("85 mil" = 85000). Solo para cambio de remuneración. null si no aplica.' },
    department_name: { type: ['string', 'null'], description: 'Nombre del departamento destino mencionado, tal cual se entiende. null si no aplica.' },
    job_title_name: { type: ['string', 'null'], description: 'Nombre del cargo destino mencionado. null si no aplica.' },
    shift_name: { type: ['string', 'null'], description: 'Nombre del turno destino mencionado. null si no aplica.' },
    location_name: { type: ['string', 'null'], description: 'Nombre de la sucursal destino mencionada. null si no aplica.' },
    notes: { type: ['string', 'null'], description: 'Detalle libre de la instrucción que valga la pena dejar como observación de la acción. null si nada.' },
    confidence: { type: 'number', description: 'Confianza 0 a 1 en la interpretación.' },
    message: { type: 'string', description: 'Una frase para el usuario: qué se entendió y qué falta por completar (o por qué no se pudo proponer).' },
  },
  required: ['employee_action_id', 'employee_action_reason_id', 'effective_date', 'salary', 'department_name', 'job_title_name', 'shift_name', 'location_name', 'notes', 'confidence', 'message'],
} as const

const PROPOSE_SYSTEM = `Eres un analista de Recursos Humanos dominicano. Recibes una instrucción en
lenguaje natural sobre UN empleado y la conviertes en una acción de personal ESTRUCTURADA.

Reglas:
- Elige la acción SOLO de la lista allowed_actions (ids exactos; no inventes). Si la instrucción pide
  algo que no está permitido en el estado actual del empleado, employee_action_id=null y explica en message.
- La razón debe ser de la lista reasons y pertenecer a la acción elegida (mismo action_id).
- Resuelve fechas relativas contra la fecha de hoy dada ("el 1ro del mes que viene", "desde mañana").
- Montos: interpreta expresiones dominicanas ("85 mil" = 85000, "quince mil quinientos" = 15500). El
  salario es MENSUAL en DOP.
- NO ejecutas nada: es una propuesta que un humano revisará campo por campo antes de registrar.
- Si la instrucción trae información extra útil (motivo detallado, referencia), ponla en notes.`

// ── Recibo de descargo y finiquito (liquidación) ─────────────────────────────

const DischargeBody = z.object({
  ...locationFields,
  context: z.object({
    today: z.string(),
    company: z.object({ name: z.string().nullish(), business_unit: z.string().nullish() }),
    employee: z.object({
      fullname: z.string(),
      employee_code: z.string().nullish(),
      job_title: z.string().nullish(),
      hire_date: z.string().nullish(),
    }),
    termination: z.object({
      effective_date: z.string(),
      reason: z.string().nullish(),
    }),
    amounts: z.object({
      notice: z.object({ days: z.number(), amount: z.number() }),
      severance: z.object({ days: z.number(), amount: z.number() }),
      regalia_pascual: z.object({ amount: z.number() }),
      vacation: z.object({ days: z.number(), amount: z.number() }),
      pending_salary: z.number(),
      total: z.number(),
    }),
  }),
})

const DISCHARGE_SYSTEM = `Eres un abogado laboralista dominicano que redacta el RECIBO DE DESCARGO Y
FINIQUITO LEGAL que firma un trabajador al recibir el pago de sus prestaciones laborales
(Art. 669 del Código de Trabajo de la República Dominicana).

Reglas:
- SOLO texto plano: nada de markdown, asteriscos ni numerales. Español jurídico dominicano claro.
- Estructura: título "RECIBO DE DESCARGO Y FINIQUITO LEGAL"; identificación del trabajador (nombre,
  código de empleado si viene, cargo, cédula como "[____]" porque NO viene en el contexto); declaración
  de que recibió de la empresa el monto TOTAL en pago de sus prestaciones laborales por la terminación
  del contrato (menciona la causa si viene y las fechas de ingreso y salida); DESGLOSE de los conceptos
  y montos exactos del contexto (preaviso con sus días, cesantía con sus días, regalía pascual
  proporcional, vacaciones con sus días, salario pendiente — OMITE los conceptos en 0); declaración de
  descargo: que no le queda nada pendiente por reclamar por esos ni ningún otro concepto (salarios,
  horas extras, comisiones, etc.) y que otorga formal descargo y finiquito legal conforme al Art. 669;
  lugar y fecha de firma (usa la fecha de hoy del contexto); bloques de firma: el trabajador
  (nombre y línea), por la empresa (nombre de la empresa y línea) y dos testigos con líneas "[____]".
- Usa ÚNICAMENTE los datos y montos del contexto; NO inventes cédulas, montos ni fechas. Los montos
  escríbelos en formato RD$ con dos decimales, y el total también en LETRAS.
- Extensión: una página.`

// ── Explicación de liquidación ───────────────────────────────────────────────

const ExplainBody = z.object({
  ...locationFields,
  context: z.object({
    employee: z.object({ fullname: z.string(), hire_date: z.string().nullish(), monthly_salary: z.number().nullish() }),
    effective_date: z.string(),
    years_of_service: z.number(),
    daily_wage: z.number(),
    notice: z.object({ days: z.number(), amount: z.number() }),
    severance: z.object({ days: z.number(), amount: z.number() }),
    vacation: z.object({ days: z.number(), amount: z.number() }).nullish(),
    regalia_pascual: z.object({ amount: z.number() }),
    total_liquidation: z.number(),
    cause: z.string().nullish(),
  }),
})

const EXPLAIN_SYSTEM = `Eres un experto en derecho laboral dominicano (Código de Trabajo, Ley 16-92).
Explicas a un encargado de RRHH, en lenguaje claro y texto plano (sin markdown), CÓMO se llegó a la
estimación de liquidación que se te da. Reglas:
- Usa ÚNICAMENTE los números del contexto; no recalcules ni inventes montos.
- Cita los artículos: preaviso Art. 76, cesantía Art. 80, vacaciones Art. 177, salario de Navidad
  (regalía) Arts. 219-222. Explica la banda de días que aplicó según la antigüedad.
- Aclara SIEMPRE que es una ESTIMACIÓN y que el derecho a preaviso y cesantía depende de la causa de
  terminación: el desahucio los paga; el despido justificado (Art. 88) no los paga; la dimisión
  justificada (Art. 96) sí. Menciona la causa dada si viene en el contexto.
- Máximo ~220 palabras.`

export function hrRoutes(app: FastifyInstance) {
  // ── Carta formal de una acción ─────────────────────────────────────────────
  app.post('/comandi/hr/action-letter', async (req, reply) => {
    const parsed = LetterBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Datos inválidos', errors: parsed.error.flatten() })

    try {
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const userId = req.actor?.type === 'user' ? req.actor.userId : null
      const letter = await generateText({
        config,
        system: LETTER_SYSTEM,
        user: `Redacta la carta correspondiente a esta acción de personal.\n\nContexto (JSON):\n${JSON.stringify(parsed.data.context, null, 2)}`,
        maxTokens: 1600,
        usageMeta: { businessUnitId, userId, endpoint: 'hr-action-letter' },
      })
      return { success: true, enabled: true, letter: (letter || '').trim() }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof LLMError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error redactando la carta' })
    }
  })

  // ── Propuesta estructurada desde lenguaje natural ──────────────────────────
  app.post('/comandi/hr/action-propose', async (req, reply) => {
    const parsed = ProposeBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Datos inválidos', errors: parsed.error.flatten() })

    try {
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const { context, instruction } = parsed.data
      const userId = req.actor?.type === 'user' ? req.actor.userId : null
      const result = await generateJSON<any>({
        config,
        system: PROPOSE_SYSTEM,
        user: `Fecha de hoy: ${context.today}\n\nEmpleado:\n${JSON.stringify(context.employee, null, 2)}\n\nAcciones permitidas en su estado actual (allowed_actions):\n${context.allowed_actions.map((a) => `${a.id}: ${a.description}${a.code ? ` (${a.code})` : ''}`).join('\n')}\n\nRazones disponibles (reasons — id: [action_id] descripción):\n${context.reasons.map((r) => `${r.id}: [${r.action_id}] ${r.description}`).join('\n')}\n\nInstrucción del usuario:\n"""${instruction}"""`,
        schema: PROPOSE_SCHEMA,
        schemaName: 'hr_action_proposal',
        maxTokens: 700,
        usageMeta: { businessUnitId, userId, endpoint: 'hr-action-propose' },
      })

      // Blindaje: ids deben existir en las listas enviadas y ser coherentes entre sí.
      const action = context.allowed_actions.find((a) => a.id === result?.employee_action_id) || null
      const reason = action ? (context.reasons.find((r) => r.id === result?.employee_action_reason_id && r.action_id === action.id) || null) : null
      return {
        success: true,
        enabled: true,
        proposal: {
          employee_action_id: action?.id ?? null,
          employee_action_reason_id: reason?.id ?? null,
          effective_date: /^\d{4}-\d{2}-\d{2}$/.test(String(result?.effective_date || '')) ? result.effective_date : null,
          salary: Number(result?.salary) > 0 ? Number(result.salary) : null,
          department_name: result?.department_name || null,
          job_title_name: result?.job_title_name || null,
          shift_name: result?.shift_name || null,
          location_name: result?.location_name || null,
          notes: result?.notes || null,
          confidence: Math.max(0, Math.min(1, Number(result?.confidence) || 0)),
          message: result?.message || '',
        },
      }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof LLMError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error interpretando la instrucción' })
    }
  })

  // ── Recibo de descargo y finiquito legal ───────────────────────────────────
  app.post('/comandi/hr/discharge-receipt', async (req, reply) => {
    const parsed = DischargeBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Datos inválidos', errors: parsed.error.flatten() })

    try {
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const userId = req.actor?.type === 'user' ? req.actor.userId : null
      const receipt = await generateText({
        config,
        system: DISCHARGE_SYSTEM,
        user: `Redacta el recibo de descargo para esta liquidación.\n\nContexto (JSON):\n${JSON.stringify(parsed.data.context, null, 2)}`,
        maxTokens: 1800,
        usageMeta: { businessUnitId, userId, endpoint: 'hr-discharge-receipt' },
      })
      return { success: true, enabled: true, receipt: (receipt || '').trim() }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof LLMError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error redactando el recibo de descargo' })
    }
  })

  // ── Explicación de la estimación de liquidación ────────────────────────────
  app.post('/comandi/hr/explain-liquidation', async (req, reply) => {
    const parsed = ExplainBody.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ success: false, message: 'Datos inválidos', errors: parsed.error.flatten() })

    try {
      const { businessUnitId, config } = await resolveTenant(parsed.data, req.actor)
      if (!config) return { success: true, enabled: false, message: 'Comandi no está activado para esta empresa.' }

      const userId = req.actor?.type === 'user' ? req.actor.userId : null
      const explanation = await generateText({
        config,
        system: EXPLAIN_SYSTEM,
        user: `Explica esta estimación de liquidación.\n\nContexto (JSON):\n${JSON.stringify(parsed.data.context, null, 2)}`,
        maxTokens: 700,
        usageMeta: { businessUnitId, userId, endpoint: 'hr-explain-liquidation' },
      })
      return { success: true, enabled: true, explanation: (explanation || '').trim() }
    } catch (e: any) {
      if (e instanceof TenantError) return reply.code(e.statusCode).send({ success: false, message: e.message })
      if (e instanceof LLMError) return reply.code(502).send({ success: false, message: e.message })
      req.log.error(e)
      return reply.code(500).send({ success: false, message: 'Error explicando la liquidación' })
    }
  })
}
