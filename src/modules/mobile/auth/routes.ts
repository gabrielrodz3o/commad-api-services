import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import jwt from "jsonwebtoken";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { query } from "../../../db/pool.js";
import { env } from "../../../config/env.js";
import { resolveMobileApp } from "../shared/context.js";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");
const otpHash = (id: string, code: string) =>
  createHmac("sha256", env.OTP_HMAC_SECRET)
    .update(`${id}:${code}`)
    .digest("hex");
const phoneSchema = z.string().transform((v) => {
  let d = v.replace(/\D/g, "");
  if (d.length === 10) d = `1${d}`;
  if (d.length !== 11 || !d.startsWith("1"))
    throw new Error("Teléfono inválido");
  return `+${d}`;
});
const appContext = async (slug: string) => {
  const c = await resolveMobileApp(slug);
  if (!c)
    throw Object.assign(new Error("Aplicación no disponible"), {
      statusCode: 404,
      code: "APP_NOT_FOUND",
    });
  if (env.CUSTOMER_JWT_SECRET.length < 32 || env.OTP_HMAC_SECRET.length < 32)
    throw Object.assign(new Error("Autenticación móvil no configurada"), {
      statusCode: 503,
      code: "AUTH_NOT_CONFIGURED",
    });
  return c;
};
const issue = async (identity: any, device: any, req: FastifyRequest) => {
  const refresh = randomBytes(48).toString("base64url");
  const sessions = await query<any>(
    `INSERT INTO finances.customer_mobile_sessions(identity_id,entity_id,business_unit_id,refresh_token_hash,device_id,platform,app_version,last_ip,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::inet,now()+interval '90 days') RETURNING id`,
    [
      identity.id,
      identity.entity_id,
      identity.business_unit_id,
      sha(refresh),
      device?.id ?? null,
      device?.platform ?? null,
      device?.app_version ?? null,
      req.ip,
    ],
  );
  const access = jwt.sign(
    {
      sub: identity.id,
      sid: sessions[0].id,
      entity_id: Number(identity.entity_id),
      business_unit_id: Number(identity.business_unit_id),
      type: "customer",
    },
    env.CUSTOMER_JWT_SECRET,
    { expiresIn: "15m", issuer: "comandpos", audience: "pizza-getto-app" },
  );
  return { access_token: access, refresh_token: refresh, expires_in: 900 };
};

export function mobileAuthRoutes(app: FastifyInstance) {
  app.post<{ Params: { slug: string }; Body: any }>(
    "/v1/mobile/apps/:slug/auth/otp/request",
    async (req) => {
      const c = await appContext(req.params.slug);
      const body = z.object({ phone: z.string() }).parse(req.body);
      const phone = phoneSchema.parse(body.phone);
      const recent = await query<any>(
        `SELECT count(*)::int n FROM finances.customer_otp_challenges WHERE business_unit_id=$1 AND phone_e164=$2 AND created_at>now()-interval '15 minutes'`,
        [c.businessUnitId, phone],
      );
      if (Number(recent[0]?.n) >= (env.APP_ENV === "production" ? 3 : 20))
        throw Object.assign(
          new Error("Espera unos minutos antes de solicitar otro código"),
          { statusCode: 429, code: "OTP_RATE_LIMIT" },
        );
      const id = randomBytes(16)
        .toString("hex")
        .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
      const code = String(randomInt(1_000_000)).padStart(6, "0");
      await query(
        `INSERT INTO finances.customer_otp_challenges(id,business_unit_id,phone_e164,code_hash,expires_at,requested_ip,user_agent)VALUES($1,$2,$3,$4,now()+interval '5 minutes',$5::inet,$6)`,
        [
          id,
          c.businessUnitId,
          phone,
          otpHash(id, code),
          req.ip,
          req.headers["user-agent"] ?? null,
        ],
      );
      // Look up existing customer to return a masked greeting name
      const existing = await query<any>(
        `SELECT i.display_name FROM finances.customer_auth_identities i
         WHERE i.business_unit_id=$1 AND i.provider='phone' AND i.phone_e164=$2
         LIMIT 1`,
        [c.businessUnitId, phone],
      );
      const maskName = (full: string): string => {
        const first = full.trim().split(/\s+/)[0] ?? "";
        if (first.length <= 2) return first + "****";
        return first.slice(0, Math.max(2, Math.ceil(first.length / 2))) + "****";
      };
      const maskedName = existing[0]?.display_name
        ? maskName(existing[0].display_name)
        : null;
      if (env.OTP_WEBHOOK_URL) {
        const response = await fetch(env.OTP_WEBHOOK_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(env.OTP_WEBHOOK_TOKEN
              ? { authorization: `Bearer ${env.OTP_WEBHOOK_TOKEN}` }
              : {}),
          },
          body: JSON.stringify({ to: phone, code, channel: "pizza_getto_app" }),
        });
        if (!response.ok)
          throw Object.assign(new Error("No se pudo enviar el código"), {
            statusCode: 502,
            code: "OTP_PROVIDER_ERROR",
          });
      } else if (env.APP_ENV === "production")
        throw Object.assign(new Error("Proveedor OTP no configurado"), {
          statusCode: 503,
          code: "OTP_NOT_CONFIGURED",
        });
      return {
        success: true,
        data: {
          challenge_id: id,
          expires_in: 300,
          ...(maskedName ? { masked_name: maskedName } : {}),
          ...(env.APP_ENV === "local" ? { dev_code: code } : {}),
        },
      };
    },
  );

  app.post<{ Params: { slug: string }; Body: any }>(
    "/v1/mobile/apps/:slug/auth/otp/verify",
    async (req) => {
      const c = await appContext(req.params.slug);
      const b = z
        .object({
          challenge_id: z.string().uuid(),
          code: z.string().regex(/^\d{6}$/),
          name: z.string().trim().optional().transform((v) => (v === '' ? undefined : v)),
          link_token: z.string().optional(),
          device: z.any().optional(),
        })
        .parse(req.body);
      const rows = await query<any>(
        `SELECT * FROM finances.customer_otp_challenges WHERE id=$1 AND business_unit_id=$2`,
        [b.challenge_id, c.businessUnitId],
      );
      const ch = rows[0];
      if (
        !ch ||
        ch.consumed_at ||
        new Date(ch.expires_at) <= new Date() ||
        Number(ch.attempts) >= Number(ch.max_attempts)
      )
        throw Object.assign(new Error("Código inválido o expirado"), {
          statusCode: 401,
          code: "INVALID_OTP",
        });
      const expected = Buffer.from(ch.code_hash, "hex"),
        actual = Buffer.from(otpHash(b.challenge_id, b.code), "hex");
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      ) {
        await query(
          `UPDATE finances.customer_otp_challenges SET attempts=attempts+1 WHERE id=$1`,
          [b.challenge_id],
        );
        throw Object.assign(new Error("Código incorrecto"), {
          statusCode: 401,
          code: "INVALID_OTP",
        });
      }
      await query(
        `UPDATE finances.customer_otp_challenges SET consumed_at=now() WHERE id=$1`,
        [b.challenge_id],
      );
      const digits = String(ch.phone_e164).replace(/\D/g, ""),
        local = digits.slice(-10);
      const candidates = await query<any>(
        `SELECT e.id,e.name FROM finances.entities e WHERE e.is_customer=TRUE AND(e.business_unit_id=$1 OR e.business_unit_id IS NULL)AND json_typeof(e.contact_json)='array' AND EXISTS(SELECT 1 FROM json_array_elements(e.contact_json)c WHERE regexp_replace(COALESCE(c->>'description',''),'[^0-9]','','g') IN($2,$3)) ORDER BY e.id LIMIT 1`,
        [c.businessUnitId, digits, local],
      );
      let entityId = Number(candidates[0]?.id);
      if (!entityId) {
        const contacts = JSON.stringify([
          { id_type: 7, description_type: 7, description: local },
        ]);
        const created = await query<any>(
          `SELECT * FROM finances.add_or_update_entity(NULL,2,'',$1,$2::json,FALSE,TRUE,1,NULL,'[]'::json,$3::json,'[]'::json,$4)`,
          [
            b.name || "Cliente Pizza Getto",
            contacts,
            JSON.stringify({ account_receivable_id: 3, credit_day_id: 1 }),
            c.businessUnitId,
          ],
        );
        entityId = Number(created[0]?.entity_id ?? created[0]?.id);
      }
      const identities = await query<any>(
        `INSERT INTO finances.customer_auth_identities(entity_id,business_unit_id,provider,provider_subject,phone_e164,phone_verified,display_name,last_login_at)VALUES($1,$2,'phone',$3,$3,TRUE,$4,now())ON CONFLICT(business_unit_id,provider,provider_subject)DO UPDATE SET last_login_at=now(),phone_verified=TRUE RETURNING *`,
        [
          entityId,
          c.businessUnitId,
          ch.phone_e164,
          candidates[0]?.name || b.name || "Cliente Pizza Getto",
        ],
      );
      if (b.link_token) {
        const linked = jwt.verify(b.link_token, env.CUSTOMER_JWT_SECRET, {
          issuer: "comandpos",
          audience: "pizza-getto-link",
        }) as any;
        await query(
          `INSERT INTO finances.customer_auth_identities(entity_id,business_unit_id,provider,provider_subject,email_normalized,email_verified,display_name,avatar_url,last_login_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())ON CONFLICT(business_unit_id,provider,provider_subject)DO UPDATE SET entity_id=EXCLUDED.entity_id,last_login_at=now()`,
          [
            entityId,
            c.businessUnitId,
            linked.provider,
            linked.provider_subject,
            linked.email,
            linked.email_verified,
            linked.name,
            linked.picture,
          ],
        );
      }
      const tokens = await issue(identities[0], b.device, req);
      return {
        success: true,
        data: {
          ...tokens,
          profile: {
            id: entityId,
            name: identities[0].display_name,
            phone: ch.phone_e164,
          },
        },
      };
    },
  );

  app.post<{ Params: { slug: string }; Body: any }>(
    "/v1/mobile/apps/:slug/auth/social",
    async (req) => {
      const c = await appContext(req.params.slug);
      const b = z
        .object({
          provider: z.enum(["google", "apple"]),
          id_token: z.string().min(20),
          name: z.string().optional(),
          device: z.any().optional(),
        })
        .parse(req.body);
      const google = b.provider === "google",
        audiences = (google ? env.GOOGLE_CLIENT_IDS : env.APPLE_CLIENT_ID)
          .split(",")
          .filter(Boolean);
      if (!audiences.length)
        throw Object.assign(
          new Error(`${google ? "Google" : "Apple"} no configurado`),
          { statusCode: 503, code: "SOCIAL_NOT_CONFIGURED" },
        );
      const jwks = createRemoteJWKSet(
        new URL(
          google
            ? "https://www.googleapis.com/oauth2/v3/certs"
            : "https://appleid.apple.com/auth/keys",
        ),
      );
      let p: any;
      try {
        p = (
          await jwtVerify(b.id_token, jwks, {
            issuer: google
              ? ["https://accounts.google.com", "accounts.google.com"]
              : "https://appleid.apple.com",
            audience: audiences,
          })
        ).payload;
      } catch {
        throw Object.assign(new Error("Identidad externa inválida"), {
          statusCode: 401,
          code: "INVALID_SOCIAL_TOKEN",
        });
      }
      const existing = await query<any>(
        `SELECT i.*,e.name FROM finances.customer_auth_identities i JOIN finances.entities e ON e.id=i.entity_id WHERE i.business_unit_id=$1 AND i.provider=$2 AND i.provider_subject=$3`,
        [c.businessUnitId, b.provider, String(p.sub)],
      );
      if (existing[0])
        return {
          success: true,
          data: {
            ...(await issue(existing[0], b.device, req)),
            profile: {
              id: Number(existing[0].entity_id),
              name: existing[0].name,
              email: existing[0].email_normalized,
              avatarUrl: existing[0].avatar_url,
            },
          },
        };
      const link_token = jwt.sign(
        {
          provider: b.provider,
          provider_subject: String(p.sub),
          email: p.email ? String(p.email).toLowerCase() : null,
          email_verified:
            p.email_verified === true || p.email_verified === "true",
          name: b.name || p.name || null,
          picture: p.picture || null,
        },
        env.CUSTOMER_JWT_SECRET,
        { expiresIn: "10m", issuer: "comandpos", audience: "pizza-getto-link" },
      );
      return { success: true, data: { needs_phone: true, link_token } };
    },
  );

  app.post<{ Params: { slug: string }; Body: any }>(
    "/v1/mobile/apps/:slug/auth/refresh",
    async (req) => {
      const c = await appContext(req.params.slug);
      const b = z.object({ refresh_token: z.string().min(20) }).parse(req.body);
      const rows = await query<any>(
        `SELECT * FROM finances.customer_mobile_sessions WHERE refresh_token_hash=$1 AND business_unit_id=$2 AND revoked_at IS NULL AND expires_at>now()`,
        [sha(b.refresh_token), c.businessUnitId],
      );
      const s = rows[0];
      if (!s)
        throw Object.assign(new Error("Sesión expirada"), {
          statusCode: 401,
          code: "SESSION_EXPIRED",
        });
      const next = randomBytes(48).toString("base64url");
      await query(
        `UPDATE finances.customer_mobile_sessions SET refresh_token_hash=$1,last_seen_at=now(),last_ip=$2::inet WHERE id=$3`,
        [sha(next), req.ip, s.id],
      );
      const access = jwt.sign(
        {
          sub: s.identity_id,
          sid: s.id,
          entity_id: Number(s.entity_id),
          business_unit_id: c.businessUnitId,
          type: "customer",
        },
        env.CUSTOMER_JWT_SECRET,
        { expiresIn: "15m", issuer: "comandpos", audience: "pizza-getto-app" },
      );
      return {
        success: true,
        data: { access_token: access, refresh_token: next, expires_in: 900 },
      };
    },
  );
  app.post<{ Params: { slug: string }; Body: any }>(
    "/v1/mobile/apps/:slug/auth/logout",
    async (req) => {
      const c = await appContext(req.params.slug);
      const b = z.object({ refresh_token: z.string().min(20) }).parse(req.body);
      await query(
        `UPDATE finances.customer_mobile_sessions SET revoked_at=now(),revoke_reason='customer_logout' WHERE refresh_token_hash=$1 AND business_unit_id=$2 AND revoked_at IS NULL`,
        [sha(b.refresh_token), c.businessUnitId],
      );
      return { success: true };
    },
  );
}
