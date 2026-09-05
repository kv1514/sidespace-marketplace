"use client";
import { useEffect, useState } from "react";
import { addCalendarDays, calendarToday } from "@/lib/listings/availability";
import { bookingDateLabel, type BookingListing, type BookingQuote } from "@/lib/listings/booking";
import { createClient } from "@/lib/supabase/client";
import { AvailabilityCalendar } from "./AvailabilityCalendar";
import { formatCents } from "@/lib/payments/fees";
import { useT } from "@/lib/i18n/client";

export function BookingPriceSummary({ quote }: { quote: BookingQuote }) {
  const t = useT();
  return <div className="booking-price-summary" aria-live="polite">
    <strong>{bookingDateLabel(quote.timingKind, quote.startDate, quote.endDate)}</strong>
    <dl>{quote.pricingKind && quote.pricingKind !== "fixed" && <div><dt>{t("Rate")}</dt><dd>{formatCents(quote.rateCents)} / {quote.pricingKind === "30_days" ? t("30 days") : quote.pricingKind}</dd></div>}<div><dt>{t("Subtotal")}</dt><dd>{formatCents(quote.subtotalCents)}</dd></div>
      <div><dt>{t("Service fee")}</dt><dd>{formatCents(quote.buyerFeeCents)}</dd></div>
      <div><dt>{t("Total before tax")}</dt><dd>{formatCents(quote.customerTotalCents)}</dd></div></dl>
    <small>{t("Ad credit and any tax appear at checkout.")}</small>
  </div>;
}

export function BookingFields({ listing, quoteRequired = true, onChange }: {
  listing: BookingListing; quoteRequired?: boolean;
  onChange?: (selection: { start: string; end: string; quote: BookingQuote | null }) => void;
}) {
  const t = useT();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [availability, setAvailability] = useState<{ dates: string[]; error: string } | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [result, setResult] = useState<{ key: string; quote: BookingQuote | null; error: string } | null>(null);
  const [reload, setReload] = useState(0);

  const deadline = listing.timing_kind === "deadline";
  const fixed = quoteRequired && (Boolean(listing.timing_kind && listing.pricing_kind === "fixed") || (!listing.timing_kind && listing.instant_booking_enabled));
  const lastDay = deadline ? start : fixed && start ? addCalendarDays(start, (listing.booking_duration_days ?? 1) - 1) : end;
  const today = calendarToday(listing.booking_timezone);
  const minimum = quoteRequired ? [addCalendarDays(today, listing.lead_time_days ?? 0), listing.available_from || ""].sort().at(-1)! : today;
  const maximum = [addCalendarDays(today, 365), ...(quoteRequired && listing.available_to ? [listing.available_to] : [])].sort()[0];
  const requestKey = JSON.stringify([listing.id,listing.updated_at,start,lastDay,quoteRequired,reload]);
  const quote = result?.key === requestKey ? result.quote : null;
  const error = result?.key === requestKey ? result.error : "";
  const loading = quoteRequired && !!start && !!lastDay && !!listing.id && result?.key !== requestKey;
  useEffect(() => { onChange?.({ start, end: lastDay, quote }); }, [start, lastDay, quote, onChange]);
  useEffect(() => {
    if (!quoteRequired || !start || !lastDay || !listing.id) return;
    const controller = new AbortController();
    fetch("/api/listings/quote", { method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ listingId: listing.id, startDate: start, endDate: lastDay, listingUpdatedAt: listing.updated_at }) })
      .then(async (response) => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "Couldn’t calculate this booking."); return data; })
      .then((data) => { if (!controller.signal.aborted) setResult({ key:requestKey,quote:data,error:"" }); })
      .catch((reason) => { if (!controller.signal.aborted) setResult({key:requestKey,quote:null,error: t(reason.message || "Couldn’t load the price. Try again.")}); });
    return () => controller.abort();
  }, [start, lastDay, listing.id, listing.updated_at, quoteRequired, reload, requestKey, t]);
  useEffect(() => {
    if (!calendarOpen || !listing.instant_booking_enabled || !listing.id) return;
    let active = true;
    createClient().rpc("listing_available_dates", { target_listing_id: listing.id })
      .then(({data,error}: {data: string[] | null; error: unknown}) => { if (active) setAvailability({ dates: data ?? [], error: error ? t("Couldn’t load open dates. Choose dates below to check availability.") : "" }); })
      .catch(() => { if (active) setAvailability({ dates: [], error: t("Couldn’t load open dates. Choose dates below to check availability.") }); });
    return () => { active = false; };
  }, [calendarOpen, listing.id, listing.updated_at, listing.instant_booking_enabled, reload, t]);
  return <div className="booking-fields field-wide">
    {listing.instant_booking_enabled && <details className="composer-options booking-calendar" onToggle={(event) => setCalendarOpen(event.currentTarget.open)}>
      <summary>{t("See available dates")}</summary>
      {!availability ? <p role="status">{t("Loading open dates…")}</p> : availability.error ? <p role="alert">{availability.error}</p> : !availability.dates.length ? <p>{t("No open dates right now. You can make a custom offer.")}</p> : <>
        <p>{deadline ? t("Choose a delivery date.") : fixed ? t("Choose a start date.") : start && !end ? t("Now choose the end date.") : t("Choose a start date, then an end date.")}</p>
        <AvailabilityCalendar minimum={minimum} maximum={maximum} allowed={availability.dates} selected={[start,lastDay].filter(Boolean)}
          onChange={([day]) => { if (!day) return; if (deadline || fixed) setStart(day); else if (start && !end && day >= start) setEnd(day); else { setStart(day); setEnd(""); } }} />
      </>}
    </details>}
    <div className="field-grid"><label>{deadline ? t("Deliver by") : t("Start date")}
      <input name="start_date" type="date" min={minimum} max={maximum} required value={start}
        onChange={(event) => { setStart(event.target.value); }} /></label>
      {!deadline && !fixed ? <label>{t("End date")}<input name="end_date" type="date" min={start || minimum} max={maximum} required value={end}
        onChange={(event) => { setEnd(event.target.value); }} /></label> : <input type="hidden" name="end_date" value={lastDay} />}
    </div>
    {!deadline && fixed && start && <p>{bookingDateLabel("date_range", start, lastDay)}</p>}
    {loading && <p role="status">{t("Checking dates and price…")}</p>}
    {error && <div className="field-error" role="alert">{error} <button type="button" onClick={() => setReload((value) => value + 1)}>{t("Try again")}</button></div>}
    {quote && <BookingPriceSummary quote={quote} />}
    <input type="hidden" name="quote_subtotal" value={quote?.subtotalCents ?? ""} />
    <input type="hidden" name="quote_version" value={quote?.listingUpdatedAt ?? ""} />
  </div>;
}
