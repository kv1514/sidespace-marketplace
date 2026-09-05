"use client";
import { useCallback, useState } from "react";
import type { BookingListing, BookingQuote } from "@/lib/listings/booking";
import { BookingFields } from "./BookingFields";
import { useLocale } from "@/app/components/LocaleProvider";
export function InstantBookingPanel({ listing, busy, onCheckout }: {
  listing: BookingListing & { id: string }; busy: boolean; onCheckout: (start: string, end: string) => void;
}) {
  const { t } = useLocale();
  const [selection, setSelection] = useState<{ start: string; end: string; quote: BookingQuote | null }>({ start: "", end: "", quote: null });
  const update = useCallback((next: typeof selection) => setSelection(next), []);
  return <section className="instant-booking-panel" aria-label={t("instant.bookThisPackage")}>
    <h3>{listing.timing_kind === "deadline" ? t("instant.chooseYourDeliveryDate") : t("instant.chooseYourDates")}</h3>
    <BookingFields listing={listing} onChange={update} />
    <button type="button" className="button button-coral" disabled={busy || !selection.quote}
      onClick={() => onCheckout(selection.start, selection.end)}>{busy ? t("instant.openingCheckout") : t("instant.continueToCheckout")}</button>
    <small>{t("instant.noApprovalNeededPaymentConfirmsYourBooking")}</small>
  </section>;
}
