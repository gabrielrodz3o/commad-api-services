import { query } from "../../../db/pool.js";
export async function getMobileApp(slug: string) {
  const rows = await query<any>(
    `SELECT bu.id,bu.company_id,bu.description_long,bu.mobile_app_slug,bu.mobile_app_config,bu.image_storage,bu.color FROM human_resource.business_units bu WHERE bu.mobile_app_enabled=TRUE AND bu.mobile_app_slug=$1 LIMIT 1`,
    [slug],
  );
  if (!rows[0]) return null;
  const locations = await query<any>(
    `SELECT l.id,l.description_short name,l.description_long description,l.address,l.phone,
       l.use_delivery,l.use_pickup,l.use_zone_delivery,l.service_radius_km,c.id catalogue_id,
       COALESCE((SELECT json_agg(json_build_object('id',pt.id,'name',pt.name,'icon',pt.icon,'color',pt.color) ORDER BY pt.id)
         FROM finances.location_payment_types lpt
         JOIN finances.invoice_payment_types pt ON pt.id=lpt.payment_type_id
         WHERE lpt.location_id=l.id AND lpt.is_active=TRUE AND pt.id IN(1,2,4)),'[]'::json) payment_methods
     FROM human_resource.locations l
     LEFT JOIN inventory.catalogues c ON c.location_id=l.id
     WHERE l.business_unit_id=$1 AND l.status_id=1 ORDER BY l.id`,
    [rows[0].id],
  );
  return { ...rows[0], locations };
}
