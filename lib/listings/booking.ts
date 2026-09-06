import { addCalendarDays, calendarToday, validCalendarDay, type BookingSchedule } from "./availability";
import { calculatePaymentBreakdown } from "../payments/fees";
import { DEFAULT_LOCALE, localeTag, translateEnglish, type Locale, type Translate } from "../i18n";

export type TimingKind = "deadline" | "date_range";
export type PricingKind = "fixed" | "day" | "week" | "30_days";
export type BookingListing = BookingSchedule & {
  id?: string; updated_at?: string; price_cents: number; price_max_cents?: number | null;
  available_from?: string | null; available_to?: string | null;
};
export type BookingQuote = ReturnType<typeof quoteBooking>;

export function calendarDayCount(start: string, end: string) {
  if (!validCalendarDay(start) || !validCalendarDay(end) || end < start) throw new Error("Choose valid dates in order.");
  return Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86400000) + 1;
}

export function bookingDateLabel(kind: TimingKind | null | undefined, start: string, end: string, t: Translate = translateEnglish, locale: Locale = DEFAULT_LOCALE) {
  const tag = localeTag(locale);
  const date = (day: string) => new Date(`${day}T12:00:00Z`);
  const label = (day: string) => date(day).toLocaleDateString(tag, { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  if (!validCalendarDay(start) || !validCalendarDay(end)) return t("booking.chooseADate");
  if (kind === "deadline") return t("booking.deliverBy", { date: label(end) });
  const days = calendarDayCount(start, end);
  const range = start === end ? label(start) : start.slice(0,7) === end.slice(0,7)
    ? `${date(start).toLocaleDateString(tag, { month: "long", day: "numeric", timeZone: "UTC" })}–${Number(end.slice(8))}, ${end.slice(0,4)}`
    : `${label(start)} – ${label(end)}`;
  return days === 1 ? t("booking.rangeOneDay", { range }) : t("booking.rangeDays", { range, count: days });
}

export function pricingLabel(listing: BookingSchedule & { price_unit?: string }) {
  return listing.pricing_kind === "30_days" ? "30 days" : listing.pricing_kind === "fixed" ? (listing.timing_kind === "deadline" ? "delivery" : "package") : listing.pricing_kind || listing.price_unit || "package";
}

/** Money is rounded once after multiplying the complete interval, never per day. */
export function proratedSubtotal(rateCents: number, days: number, pricing: PricingKind | null | undefined) {
  if (!Number.isSafeInteger(rateCents) || rateCents <= 0 || !Number.isInteger(days) || days < 1 || days > 366) throw new Error("Enter a valid price and duration.");
  const denominator = BigInt(pricing === "week" ? 7 : pricing === "30_days" ? 30 : 1);
  const numerator = BigInt(rateCents) * BigInt(!pricing || pricing === "fixed" ? 1 : days);
  const cents = Number((numerator + denominator / BigInt(2)) / denominator);
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("Choose a longer booking for this rate.");
  return cents;
}

export function quoteBooking(listing: BookingListing, start: string, requestedEnd?: string, now = new Date()) {
  const kind = listing.timing_kind ?? "date_range";
  const fixedDuration = kind === "deadline" ? 1 : listing.booking_duration_days ?? 1;
  const variable = Boolean(listing.pricing_kind && listing.pricing_kind !== "fixed");
  const end = kind === "deadline" ? start : requestedEnd || (!variable && validCalendarDay(start) ? addCalendarDays(start, fixedDuration - 1) : "");
  const days = calendarDayCount(start, end);
  if (kind === "deadline" && requestedEnd && requestedEnd !== start) throw new Error("Choose one delivery deadline.");
  const today = calendarToday(listing.booking_timezone, now);
  if (start < addCalendarDays(today, listing.lead_time_days ?? 0)) throw new Error("Choose a later date to allow the required notice.");
  if (end > addCalendarDays(today, 365)) throw new Error("Choose dates within the next year.");
  if ((listing.available_from && start < listing.available_from) || (listing.available_to && end > listing.available_to)) throw new Error("Choose dates within the listing’s availability.");
  if (listing.timing_kind && !variable && days !== fixedDuration) throw new Error(`This package includes ${fixedDuration} ${fixedDuration === 1 ? "day" : "days"}.`);
  if (!listing.timing_kind && listing.instant_booking_enabled && days !== fixedDuration) throw new Error(`This package includes ${fixedDuration} days.`);
  if (days < (listing.minimum_duration_days ?? 1)) throw new Error(`Choose at least ${listing.minimum_duration_days} days.`);
  if (listing.instant_booking_enabled && Array.from({ length: days }, (_, index) => addCalendarDays(start, index)).some((day) => !listing.availability_dates?.includes(day))) throw new Error("Some of these dates are unavailable. Choose another range.");
  if (listing.price_max_cents != null && listing.price_max_cents > listing.price_cents) throw new Error("Send a custom offer for this price range.");
  const subtotalCents = proratedSubtotal(listing.price_cents, days, listing.pricing_kind);
  const money = calculatePaymentBreakdown(subtotalCents);
  return { timingKind: kind, pricingKind: listing.pricing_kind ?? null, rateCents: listing.price_cents, priceUnit: pricingLabel(listing), startDate: start, endDate: end, days, ...money, listingUpdatedAt: listing.updated_at };
}
