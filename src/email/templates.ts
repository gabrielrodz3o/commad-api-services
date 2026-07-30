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
  report: '#0b7285',  // reportes programados (teal ejecutivo)
}
const KIND_META: Record<string, { icon: string; label: string }> = {
  alert: { icon: '⚠', label: 'Alerta' },
  info: { icon: 'ℹ', label: 'Notificación' },
  report: { icon: '▣', label: 'Reporte' },
}
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`

/** Layout base premium (una sola columna, email-safe con tablas + inline styles). */
export function layout(opts: {
  kind?: 'alert' | 'info' | 'report'
  title: string
  subtitle?: string | null
  bodyHtml: string
  footerNote?: string | null
  cta?: { url: string; label: string } | null
}): string {
  const kind = opts.kind || 'info'
  const accent = ACCENT[kind]
  const meta = KIND_META[kind]
  const nowStr = new Date().toLocaleString('es-DO', { timeZone: 'America/Santo_Domingo', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
  const preheader = `${opts.title}${opts.subtitle ? ' · ' + opts.subtitle : ''}`
  const ctaHtml = opts.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px"><tr><td style="border-radius:8px;background:${accent}">
         <a href="${opts.cta.url}" target="_blank"
            style="display:inline-block;color:#ffffff;text-decoration:none;font-family:${FONT};font-size:14px;font-weight:700;padding:12px 24px">
           ${esc(opts.cta.label)} &rarr;</a>
       </td></tr></table>`
    : ''
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#eef1f4;font-family:${FONT};color:#1f2937">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f4;padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e3e7ec">
        <!-- barra de acento -->
        <tr><td style="height:4px;background:${accent};font-size:0;line-height:0">&nbsp;</td></tr>
        <!-- header -->
        <tr><td style="padding:22px 28px 6px">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
            <td valign="middle" style="width:44px">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" valign="middle"
                style="width:38px;height:38px;background:${accent}1a;border-radius:9px;color:${accent};font-size:18px;font-weight:700">${meta.icon}</td></tr></table>
            </td>
            <td valign="middle" style="padding-left:12px">
              <div style="font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#9aa4b2">ComandPOS · ${meta.label}</div>
              <div style="font-size:20px;font-weight:800;color:#111827;line-height:1.2;margin-top:2px">${esc(opts.title)}</div>
            </td>
          </tr></table>
          ${opts.subtitle ? `<div style="font-size:13px;color:#6b7280;margin-top:8px">${esc(opts.subtitle)}</div>` : ''}
        </td></tr>
        <!-- body -->
        <tr><td style="padding:18px 28px 26px">${opts.bodyHtml}${ctaHtml}</td></tr>
        <!-- footer -->
        <tr><td style="padding:16px 28px;background:#f7f9fb;border-top:1px solid #eceff3">
          <div style="color:#9aa4b2;font-size:11px;line-height:1.5">
            ${esc(opts.footerNote || 'Notificación automática de ComandPOS.')}<br>
            Generado el ${esc(nowStr)} · Configurable en Ajustes &rarr; Notificaciones.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

/**
 * Enlace accionable "Abrir en ComandPOS" según el evento. Requiere pos_base_url
 * configurado por la compañía. Devuelve null si no hay base o ruta clara.
 * Factura: /documents/<invoice_id> (pantalla real de factura del POS).
 */
export function buildPosCta(eventCode: string, payload: any, baseUrl?: string | null): { url: string; label: string } | null {
  if (!baseUrl) return null
  const base = baseUrl.replace(/\/+$/, '')
  const p = payload || {}
  const inv = p.invoice_id
  switch (eventCode) {
    case 'INVOICE_CANCELLED':
      return inv ? { url: `${base}/documents/${inv}`, label: 'Ver factura' } : null
    case 'INVOICE_MODIFIED':
      return inv ? { url: `${base}/documents/${inv}`, label: 'Ver factura' } : null
    default:
      return null
  }
}

/** Tarjeta clave→valor para los correos de alerta (con divisores hairline). */
export function kvTable(rows: Array<[string, string]>): string {
  const clean = rows.filter(([, v]) => v !== '' && v !== 'null' && v !== 'undefined' && v != null)
  const tr = clean.map(([k, v], i) => `<tr>
      <td style="padding:9px 14px 9px 0;color:#8a94a6;font-size:12px;white-space:nowrap;vertical-align:top;${i < clean.length - 1 ? 'border-bottom:1px solid #f0f2f5' : ''}">${esc(k)}</td>
      <td style="padding:9px 0;font-size:13px;color:#1f2937;vertical-align:top;${i < clean.length - 1 ? 'border-bottom:1px solid #f0f2f5' : ''}"><strong>${v}</strong></td>
    </tr>`).join('')
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"
     style="background:#fbfcfe;border:1px solid #eef1f5;border-radius:10px;padding:4px 16px">${tr}</table>`
}

/** Tabla de datos (reportes). headers + filas ya escapadas por el llamador con esc(). */
export function dataTable(headers: string[], rows: string[][], align: Array<'left' | 'right'> = []): string {
  const th = headers.map((h, i) =>
    `<th style="padding:9px 10px;background:#f2f5f8;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.3px;text-align:${align[i] || 'left'};border-bottom:1px solid #e3e7ec">${esc(h)}</th>`).join('')
  const trs = rows.map((r, ri) =>
    `<tr style="background:${ri % 2 ? '#fbfcfe' : '#ffffff'}">${r.map((c, i) =>
      `<td style="padding:9px 10px;font-size:12px;color:#374151;border-bottom:1px solid #f0f2f5;text-align:${align[i] || 'left'}">${c}</td>`).join('')}</tr>`).join('')
  return `<div style="overflow-x:auto;border:1px solid #eef1f5;border-radius:10px;margin-top:4px">
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse">
    <thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table></div>`
}

/** Banner de estado para alertas: pastilla de color + mensaje corto de contexto. */
export function statusBanner(kind: 'alert' | 'info' | 'report', text: string): string {
  const accent = ACCENT[kind]
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px">
    <tr><td style="background:${accent}0f;border-left:4px solid ${accent};border-radius:8px;padding:12px 16px;font-size:13px;color:#374151">${text}</td></tr>
  </table>`
}

/**
 * KPI hero: número grande destacado (venta neta) con contexto secundario.
 * Email-safe (tablas + inline styles).
 */
export function heroStat(opts: { label: string; value: string; context?: string; accent?: string }): string {
  const accent = opts.accent || '#2f9e44'
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px">
    <tr><td style="background:#f8fbf9;border:1px solid #e3f0e8;border-left:4px solid ${accent};border-radius:10px;padding:16px 20px">
      <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.5px">${esc(opts.label)}</div>
      <div style="font-size:30px;font-weight:800;color:#111827;line-height:1.1;margin-top:4px">${opts.value}</div>
      ${opts.context ? `<div style="font-size:12px;color:#6b7280;margin-top:6px">${opts.context}</div>` : ''}
    </td></tr></table>`
}

/**
 * Cuadrícula de indicadores (2 por fila, mobile-safe). Cada tile: etiqueta + valor.
 */
export function statTiles(tiles: Array<{ label: string; value: string; color?: string }>): string {
  const cell = (t?: { label: string; value: string; color?: string }) => t
    ? `<td width="50%" style="padding:6px">
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #eceff3;border-radius:10px">
           <tr><td style="padding:12px 14px">
             <div style="font-size:11px;color:#8a94a6;text-transform:uppercase;letter-spacing:.4px">${esc(t.label)}</div>
             <div style="font-size:18px;font-weight:700;color:${t.color || '#111827'};margin-top:3px">${t.value}</div>
           </td></tr>
         </table>
       </td>`
    : '<td width="50%" style="padding:6px"></td>'
  let rows = ''
  for (let i = 0; i < tiles.length; i += 2) {
    rows += `<tr>${cell(tiles[i])}${cell(tiles[i + 1])}</tr>`
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 -6px 8px">${rows}</table>`
}

/** Encabezado de sección con estilo (línea + título). */
export function sectionHead(text: string): string {
  return `<div style="margin:22px 0 8px;font-size:13px;font-weight:700;color:#374151;border-bottom:2px solid #eceff3;padding-bottom:6px">${esc(text)}</div>`
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
  /** URL base del POS para el botón "Abrir en ComandPOS". */
  posBaseUrl?: string | null
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
        ['Cuenta', `${esc(p.account_name || dash)} (ref. ${esc(p.account_id)})`],
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
        ['Cuenta', `${esc(p.account_name || dash)} (ref. ${esc(p.account_id)})`],
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
    NCF_RUNNING_OUT: () => {
      const agotado = Number(p.available) === 0
      const runway = p.runway_days == null ? null : Number(p.runway_days)
      const fmtD = (v: any) => v ? fmtDateTime(v).split(',')[0] : dash
      return {
        kind: 'alert' as const,
        rows: [
          ['Tipo de comprobante', `${esc(p.voucher_type)}${p.serie ? ` (serie ${esc(p.serie)}${p.serie === 'E' ? ' · e-CF' : ' · físico'})` : ''}`],
          ['Disponibles', `<span style="color:${agotado ? '#c92a2a' : '#e8590c'};font-size:16px;font-weight:800">${esc(p.available)}</span> comprobantes`],
          ['Autonomía estimada', agotado
            ? '<span style="color:#c92a2a;font-weight:700">AGOTADO — no se puede facturar</span>'
            : (runway != null ? `<span style="color:${p.severity === 'critical' ? '#c92a2a' : '#e8590c'};font-weight:700">~${runway} día${runway === 1 ? '' : 's'}</span>` : 'Sin consumo reciente')],
          ['Consumo (tasa diaria)', p.daily_rate ? `${esc(p.daily_rate)} / día` : dash],
          ['Fecha estimada de agotamiento', fmtD(p.depletion_date)],
          ['Próximo vencimiento de secuencia', fmtD(p.next_expiration) + (p.days_to_expiration != null ? ` (${esc(p.days_to_expiration)} día${Number(p.days_to_expiration) === 1 ? '' : 's'})` : '')],
          ['Riesgo de no facturar', Number(p.daily_amount_risk) > 0 ? `${money(p.daily_amount_risk)} / día` : dash],
          ['Acción requerida', agotado
            ? '<span style="color:#c92a2a">SOLICITAR NCF A DGII DE INMEDIATO</span>'
            : (p.serie === 'B' ? 'Solicitar nueva secuencia a DGII (los físicos tardan días en aprobarse)' : 'Solicitar nueva secuencia de e-CF a la DGII')],
        ],
      }
    },
    PLATFORM_ORDER_FAILED: () => ({
      kind: 'alert',
      rows: [
        ['Cliente', esc(p.customer_name || 'Sin nombre')],
        ['Teléfono', esc(p.phone || dash)],
        ['Dirección', esc(p.address || dash)],
        ['Tipo', esc(p.order_type || dash)],
        ['Artículos', p.items_count != null ? esc(p.items_count) : dash],
        ['Intentó', esc(p.attempted_by || 'N/D')],
        ['Origen', esc(p.context || p.flow || dash)],
        ['Error', `<span style="color:#c92a2a">${esc(p.error_message || 'Desconocido')}</span>`],
        ['Detalle técnico', esc(p.error_detail || dash)],
        ['Acción requerida', '<strong>Verificar si el pedido llegó a cocina; si no, tomarlo de nuevo con el cliente/teléfono de arriba.</strong>'],
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

  // Banner de estado con el resumen (una línea de contexto), arriba del detalle.
  const banner = p._body ? statusBanner(resolved.kind, esc(p._body)) : ''

  return {
    subject: `[${place}] ${title}`,
    html: layout({
      kind: resolved.kind,
      title,
      subtitle: place,
      bodyHtml: banner + kvTable(rows) + (resolved.extra || ''),
      cta: buildPosCta(ctx.eventCode, p, ctx.posBaseUrl),
    }),
  }
}

function sectionTitle(text: string): string {
  return sectionHead(text)
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
  eventCode?: string
  eventName: string
  place: string
  items: Array<{ payload?: any; title?: string; at?: string | null; body?: string | null }>
}): { subject: string; html: string } {
  const n = opts.items.length
  const at = (it: any) => (it.at ? fmtDateTime(it.at) : dash)
  let table: string
  const code = opts.eventCode

  // Columnas ricas según el tipo de evento (muestran quién, valor, motivo…).
  if (code === 'ORDER_ITEM_DELETED') {
    table = dataTable(
      ['Artículo', 'Valor', 'Cant.', 'Usuario', 'Motivo', 'Cuándo'],
      opts.items.map((it) => {
        const p = it.payload || {}
        return [
          esc(p.item_name || '—'), money(p.total_value), esc(p.quantity ?? '—'),
          esc(p.deleted_by || p.cancelled_by || 'N/D'), esc(p.reason || '—'), at(it),
        ]
      }),
      ['left', 'right', 'right', 'left', 'left', 'left'],
    )
  } else if (code === 'EMPLOYEE_DISCOUNT') {
    table = dataTable(
      ['Descuento', 'Cuenta', 'Autorizó', 'Motivo', 'Cuándo'],
      opts.items.map((it) => {
        const p = it.payload || {}
        return [
          `${money(p.total_discount)} (${esc(p.percent)}%)`,
          esc(p.table_name ? 'Mesa ' + p.table_name : p.account_name || '—'),
          esc(p.authorized_by_name || 'N/D'), esc(p.reason || '—'), at(it),
        ]
      }),
      ['right', 'left', 'left', 'left', 'left'],
    )
  } else if (code === 'DELIVERY_DELAYED' || code === 'ORDER_DELAYED') {
    table = dataTable(
      ['Orden', 'Cliente', 'Retraso', 'Estado', 'Cuándo'],
      opts.items.map((it) => {
        const p = it.payload || {}
        return [
          esc(p.order_code || p.account_name || '—'), esc(p.customer_name || '—'),
          `${esc(p.minutes)} min`, esc(p.status_name || '—'), at(it),
        ]
      }),
      ['left', 'left', 'right', 'left', 'left'],
    )
  } else {
    // Genérico: título + hora.
    table = dataTable(
      ['#', 'Detalle', 'Cuándo'],
      opts.items.map((it, i) => [String(i + 1), esc(it.title || it.payload?._title || opts.eventName), at(it)]),
      ['right', 'left', 'left'],
    )
  }

  const body =
    heroStat({ label: opts.eventName, value: `${n} <span style="font-size:15px;font-weight:600;color:#6b7280">notificación${n === 1 ? '' : 'es'}</span>`, context: 'Agrupadas para no saturar tu bandeja', accent: '#0b7285' }) +
    table
  return {
    subject: `[${opts.place}] ${opts.eventName}: ${n} notificación${n === 1 ? '' : 'es'}`,
    html: layout({ kind: 'info', title: `${opts.eventName} — resumen`, subtitle: opts.place, bodyHtml: body }),
  }
}

const dash = '—'
