import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../../../db/pool.js";
import { transaction } from "../../../db/transaction.js";
import { authenticateCustomer, resolveMobileApp } from "../shared/context.js";
import { resolveMobileCoverage } from "./coverage.js";
import { isScheduleOpen, scheduleLabel } from "../shared/schedule.js";
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
      const program = (await query<any>(`SELECT * FROM finances.customer_loyalty_programs WHERE business_unit_id=$1 AND is_active=TRUE`, [c.businessUnitId]))[0];
      if (program) await query(
        `INSERT INTO finances.customer_loyalty_ledger(business_unit_id,entity_id,points,movement_type,description,reversed_movement_id)
         SELECT l.business_unit_id,l.entity_id,-l.points,'EXPIRE','Puntos vencidos',l.id FROM finances.customer_loyalty_ledger l
         WHERE l.business_unit_id=$1 AND l.entity_id=$2 AND l.movement_type='EARN' AND l.points>0 AND l.expires_at<=now()
         ON CONFLICT(reversed_movement_id) WHERE reversed_movement_id IS NOT NULL DO NOTHING`, [c.businessUnitId,u.entity_id]);
      const [e, loyaltyRows, addresses, orders, redemptions] = await Promise.all([
        query<any>(
          `SELECT id,name,document_id,contact_json FROM finances.entities WHERE id=$1 AND is_customer=TRUE`,
          [u.entity_id],
        ),
        query<any>(
          `SELECT COALESCE(SUM(points),0)::int balance,
                  COALESCE(json_agg(json_build_object('id',id,'points',points,'type',movement_type,'description',description,'created_at',created_at) ORDER BY created_at DESC) FILTER(WHERE id IS NOT NULL),'[]'::json) movements
             FROM (SELECT * FROM finances.customer_loyalty_ledger WHERE business_unit_id=$1 AND entity_id=$2 ORDER BY created_at DESC LIMIT 30) x`,
          [c.businessUnitId, u.entity_id],
        ),
        query<any>(
          `SELECT cda.id,cda.street,cda.reference,cda.complement,cda.neighborhood,cda.district,cda.province,cda.label,cda.is_default,cda.notes,
             CASE WHEN cda.location_point IS NOT NULL THEN(cda.location_point)[1]END latitude,
             CASE WHEN cda.location_point IS NOT NULL THEN(cda.location_point)[0]END longitude,
             COALESCE(cda.assigned_location_id,cda.detected_location_id)effective_location_id,
             cda.detected_location_id,cda.detected_zone_id,dz.name detected_zone_name,dz.price detected_zone_price,
             dz.active_from detected_zone_active_from,dz.active_until detected_zone_active_until,dz.active_days detected_zone_active_days,
             l.description_long effective_location_name,l.shopping_start_time,l.shopping_end_time
           FROM finances.customer_delivery_addresses cda
           LEFT JOIN restaurant.delivery_zones dz ON dz.id=cda.detected_zone_id
           LEFT JOIN human_resource.locations l ON l.id=COALESCE(cda.assigned_location_id,cda.detected_location_id)
           WHERE cda.entity_id=$1 AND cda.deleted_at IS NULL ORDER BY cda.is_default DESC,cda.created_at`,
          [u.entity_id],
        ),
        query<any>(
          `SELECT a.id account_id,a.created_at,a.updated_at,a.is_delivery,a.is_pickup,a.status_tracker_id,
                  COALESCE(st.name,'Recibido')status_name,st.color status_color,st.icon status_icon,
                  a.delivery_address,COALESCE(a.delivery_cost,a.cost_delivery,0)::numeric delivery_cost,a.location_id,l.description_long location_name,a.invoice_id,
                  a.scheduled_for,a.estimated_ready_at,
                  COALESCE((SELECT SUM(od.quantity*(od.order_price-COALESCE(od.discount_amount,0)))
                    FROM restaurant.orders r JOIN restaurant.order_details od ON od.order_id=r.id WHERE r.account_id=a.id),0)::numeric subtotal,
                  COALESCE((SELECT COUNT(*) FROM restaurant.orders r JOIN restaurant.order_details od ON od.order_id=r.id WHERE r.account_id=a.id),0)::int item_count,
                  COALESCE((SELECT json_agg(x ORDER BY x.item_sequence) FROM (
                    SELECT DISTINCT ON(od.item_id) od.item_id,od.item_sequence,i.name item_name,i.image_url item_image_url,od.quantity
                    FROM restaurant.orders r JOIN restaurant.order_details od ON od.order_id=r.id
                    JOIN inventory.items i ON i.id=od.item_id WHERE r.account_id=a.id
                    ORDER BY od.item_id,od.item_sequence LIMIT 3
                  )x),'[]'::json) item_preview
             FROM restaurant.accounts a
             LEFT JOIN restaurant.account_service_status st ON st.id=a.status_tracker_id
             LEFT JOIN human_resource.locations l ON l.id=a.location_id
            WHERE a.customer_id=$1 ORDER BY a.created_at DESC LIMIT 50`,
          [u.entity_id],
        ),
        query<any>(`SELECT x.*,r.name reward_name,r.description reward_description,r.image_url FROM finances.customer_loyalty_redemptions x JOIN finances.customer_loyalty_rewards r ON r.id=x.reward_id WHERE x.business_unit_id=$1 AND x.entity_id=$2 ORDER BY x.redeemed_at DESC LIMIT 30`, [c.businessUnitId,u.entity_id]),
      ]);
      if (!e[0])
        throw Object.assign(new Error("Cliente no encontrado"), {
          statusCode: 404,
          code: "CUSTOMER_NOT_FOUND",
        });
      return {
        success: true,
        data: { profile: e[0], loyalty: program ? { ...(loyaltyRows[0] ?? { balance: 0, movements: [] }), program, redemptions } : null, addresses: addresses.map((item: any) => ({
          ...item,
          delivery_open_now: isScheduleOpen({ start: item.shopping_start_time, end: item.shopping_end_time }) && isScheduleOpen({ start: item.detected_zone_active_from, end: item.detected_zone_active_until, days: item.detected_zone_active_days }),
          delivery_schedule_label: scheduleLabel(item.detected_zone_active_from, item.detected_zone_active_until),
        })), orders },
      };
    },
  );
  app.post<{ Params: { slug: string; rewardId: string } }>(
    "/v1/mobile/apps/:slug/me/loyalty/rewards/:rewardId/redeem",
    async (req) => {
      const c=await ctx(req.params.slug),u=await authenticateCustomer(req,c),rewardId=Number(req.params.rewardId);
      if(!Number.isInteger(rewardId)) throw Object.assign(new Error("Recompensa inválida"),{statusCode:400,code:"INVALID_REWARD"});
      const redemption=await transaction(async(client)=>{
        const program=(await client.query(`SELECT * FROM finances.customer_loyalty_programs WHERE business_unit_id=$1 AND is_active=TRUE FOR UPDATE`,[c.businessUnitId])).rows[0];
        if(!program) throw Object.assign(new Error("El programa de puntos no está disponible"),{statusCode:409,code:"LOYALTY_DISABLED"});
        const reward=(await client.query<any>(`SELECT * FROM finances.customer_loyalty_rewards WHERE id=$1 AND business_unit_id=$2 AND is_active=TRUE AND(stock IS NULL OR stock>0) FOR UPDATE`,[rewardId,c.businessUnitId])).rows[0];
        if(!reward) throw Object.assign(new Error("Recompensa agotada o no disponible"),{statusCode:409,code:"REWARD_UNAVAILABLE"});
        const balance=Number((await client.query(`SELECT COALESCE(SUM(points),0)::int balance FROM finances.customer_loyalty_ledger WHERE business_unit_id=$1 AND entity_id=$2`,[c.businessUnitId,u.entity_id])).rows[0].balance);
        if(balance<Number(reward.points_cost)) throw Object.assign(new Error("No tienes puntos suficientes"),{statusCode:409,code:"INSUFFICIENT_POINTS"});
        const code=`PG-${crypto.randomUUID().replace(/-/g,'').slice(0,10).toUpperCase()}`;
        const row=(await client.query<any>(`INSERT INTO finances.customer_loyalty_redemptions(business_unit_id,entity_id,reward_id,code,points_spent,expires_at) VALUES($1,$2,$3,$4,$5,now()+($6::int*interval '1 day')) RETURNING *`,[c.businessUnitId,u.entity_id,reward.id,code,reward.points_cost,reward.valid_days])).rows[0];
        await client.query(`INSERT INTO finances.customer_loyalty_ledger(business_unit_id,entity_id,points,movement_type,description,redemption_id) VALUES($1,$2,$3,'REDEEM',$4,$5)`,[c.businessUnitId,u.entity_id,-Number(reward.points_cost),`Canje: ${reward.name}`,row.id]);
        if(reward.stock!==null) await client.query(`UPDATE finances.customer_loyalty_rewards SET stock=stock-1,updated_at=now() WHERE id=$1`,[reward.id]);
        return {...row,reward_name:reward.name,reward_description:reward.description};
      });
      return {success:true,data:redemption};
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
