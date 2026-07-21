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
Todo request (salvo `/health`) requiere `Authorization: Bearer <COMANDI_SERVICE_TOKEN>`.
Pensado para que el **core (Nuxt) llame server-to-server**; el token nunca va al navegador.

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
