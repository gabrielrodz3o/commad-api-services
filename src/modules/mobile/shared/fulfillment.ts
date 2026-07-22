export function resolveFulfillmentAt(scheduledFor?: string | null, now = new Date()) {
  if (!scheduledFor) return { date: now, scheduled: false };
  const date = new Date(scheduledFor), delta = date.getTime() - now.getTime();
  if (!Number.isFinite(date.getTime()) || delta < 30 * 60_000 || delta > 7 * 86400_000) {
    throw Object.assign(new Error("El pedido programado debe ser entre 30 minutos y 7 días"), { statusCode: 400, code: "INVALID_SCHEDULE" });
  }
  return { date, scheduled: true };
}
