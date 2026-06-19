// Pool de Postgres de SOLO LECTURA para Comandi.
// El satélite lee config y datos; NUNCA escribe datos de negocio (a lo sumo logs).
import pg from 'pg'
import { env } from '../config/env.js'

export const pool = new pg.Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_DATABASE,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
})

pool.on('error', (err) => {
  console.error('❌ Error inesperado en el pool de Postgres:', err.message)
})

/** Helper tipado para queries. */
export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(sql, params)
  return res.rows as T[]
}
