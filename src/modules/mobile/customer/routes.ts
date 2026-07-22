import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../../../db/pool.js";
import { authenticateCustomer, resolveMobileApp } from "../shared/context.js";
import { resolveMobileCoverage } from "./coverage.js";
const ctx = async (slug: string) => {
  const c = await resolveMobileApp(slug);
  if (!c)
    throw Object.assign(new Error("Aplicación no disponible"), {
      statusCode: 404,
      code: "APP_NOT_FOUND",
    });
  return c;
};
const address = z.object({
  label: z.string().max(50).default("Casa"),
  street: z.string().min(3).max(255),
  reference: z.string().max(255).optional().nullable(),
  complement: z.string().max(255).optional().nullable(),
  neighborhood: z.string().max(120).optional().nullable(),
  district: z.string().max(120).optional().nullable(),
  province: z.string().max(120).optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  is_default: z.boolean().default(false),
  google_place_id: z.string().max(255).optional().nullable(),
});
export function mobileCustomerRoutes(app: FastifyInstance) {
  app.post<{ Params: { slug: string }; Body: unknown }>(
    "/v1/mobile/apps/:slug/me/addresses/coverage",
    async (req) => {
      const c = await ctx(req.params.slug);
      await authenticateCustomer(req, c);
      const point = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).parse(req.body);
      const coverage = await resolveMobileCoverage(c.businessUnitId, point.latitude, point.longitude);
      return { success: true, data: coverage ?? { within_coverage: false } };
    },
  );
  app.get<{ Params: { slug: string } }>(
    "/v1/mobile/apps/:slug/me",
    async (req) => {
      const c = await ctx(req.params.slug),
        u = await authenticateCustomer(req, c);
      const [e, a, o] = await Promise.all([
        query<any>(
          `SELECT id,name,document_id,contact_json FROM finances.entities WHERE id=$1 AND is_customer=TRUE`,
          [u.entity_id],
        ),
        query<any>(
          `SELECT cda.id,cda.street,cda.reference,cda.complement,cda.neighborhood,cda.district,cda.province,cda.label,cda.is_default,cda.notes,
             CASE WHEN cda.location_point IS NOT NULL THEN(cda.location_point)[1]END latitude,
             CASE WHEN cda.location_point IS NOT NULL THEN(cda.location_point)[0]END longitude,
             COALESCE(cda.assigned_location_id,cda.detected_location_id)effective_location_id,
             cda.detected_location_id,cda.detected_zone_id,dz.name detected_zone_name,dz.price detected_zone_price,
             l.description_long effective_location_name
           FROM finances.customer_delivery_addresses cda
           LEFT JOIN restaurant.delivery_zones dz ON dz.id=cda.detected_zone_id
           LEFT JOIN human_resource.locations l ON l.id=COALESCE(cda.assigned_location_id,cda.detected_location_id)
           WHERE cda.entity_id=$1 AND cda.deleted_at IS NULL ORDER BY cda.is_default DESC,cda.created_at`,
          [u.entity_id],
        ),
        query<any>(
          `SELECT a.id account_id,a.created_at,a.updated_at,a.is_delivery,a.is_pickup,a.status_tracker_id,COALESCE(st.name,'Recibido')status_name,a.delivery_address,a.delivery_cost,a.location_id,l.description_long location_name,a.invoice_id,COALESCE((SELECT SUM(od.quantity*od.order_price-COALESCE(od.discount_amount,0))FROM restaurant.orders r JOIN restaurant.order_details od ON od.order_id=r.id WHERE r.account_id=a.id),0)::numeric subtotal FROM restaurant.accounts a LEFT JOIN restaurant.account_service_status st ON st.id=a.status_tracker_id LEFT JOIN human_resource.locations l ON l.id=a.location_id WHERE a.customer_id=$1 ORDER BY a.created_at DESC LIMIT 50`,
          [u.entity_id],
        ),
      ]);
      if (!e[0])
        throw Object.assign(new Error("Cliente no encontrado"), {
          statusCode: 404,
          code: "CUSTOMER_NOT_FOUND",
        });
      return {
        success: true,
        data: { profile: e[0], addresses: a, orders: o },
      };
    },
  );
  app.post<{ Params: { slug: string }; Body: unknown }>(
    "/v1/mobile/apps/:slug/me/addresses",
    async (req) => {
      const c = await ctx(req.params.slug),
        u = await authenticateCustomer(req, c),
        b = address.parse(req.body);
      const coverage = await resolveMobileCoverage(c.businessUnitId, b.latitude, b.longitude);
      if (!coverage) throw Object.assign(new Error("La ubicación está fuera de nuestras zonas de delivery"), { statusCode: 422, code: "OUT_OF_COVERAGE" });
      if (b.is_default)
        await query(
          `UPDATE finances.customer_delivery_addresses SET is_default=FALSE WHERE entity_id=$1`,
          [u.entity_id],
        );
      const rows = await query<any>(
        `INSERT INTO finances.customer_delivery_addresses(entity_id,street,reference,complement,neighborhood,district,province,label,is_default,notes,location_point,google_place_id,detected_location_id,detected_zone_id,created_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,point($11,$12),$13,$14,$15,now())RETURNING *`,
        [
          u.entity_id,
          b.street,
          b.reference,
          b.complement,
          b.neighborhood,
          b.district,
          b.province,
          b.label,
          b.is_default,
          b.notes,
          b.longitude,
          b.latitude,
          b.google_place_id,
          coverage.location_id,
          coverage.zone_id,
        ],
      );
      return { success: true, data: rows[0] };
    },
  );
  app.put<{ Params: { slug: string; id: string }; Body: unknown }>(
    "/v1/mobile/apps/:slug/me/addresses/:id",
    async (req) => {
      const c = await ctx(req.params.slug),
        u = await authenticateCustomer(req, c),
        b = address.parse(req.body);
      const coverage = await resolveMobileCoverage(c.businessUnitId, b.latitude, b.longitude);
      if (!coverage) throw Object.assign(new Error("La ubicación está fuera de nuestras zonas de delivery"), { statusCode: 422, code: "OUT_OF_COVERAGE" });
      if (b.is_default)
        await query(
          `UPDATE finances.customer_delivery_addresses SET is_default=FALSE WHERE entity_id=$1`,
          [u.entity_id],
        );
      const rows = await query<any>(
        `UPDATE finances.customer_delivery_addresses SET street=$1,reference=$2,complement=$3,neighborhood=$4,district=$5,province=$6,label=$7,is_default=$8,notes=$9,location_point=point($10,$11),google_place_id=$12,detected_location_id=$13,detected_zone_id=$14 WHERE id=$15::uuid AND entity_id=$16 AND deleted_at IS NULL RETURNING *`,
        [
          b.street,
          b.reference,
          b.complement,
          b.neighborhood,
          b.district,
          b.province,
          b.label,
          b.is_default,
          b.notes,
          b.longitude,
          b.latitude,
          b.google_place_id,
          coverage.location_id,
          coverage.zone_id,
          req.params.id,
          u.entity_id,
        ],
      );
      if (!rows[0])
        throw Object.assign(new Error("Dirección no encontrada"), {
          statusCode: 404,
          code: "ADDRESS_NOT_FOUND",
        });
      return { success: true, data: rows[0] };
    },
  );
  app.delete<{ Params: { slug: string; id: string } }>(
    "/v1/mobile/apps/:slug/me/addresses/:id",
    async (req) => {
      const c = await ctx(req.params.slug),
        u = await authenticateCustomer(req, c);
      const rows = await query(
        `UPDATE finances.customer_delivery_addresses SET deleted_at=now(),is_default=FALSE WHERE id=$1::uuid AND entity_id=$2 AND deleted_at IS NULL RETURNING id`,
        [req.params.id, u.entity_id],
      );
      if (!rows.length)
        throw Object.assign(new Error("Dirección no encontrada"), {
          statusCode: 404,
          code: "ADDRESS_NOT_FOUND",
        });
      return { success: true };
    },
  );
}
