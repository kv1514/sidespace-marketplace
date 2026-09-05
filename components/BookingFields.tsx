"use client";
import { useEffect, useState } from "react";
import { addCalendarDays, calendarToday } from "@/lib/listings/availability";
import { bookingDateLabel, type BookingListing, type BookingQuote } from "@/lib/listings/booking";
import { createClient } from "@/lib/supabase/client";
import { AvailabilityCalendar } from "./AvailabilityCalendar";
import { formatCents } from "@/lib/payments/fees";
import { useLocale } from "@/app/components/LocaleProvider";

export function BookingPriceSummary({ quote }: { quote: BookingQuote }) {
  const { t, locale } = useLocale();
  return <div className="booking-price-summary" aria-live="polite">
    <strong>{bookingDateLabel(quote.timingKind, quote.startDate, quote.endDate, t, locale)}</strong>
    <dl>{quote.pricingKind && quote.pricingKind !== "fixed" && <div><dt>{t("booking.rate")}</dt><dd>{formatCents(quote.rateCents)} / {quote.pricingKind === "30_days" ? t("home.unitThirtyDays") : quote.pricingKind}</dd></div>}<div><dt>{t("booking.subtotal")}</dt><dd>{formatCents(quote.subtotalCents)}</dd></div>
      <div><dt>{t("booking.serviceFee")}</dt><dd>{formatCents(quote.buyerFeeCents)}</dd></div>
      <div><dt>{t("app.totalBeforeTax")}</dt><dd>{formatCents(quote.customerTotalCents)}</dd></div></dl>
    <small>{t("booking.adCreditAndAnyTaxAppearAt")}</small>
  </div>;
}

export function BookingFields({ listing, quoteRequired = true, onChange }: {
  listing: BookingListing; quoteRequired?: boolean;
  onChange?: (selection: { start: string; end: string; quote: BookingQuote | null }) => void;
}) {
  const { t, locale } = useLocale();
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
      .catch((reason) => { if (!controller.signal.aborted) setResult({key:requestKey,quote:null,error:reason.message || "Couldn’t load the price. Try again."}); });
    return () => controller.abort();
  }, [start, lastDay, listing.id, listing.updated_at, quoteRequired, reload, requestKey]);
  useEffect(() => {
    if (!calendarOpen || !listing.instant_booking_enabled || !listing.id) return;
    let active = true;
    createClient().rpc("listing_available_dates", { target_listing_id: listing.id })
      .then(({data,error}: {data: string[] | null; error: unknown}) => { if (active) setAvailability({ dates: data ?? [], error: error ? "Couldn’t load open dates. Choose dates below to check availability." : "" }); })
      .catch(() => { if (active) setAvailability({ dates: [], error: "Couldn’t load open dates. Choose dates below to check availability." }); });
    return () => { active = false; };
  }, [calendarOpen, listing.id, listing.updated_at, listing.instant_booking_enabled, reload]);
  return <div className="booking-fields field-wide">
    {listing.instant_booking_enabled && <details className="composer-options booking-calendar" onToggle={(event) => setCalendarOpen(event.currentTarget.open)}>
      <summary>{t("booking.seeAvailableDates")}</summary>
      {!availability ? <p role="status">{t("booking.loadingOpenDates")}</p> : availability.error ? <p role="alert">{availability.error}</p> : !availability.dates.length ? <p>{t("booking.noOpenDatesRightNowYouCan")}</p> : <>
        <p>{deadline ? t("booking.chooseADeliveryDate") : fixed ? t("booking.chooseAStartDate") : start && !end ? t("booking.nowChooseTheEndDate") : t("booking.chooseAStartDateThenAnEnd")}</p>
        <AvailabilityCalendar minimum={minimum} maximum={maximum} allowed={availability.dates} selected={[start,lastDay].filter(Boolean)}
          onChange={([day]) => { if (!day) return; if (deadline || fixed) setStart(day); else if (start && !end && day >= start) setEnd(day); else { setStart(day); setEnd(""); } }} />
      </>}
    </details>}
    <div className="field-grid"><label>{deadline ? t("composer.deliverBy") : t("composer.startDate")}
      <input name="start_date" type="date" min={minimum} max={maximum} required value={start}
        onChange={(event) => { setStart(event.target.value); }} /></label>
      {!deadline && !fixed ? <label>{t("composer.endDate")}<input name="end_date" type="date" min={start || minimum} max={maximum} required value={end}
        onChange={(event) => { setEnd(event.target.value); }} /></label> : <input type="hidden" name="end_date" value={lastDay} />}
    </div>
    {!deadline && fixed && start && <p>{bookingDateLabel("date_range", start, lastDay, t, locale)}</p>}
    {loading && <p role="status">{t("booking.checkingDatesAndPrice")}</p>}
    {error && <div className="field-error" role="alert">{error} <button type="button" onClick={() => setReload((value) => value + 1)}>{t("booking.tryAgain")}</button></div>}
    {quote && <BookingPriceSummary quote={quote} />}
    <input type="hidden" name="quote_subtotal" value={quote?.subtotalCents ?? ""} />
    <input type="hidden" name="quote_version" value={quote?.listingUpdatedAt ?? ""} />
  </div>;
}
