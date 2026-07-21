import 'dotenv/config'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import pg from 'pg'

const database=process.env.DB_DATABASE||'';const appEnv=process.env.APP_ENV||'local'
if(appEnv==='production'&&database!=='gcode')throw new Error('production requiere gcode')
if(appEnv==='test'&&database!=='gcode_test')throw new Error('test requiere gcode_test')
const pool=new pg.Pool({host:process.env.DB_MIGRATION_HOST||process.env.DB_HOST,port:Number(process.env.DB_MIGRATION_PORT||process.env.DB_PORT||5432),database,user:process.env.DB_MIGRATION_USER||process.env.DB_USER,password:process.env.DB_MIGRATION_PASSWORD||process.env.DB_PASSWORD,ssl:process.env.DB_SSL==='require'?{rejectUnauthorized:false}:undefined,max:1})
const client=await pool.connect()
try{await client.query(`SELECT pg_advisory_lock(hashtext('command-api-services-migrations'))`);await client.query(`CREATE TABLE IF NOT EXISTS public.command_api_schema_migrations(name text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now(),duration_ms integer NOT NULL)`);for(const name of(await readdir(new URL('../migrations/',import.meta.url))).filter(x=>x.endsWith('.sql')).sort()){const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');const checksum=createHash('sha256').update(sql).digest('hex');const found=await client.query(`SELECT checksum FROM public.command_api_schema_migrations WHERE name=$1`,[name]);if(found.rowCount){if(found.rows[0].checksum!==checksum)throw new Error(`Checksum cambió: ${name}`);continue}const started=Date.now();await client.query('BEGIN');try{await client.query(sql);await client.query(`INSERT INTO public.command_api_schema_migrations(name,checksum,duration_ms)VALUES($1,$2,$3)`,[name,checksum,Date.now()-started]);await client.query('COMMIT');console.log(`✓ ${name}`)}catch(error){await client.query('ROLLBACK');throw error}}}finally{await client.query(`SELECT pg_advisory_unlock(hashtext('command-api-services-migrations'))`).catch(()=>{});client.release();await pool.end()}
