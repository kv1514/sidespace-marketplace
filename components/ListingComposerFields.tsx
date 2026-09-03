"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BookingSchedule } from "@/lib/listings/availability";
import { addCalendarDays, calendarToday } from "@/lib/listings/availability";
import { centsToInputDollars } from "@/lib/payments/fees";
import { AvailabilityCalendar } from "./AvailabilityCalendar";

type SavedListing = BookingSchedule & Partial<Record<"title" | "channel" | "format" | "deliverables" | "description" | "price_unit" | "location_area" | "available_from" | "available_to" | "availability_notes" | "minimum_booking" | "cancellation_policy" | "demographics" | "space_size" | "street_address" | "install_by" | "sponsor_tier" | "brief_scope", string | null>> & {
  draft_price?: string; draft_price_max?: string; id?: string; price_cents?: number; price_max_cents?: number | null; surface_types?: string[]; target_platforms?: string[]; sponsor_slots?: number | null;
};
export type ComposerKind = "social" | "physical" | "sponsorship" | "brief";

export function ListingComposerFields({ listing = {}, kind, city = "", audience = "", channels, surfaces, installers, platforms, aiTools, spaceTools, onInstantChange, draftFiles }: {
  listing?: SavedListing; kind: ComposerKind; city?: string; audience?: string;
  channels: string[]; surfaces: string[]; installers: { value: string; label: string }[]; platforms: string[];
  aiTools?: ReactNode; spaceTools?: ReactNode; onInstantChange?: (enabled: boolean) => void;
  draftFiles?: File[];
}) {
  const photoInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (photoInput.current && draftFiles?.length) { const transfer = new DataTransfer(); draftFiles.forEach((file) => transfer.items.add(file)); photoInput.current.files = transfer.files; } }, [draftFiles]);
  const brief = kind === "brief";
  const legacy = Boolean(listing.id && !listing.timing_kind);
  const [timing, setTiming] = useState(listing.timing_kind || (legacy ? "" : kind === "social" ? "deadline" : "date_range"));
  const [pricing, setPricing] = useState(listing.pricing_kind || (legacy ? "" : kind === "social" || brief ? "fixed" : "day"));
  const [instant, setInstant] = useState(listing.instant_booking_enabled ?? false);
  const [dates, setDates] = useState(listing.availability_dates ?? []);
  const [zone] = useState(listing.booking_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [flexible, setFlexible] = useState(brief && !listing.available_from && !listing.available_to);
  const [briefEnd, setBriefEnd] = useState(listing.available_to || "");
  const [cardEdited, setCardEdited] = useState(Boolean(listing.id));
  const today = calendarToday(zone);
  const isDeadline = timing === "deadline";
  const unit = pricing === "30_days" ? "30 days" : pricing === "fixed" ? (isDeadline ? "delivery" : "package") : pricing;
  const physicalChannels = ["Storefront", "Vehicle", "Wall / mural", "Room / interior", "Community board", "Other"];
  const relevantChannels = kind === "physical" ? channels.filter((channel) => physicalChannels.includes(channel))
    : kind === "sponsorship" ? ["Sponsorship", "Other"]
    : channels.filter((channel) => !physicalChannels.includes(channel) && !["Business brief", "Sponsorship"].includes(channel)).concat("Other");
  const supplied = listing.deliverables || listing.format || "";
  return <>
    <section className="composer-section field-wide">
      <h3>{brief ? "What you need" : "What you offer"}</h3>
      <div className="field-grid">
        <label className="field-wide">{brief ? "Campaign title" : "Listing title"}<input name="title" required maxLength={120} defaultValue={listing.title || ""} placeholder={brief ? "Promote our new coffee shop" : kind === "physical" ? "Poster space in my café window" : "An Instagram story for your business"} /></label>
        {!brief && <label className="field-wide">{kind === "social" ? "Platform" : "Placement"}<select name="channel" defaultValue={listing.channel || (kind === "physical" ? "Storefront" : kind === "sponsorship" ? "Sponsorship" : "Instagram")}>
          {[...new Set([...relevantChannels, ...(listing.channel ? [listing.channel] : [])])].map((value) => <option key={value}>{value}</option>)}
        </select></label>}
        {brief && <input type="hidden" name="channel" value="Business brief" />}
        <label className="field-wide">{brief ? "What do you need?" : "What’s included?"}
          <textarea name="deliverables" required minLength={2} maxLength={1000} rows={3} defaultValue={supplied}
            placeholder={kind === "physical" ? "One A3 poster in our front window. We put it up and send you a photo." : "One Instagram story featuring your business, with a link. Live for 24 hours."}
            onChange={(event) => { if (!cardEdited) { const field = event.currentTarget.form?.elements.namedItem("format"); if (field instanceof HTMLInputElement) field.value = event.target.value.trim().split("\n")[0].slice(0, 140); } }} />
        </label>
        {aiTools && <details className="composer-options field-wide"><summary>Help me write this</summary>{aiTools}</details>}
      </div>
    </section>
    <section className="composer-section field-wide">
      <h3>{brief ? "Budget" : "Price and timing"}</h3>
      <div className="field-grid">
        <label>{brief ? "Budget ($)" : "Price ($)"}<input name="price" type="number" min={listing.id ? 0 : 0.01} max={2000000000} step="0.01" required defaultValue={listing.draft_price ?? (listing.price_cents == null ? "" : centsToInputDollars(listing.price_cents))} placeholder="50" /></label>
        {brief && <h3 className="field-wide">Timing</h3>}
        <label>{brief ? "Schedule" : "Timing"}<select name="timing_kind" value={timing} onChange={(event) => { const value = event.target.value; setTiming(value); if (!value) setPricing(""); else if (value === "deadline") setPricing("fixed"); else if (!pricing) setPricing(brief ? "fixed" : "day"); }}>
          {legacy && <option value="">Keep existing timing</option>}
          <option value="deadline">Deliver by a date</option><option value="date_range">Run between dates</option>
        </select></label>
        {!brief && !isDeadline && <label>Priced per<select name="pricing_kind" value={pricing} onChange={(event) => { setPricing(event.target.value); if (event.target.value && !timing) setTiming("date_range"); }}>
          {legacy && <option value="">Keep existing rate</option>}<option value="day">Day</option><option value="week">Week</option><option value="30_days">30 days</option><option value="fixed">Fixed package</option>
        </select></label>}
        {(brief || isDeadline) && <input type="hidden" name="pricing_kind" value={timing ? "fixed" : ""} />}
        {pricing || brief ? <input type="hidden" name="price_unit" value={brief ? "campaign" : unit} /> : <label>Existing price unit<input name="price_unit" defaultValue={listing.price_unit || "campaign"} /></label>}
        {!brief && <label>Notice needed (days)<input name="lead_time_days" type="number" min={0} max={365} defaultValue={listing.lead_time_days ?? 2} /></label>}
        {!brief && !isDeadline && <label>{pricing && pricing !== "fixed" ? "Minimum days" : "Days in package"}
          <input key={pricing && pricing !== "fixed" ? "minimum" : "duration"} name={pricing && pricing !== "fixed" ? "minimum_duration_days" : "booking_duration_days"} type="number" min={1} max={365} defaultValue={pricing && pricing !== "fixed" ? listing.minimum_duration_days ?? 1 : listing.booking_duration_days ?? 1} required />
        </label>}
        {(isDeadline || brief || (pricing && pricing !== "fixed")) && <input type="hidden" name="booking_duration_days" value="1" />}
        {(isDeadline || brief || !pricing || pricing === "fixed") && <input type="hidden" name="minimum_duration_days" value="1" />}
        <input type="hidden" name="booking_timezone" value={zone} />
        {!brief && <label className="composer-toggle field-wide"><input name="instant_booking_enabled" type="checkbox" checked={instant}
          onChange={(event) => { setInstant(event.target.checked); onInstantChange?.(event.target.checked); }} />Let buyers book without approval</label>}
        {!brief && <input type="hidden" name="availability_dates" value={JSON.stringify(dates)} />}
        {!brief && instant && <div className="field-wide"><p>{isDeadline ? "Choose available delivery dates." : "Choose every day the placement is available."}</p>
          <AvailabilityCalendar multiple selected={dates} onChange={setDates} minimum={today} maximum={addCalendarDays(today,365)} />
          <small>{zone.replaceAll("_", " ")} · Paid bookings are confirmed automatically.</small>
        </div>}
        {brief && <label className="composer-toggle field-wide"><input type="checkbox" checked={flexible} onChange={(event) => setFlexible(event.target.checked)} />My dates are flexible</label>}
        {brief && !flexible && <>
          {!isDeadline && <label>Start date<input type="date" name="available_from" min={today} defaultValue={listing.available_from || ""} required /></label>}
          <label>{isDeadline ? "Deliver by" : "End date"}<input type="date" name="available_to" min={today} value={briefEnd} onChange={(event) => setBriefEnd(event.target.value)} required /></label>
          {isDeadline && <input type="hidden" name="available_from" value={briefEnd} />}
        </>}
        {!brief && <label className="field-wide">Cancellation terms{!instant && " (optional)"}<input name="cancellation_policy" required={instant} maxLength={1000} defaultValue={listing.cancellation_policy || ""} placeholder="Free cancellation until 48 hours before the start" /></label>}
        <details className="composer-options field-wide"><summary>{brief ? "Budget range" : "More pricing and availability options"}</summary><div className="field-grid">
          <label>Maximum {brief ? "budget" : "price"} (optional)<input name="price_max" type="number" min={1} max={2000000000} step="0.01" defaultValue={listing.draft_price_max ?? (listing.price_max_cents == null ? "" : centsToInputDollars(listing.price_max_cents))} /></label>
          {!brief && <><label>Available from<input name="available_from" type="date" defaultValue={listing.available_from || ""} /></label><label>Available until<input name="available_to" type="date" defaultValue={listing.available_to || ""} /></label>
          <label className="field-wide">Other booking requirements<input name="minimum_booking" defaultValue={listing.minimum_booking || ""} placeholder="Optional" /></label></>}
          <label className="field-wide">Timing notes<input name="availability_notes" defaultValue={listing.availability_notes || ""} placeholder="Optional" /></label>
        </div></details>
      </div>
    </section>
    <section className="composer-section field-wide">{!brief && <h3>Photos and details</h3>}<div className="field-grid">
      <label className="field-wide">{brief ? "Artwork (optional)" : "Photos (optional)"}<input ref={photoInput} name="listing_photos" type="file" accept="image/jpeg,image/png,image/webp" multiple /><small>Up to 6 photos. Existing photos are kept unless replaced.</small></label>
      <label className="field-wide">{brief ? "Target area" : "Location or service area"}<input name="location_area" defaultValue={listing.location_area || city} placeholder="City, area, or online" /></label>
      <details className="composer-options field-wide"><summary>Additional description and audience</summary><div className="field-grid">
        <label className="field-wide">Additional description<textarea name="description" rows={3} defaultValue={listing.description || ""} /></label>
        <label className="field-wide">Audience<input name="demographics" defaultValue={listing.demographics || audience} /></label>
        <label className="field-wide">Short card summary<input name="format" maxLength={140} defaultValue={listing.format || supplied.split("\n")[0].slice(0,140)} onChange={() => setCardEdited(true)} /></label>
      </div></details>
      {kind === "physical" && <details className="composer-options field-wide"><summary>Space and installation</summary><input type="hidden" name="has_space_section" value="1" /><div className="field-grid">
        <fieldset className="chip-check-group field-wide"><legend>Allowed formats</legend>{surfaces.map((value) => <label className="chip-check" key={value}><input type="checkbox" name="surface_types" value={value} defaultChecked={listing.surface_types?.includes(value)} /><span>{value}</span></label>)}</fieldset>
        <label>Who installs it?<select name="install_by" defaultValue={listing.install_by || ""}><option value="">Arrange together</option>{installers.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
        <label>Size<input name="space_size" maxLength={80} defaultValue={listing.space_size || ""} placeholder="6 ft × 3 ft" /></label>
        <label className="field-wide">Exact address (private)<input name="street_address" maxLength={240} defaultValue={listing.street_address || ""} /></label>{spaceTools}
      </div></details>}
      {kind === "sponsorship" && <details className="composer-options field-wide"><summary>Sponsorship tier</summary><input type="hidden" name="has_sponsor_section" value="1" /><div className="field-grid">
        <label>Tier name<input name="sponsor_tier" maxLength={40} defaultValue={listing.sponsor_tier || ""} placeholder="Gold" /></label>
        {!listing.id && <label className="composer-toggle field-wide"><input name="add_another_tier" type="checkbox" />Add another tier after publishing</label>}
        <label>Available spots<input name="sponsor_slots" type="number" min={1} max={10000} defaultValue={listing.sponsor_slots ?? ""} /></label>
      </div></details>}
      {brief && <details className="composer-options field-wide"><summary>Platforms and placement types</summary><input type="hidden" name="has_brief_section" value="1" /><div className="field-grid">
        <label>Placement types<select name="brief_scope" defaultValue={listing.brief_scope || "both"}><option value="both">Physical and online</option><option value="physical">Physical</option><option value="virtual">Online</option></select></label>
        <fieldset className="chip-check-group field-wide"><legend>Target platforms</legend>{platforms.map((value) => <label className="chip-check" key={value}><input name="target_platforms" type="checkbox" value={value} defaultChecked={listing.target_platforms?.includes(value)} /><span>{value}</span></label>)}</fieldset>
      </div></details>}
    </div></section>
  </>;
}

export function revealInvalidField(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return;
  let parent = target.parentElement;
  while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
}
