"use client";
import { useCallback, useState } from "react";
import type { BookingListing, BookingQuote } from "@/lib/listings/booking";
import { BookingFields } from "./BookingFields";
export function InstantBookingPanel({ listing, busy, onCheckout }: {
  listing: BookingListing & { id: string }; busy: boolean; onCheckout: (start: string, end: string) => void;
}) {
  const [selection, setSelection] = useState<{ start: string; end: string; quote: BookingQuote | null }>({ start: "", end: "", quote: null });
  const update = useCallback((next: typeof selection) => setSelection(next), []);
  return <section className="instant-booking-panel" aria-label="Book this package">
    <h3>{listing.timing_kind === "deadline" ? "Choose your delivery date" : "Choose your dates"}</h3>
    <BookingFields listing={listing} onChange={update} />
    <button type="button" className="button button-coral" disabled={busy || !selection.quote}
      onClick={() => onCheckout(selection.start, selection.end)}>{busy ? "Opening checkout…" : "Continue to checkout"}</button>
    <small>No approval needed. Payment confirms your booking.</small>
  </section>;
}
