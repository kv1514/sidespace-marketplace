export type BookingSchedule = {
  instant_booking_enabled?: boolean;
  availability_dates?: string[];
  booking_duration_days?: number;
  booking_timezone?: string;
  lead_time_days?: number;
};

export function calendarToday(timeZone = "UTC", now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export function addCalendarDays(day: string, count: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export function validCalendarDay(day: unknown): day is string {
  return typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) &&
    Number.isFinite(Date.parse(`${day}T12:00:00Z`)) && addCalendarDays(day, 0) === day;
}

export function availableStartDates(schedule: BookingSchedule, now = new Date()) {
  if (!Number.isInteger(schedule.lead_time_days ?? 0) || (schedule.lead_time_days ?? 0) < 0 || (schedule.lead_time_days ?? 0) > 365) return [];
  const today = calendarToday(schedule.booking_timezone, now);
  const minimum = addCalendarDays(today, schedule.lead_time_days ?? 0);
  const maximum = addCalendarDays(today, 365);
  const dates = new Set(schedule.availability_dates ?? []);
  const duration = schedule.booking_duration_days ?? 1;
  if (!Number.isInteger(duration) || duration < 1 || duration > 365) return [];
  return [...dates].filter((day) => validCalendarDay(day) && day >= minimum &&
    addCalendarDays(day, duration - 1) <= maximum &&
    Array.from({ length: duration }, (_, index) => addCalendarDays(day, index))
      .every((date) => dates.has(date))).sort();
}
