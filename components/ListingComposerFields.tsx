"use client";
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { BookingSchedule } from "@/lib/listings/availability";
import { addCalendarDays, calendarToday } from "@/lib/listings/availability";
import { centsToInputDollars } from "@/lib/payments/fees";
import { AvailabilityCalendar } from "./AvailabilityCalendar";
import { useLocale } from "@/app/components/LocaleProvider";

type SavedListing = BookingSchedule & Partial<Record<"title" | "channel" | "format" | "deliverables" | "description" | "price_unit" | "location_area" | "available_from" | "available_to" | "availability_notes" | "minimum_booking" | "cancellation_policy" | "demographics" | "space_size" | "street_address" | "install_by" | "sponsor_tier" | "brief_scope", string | null>> & {
  draft_price?: string; draft_price_max?: string; id?: string; price_cents?: number; price_max_cents?: number | null; surface_types?: string[]; target_platforms?: string[]; sponsor_slots?: number | null;
};
export type ComposerKind = "social" | "physical" | "sponsorship" | "brief";

const MAX_LISTING_PHOTO_FILES = 6;
const LISTING_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
const EMPTY_LISTING_FILES: File[] = [];

type ListingPhotoItem = {
  id: string;
  file: File;
  previewUrl: string;
};

function listingPhotoId(file: File) {
  return [file.name, file.size, file.lastModified, file.type].join("::");
}

function isListingPhoto(file: File) {
  return LISTING_PHOTO_TYPES.includes(file.type) || /\.(?:jpe?g|png|webp)$/i.test(file.name);
}

function formatPhotoSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function revokeListingPhoto(item: ListingPhotoItem) {
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
}

function writeListingFilesToInput(input: HTMLInputElement | null, photos: ListingPhotoItem[]) {
  if (!input || typeof DataTransfer === "undefined") return;
  const transfer = new DataTransfer();
  photos.forEach(({ file }) => transfer.items.add(file));
  input.files = transfer.files;
}

function createListingPhotoItems(files: File[]) {
  return files
    .filter((file) => file.size > 0 && isListingPhoto(file))
    .slice(0, MAX_LISTING_PHOTO_FILES)
    .map((file) => ({
      id: listingPhotoId(file),
      file,
      previewUrl: typeof window === "undefined" ? "" : URL.createObjectURL(file),
    }));
}

function hasDragType(event: DragEvent<HTMLElement>, type: string) {
  return Array.from(event.dataTransfer.types).includes(type);
}

function ListingPhotoPicker({ label, draftFiles = EMPTY_LISTING_FILES, onFilesChange, hasSavedPhotos = false }: {
  label: string;
  draftFiles?: File[];
  onFilesChange?: (files: File[]) => void;
  hasSavedPhotos?: boolean;
}) {
  const { t } = useLocale();
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const [photos, setPhotos] = useState<ListingPhotoItem[]>(() => createListingPhotoItems(draftFiles));
  const photosRef = useRef<ListingPhotoItem[]>(photos);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [fileDropActive, setFileDropActive] = useState(false);
  const [fileMessage, setFileMessage] = useState("");

  useEffect(() => {
    writeListingFilesToInput(inputRef.current, photosRef.current);
  }, [draftFiles]);

  useEffect(() => () => {
    photosRef.current.forEach(revokeListingPhoto);
    photosRef.current = [];
  }, []);

  function commitPhotos(next: ListingPhotoItem[]) {
    const nextIds = new Set(next.map((photo) => photo.id));
    photosRef.current.forEach((photo) => {
      if (!nextIds.has(photo.id)) revokeListingPhoto(photo);
    });
    photosRef.current = next;
    setPhotos(next);
    onFilesChange?.(next.map(({ file }) => file));
    writeListingFilesToInput(inputRef.current, next);
  }

  function addFiles(incoming: File[]) {
    if (!incoming.length) return;
    const current = photosRef.current;
    const existingIds = new Set(current.map((photo) => photo.id));
    const invalidCount = incoming.filter((file) => file.size > 0 && !isListingPhoto(file)).length;
    const unique = incoming.filter((file) => {
      if (file.size <= 0 || !isListingPhoto(file)) return false;
      const id = listingPhotoId(file);
      if (existingIds.has(id)) return false;
      existingIds.add(id);
      return true;
    });
    const room = Math.max(0, MAX_LISTING_PHOTO_FILES - current.length);
    const accepted = unique.slice(0, room).map((file) => ({
      id: listingPhotoId(file),
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    if (accepted.length) commitPhotos([...current, ...accepted]);

    const messages = [
      invalidCount ? `${invalidCount} file${invalidCount === 1 ? " was" : "s were"} skipped. Use JPG, PNG, or WebP.` : "",
      unique.length > room
        ? room > 0
          ? `Added ${accepted.length} photo${accepted.length === 1 ? "" : "s"}. ${unique.length - room} more photo${unique.length - room === 1 ? " was" : "s were"} not added; listings can have up to 6.`
          : "You already have 6 photos. Remove one before adding another."
        : "",
    ].filter(Boolean);
    setFileMessage(messages.join(" "));
  }

  function removePhoto(index: number) {
    commitPhotos(photosRef.current.filter((_, photoIndex) => photoIndex !== index));
    setFileMessage("");
  }

  function movePhoto(from: number, to: number) {
    const current = photosRef.current;
    if (from === to || from < 0 || to < 0 || from >= current.length || to >= current.length) return;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    commitPhotos(next);
    setDraggedIndex(null);
    setDragOverIndex(null);
  }

  function handlePhotoDragStart(event: DragEvent<HTMLLIElement>, index: number) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
    setDraggedIndex(index);
  }

  function handlePhotoDragOver(event: DragEvent<HTMLLIElement>, index: number) {
    if (draggedIndex === null || !hasDragType(event, "text/plain")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverIndex(index);
  }

  function handlePhotoDrop(event: DragEvent<HTMLLIElement>, index: number) {
    if (draggedIndex === null || !hasDragType(event, "text/plain")) return;
    event.preventDefault();
    event.stopPropagation();
    movePhoto(draggedIndex, index);
  }

  function handlePhotoDragEnd() {
    setDraggedIndex(null);
    setDragOverIndex(null);
  }

  function handleFileDropzoneDragOver(event: DragEvent<HTMLDivElement>) {
    if (draggedIndex !== null || !hasDragType(event, "Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setFileDropActive(true);
  }

  function handleFileDropzoneDrop(event: DragEvent<HTMLDivElement>) {
    if (draggedIndex !== null || !hasDragType(event, "Files")) return;
    event.preventDefault();
    setFileDropActive(false);
    addFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <div className={`listing-photo-picker field-wide${fileDropActive ? " is-drop-active" : ""}`}>
      <div className="listing-photo-picker-heading">
        <div>
          <label className="listing-photo-picker-label" htmlFor={inputId}>{label}</label>
          <p>{hasSavedPhotos
            ? t("composer.newPhotosAreAddedAfterTheCurrent")
            : t("composer.showPeopleWhatTheyreBookingTheFirst")}</p>
        </div>
        <span className="listing-photo-count" aria-live="polite">
          {photos.length}/{MAX_LISTING_PHOTO_FILES}
        </span>
      </div>
      <div
        className="listing-photo-dropzone"
        onDragEnter={handleFileDropzoneDragOver}
        onDragOver={handleFileDropzoneDragOver}
        onDragLeave={(event) => {
          const relatedTarget = event.relatedTarget;
          if (!(relatedTarget instanceof Node) || !event.currentTarget.contains(relatedTarget)) setFileDropActive(false);
        }}
        onDrop={handleFileDropzoneDrop}
      >
        {photos.length ? (
          <>
            <ol className="listing-photo-grid" aria-label={t("composer.selectedListingPhotos")}>
              {photos.map((photo, index) => (
                <li
                  className={`listing-photo-card${draggedIndex === index ? " is-dragging" : ""}${dragOverIndex === index && draggedIndex !== index ? " is-drag-over" : ""}`}
                  draggable={photos.length > 1}
                  key={photo.id}
                  onDragStart={(event) => handlePhotoDragStart(event, index)}
                  onDragOver={(event) => handlePhotoDragOver(event, index)}
                  onDrop={(event) => handlePhotoDrop(event, index)}
                  onDragEnd={handlePhotoDragEnd}
                >
                  <div className="listing-photo-preview">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photo.previewUrl} alt={t("composer.selectedListingPhotoValue", { value: index + 1 })} />
                    <span className="listing-photo-order" aria-hidden="true">{index + 1}</span>
                    {index === 0 && !hasSavedPhotos && <span className="listing-photo-cover">{t("app.cover")}</span>}
                    <button
                      type="button"
                      className="listing-photo-remove"
                      aria-label={t("app.removePhotoValue", { value: index + 1 })}
                      title={t("app.removePhoto")}
                      onClick={() => removePhoto(index)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="listing-photo-meta">
                    <span className="listing-photo-name" title={photo.file.name}>{photo.file.name}</span>
                    <span className="listing-photo-size">{formatPhotoSize(photo.file.size)}</span>
                  </div>
                  <div className="listing-photo-actions">
                    <span>{photos.length > 1 ? t("composer.dragToMove") : hasSavedPhotos ? t("composer.addedPhoto") : t("composer.coverPhoto")}</span>
                    <div className="listing-photo-move-buttons">
                      <button
                        type="button"
                        disabled={index === 0}
                        aria-label={t("composer.movePhotoValueEarlier", { value: index + 1 })}
                        title={t("composer.moveEarlier")}
                        onClick={() => movePhoto(index, index - 1)}
                      >
                        ←
                      </button>
                      <button
                        type="button"
                        disabled={index === photos.length - 1}
                        aria-label={t("composer.movePhotoValueLater", { value: index + 1 })}
                        title={t("composer.moveLater")}
                        onClick={() => movePhoto(index, index + 1)}
                      >
                        →
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            {photos.length < MAX_LISTING_PHOTO_FILES && (
              <button type="button" className="listing-photo-add" onClick={() => inputRef.current?.click()}>
                <span aria-hidden="true">+</span>{" "}{t("composer.addAnotherPhoto")}
              </button>
            )}
          </>
        ) : (
          <div className="listing-photo-empty">
            <span className="listing-photo-empty-mark" aria-hidden="true">+</span>
            <strong>{t("composer.addPhotosOfWhatYoureOffering")}</strong>
            <span>{t("composer.dropThemHereOrChooseThemFrom")}</span>
            <button type="button" className="button button-dark button-small" onClick={() => inputRef.current?.click()}>
              {t("composer.choosePhotos")}{" "}<span aria-hidden="true">↗</span>
            </button>
          </div>
        )}
      </div>
      <input
        ref={inputRef}
        id={inputId}
        className="listing-photo-input"
        name="listing_photos"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        onChange={(event) => addFiles(Array.from(event.currentTarget.files ?? []))}
      />
      <div className="listing-photo-picker-footer">
        <small>{t("composer.jpgPngOrWebpUpTo6")}</small>
        {fileMessage && <small className="listing-photo-message" role="alert">{fileMessage}</small>}
      </div>
    </div>
  );
}

export function ListingComposerFields({ listing = {}, kind, city = "", audience = "", channels, surfaces, installers, platforms, aiTools, spaceTools, onInstantChange, draftFiles, onFilesChange, hasSavedPhotos }: {
  listing?: SavedListing; kind: ComposerKind; city?: string; audience?: string;
  channels: string[]; surfaces: string[]; installers: { value: string; label: string }[]; platforms: string[];
  aiTools?: ReactNode; spaceTools?: ReactNode; onInstantChange?: (enabled: boolean) => void;
  draftFiles?: File[]; onFilesChange?: (files: File[]) => void; hasSavedPhotos?: boolean;
}) {
  const { t, tx } = useLocale();
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
      <h3>{brief ? t("app.whatYouNeed") : t("composer.whatYouOffer")}</h3>
      <div className="field-grid">
        <label className="field-wide">{brief ? t("composer.campaignTitle") : t("composer.listingTitle")}<input name="title" required maxLength={120} defaultValue={listing.title || ""} placeholder={brief ? t("composer.promoteOurNewCoffeeShop") : kind === "physical" ? t("composer.posterSpaceInMyCafWindow") : t("composer.anInstagramStoryForYourBusiness")} /></label>
        {!brief && <label className="field-wide">{kind === "social" ? t("composer.platform") : t("composer.placement")}<select name="channel" defaultValue={listing.channel || (kind === "physical" ? "Storefront" : kind === "sponsorship" ? "Sponsorship" : "Instagram")}>
          {[...new Set([...relevantChannels, ...(listing.channel ? [listing.channel] : [])])].map((value) => <option key={value}>{value}</option>)}
        </select></label>}
        {brief && <input type="hidden" name="channel" value="Business brief" />}
        <label className="field-wide">{brief ? t("composer.whatDoYouNeed") : t("composer.whatsIncluded")}
          <textarea name="deliverables" required minLength={2} maxLength={1000} rows={3} defaultValue={supplied}
            placeholder={kind === "physical" ? t("composer.oneA3PosterInOurFrontWindow") : t("composer.oneInstagramStoryFeaturingYourBusinessWith")}
            onChange={(event) => { if (!cardEdited) { const field = event.currentTarget.form?.elements.namedItem("format"); if (field instanceof HTMLInputElement) field.value = event.target.value.trim().split("\n")[0].slice(0, 140); } }} />
        </label>
        {aiTools && <details className="composer-options field-wide"><summary>{t("composer.helpMeWriteThis")}</summary>{aiTools}</details>}
      </div>
    </section>
    <section className="composer-section field-wide">
      <h3>{brief ? t("market.budget") : t("composer.priceAndTiming")}</h3>
      <div className="field-grid">
        <label>{brief ? t("composer.budget") : t("composer.price")}<input name="price" type="number" min={listing.id ? 0 : 0.01} max={2000000000} step="0.01" required defaultValue={listing.draft_price ?? (listing.price_cents == null ? "" : centsToInputDollars(listing.price_cents))} placeholder="50" /></label>
        {brief && <h3 className="field-wide">{t("app.timing")}</h3>}
        <label>{brief ? t("composer.schedule") : t("app.timing")}<select name="timing_kind" value={timing} onChange={(event) => { const value = event.target.value; setTiming(value); if (!value) setPricing(""); else if (value === "deadline") setPricing("fixed"); else if (!pricing) setPricing(brief ? "fixed" : "day"); }}>
          {legacy && <option value="">{t("composer.keepExistingTiming")}</option>}
          <option value="deadline">{t("composer.deliverByADate")}</option><option value="date_range">{t("composer.runBetweenDates")}</option>
        </select></label>
        {!brief && !isDeadline && <label>{t("composer.pricedPer")}<select name="pricing_kind" value={pricing} onChange={(event) => { setPricing(event.target.value); if (event.target.value && !timing) setTiming("date_range"); }}>
          {legacy && <option value="">{t("composer.keepExistingRate")}</option>}<option value="day">{t("composer.day")}</option><option value="week">{t("composer.week")}</option><option value="30_days">{t("home.unitThirtyDays")}</option><option value="fixed">{t("composer.fixedPackage")}</option>
        </select></label>}
        {(brief || isDeadline) && <input type="hidden" name="pricing_kind" value={timing ? "fixed" : ""} />}
        {pricing || brief ? <input type="hidden" name="price_unit" value={brief ? "campaign" : unit} /> : <label>{t("composer.existingPriceUnit")}<input name="price_unit" defaultValue={listing.price_unit || "campaign"} /></label>}
        {!brief && <label>{t("composer.noticeNeededDays")}<input name="lead_time_days" type="number" min={0} max={365} defaultValue={listing.lead_time_days ?? 2} /></label>}
        {!brief && !isDeadline && <label>{pricing && pricing !== "fixed" ? t("composer.minimumDays") : t("composer.daysInPackage")}
          <input key={pricing && pricing !== "fixed" ? "minimum" : "duration"} name={pricing && pricing !== "fixed" ? "minimum_duration_days" : "booking_duration_days"} type="number" min={1} max={365} defaultValue={pricing && pricing !== "fixed" ? listing.minimum_duration_days ?? 1 : listing.booking_duration_days ?? 1} required />
        </label>}
        {(isDeadline || brief || (pricing && pricing !== "fixed")) && <input type="hidden" name="booking_duration_days" value="1" />}
        {(isDeadline || brief || !pricing || pricing === "fixed") && <input type="hidden" name="minimum_duration_days" value="1" />}
        <input type="hidden" name="booking_timezone" value={zone} />
        {!brief && <label className="composer-toggle field-wide"><input name="instant_booking_enabled" type="checkbox" checked={instant}
          onChange={(event) => { setInstant(event.target.checked); onInstantChange?.(event.target.checked); }} />{t("composer.letBuyersBookWithoutApproval")}</label>}
        {!brief && <input type="hidden" name="availability_dates" value={JSON.stringify(dates)} />}
        {!brief && instant && <div className="field-wide"><p>{isDeadline ? t("composer.chooseAvailableDeliveryDates") : t("composer.chooseEveryDayThePlacementIsAvailable")}</p>
          <AvailabilityCalendar multiple selected={dates} onChange={setDates} minimum={today} maximum={addCalendarDays(today,365)} />
          <small>{t("composer.replaceallPaidBookingsAreConfirmedAutomatically", { replaceAll: zone.replaceAll("_", " ") })}</small>
        </div>}
        {brief && <label className="composer-toggle field-wide"><input type="checkbox" checked={flexible} onChange={(event) => setFlexible(event.target.checked)} />{t("composer.myDatesAreFlexible")}</label>}
        {brief && !flexible && <>
          {!isDeadline && <label>{t("composer.startDate")}<input type="date" name="available_from" min={today} defaultValue={listing.available_from || ""} required /></label>}
          <label>{isDeadline ? t("composer.deliverBy") : t("composer.endDate")}<input type="date" name="available_to" min={today} value={briefEnd} onChange={(event) => setBriefEnd(event.target.value)} required /></label>
          {isDeadline && <input type="hidden" name="available_from" value={briefEnd} />}
        </>}
        {!brief && <label className="field-wide">{t("app.cancellationTerms")}{!instant && t("composer.optional")}<input name="cancellation_policy" required={instant} maxLength={1000} defaultValue={listing.cancellation_policy || ""} placeholder={t("composer.freeCancellationUntil48HoursBeforeThe")} /></label>}
        <details className="composer-options field-wide"><summary>{brief ? t("app.budgetRange") : t("composer.morePricingAndAvailabilityOptions")}</summary><div className="field-grid">
          <label>{t("composer.maximum")}{" "}{brief ? t("composer.budget2") : t("composer.price2")}{" "}{t("composer.optional2")}<input name="price_max" type="number" min={1} max={2000000000} step="0.01" defaultValue={listing.draft_price_max ?? (listing.price_max_cents == null ? "" : centsToInputDollars(listing.price_max_cents))} /></label>
          {!brief && <><label>{t("composer.availableFrom")}<input name="available_from" type="date" defaultValue={listing.available_from || ""} /></label><label>{t("composer.availableUntil")}<input name="available_to" type="date" defaultValue={listing.available_to || ""} /></label>
          <label className="field-wide">{t("composer.otherBookingRequirements")}<input name="minimum_booking" defaultValue={listing.minimum_booking || ""} placeholder={t("app.optional")} /></label></>}
          <label className="field-wide">{t("composer.timingNotes")}<input name="availability_notes" defaultValue={listing.availability_notes || ""} placeholder={t("app.optional")} /></label>
        </div></details>
      </div>
    </section>
    <section className="composer-section field-wide">{!brief && <h3>{t("composer.photosAndDetails")}</h3>}<div className="field-grid">
      <ListingPhotoPicker label={brief ? t("composer.artworkOptional") : t("composer.photosOptional")} draftFiles={draftFiles} onFilesChange={onFilesChange} hasSavedPhotos={hasSavedPhotos} />
      <label className="field-wide">{brief ? t("composer.targetArea") : t("composer.locationOrServiceArea")}<input name="location_area" defaultValue={listing.location_area || city} placeholder={t("composer.cityAreaOrOnline")} /></label>
      <details className="composer-options field-wide"><summary>{t("composer.additionalDescriptionAndAudience")}</summary><div className="field-grid">
        <label className="field-wide">{t("composer.additionalDescription")}<textarea name="description" rows={3} defaultValue={listing.description || ""} /></label>
        <label className="field-wide">{t("composer.audience")}<input name="demographics" defaultValue={listing.demographics || audience} /></label>
        <label className="field-wide">{t("composer.shortCardSummary")}<input name="format" maxLength={140} defaultValue={listing.format || supplied.split("\n")[0].slice(0,140)} onChange={() => setCardEdited(true)} /></label>
      </div></details>
      {kind === "physical" && <details className="composer-options field-wide"><summary>{t("composer.spaceAndInstallation")}</summary><input type="hidden" name="has_space_section" value="1" /><div className="field-grid">
        <fieldset className="chip-check-group field-wide"><legend>{t("composer.allowedFormats")}</legend>{surfaces.map((value) => <label className="chip-check" key={value}><input type="checkbox" name="surface_types" value={value} defaultChecked={listing.surface_types?.includes(value)} /><span>{tx(value)}</span></label>)}</fieldset>
        <label>{t("composer.whoInstallsIt")}<select name="install_by" defaultValue={listing.install_by || ""}><option value="">{t("composer.arrangeTogether")}</option>{installers.map((item) => <option value={item.value} key={item.value}>{tx(item.label)}</option>)}</select></label>
        <label>{t("composer.size")}<input name="space_size" maxLength={80} defaultValue={listing.space_size || ""} placeholder={t("app.n6Ft3Ft")} /></label>
        <label className="field-wide">{t("composer.exactAddressPrivate")}<input name="street_address" maxLength={240} defaultValue={listing.street_address || ""} /></label>{spaceTools}
      </div></details>}
      {kind === "sponsorship" && <details className="composer-options field-wide"><summary>{t("composer.sponsorshipTier")}</summary><input type="hidden" name="has_sponsor_section" value="1" /><div className="field-grid">
        <label>{t("composer.tierName")}<input name="sponsor_tier" maxLength={40} defaultValue={listing.sponsor_tier || ""} placeholder={t("app.gold")} /></label>
        {!listing.id && <label className="composer-toggle field-wide"><input name="add_another_tier" type="checkbox" />{t("composer.addAnotherTierAfterPublishing")}</label>}
        <label>{t("composer.availableSpots")}<input name="sponsor_slots" type="number" min={1} max={10000} defaultValue={listing.sponsor_slots ?? ""} /></label>
      </div></details>}
      {brief && <details className="composer-options field-wide"><summary>{t("composer.platformsAndPlacementTypes")}</summary><input type="hidden" name="has_brief_section" value="1" /><div className="field-grid">
        <label>{t("composer.placementTypes")}<select name="brief_scope" defaultValue={listing.brief_scope || "both"}><option value="both">{t("app.physicalAndOnline")}</option><option value="physical">{t("app.physical")}</option><option value="virtual">{t("app.online")}</option></select></label>
        <fieldset className="chip-check-group field-wide"><legend>{t("composer.targetPlatforms")}</legend>{platforms.map((value) => <label className="chip-check" key={value}><input name="target_platforms" type="checkbox" value={value} defaultChecked={listing.target_platforms?.includes(value)} /><span>{tx(value)}</span></label>)}</fieldset>
      </div></details>}
    </div></section>
  </>;
}

export function revealInvalidField(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return;
  let parent = target.parentElement;
  while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
}
