import { query } from "../../../db/pool.js";
import { isScheduleOpen, scheduleLabel } from "../shared/schedule.js";
export async function getMobileApp(slug: string) {
  const rows = await query<any>(
    `SELECT bu.id,bu.company_id,bu.description_long,bu.mobile_app_slug,bu.mobile_app_config,bu.image_storage,bu.color FROM human_resource.business_units bu WHERE bu.mobile_app_enabled=TRUE AND bu.mobile_app_slug=$1 LIMIT 1`,
    [slug],
  );
  if (!rows[0]) return null;
  const locations = await query<any>(
    `SELECT l.id,l.description_short name,l.description_long description,l.address,l.phone,
       l.use_delivery,l.use_pickup,l.use_zone_delivery,l.service_radius_km,l.shopping_start_time,l.shopping_end_time,c.id catalogue_id,
       CASE WHEN l.location_point IS NOT NULL THEN(l.location_point)[1]END latitude,
       CASE WHEN l.location_point IS NOT NULL THEN(l.location_point)[0]END longitude,
       COALESCE((SELECT json_agg(json_build_object('id',dz.id,'name',dz.name,'price',dz.price,
         'polygon',dz.polygon,'color',dz.color,'provincia_id',dz.provincia_id,
         'municipio_id',dz.municipio_id,'sectors',COALESCE(dz.sectors,'[]'::jsonb),
         'active_from',dz.active_from,'active_until',dz.active_until,'active_days',dz.active_days) ORDER BY dz.id)
         FROM restaurant.delivery_zones dz WHERE dz.location_id=l.id AND dz.status_id=1
           AND dz.deleted_at IS NULL AND dz.polygon IS NOT NULL),'[]'::json) delivery_zones,
       COALESCE((SELECT json_agg(json_build_object('id',pt.id,'name',pt.name,'icon',pt.icon,'color',pt.color) ORDER BY pt.id)
         FROM finances.location_payment_types lpt
         JOIN finances.invoice_payment_types pt ON pt.id=lpt.payment_type_id
         WHERE lpt.location_id=l.id AND lpt.is_active=TRUE AND pt.id IN(1,2,4)),'[]'::json) payment_methods
     FROM human_resource.locations l
     LEFT JOIN inventory.catalogues c ON c.location_id=l.id
     WHERE l.business_unit_id=$1 AND l.status_id=1 ORDER BY l.id`,
    [rows[0].id],
  );
  const campaigns = await query<any>(
    `SELECT p.id,p.code,p.name,p.description,p.promotion_type,p.discount_percentage,p.discount_amount,
            p.banner_url,p.banner_alt_text,p.mobile_cta_label,p.location_id,p.start_date,p.end_date,p.start_time,p.end_time,
            COALESCE((SELECT json_agg(pi.item_id ORDER BY pi.item_id) FROM restaurant.promotion_items pi WHERE pi.promotion_id=p.id),'[]'::json) item_ids
       FROM restaurant.promotions p
       JOIN human_resource.locations l ON l.id=p.location_id
      WHERE l.business_unit_id=$1 AND p.is_active=TRUE AND COALESCE(p.is_employee_benefit,FALSE)=FALSE
        AND COALESCE(p.show_in_mobile,FALSE)=TRUE AND p.banner_url IS NOT NULL
        AND (NOW() AT TIME ZONE 'America/Santo_Domingo')::date BETWEEN p.start_date::date AND p.end_date::date
        AND (p.max_uses_total IS NULL OR p.current_uses<p.max_uses_total)
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
      ORDER BY p.priority DESC,p.id DESC LIMIT 12`,
    [rows[0].id],
  );
  const loyaltyRows = await query<any>(
    `SELECT p.is_active,p.currency_amount_per_point,p.expiration_days,p.terms,
            COALESCE((SELECT json_agg(json_build_object('id',r.id,'name',r.name,'description',r.description,'points_cost',r.points_cost,'reward_type',r.reward_type,'reward_value',r.reward_value,'item_id',r.item_id,'image_url',r.image_url,'terms',r.terms,'stock',r.stock,'valid_days',r.valid_days) ORDER BY r.points_cost,r.id) FROM finances.customer_loyalty_rewards r WHERE r.business_unit_id=p.business_unit_id AND r.is_active=TRUE AND (r.stock IS NULL OR r.stock>0)),'[]'::json) rewards
       FROM finances.customer_loyalty_programs p WHERE p.business_unit_id=$1`,
    [rows[0].id],
  );
  return { ...rows[0], campaigns, loyalty: loyaltyRows[0]?.is_active ? loyaltyRows[0] : null, locations: locations.map((location: any) => {
    const storeOpen = isScheduleOpen({ start: location.shopping_start_time, end: location.shopping_end_time });
    const zones = (location.delivery_zones ?? []).map((zone: any) => ({
      ...zone,
      available_now: storeOpen && isScheduleOpen({ start: zone.active_from, end: zone.active_until, days: zone.active_days }),
      schedule_label: scheduleLabel(zone.active_from ?? location.shopping_start_time, zone.active_until ?? location.shopping_end_time),
    }));
    return { ...location, open_now: storeOpen, schedule_label: scheduleLabel(location.shopping_start_time, location.shopping_end_time), delivery_zones: zones };
  }) };
}
