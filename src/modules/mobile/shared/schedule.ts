const TIME_ZONE = "America/Santo_Domingo";

const clock = (at = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const days: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const hour = Number(value("hour")) % 24;
  return { isoDay: days[value("weekday")] ?? 1, minutes: hour * 60 + Number(value("minute")) };
};

const minutes = (time?: string | null) => {
  if (!time) return null;
  const [hour, minute] = String(time).split(":").map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
};

export const normalizeDays = (value: unknown): number[] => {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) ? value.map(Number).filter((day) => day >= 1 && day <= 7) : [];
};

export function isScheduleOpen(schedule: { start?: string | null; end?: string | null; days?: unknown }, at = new Date()) {
  const now = clock(at);
  const days = normalizeDays(schedule.days);
  if (days.length && !days.includes(now.isoDay)) return false;
  const start = minutes(schedule.start), end = minutes(schedule.end);
  if (start == null && end == null) return true;
  if (start == null) return now.minutes < end!;
  if (end == null) return now.minutes >= start;
  return start <= end ? now.minutes >= start && now.minutes < end : now.minutes >= start || now.minutes < end;
}

export const scheduleLabel = (start?: string | null, end?: string | null) => {
  const short = (value?: string | null) => value ? String(value).slice(0, 5) : "";
  if (!start && !end) return "Disponible ahora";
  if (start && end) return `${short(start)}–${short(end)}`;
  return start ? `Desde ${short(start)}` : `Hasta ${short(end)}`;
};
