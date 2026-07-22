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
  return { ...rows[0], locations: locations.map((location: any) => {
    const storeOpen = isScheduleOpen({ start: location.shopping_start_time, end: location.shopping_end_time });
    const zones = (location.delivery_zones ?? []).map((zone: any) => ({
      ...zone,
      available_now: storeOpen && isScheduleOpen({ start: zone.active_from, end: zone.active_until, days: zone.active_days }),
      schedule_label: scheduleLabel(zone.active_from ?? location.shopping_start_time, zone.active_until ?? location.shopping_end_time),
    }));
    return { ...location, open_now: storeOpen, schedule_label: scheduleLabel(location.shopping_start_time, location.shopping_end_time), delivery_zones: zones };
  }) };
}
