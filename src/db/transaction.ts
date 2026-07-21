import type { PoolClient } from 'pg'
import { pool } from './pool.js'
export async function transaction<T>(run:(client:PoolClient)=>Promise<T>):Promise<T>{const client=await pool.connect();try{await client.query('BEGIN');const value=await run(client);await client.query('COMMIT');return value}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}}
