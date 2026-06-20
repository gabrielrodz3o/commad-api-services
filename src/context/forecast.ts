// Pronóstico simple de ventas: promedio por DÍA DE SEMANA de las últimas 8 semanas,
// proyectado a los próximos 7 días. Lee finances.invoices (read-only). Sin ML pesado:
// es explicable y suficiente para planificar compras/preparación.
import { query } from '../db/pool.js'

const DOW = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']

export async function salesForecast(locationIds: number[]): Promise<any> {
  if (!locationIds.length) return { error: 'sin sucursales' }
  const rows = await query<{ dow: number; dias: number; ventas: number }>(
    `SELECT EXTRACT(DOW FROM emission_date)::int AS dow,
            COUNT(DISTINCT emission_date::date)::int AS dias,
            COALESCE(SUM(total_amount * currency_rate), 0)::float8 AS ventas
       FROM finances.invoices
      WHERE invoice_type_id = 2 AND status_id = 1
        AND location_id = ANY($1)
        AND emission_date::date >= current_date - interval '56 days'
        AND emission_date::date < current_date
      GROUP BY 1`,
    [locationIds],
  )
  const avgByDow = new Map<number, number>()
  for (const r of rows) avgByDow.set(r.dow, r.dias > 0 ? r.ventas / r.dias : 0)

  const proximos: { fecha: string; dia: string; esperado: number }[] = []
  let total = 0
  for (let i = 1; i <= 7; i++) {
    const d = new Date()
    d.setDate(d.getDate() + i)
    const dow = d.getDay()
    const esperado = Math.round((avgByDow.get(dow) || 0) * 100) / 100
    total += esperado
    proximos.push({ fecha: d.toISOString().slice(0, 10), dia: DOW[dow], esperado })
  }
  return {
    metodo: 'Promedio por día de semana (últimas 8 semanas).',
    promedio_diario: Math.round((total / 7) * 100) / 100,
    total_proxima_semana: Math.round(total * 100) / 100,
    proximos_7_dias: proximos,
  }
}
