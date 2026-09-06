"use client";

/* Public marketplace images can be remote Supabase URLs whose hosts are not
   fixed at build time; static and live cards intentionally share one element. */
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import NextImage from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  localizeListingChannel,
  localizeListingUnit,
  type TranslationKey,
} from "@/lib/i18n";
import {
  isListingRequestable,
  type ListingProvenanceStatus,
} from "@/lib/listings/provenance";
import HeroCanvas from "./HeroCanvas";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocale } from "./LocaleProvider";

export type PublicListing = {
  id: string;
  title: string;
  channel: string;
  format: string;
  price_cents: number;
  price_max_cents?: number | null;
  price_unit: string;
  description: string;
  demographics?: string | null;
  image_url: string;
  location_area?: string | null;
  provenance_status?: ListingProvenanceStatus | null;
  availability_confirmed_at?: string | null;
  owner: {
    id: string;
    display_name: string;
    city: string;
    role: string;
    verified: boolean;
    is_demo: boolean;
  };
};

/** The listing's own city, falling back to the owner's profile city. */
function listingCity(listing: PublicListing) {
  return listing.location_area || listing.owner.city;
}

function price(
  listing: PublicListing,
  formatListingPrice: (usdCents: number) => string,
) {
  const low = Number(listing.price_cents || 0);
  const high = Number(listing.price_max_cents || 0);
  return high > low
    ? `${formatListingPrice(low)}–${formatListingPrice(high)}`
    : formatListingPrice(low);
}

/**
 * A "Business brief" is a business asking for space, not space anyone can book.
 *
 * It is the one channel that means demand rather than supply, so it has no
 * business anywhere the site is showing off its inventory - the hero card
 * least of all, which is the first listing most people ever see. Briefs still
 * belong in the marketplace, where "wanted" is a card people can answer; they
 * just sort to the end of it.
 */
function isDemandBrief(listing: Pick<PublicListing, "channel">) {
  return listing.channel === "Business brief";
}

function hoverIsFine() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
}

/**
 * Which channels each hero tab is actually offering.
 *
 * Matched against `channel` alone, which is the field that says what a listing
 * is. Widening it to the prose in `format` sounds harmless and is not: the
 * word "team" in "logo beneath the team logo on a team hoodie" was enough to
 * present a hoodie as the marketplace's example of a local event.
 *
 * A regex rather than a set because the seed rows predate the
 * `LISTING_CHANNELS` vocabulary and carry their own values ("Cafe window",
 * "Counter card", "Farm stand"). A channel that matches nothing here - "Other"
 * - simply does not appear in the hero, which is the right answer for a
 * listing whose own kind is unstated.
 */
const INVENTORY_TYPES: ReadonlyArray<{
  label: string;
  labelKey: TranslationKey;
  short: string;
  shortKey: TranslationKey;
  detail: string;
  detailKey: TranslationKey;
  match: RegExp;
}> = [
  {
    label: "Storefront",
    labelKey: "home.inventoryStorefront",
    short: "WINDOW / 01",
    shortKey: "home.inventoryStorefrontShort",
    detail: "A real window on a real street",
    detailKey: "home.inventoryStorefrontDetail",
    match: /storefront|window|wall|mural|room|interior|board|counter|main street|farm stand|cafe|bakery/i,
  },
  {
    label: "Creator",
    labelKey: "home.inventoryCreator",
    short: "AUDIENCE / 02",
    shortKey: "home.inventoryCreatorShort",
    detail: "A trusted voice people already follow",
    detailKey: "home.inventoryCreatorDetail",
    match: /instagram|tiktok|youtube|newsletter|podcast|twitch|website/i,
  },
  {
    label: "Vehicle",
    labelKey: "home.inventoryVehicle",
    short: "ROUTE / 03",
    shortKey: "home.inventoryVehicleShort",
    detail: "A moving placement with a local routine",
    detailKey: "home.inventoryVehicleDetail",
    match: /vehicle/i,
  },
  {
    label: "Event",
    labelKey: "home.inventoryEvent",
    short: "CROWD / 04",
    shortKey: "home.inventoryEventShort",
    detail: "A team, gathering, or local occasion",
    detailKey: "home.inventoryEventDetail",
    match: /sponsorship|event/i,
  },
];

/**
 * Editorial overrides: the listing a tab should show when we have a preference.
 *
 * The rule below picks the newest listing of the right kind, which is the
 * right default and keeps working as listings come and go. This is the
 * exception for when a particular listing is simply the better shop window -
 * a car with a real listing photo and a title that says what it is, rather
 * than a newer one called "My car" illustrated with its owner's profile
 * picture.
 *
 * Each tab holds an ORDERED list, not a single id: the front page should show
 * the best example of a kind, and the best example has a runner-up. The first
 * pin that is actually available wins, so a listing going paused or deleted
 * quietly promotes the next one instead of dropping the tab back to whatever
 * happens to be newest.
 *
 * Keyed by tab label so it reads as an editorial choice rather than a rule.
 * A pin is resolved against every bookable listing, NOT only the ones whose
 * channel matches its tab: the listing we want to introduce a category with
 * does not always carry the channel the matcher would guess, and a human
 * naming a specific id has already made that call. Demand briefs stay
 * excluded either way - the front page never presents someone asking for
 * space as someone offering it. The list falls back to the channel rule the
 * moment none of its entries are available - deleted, deactivated, or simply
 * pushed out of the rows the page fetches. Emptying an entry restores the
 * default.
 */
const HERO_PINS: Record<string, string[]> = {
  // A placement on an actual street, described in plain words, which is what
  // this tab promises ("a real window on a real street"). The dorm door is
  // the runner-up: it is the more detailed listing and carries its owner's
  // own photo, but it is an interior door rather than a street.
  Storefront: [
    "e54988cb-24b6-4ed0-80da-96163b053929", // Dylan Nguyen - yard sign on a Yorba Linda street
    "de1b07a4-7cb0-46c6-a692-b30ea460a59d", // Kausthubh Veldanda - dorm room door, floor 4 corner
  ],
  // Creators with a real audience, a real listing photo, and an offer a
  // business can picture. These two are how we want the marketplace
  // introduced, so the tab shows them rather than the newest creator to
  // have published.
  Creator: [
    "265650f5-0f1e-4ee6-966c-aa5df6e22edd", // Dylan Nguyen - 30-second YouTube segment
    "86b8e144-4952-45d8-8b5d-807932a4810c", // Aidan Chen - Instagram story for local businesses
  ],
  Vehicle: ["3aeba0db-3bf1-4acc-a51a-eba0f1417f64"],
  // A local occasion you can actually buy, and the one we want to lead with.
  // Its channel is "Other", so only a pin can put it here - the tab's matcher
  // would never find it. Troy Physics Club's sponsor whiteboard sits behind
  // it as the conventional sponsorship example.
  Event: [
    "7f32be7a-1f79-4c37-9fdc-73968d00ea23", // Aiden Guan - run across campus with your flag
    "8af17b87-b816-4edf-901c-750bd4f03938", // Troy Physics Club - whiteboard for sponsors
  ],
};

/**
 * The listing each tab shows.
 *
 * This used to be `listings[active]` - the card was chosen by which tab was
 * open, not by what the tab was offering, so whatever happened to be the
 * second-newest listing in the whole marketplace was presented as a Creator.
 * That is how a business brief ended up introduced as "a trusted voice people
 * already follow" on the front page.
 *
 * Now each tab picks the newest real listing that genuinely belongs to it,
 * demo rows are a fallback rather than a first choice, and a tab with nothing
 * to show falls through to the generic card below rather than borrowing
 * someone else's listing.
 */
function pickInventory(listings: PublicListing[]) {
  const bookable = listings.filter((listing) => !isDemandBrief(listing));
  return INVENTORY_TYPES.map((type) => {
    const matches = bookable.filter((listing) =>
      type.match.test(listing.channel),
    );
    const pinned = (HERO_PINS[type.label] ?? [])
      .map((id) => bookable.find((listing) => listing.id === id))
      .find(Boolean);
    return (
      pinned ||
      matches.find((listing) => !listing.owner.is_demo) ||
      matches[0]
    );
  });
}

const HERO_FALLBACK_IMAGES = [
  "/photos/corner-store.jpg",
  "/photos/market-creator.jpg",
  "/photos/jay-volvo.jpg",
  "/photos/rural-market.jpg",
] as const;

const HERO_ROTATION_MS = 4300;

const CATEGORY_REEL: ReadonlyArray<readonly [TranslationKey, string, string]> = [
  ["home.categoryInstagramStory", "Instagram", "01"],
  ["home.categoryTikTok", "TikTok", "02"],
  ["home.categoryNewsletter", "Newsletter", "03"],
  ["home.categoryStorefrontWindow", "Storefront", "04"],
  ["home.categoryCafeCounter", "Storefront", "05"],
  ["home.categoryVehicle", "Vehicle", "06"],
  ["home.categoryCommunityBoard", "Community board", "07"],
  ["home.categoryWall", "Wall / mural", "08"],
  ["home.categoryEventSponsorship", "Sponsorship", "09"],
  ["home.categoryTeamSponsorship", "Sponsorship", "10"],
] as const;

const PLACEMENT_EXAMPLES = [
  {
    number: "01",
    type: "MOVING PLACEMENT",
    title: "A daily route, turned into mobile reach.",
    before: "/photos/sidespace-placements/car-before.jpg",
    after: "/photos/sidespace-placements/car-after.jpg",
    beforeAlt: "Plain white car parked on a neighborhood street",
    afterAlt: "The same white car with a cream, amber, and charcoal SideSpace wrap",
  },
  {
    number: "02",
    type: "STREET-FACING GLASS",
    title: "Dinner traffic, captured at eye level.",
    before: "/photos/sidespace-placements/restaurant-window-before.jpg",
    after: "/photos/sidespace-placements/restaurant-window-after.jpg",
    beforeAlt: "Restaurant facade with a clear street-facing picture window",
    afterAlt: "The same restaurant window with a translucent amber SideSpace vinyl",
  },
  {
    number: "03",
    type: "COMMUNITY SURFACE",
    title: "Local attention, courtside.",
    before: "/photos/sidespace-placements/court-fence-before.jpg",
    after: "/photos/sidespace-placements/court-fence-after.jpg",
    beforeAlt: "Neighborhood basketball court with an empty chain-link fence",
    afterAlt: "The same basketball-court fence with an amber SideSpace sponsor banner",
  },
  {
    number: "04",
    type: "LARGE FORMAT",
    title: "A blank wall, transformed into a landmark.",
    before: "/photos/sidespace-placements/wall-before.jpg",
    after: "/photos/sidespace-placements/wall-after.jpg",
    beforeAlt: "Blank cream side wall on a neighborhood corner building",
    afterAlt: "The same wall painted with a large amber and charcoal SideSpace mural",
  },
] as const;

const PLACEMENT_COPY: Record<
  string,
  {
    type: TranslationKey;
    title: TranslationKey;
    beforeAlt: TranslationKey;
    afterAlt: TranslationKey;
  }
> = {
  "01": {
    type: "home.placementMovingType",
    title: "home.placementMovingTitle",
    beforeAlt: "home.placementMovingBeforeAlt",
    afterAlt: "home.placementMovingAfterAlt",
  },
  "02": {
    type: "home.placementGlassType",
    title: "home.placementGlassTitle",
    beforeAlt: "home.placementGlassBeforeAlt",
    afterAlt: "home.placementGlassAfterAlt",
  },
  "03": {
    type: "home.placementCommunityType",
    title: "home.placementCommunityTitle",
    beforeAlt: "home.placementCommunityBeforeAlt",
    afterAlt: "home.placementCommunityAfterAlt",
  },
  "04": {
    type: "home.placementLargeType",
    title: "home.placementLargeTitle",
    beforeAlt: "home.placementLargeBeforeAlt",
    afterAlt: "home.placementLargeAfterAlt",
  },
};

function CategoryReel() {
  const { t } = useLocale();

  function renderCards(isClone = false) {
    return (
      <div
        className={`ss-category-reel-set${isClone ? " is-clone" : ""}`}
        aria-hidden={isClone || undefined}
      >
        {CATEGORY_REEL.map(([label, channel, number]) => (
          <Link
            href={`/marketplace?channel=${encodeURIComponent(channel)}`}
            key={`${number}-${isClone ? "clone" : "original"}`}
            tabIndex={isClone ? -1 : undefined}
          >
            <span>{number}</span>
            <strong>{t(label)}</strong>
            <b aria-hidden="true" className="ss-icon-arrow">
              ↗
            </b>
          </Link>
        ))}
      </div>
    );
  }

  return (
    <div
      className="ss-category-reel"
      role="region"
      aria-label={t("home.categoryKicker")}
      onPointerCancel={(event) => {
        event.currentTarget.classList.remove("is-paused");
      }}
      onPointerDown={(event) => {
        event.currentTarget.classList.add("is-paused");
      }}
      onPointerLeave={(event) => {
        event.currentTarget.classList.remove("is-paused");
      }}
      onPointerUp={(event) => {
        event.currentTarget.classList.remove("is-paused");
      }}
    >
      <div className="ss-category-reel-track">
        {renderCards()}
        {renderCards(true)}
      </div>
    </div>
  );
}

function PlacementComparison({
  example,
  index,
}: {
  example: (typeof PLACEMENT_EXAMPLES)[number];
  index: number;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const { t } = useLocale();
  const [manual, setManual] = useState(false);
  const [position, setPosition] = useState(50);
  const comparisonRef = useRef<HTMLDivElement | null>(null);
  const dividerRef = useRef<HTMLDivElement | null>(null);
  const auto = !reduceMotion && !manual;

  function takeControl() {
    if (manual) return;
    const comparison = comparisonRef.current?.getBoundingClientRect();
    const divider = dividerRef.current?.getBoundingClientRect();
    if (comparison && divider && comparison.width > 0) {
      const livePosition =
        ((divider.left + divider.width / 2 - comparison.left) /
          comparison.width) *
        100;
      setPosition(Math.min(88, Math.max(12, Math.round(livePosition))));
    }
    setManual(true);
  }

  const style = {
    "--ss-placement-position": `${position}%`,
    "--ss-placement-delay": `${index * -1.15}s`,
  } as CSSProperties;

  return (
    <div
      className={`ss-placement-comparison ${auto ? "is-auto" : "is-manual"}`}
      ref={comparisonRef}
      style={style}
    >
      <NextImage
        alt={t(PLACEMENT_COPY[example.number].beforeAlt)}
        className="ss-placement-before"
        decoding="async"
        height={1024}
        loading={index === 0 ? "eager" : "lazy"}
        sizes="(max-width: 760px) calc(100vw - 68px), 42vw"
        src={example.before}
        unoptimized
        width={1536}
      />
      <div className="ss-placement-after">
        <NextImage
          alt={t(PLACEMENT_COPY[example.number].afterAlt)}
          decoding="async"
          height={1024}
          loading={index === 0 ? "eager" : "lazy"}
          sizes="(max-width: 760px) calc(100vw - 68px), 42vw"
          src={example.after}
          unoptimized
          width={1536}
        />
      </div>
      <span className="ss-placement-state is-before">{t("home.compareBefore")}</span>
      <span className="ss-placement-state is-after">{t("home.compareWith")}</span>
      <div className="ss-placement-divider" ref={dividerRef} aria-hidden="true">
        <i>↔</i>
      </div>
      <input
        aria-label={t("home.compareAria", {
          title: t(PLACEMENT_COPY[example.number].title),
        })}
        max="88"
        min="12"
        onChange={(event) => {
          setManual(true);
          setPosition(Number(event.currentTarget.value));
        }}
        onFocus={takeControl}
        onPointerDown={takeControl}
        step="1"
        type="range"
        value={position}
      />
    </div>
  );
}

function PlacementGallery() {
  const { t } = useLocale();

  return (
    <div className="ss-placement-gallery">
      {PLACEMENT_EXAMPLES.map((example, index) => (
        <article className="ss-placement-example" key={example.number}>
          <header>
            <span>
              {example.number} / {t(PLACEMENT_COPY[example.number].type)}
            </span>
            <h3>{t(PLACEMENT_COPY[example.number].title)}</h3>
          </header>
          <PlacementComparison example={example} index={index} />
        </article>
      ))}
    </div>
  );
}

function ListingPreviewCard({
  listing,
  onOpen,
}: {
  listing: PublicListing;
  onOpen: (listingId: string) => void;
}) {
  const { locale, formatListingPrice, t } = useLocale();

  return (
    <article className="ss-listing-preview">
      <button
        className="ss-listing-preview-image"
        onClick={() => onOpen(listing.id)}
        aria-label={t("market.openListing", { title: listing.title })}
      >
        <img
          src={listing.image_url || "/photos/market-creator.jpg"}
          alt=""
          loading="lazy"
          decoding="async"
        />
          <span>{localizeListingChannel(locale, listing.channel)}</span>
      </button>
      <div>
        <p>
          {listing.owner.display_name}
          {listing.owner.verified && <b aria-label={t("chrome.verified")}>✓</b>}
          {listingCity(listing) && ` · ${listingCity(listing)}`}
          {listing.owner.is_demo && (
            <span className="ss-demo-label">{t("chrome.demo")}</span>
          )}
        </p>
        <button onClick={() => onOpen(listing.id)}>{listing.title}</button>
        <footer>
          <strong>{price(listing, formatListingPrice)}</strong>
          <span>/ {localizeListingUnit(locale, listing.price_unit)}</span>
          <button
            onClick={() => onOpen(listing.id)}
            aria-label={t("market.openListing", { title: listing.title })}
          >
            <span className="ss-icon-arrow" aria-hidden="true">
              ↗
            </span>
          </button>
        </footer>
      </div>
    </article>
  );
}

function HeroInventory({ listings }: { listings: PublicListing[] }) {
  const { locale, formatListingPrice, t } = useLocale();
  const picks = useMemo(() => pickInventory(listings), [listings]);
  const [active, setActive] = useState(0);
  const [onScreen, setOnScreen] = useState(true);
  const [tabVisible, setTabVisible] = useState(true);
  const [connectorStyle, setConnectorStyle] = useState<CSSProperties>({});
  const [positionedFor, setPositionedFor] = useState<number | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sourceRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const advancedRef = useRef(false);
  const reduceMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      ([entry]) => setOnScreen(entry.isIntersecting),
      { rootMargin: "140px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onVisibility = () => setTabVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const source = sourceRef.current;
    const card = cardRef.current;
    if (!host || !source || !card) return;

    const measureConnector = () => {
      // On a phone the stage is a vertical stack: source, then a downward
      // stem, then the listing. A measured diagonal (or a flattened sideways
      // bar) would point at empty space. CSS owns that stem; skip geometry.
      if (window.matchMedia("(max-width: 760px)").matches) {
        setConnectorStyle({
          "--ss-hero-cycle-duration": `${HERO_ROTATION_MS}ms`,
        } as CSSProperties);
        setPositionedFor(active);
        return;
      }

      const origin = (source.offsetParent as HTMLElement | null) ?? host;
      const originRect = origin.getBoundingClientRect();
      const sourceRect = source.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const sourceCenter = {
        x: sourceRect.left + sourceRect.width / 2,
        y: sourceRect.top + sourceRect.height / 2,
      };
      const cardCenter = {
        x: cardRect.left + cardRect.width / 2,
        y: cardRect.top + cardRect.height / 2,
      };
      const dx = cardCenter.x - sourceCenter.x;
      const dy = cardCenter.y - sourceCenter.y;
      const centerDistance = Math.hypot(dx, dy);
      if (centerDistance < 1) return;

      const unitX = dx / centerDistance;
      const unitY = dy / centerDistance;
      const distanceToEdge = (rect: DOMRect) =>
        Math.min(
          Math.abs(unitX) > 0.001
            ? rect.width / 2 / Math.abs(unitX)
            : Number.POSITIVE_INFINITY,
          Math.abs(unitY) > 0.001
            ? rect.height / 2 / Math.abs(unitY)
            : Number.POSITIVE_INFINITY,
        );
      const sourceEdge = distanceToEdge(sourceRect) + 9;
      const cardEdge = distanceToEdge(cardRect) + 9;
      const start = {
        x: sourceCenter.x + unitX * sourceEdge,
        y: sourceCenter.y + unitY * sourceEdge,
      };
      const end = {
        x: cardCenter.x - unitX * cardEdge,
        y: cardCenter.y - unitY * cardEdge,
      };
      const length = Math.max(0, Math.hypot(end.x - start.x, end.y - start.y));

      setConnectorStyle({
        left: `${start.x - originRect.left}px`,
        top: `${start.y - originRect.top - 9}px`,
        transform: `rotate(${Math.atan2(end.y - start.y, end.x - start.x)}rad)`,
        width: `${length}px`,
        "--ss-hero-cycle-duration": `${HERO_ROTATION_MS}ms`,
      } as CSSProperties);
    };

    const frame = window.requestAnimationFrame(measureConnector);
    const settleTimer = window.setTimeout(() => {
      measureConnector();
      setPositionedFor(active);
    }, 680);
    const observer =
      "ResizeObserver" in window ? new ResizeObserver(measureConnector) : null;
    observer?.observe(host);
    window.addEventListener("resize", measureConnector);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      observer?.disconnect();
      window.removeEventListener("resize", measureConnector);
    };
  }, [active]);

  useEffect(() => {
    advancedRef.current = false;
    if (reduceMotion || !onScreen || !tabVisible || positionedFor !== active) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (advancedRef.current) return;
      advancedRef.current = true;
      setActive((current) => (current + 1) % INVENTORY_TYPES.length);
    }, HERO_ROTATION_MS);
    return () => window.clearTimeout(timer);
  }, [active, onScreen, positionedFor, reduceMotion, tabVisible]);

  const listing = picks[active];
  const inventory = INVENTORY_TYPES[active];
  const fallbackImage = HERO_FALLBACK_IMAGES[active];
  return (
    <div
      className="ss-inventory-stage"
      data-ss-parallax="0.13"
      data-ss-parallax-max="56"
      ref={hostRef}
    >
      <div
        aria-hidden="true"
        className="ss-hero-field"
        data-ss-parallax="0.035"
        data-ss-parallax-max="18"
      >
        <HeroCanvas />
      </div>
      <div
        className="ss-plane-fallback"
        data-ss-parallax="0.11"
        data-ss-parallax-max="46"
        aria-hidden="true"
      >
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <div
        className="ss-inventory-tabs"
        data-ss-parallax="0.045"
        data-ss-parallax-max="20"
        role="group"
        aria-label={t("home.audienceTitle")}
      >
        {INVENTORY_TYPES.map((item, index) => (
          <button
            key={item.label}
            aria-pressed={active === index}
            onClick={() => setActive(index)}
          >
            <span>{t(item.shortKey)}</span>
            <b>{t(item.labelKey)}</b>
          </button>
        ))}
      </div>
      <div className="ss-inventory-scene">
      <div
        className="ss-attention-source"
        key={`source-${active}`}
        ref={sourceRef}
      >
        <span>{t(inventory.shortKey)}</span>
        <strong>{t(inventory.labelKey)}</strong>
        <p>{t(inventory.detailKey)}</p>
        <i aria-hidden="true">{t("home.inventoryAttention")}</i>
      </div>
      <div
        className={`ss-transform-line${
          positionedFor === active ? " is-positioned" : ""
        }${
          !reduceMotion &&
          onScreen &&
          tabVisible &&
          positionedFor === active
            ? " is-running"
            : ""
        }`}
        key={`progress-${active}`}
        style={connectorStyle}
        aria-hidden="true"
      >
        <span>{t("home.inventoryList")}</span>
        <i>
          <span
            className="ss-transform-progress"
            onAnimationEnd={(event) => {
              if (
                (event.animationName === "ss-line-run" ||
                  event.animationName === "ss-line-run-y") &&
                !advancedRef.current &&
                !reduceMotion &&
                onScreen &&
                tabVisible &&
                positionedFor === active
              ) {
                advancedRef.current = true;
                setActive((current) =>
                  (current + 1) % INVENTORY_TYPES.length,
                );
              }
            }}
          />
        </i>
        <b />
      </div>
      <div
        className="ss-bookable-card"
        key={`listing-${active}`}
        ref={cardRef}
      >
        <div className="ss-bookable-top">
          <span>
            {t("pages.sidespace")}{" "}{listing ? t("home.inventoryMarketplace") : t("home.inventoryMarketplaceExample")} {t("home.inventoryLabel")}
          </span>
          {(!listing || !isListingRequestable(listing)) && (
            <b>● {listing ? t("home.inventoryViewOnly") : t("home.inventoryExample")}</b>
          )}
        </div>
        {listing ? (
          <>
            <img
              alt=""
              decoding="async"
              fetchPriority="high"
              onError={(event) => {
                if (!event.currentTarget.src.endsWith(fallbackImage)) {
                  event.currentTarget.src = fallbackImage;
                }
              }}
              src={listing.image_url || fallbackImage}
            />
            <div className="ss-bookable-body">
              <span>
                {listing && !inventory.match.test(listing.channel)
                  ? t(inventory.labelKey)
                  : listing?.channel
                    ? localizeListingChannel(locale, listing.channel)
                    : t(inventory.labelKey)}
              </span>
              <strong>{listing.title}</strong>
              <p>{listing.owner.display_name} · {listingCity(listing)}</p>
              <b>{price(listing, formatListingPrice)} / {localizeListingUnit(locale, listing.price_unit)}</b>
              {!isListingRequestable(listing) && (
                <small>{t("home.inventoryViewOnlyUntil")}</small>
              )}
            </div>
          </>
        ) : (
          <>
            <img
              alt=""
              decoding="async"
              fetchPriority="high"
              src={fallbackImage}
            />
            <div className="ss-bookable-body">
              <span>{t(inventory.labelKey)}</span>
              <strong>{t("home.inventoryReady")}</strong>
              <p>{t("home.inventoryOwnerSets")}</p>
              <b>{t("home.inventoryDirectConversation")}</b>
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
}

function FinalCall({ onList }: { onList: () => void }) {
  const { t } = useLocale();
  const sectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;

    const revealHighlight = () => {
      section.classList.add("is-highlighted");
    };

    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      !("IntersectionObserver" in window)
    ) {
      revealHighlight();
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        revealHighlight();
        observer.disconnect();
      },
      { rootMargin: "0px 0px -18% 0px", threshold: 0.2 },
    );

    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="ss-final-call" ref={sectionRef}>
      <p className="ss-kicker">{t("home.finalKicker")}</p>
      <h2 data-ss-parallax="0.045" data-ss-parallax-max="28">
        {t("home.finalTitleLead")}
        <br className="ss-everywhere-break" />{" "}
        <span className="ss-everywhere-highlight">
          <span className="ss-everywhere-highlight__base">
            {t("home.finalTitleAccent")}
          </span>
          <span
            aria-hidden="true"
            className="ss-everywhere-highlight__reveal"
          >
            {t("home.finalTitleAccent")}
          </span>
        </span>
        <br />
        <em>{t("home.finalTitleEm")}</em>
      </h2>
      <div>
        <Link className="ss-button is-dark" href="/marketplace">
          {t("home.finalBrowse")} <span aria-hidden="true" className="ss-icon-arrow">↗</span>
        </Link>
        <button className="ss-button is-light" onClick={onList}>
          {t("home.finalList")} <span aria-hidden="true" className="ss-icon-plus">＋</span>
        </button>
      </div>
    </section>
  );
}

export function LandingPage({
  listings,
  onJoin,
  onList,
}: {
  listings: PublicListing[];
  onJoin: () => void;
  onList: () => void;
}) {
  const { t } = useLocale();
  const [audience, setAudience] = useState<"advertise" | "offer">("advertise");
  const [activeProcess, setActiveProcess] = useState(0);
  const processRef = useRef<HTMLDivElement | null>(null);

  /**
   * The three-step band cycles only while it is on screen, and rewinds to 01
   * every time it comes back.
   *
   * It used to run a bare interval from mount, so by the time anyone scrolled
   * this far the story was mid-way through: you arrived at step 02 or 03 with
   * no idea you had missed the beginning. Leaving the viewport now parks it,
   * and returning restarts from the first step, so the first thing anyone sees
   * is the first step.
   */
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const band = processRef.current;
    // Each preview gets one complete 4.6 second widget cycle before the
    // emphasis moves on.
    const start = () =>
      window.setInterval(
        () => setActiveProcess((current) => (current + 1) % 3),
        4600,
      );

    // No observer: better a band that cycles than one frozen on step 01.
    if (!band || typeof IntersectionObserver === "undefined") {
      const timer = start();
      return () => window.clearInterval(timer);
    }

    let timer: number | undefined;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (timer) return;
          setActiveProcess(0);
          timer = start();
        } else if (timer) {
          window.clearInterval(timer);
          timer = undefined;
        }
      },
      // A sliver on screen is not "reading it" - wait until a good part of the
      // band is actually in view before starting the story.
      { threshold: 0.35 },
    );
    observer.observe(band);
    return () => {
      if (timer) window.clearInterval(timer);
      observer.disconnect();
    };
  }, []);

  return (
    <>
      <section className="ss-home-hero" id="main-content">
        <div
          className="ss-home-hero-copy"
          data-ss-parallax="0.045"
          data-ss-parallax-max="28"
        >
            <p className="ss-kicker">{t("home.heroKicker")}</p>
            <h1>
            {t("home.heroTitleLead")}
            <br />
            <em>{t("home.heroTitleAccent")}</em>
            </h1>
          <p className="ss-hero-deck">
            {t("home.heroDescription")}
          </p>
          <div className="ss-hero-actions">
            <Link className="ss-button is-dark" href="/marketplace">
              {t("home.browse")} <span aria-hidden="true" className="ss-icon-arrow">↗</span>
            </Link>
            <button className="ss-button is-light" onClick={onList}>
              {t("home.list")} <span aria-hidden="true" className="ss-icon-plus">＋</span>
            </button>
          </div>
          <ul className="ss-proof-row" aria-label={t("home.proofAria")}>
            <li>{t("home.proofFree")}</li>
            <li>{t("home.proofMessaging")}</li>
            <li>{t("home.proofPrice")}</li>
          </ul>
        </div>
        <HeroInventory listings={listings} />
      </section>

      <section className="ss-audience-section">
        <header
          className="ss-section-heading"
          data-ss-parallax="0.04"
          data-ss-parallax-max="26"
        >
          <p className="ss-kicker">{t("home.audienceKicker")}</p>
          <h2>{t("home.audienceTitle")}</h2>
          <p>
            {t("home.audienceDescription")}
          </p>
        </header>
        <div className={`ss-audience-split is-${audience}`}>
          <div className="ss-audience-controls" role="tablist" aria-label={t("home.audienceControlsAria")}>
            <button
              role="tab"
              aria-selected={audience === "advertise"}
              onClick={() => setAudience("advertise")}
              onMouseEnter={() => hoverIsFine() && setAudience("advertise")}
            >
              <span>{t("home.advertiserLabel")}</span>
              <strong>{t("home.advertiserTitle")}</strong>
              <p>
                {t("home.advertiserDescription")}
              </p>
            </button>
            <button
              role="tab"
              aria-selected={audience === "offer"}
              onClick={() => setAudience("offer")}
              onMouseEnter={() => hoverIsFine() && setAudience("offer")}
            >
              <span>{t("home.offerLabel")}</span>
              <strong>{t("home.offerTitle")}</strong>
              <p>
                {t("home.offerDescription")}
              </p>
            </button>
          </div>
          <div
            className="ss-audience-visual"
            data-ss-parallax="0.055"
            data-ss-parallax-max="28"
            aria-live="polite"
          >
            <div
              className="ss-audience-map"
              data-ss-parallax="0.17"
              data-ss-parallax-max="68"
            >
              <span className="is-one" />
              <span className="is-two" />
              <span className="is-three" />
              <span className="is-four" />
              <i />
            </div>
            <div className="ss-audience-copy" key={audience}>
              <span>
                {audience === "advertise"
                  ? t("home.advertiserTag")
                  : t("home.offerTag")}
              </span>
              <strong>
                {audience === "advertise"
                  ? t("home.advertiserStrong")
                  : t("home.offerStrong")}
              </strong>
              <ul>
                {(audience === "advertise"
                  ? ([
                      "home.itemCreators",
                      "home.itemStorefronts",
                      "home.itemVehicles",
                      "home.itemEvents",
                      "home.itemNewsletters",
                    ] as TranslationKey[])
                  : ([
                      "home.itemInstagram",
                      "home.itemWindows",
                      "home.itemWalls",
                      "home.itemCounters",
                      "home.itemTeams",
                      "home.itemNewsletters",
                    ] as TranslationKey[])
                ).map((item) => <li key={item}>{t(item)}</li>)}
              </ul>
              {audience === "advertise" ? (
                <Link href="/marketplace">
                  {t("home.advertiserLink")} {" "}
                  <span aria-hidden="true" className="ss-icon-arrow">
                    ↗
                  </span>
                </Link>
              ) : (
                <button onClick={onJoin}>
                  {t("home.offerLink")} {" "}
                  <span aria-hidden="true" className="ss-icon-arrow">
                    ↗
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="ss-category-section">
        <header
          className="ss-section-heading is-horizontal"
          data-ss-parallax="0.04"
          data-ss-parallax-max="26"
        >
          <div>
            <p className="ss-kicker">{t("home.categoryKicker")}</p>
            <h2>
              {t("home.categoryTitleLead")}
              <br />
              <em>{t("home.categoryTitleAccent")}</em>
            </h2>
          </div>
          <p>
            {t("home.categoryDescription")}
          </p>
        </header>
        <CategoryReel />
        <PlacementGallery />
      </section>

      <section className="ss-how-preview">
        <header
          className="ss-section-heading is-horizontal"
          data-ss-parallax="0.04"
          data-ss-parallax-max="26"
        >
          <div>
            <p className="ss-kicker">{t("home.howKicker")}</p>
            <h2>
              {t("home.howTitleLead")}
              <br />
              <em>{t("home.howTitleAccent")}</em>
            </h2>
          </div>
          <Link href="/how-it-works">
            {t("home.howLink")} {" "}
            <span aria-hidden="true" className="ss-icon-arrow">
              ↗
            </span>
          </Link>
        </header>
        <div className="ss-process-row" ref={processRef}>
          <article
            className={activeProcess === 0 ? "is-active" : undefined}
            aria-current={activeProcess === 0 ? "step" : undefined}
            onMouseEnter={() => hoverIsFine() && setActiveProcess(0)}
          >
            <span>{t("home.processDiscoverLabel")}</span>
            <div className="ss-mini-search" aria-hidden="true">
              <b>⌕</b><span>{t("home.processSearch")}</span><i>12</i>
            </div>
            <h3>{t("home.processDiscoverTitle")}</h3>
            <p>{t("home.processDiscoverCopy")}</p>
            <i className="ss-process-progress" aria-hidden="true" />
          </article>
          <article
            className={activeProcess === 1 ? "is-active" : undefined}
            aria-current={activeProcess === 1 ? "step" : undefined}
            onMouseEnter={() => hoverIsFine() && setActiveProcess(1)}
          >
            <span>{t("home.processTalkLabel")}</span>
            <div className="ss-mini-chat" aria-hidden="true">
              <p>{t("home.processChatOne")}</p><p>{t("home.processChatTwo")}</p>
            </div>
            <h3>{t("home.processTalkTitle")}</h3>
            <p>{t("home.processTalkCopy")}</p>
            <i className="ss-process-progress" aria-hidden="true" />
          </article>
          <article
            className={activeProcess === 2 ? "is-active" : undefined}
            aria-current={activeProcess === 2 ? "step" : undefined}
            onMouseEnter={() => hoverIsFine() && setActiveProcess(2)}
          >
            <span>{t("home.processMakeLabel")}</span>
            <div className="ss-mini-deal" aria-hidden="true">
              <span>{t("home.processCampaignRequest")}</span><strong>{t("pages.n1202Weeks")}</strong><b>{t("home.processAgreed")}</b>
            </div>
            <h3>{t("home.processMakeTitle")}</h3>
            <p>{t("home.processMakeCopy")}</p>
            <i className="ss-process-progress" aria-hidden="true" />
          </article>
        </div>
      </section>

      <FinalCall onList={onList} />
    </>
  );
}

type JourneySide = "advertiser" | "owner";

type JourneyStep = {
  eyebrowKey: TranslationKey;
  titleKey: TranslationKey;
  copyKey: TranslationKey;
};

const JOURNEY_STEPS: Record<JourneySide, readonly JourneyStep[]> = {
  advertiser: [
    {
      eyebrowKey: "how.advertiserStep1Label",
      titleKey: "how.advertiserStep1Title",
      copyKey: "how.advertiserStep1Copy",
    },
    {
      eyebrowKey: "how.advertiserStep2Label",
      titleKey: "how.advertiserStep2Title",
      copyKey: "how.advertiserStep2Copy",
    },
    {
      eyebrowKey: "how.advertiserStep3Label",
      titleKey: "how.advertiserStep3Title",
      copyKey: "how.advertiserStep3Copy",
    },
    {
      eyebrowKey: "how.advertiserStep4Label",
      titleKey: "how.advertiserStep4Title",
      copyKey: "how.advertiserStep4Copy",
    },
    {
      eyebrowKey: "how.advertiserStep5Label",
      titleKey: "how.advertiserStep5Title",
      copyKey: "how.advertiserStep5Copy",
    },
  ],
  owner: [
    {
      eyebrowKey: "how.ownerStep1Label",
      titleKey: "how.ownerStep1Title",
      copyKey: "how.ownerStep1Copy",
    },
    {
      eyebrowKey: "how.ownerStep2Label",
      titleKey: "how.ownerStep2Title",
      copyKey: "how.ownerStep2Copy",
    },
    {
      eyebrowKey: "how.ownerStep3Label",
      titleKey: "how.ownerStep3Title",
      copyKey: "how.ownerStep3Copy",
    },
    {
      eyebrowKey: "how.ownerStep4Label",
      titleKey: "how.ownerStep4Title",
      copyKey: "how.ownerStep4Copy",
    },
    {
      eyebrowKey: "how.ownerStep5Label",
      titleKey: "how.ownerStep5Title",
      copyKey: "how.ownerStep5Copy",
    },
  ],
};

const JOURNEY_OPTIONS: ReadonlyArray<{
  side: JourneySide;
  labelKey: TranslationKey;
}> = [
  { side: "advertiser", labelKey: "how.optionAdvertiser" },
  { side: "owner", labelKey: "how.optionOwner" },
];

const JOURNEY_DEMO_IMAGES = [
  "/photos/corner-store.jpg",
  "/photos/market-creator.jpg",
] as const;

const JOURNEY_CURSOR_LABELS: Record<JourneySide, readonly TranslationKey[]> = {
  advertiser: [
    "how.advertiserStep1Label",
    "how.advertiserStep2Label",
    "how.advertiserStep3Label",
    "how.advertiserStep4Label",
    "how.advertiserStep5Label",
  ],
  owner: [
    "how.ownerStep1Label",
    "how.ownerStep2Label",
    "how.ownerStep3Label",
    "how.ownerStep4Label",
    "how.ownerStep5Label",
  ],
};

function JourneyDemoCursor({ onDemonstrate, side, step }: { onDemonstrate: () => void; side: JourneySide; step: number }) {
  const { t } = useLocale();

  return (
    <div aria-hidden="true" className={`ss-demo-cursor is-${side}-${step}`}>
      <span className="ss-demo-cursor-ripple" />
      <span
        className="ss-demo-cursor-trigger"
        onAnimationEnd={(event) => {
          if (event.animationName === "ss-demo-cursor-trigger") onDemonstrate();
        }}
      />
      <svg fill="none" viewBox="0 0 24 30">
        <path d="M3 2.5v20.1l5.2-4.3 4.1 8.2 3.7-1.9-4-7.9h7.2L3 2.5Z" />
      </svg>
      <b>{t(JOURNEY_CURSOR_LABELS[side][step])}</b>
    </div>
  );
}

function JourneyScene({ side, step }: { side: JourneySide; step: number }) {
  const { formatCurrency, formatDate, t } = useLocale();
  const [selectedItem, setSelectedItem] = useState(0);
  const [actionComplete, setActionComplete] = useState(false);
  const [termsEnabled, setTermsEnabled] = useState([true, true]);
  const money = (dollars: number) => formatCurrency(dollars * 100);
  const demoDate = (month: number, day: number) =>
    formatDate(new Date(Date.UTC(2026, month, day)), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  const sep12To14 = `${demoDate(8, 12)} — ${demoDate(8, 14)}`;
  const sep20To22 = `${demoDate(8, 20)} — ${demoDate(8, 22)}`;
  const oct04 = demoDate(9, 4);

  function demonstrateAction() {
    if (side === "advertiser") {
      if (step === 0 || step === 1) setSelectedItem(1);
      else setActionComplete(true);
      return;
    }

    if (step === 2) setSelectedItem(1);
    else setActionComplete(true);
  }

  function withCursor(scene: ReactNode) {
    return <>{scene}<JourneyDemoCursor onDemonstrate={demonstrateAction} side={side} step={step} /></>;
  }

  if (side === "advertiser") {
    if (step === 0) {
      return withCursor(
        <div className="ss-demo-scene is-searching">
          <div className="ss-scene-search"><span>⌕</span><strong><i>{t("how.demo.searchPlaceholder")}</i></strong><kbd>↵</kbd></div>
          <div className="ss-scene-results">
            <button aria-pressed={selectedItem === 0} className={selectedItem === 0 ? "is-selected" : undefined} onClick={() => setSelectedItem(0)} type="button"><img src="/photos/corner-store.jpg" alt="" /><span><small>{t("how.demo.storefrontMeta")}</small><strong>{t("how.demo.frontWindowPlacement")}</strong><em>{t("how.demo.twoWeeksRate", { amount: money(240) })}</em></span><b>01</b></button>
            <button aria-pressed={selectedItem === 1} className={selectedItem === 1 ? "is-selected" : undefined} data-cursor-target onClick={() => setSelectedItem(1)} type="button"><img src="/photos/market-creator.jpg" alt="" /><span><small>{t("how.demo.creatorMeta")}</small><strong>{t("how.demo.storySavedHighlight")}</strong><em>{t("how.demo.campaignRate", { amount: money(180) })}</em></span><b>02</b></button>
          </div>
          <p className="ss-demo-hint">{t("how.demo.chooseResult")}</p>
        </div>
      );
    }

    if (step === 1) {
      const shortlist = [
        [t("how.demo.storefrontWindow"), money(240), t("how.demo.days", { count: 5 })],
        [t("how.demo.creatorStory"), money(180), t("how.demo.days", { count: 3 })],
        [t("how.demo.cafeCounterCards"), money(95), t("how.demo.days", { count: 2 })],
      ];

      return withCursor(
        <div className="ss-demo-scene is-comparing">
          <div className="ss-scene-title"><small>{t("how.demo.yourShortlist")}</small><strong>{t("how.demo.shortlistTitle")}</strong><span>{t("how.demo.savedCount", { count: 3 })}</span></div>
          <div className="ss-compare-head"><span>{t("how.demo.offering")}</span><span>{t("how.demo.rate")}</span><span>{t("how.demo.leadTime")}</span></div>
          {shortlist.map(([name, rate, lead], index) => <button aria-pressed={selectedItem === index} className={selectedItem === index ? "ss-compare-row is-best" : "ss-compare-row"} data-cursor-target={index === 1 ? true : undefined} key={name} onClick={() => setSelectedItem(index)} type="button"><span><i>{index + 1}</i>{name}</span><strong>{rate}</strong><span>{lead}</span></button>)}
          <div className="ss-scene-note"><i>✓</i><span><strong>{t("how.demo.selectedForBrief")}</strong>{shortlist[selectedItem][0]} · {t("how.demo.leadTimeValue", { value: shortlist[selectedItem][2] })}</span></div>
        </div>
      );
    }

    if (step === 2) {
      return withCursor(
        <div className="ss-demo-scene is-requesting">
          <div className="ss-scene-title"><small>{t("home.processCampaignRequest")}</small><strong>{t("how.demo.neighborhoodLaunch")}</strong><span>{t("how.demo.draft")}</span></div>
          <div className="ss-request-grid">
            <label><span>{t("how.demo.runDates")}</span><strong>{sep12To14}</strong></label>
            <label><span>{t("how.demo.workingBudget")}</span><strong>{money(600)}</strong></label>
          </div>
          <div className="ss-request-brief"><span>{t("how.demo.whatShouldRun")}</span><p>{t("how.demo.briefCopy")}</p></div>
          <div className="ss-scene-action"><span>{actionComplete ? t("how.demo.offerDelivered") : t("how.demo.deliverablesAttached")}</span><button className={actionComplete ? "is-complete" : undefined} data-cursor-target onClick={() => setActionComplete((current) => !current)} type="button">{actionComplete ? t("how.demo.offerSent") : t("how.demo.sendOffer")}</button></div>
        </div>
      );
    }

    if (step === 3) {
      return withCursor(
        <div className="ss-demo-scene is-talking">
          <div className="ss-thread-person"><span>{t("pages.mc")}</span><div><strong>{t("pages.mayaChen")}</strong><small>{t("how.demo.activeNow")}</small></div><b>•••</b></div>
          <div className="ss-scene-thread">
            <p>{t("how.demo.staysInHighlight")}</p>
            <p>{t("how.demo.canIncludeTotal", { amount: money(640) })}</p>
          </div>
          {actionComplete ? (
            <div className="ss-payout-screen"><span>{t("how.demo.paymentSecured")}</span><strong>{money(640)}</strong><p>{t("how.demo.payoutScheduled")}</p><div><small>{t("how.demo.recipient")}</small><b>{t("pages.mayaChen")}</b><small>{t("how.demo.status")}</small><b>{t("how.demo.ready")}</b></div></div>
          ) : (
            <div className="ss-counter-card"><span>{t("how.demo.counterOffer")}</span><strong>{money(640)}</strong><small>{t("how.demo.storyTwoWeekHighlight")}</small><div><button data-cursor-target onClick={() => setActionComplete(true)} type="button">{t("how.demo.accept")}</button><button onClick={() => setActionComplete(false)} type="button">{t("how.demo.reply")}</button></div></div>
          )}
        </div>
      );
    }

    return withCursor(
      <div className="ss-demo-scene is-agreed">
        <div className="ss-agreed-mark">✓</div>
        <small>{t("how.demo.campaignAgreed")}</small>
        <h3>{t("how.demo.neighborhoodLaunch")}</h3>
        <p>{t("pages.mayaChenLittleSunCoffee")}</p>
        <div className="ss-agreed-details"><span><small>{t("how.demo.dates")}</small><strong>{sep12To14}</strong></span><span><small>{t("how.demo.agreedTotal")}</small><strong>{money(640)}</strong></span></div>
        <button className={`ss-agreed-next${actionComplete ? " is-open" : ""}`} data-cursor-target={actionComplete ? undefined : true} onClick={() => setActionComplete(true)} type="button"><i>{actionComplete ? "✓" : "01"}</i><span><strong>{actionComplete ? t("how.demo.assetThreadReady") : t("how.demo.nextUp")}</strong>{actionComplete ? t("how.demo.assetThreadCopy") : t("how.demo.shareFinalAssets")}</span></button>
      </div>
    );
  }

  if (step === 0) {
    return withCursor(
      <div className="ss-demo-scene is-listing">
        <div className="ss-listing-photo"><img src="/photos/market-creator.jpg" alt="" /><span>{t("how.demo.addPhotos")}</span></div>
        <div className="ss-listing-form"><small>{actionComplete ? t("how.demo.draftSaved") : t("how.demo.newOffering")}</small><h3>{t("how.demo.localStorySavedHighlight")}</h3><div><button aria-pressed={selectedItem === 0} className={selectedItem === 0 ? "is-active" : undefined} onClick={() => setSelectedItem(0)} type="button">{t("how.demo.creator")}</button><button aria-pressed={selectedItem === 1} className={selectedItem === 1 ? "is-active" : undefined} onClick={() => setSelectedItem(1)} type="button">{t("how.demo.physical")}</button><button aria-pressed={selectedItem === 2} className={selectedItem === 2 ? "is-active" : undefined} onClick={() => setSelectedItem(2)} type="button">{t("how.demo.sponsorship")}</button></div><p>{t("how.demo.reachNeighbors")}</p><button className={actionComplete ? "is-complete" : undefined} data-cursor-target onClick={() => setActionComplete((current) => !current)} type="button">{actionComplete ? `${t("how.demo.draftSaved")} ✓` : t("how.demo.continue")}</button></div>
      </div>
    );
  }

  if (step === 1) {
    return withCursor(
      <div className="ss-demo-scene is-terms">
        <div className="ss-scene-title"><small>{t("how.demo.priceAvailability")}</small><strong>{t("how.demo.decideTerms")}</strong><span>{t("how.demo.stepTwoOfThree")}</span></div>
        <div className="ss-terms-rate"><span>{t("how.demo.yourRate")}</span><strong>{money(180)}</strong><small>{t("how.demo.perCampaign")}</small></div>
        <div className="ss-terms-grid"><label><span>{t("how.demo.leadTime")}</span><strong>{t("how.demo.days", { count: 3 })}</strong></label><label><span>{t("how.demo.available")}</span><strong>{t("how.demo.thursdaySunday")}</strong></label></div>
        <button aria-pressed={termsEnabled[0]} className="ss-terms-rule" onClick={() => setTermsEnabled((current) => [!current[0], current[1]])} type="button"><span>{t("how.demo.savedHighlightIncluded")}</span><i>{termsEnabled[0] ? t("how.demo.yes") : t("how.demo.no")}</i></button>
        <button aria-pressed={termsEnabled[1]} className="ss-terms-rule" onClick={() => setTermsEnabled((current) => [current[0], !current[1]])} type="button"><span>{t("how.demo.productApprovalRequired")}</span><i>{termsEnabled[1] ? t("how.demo.yes") : t("how.demo.no")}</i></button>
        <div className="ss-scene-action"><span>{actionComplete ? t("how.demo.offeringVisible") : t("how.demo.changeAnytime")}</span><button className={actionComplete ? "is-complete" : undefined} data-cursor-target onClick={() => setActionComplete((current) => !current)} type="button">{actionComplete ? t("how.demo.published") : t("how.demo.publishOffering")}</button></div>
      </div>
    );
  }

  if (step === 2) {
    const offers = [
      ["Little Sun Coffee", money(600), sep12To14],
      ["Morrow Records", money(425), sep20To22],
      ["Cedar Run Club", money(260), oct04],
    ];

    return withCursor(
      <div className="ss-demo-scene is-offers">
        <div className="ss-scene-title"><small>{t("how.demo.incomingOffers", { count: offers.length })}</small><strong>{t("how.demo.chooseFits")}</strong><span>{t("how.demo.selectedRate", { rate: offers[selectedItem][1] })}</span></div>
        {offers.map(([name, rate, dates], index) => <button aria-pressed={selectedItem === index} className={selectedItem === index ? "is-best" : undefined} data-cursor-target={index === 1 ? true : undefined} key={name} onClick={() => setSelectedItem(index)} type="button"><span>{name.slice(0, 2).toUpperCase()}</span><span><strong>{name}</strong><small>{dates}</small></span><b>{rate}</b><i>{selectedItem === index ? t("how.demo.selected") : t("how.demo.view")}</i></button>)}
      </div>
    );
  }

  if (step === 3) {
    return withCursor(
      <div className="ss-demo-scene is-talking">
        <div className="ss-thread-person"><span>{t("pages.ls")}</span><div><strong>{t("pages.littleSunCoffee")}</strong><small>{t("how.demo.businessCampaignRequest")}</small></div><b>•••</b></div>
        <div className="ss-scene-thread"><p>{t("how.demo.includeHighlight")}</p><p>{t("how.demo.totalTo", { amount: money(640) })}</p></div>
        <div className={`ss-counter-compose${actionComplete ? " is-complete" : ""}`}><span>{actionComplete ? t("how.demo.counterSent") : t("how.demo.yourCounter")}</span><strong>{actionComplete ? "✓" : money(640)}</strong><p>{t("how.demo.includesStory")}</p><button data-cursor-target onClick={() => setActionComplete((current) => !current)} type="button">{actionComplete ? t("how.demo.sent") : t("how.demo.sendCounter")}</button></div>
      </div>
    );
  }

  return withCursor(
    actionComplete ? (
      <div className="ss-demo-scene is-payout">
        <div className="ss-payout-mark">✓</div>
        <small>{t("how.demo.payoutDetails")}</small>
        <h3>{money(640)}</h3>
        <p>{t("how.demo.scheduledCompleted")}</p>
        <div className="ss-payout-breakdown"><span><small>{t("how.demo.from")}</small><strong>{t("pages.littleSunCoffee")}</strong></span><span><small>{t("home.processCampaignRequest")}</small><strong>{sep12To14}</strong></span><span><small>{t("how.demo.status")}</small><strong>{t("how.demo.ready")}</strong></span></div>
      </div>
    ) : (
      <div className="ss-demo-scene is-accepting">
        <small>{t("how.demo.finalOffer")}</small>
        <h3>{t("how.demo.neighborhoodLaunch")}</h3>
        <p>{t("how.demo.wantsStory")}</p>
        <div className="ss-final-offer"><span><small>{t("how.demo.dates")}</small><strong>{sep12To14}</strong></span><span><small>{t("how.demo.youReceive")}</small><strong>{money(640)}</strong></span></div>
        <button data-cursor-target onClick={() => setActionComplete(true)} type="button">{t("how.demo.acceptOffer")}</button>
      </div>
    )
  );
}

export function HowItWorksPage({ onJoin }: { onJoin: () => void }) {
  const { t } = useLocale();
  const [side, setSide] = useState<JourneySide>("advertiser");
  const [activeStep, setActiveStep] = useState(0);
  const [stepDirection, setStepDirection] = useState(1);
  const [isJourneyInView, setIsJourneyInView] = useState(false);
  const [isJourneyPaused, setIsJourneyPaused] = useState(false);
  const [isPageVisible, setIsPageVisible] = useState(true);
  const journeyRef = useRef<HTMLElement>(null);
  const pointerInteractionRef = useRef(false);
  const reduceMotion = useReducedMotion() ?? false;
  const steps = JOURNEY_STEPS[side];
  const journeyPlaying = !reduceMotion && isJourneyInView && !isJourneyPaused && isPageVisible;
  const sideDirection = side === "owner" ? 1 : -1;
  const contentTransition = reduceMotion
    ? { duration: 0.14, ease: "linear" as const }
    : { type: "spring" as const, bounce: 0, duration: 0.36 };
  const contentVariants = {
    enter: (enterDirection: number) => ({
      opacity: 0,
      transform: reduceMotion ? "translate3d(0,0,0)" : `translate3d(${enterDirection * 18}px,0,0)`,
    }),
    center: { opacity: 1, transform: "translate3d(0,0,0)" },
    exit: (exitDirection: number) => ({
      opacity: 0,
      transform: reduceMotion ? "translate3d(0,0,0)" : `translate3d(${exitDirection * -18}px,0,0)`,
    }),
  };
  const sceneVariants = {
    enter: (enterDirection: number) => ({
      opacity: 0,
      transform: reduceMotion
        ? "translate3d(0,0,0)"
        : `translate3d(0,${enterDirection * 14}px,0) scale(0.99)`,
    }),
    center: { opacity: 1, transform: "translate3d(0,0,0) scale(1)" },
    exit: (exitDirection: number) => ({
      opacity: 0,
      transform: reduceMotion
        ? "translate3d(0,0,0)"
        : `translate3d(0,${exitDirection * -10}px,0) scale(0.995)`,
    }),
  };

  useEffect(() => {
    // Both journeys should be ready before the first switch so the image never
    // arrives a beat after the surrounding copy.
    JOURNEY_DEMO_IMAGES.forEach((src) => {
      const image = new Image();
      image.src = src;
    });
  }, []);

  useEffect(() => {
    const section = journeyRef.current;
    if (!section || !("IntersectionObserver" in window)) {
      setIsJourneyInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setIsJourneyInView(entry.isIntersecting),
      { rootMargin: "-12% 0px -12% 0px", threshold: 0.16 },
    );
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => setIsPageVisible(!document.hidden);
    handleVisibilityChange();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  function selectSide(nextSide: JourneySide) {
    if (nextSide === side) return;
    setSide(nextSide);
    setActiveStep(0);
    setStepDirection(1);
  }

  function selectStep(nextStep: number) {
    setStepDirection(nextStep >= activeStep ? 1 : -1);
    setActiveStep(nextStep);
  }

  function advanceJourney() {
    if (!journeyPlaying) return;
    setStepDirection(1);
    setActiveStep((current) => (current + 1) % steps.length);
  }

  function handleJourneyKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    let nextSide: JourneySide | null = null;

    if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "Home") {
      nextSide = "advertiser";
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "End") {
      nextSide = "owner";
    }

    if (!nextSide) return;

    event.preventDefault();
    selectSide(nextSide);
    document.getElementById(`ss-journey-${nextSide}-tab`)?.focus();
  }

  return (
    <>
      <section className="ss-page-hero ss-how-hero" id="main-content">
        <p className="ss-kicker">{t("how.kicker")}</p>
        <h1 data-ss-parallax="0.05" data-ss-parallax-max="30">
          {t("how.titleLead")}
          <br />
          <em>{t("how.titleAccent")}</em>
        </h1>
        <p>
          {t("how.description")}
        </p>
        <div
          className="ss-journey-switch"
          role="tablist"
          aria-label={t("how.journeyAria")}
        >
          {JOURNEY_OPTIONS.map((option) => {
            const isSelected = side === option.side;

            return (
              <button
                aria-controls="ss-journey-panel"
                aria-selected={isSelected}
                id={`ss-journey-${option.side}-tab`}
                key={option.side}
                onClick={() => selectSide(option.side)}
                onKeyDown={handleJourneyKeyDown}
                role="tab"
                tabIndex={isSelected ? 0 : -1}
              >
                {isSelected && (
                  <motion.span
                    aria-hidden="true"
                    className="ss-journey-switch-indicator"
                    layoutId="ss-journey-switch-indicator"
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : { type: "spring", bounce: 0, duration: 0.4 }
                    }
                  />
                )}
                <span className="ss-journey-switch-label">{t(option.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section
        aria-labelledby={`ss-journey-${side}-tab`}
        className={`ss-journey${journeyPlaying ? " is-playing" : " is-paused"}`}
        id="ss-journey-panel"
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsJourneyPaused(false);
        }}
        onFocusCapture={() => {
          if (!pointerInteractionRef.current) setIsJourneyPaused(true);
        }}
        onKeyDownCapture={() => setIsJourneyPaused(true)}
        onPointerCancelCapture={() => { pointerInteractionRef.current = false; }}
        onPointerDownCapture={() => { pointerInteractionRef.current = true; }}
        onPointerUpCapture={() => { pointerInteractionRef.current = false; }}
        ref={journeyRef}
        role="tabpanel"
      >
        <div className="ss-journey-steps">
          <AnimatePresence custom={sideDirection} initial={false} mode="popLayout">
            <motion.div
              animate="center"
              className="ss-journey-steps-content"
              custom={sideDirection}
              exit="exit"
              initial="enter"
              key={side}
              transition={contentTransition}
              variants={contentVariants}
            >
              <div className="ss-journey-step-intro">
                <span>
                  {side === "advertiser"
                    ? t("how.forBusinesses")
                    : t("how.forCreators")}
                </span>
                <p>
                  {reduceMotion ? t("how.chooseStep") : t("how.followStep")}
                </p>
              </div>
              {steps.map((step, index) => (
                <button
                  aria-current={activeStep === index ? "step" : undefined}
                  className={activeStep === index ? "is-active" : undefined}
                  key={step.titleKey}
                  onClick={() => selectStep(index)}
                  type="button"
                >
                  <span>
                    {String(index + 1).padStart(2, "0")} / {t(step.eyebrowKey)}
                  </span>
                  <div>
                    <h2>{t(step.titleKey)}</h2>
                    <p>{t(step.copyKey)}</p>
                  </div>
                  <i aria-hidden="true" className="ss-journey-step-progress" onAnimationEnd={advanceJourney} />
                </button>
              ))}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="ss-journey-demo">
          <div className="ss-demo-window">
            <header>
              <i /><i /><i />
              <span>
                {t("pages.sidespace")}{" "}{side === "advertiser" ? t("how.forBusinesses") : t("how.forCreators")}
              </span>
              <b>
                {String(activeStep + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}
              </b>
            </header>
            <AnimatePresence custom={stepDirection} initial={false} mode="wait">
            <motion.div
              animate="center"
              className="ss-demo-stage"
              custom={stepDirection}
              exit="exit"
              initial="enter"
              key={`${side}-${activeStep}`}
              transition={reduceMotion ? { duration: 0.14 } : { duration: 0.42, ease: [0.23, 1, 0.32, 1] }}
              variants={sceneVariants}
            >
              <JourneyScene side={side} step={activeStep} />
            </motion.div>
            </AnimatePresence>
            <footer>
              <span>{t(steps[activeStep].eyebrowKey)}</span>
              <div aria-hidden="true">
                {steps.map((_, index) => (
                  <i
                    className={index <= activeStep ? "is-filled" : undefined}
                    key={index}
                  />
                ))}
              </div>
              <b>
                {journeyPlaying
                  ? t("how.playing")
                  : reduceMotion
                    ? t("how.manual")
                    : t("how.paused")}
              </b>
            </footer>
          </div>
        </div>
      </section>

      <section className="ss-principles-band">
        <article>
          <span>{t("how.controlLabel")}</span>
          <h3>{t("how.controlTitle")}</h3>
          <p>{t("how.controlCopy")}</p>
        </article>
        <article>
          <span>{t("how.contextLabel")}</span>
          <h3>{t("how.contextTitle")}</h3>
          <p>{t("how.contextCopy")}</p>
        </article>
        <article>
          <span>{t("how.conversationLabel")}</span>
          <h3>{t("how.conversationTitle")}</h3>
          <p>{t("how.conversationCopy")}</p>
        </article>
      </section>

      <section className="ss-page-cta">
        <p className="ss-kicker">{t("how.ctaKicker")}</p>
        <h2>{t("how.ctaTitle")}</h2>
        <div>
          <Link className="ss-button is-dark" href="/marketplace">
            {t("how.ctaBrowse")} {" "}
            <span aria-hidden="true" className="ss-icon-arrow">
              ↗
            </span>
          </Link>
          <button className="ss-button is-light" onClick={onJoin}>
            {t("how.ctaCreate")} {" "}
            <span aria-hidden="true" className="ss-icon-plus">
              ＋
            </span>
          </button>
        </div>
      </section>
    </>
  );
}

export function CreatorsPage({
  listings,
  onList,
  onOpenListing,
}: {
  listings: PublicListing[];
  onList: () => void;
  onOpenListing: (listingId: string) => void;
}) {
  const { t } = useLocale();
  const bookable = listings.filter((listing) => !isDemandBrief(listing));
  const creatorInventory = bookable.filter((listing) =>
    /instagram|tiktok|youtube|newsletter|creator|sponsor|story|video|window|storefront|vehicle|wall|counter|board|room|placement/i.test(
      `${listing.channel} ${listing.title}`,
    ),
  );
  const examples = (creatorInventory.length ? creatorInventory : bookable).slice(0, 4);

  return (
    <>
      <section className="ss-page-hero ss-creators-hero" id="main-content">
        <div data-ss-parallax="0.045" data-ss-parallax-max="28">
          <p className="ss-kicker">{t("creators.heroKicker")}</p>
          <h1>
            {t("creators.heroTitleLead")}
            <br />
            <em>{t("creators.heroTitleAccent")}</em>
          </h1>
          <p>
            {t("creators.heroDescription")}
          </p>
          <button className="ss-button is-dark" onClick={onList}>
            {t("creators.heroButton")} <span aria-hidden="true" className="ss-icon-arrow">↗</span>
          </button>
        </div>
        <div className="ss-creator-stack">
          <article className="is-social" data-ss-parallax="0.1" data-ss-parallax-max="44"><span>{t("creators.socialLabel")}</span><img src="/photos/market-creator.jpg" alt={t("pages.localCreatorAtAnOutdoorMarket")} /><strong>{t("creators.socialTitle")}</strong><p>{t("creators.socialCopy")}</p></article>
          <article className="is-newsletter" data-ss-parallax="0.18" data-ss-parallax-max="62"><span>{t("creators.newsletterLabel")}</span><strong>{t("creators.newsletterTitle")}</strong><p>{t("creators.newsletterCopy")}</p><b>{t("creators.newsletterPrice")}</b></article>
          <article className="is-event" data-ss-parallax="0.14" data-ss-parallax-max="54"><span>{t("creators.eventLabel")}</span><strong>{t("creators.eventTitle")}</strong><p>{t("creators.eventCopy")}</p></article>
        </div>
      </section>

      <section className="ss-creator-types">
        {([
          ["creators.typeSocial", "creators.typeSocialCopy"],
          ["creators.typeNewsletter", "creators.typeNewsletterCopy"],
          ["creators.typePlacement", "creators.typePlacementCopy"],
          ["creators.typeTeams", "creators.typeTeamsCopy"],
          ["creators.typeEvents", "creators.typeEventsCopy"],
          ["creators.typePodcasts", "creators.typePodcastsCopy"],
        ] as Array<[TranslationKey, TranslationKey]>
        ).map(([titleKey, copyKey], index) => (
          <article key={titleKey}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <h2>{t(titleKey)}</h2>
            <p>{t(copyKey)}</p>
          </article>
        ))}
      </section>

      <section className="ss-creator-offer">
        <div>
          <p className="ss-kicker">{t("creators.offerKicker")}</p>
          <h2>
            {t("creators.offerTitleLead")}
            <br />
            <em>{t("creators.offerTitleAccent")}</em>
          </h2>
        </div>
        <ol>
          <li><span>01</span><div><strong>{t("creators.stepOneTitle")}</strong><p>{t("creators.stepOneCopy")}</p></div></li>
          <li><span>02</span><div><strong>{t("creators.stepTwoTitle")}</strong><p>{t("creators.stepTwoCopy")}</p></div></li>
          <li><span>03</span><div><strong>{t("creators.stepThreeTitle")}</strong><p>{t("creators.stepThreeCopy")}</p></div></li>
        </ol>
      </section>

      <section className="ss-live-preview">
        <header className="ss-section-heading is-horizontal" data-ss-parallax="0.04" data-ss-parallax-max="26">
          <div>
            <p className="ss-kicker">{t("creators.inventoryKicker")}</p>
            <h2>
              {t("creators.inventoryTitleLead")}
              <br />
              <em>{t("creators.inventoryTitleAccent")}</em>
            </h2>
          </div>
          <Link href="/marketplace?intent=supply">
            {t("creators.inventoryLink")} {" "}
            <span aria-hidden="true" className="ss-icon-arrow">
              ↗
            </span>
          </Link>
        </header>
        <div className="ss-preview-grid">{examples.map((listing) => <ListingPreviewCard listing={listing} onOpen={onOpenListing} key={listing.id} />)}</div>
      </section>
      <FinalCall onList={onList} />
    </>
  );
}

export function PricingPage({ onJoin }: { onJoin: () => void }) {
  const { t } = useLocale();

  return (
    <>
      <section className="ss-page-hero ss-pricing-hero" id="main-content">
        <p className="ss-kicker">{t("pricing.heroKicker")}</p>
        <h1 data-ss-parallax="0.05" data-ss-parallax-max="30">
          {t("pricing.heroTitleLead")}
          <br />
          <em>{t("pricing.heroTitleAccent")}</em>
        </h1>
        <p>
          {t("pricing.heroDescription")}
        </p>
        <button className="ss-button is-dark" onClick={onJoin}>
          {t("pricing.heroButton")} <span aria-hidden="true" className="ss-icon-arrow">↗</span>
        </button>
      </section>

      <section className="ss-current-pricing" aria-labelledby="current-pricing-title">
        <div className="ss-current-flag" data-ss-parallax="0.06" data-ss-parallax-max="28"><span>{t("pricing.current")}</span><b>{t("pricing.liveNow")}</b></div>
        <div data-ss-parallax="0.11" data-ss-parallax-max="42"><p className="ss-kicker">{t("pricing.marketplace")}</p><h2 id="current-pricing-title">5% + 5%</h2><p className="ss-price"><strong>$0</strong><span>{t("pricing.month")}</span></p></div>
        <ul data-ss-parallax="0.08" data-ss-parallax-max="34"><li>{t("pricing.businessPays")}</li><li>{t("pricing.creatorReceives")}</li><li>{t("pricing.tax")}</li><li>{t("pricing.stripe")}</li><li>{t("pricing.noMinimum")}</li></ul>
        <button onClick={onJoin}>
          {t("pricing.createAccount")} {" "}
          <span aria-hidden="true" className="ss-icon-arrow">
            ↗
          </span>
        </button>
      </section>

      <section className="ss-future-pricing" aria-labelledby="future-pricing-title">
        <header><div><p className="ss-kicker">{t("pricing.exampleKicker")}</p><h2 id="future-pricing-title">{t("pricing.exampleTitle")}</h2></div><p>{t("pricing.exampleDescription")}</p></header>
        <div>
          <article><span>{t("pricing.business")}</span><h3>{t("pricing.businessPaysAmount")}</h3><p>{t("pricing.businessExplanation")}</p><ul><li>{t("pricing.agreedCampaign")}</li><li>{t("pricing.buyerFee")}</li><li>{t("pricing.taxAdded")}</li></ul></article>
          <article><span>{t("pricing.creator")}</span><h3>{t("pricing.creatorEarns")}</h3><p>{t("pricing.creatorExplanation")}</p><ul><li>{t("pricing.agreedCampaign")}</li><li>{t("pricing.creatorFee")}</li><li>{t("pricing.creatorPayout")}</li></ul></article>
        </div>
      </section>

      <section className="ss-pricing-truth">
        <h2>{t("pricing.hostedTitle")}</h2>
        <p>{t("pricing.hostedCopy")}</p>
      </section>

      <section className="ss-page-cta">
        <p className="ss-kicker">{t("pricing.ctaKicker")}</p>
        <h2>{t("pricing.ctaTitle")}</h2>
        <div>
          <Link className="ss-button is-light" href="/marketplace">
            {t("pricing.browseFirst")} {" "}
            <span aria-hidden="true" className="ss-icon-arrow">
              ↗
            </span>
          </Link>
          <button className="ss-button is-dark" onClick={onJoin}>
            {t("pricing.join")} {" "}
            <span aria-hidden="true" className="ss-icon-plus">
              ＋
            </span>
          </button>
        </div>
      </section>
    </>
  );
}

export function DashboardGate({
  onSignIn,
  onJoin,
}: {
  onSignIn: () => void;
  onJoin: () => void;
}) {
  const { t } = useLocale();

  return (
    <section className="ss-dashboard-gate" id="main-content">
      <p className="ss-kicker">{t("dashboard.gateKicker")}</p>
      <h1>
        {t("dashboard.gateTitleLead")}
        <br />
        <em>{t("dashboard.gateTitleAccent")}</em>
      </h1>
      <p>
        {t("dashboard.gateDescription")}
      </p>
      <div>
        <button className="ss-button is-dark" onClick={onSignIn}>
          {t("dashboard.signIn")} <span aria-hidden="true" className="ss-icon-arrow">↗</span>
        </button>
        <button className="ss-button is-light" onClick={onJoin}>
          {t("dashboard.join")} <span aria-hidden="true" className="ss-icon-plus">＋</span>
        </button>
      </div>
    </section>
  );
}
