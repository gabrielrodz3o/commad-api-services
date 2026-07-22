import { query } from "../../../db/pool.js";
import { isScheduleOpen, scheduleLabel } from "../shared/schedule.js";

type Point = { lat: number; lng: number };

function normalizePolygon(value: unknown): Point[] {
  let raw = value;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((p: any) => ({ lat: Number(p?.lat), lng: Number(p?.lng) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

function contains(point: Point, polygon: Point[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (((a.lat > point.lat) !== (b.lat > point.lat))
      && point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}

export async function resolveMobileCoverage(businessUnitId: number, latitude: number, longitude: number) {
  const zones = await query<any>(
    `SELECT dz.id zone_id,dz.location_id,dz.name zone_name,dz.price,
            dz.provincia_id,dz.municipio_id,dz.sectors,dz.polygon,
            dz.active_from,dz.active_until,dz.active_days,
            l.description_long location_name,l.shopping_start_time,l.shopping_end_time,c.id catalogue_id
       FROM restaurant.delivery_zones dz
       JOIN human_resource.locations l ON l.id=dz.location_id
       LEFT JOIN inventory.catalogues c ON c.location_id=l.id
      WHERE l.business_unit_id=$1 AND l.status_id=1
        AND dz.status_id=1 AND dz.deleted_at IS NULL AND dz.polygon IS NOT NULL`,
    [businessUnitId],
  );
  const match = zones.find((zone) => {
    const polygon = normalizePolygon(zone.polygon);
    return polygon.length >= 3 && contains({ lat: latitude, lng: longitude }, polygon);
  });
  if (!match) return null;
  const zoneOpen = isScheduleOpen({ start: match.active_from, end: match.active_until, days: match.active_days });
  const storeOpen = isScheduleOpen({ start: match.shopping_start_time, end: match.shopping_end_time });
  return {
    within_coverage: true,
    location_id: Number(match.location_id),
    location_name: match.location_name,
    catalogue_id: match.catalogue_id == null ? null : Number(match.catalogue_id),
    zone_id: Number(match.zone_id),
    zone_name: match.zone_name,
    zone_price: Number(match.price ?? 0),
    available_now: zoneOpen && storeOpen,
    zone_open_now: zoneOpen,
    store_open_now: storeOpen,
    schedule_label: scheduleLabel(match.active_from ?? match.shopping_start_time, match.active_until ?? match.shopping_end_time),
    provincia_id: match.provincia_id == null ? null : Number(match.provincia_id),
    municipio_id: match.municipio_id == null ? null : Number(match.municipio_id),
    sectors: Array.isArray(match.sectors) ? match.sectors : [],
  };
}
