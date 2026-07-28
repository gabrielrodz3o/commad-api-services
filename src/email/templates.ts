// Templates HTML de los correos de notificación. Sin motor externo: funciones
// template-literal (estilo minimalista del repo). Todo dato dinámico pasa por
// esc() — los payloads traen texto libre (motivos, nombres, notas).

export function esc(v: any): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function money(v: any): string {
  const n = Number(v) || 0
  return `RD$${n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const ACCENT: Record<string, string> = {
  alert: '#d9480f',   // alertas operativas (anulación, borrado, diferencia)
  info: '#1971c2',    // informativos (cierre de caja, conteo)
  report: '#2f9e44',  // reportes programados
}

/** Layout base responsive (una sola columna, safe para clientes de correo). */
export function layout(opts: {
  kind?: 'alert' | 'info' | 'report'
  title: string
  subtitle?: string | null
  bodyHtml: string
  footerNote?: string | null
}): string {
  const accent = ACCENT[opts.kind || 'info']
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#212529">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e9ecef">
        <tr><td style="background:${accent};padding:18px 24px">
          <div style="color:#ffffff;font-size:18px;font-weight:bold">${esc(opts.title)}</div>
          ${opts.subtitle ? `<div style="color:rgba(255,255,255,.85);font-size:13px;margin-top:4px">${esc(opts.subtitle)}</div>` : ''}
        </td></tr>
        <tr><td style="padding:24px">${opts.bodyHtml}</td></tr>
        <tr><td style="padding:14px 24px;background:#f8f9fa;border-top:1px solid #e9ecef">
          <div style="color:#868e96;font-size:11px">
            ${esc(opts.footerNote || 'Notificación automática de ComandPOS — configurable en Ajustes → Notificaciones.')}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

/** Tabla clave→valor para los correos de alerta. */
export function kvTable(rows: Array<[string, string]>): string {
  const tr = rows
    .filter(([, v]) => v !== '' && v !== 'null' && v !== 'undefined')
    .map(([k, v]) => `<tr>
      <td style="padding:6px 12px 6px 0;color:#868e96;font-size:13px;white-space:nowrap;vertical-align:top">${esc(k)}</td>
      <td style="padding:6px 0;font-size:13px"><strong>${v}</strong></td>
    </tr>`)
    .join('')
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%">${tr}</table>`
}

/** Tabla de datos (reportes). headers + filas ya escapadas por el llamador con esc(). */
export function dataTable(headers: string[], rows: string[][], align: Array<'left' | 'right'> = []): string {
  const th = headers.map((h, i) =>
    `<th style="padding:8px;background:#f1f3f5;font-size:12px;color:#495057;text-align:${align[i] || 'left'};border-bottom:2px solid #dee2e6">${esc(h)}</th>`).join('')
  const trs = rows.map((r) =>
    `<tr>${r.map((c, i) =>
      `<td style="padding:7px 8px;font-size:12px;border-bottom:1px solid #f1f3f5;text-align:${align[i] || 'left'}">${c}</td>`).join('')}</tr>`).join('')
  return `<div style="overflow-x:auto"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
    <thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`
}

// ─────────────────────────────────────────────────────────────────────────────
// Render por tipo de evento realtime/watcher (los reportes scheduled tienen sus
// propios renders en src/email/reports/*).
// ─────────────────────────────────────────────────────────────────────────────

const TZ = 'America/Santo_Domingo'

export function fmtDateTime(v: any): string {
  if (!v) return '—'
  try {
    return new Date(v).toLocaleString('es-DO', {
      timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
    })
  } catch { return String(v) }
}

interface EventContext {
  eventCode: string
  eventName: string
  business: string
  location: string | null
  payload: any
  /** Momento en que ocurrió el evento (created_at del outbox). */
  occurredAt?: string | null
}

export function renderEventEmail(ctx: EventContext): { subject: string; html: string } {
  const p = ctx.payload || {}
  const place = ctx.location ? `${ctx.business} — ${ctx.location}` : ctx.business
  const title = p._title || ctx.eventName
  const dash = '—'

  const base: Record<string, () => { kind: 'alert' | 'info'; rows: Array<[string, string]>; extra?: string }> = {
    BOX_SHIFT_CLOSE: () => ({
      kind: 'info',
      rows: [
        ['Caja', esc(p.box_name)],
        ['Cerró', esc(p.closed_by || dash)],
        ['Turno', `${fmtDateTime(p.opened_at)} → ${fmtDateTime(p.closed_at)}`],
        ['Total contado', money(p.total_closed)],
        ['Diferencia', Math.abs(Number(p.difference) || 0) >= 0.01
          ? `<span style="color:#d9480f">${money(p.difference)}</span>`
          : '<span style="color:#2f9e44">Cuadrada ✔</span>'],
      ],
      extra: currenciesTable(p.currencies),
    }),
    BOX_CASH_VARIANCE: () => ({
      kind: 'alert',
      rows: [
        ['Caja', esc(p.box_name)],
        ['Cerró', esc(p.closed_by || dash)],
        ['Turno', `${fmtDateTime(p.opened_at)} → ${fmtDateTime(p.closed_at)}`],
        ['Diferencia', `<span style="color:#c92a2a;font-size:15px">${Number(p.difference) > 0 ? 'SOBRANTE' : 'FALTANTE'} ${money(Math.abs(Number(p.difference) || 0))}</span>`],
        ['Total contado', money(p.total_closed)],
      ],
      extra: currenciesTable(p.currencies),
    }),
    EMPLOYEE_DISCOUNT: () => ({
      kind: 'alert',
      rows: [
        ['Descuento total', `<span style="font-size:15px">${money(p.total_discount)}</span> (${esc(p.percent)}% máx.)`],
        ['Subtotal antes del descuento', money(p.subtotal_before)],
        ['Cuenta', esc(p.table_name ? `Mesa ${p.table_name}` : p.account_name || `#${p.account_id}`)],
        ['Mesero', esc(p.waiter_name || dash)],
        ['Autorizó', esc(p.authorized_by_name || 'N/D')],
        ['Motivo', esc(p.reason || dash)],
      ],
      extra: Array.isArray(p.items) && p.items.length
        ? sectionTitle(`Artículos descontados (${p.items.length})`) + dataTable(
            ['Artículo', 'Cant.', 'Precio', 'Descuento', '%'],
            p.items.map((i: any) => [
              esc(i.name), esc(i.quantity), money(i.price), money(i.discount_amount), `${esc(i.percent)}%`,
            ]),
            ['left', 'right', 'right', 'right', 'right'],
          )
        : '',
    }),
    INVOICE_CANCELLED: () => ({
      kind: 'alert',
      rows: [
        ['Factura', `#${esc(p.invoice_number)}${p.invoice_ncf ? ` · NCF ${esc(p.invoice_ncf)}` : ''}`],
        ['Monto', `<span style="font-size:15px">${money(p.total_amount)}</span>`],
        ['Cliente', `${esc(p.client_name || 'Consumidor final')}${p.client_document ? ` (${esc(p.client_document)})` : ''}`],
        ['Emitida', `${fmtDateTime(p.emitted_at)}${p.emitted_by ? ` por ${esc(p.emitted_by)}` : ''}`],
        ['Anuló', esc(p.cancelled_by || 'N/D')],
        ['Motivo', esc(p.reason || dash)],
      ],
    }),
    ORDER_ITEM_DELETED: () => ({
      kind: 'alert',
      rows: [
        ['Artículo', esc(p.item_name)],
        ['Cantidad × precio', `${esc(p.quantity ?? dash)} × ${money(p.unit_price)}`],
        ['Valor perdido', `<span style="color:#c92a2a;font-size:15px">${money(p.total_value)}</span>`],
        ['Orden', `${esc(p.order_code || p.order_id)}${p.order_type ? ` · ${esc(p.order_type)}` : ''}`],
        ['Cuenta', esc(p.table_name ? `Mesa ${p.table_name}` : p.account_name || dash)],
        ['Mesero', esc(p.waiter_name || dash)],
        ['Ordenado', fmtDateTime(p.order_created_at)],
        ['Borró', esc(p.deleted_by || p.cancelled_by || 'N/D')],
        ['Motivo', esc(p.reason || dash)],
        ['Inventario devuelto', p.return_inventory ? 'Sí' : 'No'],
        ['Nota del artículo', esc(p.item_note || dash)],
      ],
    }),
    INVOICE_MODIFIED: () => ({
      kind: 'alert',
      rows: p.scope === 'payment_cancelled'
        ? [
            ['Cambio', 'Pago anulado'],
            ['Factura', `#${esc(p.invoice_number)}${p.invoice_ncf ? ` · NCF ${esc(p.invoice_ncf)}` : ''} (total ${money(p.invoice_total)})`],
            ['Cliente', esc(p.client_name || 'Consumidor final')],
            ['Pago anulado', `<span style="font-size:15px">${money(p.amount)}</span> · ${esc(p.payment_type || 'N/D')}`],
            ['Pagado originalmente', fmtDateTime(p.paid_at)],
            ['Anuló', esc(p.modified_by || 'N/D')],
          ]
        : [
            ['Cambio', 'Corrección de cierre de caja'],
            ['Entrada de caja', `#${esc(p.box_entry_id)}`],
            ['Contado', `${esc(p.previous_counted)} → ${esc(p.new_counted)}`],
            ['Δ dinero', money(p.money_delta)],
            ['Tipo', esc(p.adjustment_type)],
            ['Nota', esc(p.notes || dash)],
          ],
    }),
    STOCK_COUNT_CLOSED: () => ({
      kind: 'info',
      rows: [
        ['Almacén', esc(p.warehouse_name || `Sesión #${p.session_id}`)],
        ['Cerró', esc(p.closed_by || dash)],
        ['Ítems contados', esc(p.items_counted)],
        ['Con varianza', esc(p.items_with_variance)],
        ['Valor del ajuste', `<span style="font-size:15px;color:${Number(p.total_variance_value) < 0 ? '#c92a2a' : '#2f9e44'}">${money(p.total_variance_value)}</span>`],
        ['Nota', esc(p.note || dash)],
      ],
      extra: (Array.isArray(p.variance_by_category) && p.variance_by_category.length
        ? sectionTitle('Varianza por categoría') + dataTable(
            ['Categoría', 'Ítems', 'Con varianza', 'Valor'],
            p.variance_by_category.map((c: any) => [
              esc(c.category_name || 'Sin categoría'), esc(c.total_items), esc(c.items_with_variance), money(c.total_variance_value),
            ]),
            ['left', 'right', 'right', 'right'],
          )
        : '') +
        (Array.isArray(p.top_variance_items) && p.top_variance_items.length
          ? sectionTitle('Mayores varianzas') + dataTable(
              ['Ítem', 'Teórico', 'Contado', 'Varianza', 'Valor'],
              p.top_variance_items.slice(0, 10).map((i: any) => [
                esc(i.item_name), esc(i.theoretical_qty), esc(i.counted_qty), esc(i.variance_qty), money(i.variance_value),
              ]),
              ['left', 'right', 'right', 'right', 'right'],
            )
          : ''),
    }),
    DELIVERY_DELAYED: () => ({
      kind: 'alert',
      rows: [
        ['Orden', esc(p.order_code || p.account_name || `#${p.account_id}`)],
        ['Cuenta', esc(p.account_name || dash)],
        ['Retraso', `<span style="color:#c92a2a;font-size:15px">${esc(p.minutes)} min</span> (umbral ${esc(p.threshold)} min)`],
        ['Estado actual', esc(p.status_name || dash)],
        ['Cliente', esc(p.customer_name || dash)],
        ['Teléfono', esc(p.customer_phone || dash)],
        ['Dirección', esc(p.address || dash)],
        ['Motorista', esc(p.driver_name || 'Sin asignar')],
        ['Monto de la orden', money(p.total_amount)],
        ['Ordenado', esc(p.ordered_at || dash)],
      ],
    }),
    ORDER_DELAYED: () => ({
      kind: 'alert',
      rows: [
        ['Orden', esc(p.order_code || p.account_name || `#${p.account_id}`)],
        ['Cuenta', esc(p.account_name || dash)],
        // Identificador de plataforma (Uber Eats / PedidosYa) cuando aplica.
        ...(p.platform ? [['Plataforma', `${esc(p.platform)}${p.platform_order_id ? ' · pedido #' + esc(p.platform_order_id) : ''}`] as [string, string]] : []),
        ['Retraso', `<span style="color:#c92a2a;font-size:15px">${esc(p.minutes)} min</span> (umbral ${esc(p.threshold)} min)`],
        ['Estado actual', esc(p.status_name || dash)],
        ['Cliente', esc(p.customer_name || dash)],
        ['Teléfono', esc(p.customer_phone || dash)],
        ['Monto de la orden', money(p.total_amount)],
        ['Ordenado', esc(p.ordered_at || dash)],
      ],
    }),
    NCF_RUNNING_OUT: () => ({
      kind: 'alert',
      rows: [
        ['Tipo de comprobante', esc(p.voucher_type)],
        ['Disponibles', `<span style="color:${Number(p.remaining) <= 0 ? '#c92a2a' : '#e8590c'};font-size:16px;font-weight:bold">${esc(p.remaining)}</span> (umbral: ${esc(p.threshold)})`],
        ['Próximo vencimiento de secuencia', p.next_expiration ? fmtDateTime(p.next_expiration).split(',')[0] : dash],
        ['Acción requerida', Number(p.remaining) <= 0
          ? '<span style="color:#c92a2a">SOLICITAR NCF A DGII DE INMEDIATO — no se puede facturar este tipo</span>'
          : 'Solicitar nueva secuencia de NCF a la DGII antes de que se agoten'],
      ],
    }),
    PLATFORM_ORDER_FAILED: () => ({
      kind: 'alert',
      rows: [
        ['Origen', esc(p.context || p.flow || dash)],
        ['Cuenta/Orden', esc(p.account_id || dash)],
        ['Usuario', esc(p.user_name || dash)],
        ['Error', `<span style="color:#c92a2a">${esc(p.error_message || 'Desconocido')}</span>`],
        ['Acción requerida', 'Verificar si el pedido del cliente llegó a cocina; si no, reprocesarlo manualmente'],
      ],
    }),
    COURTESY_HIGH: () => ({
      kind: 'alert',
      rows: [
        ['Total en cortesías hoy', `<span style="color:#e8590c;font-size:15px">${money(p.amount)}</span> (umbral ${money(p.threshold)})`],
        ['Cortesías registradas', esc(p.courtesies)],
      ],
      extra: Array.isArray(p.top) && p.top.length
        ? sectionTitle('Mayores cortesías del día') + dataTable(
            ['Monto', 'Autorizó', 'Mesero', 'Motivo'],
            p.top.map((t: any) => [money(t.amount), esc(t.authorized_by_fullname || dash), esc(t.waiter_fullname || dash), esc(t.reason || dash)]),
            ['right', 'left', 'left', 'left'],
          )
        : '',
    }),
    WASTE_HIGH: () => ({
      kind: 'alert',
      rows: [
        ['Costo total de mermas hoy', `<span style="color:#c92a2a;font-size:15px">${money(p.amount)}</span> (umbral ${money(p.threshold)})`],
        ['Registros de merma', esc(p.wastes)],
        ['Acción sugerida', 'Revisar el detalle en Inventario → Mermas y validar causas'],
      ],
    }),
    CUSTOMER_DELINQUENT: () => ({
      kind: 'alert',
      rows: [
        ['Cliente', `${esc(p.client_name)}${p.client_document ? ` (${esc(p.client_document)})` : ''}`],
        ['Factura', `#${esc(p.invoice_number)}`],
        ['Saldo pendiente', `<span style="color:#c92a2a;font-size:15px">${money(p.pending)}</span>`],
        ['Emitida', fmtDateTime(p.emitted_at)],
        ['Venció', `${fmtDateTime(p.expire_at).split(',')[0]} — lleva más de 30 días vencida (MOROSA)`],
        ['Acción sugerida', 'Gestionar cobro / evaluar suspensión de crédito'],
      ],
    }),
    PIN_FAILED_ATTEMPTS: () => ({
      kind: 'alert',
      rows: [
        ['Intentos fallidos', `<span style="color:#c92a2a;font-size:16px;font-weight:bold">${esc(p.attempts)}</span> en ${esc(p.window_minutes)} minutos (umbral ${esc(p.threshold)})`],
        ['PIN incorrecto', esc(p.wrong_pin)],
        ['PIN válido sin perfil autorizado', esc(p.no_profile)],
        ['PIN válido sin acceso a la sucursal', esc(p.no_access)],
        ['Posible causa', 'Alguien intentando adivinar un PIN de supervisor — verificar cámaras/personal en turno'],
      ],
    }),
  }

  const def = base[ctx.eventCode]
  const resolved = def
    ? def()
    : { kind: 'info' as const, rows: Object.entries(p).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, esc(v)] as [string, string]), extra: '' }

  // Fila estándar: cuándo ocurrió el evento (todas las alertas la llevan)
  const rows: Array<[string, string]> = [
    ...resolved.rows,
    ['Fecha del evento', fmtDateTime(ctx.occurredAt)],
  ]

  return {
    subject: `[${place}] ${title}`,
    html: layout({
      kind: resolved.kind,
      title,
      subtitle: place,
      bodyHtml: kvTable(rows) + (resolved.extra || '') + (p._body ? `<div style="margin-top:14px;font-size:13px;color:#495057">${esc(p._body)}</div>` : ''),
    }),
  }
}

function sectionTitle(text: string): string {
  return `<div style="margin-top:16px;margin-bottom:4px;font-size:13px;font-weight:bold;color:#495057">${esc(text)}</div>`
}

/** Desglose por moneda de un cierre de caja. */
function currenciesTable(currencies: any): string {
  if (!Array.isArray(currencies) || !currencies.length) return ''
  return sectionTitle('Desglose por moneda') + dataTable(
    ['Moneda', 'Apertura', 'Esperado', 'Contado', 'Diferencia'],
    currencies.map((c: any) => [
      esc(c.currency || dashSafe(c.currency)), money(c.opened), money(c.expected), money(c.counted),
      Math.abs(Number(c.difference) || 0) >= 0.01
        ? `<span style="color:${Number(c.difference) > 0 ? '#e8590c' : '#c92a2a'}">${money(c.difference)}</span>`
        : '<span style="color:#2f9e44">✔</span>',
    ]),
    ['left', 'right', 'right', 'right', 'right'],
  )
}

function dashSafe(v: any): string { return v == null || v === '' ? '—' : String(v) }

/**
 * Correo digest: agrupa N eventos del mismo tipo en un solo mensaje (anti-spam).
 * Lista cada evento con su título y hora, para eventos ruidosos (ítems borrados,
 * descuentos, retrasos) que de otro modo mandarían un correo por cada uno.
 */
export function renderDigestEmail(opts: {
  eventName: string
  place: string
  items: Array<{ title: string; at?: string | null; body?: string | null }>
}): { subject: string; html: string } {
  const n = opts.items.length
  const rows = opts.items.map((it, i) => [
    String(i + 1),
    esc(it.title || opts.eventName),
    it.at ? fmtDateTime(it.at) : dash,
  ])
  const body =
    `<div style="font-size:14px;margin-bottom:6px">Se agruparon <strong>${n}</strong> notificaciones de «${esc(opts.eventName)}» para no saturar tu bandeja:</div>` +
    dataTable(['#', 'Detalle', 'Cuándo'], rows, ['right', 'left', 'left'])
  return {
    subject: `[${opts.place}] ${opts.eventName}: ${n} notificaciones agrupadas`,
    html: layout({ kind: 'info', title: `${opts.eventName} — resumen`, subtitle: opts.place, bodyHtml: body }),
  }
}

const dash = '—'
