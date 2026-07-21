import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { query } from "../../../db/pool.js";
import { transaction } from "../../../db/transaction.js";
import {
  authenticateCustomer,
  requireLocation,
  resolveMobileApp,
} from "../shared/context.js";
import { getMobileProducts } from "../catalog/products.js";
const bodySchema = z.object({
  location_id: z.number().int().positive(),
  catalogue_id: z.number().int().positive(),
  menu_id: z.number().int().positive().optional(),
  delivery_type: z.enum(["delivery", "pickup"]),
  delivery_address_id: z.string().uuid().optional(),
  delivery_address: z.string().max(500).optional(),
  customer: z.object({
    name: z.string().min(1).max(200),
    phone: z.string().max(20),
  }),
  payment_method_id: z.number().int().positive(),
  order_note: z.string().max(500).optional(),
  order_details: z
    .array(
      z.object({
        item_id: z.number().int().positive(),
        quantity: z.number().positive().max(50),
        item_note: z.string().max(500).optional(),
        combo_group_id: z.string().max(100).nullable().optional(),
        combo_item_id: z.number().int().positive().nullable().optional(),
        sides: z
          .array(z.object({ side_id: z.number().int().positive() }))
          .default([]),
      }),
    )
    .min(1)
    .max(100),
});
const stable = (v: unknown) => JSON.stringify(v, Object.keys(v as any).sort());
export function mobileOrderRoutes(app: FastifyInstance) {
  app.post<{ Params: { slug: string }; Body: unknown }>(
    "/v1/mobile/apps/:slug/orders",
    async (req, reply) => {
      const c = await resolveMobileApp(req.params.slug);
      if (!c)
        throw Object.assign(new Error("Aplicación no disponible"), {
          statusCode: 404,
          code: "APP_NOT_FOUND",
        });
      const u = await authenticateCustomer(req, c),
        b = bodySchema.parse(req.body),
        key = String(req.headers["idempotency-key"] || "");
      if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key))
        throw Object.assign(new Error("Idempotency-Key requerido"), {
          statusCode: 400,
          code: "IDEMPOTENCY_KEY_REQUIRED",
        });
      const hash = createHash("sha256").update(stable(b)).digest("hex"),
        old = await query<any>(
          `SELECT request_hash,status,response_json FROM restaurant.mobile_order_requests WHERE business_unit_id=$1 AND entity_id=$2 AND idempotency_key=$3`,
          [c.businessUnitId, u.entity_id, key],
        );
      if (old[0]) {
        if (old[0].request_hash !== hash)
          throw Object.assign(
            new Error("La clave ya fue usada con otro contenido"),
            { statusCode: 409, code: "IDEMPOTENCY_CONFLICT" },
          );
        if (old[0].status === "completed") return old[0].response_json;
        return reply.code(409).send({
          success: false,
          code: "ORDER_IN_PROGRESS",
          message: "La orden está siendo procesada",
        });
      }
      const location = await requireLocation(c, b.location_id);
      if (!location || Number(location.catalogue_id) !== b.catalogue_id)
        throw Object.assign(new Error("Sucursal o catálogo inválido"), {
          statusCode: 400,
          code: "INVALID_LOCATION",
        });
      if (b.delivery_type === "delivery" && !location.use_delivery)
        throw Object.assign(new Error("Delivery no disponible"), {
          statusCode: 409,
          code: "DELIVERY_UNAVAILABLE",
        });
      if (b.delivery_type === "pickup" && !location.use_pickup)
        throw Object.assign(new Error("Recogida no disponible"), {
          statusCode: 409,
          code: "PICKUP_UNAVAILABLE",
        });
      const paymentAllowed = await query(
        `SELECT 1 FROM finances.location_payment_types WHERE location_id=$1 AND payment_type_id=$2 AND is_active=TRUE`,
        [b.location_id, b.payment_method_id],
      );
      if (!paymentAllowed.length)
        throw Object.assign(new Error("Método de pago no disponible en esta sucursal"), {
          statusCode: 409,
          code: "PAYMENT_METHOD_UNAVAILABLE",
        });
      const ids = [...new Set(b.order_details.map((x) => x.item_id))],
        priced = await query<any>(
          `SELECT DISTINCT ON(cd.item_id)
             cd.item_id,md.menu_id,cd.sale_price::numeric original_price,md.production_center_id,
             promo.id promotion_id,promo.promotion_type,
             CASE promo.promotion_type
               WHEN 'DISCOUNT_PERCENTAGE' THEN GREATEST(cd.sale_price-LEAST(cd.sale_price*(promo.discount_percentage/100),COALESCE(promo.max_discount_amount,cd.sale_price)),0)
               WHEN 'DISCOUNT_FIXED' THEN GREATEST(cd.sale_price-promo.discount_amount,0)
               ELSE cd.sale_price
             END::numeric price
           FROM inventory.catalogue_details cd
           JOIN inventory.items i ON i.id=cd.item_id AND i.active=TRUE
           JOIN restaurant.menu_details md ON md.item_id=cd.item_id
           JOIN restaurant.menus m ON m.id=md.menu_id AND m.location_id=$3 AND m.active=TRUE
           LEFT JOIN LATERAL(
             SELECT p.id,p.promotion_type,p.discount_percentage,p.discount_amount,p.max_discount_amount
             FROM restaurant.promotions p LEFT JOIN restaurant.promotion_items pi ON pi.promotion_id=p.id
             WHERE p.is_active=TRUE AND COALESCE(p.is_employee_benefit,FALSE)=FALSE
               AND (NOW() AT TIME ZONE 'America/Santo_Domingo')::date BETWEEN p.start_date::date AND p.end_date::date
               AND (p.location_id IS NULL OR p.location_id=$3)
               AND (p.max_uses_total IS NULL OR p.current_uses<p.max_uses_total)
               AND (pi.item_id=cd.item_id OR(p.applies_to_all_items=TRUE AND pi.item_id IS NULL))
               AND ((EXTRACT(DOW FROM NOW() AT TIME ZONE 'America/Santo_Domingo')=0 AND p.applies_sunday)OR
                    (EXTRACT(DOW FROM NOW() AT TIME ZONE 'America/Santo_Domingo')=1 AND p.applies_monday)OR
                    (EXTRACT(DOW FROM NOW() AT TIME ZONE 'America/Santo_Domingo')=2 AND p.applies_tuesday)OR
                    (EXTRACT(DOW FROM NOW() AT TIME ZONE 'America/Santo_Domingo')=3 AND p.applies_wednesday)OR
                    (EXTRACT(DOW FROM NOW() AT TIME ZONE 'America/Santo_Domingo')=4 AND p.applies_thursday)OR
                    (EXTRACT(DOW FROM NOW() AT TIME ZONE 'America/Santo_Domingo')=5 AND p.applies_friday)OR
                    (EXTRACT(DOW FROM NOW() AT TIME ZONE 'America/Santo_Domingo')=6 AND p.applies_saturday))
               AND (p.start_time IS NULL OR p.end_time IS NULL OR
                    (p.start_time<=p.end_time AND (NOW() AT TIME ZONE 'America/Santo_Domingo')::time BETWEEN p.start_time AND p.end_time)OR
                    (p.start_time>p.end_time AND ((NOW() AT TIME ZONE 'America/Santo_Domingo')::time>=p.start_time OR (NOW() AT TIME ZONE 'America/Santo_Domingo')::time<=p.end_time)))
             ORDER BY (pi.item_id IS NOT NULL)DESC,p.priority DESC,p.id LIMIT 1
           )promo ON TRUE
           WHERE cd.catalogue_id=$1 AND cd.item_id=ANY($2::int[]) AND cd.status_id=1
           ORDER BY cd.item_id,md.menu_id`,
          [b.catalogue_id, ids, b.location_id],
        );
      const prices = new Map(priced.map((x) => [Number(x.item_id), x]));
      if (ids.some((id) => !prices.has(id)))
        throw Object.assign(
          new Error("Uno o más productos ya no están disponibles"),
          { statusCode: 409, code: "ITEM_UNAVAILABLE" },
        );
      const checkoutMenuIds = b.menu_id
        ? [b.menu_id]
        : [...new Set(priced.map((x) => Number(x.menu_id)))];
      const stockRows = (
        await Promise.all(
          checkoutMenuIds.map((menuId) =>
            getMobileProducts({
              menuId,
              catalogueId: b.catalogue_id,
              locationId: b.location_id,
              orderTypeId: b.delivery_type === "delivery" ? 3 : 2,
            }),
          ),
        )
      ).flat();
      const stock = new Map(stockRows.map((x) => [Number(x.item_id), x]));
      const requested = new Map<number, number>();
      for (const line of b.order_details)
        requested.set(
          line.item_id,
          (requested.get(line.item_id) ?? 0) + line.quantity,
        );
      for (const [itemId, quantity] of requested) {
        const item = stock.get(itemId);
        if (
          !item ||
          (!item.negative_sale &&
            Number(item.discount_warehouse_quantity) < quantity)
        )
          throw Object.assign(
            new Error(`Producto ${itemId} sin existencia suficiente`),
            {
              statusCode: 409,
              code: "INSUFFICIENT_STOCK",
            },
          );
      }
      for (const line of b.order_details) {
        if (!line.sides.length) continue;
        const item = stock.get(line.item_id);
        const categories = Array.isArray(item?.sides_categories)
          ? item.sides_categories
          : [];
        const allowed = new Set(
          categories.flatMap((category: any) =>
            (category.sides ?? []).map((side: any) => Number(side.id)),
          ),
        );
        if (line.sides.some((side) => !allowed.has(side.side_id)))
          throw Object.assign(
            new Error(`Acompañamiento inválido para producto ${line.item_id}`),
            {
              statusCode: 409,
              code: "INVALID_SIDE",
            },
          );
      }
      let addr: any = null;
      if (b.delivery_address_id) {
        const rows = await query<any>(
          `SELECT * FROM finances.customer_delivery_addresses WHERE id=$1::uuid AND entity_id=$2 AND deleted_at IS NULL`,
          [b.delivery_address_id, u.entity_id],
        );
        addr = rows[0];
        if (!addr)
          throw Object.assign(new Error("Dirección inválida"), {
            statusCode: 400,
            code: "INVALID_ADDRESS",
          });
      }
      const orderUserId = Number(c.config.order_user_id);
      if (!Number.isInteger(orderUserId) || orderUserId <= 0)
        throw Object.assign(
          new Error("Falta mobile_app_config.order_user_id"),
          { statusCode: 503, code: "ORDER_USER_NOT_CONFIGURED" },
        );
      await query(
        `INSERT INTO restaurant.mobile_order_requests(business_unit_id,entity_id,idempotency_key,request_hash,status)VALUES($1,$2,$3,$4,'processing')`,
        [c.businessUnitId, u.entity_id, key, hash],
      );
      try {
        const response = await transaction(async (client) => {
          const details = b.order_details.map((x) => {
            const p = prices.get(x.item_id)!;
            return {
              item_id: x.item_id,
              quantity: x.quantity,
              order_price: Number(p.price),
              original_price: Number(p.original_price),
              discount_amount: Number(p.original_price) - Number(p.price),
              discount_type: p.promotion_type ?? "NONE",
              promotion_id: p.promotion_id ?? null,
              item_note: x.item_note || "",
              production_center_id: Number(p.production_center_id),
              combo_group_id: x.combo_group_id ?? null,
              combo_item_id: x.combo_item_id ?? null,
              sides: x.sides,
            };
          });
          const account = {
            in_account_id: null,
            in_customer_id: u.entity_id,
            in_account_name: b.customer.name,
            in_location_id: b.location_id,
            in_status_id: 1,
            user_id: orderUserId,
            is_delivery: b.delivery_type === "delivery",
            is_pickup: b.delivery_type === "pickup",
            external_platform: null,
            delivery_phone: b.customer.phone,
            delivery_contact_name: b.customer.name,
            delivery_address: b.delivery_address || addr?.street || null,
            delivery_reference_point: addr?.reference || null,
            delivery_lat: addr?.location_point?.[1] ?? null,
            delivery_lng: addr?.location_point?.[0] ?? null,
            delivery_address_id: b.delivery_address_id ?? null,
          };
          const order = {
            menu_id: b.menu_id ?? priced[0]?.menu_id,
            user_id: orderUserId,
            type_id: b.delivery_type === "delivery" ? 3 : 2,
            has_tip: false,
            order_note: b.order_note || "",
            platform_id: null,
            state_id: 2,
          };
          const result = await client.query(
            `SELECT * FROM restaurant.add_account_with_order($1::jsonb,$2::json,$3::jsonb)`,
            [
              JSON.stringify(account),
              JSON.stringify(details),
              JSON.stringify(order),
            ],
          );
          const first = result.rows[0] || {};
          if (first.account_id)
            await client.query(
              `UPDATE restaurant.accounts SET payment_method_id=$1 WHERE id=$2`,
              [b.payment_method_id, first.account_id],
            );
          return {
            success: true,
            data: {
              account_id: Number(first.account_id),
              order_id: Number(first.order_id),
              status: "received",
              tickets: result.rows,
            },
          };
        });
        await query(
          `UPDATE restaurant.mobile_order_requests SET status='completed',account_id=$1,response_json=$2::jsonb,updated_at=now() WHERE business_unit_id=$3 AND entity_id=$4 AND idempotency_key=$5`,
          [
            response.data.account_id,
            JSON.stringify(response),
            c.businessUnitId,
            u.entity_id,
            key,
          ],
        );
        return response;
      } catch (error) {
        await query(
          `UPDATE restaurant.mobile_order_requests SET status='failed',error_code='ORDER_FAILED',updated_at=now() WHERE business_unit_id=$1 AND entity_id=$2 AND idempotency_key=$3`,
          [c.businessUnitId, u.entity_id, key],
        );
        throw error;
      }
    },
  );
  app.get<{ Params: { slug: string; id: string } }>(
    "/v1/mobile/apps/:slug/orders/:id",
    async (req) => {
      const c = await resolveMobileApp(req.params.slug);
      if (!c)
        throw Object.assign(new Error("Aplicación no disponible"), {
          statusCode: 404,
        });
      const u = await authenticateCustomer(req, c);
      const rows = await query<any>(
        `SELECT a.id account_id,a.created_at,a.updated_at,a.status_tracker_id,COALESCE(s.name,'Recibido')status_name,a.location_id,a.invoice_id FROM restaurant.accounts a LEFT JOIN restaurant.account_service_status s ON s.id=a.status_tracker_id WHERE a.id=$1 AND a.customer_id=$2`,
        [Number(req.params.id), u.entity_id],
      );
      if (!rows[0])
        throw Object.assign(new Error("Orden no encontrada"), {
          statusCode: 404,
          code: "ORDER_NOT_FOUND",
        });
      return { success: true, data: rows[0] };
    },
  );
}
