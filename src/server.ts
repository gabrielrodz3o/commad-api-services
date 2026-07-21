import { env } from './config/env.js'
import { buildApp } from './app.js'
import { pool } from './db/pool.js'
import { startTelegramPoller } from './telegram/poller.js'
const app = await buildApp()
const shutdown=async(signal:string)=>{app.log.info({signal},'shutting down');await app.close();await pool.end();process.exit(0)}
process.once('SIGTERM',()=>void shutdown('SIGTERM'));process.once('SIGINT',()=>void shutdown('SIGINT'))

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' })
  console.log(`🚀 command-api-services escuchando en http://0.0.0.0:${env.PORT}`)
  // Canal Telegram (long-polling) si hay token configurado. No bloquea el arranque.
  void startTelegramPoller()
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
