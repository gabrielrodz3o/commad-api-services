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
            external_platform: 4,
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
            platform_id: 4,
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
      const accountId = Number(req.params.id);

      // 1. Get catalogue_id
      const catalogueResult = await query<any>(
        `SELECT c.id as catalogue_id
         FROM restaurant.accounts a
         JOIN inventory.catalogues c ON c.location_id = a.location_id
         WHERE a.id = $1
         LIMIT 1`,
        [accountId],
      );

      if (!catalogueResult.length) {
        throw Object.assign(new Error("No se encontró catálogo para la orden"), {
          statusCode: 404,
          code: "CATALOGUE_NOT_FOUND",
        });
      }
      const catalogueId = catalogueResult[0].catalogue_id;

      // 2. Fetch full detail (Secured by matching accounts.customer_id = $3)
      const detailQuery = `
        SELECT
            accounts.id AS account_id,
            accounts.table_id,
            accounts.location_id,
            locations.description_long  AS location_name,
            locations.description_short AS location_name_short,
            bu.description_long         AS business_unit_name,
            bu.color                    AS business_unit_color,
            $2::integer                 AS catalogue_id,
            accounts.cost_delivery,
            accounts.delivery_zone_id,
            accounts.scheduled_for,
            (SELECT dz.name FROM restaurant.delivery_zones dz
              WHERE dz.id = accounts.delivery_zone_id) AS delivery_zone_name,
            (SELECT pr.nombre FROM restaurant.delivery_zones dz
              LEFT JOIN public.provincias pr ON pr.provincia_id = dz.provincia_id
              WHERE dz.id = accounts.delivery_zone_id) AS delivery_zone_province,
            (SELECT mu.nombre FROM restaurant.delivery_zones dz
              LEFT JOIN public.municipios mu ON mu.municipio_id = dz.municipio_id
              WHERE dz.id = accounts.delivery_zone_id) AS delivery_zone_municipio,
            accounts.status_tracker_id,
            ass.name  AS status_name,
            ass.color AS color,
            ass.icon  AS icon,
            accounts.invoice_id,
            accounts.customer_id,
            accounts.name,
            accounts.created_at,
            TO_CHAR((accounts.created_at::TIMESTAMP AT TIME ZONE 'AMERICA/SANTO_DOMINGO'),'DD/MM/yyyy hh:mm:ss AM') as created_at_format,
            accounts.state_id,
            accounts.is_delivery,
            accounts.is_pickup,
            accounts.is_locked,
            accounts.uber_order_id,
            accounts.pedidosya_order_id,
            accounts.external_order_display_id,
            accounts.external_plattform_id,
            accounts.delivery_address,
            accounts.delivery_phone,
            accounts.delivery_lat,
            accounts.delivery_lng,
            accounts.delivery_notes,
            accounts.delivery_province,
            accounts.delivery_city,
            accounts.delivery_neighborhood,
            accounts.delivery_reference_point,
            accounts.invoice_voucher_type_id,
            accounts.payment_method_id,
            accounts.payment_breakdown,
            e.name AS entity_name,
            e.document_id,
            e.document_id_type_id,
            i.invoice_number,
            account_states.name AS account_state_name,
            accounts.waiter_id,
            waiter.name AS waiter_name,
            accounts.assigned_driver_id,
            driver.use_fullname AS assigned_driver_name,
            accounts.user_id AS taken_by_id,
            taker.use_fullname AS taken_by_name,
            accounts.accepted_by,
            accounts.accepted_at,
            acceptor.use_fullname AS accepted_by_name,
            i.created_by AS invoiced_by_id,
            biller.use_fullname AS invoiced_by_name,
            (
                SELECT
                    json_agg(t.*) AS json_agg
                FROM
                    (
                        SELECT
                            orders.id AS order_id,
                            orders.account_id,
                            orders.code,
                            orders.created_at,
                            TO_CHAR((orders.created_at::TIMESTAMP) AT TIME ZONE 'AMERICA/SANTO_DOMINGO','DD/MM/yyyy hh:mm:ss AM') as order_created_at,
                            COALESCE(orders.note, ''::text) AS note,
                            orders.location_id,
                            orders.has_tip,
                            orders.state_id,
                            order_states.name AS order_state_name,
                            orders.type_id,
                            order_types.name AS type_name,
                            orders.user_id,
                            users.use_fullname AS user_name,
                            (
                                SELECT
                                    json_agg(t_1.*) AS json_agg
                                FROM
                                    (
                                        SELECT
                                            order_details.quantity,
                                            order_details.item_sequence,
                                            order_details.order_price,
                                            order_details.original_price,
                                            order_details.item_note,
                                            order_details.production_center_id,
                                            COALESCE(order_details.discount_type, 'NONE') AS discount_type,
                                            COALESCE(order_details.discount_value, 0) AS discount_value,
                                            COALESCE(order_details.discount_amount, 0) AS discount_amount,
                                            order_details.discount_reason,
                                            order_details.discount_authorized_by,
                                            discount_user.use_fullname AS discount_authorized_by_name,
                                            order_details.promotion_id,
                                            promo.name AS promotion_name,
                                            promo.code AS promotion_code,
                                            promo.promotion_type AS promo_type,
                                            promo.discount_percentage AS promo_discount_percentage,
                                            order_details.combo_group_id,
                                            order_details.combo_item_id,
                                            combo_item.name AS combo_name,
                                            combo_item.tax_type_id AS combo_tax_type_id,
                                            combo_item.unit_id AS combo_unit_id,
                                            cd.catalogue_id,
                                            cd.item_id,
                                            i.unit_id,
                                            u.name AS unit_name,
                                            i.item_type_id,
                                            it.name AS item_type_name,
                                            i.name AS item_name,
                                            i.note AS item_description,
                                            i.image_url AS item_image_url,
                                            i.image_json,
                                            i.image_name,
                                            i.attribute_set,
                                            NULL AS item_attributes,
                                            i.tax_type_id,
                                            tt.name AS tax_type_name,
                                            tt.value AS tax_value,
                                            i.inventory_product,
                                            i.negative_sale,
                                            i.active,
                                            i.parent_id,
                                            parent_item.name AS parent_name,
                                            i.account_category_id,
                                            ac.name AS account_categorie_name,
                                            i.item_category_id,
                                            ic.name AS item_categorie_name,
                                            NULL AS item_categories,
                                            cd.max,
                                            cd.min,
                                            cd.warehouse_id,
                                            cd.category_id,
                                            cat.name AS category_name,
                                            NULL AS item_in_recipes,
                                            cd.sale_price AS price,
                                            cd.cost_price,
                                            (order_details.quantity * order_details.order_price) AS subtotal,
                                            ((order_details.quantity * order_details.order_price) - COALESCE(order_details.discount_amount, 0)) AS subtotal_with_discount,
                                            CASE 
                                                WHEN i.tax_type_id IS NOT NULL THEN
                                                    order_details.order_price * (1 + COALESCE(tt.value, 0))
                                                ELSE 
                                                    order_details.order_price
                                            END AS price_with_taxes,
                                            CASE 
                                                WHEN i.tax_type_id IS NOT NULL THEN
                                                    ((order_details.quantity * order_details.order_price) - COALESCE(order_details.discount_amount, 0)) * (1 + COALESCE(tt.value, 0))
                                                ELSE 
                                                    (order_details.quantity * order_details.order_price) - COALESCE(order_details.discount_amount, 0)
                                            END AS total_with_taxes_and_discount,
                                            CASE 
                                                WHEN (order_details.quantity * order_details.order_price) > 0 THEN
                                                    ROUND((COALESCE(order_details.discount_amount, 0) / (order_details.quantity * order_details.order_price)) * 100, 2)
                                                ELSE 
                                                    0
                                            END AS effective_discount_percentage,
                                            cd.code,
                                            (
                                                SELECT
                                                    json_agg(
                                                        json_build_object(
                                                            'id', side_types.id,
                                                            'name', side_types.name,
                                                            'location_id', side_types.location_id,
                                                            'sides', (
                                                                SELECT
                                                                    json_agg(
                                                                        json_build_object(
                                                                            'id', sides.id,
                                                                            'side_type_id', sides.side_type_id,
                                                                            'item_id', sides.item_id,
                                                                            'item_sequence', order_side_details.item_sequence,
                                                                            'side_sequence', order_side_details.side_sequence,
                                                                            'name', sides.name,
                                                                            'price', sides.price
                                                                        )
                                                                    )
                                                                FROM
                                                                    restaurant.order_side_details
                                                                    JOIN restaurant.sides ON sides.id = order_side_details.side_id
                                                                WHERE
                                                                    order_side_details.order_id = orders.id
                                                                    AND order_side_details.item_id = order_details.item_id
                                                                    AND sides.side_type_id = side_types.id
                                                                    AND order_side_details.item_sequence = order_details.item_sequence 
                                                            )
                                                        )
                                                    )
                                                FROM
                                                    restaurant.side_types
                                                WHERE
                                                    EXISTS (
                                                        SELECT
                                                            1
                                                        FROM
                                                            restaurant.order_side_details
                                                            JOIN restaurant.sides ON sides.id = order_side_details.side_id
                                                        WHERE
                                                            sides.side_type_id = side_types.id
                                                            AND order_side_details.order_id = orders.id
                                                            AND order_side_details.item_id = order_details.item_id
                                                    )
                                            ) AS side_types
                                        FROM
                                            restaurant.order_details
                                            JOIN inventory.catalogue_details cd ON cd.item_id = order_details.item_id 
                                                AND cd.catalogue_id = $2
                                            JOIN inventory.items i ON i.id = cd.item_id
                                            LEFT JOIN inventory.units u ON u.id = i.unit_id
                                            LEFT JOIN inventory.item_types it ON it.id = i.item_type_id
                                            LEFT JOIN inventory.item_categories ic ON ic.id = i.item_category_id
                                            LEFT JOIN inventory.item_categories cat ON cat.id = cd.category_id
                                            LEFT JOIN finances.account_categories ac ON ac.id = i.account_category_id
                                            LEFT JOIN inventory.items parent_item ON parent_item.id = i.parent_id
                                            LEFT JOIN finances.tax_types tt ON tt.id = i.tax_type_id
                                            LEFT JOIN common.users discount_user ON discount_user.use_id = order_details.discount_authorized_by
                                            LEFT JOIN restaurant.promotions promo ON promo.id = order_details.promotion_id
                                            LEFT JOIN inventory.items combo_item ON combo_item.id = order_details.combo_item_id
                                        WHERE
                                            order_details.order_id = orders.id
                                        ORDER BY 
                                            order_details.item_sequence ASC
                                    ) t_1
                            ) AS order_details
                        FROM
                            restaurant.orders
                            JOIN restaurant.order_states ON order_states.id = orders.state_id
                            JOIN restaurant.order_types ON order_types.id = orders.type_id
                            LEFT JOIN common.users ON users.use_id = orders.user_id
                        WHERE
                            orders.account_id = accounts.id
                            AND EXISTS (
                                SELECT 1 
                                FROM restaurant.order_details 
                                WHERE order_details.order_id = orders.id
                            )
                        ORDER BY
                            orders.created_at DESC
                    ) t
            ) AS orders
        FROM
            restaurant.accounts
            LEFT JOIN restaurant.waiter ON waiter.id = accounts.waiter_id
            LEFT JOIN finances.entities e ON accounts.customer_id = e.id
            LEFT JOIN finances.invoices i ON i.id = accounts.invoice_id
            LEFT JOIN common.users taker ON taker.use_id = accounts.user_id
            LEFT JOIN common.users driver ON driver.use_id = accounts.assigned_driver_id
            LEFT JOIN common.users acceptor ON acceptor.use_id = accounts.accepted_by
            LEFT JOIN common.users biller ON biller.use_id = i.created_by
            LEFT JOIN restaurant.account_states ON account_states.id = accounts.state_id
            LEFT JOIN restaurant.account_service_status ass ON ass.id = accounts.status_tracker_id
            LEFT JOIN human_resource.locations ON locations.id = accounts.location_id
            LEFT JOIN human_resource.business_units bu ON bu.id = locations.business_unit_id
        WHERE accounts.id = $1
            AND accounts.customer_id = $3;
      `;

      const rows = await query<any>(detailQuery, [accountId, catalogueId, u.entity_id]);

      if (!rows[0])
        throw Object.assign(new Error("Orden no encontrada"), {
          statusCode: 404,
          code: "ORDER_NOT_FOUND",
        });

      const account = rows[0];
      if (account.orders === null) {
        account.orders = [];
      }

      return { success: true, data: account };
    },
  );
}
