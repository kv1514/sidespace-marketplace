"use client";

/* Public marketplace images can be remote Supabase URLs whose hosts are not
   fixed at build time; static and live cards intentionally share one element. */
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import NextImage from "next/image";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { formatCents } from "@/lib/payments/fees";
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
import { useT } from "@/lib/i18n/client";
import { msg } from "@/lib/i18n";

export type PublicListing = {
  id: string;
  title: string;
  channel: string;
  format: string;
  price_cents: number;
  price_max_cents?: number | null;
  price_unit: string;
  description: string;
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

function price(listing: PublicListing) {
  const low = Number(listing.price_cents || 0);
  const high = Number(listing.price_max_cents || 0);
  return high > low
    ? `${formatCents(low)}–${formatCents(high)}`
    : formatCents(low);
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
const INVENTORY_TYPES = [
  {
    label: msg("Storefront"),
    short: msg("WINDOW / 01"),
    detail: msg("A real window on a real street"),
    match: /storefront|window|wall|mural|room|interior|board|counter|main street|farm stand|cafe|bakery/i,
  },
  {
    label: msg("Creator"),
    short: msg("AUDIENCE / 02"),
    detail: msg("A trusted voice people already follow"),
    match: /instagram|tiktok|youtube|newsletter|podcast|twitch|website/i,
  },
  {
    label: msg("Vehicle"),
    short: msg("ROUTE / 03"),
    detail: msg("A moving placement with a local routine"),
    match: /vehicle/i,
  },
  {
    label: msg("Event"),
    short: msg("CROWD / 04"),
    detail: msg("A team, gathering, or local occasion"),
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

const CATEGORY_REEL = [
  [msg("Instagram Story"), msg("Instagram"), "01"],
  [msg("TikTok"), msg("TikTok"), "02"],
  [msg("Newsletter"), msg("Newsletter"), "03"],
  [msg("Storefront window"), msg("Storefront"), "04"],
  [msg("Cafe counter"), msg("Storefront"), "05"],
  [msg("Vehicle"), msg("Vehicle"), "06"],
  [msg("Community board"), msg("Community board"), "07"],
  [msg("Wall"), msg("Wall / mural"), "08"],
  [msg("Event sponsorship"), msg("Sponsorship"), "09"],
  [msg("Team sponsorship"), msg("Sponsorship"), "10"],
] as const;

const PLACEMENT_EXAMPLES = [
  {
    number: "01",
    type: msg("MOVING PLACEMENT"),
    title: msg("A daily route, turned into mobile reach."),
    before: "/photos/sidespace-placements/car-before.jpg",
    after: "/photos/sidespace-placements/car-after.jpg",
    beforeAlt: msg("Plain white car parked on a neighborhood street"),
    afterAlt: msg("The same white car with a cream, amber, and charcoal SideSpace wrap"),
  },
  {
    number: "02",
    type: msg("STREET-FACING GLASS"),
    title: msg("Dinner traffic, captured at eye level."),
    before: "/photos/sidespace-placements/restaurant-window-before.jpg",
    after: "/photos/sidespace-placements/restaurant-window-after.jpg",
    beforeAlt: msg("Restaurant facade with a clear street-facing picture window"),
    afterAlt: msg("The same restaurant window with a translucent amber SideSpace vinyl"),
  },
  {
    number: "03",
    type: msg("COMMUNITY SURFACE"),
    title: msg("Local attention, courtside."),
    before: "/photos/sidespace-placements/court-fence-before.jpg",
    after: "/photos/sidespace-placements/court-fence-after.jpg",
    beforeAlt: msg("Neighborhood basketball court with an empty chain-link fence"),
    afterAlt: msg("The same basketball-court fence with an amber SideSpace sponsor banner"),
  },
  {
    number: "04",
    type: msg("LARGE FORMAT"),
    title: msg("A blank wall, transformed into a landmark."),
    before: "/photos/sidespace-placements/wall-before.jpg",
    after: "/photos/sidespace-placements/wall-after.jpg",
    beforeAlt: msg("Blank cream side wall on a neighborhood corner building"),
    afterAlt: msg("The same wall painted with a large amber and charcoal SideSpace mural"),
  },
] as const;

function CategoryReel() {
  const t = useT();
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
            <strong>{label}</strong>
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
      aria-label={t("SideSpace inventory categories")}
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
  const t = useT();
  const reduceMotion = useReducedMotion() ?? false;
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
        alt={t(example.beforeAlt)}
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
          alt={t(example.afterAlt)}
          decoding="async"
          height={1024}
          loading={index === 0 ? "eager" : "lazy"}
          sizes="(max-width: 760px) calc(100vw - 68px), 42vw"
          src={example.after}
          unoptimized
          width={1536}
        />
      </div>
      <span className="ss-placement-state is-before">{t("Before")}</span>
      <span className="ss-placement-state is-after">{t("With SideSpace")}</span>
      <div className="ss-placement-divider" ref={dividerRef} aria-hidden="true">
        <i>↔</i>
      </div>
      <input
        aria-label={t("Compare {title} before and after SideSpace advertising", { title: example.title })}
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
  const t = useT();
  return (
    <div className="ss-placement-gallery">
      {PLACEMENT_EXAMPLES.map((example, index) => (
        <article className="ss-placement-example" key={example.number}>
          <header>
            <span>{example.number} / {t(example.type)}</span>
            <h3>{t(example.title)}</h3>
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
  const t = useT();
  return (
    <article className="ss-listing-preview">
      <button
        className="ss-listing-preview-image"
        onClick={() => onOpen(listing.id)}
        aria-label={t("View {title}", { title: listing.title })}
      >
        <img
          src={listing.image_url || "/photos/market-creator.jpg"}
          alt=""
          loading="lazy"
          decoding="async"
        />
        <span>{listing.channel}</span>
      </button>
      <div>
        <p>
          {listing.owner.display_name}
          {listing.owner.verified && <b aria-label={t("Verified")}>✓</b>}
          {listingCity(listing) && ` · ${listingCity(listing)}`}
          {listing.owner.is_demo && (
            <span className="ss-demo-label">{t("Demo")}</span>
          )}
        </p>
        <button onClick={() => onOpen(listing.id)}>{listing.title}</button>
        <footer>
          <strong>{price(listing)}</strong>
          <span>/ {listing.price_unit}</span>
          <button onClick={() => onOpen(listing.id)} aria-label={t("Open {title}", { title: listing.title })}>
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
  const t = useT();
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
  /**
   * What the card calls this listing's kind.
   *
   * Normally the listing's own channel, which is what the marketplace shows
   * everywhere else. But a pinned listing can be one this tab's matcher would
   * never have found - Aiden's campus run is channel "Other" - and "OTHER"
   * reads as a hole in the set next to STOREFRONT, YOUTUBE and VEHICLE. The
   * hero is a showcase of four kinds, so when a listing's channel does not
   * belong to the tab it is being shown under, the card is labelled with that
   * kind instead of its own.
   *
   * This can only ever affect an editorial override: every unpinned listing
   * comes out of the matched set, so its channel passes this test by
   * construction and it keeps its own label. Nothing outside the hero is
   * touched - the listing is still "Other" on its own page and in the grid,
   * because that is what its owner chose.
   */
  const kindLabel =
    listing && !inventory.match.test(listing.channel)
      ? inventory.label
      : listing?.channel;

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
        aria-label={t("Kinds of local attention")}
      >
        {INVENTORY_TYPES.map((item, index) => (
          <button
            key={item.label}
            aria-pressed={active === index}
            onClick={() => setActive(index)}
          >
            <span>{t(item.short)}</span>
            <b>{t(item.label)}</b>
          </button>
        ))}
      </div>
      <div className="ss-inventory-scene">
      <div
        className="ss-attention-source"
        key={`source-${active}`}
        ref={sourceRef}
      >
        <span>{t(inventory.short)}</span>
        <strong>{t(inventory.label)}</strong>
        <p>{inventory.detail}</p>
        <i aria-hidden="true">{t("LOCAL ATTENTION")}</i>
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
        <span>{t("LIST")}</span>
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
            {t("SIDESPACE /")}{" "}{listing ? t("MARKETPLACE") : t("MARKETPLACE EXAMPLE")}{" "}{t("INVENTORY")}
          </span>
          {(!listing || !isListingRequestable(listing)) && (
            <b>● {listing ? t("VIEW ONLY") : t("EXAMPLE")}</b>
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
              <span>{kindLabel}</span>
              <strong>{listing.title}</strong>
              <p>{listing.owner.display_name} · {listingCity(listing)}</p>
              <b>{price(listing)} / {listing.price_unit}</b>
              {!isListingRequestable(listing) && (
                <small>{t("View-only until the owner confirms it is still available.")}</small>
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
              <span>{t(inventory.label)}</span>
              <strong>{t("Local attention, ready to book")}</strong>
              <p>{t("Owner sets the details and the price")}</p>
              <b>{t("Direct conversation")}</b>
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
}

function FinalCall({ onList }: { onList: () => void }) {
  const t = useT();
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
      <p className="ss-kicker">{t("THE SPACE BETWEEN A BUSINESS AND ITS NEXT CUSTOMER")}</p>
      <h2 data-ss-parallax="0.045" data-ss-parallax-max="28">
        {t("Attention is already")}
        <br className="ss-everywhere-break" />{" "}
        <span className="ss-everywhere-highlight">
          <span className="ss-everywhere-highlight__base">{t("everywhere.")}</span>
          <span
            aria-hidden="true"
            className="ss-everywhere-highlight__reveal"
          >
            {t("everywhere.")}
          </span>
        </span>
        <br />
        <em>{t("SideSpace makes it bookable.")}</em>
      </h2>
      <div>
        <Link className="ss-button is-dark" href="/marketplace">
          {t("Browse marketplace")}{" "}<span aria-hidden="true" className="ss-icon-arrow">↗</span>
        </Link>
        <button className="ss-button is-light" onClick={onList}>
          {t("List what you have")}{" "}<span aria-hidden="true" className="ss-icon-plus">＋</span>
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
  const t = useT();
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
          <p className="ss-kicker">{t("THE MARKETPLACE FOR LOCAL ATTENTION")}</p>
          <h1>
            {t("Local attention,")}
            <br />
            <em>{t("now bookable.")}</em>
          </h1>
          <p className="ss-hero-deck">
            {t("Book creators offering social, physical, and sponsorship inventory—or list the way you can advertise.")}
          </p>
          <div className="ss-hero-actions">
            <Link className="ss-button is-dark" href="/marketplace">
              {t("Browse the marketplace")}{" "}<span aria-hidden="true" className="ss-icon-arrow">↗</span>
            </Link>
            <button className="ss-button is-light" onClick={onList}>
              {t("List what you have to advertise")}{" "}<span aria-hidden="true" className="ss-icon-plus">＋</span>
            </button>
          </div>
          <ul className="ss-proof-row" aria-label={t("SideSpace benefits")}>
            <li>{t("Free to join")}</li>
            <li>{t("Direct messaging")}</li>
            <li>{t("Owners set the price")}</li>
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
          <p className="ss-kicker">{t("TWO SIDES, ONE LOCAL MARKET")}</p>
          <h2>{t("What brings you here?")}</h2>
          <p>
            {t("SideSpace connects the people looking for attention with the people and places that already have it.")}
          </p>
        </header>
        <div className={`ss-audience-split is-${audience}`}>
          <div className="ss-audience-controls" role="tablist" aria-label={t("Choose your SideSpace path")}>
            <button
              role="tab"
              aria-selected={audience === "advertise"}
              onClick={() => setAudience("advertise")}
              onMouseEnter={() => hoverIsFine() && setAudience("advertise")}
            >
              <span>{t("01 / ADVERTISERS")}</span>
              <strong>{t("I want to advertise")}</strong>
              <p>
                {t("Find creators and real-world places where your local audience already spends attention.")}
              </p>
            </button>
            <button
              role="tab"
              aria-selected={audience === "offer"}
              onClick={() => setAudience("offer")}
              onMouseEnter={() => hoverIsFine() && setAudience("offer")}
            >
              <span>{t("02 / CREATORS & LOCAL OWNERS")}</span>
              <strong>{t("I have attention to offer")}</strong>
              <p>
                {t("List the audience, placement, or sponsorship inventory you control, set your price, and talk directly with businesses.")}
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
              <span>{audience === "advertise" ? t("SEARCH / REQUEST / AGREE") : t("LIST / PRICE / TALK")}</span>
              <strong>
                {audience === "advertise"
                  ? t("Choose the exact person or place—not a vague audience segment.")
                  : t("Turn what people already notice into inventory you control.")}
              </strong>
              <ul>
                {(audience === "advertise"
                  ? [t("Creators"), t("Storefronts"), t("Vehicles"), t("Events"), t("Newsletters")]
                  : ["Instagram", t("Windows"), t("Walls"), t("Counters"), t("Teams"), t("Newsletters")]
                ).map((item) => <li key={item}>{item}</li>)}
              </ul>
              {audience === "advertise" ? (
                <Link href="/marketplace">
                  {t("Find places to advertise")}{" "}
                  <span aria-hidden="true" className="ss-icon-arrow">
                    ↗
                  </span>
                </Link>
              ) : (
                <button onClick={onJoin}>
                  {t("List my reach")}{" "}
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
            <p className="ss-kicker">{t("WHAT CAN BE LISTED")}</p>
            <h2>{t("More than ad space.")}<br /><em>{t("Anything people notice.")}</em></h2>
          </div>
          <p>
            {t("Digital audiences, everyday surfaces, and local moments all live in one marketplace.")}
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
            <p className="ss-kicker">{t("A DIRECT PATH FROM INTEREST TO AGREEMENT")}</p>
            <h2>{t("Find it. Talk directly.")}<br /><em>{t("Make it happen.")}</em></h2>
          </div>
          <Link href="/how-it-works">
            {t("See how SideSpace works")}{" "}
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
            <span>{t("01 / DISCOVER")}</span>
            <div className="ss-mini-search" aria-hidden="true">
              <b>⌕</b><span>{t("Storefront near Fullerton")}</span><i>12</i>
            </div>
            <h3>{t("Find the right attention.")}</h3>
            <p>{t("Search a specific creator, audience, placement, or town.")}</p>
            <i className="ss-process-progress" aria-hidden="true" />
          </article>
          <article
            className={activeProcess === 1 ? "is-active" : undefined}
            aria-current={activeProcess === 1 ? "step" : undefined}
            onMouseEnter={() => hoverIsFine() && setActiveProcess(1)}
          >
            <span>{t("02 / TALK DIRECTLY")}</span>
            <div className="ss-mini-chat" aria-hidden="true">
              <p>{t("Could this run next Friday?")}</p><p>{t("Yes—here are the dimensions.")}</p>
            </div>
            <h3>{t("Message the person in control.")}</h3>
            <p>{t("No broker between you and the owner, creator, or host.")}</p>
            <i className="ss-process-progress" aria-hidden="true" />
          </article>
          <article
            className={activeProcess === 2 ? "is-active" : undefined}
            aria-current={activeProcess === 2 ? "step" : undefined}
            onMouseEnter={() => hoverIsFine() && setActiveProcess(2)}
          >
            <span>{t("03 / MAKE IT HAPPEN")}</span>
            <div className="ss-mini-deal" aria-hidden="true">
              <span>{t("CAMPAIGN REQUEST")}</span><strong>{t("$120 / 2 weeks")}</strong><b>{t("AGREED ✓")}</b>
            </div>
            <h3>{t("Agree on the real details.")}</h3>
            <p>{t("Set price, timing, placement, and deliverables together.")}</p>
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
  eyebrow: string;
  title: string;
  copy: string;
};

const JOURNEY_STEPS: Record<JourneySide, readonly JourneyStep[]> = {
  advertiser: [
    {
      eyebrow: msg("FIND"),
      title: msg("Browse real offerings."),
      copy: msg("Search by place, format, audience, or local market and see exactly who controls each listing."),
    },
    {
      eyebrow: msg("COMPARE"),
      title: msg("Build a focused shortlist."),
      copy: msg("Compare the rate, timing, reach, and format before choosing who you want to work with."),
    },
    {
      eyebrow: msg("REQUEST"),
      title: msg("Send a clear offer."),
      copy: msg("Share the campaign goal, dates, deliverables, and working budget with the creator."),
    },
    {
      eyebrow: msg("DISCUSS"),
      title: msg("Work out the details."),
      copy: msg("Message directly, answer questions, and respond when the creator counters your offer."),
    },
    {
      eyebrow: msg("AGREE"),
      title: msg("Confirm the right fit."),
      copy: msg("Accept the final price and plan together so everyone knows what happens next."),
    },
  ],
  owner: [
    {
      eyebrow: msg("CREATE"),
      title: msg("Post what you can offer."),
      copy: msg("Turn an audience, window, wall, route, team, or event into a specific bookable listing."),
    },
    {
      eyebrow: msg("SET TERMS"),
      title: msg("Name your price and boundaries."),
      copy: msg("Choose the rate, availability, lead time, deliverables, and practical limits you control."),
    },
    {
      eyebrow: msg("REVIEW"),
      title: msg("Compare incoming offers."),
      copy: msg("See each business's budget, dates, campaign idea, and requested deliverables side by side."),
    },
    {
      eyebrow: msg("RESPOND"),
      title: msg("Counter or clarify."),
      copy: msg("Ask questions, suggest a different price, or decline anything that is not right for you."),
    },
    {
      eyebrow: msg("CHOOSE"),
      title: msg("Accept the offer that fits."),
      copy: msg("You make the final call. Agree only when the business, timing, and campaign feel right."),
    },
  ],
};

const JOURNEY_OPTIONS: ReadonlyArray<{ side: JourneySide; label: string }> = [
  { side: "advertiser", label: msg("I want to advertise") },
  { side: "owner", label: msg("I have attention to offer") },
];

const JOURNEY_DEMO_IMAGES = [
  "/photos/corner-store.jpg",
  "/photos/market-creator.jpg",
] as const;

const JOURNEY_CURSOR_LABELS: Record<JourneySide, readonly string[]> = {
  advertiser: [msg("OPEN"), msg("COMPARE"), msg("SEND"), msg("ACCEPT"), msg("NEXT")],
  owner: [msg("CONTINUE"), msg("PUBLISH"), msg("REVIEW"), msg("COUNTER"), msg("ACCEPT")],
};

function JourneyDemoCursor({ onDemonstrate, side, step }: { onDemonstrate: () => void; side: JourneySide; step: number }) {
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
      <b>{JOURNEY_CURSOR_LABELS[side][step]}</b>
    </div>
  );
}

function JourneyScene({ side, step }: { side: JourneySide; step: number }) {
  const t = useT();
  const [selectedItem, setSelectedItem] = useState(0);
  const [actionComplete, setActionComplete] = useState(false);
  const [termsEnabled, setTermsEnabled] = useState([true, true]);

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
          <div className="ss-scene-search"><span>⌕</span><strong><i>{t("Creator or storefront near Fullerton")}</i></strong><kbd>↵</kbd></div>
          <div className="ss-scene-results">
            <button aria-pressed={selectedItem === 0} className={selectedItem === 0 ? "is-selected" : undefined} onClick={() => setSelectedItem(0)} type="button"><img src="/photos/corner-store.jpg" alt="" /><span><small>{t("STOREFRONT · 0.8 MI")}</small><strong>{t("Front window placement")}</strong><em>{t("$240 / 2 weeks")}</em></span><b>01</b></button>
            <button aria-pressed={selectedItem === 1} className={selectedItem === 1 ? "is-selected" : undefined} data-cursor-target onClick={() => setSelectedItem(1)} type="button"><img src="/photos/market-creator.jpg" alt="" /><span><small>{t("LOCAL CREATOR · 1.4 MI")}</small><strong>{t("Story + saved highlight")}</strong><em>{t("$180 / campaign")}</em></span><b>02</b></button>
          </div>
          <p className="ss-demo-hint">{t("Choose either result to preview the selection.")}</p>
        </div>
      );
    }

    if (step === 1) {
      const shortlist = [
        [t("Storefront window"), "$240", t("5 days")],
        [t("Creator story"), "$180", t("3 days")],
        [t("Cafe counter cards"), "$95", t("2 days")],
      ];

      return withCursor(
        <div className="ss-demo-scene is-comparing">
          <div className="ss-scene-title"><small>{t("YOUR SHORTLIST")}</small><strong>{t("Three ways to reach the neighborhood")}</strong><span>{t("3 saved")}</span></div>
          <div className="ss-compare-head"><span>{t("OFFERING")}</span><span>{t("RATE")}</span><span>{t("LEAD TIME")}</span></div>
          {shortlist.map(([name, rate, lead], index) => <button aria-pressed={selectedItem === index} className={selectedItem === index ? "ss-compare-row is-best" : "ss-compare-row"} data-cursor-target={index === 1 ? true : undefined} key={name} onClick={() => setSelectedItem(index)} type="button"><span><i>{index + 1}</i>{name}</span><strong>{rate}</strong><span>{lead}</span></button>)}
          <div className="ss-scene-note"><i>✓</i><span><strong>{t("Selected for the brief")}</strong>{t("{shortlist} · {shortlist2} lead time", { shortlist: shortlist[selectedItem][0], shortlist2: shortlist[selectedItem][2] })}</span></div>
        </div>
      );
    }

    if (step === 2) {
      return withCursor(
        <div className="ss-demo-scene is-requesting">
          <div className="ss-scene-title"><small>{t("CAMPAIGN REQUEST")}</small><strong>{t("Neighborhood launch weekend")}</strong><span>{t("DRAFT")}</span></div>
          <div className="ss-request-grid">
            <label><span>{t("RUN DATES")}</span><strong>{t("SEP 12 — SEP 14")}</strong></label>
            <label><span>{t("WORKING BUDGET")}</span><strong>$600</strong></label>
          </div>
          <div className="ss-request-brief"><span>{t("WHAT SHOULD RUN?")}</span><p>{t("One story showing the opening, saved to a local guide highlight for two weeks.")}</p></div>
          <div className="ss-scene-action"><span>{actionComplete ? t("Offer delivered to Maya") : t("3 deliverables attached")}</span><button className={actionComplete ? "is-complete" : undefined} data-cursor-target onClick={() => setActionComplete((current) => !current)} type="button">{actionComplete ? t("OFFER SENT ✓") : t("SEND OFFER ↗")}</button></div>
        </div>
      );
    }

    if (step === 3) {
      return withCursor(
        <div className="ss-demo-scene is-talking">
          <div className="ss-thread-person"><span>{t("MC")}</span><div><strong>{t("Maya Chen")}</strong><small>{t("LOCAL CREATOR · ACTIVE NOW")}</small></div><b>•••</b></div>
          <div className="ss-scene-thread">
            <p>{t("Could the story stay in your local guide highlight for two weeks?")}</p>
            <p>{t("Yes. I can include that for $640 total.")}</p>
          </div>
          {actionComplete ? (
            <div className="ss-payout-screen"><span>{t("PAYMENT SECURED")}</span><strong>$640</strong><p>{t("Creator payout is scheduled after the campaign is completed.")}</p><div><small>{t("RECIPIENT")}</small><b>{t("Maya Chen")}</b><small>{t("STATUS")}</small><b>{t("READY")}</b></div></div>
          ) : (
            <div className="ss-counter-card"><span>{t("COUNTER OFFER")}</span><strong>$640</strong><small>{t("Story + 2-week saved highlight")}</small><div><button data-cursor-target onClick={() => setActionComplete(true)} type="button">{t("ACCEPT")}</button><button onClick={() => setActionComplete(false)} type="button">{t("REPLY")}</button></div></div>
          )}
        </div>
      );
    }

    return withCursor(
      <div className="ss-demo-scene is-agreed">
        <div className="ss-agreed-mark">✓</div>
        <small>{t("CAMPAIGN AGREED")}</small>
        <h3>{t("Neighborhood launch weekend")}</h3>
        <p>{t("Maya Chen × Little Sun Coffee")}</p>
        <div className="ss-agreed-details"><span><small>{t("DATES")}</small><strong>{t("SEP 12 — 14")}</strong></span><span><small>{t("AGREED TOTAL")}</small><strong>$640</strong></span></div>
        <button className={`ss-agreed-next${actionComplete ? " is-open" : ""}`} data-cursor-target={actionComplete ? undefined : true} onClick={() => setActionComplete(true)} type="button"><i>{actionComplete ? "✓" : "01"}</i><span><strong>{actionComplete ? t("Asset thread ready") : t("Next up")}</strong>{actionComplete ? t("Brief, files, and final details are now in one place.") : t("Share final assets in the campaign thread.")}</span></button>
      </div>
    );
  }

  if (step === 0) {
    return withCursor(
      <div className="ss-demo-scene is-listing">
        <div className="ss-listing-photo"><img src="/photos/market-creator.jpg" alt="" /><span>{t("＋ ADD PHOTOS")}</span></div>
        <div className="ss-listing-form"><small>{actionComplete ? t("DRAFT SAVED") : t("NEW OFFERING")}</small><h3>{t("Local story + saved highlight")}</h3><div><button aria-pressed={selectedItem === 0} className={selectedItem === 0 ? "is-active" : undefined} onClick={() => setSelectedItem(0)} type="button">{t("CREATOR")}</button><button aria-pressed={selectedItem === 1} className={selectedItem === 1 ? "is-active" : undefined} onClick={() => setSelectedItem(1)} type="button">{t("PHYSICAL")}</button><button aria-pressed={selectedItem === 2} className={selectedItem === 2 ? "is-active" : undefined} onClick={() => setSelectedItem(2)} type="button">{t("SPONSORSHIP")}</button></div><p>{t("Reach neighbors who follow local food, shops, and weekend plans.")}</p><button className={actionComplete ? "is-complete" : undefined} data-cursor-target onClick={() => setActionComplete((current) => !current)} type="button">{actionComplete ? t("DRAFT SAVED ✓") : t("CONTINUE ↗")}</button></div>
      </div>
    );
  }

  if (step === 1) {
    return withCursor(
      <div className="ss-demo-scene is-terms">
        <div className="ss-scene-title"><small>{t("PRICE & AVAILABILITY")}</small><strong>{t("You decide the terms")}</strong><span>{t("STEP 2 / 3")}</span></div>
        <div className="ss-terms-rate"><span>{t("YOUR RATE")}</span><strong><i>$</i>180</strong><small>{t("PER CAMPAIGN")}</small></div>
        <div className="ss-terms-grid"><label><span>{t("LEAD TIME")}</span><strong>{t("3 days")}</strong></label><label><span>{t("AVAILABLE")}</span><strong>{t("Thu — Sun")}</strong></label></div>
        <button aria-pressed={termsEnabled[0]} className="ss-terms-rule" onClick={() => setTermsEnabled((current) => [!current[0], current[1]])} type="button"><span>{t("Saved highlight included")}</span><i>{termsEnabled[0] ? t("YES") : t("NO")}</i></button>
        <button aria-pressed={termsEnabled[1]} className="ss-terms-rule" onClick={() => setTermsEnabled((current) => [current[0], !current[1]])} type="button"><span>{t("Product approval required")}</span><i>{termsEnabled[1] ? t("YES") : t("NO")}</i></button>
        <div className="ss-scene-action"><span>{actionComplete ? t("Your offering is now visible") : t("You can change these anytime")}</span><button className={actionComplete ? "is-complete" : undefined} data-cursor-target onClick={() => setActionComplete((current) => !current)} type="button">{actionComplete ? t("PUBLISHED ✓") : t("PUBLISH OFFERING ↗")}</button></div>
      </div>
    );
  }

  if (step === 2) {
    const offers = [
      ["Little Sun Coffee", "$600", "SEP 12 — 14"],
      ["Morrow Records", "$425", "SEP 20 — 22"],
      ["Cedar Run Club", "$260", "OCT 04"],
    ];

    return withCursor(
      <div className="ss-demo-scene is-offers">
        <div className="ss-scene-title"><small>{t("3 INCOMING OFFERS")}</small><strong>{t("Choose what fits your audience")}</strong><span>{t("{offers} SELECTED", { offers: offers[selectedItem][1] })}</span></div>
        {offers.map(([name, rate, dates], index) => <button aria-pressed={selectedItem === index} className={selectedItem === index ? "is-best" : undefined} data-cursor-target={index === 1 ? true : undefined} key={name} onClick={() => setSelectedItem(index)} type="button"><span>{name.slice(0, 2).toUpperCase()}</span><span><strong>{name}</strong><small>{dates}</small></span><b>{rate}</b><i>{selectedItem === index ? t("SELECTED") : t("VIEW")}</i></button>)}
      </div>
    );
  }

  if (step === 3) {
    return withCursor(
      <div className="ss-demo-scene is-talking">
        <div className="ss-thread-person"><span>{t("LS")}</span><div><strong>{t("Little Sun Coffee")}</strong><small>{t("BUSINESS · CAMPAIGN REQUEST")}</small></div><b>•••</b></div>
        <div className="ss-scene-thread"><p>{t("Could we include a saved highlight for two weeks?")}</p><p>{t("Yes—that would bring the total to $640.")}</p></div>
        <div className={`ss-counter-compose${actionComplete ? " is-complete" : ""}`}><span>{actionComplete ? t("COUNTER SENT") : t("YOUR COUNTER")}</span><strong>{actionComplete ? "✓" : "$640"}</strong><p>{t("Includes story + two-week saved highlight.")}</p><button data-cursor-target onClick={() => setActionComplete((current) => !current)} type="button">{actionComplete ? t("SENT ✓") : t("SEND COUNTER ↗")}</button></div>
      </div>
    );
  }

  return withCursor(
    actionComplete ? (
      <div className="ss-demo-scene is-payout">
        <div className="ss-payout-mark">✓</div>
        <small>{t("PAYOUT DETAILS")}</small>
        <h3>$640</h3>
        <p>{t("Scheduled after the campaign is completed.")}</p>
        <div className="ss-payout-breakdown"><span><small>{t("FROM")}</small><strong>{t("Little Sun Coffee")}</strong></span><span><small>{t("CAMPAIGN")}</small><strong>{t("SEP 12 — 14")}</strong></span><span><small>{t("STATUS")}</small><strong>{t("READY")}</strong></span></div>
      </div>
    ) : (
      <div className="ss-demo-scene is-accepting">
        <small>{t("FINAL OFFER")}</small>
        <h3>{t("Neighborhood launch weekend")}</h3>
        <p>{t("Little Sun Coffee wants a story and two-week saved highlight.")}</p>
        <div className="ss-final-offer"><span><small>{t("DATES")}</small><strong>{t("SEP 12 — 14")}</strong></span><span><small>{t("YOU RECEIVE")}</small><strong>$640</strong></span></div>
        <button data-cursor-target onClick={() => setActionComplete(true)} type="button">{t("ACCEPT OFFER ↗")}</button>
      </div>
    )
  );
}

export function HowItWorksPage({ onJoin }: { onJoin: () => void }) {
  const t = useT();
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
        <p className="ss-kicker">{t("HOW SIDESPACE WORKS")}</p>
        <h1 data-ss-parallax="0.05" data-ss-parallax-max="30">{t("One marketplace.")}<br /><em>{t("Two clear paths.")}</em></h1>
        <p>
          {t("Businesses find the attention they need. Creators, owners, and hosts decide what they offer. Both sides talk directly before anything runs.")}
        </p>
        <div className="ss-journey-switch" role="tablist" aria-label={t("Choose a SideSpace journey")}>
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
                <span className="ss-journey-switch-label">{t(option.label)}</span>
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
                <span>{side === "advertiser" ? t("FOR BUSINESSES") : t("FOR CREATORS")}</span>
                <p>{reduceMotion ? t("Choose a step to explore the journey.") : t("Follow the journey, or choose any step.")}</p>
              </div>
              {steps.map((step, index) => (
                <button
                  aria-current={activeStep === index ? "step" : undefined}
                  className={activeStep === index ? "is-active" : undefined}
                  key={step.title}
                  onClick={() => selectStep(index)}
                  type="button"
                >
                  <span>{String(index + 1).padStart(2, "0")} / {t(step.eyebrow)}</span>
                  <div><h2>{step.title}</h2><p>{step.copy}</p></div>
                  <i aria-hidden="true" className="ss-journey-step-progress" onAnimationEnd={advanceJourney} />
                </button>
              ))}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="ss-journey-demo">
          <div className="ss-demo-window">
            <header><i /><i /><i /><span>{t("SIDESPACE /")}{" "}{side === "advertiser" ? t("BUSINESS") : t("CREATOR")}</span><b>{String(activeStep + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}</b></header>
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
            <footer><span>{t(steps[activeStep].eyebrow)}</span><div aria-hidden="true">{steps.map((_, index) => <i className={index <= activeStep ? "is-filled" : undefined} key={index} />)}</div><b>{journeyPlaying ? t("PLAYING") : reduceMotion ? t("MANUAL") : t("PAUSED")}</b></footer>
          </div>
        </div>
      </section>

      <section className="ss-principles-band">
        <article><span>{t("CONTROL")}</span><h3>{t("The owner decides.")}</h3><p>{t("Every request can be discussed, countered, accepted, or declined.")}</p></article>
        <article><span>{t("CONTEXT")}</span><h3>{t("The listing is specific.")}</h3><p>{t("A real audience, surface, route, place, or event—not an abstract ad unit.")}</p></article>
        <article><span>{t("CONVERSATION")}</span><h3>{t("The parties talk directly.")}</h3><p>{t("Price, timing, fit, and campaign details stay in one private thread.")}</p></article>
      </section>

      <section className="ss-page-cta">
        <p className="ss-kicker">{t("START WITH THE SIDE THAT FITS YOU")}</p>
        <h2>{t("Ready to see what is already here?")}</h2>
        <div>
          <Link className="ss-button is-dark" href="/marketplace">
            {t("Browse marketplace")}{" "}
            <span aria-hidden="true" className="ss-icon-arrow">
              ↗
            </span>
          </Link>
          <button className="ss-button is-light" onClick={onJoin}>
            {t("Create a free profile")}{" "}
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
  const t = useT();
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
          <p className="ss-kicker">{t("CREATORS & LOCAL INVENTORY")}</p>
          <h1>{t("Your local reach")}<br /><em>{t("can work for you.")}</em></h1>
          <p>
            {t("List the way you can advertise—on social, in a newsletter, on a storefront, around a team, or at a local event. You choose the offer, the price, and every campaign.")}
          </p>
          <button className="ss-button is-dark" onClick={onList}>{t("List my reach")}{" "}<span aria-hidden="true" className="ss-icon-arrow">↗</span></button>
        </div>
        <div className="ss-creator-stack">
          <article className="is-social" data-ss-parallax="0.1" data-ss-parallax-max="44"><span>{t("INSTAGRAM / LOCAL")}</span><img src="/photos/market-creator.jpg" alt={t("Local creator at an outdoor market")} /><strong>{t("Story + saved highlight")}</strong><p>{t("Audience, format, rate")}</p></article>
          <article className="is-newsletter" data-ss-parallax="0.18" data-ss-parallax-max="62"><span>{t("NEWSLETTER / WEEKLY")}</span><strong>{t("The Friday local list")}</strong><p>{t("2.4K readers · One featured mention")}</p><b>{t("OWNER SETS THE PRICE")}</b></article>
          <article className="is-event" data-ss-parallax="0.14" data-ss-parallax-max="54"><span>{t("EVENT / SPONSORSHIP")}</span><strong>{t("Community team season")}</strong><p>{t("Named tier · Benefits · Available slots")}</p></article>
        </div>
      </section>

      <section className="ss-creator-types">
        {[
          [t("Social"), t("Instagram, TikTok, YouTube, and the formats your audience expects.")],
          [t("Newsletters"), t("A useful local recommendation delivered to a known reader base.")],
          [t("Placements"), t("Windows, walls, vehicles, counters, rooms, and boards people already pass.")],
          [t("Teams"), t("Season, event, jersey, banner, and community sponsorship opportunities.")],
          [t("Events"), t("Gatherings, markets, showcases, and recurring local occasions.")],
          [t("Podcasts"), t("Host-read mentions, sponsored segments, and trusted recommendations for local listeners.")],
        ].map(([title, copy], index) => <article key={title}><span>{String(index + 1).padStart(2, "0")}</span><h2>{title}</h2><p>{copy}</p></article>)}
      </section>

      <section className="ss-creator-offer">
        <div><p className="ss-kicker">{t("BUILD AN OFFER PEOPLE CAN UNDERSTAND")}</p><h2>{t("You know your audience.")}<br /><em>{t("You define the inventory.")}</em></h2></div>
        <ol>
          <li><span>01</span><div><strong>{t("Say where the attention lives.")}</strong><p>{t("Platform, newsletter, placement, team, event, or organization.")}</p></div></li>
          <li><span>02</span><div><strong>{t("Describe exactly what a business gets.")}</strong><p>{t("Frames, video length, placement, mention, tier, or sponsor benefit.")}</p></div></li>
          <li><span>03</span><div><strong>{t("Set the price and boundaries.")}</strong><p>{t("You can discuss, counter, accept, or decline every request.")}</p></div></li>
        </ol>
      </section>

      <section className="ss-live-preview">
        <header className="ss-section-heading is-horizontal" data-ss-parallax="0.04" data-ss-parallax-max="26">
          <div>
            <p className="ss-kicker">{t("CREATOR INVENTORY")}</p>
            <h2>
              {t("Creators and local owners")}
              <br />
              <em>{t("already listing.")}</em>
            </h2>
          </div>
          <Link href="/marketplace?intent=supply">
            {t("Explore creator listings")}{" "}
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
  const t = useT();
  return (
    <>
      <section className="ss-page-hero ss-pricing-hero" id="main-content">
        <p className="ss-kicker">{t("PRICING / PAY AS YOU GO")}</p>
        <h1 data-ss-parallax="0.05" data-ss-parallax-max="30">{t("Free to join.")}<br /><em>{t("Clear campaign fees.")}</em></h1>
        <p>
          {t("Create a profile, publish listings, browse the marketplace, send campaign requests, and message members without a subscription. SideSpace charges each side only when an accepted campaign is paid.")}
        </p>
        <button className="ss-button is-dark" onClick={onJoin}>{t("Create a free account")}{" "}<span aria-hidden="true" className="ss-icon-arrow">↗</span></button>
      </section>

      <section className="ss-current-pricing" aria-labelledby="current-pricing-title">
        <div className="ss-current-flag" data-ss-parallax="0.06" data-ss-parallax-max="28"><span>{t("CURRENT")}</span><b>{t("LIVE NOW")}</b></div>
        <div data-ss-parallax="0.11" data-ss-parallax-max="42"><p className="ss-kicker">{t("MARKETPLACE")}</p><h2 id="current-pricing-title">5% + 5%</h2><p className="ss-price"><strong>$0</strong><span>{t("/ month")}</span></p></div>
        <ul data-ss-parallax="0.08" data-ss-parallax-max="34"><li>{t("Businesses pay the agreed campaign price plus 5%")}</li><li>{t("Creators receive the agreed price minus 5%")}</li><li>{t("Applicable tax is calculated at Stripe Checkout")}</li><li>{t("Stripe hosts checkout, invoices, and payout onboarding")}</li><li>{t("No subscription or minimum campaign spend")}</li></ul>
        <button onClick={onJoin}>
          {t("Create a free account")}{" "}
          <span aria-hidden="true" className="ss-icon-arrow">
            ↗
          </span>
        </button>
      </section>

      <section className="ss-future-pricing" aria-labelledby="future-pricing-title">
        <header><div><p className="ss-kicker">{t("EXAMPLE / EXACT MATH")}</p><h2 id="future-pricing-title">{t("A $100 campaign, end to end.")}</h2></div><p>{t("Fees are rounded to the nearest cent and shown before the business opens Stripe Checkout.")}</p></header>
        <div>
          <article><span>{t("BUSINESS")}</span><h3>{t("Pays $105 before tax")}</h3><p>{t("The $100 campaign subtotal plus a $5 SideSpace buyer fee.")}</p><ul><li>{t("$100 agreed campaign")}</li><li>{t("$5 buyer fee")}</li><li>{t("Tax added when applicable")}</li></ul></article>
          <article><span>{t("CREATOR")}</span><h3>{t("Earns $95")}</h3><p>{t("The $100 campaign subtotal minus a $5 SideSpace creator fee.")}</p><ul><li>{t("$100 gross campaign")}</li><li>{t("$5 creator fee")}</li><li>{t("$95 creator payout before Stripe payout adjustments")}</li></ul></article>
        </div>
      </section>

      <section className="ss-pricing-truth">
        <h2>{t("Hosted checkout. No hidden subscription.")}</h2>
        <p>{t("The business sees the campaign, buyer fee, and tax before paying. A verified Stripe webhook—not the browser redirect—confirms the campaign.")}</p>
      </section>

      <section className="ss-page-cta">
        <p className="ss-kicker">{t("FREE TO JOIN")}</p>
        <h2>{t("Start with the marketplace, then pay only for accepted work.")}</h2>
        <div>
          <Link className="ss-button is-light" href="/marketplace">
            {t("Browse first")}{" "}
            <span aria-hidden="true" className="ss-icon-arrow">
              ↗
            </span>
          </Link>
          <button className="ss-button is-dark" onClick={onJoin}>
            {t("Join SideSpace")}{" "}
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
  const t = useT();
  return (
    <section className="ss-dashboard-gate" id="main-content">
      <p className="ss-kicker">{t("YOUR SIDESPACE")}</p>
      <h1>{t("Listings, requests, and")}<br /><em>{t("conversations in one place.")}</em></h1>
      <p>
        {t("Sign in to manage your profile, publish inventory, reply to campaign requests, and continue private messages.")}
      </p>
      <div><button className="ss-button is-dark" onClick={onSignIn}>{t("Sign in")}{" "}<span aria-hidden="true" className="ss-icon-arrow">↗</span></button><button className="ss-button is-light" onClick={onJoin}>{t("Join SideSpace")}{" "}<span aria-hidden="true" className="ss-icon-plus">＋</span></button></div>
    </section>
  );
}
