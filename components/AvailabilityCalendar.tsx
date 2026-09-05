"use client";

import { useId, useState } from "react";
import { addCalendarDays, calendarToday, type BookingSchedule } from "@/lib/listings/availability";
import { useLocale, useT } from "@/lib/i18n/client";
import { LOCALE_TAGS } from "@/lib/i18n/locales";

export function AvailabilityCalendar({ selected, onChange, minimum, maximum, allowed, multiple = false }: {
  selected: string[]; onChange: (dates: string[]) => void; minimum: string; maximum: string;
  allowed?: string[]; multiple?: boolean;
}) {
  const t = useT();
  const tag = LOCALE_TAGS[useLocale()];
  const heading = useId();
  const [month, setMonth] = useState((selected.find((date) => date >= minimum) ?? minimum).slice(0, 7));
  const first = `${month}-01`;
  const start = new Date(`${first}T12:00:00Z`).getUTCDay();
  const count = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  const title = new Date(`${first}T12:00:00Z`).toLocaleDateString(tag, { month: "long", year: "numeric", timeZone: "UTC" });
  // 2023-01-01 was a Sunday; the grid starts on Sunday.
  const weekdays = Array.from({ length: 7 }, (_, index) => new Date(Date.UTC(2023, 0, 1 + index)).toLocaleDateString(tag, { weekday: "short", timeZone: "UTC" }));
  const previous = addCalendarDays(first, -1).slice(0, 7);
  const next = addCalendarDays(first, count).slice(0, 7);
  const usable = (date: string) => date >= minimum && date <= maximum && (!allowed || allowed.includes(date));
  const monthDates = Array.from({ length: count }, (_, index) => addCalendarDays(first, index)).filter(usable);
  return <div className="availability-calendar" aria-labelledby={heading}>
    <div className="availability-calendar-nav">
      <button type="button" aria-label={t("Previous month")} disabled={previous < minimum.slice(0, 7)} onClick={() => setMonth(previous)}>‹</button>
      <strong id={heading} aria-live="polite">{title}</strong>
      <button type="button" aria-label={t("Next month")} disabled={next > maximum.slice(0, 7)} onClick={() => setMonth(next)}>›</button>
    </div>
    <div className="availability-calendar-grid">
      {weekdays.map((day) => <span className="calendar-weekday" key={day}>{day}</span>)}
      {Array.from({ length: start }, (_, index) => <span key={`blank-${index}`} />)}
      {Array.from({ length: count }, (_, index) => {
        const date = addCalendarDays(first, index);
        return <button key={date} type="button" disabled={!usable(date)} aria-pressed={selected.includes(date)}
          aria-label={new Date(`${date}T12:00:00Z`).toLocaleDateString(tag, { dateStyle: "full", timeZone: "UTC" })}
          onClick={() => onChange(multiple ? selected.includes(date) ? selected.filter((item) => item !== date) : [...selected, date].sort() : [date])}>{index + 1}</button>;
      })}
    </div>
    {multiple && <div className="availability-calendar-shortcuts">
      <button type="button" onClick={() => onChange([...new Set([...selected, ...monthDates])].sort())}>{t("Select month")}</button>
      <button type="button" onClick={() => onChange([...new Set([...selected, ...monthDates.filter((date) => ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay()))])].sort())}>{t("Weekdays")}</button>
      <button type="button" onClick={() => onChange(selected.filter((date) => !date.startsWith(month)))}>{t("Clear month")}</button>
    </div>}
  </div>;
}

export function ListingAvailabilityFields({ listing = {}, onChange }: {
  listing?: BookingSchedule; onChange?: (value: BookingSchedule) => void;
}) {
  const t = useT();
  const [enabled, setEnabled] = useState(listing.instant_booking_enabled ?? false);
  const [timeZone] = useState(listing.booking_timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const today = calendarToday(timeZone);
  const maximum = addCalendarDays(today, 365);
  const [dates, setDates] = useState((listing.availability_dates ?? []).filter((day) => day >= today && day <= maximum));
  const [duration, setDuration] = useState(listing.booking_duration_days ?? 1);
  function update(next: Partial<BookingSchedule>) {
    onChange?.({ instant_booking_enabled: enabled, availability_dates: dates, booking_duration_days: duration, booking_timezone: timeZone, ...next });
  }
  return <section className="listing-availability field-wide">
    <label className="instant-booking-toggle">
      <span><strong>{t("Let businesses book instantly")}</strong><small>{t("Set your dates once. Buyers choose a date and check out.")}</small></span>
      <input type="checkbox" name="instant_booking_enabled" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); update({ instant_booking_enabled: event.target.checked }); }} />
    </label>
    <input type="hidden" name="availability_dates" value={JSON.stringify(dates)} />
    <input type="hidden" name="booking_timezone" value={timeZone} />
    <input type="hidden" name="booking_duration_days" value={enabled ? duration : 1} />
    {enabled && <div className="listing-availability-body">
      <label>{t("Days included in one package")}
        <small>{t("Your listed price covers this entire booking. Only one business can book these dates.")}</small>
        <input type="number" min={1} max={365} required value={duration} onChange={(event) => { const value = Number(event.target.value); setDuration(value); update({ booking_duration_days: value }); }} />
      </label>
      <p>{t("Select every day you can deliver, up to one year ahead. For a longer package, select consecutive days.")}</p>
      <AvailabilityCalendar multiple selected={dates} minimum={today} maximum={maximum} onChange={(value) => { setDates(value); update({ availability_dates: value }); }} />
      <div className="calendar-legend"><span><i />{" "}{t("Available")}</span><span>{t("{count} days selected · {timeZone}", { count: dates.length, timeZone: timeZone.replaceAll("_", " ") })}</span></div>
      <p className="instant-booking-commitment">{t("By enabling this, you agree to fulfill paid bookings on these dates at your fixed price, with the deliverables and cancellation terms below. Finish payout setup before buyers can pay. Calendar changes affect new bookings; existing bookings stay reserved.")}</p>
    </div>}
  </section>;
}
