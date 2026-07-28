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

interface EventContext {
  eventCode: string
  eventName: string
  business: string
  location: string | null
  payload: any
}

export function renderEventEmail(ctx: EventContext): { subject: string; html: string } {
  const p = ctx.payload || {}
  const place = ctx.location ? `${ctx.business} — ${ctx.location}` : ctx.business
  const title = p._title || ctx.eventName

  const base: Record<string, () => { kind: 'alert' | 'info'; rows: Array<[string, string]> }> = {
    BOX_SHIFT_CLOSE: () => ({
      kind: 'info',
      rows: [
        ['Caja', esc(p.box_name)],
        ['Cerró', esc(p.closed_by)],
        ['Total contado', money(p.total_closed)],
        ['Diferencia', p.difference ? money(p.difference) : 'Cuadrada ✔'],
      ],
    }),
    BOX_CASH_VARIANCE: () => ({
      kind: 'alert',
      rows: [
        ['Caja', esc(p.box_name)],
        ['Cerró', esc(p.closed_by)],
        ['Diferencia', `${Number(p.difference) > 0 ? 'SOBRANTE' : 'FALTANTE'} ${money(Math.abs(Number(p.difference) || 0))}`],
        ['Total contado', money(p.total_closed)],
      ],
    }),
    EMPLOYEE_DISCOUNT: () => ({
      kind: 'alert',
      rows: [
        ['Descuento total', money(p.total_discount)],
        ['Porcentaje máx.', `${esc(p.percent)}%`],
        ['Artículos', esc(p.items_count)],
        ['Autorizó', esc(p.authorized_by_name || 'N/D')],
        ['Motivo', esc(p.reason || '—')],
        ['Cuenta', esc(p.account_id)],
      ],
    }),
    INVOICE_CANCELLED: () => ({
      kind: 'alert',
      rows: [
        ['Factura', `#${esc(p.invoice_number)}`],
        ['Monto', money(p.total_amount)],
        ['Anuló', esc(p.cancelled_by)],
        ['Motivo', esc(p.reason || '—')],
      ],
    }),
    ORDER_ITEM_DELETED: () => ({
      kind: 'alert',
      rows: [
        ['Artículo', esc(p.item_name)],
        ['Cantidad', esc(p.quantity ?? '—')],
        ['Orden', esc(p.order_code || p.order_id)],
        ['Usuario', esc(p.deleted_by || p.cancelled_by || 'N/D')],
        ['Motivo', esc(p.reason || '—')],
        ['Inventario devuelto', p.return_inventory ? 'Sí' : 'No'],
      ],
    }),
    INVOICE_MODIFIED: () => ({
      kind: 'alert',
      rows: p.scope === 'payment_cancelled'
        ? [
            ['Cambio', 'Pago anulado'],
            ['Factura', `#${esc(p.invoice_number)}`],
            ['Monto del pago', money(p.amount)],
            ['Usuario', esc(p.modified_by || 'N/D')],
          ]
        : [
            ['Cambio', 'Corrección de cierre de caja'],
            ['Entrada de caja', `#${esc(p.box_entry_id)}`],
            ['Contado', `${esc(p.previous_counted)} → ${esc(p.new_counted)}`],
            ['Δ dinero', money(p.money_delta)],
            ['Tipo', esc(p.adjustment_type)],
            ['Nota', esc(p.notes || '—')],
          ],
    }),
    STOCK_COUNT_CLOSED: () => ({
      kind: 'info',
      rows: [
        ['Sesión', `#${esc(p.session_id)}`],
        ['Ítems contados', esc(p.items_counted)],
        ['Con varianza', esc(p.items_with_variance)],
        ['Valor del ajuste', money(p.total_variance_value)],
      ],
    }),
    DELIVERY_DELAYED: () => ({
      kind: 'alert',
      rows: [
        ['Orden', esc(p.order_code || p.account_id)],
        ['Cliente', esc(p.customer_name || '—')],
        ['Minutos transcurridos', esc(p.minutes)],
        ['Umbral', `${esc(p.threshold)} min`],
        ['Estado', esc(p.status_name || '—')],
      ],
    }),
    ORDER_DELAYED: () => ({
      kind: 'alert',
      rows: [
        ['Orden', esc(p.order_code || p.order_id)],
        ['Minutos en preparación', esc(p.minutes)],
        ['Umbral', `${esc(p.threshold)} min`],
        ['Estado', esc(p.status_name || '—')],
      ],
    }),
  }

  const def = base[ctx.eventCode]
  const { kind, rows } = def
    ? def()
    : { kind: 'info' as const, rows: Object.entries(p).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, esc(v)] as [string, string]) }

  // Extra: top varianzas en el correo de conteo
  let extra = ''
  if (ctx.eventCode === 'STOCK_COUNT_CLOSED' && Array.isArray(p.top_variance_items) && p.top_variance_items.length) {
    extra = `<div style="margin-top:16px;font-size:13px;font-weight:bold;color:#495057">Mayores varianzas</div>` +
      dataTable(
        ['Ítem', 'Teórico', 'Contado', 'Varianza', 'Valor'],
        p.top_variance_items.slice(0, 10).map((i: any) => [
          esc(i.item_name), esc(i.theoretical_qty), esc(i.counted_qty), esc(i.variance_qty), money(i.variance_value),
        ]),
        ['left', 'right', 'right', 'right', 'right'],
      )
  }

  return {
    subject: `[${place}] ${title}`,
    html: layout({
      kind,
      title,
      subtitle: place,
      bodyHtml: kvTable(rows) + extra + (p._body ? `<div style="margin-top:14px;font-size:13px;color:#495057">${esc(p._body)}</div>` : ''),
    }),
  }
}
