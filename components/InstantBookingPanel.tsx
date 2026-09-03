"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { addCalendarDays, calendarToday, type BookingSchedule } from "@/lib/listings/availability";
import { calculatePaymentBreakdown, formatCents } from "@/lib/payments/fees";
import { AvailabilityCalendar } from "./AvailabilityCalendar";

export function InstantBookingPanel({ listing, busy, onCheckout }: {
  listing: BookingSchedule & { id: string; price_cents: number };
  busy: boolean; onCheckout: (date: string) => void;
}) {
  const [dates, setDates] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    if (busy) return;
    createClient().rpc("listing_available_dates", { target_listing_id: listing.id })
      .then(({ data, error }: { data: string[] | null; error: unknown }) => {
        if (!active) return;
        if (error) setError("We couldn’t load open dates. Try again.");
        else { setDates(data ?? []); setSelected((current) => current.filter((date) => data?.includes(date))); setError(""); }
      }).catch(() => { if (active) setError("We couldn’t load open dates. Try again."); });
    return () => { active = false; };
  }, [listing.id, reload, busy]);
  const today = calendarToday(listing.booking_timezone);
  const price = calculatePaymentBreakdown(listing.price_cents);
  const duration = listing.booking_duration_days ?? 1;
  const label = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return <section className="instant-booking-panel" aria-label="Book this package">
    <div className="instant-booking-heading"><div><small>INSTANT BOOKING</small><h3>Pick your start date.</h3></div><span className="instant-booking-badge">No approval needed</span></div>
    <p>{duration === 1 ? "One day" : `${duration} consecutive days`} · One complete package · {listing.booking_timezone?.replaceAll("_", " ")}</p>
    {error ? <div role="alert"><p>{error}</p><button type="button" className="button button-ghost" onClick={() => setReload((value) => value + 1)}>Reload dates</button></div>
      : dates === null ? <p role="status">Finding open dates…</p>
      : dates.length === 0 ? <p role="status">No dates are open right now. You can make an offer for a different schedule.</p>
      : <AvailabilityCalendar selected={selected} onChange={setSelected} minimum={today} maximum={addCalendarDays(today, 365)} allowed={dates} />}
    <div className="instant-booking-summary">
      <span aria-live="polite">{selected[0] ? `${label(selected[0])}${duration > 1 ? ` – ${label(addCalendarDays(selected[0], duration - 1))}` : ""}` : "Select your start date"}</span>
      <dl><div><dt>Package</dt><dd>{formatCents(price.subtotalCents)}</dd></div><div><dt>Service fee (5%)</dt><dd>{formatCents(price.buyerFeeCents)}</dd></div><div className="booking-total"><dt>Total before tax</dt><dd>{formatCents(price.customerTotalCents)}</dd></div></dl>
      <button className="button button-coral" type="button" disabled={busy || !selected[0] || !dates?.includes(selected[0])} onClick={() => onCheckout(selected[0])}>
        {busy ? "Opening checkout…" : "Continue to checkout"}
      </button>
      <small>Pay securely to confirm. Your ad credit and any tax appear at checkout. The listed deliverables and cancellation terms apply.</small>
    </div>
  </section>;
}
