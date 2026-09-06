"use client";

import { useId, useState } from "react";
import { addCalendarDays, calendarToday, type BookingSchedule } from "@/lib/listings/availability";
import { useLocale } from "@/app/components/LocaleProvider";

export function AvailabilityCalendar({ selected, onChange, minimum, maximum, allowed, multiple = false }: {
  selected: string[]; onChange: (dates: string[]) => void; minimum: string; maximum: string;
  allowed?: string[]; multiple?: boolean;
}) {
  const { t } = useLocale();
  const heading = useId();
  const [month, setMonth] = useState((selected.find((date) => date >= minimum) ?? minimum).slice(0, 7));
  const first = `${month}-01`;
  const start = new Date(`${first}T12:00:00Z`).getUTCDay();
  const count = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  const title = new Date(`${first}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const previous = addCalendarDays(first, -1).slice(0, 7);
  const next = addCalendarDays(first, count).slice(0, 7);
  const usable = (date: string) => date >= minimum && date <= maximum && (!allowed || allowed.includes(date));
  const monthDates = Array.from({ length: count }, (_, index) => addCalendarDays(first, index)).filter(usable);
  return <div className="availability-calendar" aria-labelledby={heading}>
    <div className="availability-calendar-nav">
      <button type="button" aria-label={t("calendar.previousMonth")} disabled={previous < minimum.slice(0, 7)} onClick={() => setMonth(previous)}>‹</button>
      <strong id={heading} aria-live="polite">{title}</strong>
      <button type="button" aria-label={t("app.nextMonth")} disabled={next > maximum.slice(0, 7)} onClick={() => setMonth(next)}>›</button>
    </div>
    <div className="availability-calendar-grid">
      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span className="calendar-weekday" key={day}>{day}</span>)}
      {Array.from({ length: start }, (_, index) => <span key={`blank-${index}`} />)}
      {Array.from({ length: count }, (_, index) => {
        const date = addCalendarDays(first, index);
        return <button key={date} type="button" disabled={!usable(date)} aria-pressed={selected.includes(date)}
          aria-label={new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { dateStyle: "full", timeZone: "UTC" })}
          onClick={() => onChange(multiple ? selected.includes(date) ? selected.filter((item) => item !== date) : [...selected, date].sort() : [date])}>{index + 1}</button>;
      })}
    </div>
    {multiple && <div className="availability-calendar-shortcuts">
      <button type="button" onClick={() => onChange([...new Set([...selected, ...monthDates])].sort())}>{t("calendar.selectMonth")}</button>
      <button type="button" onClick={() => onChange([...new Set([...selected, ...monthDates.filter((date) => ![0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay()))])].sort())}>{t("calendar.weekdays")}</button>
      <button type="button" onClick={() => onChange(selected.filter((date) => !date.startsWith(month)))}>{t("calendar.clearMonth")}</button>
    </div>}
  </div>;
}

export function ListingAvailabilityFields({ listing = {}, onChange }: {
  listing?: BookingSchedule; onChange?: (value: BookingSchedule) => void;
}) {
  const { t } = useLocale();
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
      <span><strong>{t("calendar.letBusinessesBookInstantly")}</strong><small>{t("calendar.setYourDatesOnceBuyersChooseA")}</small></span>
      <input type="checkbox" name="instant_booking_enabled" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); update({ instant_booking_enabled: event.target.checked }); }} />
    </label>
    <input type="hidden" name="availability_dates" value={JSON.stringify(dates)} />
    <input type="hidden" name="booking_timezone" value={timeZone} />
    <input type="hidden" name="booking_duration_days" value={enabled ? duration : 1} />
    {enabled && <div className="listing-availability-body">
      <label>{t("calendar.daysIncludedInOnePackage")}
        <small>{t("calendar.yourListedPriceCoversThisEntireBooking")}</small>
        <input type="number" min={1} max={365} required value={duration} onChange={(event) => { const value = Number(event.target.value); setDuration(value); update({ booking_duration_days: value }); }} />
      </label>
      <p>{t("calendar.selectEveryDayYouCanDeliverUp")}</p>
      <AvailabilityCalendar multiple selected={dates} minimum={today} maximum={maximum} onChange={(value) => { setDates(value); update({ availability_dates: value }); }} />
      <div className="calendar-legend"><span><i />{" "}{t("calendar.available")}</span><span>{t("calendar.datescountDaysSelectedReplaceall", { datesCount: dates.length, replaceAll: timeZone.replaceAll("_", " ") })}</span></div>
      <p className="instant-booking-commitment">{t("calendar.byEnablingThisYouAgreeToFulfill")}</p>
    </div>}
  </section>;
}
