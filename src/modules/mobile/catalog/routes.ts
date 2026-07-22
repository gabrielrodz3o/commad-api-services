import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../../../db/pool.js";
import { requireLocation, resolveMobileApp } from "../shared/context.js";
import { getMobileProducts } from "./products.js";
const context = async (slug: string, locationId: number) => {
  const c = await resolveMobileApp(slug);
  if (!c)
    throw Object.assign(new Error("Aplicación no disponible"), {
      statusCode: 404,
    });
  const l = await requireLocation(c, locationId);
  if (!l)
    throw Object.assign(new Error("Sucursal no disponible"), {
      statusCode: 404,
    });
  return l;
};
export function mobileCatalogRoutes(app: FastifyInstance) {
  app.get<{ Params: { slug: string }; Querystring: any }>(
    "/v1/mobile/apps/:slug/catalog",
    async (req) => {
      const q = z
          .object({
            location_id: z.coerce.number().int().positive(),
            catalogue_id: z.coerce.number().int().positive().optional(),
          })
          .parse(req.query),
        l = await context(req.params.slug, q.location_id),
        catalogueId = q.catalogue_id ?? Number(l.catalogue_id);
      const menus = await query<any>(
          `SELECT m.*,ARRAY_AGG(DISTINCT cd.category_id)item_category_id FROM restaurant.menus m JOIN restaurant.menu_details md ON md.menu_id=m.id JOIN inventory.items i ON i.id=md.item_id AND i.active=TRUE JOIN inventory.catalogue_details cd ON cd.item_id=i.id AND cd.catalogue_id=$2 AND cd.status_id=1 JOIN inventory.item_categories ic ON ic.id=cd.category_id AND ic.is_visible=TRUE AND ic.is_supply IS NOT TRUE WHERE m.active=TRUE AND m.location_id=$1 AND(m.from_date IS NULL OR m.from_date<=(NOW() AT TIME ZONE 'America/Santo_Domingo')::date)AND(m.to_date IS NULL OR m.to_date>=(NOW() AT TIME ZONE 'America/Santo_Domingo')::date)AND(m.available_days IS NULL OR jsonb_array_length(m.available_days::jsonb)=0 OR m.available_days::jsonb@>to_jsonb(EXTRACT(ISODOW FROM NOW() AT TIME ZONE 'America/Santo_Domingo')::int))AND(m.from_time IS NULL OR m.to_time IS NULL OR(m.from_time<=m.to_time AND (NOW() AT TIME ZONE 'America/Santo_Domingo')::time BETWEEN m.from_time AND m.to_time)OR(m.from_time>m.to_time AND((NOW() AT TIME ZONE 'America/Santo_Domingo')::time>=m.from_time OR(NOW() AT TIME ZONE 'America/Santo_Domingo')::time<=m.to_time)))GROUP BY m.id ORDER BY m.name`,
        [q.location_id, catalogueId],
      );
      const menuIds = menus.map((x) => Number(x.id));
      const orderTypeId: 2 | 3 = l.use_delivery ? 3 : 2;
      const rows = await Promise.all(menuIds.map((menuId) => getMobileProducts({ menuId, catalogueId, locationId: q.location_id, orderTypeId })));
      const products = [...new Map(rows.flat().map((product) => [`${product.menu_id}:${product.item_id}`, product])).values()];
      const promotions = products.length
        ? await query<any>(
            `SELECT DISTINCT ON(COALESCE(pi.item_id,0))
               COALESCE(pi.item_id,0) item_id,p.id,p.code,p.name,p.promotion_type type,
               p.discount_percentage,p.discount_amount,p.max_discount_amount,
               COALESCE(pi.required_quantity,1) required_quantity,
               COALESCE(pi.reward_quantity,1) reward_quantity
             FROM restaurant.promotions p
             LEFT JOIN restaurant.promotion_items pi ON pi.promotion_id=p.id
             WHERE p.is_active=TRUE AND COALESCE(p.is_employee_benefit,FALSE)=FALSE
               AND (NOW() AT TIME ZONE 'America/Santo_Domingo')::date BETWEEN p.start_date::date AND p.end_date::date
               AND (p.location_id IS NULL OR p.location_id=$1)
               AND (p.max_uses_total IS NULL OR p.current_uses<p.max_uses_total)
               AND (pi.item_id=ANY($2::int[]) OR (p.applies_to_all_items=TRUE AND pi.item_id IS NULL))
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
             ORDER BY COALESCE(pi.item_id,0),p.priority DESC,p.id`,
            [q.location_id, products.map((x) => Number(x.item_id))],
          )
        : [];
      const general = promotions.find((x) => Number(x.item_id) === 0);
      const byItem = new Map(promotions.map((x) => [Number(x.item_id), x]));
      const catalogProducts = products.map((product) => {
        const promotion = byItem.get(Number(product.item_id)) ?? general;
        if (!promotion) return product;
        const price = Number(product.sale_price);
        const discount = promotion.type === 'DISCOUNT_PERCENTAGE'
          ? Math.min(price * Number(promotion.discount_percentage ?? 0) / 100, Number(promotion.max_discount_amount ?? price))
          : promotion.type === 'DISCOUNT_FIXED' ? Math.min(price, Number(promotion.discount_amount ?? 0)) : 0;
        return { ...product, has_active_promotion: true, active_promotion: promotion, discounted_price: Math.max(0, price - discount) };
      });
      return {
        success: true,
        data: {
          location: {
            id: Number(l.id),
            name: l.description_long,
            catalogue_id: catalogueId,
          },
          menus,
          products: catalogProducts,
        },
      };
    },
  );
  app.get<{ Params: { slug: string; comboId: string }; Querystring: any }>(
    "/v1/mobile/apps/:slug/catalog/combos/:comboId",
    async (req) => {
      const q = z
        .object({ location_id: z.coerce.number().int().positive(), catalogue_id: z.coerce.number().int().positive() })
        .parse(req.query);
      await context(req.params.slug, q.location_id);
      const slots = await query<any>(
        `SELECT s.id,s.name,s.sequence,s.is_required,COALESCE(json_agg(json_build_object('id',o.id,'item_id',o.item_id,'item_name',i.name,'item_type_id',i.item_type_id,'price_delta',o.price_delta,'sequence',o.sequence)ORDER BY o.sequence,o.id)FILTER(WHERE o.id IS NOT NULL),'[]'::json)options FROM restaurant.combo_slots s LEFT JOIN restaurant.combo_slot_options o ON o.slot_id=s.id LEFT JOIN inventory.items i ON i.id=o.item_id WHERE s.combo_item_id=$1 AND s.deleted_at IS NULL AND EXISTS(SELECT 1 FROM inventory.catalogue_details cd JOIN restaurant.menu_details md ON md.item_id=cd.item_id JOIN restaurant.menus m ON m.id=md.menu_id WHERE cd.item_id=s.combo_item_id AND cd.catalogue_id=$2 AND cd.status_id=1 AND m.location_id=$3 AND m.active=TRUE) GROUP BY s.id ORDER BY s.sequence,s.id`,
        [Number(req.params.comboId), q.catalogue_id, q.location_id],
      );
      return { success: true, data: { slots } };
    },
  );
}
