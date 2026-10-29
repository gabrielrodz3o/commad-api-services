# Comandi — servicio de IA (ComandPOS)

> Este servicio también es el backend propietario de las aplicaciones móviles de ComandPOS.

## API móvil

Los contratos están bajo `/v1/mobile/apps/:slug`: bootstrap, catálogo, combos, autenticación OTP/social, perfil/direcciones, checkout idempotente y tracking.

El catálogo reutiliza en `src/modules/mobile/catalog/products.ts` las reglas del POS para stock: último balance del almacén, recetas multinivel, empaque por canal y `fn_combo_producible`. Las promociones respetan sucursal, fecha, día, horario y límites de uso. Expo oculta productos sin existencia salvo que tengan `negative_sale`.

El checkout exige `Authorization: Bearer <customer token>` e `Idempotency-Key`. Los precios se consultan nuevamente en PostgreSQL y la creación usa `restaurant.add_account_with_order`, de modo que cuenta, orden y líneas son atómicas. Cada unidad habilitada debe definir `mobile_app_config.order_user_id`.

### Ambientes y despliegue

- `APP_ENV=test` solo permite `DB_DATABASE=gcode_test`.
- `APP_ENV=production` solo permite `DB_DATABASE=gcode`.
- `pnpm migrate` aplica migraciones con checksum y advisory lock.
- `pnpm check` ejecuta TypeScript y pruebas de contrato.
- CI publica una imagen GHCR por SHA. Test despliega `develop` automáticamente; producción requiere despacho manual, SHA validado y aprobación del environment.

Para Expo en la red local use `EXPO_PUBLIC_API_BASE_URL=http://192.168.100.65:4080`. `localhost` en un teléfono apunta al propio teléfono; Fastify debe escuchar en `0.0.0.0` y `/ready` debe responder. La rotación de secretos está fuera de este cambio por decisión operativa.

Satélite que orquesta el LLM (OpenAI/Claude) de COMAND POS. **Multi-empresa por request**:
recibe `location_ids`, resuelve la unidad de negocio, lee su configuración de IA (motor/modelo/llave
elegida en `business.vue`) y arma el contexto con datos reales de Postgres (solo lectura).

> El LLM **propone/redacta**; Comandi resuelve y ejecuta. El cálculo pesado vive en Postgres/core.

## Arranque
```bash
cp .env.example .env   # completa DB_PASSWORD, OPENAI_API_KEY, COMANDI_SERVICE_TOKEN
pnpm install
pnpm dev               # http://localhost:4080
```

## Auth
Las rutas protegidas aceptan la identidad configurada para cada operación: token de servicio
para integraciones internas o JWT de usuario con sus permisos. El token de servicio nunca va al navegador.
Las rutas de Workspace requieren JWT de usuario y rechazan la identidad de servicio.

## Endpoints
| Método | Ruta | Body | Qué hace |
|---|---|---|---|
| GET | `/health` | — | estado + ping a la DB |
| POST | `/comandi/ask` | `{ location_ids, question }` | chat anclado en datos de compras |
| POST | `/comandi/insights` | `{ location_ids, domain, report }` | análisis ejecutivo estructurado de un reporte |

`location_ids` deben ser **de la misma empresa** (si se mezclan, 422). Si la empresa no tiene IA
configurada → `{ enabled: false }`.

### Ejemplo
```bash
curl -X POST http://localhost:4080/comandi/insights \
  -H "Authorization: Bearer $COMANDI_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"location_ids":[1],"domain":"cost_analysis","report":{"kpis":{}}}'
```

## Docker
Puerto **4080** (local y contenedor). El compose se une a la red externa `app-network`
(la misma del core), así alcanza `pgbouncer:6432` y el reverse-proxy lo publica.

```bash
docker compose up -d --build      # levanta el contenedor "comandi" en app-network
docker compose logs -f comandi
```

Cómo lo llama el **core (Nuxt)** — variable `COMANDI_URL`:
- **Local:** `http://localhost:4080`
- **Producción:** `https://services.comandpos.com`

(en el core ya está en `runtimeConfig`: `comandiUrl` + `comandiServiceToken`).

## Reglas (arquitectura)
- Solo lectura de datos de negocio; no escribe nada del negocio.
- La config de IA se consulta por request (caché ~60s).
- Cada empresa usa **su** llave; fallback global en `.env` si no tiene.

## Contrato de Comandi Workspace

`POST /comandi/workspace/reason` recibe del ERP el contexto, instrucciones, evidencia y esquema
para `comandi_plan` o `comandi_analysis`. El ERP ejecuta las consultas parametrizadas y valida
los resultados; este servicio invoca el modelo y registra el consumo. Esta ruta no ejecuta SQL
generado ni movimientos de inventario.

- Alcance obligatorio: `business_unit_id`, `active_location_id` y `location_ids` (1–100).
- `permission_screens`: `reports`, `crm`, `inventories`, `requisiciones`, `movement`,
  `adjustment`, `kardex`, `receipts`, `production`, `waste`, `requisitions`, `requisitions_received`.
- Se comprueba `comandi/read` además de cada pantalla solicitada, antes y después del modelo.
- Para transferencias, el ERP aporta el dominio `transfers`, el filtro `guide_number` y la
  auditoría de los movimientos. Admitir `movement` en el servicio permite usar esa capacidad;
  no concede acceso adicional al usuario.
- Al publicar esta mejora, actualizar primero el servicio y después el ERP. El servicio anterior
  rechaza los nuevos códigos de pantalla con HTTP 400.

Validación: `pnpm check` con las variables de entorno de prueba descritas en CI.
`test/workspace.test.ts` prueba el contrato HTTP, permisos denegados/revocados y fallos del motor
con dependencias simuladas; no consume IA ni conecta con producción.
