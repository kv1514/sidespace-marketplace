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
    label: "Storefront",
    short: "WINDOW / 01",
    detail: "A real window on a real street",
    match: /storefront|window|wall|mural|room|interior|board|counter|main street|farm stand|cafe|bakery/i,
  },
  {
    label: "Creator",
    short: "AUDIENCE / 02",
    detail: "A trusted voice people already follow",
    match: /instagram|tiktok|youtube|newsletter|podcast|twitch|website/i,
  },
  {
    label: "Vehicle",
    short: "ROUTE / 03",
    detail: "A moving placement with a local routine",
    match: /vehicle/i,
  },
  {
    label: "Event",
    short: "CROWD / 04",
    detail: "A team, gathering, or local occasion",
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
  ["Instagram Story", "Instagram", "01"],
  ["TikTok", "TikTok", "02"],
  ["Newsletter", "Newsletter", "03"],
  ["Storefront window", "Storefront", "04"],
  ["Cafe counter", "Storefront", "05"],
  ["Vehicle", "Vehicle", "06"],
  ["Community board", "Community board", "07"],
  ["Wall", "Wall / mural", "08"],
  ["Event sponsorship", "Sponsorship", "09"],
  ["Team sponsorship", "Sponsorship", "10"],
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

function CategoryReel() {
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
      aria-label="SideSpace inventory categories"
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
        alt={example.beforeAlt}
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
          alt={example.afterAlt}
          decoding="async"
          height={1024}
          loading={index === 0 ? "eager" : "lazy"}
          sizes="(max-width: 760px) calc(100vw - 68px), 42vw"
          src={example.after}
          unoptimized
          width={1536}
        />
      </div>
      <span className="ss-placement-state is-before">Before</span>
      <span className="ss-placement-state is-after">With SideSpace</span>
      <div className="ss-placement-divider" ref={dividerRef} aria-hidden="true">
        <i>↔</i>
      </div>
      <input
        aria-label={`Compare ${example.title} before and after SideSpace advertising`}
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
  return (
    <div className="ss-placement-gallery">
      {PLACEMENT_EXAMPLES.map((example, index) => (
        <article className="ss-placement-example" key={example.number}>
          <header>
            <span>{example.number} / {example.type}</span>
            <h3>{example.title}</h3>
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
  return (
    <article className="ss-listing-preview">
      <button
        className="ss-listing-preview-image"
        onClick={() => onOpen(listing.id)}
        aria-label={`View ${listing.title}`}
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
          {listing.owner.verified && <b aria-label="Verified">✓</b>}
          {listingCity(listing) && ` · ${listingCity(listing)}`}
          {listing.owner.is_demo && (
            <span className="ss-demo-label">Demo</span>
          )}
        </p>
        <button onClick={() => onOpen(listing.id)}>{listing.title}</button>
        <footer>
          <strong>{price(listing)}</strong>
          <span>/ {listing.price_unit}</span>
          <button onClick={() => onOpen(listing.id)} aria-label={`Open ${listing.title}`}>
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
        aria-label="Kinds of local attention"
      >
        {INVENTORY_TYPES.map((item, index) => (
          <button
            key={item.label}
            aria-pressed={active === index}
            onClick={() => setActive(index)}
          >
            <span>{item.short}</span>
            <b>{item.label}</b>
          </button>
        ))}
      </div>
      <div className="ss-inventory-scene">
      <div
        className="ss-attention-source"
        key={`source-${active}`}
        ref={sourceRef}
      >
        <span>{inventory.short}</span>
        <strong>{inventory.label}</strong>
        <p>{inventory.detail}</p>
        <i aria-hidden="true">LOCAL ATTENTION</i>
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
        <span>LIST</span>
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
            SIDESPACE / {listing ? "MARKETPLACE" : "MARKETPLACE EXAMPLE"} INVENTORY
          </span>
          {(!listing || !isListingRequestable(listing)) && (
            <b>● {listing ? "VIEW ONLY" : "EXAMPLE"}</b>
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
                <small>View-only until the owner confirms it is still available.</small>
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
              <span>{inventory.label}</span>
              <strong>Local attention, ready to book</strong>
              <p>Owner sets the details and the price</p>
              <b>Direct conversation</b>
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
}

function FinalCall({ onList }: { onList: () => void }) {
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
      <p className="ss-kicker">THE SPACE BETWEEN A BUSINESS AND ITS NEXT CUSTOMER</p>
      <h2 data-ss-parallax="0.045" data-ss-parallax-max="28">
        Attention is already
        <br className="ss-everywhere-break" />{" "}
        <span className="ss-everywhere-highlight">
          <span className="ss-everywhere-highlight__base">everywhere.</span>
          <span
            aria-hidden="true"
            className="ss-everywhere-highlight__reveal"
          >
            everywhere.
          </span>
        </span>
        <br />
        <em>SideSpace makes it bookable.</em>
      </h2>
      <div>
        <Link className="ss-button is-dark" href="/marketplace">
          Browse marketplace <span aria-hidden="true" className="ss-icon-arrow">↗</span>
        </Link>
        <button className="ss-button is-light" onClick={onList}>
          List what you have <span aria-hidden="true" className="ss-icon-plus">＋</span>
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
  const [audience, setAudience] = useState<"advertise" | "offer">("advertise");
  const [activeProcess, setActiveProcess] = useState(0);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }

    // Restore the original three-step rhythm: each preview gets one complete
    // 4.6 second widget cycle before the emphasis moves to the next card.
    const timer = window.setInterval(() => {
      setActiveProcess((current) => (current + 1) % 3);
    }, 4600);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <>
      <section className="ss-home-hero" id="main-content">
        <div
          className="ss-home-hero-copy"
          data-ss-parallax="0.045"
          data-ss-parallax-max="28"
        >
          <p className="ss-kicker">THE MARKETPLACE FOR LOCAL ATTENTION</p>
          <h1>
            Local attention,
            <br />
            <em>now bookable.</em>
          </h1>
          <p className="ss-hero-deck">
            Book creators offering social, physical, and sponsorship inventory—or
            list the way you can advertise.
          </p>
          <div className="ss-hero-actions">
            <Link className="ss-button is-dark" href="/marketplace">
              Browse the marketplace <span aria-hidden="true" className="ss-icon-arrow">↗</span>
            </Link>
            <button className="ss-button is-light" onClick={onList}>
              List what you have to advertise <span aria-hidden="true" className="ss-icon-plus">＋</span>
            </button>
          </div>
          <ul className="ss-proof-row" aria-label="SideSpace benefits">
            <li>Free to join</li>
            <li>Direct messaging</li>
            <li>Owners set the price</li>
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
          <p className="ss-kicker">TWO SIDES, ONE LOCAL MARKET</p>
          <h2>What brings you here?</h2>
          <p>
            SideSpace connects the people looking for attention with the people
            and places that already have it.
          </p>
        </header>
        <div className={`ss-audience-split is-${audience}`}>
          <div className="ss-audience-controls" role="tablist" aria-label="Choose your SideSpace path">
            <button
              role="tab"
              aria-selected={audience === "advertise"}
              onClick={() => setAudience("advertise")}
              onMouseEnter={() => hoverIsFine() && setAudience("advertise")}
            >
              <span>01 / ADVERTISERS</span>
              <strong>I want to advertise</strong>
              <p>
                Find creators and real-world places where your local audience
                already spends attention.
              </p>
            </button>
            <button
              role="tab"
              aria-selected={audience === "offer"}
              onClick={() => setAudience("offer")}
              onMouseEnter={() => hoverIsFine() && setAudience("offer")}
            >
              <span>02 / CREATORS &amp; LOCAL OWNERS</span>
              <strong>I have attention to offer</strong>
              <p>
                List the audience, placement, or sponsorship inventory you
                control, set your price, and talk directly with businesses.
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
              <span>{audience === "advertise" ? "SEARCH / REQUEST / AGREE" : "LIST / PRICE / TALK"}</span>
              <strong>
                {audience === "advertise"
                  ? "Choose the exact person or place—not a vague audience segment."
                  : "Turn what people already notice into inventory you control."}
              </strong>
              <ul>
                {(audience === "advertise"
                  ? ["Creators", "Storefronts", "Vehicles", "Events", "Newsletters"]
                  : ["Instagram", "Windows", "Walls", "Counters", "Teams", "Newsletters"]
                ).map((item) => <li key={item}>{item}</li>)}
              </ul>
              {audience === "advertise" ? (
                <Link href="/marketplace">
                  Find places to advertise{" "}
                  <span aria-hidden="true" className="ss-icon-arrow">
                    ↗
                  </span>
                </Link>
              ) : (
                <button onClick={onJoin}>
                  List my reach{" "}
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
            <p className="ss-kicker">WHAT CAN BE LISTED</p>
            <h2>More than ad space.<br /><em>Anything people notice.</em></h2>
          </div>
          <p>
            Digital audiences, everyday surfaces, and local moments all live in
            one marketplace.
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
            <p className="ss-kicker">A DIRECT PATH FROM INTEREST TO AGREEMENT</p>
            <h2>Find it. Talk directly.<br /><em>Make it happen.</em></h2>
          </div>
          <Link href="/how-it-works">
            See how SideSpace works{" "}
            <span aria-hidden="true" className="ss-icon-arrow">
              ↗
            </span>
          </Link>
        </header>
        <div className="ss-process-row">
          <article
            className={activeProcess === 0 ? "is-active" : undefined}
            onMouseEnter={() => hoverIsFine() && setActiveProcess(0)}
          >
            <span>01 / DISCOVER</span>
            <div className="ss-mini-search" aria-hidden="true">
              <b>⌕</b><span>Storefront near Fullerton</span><i>12</i>
            </div>
            <h3>Find the right attention.</h3>
            <p>Search a specific creator, audience, placement, or town.</p>
            <i className="ss-process-progress" aria-hidden="true" />
          </article>
          <article
            className={activeProcess === 1 ? "is-active" : undefined}
            onMouseEnter={() => hoverIsFine() && setActiveProcess(1)}
          >
            <span>02 / TALK DIRECTLY</span>
            <div className="ss-mini-chat" aria-hidden="true">
              <p>Could this run next Friday?</p><p>Yes—here are the dimensions.</p>
            </div>
            <h3>Message the person in control.</h3>
            <p>No broker between you and the owner, creator, or host.</p>
            <i className="ss-process-progress" aria-hidden="true" />
          </article>
          <article
            className={activeProcess === 2 ? "is-active" : undefined}
            onMouseEnter={() => hoverIsFine() && setActiveProcess(2)}
          >
            <span>03 / MAKE IT HAPPEN</span>
            <div className="ss-mini-deal" aria-hidden="true">
              <span>CAMPAIGN REQUEST</span><strong>$120 / 2 weeks</strong><b>AGREED ✓</b>
            </div>
            <h3>Agree on the real details.</h3>
            <p>Set price, timing, placement, and deliverables together.</p>
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
      eyebrow: "FIND",
      title: "Browse real offerings.",
      copy: "Search by place, format, audience, or local market and see exactly who controls each listing.",
    },
    {
      eyebrow: "COMPARE",
      title: "Build a focused shortlist.",
      copy: "Compare the rate, timing, reach, and format before choosing who you want to work with.",
    },
    {
      eyebrow: "REQUEST",
      title: "Send a clear offer.",
      copy: "Share the campaign goal, dates, deliverables, and working budget with the creator.",
    },
    {
      eyebrow: "DISCUSS",
      title: "Work out the details.",
      copy: "Message directly, answer questions, and respond when the creator counters your offer.",
    },
    {
      eyebrow: "AGREE",
      title: "Confirm the right fit.",
      copy: "Accept the final price and plan together so everyone knows what happens next.",
    },
  ],
  owner: [
    {
      eyebrow: "CREATE",
      title: "Post what you can offer.",
      copy: "Turn an audience, window, wall, route, team, or event into a specific bookable listing.",
    },
    {
      eyebrow: "SET TERMS",
      title: "Name your price and boundaries.",
      copy: "Choose the rate, availability, lead time, deliverables, and practical limits you control.",
    },
    {
      eyebrow: "REVIEW",
      title: "Compare incoming offers.",
      copy: "See each business's budget, dates, campaign idea, and requested deliverables side by side.",
    },
    {
      eyebrow: "RESPOND",
      title: "Counter or clarify.",
      copy: "Ask questions, suggest a different price, or decline anything that is not right for you.",
    },
    {
      eyebrow: "CHOOSE",
      title: "Accept the offer that fits.",
      copy: "You make the final call. Agree only when the business, timing, and campaign feel right.",
    },
  ],
};

const JOURNEY_OPTIONS: ReadonlyArray<{ side: JourneySide; label: string }> = [
  { side: "advertiser", label: "I want to advertise" },
  { side: "owner", label: "I have attention to offer" },
];

const JOURNEY_DEMO_IMAGES = [
  "/photos/corner-store.jpg",
  "/photos/market-creator.jpg",
] as const;

const JOURNEY_CURSOR_LABELS: Record<JourneySide, readonly string[]> = {
  advertiser: ["OPEN", "COMPARE", "SEND", "ACCEPT", "NEXT"],
  owner: ["CONTINUE", "PUBLISH", "REVIEW", "COUNTER", "ACCEPT"],
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
          <div className="ss-scene-search"><span>⌕</span><strong><i>Creator or storefront near Fullerton</i></strong><kbd>↵</kbd></div>
          <div className="ss-scene-results">
            <button aria-pressed={selectedItem === 0} className={selectedItem === 0 ? "is-selected" : undefined} onClick={() => setSelectedItem(0)} type="button"><img src="/photos/corner-store.jpg" alt="" /><span><small>STOREFRONT · 0.8 MI</small><strong>Front window placement</strong><em>$240 / 2 weeks</em></span><b>01</b></button>
            <button aria-pressed={selectedItem === 1} className={selectedItem === 1 ? "is-selected" : undefined} data-cursor-target onClick={() => setSelectedItem(1)} type="button"><img src="/photos/market-creator.jpg" alt="" /><span><small>LOCAL CREATOR · 1.4 MI</small><strong>Story + saved highlight</strong><em>$180 / campaign</em></span><b>02</b></button>
          </div>
          <p className="ss-demo-hint">Choose either result to preview the selection.</p>
        </div>
      );
    }

    if (step === 1) {
      const shortlist = [
        ["Storefront window", "$240", "5 days"],
        ["Creator story", "$180", "3 days"],
        ["Cafe counter cards", "$95", "2 days"],
      ];

      return withCursor(
        <div className="ss-demo-scene is-comparing">
          <div className="ss-scene-title"><small>YOUR SHORTLIST</small><strong>Three ways to reach the neighborhood</strong><span>3 saved</span></div>
          <div className="ss-compare-head"><span>OFFERING</span><span>RATE</span><span>LEAD TIME</span></div>
          {shortlist.map(([name, rate, lead], index) => <button aria-pressed={selectedItem === index} className={selectedItem === index ? "ss-compare-row is-best" : "ss-compare-row"} data-cursor-target={index === 1 ? true : undefined} key={name} onClick={() => setSelectedItem(index)} type="button"><span><i>{index + 1}</i>{name}</span><strong>{rate}</strong><span>{lead}</span></button>)}
          <div className="ss-scene-note"><i>✓</i><span><strong>Selected for the brief</strong>{shortlist[selectedItem][0]} · {shortlist[selectedItem][2]} lead time</span></div>
        </div>
      );
    }

    if (step === 2) {
      return withCursor(
        <div className="ss-demo-scene is-requesting">
          <div className="ss-scene-title"><small>CAMPAIGN REQUEST</small><strong>Neighborhood launch weekend</strong><span>DRAFT</span></div>
          <div className="ss-request-grid">
            <label><span>RUN DATES</span><strong>SEP 12 — SEP 14</strong></label>
            <label><span>WORKING BUDGET</span><strong>$600</strong></label>
          </div>
          <div className="ss-request-brief"><span>WHAT SHOULD RUN?</span><p>One story showing the opening, saved to a local guide highlight for two weeks.</p></div>
          <div className="ss-scene-action"><span>{actionComplete ? "Offer delivered to Maya" : "3 deliverables attached"}</span><button className={actionComplete ? "is-complete" : undefined} data-cursor-target onClick={() => setActionComplete((current) => !current)} type="button">{actionComplete ? "OFFER SENT ✓" : "SEND OFFER ↗"}</button></div>
        </div>
      );
    }

    if (step === 3) {
      return withCursor(
        <div className="ss-demo-scene is-talking">
          <div className="ss-thread-person"><span>MC</span><div><strong>Maya Chen</strong><small>LOCAL CREATOR · ACTIVE NOW</small></div><b>•••</b></div>
          <div className="ss-scene-thread">
            <p>Could the story stay in your local guide highlight for two weeks?</p>
            <p>Yes. I can include that for $640 total.</p>
          </div>
          {actionComplete ? (
            <div className="ss-payout-screen"><span>PAYMENT SECURED</span><strong>$640</strong><p>Creator payout is scheduled after the campaign is completed.</p><div><small>RECIPIENT</small><b>Maya Chen</b><small>STATUS</small><b>READY</b></div></div>
          ) : (
            <div className="ss-counter-card"><span>COUNTER OFFER</span><strong>$640</strong><small>Story + 2-week saved highlight</small><div><button data-cursor-target onClick={() => setActionComplete(true)} type="button">ACCEPT</button><button onClick={() => setActionComplete(false)} type="button">REPLY</button></div></div>
          )}
        </div>
      );
    }

    return withCursor(
      <div className="ss-demo-scene is-agreed">
        <div className="ss-agreed-mark">✓</div>
        <small>CAMPAIGN AGREED</small>
        <h3>Neighborhood launch weekend</h3>
        <p>Maya Chen × Little Sun Coffee</p>
        <div className="ss-agreed-details"><span><small>DATES</small><strong>SEP 12 — 14</strong></span><span><small>AGREED TOTAL</small><strong>$640</strong></span></div>
        <button className={`ss-agreed-next${actionComplete ? " is-open" : ""}`} data-cursor-target={actionComplete ? undefined : true} onClick={() => setActionComplete(true)} type="button"><i>{actionComplete ? "✓" : "01"}</i><span><strong>{actionComplete ? "Asset thread ready" : "Next up"}</strong>{actionComplete ? "Brief, files, and final details are now in one place." : "Share final assets in the campaign thread."}</span></button>
      </div>
    );
  }

  if (step === 0) {
    return withCursor(
      <div className="ss-demo-scene is-listing">
        <div className="ss-listing-photo"><img src="/photos/market-creator.jpg" alt="" /><span>＋ ADD PHOTOS</span></div>
        <div className="ss-listing-form"><small>{actionComplete ? "DRAFT SAVED" : "NEW OFFERING"}</small><h3>Local story + saved highlight</h3><div><button aria-pressed={selectedItem === 0} className={selectedItem === 0 ? "is-active" : undefined} onClick={() => setSelectedItem(0)} type="button">CREATOR</button><button aria-pressed={selectedItem === 1} className={selectedItem === 1 ? "is-active" : undefined} onClick={() => setSelectedItem(1)} type="button">PHYSICAL</button><button aria-pressed={selectedItem === 2} className={selectedItem === 2 ? "is-active" : undefined} onClick={() => setSelectedItem(2)} type="button">SPONSORSHIP</button></div><p>Reach neighbors who follow local food, shops, and weekend plans.</p><button className={actionComplete ? "is-complete" : undefined} data-cursor-target onClick={() => setActionComplete((current) => !current)} type="button">{actionComplete ? "DRAFT SAVED ✓" : "CONTINUE ↗"}</button></div>
      </div>
    );
  }

  if (step === 1) {
    return withCursor(
      <div className="ss-demo-scene is-terms">
        <div className="ss-scene-title"><small>PRICE &amp; AVAILABILITY</small><strong>You decide the terms</strong><span>STEP 2 / 3</span></div>
        <div className="ss-terms-rate"><span>YOUR RATE</span><strong><i>$</i>180</strong><small>PER CAMPAIGN</small></div>
        <div className="ss-terms-grid"><label><span>LEAD TIME</span><strong>3 days</strong></label><label><span>AVAILABLE</span><strong>Thu — Sun</strong></label></div>
        <button aria-pressed={termsEnabled[0]} className="ss-terms-rule" onClick={() => setTermsEnabled((current) => [!current[0], current[1]])} type="button"><span>Saved highlight included</span><i>{termsEnabled[0] ? "YES" : "NO"}</i></button>
        <button aria-pressed={termsEnabled[1]} className="ss-terms-rule" onClick={() => setTermsEnabled((current) => [current[0], !current[1]])} type="button"><span>Product approval required</span><i>{termsEnabled[1] ? "YES" : "NO"}</i></button>
        <div className="ss-scene-action"><span>{actionComplete ? "Your offering is now visible" : "You can change these anytime"}</span><button className={actionComplete ? "is-complete" : undefined} data-cursor-target onClick={() => setActionComplete((current) => !current)} type="button">{actionComplete ? "PUBLISHED ✓" : "PUBLISH OFFERING ↗"}</button></div>
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
        <div className="ss-scene-title"><small>3 INCOMING OFFERS</small><strong>Choose what fits your audience</strong><span>{offers[selectedItem][1]} SELECTED</span></div>
        {offers.map(([name, rate, dates], index) => <button aria-pressed={selectedItem === index} className={selectedItem === index ? "is-best" : undefined} data-cursor-target={index === 1 ? true : undefined} key={name} onClick={() => setSelectedItem(index)} type="button"><span>{name.slice(0, 2).toUpperCase()}</span><span><strong>{name}</strong><small>{dates}</small></span><b>{rate}</b><i>{selectedItem === index ? "SELECTED" : "VIEW"}</i></button>)}
      </div>
    );
  }

  if (step === 3) {
    return withCursor(
      <div className="ss-demo-scene is-talking">
        <div className="ss-thread-person"><span>LS</span><div><strong>Little Sun Coffee</strong><small>BUSINESS · CAMPAIGN REQUEST</small></div><b>•••</b></div>
        <div className="ss-scene-thread"><p>Could we include a saved highlight for two weeks?</p><p>Yes—that would bring the total to $640.</p></div>
        <div className={`ss-counter-compose${actionComplete ? " is-complete" : ""}`}><span>{actionComplete ? "COUNTER SENT" : "YOUR COUNTER"}</span><strong>{actionComplete ? "✓" : "$640"}</strong><p>Includes story + two-week saved highlight.</p><button data-cursor-target onClick={() => setActionComplete((current) => !current)} type="button">{actionComplete ? "SENT ✓" : "SEND COUNTER ↗"}</button></div>
      </div>
    );
  }

  return withCursor(
    actionComplete ? (
      <div className="ss-demo-scene is-payout">
        <div className="ss-payout-mark">✓</div>
        <small>PAYOUT DETAILS</small>
        <h3>$640</h3>
        <p>Scheduled after the campaign is completed.</p>
        <div className="ss-payout-breakdown"><span><small>FROM</small><strong>Little Sun Coffee</strong></span><span><small>CAMPAIGN</small><strong>SEP 12 — 14</strong></span><span><small>STATUS</small><strong>READY</strong></span></div>
      </div>
    ) : (
      <div className="ss-demo-scene is-accepting">
        <small>FINAL OFFER</small>
        <h3>Neighborhood launch weekend</h3>
        <p>Little Sun Coffee wants a story and two-week saved highlight.</p>
        <div className="ss-final-offer"><span><small>DATES</small><strong>SEP 12 — 14</strong></span><span><small>YOU RECEIVE</small><strong>$640</strong></span></div>
        <button data-cursor-target onClick={() => setActionComplete(true)} type="button">ACCEPT OFFER ↗</button>
      </div>
    )
  );
}

export function HowItWorksPage({ onJoin }: { onJoin: () => void }) {
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
        <p className="ss-kicker">HOW SIDESPACE WORKS</p>
        <h1 data-ss-parallax="0.05" data-ss-parallax-max="30">One marketplace.<br /><em>Two clear paths.</em></h1>
        <p>
          Businesses find the attention they need. Creators, owners, and hosts
          decide what they offer. Both sides talk directly before anything runs.
        </p>
        <div className="ss-journey-switch" role="tablist" aria-label="Choose a SideSpace journey">
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
                <span className="ss-journey-switch-label">{option.label}</span>
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
                <span>{side === "advertiser" ? "FOR BUSINESSES" : "FOR CREATORS"}</span>
                <p>{reduceMotion ? "Choose a step to explore the journey." : "Follow the journey, or choose any step."}</p>
              </div>
              {steps.map((step, index) => (
                <button
                  aria-current={activeStep === index ? "step" : undefined}
                  className={activeStep === index ? "is-active" : undefined}
                  key={step.title}
                  onClick={() => selectStep(index)}
                  type="button"
                >
                  <span>{String(index + 1).padStart(2, "0")} / {step.eyebrow}</span>
                  <div><h2>{step.title}</h2><p>{step.copy}</p></div>
                  <i aria-hidden="true" className="ss-journey-step-progress" onAnimationEnd={advanceJourney} />
                </button>
              ))}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="ss-journey-demo">
          <div className="ss-demo-window">
            <header><i /><i /><i /><span>SIDESPACE / {side === "advertiser" ? "BUSINESS" : "CREATOR"}</span><b>{String(activeStep + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}</b></header>
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
            <footer><span>{steps[activeStep].eyebrow}</span><div aria-hidden="true">{steps.map((_, index) => <i className={index <= activeStep ? "is-filled" : undefined} key={index} />)}</div><b>{journeyPlaying ? "PLAYING" : reduceMotion ? "MANUAL" : "PAUSED"}</b></footer>
          </div>
        </div>
      </section>

      <section className="ss-principles-band">
        <article><span>CONTROL</span><h3>The owner decides.</h3><p>Every request can be discussed, countered, accepted, or declined.</p></article>
        <article><span>CONTEXT</span><h3>The listing is specific.</h3><p>A real audience, surface, route, place, or event—not an abstract ad unit.</p></article>
        <article><span>CONVERSATION</span><h3>The parties talk directly.</h3><p>Price, timing, fit, and campaign details stay in one private thread.</p></article>
      </section>

      <section className="ss-page-cta">
        <p className="ss-kicker">START WITH THE SIDE THAT FITS YOU</p>
        <h2>Ready to see what is already here?</h2>
        <div>
          <Link className="ss-button is-dark" href="/marketplace">
            Browse marketplace{" "}
            <span aria-hidden="true" className="ss-icon-arrow">
              ↗
            </span>
          </Link>
          <button className="ss-button is-light" onClick={onJoin}>
            Create a free profile{" "}
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
          <p className="ss-kicker">CREATORS &amp; LOCAL INVENTORY</p>
          <h1>Your local reach<br /><em>can work for you.</em></h1>
          <p>
            List the way you can advertise—on social, in a newsletter, on a
            storefront, around a team, or at a local event. You choose the offer,
            the price, and every campaign.
          </p>
          <button className="ss-button is-dark" onClick={onList}>List my reach <span aria-hidden="true" className="ss-icon-arrow">↗</span></button>
        </div>
        <div className="ss-creator-stack">
          <article className="is-social" data-ss-parallax="0.1" data-ss-parallax-max="44"><span>INSTAGRAM / LOCAL</span><img src="/photos/market-creator.jpg" alt="Local creator at an outdoor market" /><strong>Story + saved highlight</strong><p>Audience, format, rate</p></article>
          <article className="is-newsletter" data-ss-parallax="0.18" data-ss-parallax-max="62"><span>NEWSLETTER / WEEKLY</span><strong>The Friday local list</strong><p>2.4K readers · One featured mention</p><b>OWNER SETS THE PRICE</b></article>
          <article className="is-event" data-ss-parallax="0.14" data-ss-parallax-max="54"><span>EVENT / SPONSORSHIP</span><strong>Community team season</strong><p>Named tier · Benefits · Available slots</p></article>
        </div>
      </section>

      <section className="ss-creator-types">
        {[
          ["Social", "Instagram, TikTok, YouTube, and the formats your audience expects."],
          ["Newsletters", "A useful local recommendation delivered to a known reader base."],
          ["Placements", "Windows, walls, vehicles, counters, rooms, and boards people already pass."],
          ["Teams", "Season, event, jersey, banner, and community sponsorship opportunities."],
          ["Events", "Gatherings, markets, showcases, and recurring local occasions."],
          ["Organizations", "Clubs, causes, and community groups with meaningful local reach."],
          ["Podcasts", "Host-read mentions, sponsored segments, and trusted recommendations for local listeners."],
        ].map(([title, copy], index) => <article key={title}><span>{String(index + 1).padStart(2, "0")}</span><h2>{title}</h2><p>{copy}</p></article>)}
      </section>

      <section className="ss-creator-offer">
        <div><p className="ss-kicker">BUILD AN OFFER PEOPLE CAN UNDERSTAND</p><h2>You know your audience.<br /><em>You define the inventory.</em></h2></div>
        <ol>
          <li><span>01</span><div><strong>Say where the attention lives.</strong><p>Platform, newsletter, placement, team, event, or organization.</p></div></li>
          <li><span>02</span><div><strong>Describe exactly what a business gets.</strong><p>Frames, video length, placement, mention, tier, or sponsor benefit.</p></div></li>
          <li><span>03</span><div><strong>Set the price and boundaries.</strong><p>You can discuss, counter, accept, or decline every request.</p></div></li>
        </ol>
      </section>

      <section className="ss-live-preview">
        <header className="ss-section-heading is-horizontal" data-ss-parallax="0.04" data-ss-parallax-max="26">
          <div>
            <p className="ss-kicker">CREATOR INVENTORY</p>
            <h2>
              Creators and local owners
              <br />
              <em>already listing.</em>
            </h2>
          </div>
          <Link href="/marketplace?intent=supply">
            Explore creator listings{" "}
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
  return (
    <>
      <section className="ss-page-hero ss-pricing-hero" id="main-content">
        <p className="ss-kicker">PRICING / PAY AS YOU GO</p>
        <h1 data-ss-parallax="0.05" data-ss-parallax-max="30">Free to join.<br /><em>Clear campaign fees.</em></h1>
        <p>
          Create a profile, publish listings, browse the marketplace, send
          campaign requests, and message members without a subscription.
          SideSpace charges each side only when an accepted campaign is paid.
        </p>
        <button className="ss-button is-dark" onClick={onJoin}>Create a free account <span aria-hidden="true" className="ss-icon-arrow">↗</span></button>
      </section>

      <section className="ss-current-pricing" aria-labelledby="current-pricing-title">
        <div className="ss-current-flag" data-ss-parallax="0.06" data-ss-parallax-max="28"><span>CURRENT</span><b>LIVE NOW</b></div>
        <div data-ss-parallax="0.11" data-ss-parallax-max="42"><p className="ss-kicker">MARKETPLACE</p><h2 id="current-pricing-title">5% + 5%</h2><p className="ss-price"><strong>$0</strong><span>/ month</span></p></div>
        <ul data-ss-parallax="0.08" data-ss-parallax-max="34"><li>Businesses pay the agreed campaign price plus 5%</li><li>Creators receive the agreed price minus 5%</li><li>Applicable tax is calculated at Stripe Checkout</li><li>Stripe hosts checkout, invoices, and payout onboarding</li><li>No subscription or minimum campaign spend</li></ul>
        <button onClick={onJoin}>
          Create a free account{" "}
          <span aria-hidden="true" className="ss-icon-arrow">
            ↗
          </span>
        </button>
      </section>

      <section className="ss-future-pricing" aria-labelledby="future-pricing-title">
        <header><div><p className="ss-kicker">EXAMPLE / EXACT MATH</p><h2 id="future-pricing-title">A $100 campaign, end to end.</h2></div><p>Fees are rounded to the nearest cent and shown before the business opens Stripe Checkout.</p></header>
        <div>
          <article><span>BUSINESS</span><h3>Pays $105 before tax</h3><p>The $100 campaign subtotal plus a $5 SideSpace buyer fee.</p><ul><li>$100 agreed campaign</li><li>$5 buyer fee</li><li>Tax added when applicable</li></ul></article>
          <article><span>CREATOR</span><h3>Earns $95</h3><p>The $100 campaign subtotal minus a $5 SideSpace creator fee.</p><ul><li>$100 gross campaign</li><li>$5 creator fee</li><li>$95 creator payout before Stripe payout adjustments</li></ul></article>
        </div>
      </section>

      <section className="ss-pricing-truth">
        <h2>Hosted checkout. No hidden subscription.</h2>
        <p>The business sees the campaign, buyer fee, and tax before paying. A verified Stripe webhook—not the browser redirect—confirms the campaign.</p>
      </section>

      <section className="ss-page-cta">
        <p className="ss-kicker">FREE TO JOIN</p>
        <h2>Start with the marketplace, then pay only for accepted work.</h2>
        <div>
          <Link className="ss-button is-light" href="/marketplace">
            Browse first{" "}
            <span aria-hidden="true" className="ss-icon-arrow">
              ↗
            </span>
          </Link>
          <button className="ss-button is-dark" onClick={onJoin}>
            Join SideSpace{" "}
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
  return (
    <section className="ss-dashboard-gate" id="main-content">
      <p className="ss-kicker">YOUR SIDESPACE</p>
      <h1>Listings, requests, and<br /><em>conversations in one place.</em></h1>
      <p>
        Sign in to manage your profile, publish inventory, reply to campaign
        requests, and continue private messages.
      </p>
      <div><button className="ss-button is-dark" onClick={onSignIn}>Sign in <span aria-hidden="true" className="ss-icon-arrow">↗</span></button><button className="ss-button is-light" onClick={onJoin}>Join SideSpace <span aria-hidden="true" className="ss-icon-plus">＋</span></button></div>
    </section>
  );
}
