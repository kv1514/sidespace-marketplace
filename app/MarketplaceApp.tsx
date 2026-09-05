"use client";

import dynamic from "next/dynamic";
import { AccountBalance } from "@/components/AccountBalance";
import {
  type Dispatch,
  FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { toastTone, type ToastTone } from "@/lib/toast-tone";
import {
  loadProfileContacts,
  saveProfileContacts,
  splitProfileWrite,
  withProfileContacts,
} from "@/lib/profile-contacts";
import {
  PUBLIC_LISTING_COLUMNS,
  PUBLIC_PROFILE_COLUMNS,
} from "@/lib/supabase/public";
import type { Invite } from "@/lib/supabase/public";
import {
  localListingSeeds,
  localProfiles,
} from "@/app/localMarketplaceData";
import {
  calculatePaymentBreakdown,
  centsToInputDollars,
  dollarsToCents,
  formatCents,
} from "@/lib/payments/fees";
import {
  BUSINESS_SIGNUP_CREDIT_CENTS,
  applyAdCreditToCheckout,
  isBusinessReferralCode,
  normalizeBusinessReferralCode,
} from "@/lib/payments/ad-credits";
import {
  isListingRequestable,
  type ListingProvenanceStatus,
} from "@/lib/listings/provenance";
import {
  LISTING_LIKE_COUNT_COLUMNS,
  mergeListingLikeCounts,
} from "@/lib/listings/likes";
import {
  comparePopularListings,
  normalizeLikeCount,
} from "@/lib/listings/popularity";
import {
  recommendListings,
  type CooccurrenceIndex,
} from "@/lib/listings/recommend";
import {
  affinityEvents,
  trackClick,
  trackLike,
  trackOffer,
  watchListingImpressions,
} from "@/lib/listings/track";
import type { ListingDraft } from "@/lib/listings/draft";
import {
  DashboardGate,
  LandingPage,
} from "@/app/components/PublicPages";
import { useLocale } from "@/app/components/LocaleProvider";
import {
  formatCurrency as formatLocalizedCurrency,
  localeTag,
  localizeListingChannel,
  localizeListingUnit,
  localizeRole,
  type Locale,
  type TranslationKey,
  DEFAULT_LOCALE,
  translateEnglish,
  type Translate,
} from "@/lib/i18n";
import {
  compareLocations,
  locationMatchScore,
} from "@/lib/listings/location";
import {
  SiteFooter,
  SiteHeader,
  type SideSpaceRoute,
} from "@/app/components/SiteChrome";
import CityAutocomplete from "@/app/components/CityAutocomplete";
import { ListingAvailabilityFields } from "@/components/AvailabilityCalendar";
import { ListingComposerFields, revealInvalidField } from "@/components/ListingComposerFields";
import { BookingFields } from "@/components/BookingFields";
import { bookingDateLabel, pricingLabel } from "@/lib/listings/booking";
import { InstantBookingPanel } from "@/components/InstantBookingPanel";
import { addCalendarDays, calendarToday, availableStartDates, type BookingSchedule } from "@/lib/listings/availability";
import { isUnitedStatesPlaceLabel } from "@/lib/geo/places";

const stripeConfigured = /^pk_(?:test|live)_/.test(
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "",
);

// `consumer` is retired from the product but stays in the union, in roleCopy and
// in the DB CHECK. Legacy rows still carry it, roleLabel() dereferences
// roleCopy[role] unguarded, and dropping a value from a CHECK re-validates the
// whole table to buy nothing. It is excluded from the picker by PICKABLE_ROLES,
// never by removing it from here.
type Role =
  | "consumer"
  | "business"
  | "creator"
  | "space_owner"
  | "sponsor_host";
type RoleFilter = "all" | "supply" | "business" | "creator";
type ListingSort = "latest" | "popular" | "location";
type CreatorOfferType = "social" | "physical" | "sponsorship";
type LocationPoint = {
  latitude: number;
  longitude: number;
};

type Profile = {
  id: string;
  auth_user_id: string | null;
  role: Role;
  extra_roles?: Role[];
  /** Which Creator inventory path to reopen by default. Businesses keep null. */
  creator_offer?: CreatorOfferType | null;
  /** Every Creator inventory path this profile can publish. */
  creator_offers?: CreatorOfferType[];
  /** Business brief preferences used to rank creator recommendations. */
  business_preferences?: BusinessPreferences | null;
  display_name: string;
  handle: string | null;
  bio: string;
  city: string;
  /** Optional city-level pin captured with the member's permission. */
  location_latitude?: number | string | null;
  location_longitude?: number | string | null;
  categories: string[];
  followers: number;
  avg_views: number;
  /** The human behind a business account, when display_name is the business. */
  contact_name?: string;
  /** Reply-to address. Replaces the @handle question for most roles. */
  contact_email?: string;
  /**
   * What avg_views is counting. The person card used to hardcode "weekly
   * looks", so a barbershop's daily footfall and a robotics team's season
   * crowd both published as weekly views of something. Defaults to
   * "weekly looks" in the DB, so every pre-existing row renders unchanged.
   */
  reach_unit?: string;
  audience_age: string;
  website: string;
  avatar_url: string;
  social_links?: Record<string, string>;
  social_verification?: Record<string, string>;
  gallery_urls?: string[];
  verified: boolean;
  verification_status?: "unverified" | "pending" | "verified" | "rejected";
  is_demo: boolean;
  /** Test/QA login. Real row, but never presented to visitors as a member. */
  is_internal?: boolean;
  onboarding_complete: boolean;
};

// What the ig-avatar edge function reports back for a handle.
type IgStats = {
  url?: string;
  username?: string;
  full_name?: string;
  followers?: number | null;
  posts?: number | null;
  is_private?: boolean;
  is_verified?: boolean;
  photo_skipped?: string;
  throttled?: boolean;
  error?: string;
};

/** How a listing's walkthrough shows: a flat video, or one of the two 360 kinds the panorama viewer takes. */
type TourKind = "video" | "video360" | "photo360";

/**
 * One row of public.my_listing_analytics: the four numbers an owner is allowed
 * to see about their own listing, and never anything about who produced them.
 */
type ListingAnalytics = {
  listing_id: string;
  title: string | null;
  status: string | null;
  impressions: number;
  clicks: number;
  impressions_7d: number;
  clicks_7d: number;
  like_count: number;
  offers: number;
};

type Listing = BookingSchedule & {
  id: string;
  owner_profile_id: string;
  title: string;
  channel: string;
  format: string;
  price_cents: number;
  price_unit: string;
  description: string;
  demographics: string;
  image_url: string;
  image_urls?: string[];
  location_area?: string;
  /** Upper end of a budget range; `price_cents` stays the lower end. */
  price_max_cents?: number | null;
  /** Physical space only: what can go up, who installs it, and how big it is. */
  surface_types?: string[];
  install_by?: string | null;
  space_size?: string;
  /** Sponsorship only: which level this row is, and how many sponsors fit. */
  sponsor_tier?: string | null;
  sponsor_slots?: number | null;
  /** Business brief: 'physical' | 'virtual' | 'both'. */
  brief_scope?: string | null;
  /** Social platforms a brief wants to target. */
  target_platforms?: string[];
  /** Exact address of a physical space, so a booker can find it. */
  street_address?: string;
  /** Month of the Google Street View frame attached to the address ("March 2025"); empty when none. */
  street_view_captured?: string;
  /** Google's panorama id at the address, the one Street View value it lets us keep; opens the 360 view of the street. */
  street_view_pano?: string;
  /** The owner's walkthrough - a video, a 360 video, or a 360 photo - hosted by SideSpace. Empty when none. */
  tour_url?: string;
  tour_kind?: TourKind | "";
  availability_notes?: string;
  available_from?: string | null;
  available_to?: string | null;
  lead_time_days?: number;
  minimum_booking?: string;
  deliverables?: string;
  cancellation_policy?: string;
  status: "active" | "paused" | "booked";
  provenance_status?: ListingProvenanceStatus | null;
  availability_confirmed_at?: string | null;
  like_count?: number | string | null;
  created_at?: string;
  updated_at?: string;
  owner: Profile;
};

/* social_links is free-shape jsonb with no key validation, so adding a platform
 * here needs no migration. An empty `base` means "this is not a URL we can
 * construct" - a newsletter or a podcast is stored as whatever the member typed
 * (see normalizeSocialUrl). */
const socialPlatforms = [
  { key: "instagram", label: "Instagram", short: "IG", base: "https://instagram.com/" },
  { key: "tiktok", label: "TikTok", short: "TT", base: "https://tiktok.com/@" },
  { key: "youtube", label: "YouTube", short: "YT", base: "https://youtube.com/@" },
  { key: "facebook", label: "Facebook", short: "FB", base: "https://facebook.com/" },
  { key: "x", label: "X", short: "X", base: "https://x.com/" },
  { key: "twitch", label: "Twitch", short: "TW", base: "https://twitch.tv/" },
  { key: "newsletter", label: "Newsletter", short: "NL", base: "" },
  { key: "podcast", label: "Podcast", short: "PC", base: "" },
] as const;

type Conversation = {
  id: string;
  participant_a: string;
  participant_b: string;
  updated_at: string;
};

type CampaignRequestMode = "offer" | "buy_now";

type Message = {
  id: string;
  conversation_id: string;
  sender_profile_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
};

type CampaignRequest = {
  id: string;
  listing_id: string;
  requester_profile_id: string;
  owner_profile_id: string;
  conversation_id: string | null;
  purchase_mode: CampaignRequestMode;
  instant_booking?: boolean;
  campaign_name: string;
  goals: string;
  requested_deliverables: string;
  budget_cents: number;
  start_date: string;
  end_date: string;
  timing_kind?: BookingSchedule["timing_kind"];
  pricing_kind?: BookingSchedule["pricing_kind"];
  listing_terms?: { cancellation_policy?: string; booking_timezone?: string };
  notes: string;
  status:
    | "pending"
    | "accepted"
    | "confirmed"
    | "declined"
    | "countered"
    | "cancelled"
    | "completed"
    | "refunded"
    | "disputed";
  counter_budget_cents: number | null;
  accepted_subtotal_cents: number | null;
  payer_profile_id: string | null;
  payee_profile_id: string | null;
  counter_message: string;
  created_at: string;
  updated_at: string;
  // Null once the listing is paused or removed: RLS only exposes active
  // listings to the requester, so the embed comes back empty.
  listing: Pick<Listing, "id" | "title" | "channel" | "price_cents" | "price_unit"> | null;
  requester: Pick<Profile, "id" | "display_name" | "avatar_url" | "city">;
  owner: Pick<Profile, "id" | "display_name" | "avatar_url" | "city">;
};

type PaymentTransaction = {
  id: string;
  campaign_request_id: string;
  business_profile_id: string;
  creator_profile_id: string;
  campaign_name: string;
  listing_title: string;
  business_name: string;
  creator_name: string;
  currency: string;
  subtotal_cents: number;
  buyer_fee_cents: number;
  creator_fee_cents: number;
  customer_total_cents: number;
  ad_credit_cents?: number;
  charged_total_cents?: number;
  creator_payout_cents: number;
  payout_amount_cents: number;
  platform_gross_revenue_cents: number;
  tax_cents: number;
  refunded_cents: number;
  status: string;
  workflow_status: string;
  payout_status: string;
  delivered_at: string | null;
  review_deadline: string | null;
  confirmed_at: string | null;
  issue_reported_at: string | null;
  issue_status: string;
  escalated_at: string | null;
  payout_released_at: string | null;
  payout_issue: boolean;
  dispute_status: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
  issue:
    | {
        id: string;
        details: string;
        status: string;
        reported_at: string;
        resolution_attempted_at: string | null;
        escalated_at: string | null;
        resolved_at: string | null;
        resolution_action: string | null;
        resolution_notes: string;
      }
    | null;
  review: CreatorReview | null;
};

type StripeAccountStatus = {
  connected: boolean;
  ready: boolean;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
  requirementsDue?: string[];
};

type CreatorPortfolioItem = {
  id: string;
  creator_profile_id: string;
  title: string;
  description: string;
  kind: "video" | "project" | "campaign" | "case_study" | "other";
  media_url: string;
  project_url: string;
  sort_order: number;
  published: boolean;
  created_at: string;
};

type CreatorReview = {
  id: string;
  payment_transaction_id: string;
  payer_profile_id: string;
  creator_profile_id: string;
  rating: number;
  review_text: string;
  created_at: string;
};

type VerificationRequest = {
  id: string;
  profile_id: string;
  verification_type: "business" | "creator" | "space_owner" | "sponsor_host";
  evidence_url: string;
  social_platform: string;
  social_handle: string;
  message: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
};

type BusinessPreferences = {
  categories: string[];
  /** A campaign usually has more than one job to do, so this is a set. */
  goals: string[];
  briefScope: "" | "physical" | "virtual" | "both";
  placements: string[];
  targetPlatforms: string[];
  wantedArea: string;
  timing: string;
};

const roleCopy: Record<
  Role,
  { label: string; short: string; eyebrow: string; icon: string }
> = {
  // Retired. Kept only so roleLabel() and the person card do not crash on a
  // legacy row - it is not offered by the picker. See PICKABLE_ROLES.
  consumer: {
    label: "Campaign shopper",
    short: "Find and book local reach",
    eyebrow: "I’m looking to discover",
    icon: "↗",
  },
  business: {
    label: "Business",
    short: "Run a campaign with creators and local advertising inventory",
    eyebrow: "I want to advertise",
    icon: "◆",
  },
  creator: {
    label: "Creator",
    short: "I have a way to advertise.",
    eyebrow: "I have reach to offer",
    icon: "@",
  },
  space_owner: {
    label: "Physical space",
    short: "Rent out a window, wall, vehicle, counter, or room",
    eyebrow: "I own a space people walk past",
    icon: "⌂",
  },
  sponsor_host: {
    label: "Sponsorship host",
    short: "Offer sponsors a logo, a banner, or a named tier",
    eyebrow: "I run a team or event",
    icon: "★",
  },
};

/**
 * The roles a member may actually choose.
 *
 * Deliberately an explicit list rather than Object.keys(roleCopy): `consumer`
 * still has an entry there for legacy rows, and iterating the object would put
 * a retired role back in the picker.
 */
const PICKABLE_ROLES: Role[] = [
  "business",
  "creator",
];

/** Roles that can be held alongside a primary one, per profiles_extra_roles_valid. */
const EXTRA_ROLE_OPTIONS: Role[] = [
  "business",
  "creator",
];

const legacyDemoProfiles: Profile[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    auth_user_id: null,
    role: "creator",
    display_name: "Maya Alvarez",
    handle: "@mayaonfilm",
    bio: "Analog fashion, thrift finds, and honest city guides for a community that actually shows up.",
    city: "East LA, CA",
    categories: ["Instagram", "Fashion", "Local"],
    followers: 18400,
    avg_views: 8200,
    audience_age: "72% ages 18–29",
    website: "",
    avatar_url: "/photos/market-creator.jpg",
    verified: true,
    is_demo: true,
    onboarding_complete: true,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    auth_user_id: null,
    role: "creator",
    display_name: "Drew Kim",
    handle: "@drew.eats",
    bio: "No-frills food reviews and weekly neighborhood roundups. My audience follows for what to order tonight.",
    city: "Oakland, CA",
    categories: ["TikTok", "Food", "Local"],
    followers: 11700,
    avg_views: 12100,
    audience_age: "61% ages 21–34",
    website: "",
    avatar_url: "/photos/drew-kitchen.jpg",
    verified: true,
    is_demo: true,
    onboarding_complete: true,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    auth_user_id: null,
    role: "creator",
    creator_offer: "physical",
    display_name: "Jay Morrison",
    handle: "Silver ’84 Volvo",
    bio: "A restored wagon parked in a high-footfall arts district and driven through downtown every weekday.",
    city: "Portland, OR",
    categories: ["Vehicle", "Physical", "Local"],
    followers: 0,
    avg_views: 31000,
    audience_age: "Commuters + arts district",
    website: "",
    avatar_url: "/photos/jay-volvo.jpg",
    verified: true,
    is_demo: true,
    onboarding_complete: true,
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    auth_user_id: null,
    role: "creator",
    creator_offer: "physical",
    display_name: "Campus Corner",
    handle: "Student-run space network",
    bio: "Storefront windows and benches along the busiest off-campus routes.",
    city: "Tempe, AZ",
    categories: ["Campus", "Storefront", "Gen Z"],
    followers: 0,
    avg_views: 48000,
    audience_age: "83% ages 18–24",
    website: "",
    avatar_url: "/photos/cafe-patio.jpg",
    verified: true,
    is_demo: true,
    onboarding_complete: true,
  },
  {
    id: "55555555-5555-4555-8555-555555555555",
    auth_user_id: null,
    role: "business",
    display_name: "Sunroom Coffee",
    handle: "@sunroomcoffee",
    bio: "A neighborhood coffee bar opening its second location and looking for local launch partners.",
    city: "Los Angeles, CA",
    categories: ["Food", "Local", "Launch"],
    followers: 6200,
    avg_views: 4500,
    audience_age: "Coffee, design, local life",
    website: "sunroom.example",
    avatar_url: "/photos/sunroom-cafe.jpg",
    verified: true,
    is_demo: true,
    onboarding_complete: true,
  },
  {
    id: "66666666-6666-4666-8666-666666666666",
    auth_user_id: null,
    role: "business",
    display_name: "Good Bones Studio",
    handle: "@goodbonesprints",
    bio: "Independent art prints and frames made for renters, first homes, and rooms with personality.",
    city: "Atlanta, GA",
    categories: ["Home", "Design", "Product"],
    followers: 8700,
    avg_views: 5300,
    audience_age: "Renters and first homes",
    website: "goodbones.example",
    avatar_url: "/photos/corner-store.jpg",
    verified: false,
    is_demo: true,
    onboarding_complete: true,
  },
];

const legacyListingSeeds: Omit<Listing, "owner">[] = [
  {
    id: "a1111111-1111-4111-8111-111111111111",
    owner_profile_id: legacyDemoProfiles[0].id,
    title: "Story set + saved highlight",
    channel: "Instagram",
    format: "3 frames · 48 hr highlight",
    price_cents: 14_500,
    price_unit: "campaign",
    description:
      "A natural three-frame story with a clear call to action, kept in my Local Finds highlight.",
    demographics: "72% ages 18–29 · East LA",
    image_url: "/photos/market-creator.jpg",
    status: "active",
  },
  {
    id: "a2222222-2222-4222-8222-222222222222",
    owner_profile_id: legacyDemoProfiles[1].id,
    title: "An honest neighborhood food feature",
    channel: "TikTok",
    format: "30–45 sec · link in bio",
    price_cents: 22_000,
    price_unit: "video",
    description:
      "One fast, useful food feature filmed on location and posted when my local audience is most active.",
    demographics: "61% ages 21–34 · Oakland",
    image_url: "/photos/drew-kitchen.jpg",
    status: "active",
  },
  {
    id: "a3333333-3333-4333-8333-333333333333",
    owner_profile_id: legacyDemoProfiles[2].id,
    title: "Rear-window campaign",
    channel: "Vehicle",
    format: "18 × 24 in · weather-safe",
    price_cents: 8_500,
    price_unit: "week",
    description:
      "Rear-window placement on a vintage wagon that moves through Portland’s east-side neighborhoods.",
    demographics: "31K weekly looks · commuter route",
    image_url: "/photos/jay-volvo.jpg",
    status: "active",
  },
  {
    id: "a4444444-4444-4444-8444-444444444444",
    owner_profile_id: legacyDemoProfiles[3].id,
    title: "Two-location campus run",
    channel: "Storefront",
    format: "2 placements · weekly proof",
    price_cents: 16_000,
    price_unit: "week",
    description:
      "Two high-visibility placements near campus with timestamped setup and weekly proof photos.",
    demographics: "48K weekly looks · 83% ages 18–24",
    image_url: "/photos/cafe-patio.jpg",
    status: "active",
  },
  {
    id: "a5555555-5555-4555-8555-555555555555",
    owner_profile_id: legacyDemoProfiles[4].id,
    title: "Second-store launch partners",
    channel: "Business brief",
    format: "Stories · tasting · street placement",
    price_cents: 25_000,
    price_unit: "partner",
    description:
      "Paid launch brief for creators and spaces with a genuine connection to neighborhood coffee culture.",
    demographics: "Local coffee, design, and culture",
    image_url: "/photos/sunroom-cafe.jpg",
    status: "active",
  },
];

const demoProfiles = localProfiles.length
  ? (localProfiles as Profile[])
  : legacyDemoProfiles;
const listingSeeds = localListingSeeds.length
  ? (localListingSeeds as Omit<Listing, "owner">[])
  : legacyListingSeeds;

const demoListings: Listing[] = listingSeeds.map((listing) => ({
  ...listing,
  owner: demoProfiles.find(
    (profile) => profile.id === listing.owner_profile_id,
  )!,
}));

// Members type their handle with or without the @ (or paste a whole URL);
// display it one way regardless of what was stored.
function displayHandle(raw: string) {
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .replace(/^@+/, "")
    .replace(/\/+$/, "");
  if (!cleaned) return "";
  // Multi-word "handles" are really display names (the QA fixtures); an @
  // would just make them look broken.
  return /\s/.test(cleaned) ? cleaned : `@${cleaned}`;
}

// Cover photo used when a listing has none of its own, and the repair target
// when a listing's photo is deleted from the member's profile.
const DEFAULT_LISTING_IMAGE = "/photos/market-creator.jpg";
/** Photos a listing holds; the editor refuses more before anything uploads. */
const MAX_LISTING_PHOTOS = 6;
/**
 * Walkthrough uploads: what the marketplace-tours bucket accepts and its
 * ceiling, which is also the largest object the project's Supabase plan
 * takes. About a minute of phone video.
 */
const TOUR_MAX_BYTES = 50 * 1024 * 1024;
const TOUR_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime"];
const TOUR_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];
/** Stills cut from a walkthrough video for Fill with AI, and their long edge. */
const TOUR_FRAMES = 6;
const TOUR_FRAME_EDGE = 960;
/**
 * A browser key for Google's Maps Embed API, restricted to this site's
 * origin, so "View whole street" opens the 360 panorama in the page. Without
 * it the button opens the same panorama on Google Maps, which needs no key.
 */
const STREET_VIEW_EMBED_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY ?? "";

/**
 * The Google client the sign-in button identifies itself as.
 *
 * Public by nature - it travels in the URL of every OAuth round trip already -
 * so it is a NEXT_PUBLIC var rather than a secret. Set it and Google's account
 * chooser names sidespace.ad; leave it unset and sign-in keeps taking the
 * redirect through Supabase, which names Supabase.
 */
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

/** Google's script is fetched only on the screen that offers Google sign-in. */
const GoogleSignInButton = dynamic(
  () => import("./components/GoogleSignInButton"),
  { ssr: false },
);

/** three.js and the viewer arrive only on a listing that has a 360 walkthrough. */
function PanoramaLoading() {
  const { t } = useLocale();
  return (
    <div className="pano-viewer">
      <span className="pano-status" role="status">
        {t("app.loadingThe360View")}
      </span>
    </div>
  );
}

const PanoramaViewer = dynamic(() => import("./components/PanoramaViewer"), {
  ssr: false,
  loading: PanoramaLoading,
});

/** Google Maps, opened straight on a Street View panorama. Needs no key. */
function streetPanoUrl(pano: string) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&pano=${encodeURIComponent(pano)}`;
}

/**
 * The walkthrough on a listing page. A plain video plays as one; the two 360
 * kinds open in the panorama viewer, where a buyer drags to look around.
 */
function ListingTour({ listing }: { listing: Listing }) {
  const { t } = useLocale();
  const kind = listing.tour_kind;
  if (!listing.tour_url || !kind) return null;
  return (
    <figure className="tour-card detail-tour">
      {kind === "video" ? (
        <video
          src={listing.tour_url}
          controls
          playsInline
          preload="metadata"
          aria-label={t("app.walkthroughVideoOfTitle", { title: listing.title })}
        />
      ) : (
        <PanoramaViewer
          key={listing.tour_url}
          src={listing.tour_url}
          kind={kind}
          label={t("app.n360ValueOfTitle", { value: kind === "video360" ? "video" : "photo", title: listing.title })}
        />
      )}
      <figcaption>
        {kind === "video"
          ? t("app.walkthroughVideoFromTheOwnerTheSpace")
          : kind === "video360"
            ? t("app.n360WalkthroughFromTheOwnerPressPlay")
            : t("app.n360PhotoFromTheOwnerDragTo")}
      </figcaption>
    </figure>
  );
}

/**
 * How long each how-it-works step holds before the band moves on.
 *
 * The widget animations run on the same clock in CSS - `--step-cycle` and
 * the `loop-*` animations in globals.css - so a change here needs the same
 * change there, or a step will move on mid-sentence.
 */
const STEP_CYCLE_MS = 3200;

/**
 * The hero's WebGL field: a slow drift of panels standing in for the
 * advertising space the marketplace sells.
 *
 * Client-only and dynamically imported, so three.js never enters the
 * server bundle and never blocks first paint. It replaces two decorative
 * blobs rather than being added on top of them: the hero already carries a
 * headline, a live listing preview and a trust row, and a third decorative
 * layer would be noise. The component itself checks for WebGL support and
 * renders nothing if there is none, so the hero always stands on its type.
 */
const HeroCanvas = dynamic(() => import("./components/HeroCanvas"), {
  ssr: false,
});
/** Channels offered in the listing editor. A listing may legitimately carry a
 *  channel outside this list (seeded rows, or one set directly in the
 *  database), so the editor also always offers whatever the listing already
 *  has - otherwise editing it would rewrite the channel. */
const LISTING_CHANNELS = [
  "Instagram",
  "TikTok",
  "YouTube",
  "Newsletter",
  "Website",
  "Storefront",
  "Vehicle",
  "Wall / mural",
  "Room / interior",
  "Community board",
  "Business brief",
  "Sponsorship",
  "Other",
];

/* ---------------------------------------------------------------------------
 * Onboarding taxonomies.
 *
 * Onboarding asks questions in chips rather than free text, and every chip has
 * to land in a column that already exists. These tables are the mapping. They
 * are client-side constants on purpose: `channel` and `price_unit` have no DB
 * CHECK (the 0002 seeds carry values like "Cafe window" and "story set" that
 * any CHECK would reject), so the taxonomy can change in a deploy rather than
 * a migration.
 * ------------------------------------------------------------------------- */

/** Written to profiles.categories. Shared by the creator and business panes. */
const CATEGORY_CHIPS = [
  "Food & drink",
  "Fashion",
  "Fitness",
  "Beauty",
  "Local news",
  "Family",
  "Music",
  "Sports",
  "Tech",
  "Home",
  "Pets",
  "Auto",
  "Other",
];

/** Creator: which socialPlatforms keys are offered, and their offer examples. */
const CREATOR_PLATFORMS = [
  "instagram",
  "tiktok",
  "youtube",
  "x",
  "facebook",
  "newsletter",
  "podcast",
  "twitch",
] as const;

/** Every kind of advertising inventory a Creator can bring to SideSpace. */
const CREATOR_OFFER_TYPES: Array<{
  value: CreatorOfferType;
  label: string;
  help: string;
}> = [
  {
    value: "social",
    label: "Online",
    help: "Social posts, video, newsletters, or podcasts",
  },
  {
    value: "physical",
    label: "Physical",
    help: "Windows, walls, vehicles, rooms, or boards",
  },
  {
    value: "sponsorship",
    label: "Sponsorship",
    help: "Teams, events, jerseys, banners, and named tiers",
  },
];

type ListingFormKind = "brief" | CreatorOfferType;

/**
 * Example copy for the listing editor, by the shape of the listing.
 *
 * Every placeholder used to show the social example regardless of what was
 * picked: choose "Physical" and the title field still suggested "Three-story
 * launch package" and the offer field "three Instagram stories over 48 hours",
 * directly under a hint that said "like Cafe window, Main Street". Someone
 * listing a window was being shown how to list a story. The form now reads
 * one row of this table, chosen by the same flags that already pick its
 * labels and help text.
 */


/** Suggestion chips for `format`, filtered to the platforms actually picked. */
const CREATOR_OFFER_EXAMPLES: Record<string, string[]> = {
  instagram: ["three Instagram stories over 48 hours", "one in-feed post"],
  tiktok: ["a TikTok with a 24-hour pin", "a TikTok product feature"],
  youtube: ["a dedicated YouTube segment", "a YouTube short"],
  x: ["a pinned post for 24 hours"],
  facebook: ["a post to my local group"],
  newsletter: ["a newsletter mention"],
  podcast: ["a podcast read"],
  twitch: ["a stream shout-out"],
};

/** Space owner: chip -> the LISTING_CHANNELS value it stores. */
const SPACE_KIND_CHIPS: Array<{ label: string; channel: string }> = [
  { label: "Window", channel: "Storefront" },
  { label: "Wall or mural", channel: "Wall / mural" },
  { label: "Storefront counter", channel: "Storefront" },
  { label: "Vehicle", channel: "Vehicle" },
  { label: "Yard or fence", channel: "Other" },
  { label: "Room or interior", channel: "Room / interior" },
  { label: "Community board", channel: "Community board" },
  { label: "A-frame sign", channel: "Other" },
  { label: "Something else", channel: "Other" },
];

/**
 * Foot traffic. Writes three things: a number to profiles.avg_views, a unit to
 * profiles.reach_unit, and a human sentence to listings.demographics.
 *
 * "Not sure" carries a null count deliberately - it must leave whatever the
 * member already had rather than publishing a claim of zero.
 */
/**
 * What can physically go up in a space.
 *
 * This is the question the flow used to answer on the owner's behalf: every
 * drafted description carried "It suits a poster, a decal, or a printed card,
 * and I can help put it up." A shop that does not allow adhesive on glass was
 * advertising decals, and every owner was volunteering their own labour.
 */
const SURFACE_OTHER = "Something else";

const SURFACE_CHIPS = [
  "Posters",
  "Vinyl decals",
  "Counter cards",
  "Flyers",
  "Banners",
  "A-frame signs",
  "Paint or mural",
  "Digital screens",
  // Required, and it becomes `deliverables` - the literal list of what a buyer
  // gets. An owner offering a shelf for product samples, a hanging mobile or a
  // lightbox had nothing to pick and no way to say so, on the one question
  // that defines the thing they are selling.
  SURFACE_OTHER,
];

/** Who physically puts it up. Feeds listings.install_by and the description. */
const INSTALL_CHIPS: Array<{
  label: string;
  value: "owner" | "renter" | "either";
  sentence: string;
}> = [
  {
    label: "I put it up",
    value: "owner",
    sentence: "I’ll put it up for you.",
  },
  {
    label: "You come and install it",
    value: "renter",
    sentence: "You install it yourself — we’ll arrange a time.",
  },
  {
    label: "Either works",
    value: "either",
    sentence: "I can put it up, or you’re welcome to install it yourself.",
  },
];

const TRAFFIC_CHIPS: Array<{
  label: string;
  count: number | null;
  sentence: string;
}> = [
  {
    label: "Quiet street",
    count: 50,
    sentence: "A quiet street - regulars and neighbours rather than crowds.",
  },
  {
    label: "Steady neighborhood",
    count: 300,
    sentence: "About 300 people a day, mostly local regulars.",
  },
  {
    label: "Busy block",
    count: 1200,
    sentence: "About 1,200 people a day on a busy block.",
  },
  {
    label: "Major foot traffic",
    count: 5000,
    sentence: "5,000+ people a day - a main pedestrian route.",
  },
  // Not "Not sure". That chip published a space with no reach at all, which
  // sorts below every space that guessed - the exact opposite of what someone
  // picking it intends. This one reveals nothing new; it just leaves the count
  // input, which is always on screen, for them to fill in.
  { label: "I’ll count it myself", count: null, sentence: "" },
];

/** Space owner availability. One chip, no date pickers. */
/**
 * Availability, which now writes real dates.
 *
 * These used to be four bare strings landing in `availability_notes` and
 * nowhere else, so a space had no date window while a business brief - whose
 * timing chips have always written available_from/available_to - did. A space
 * that cannot say when it is free cannot be matched to a campaign that runs in
 * October.
 *
 * `startDays: null` means "no window", which is the honest write for "Ask me".
 */
const AVAILABILITY_CHIPS: Array<{
  label: string;
  startDays: number | null;
  days: number;
  sentence: string;
}> = [
  { label: "Available now", startDays: 0, days: 90, sentence: "It’s free now." },
  {
    label: "From next month",
    startDays: 30,
    days: 120,
    sentence: "It opens up next month.",
  },
  {
    label: "Seasonal",
    startDays: 0,
    days: 180,
    sentence: "It’s free seasonally — ask about specific dates.",
  },
  { label: "Ask me", startDays: null, days: 0, sentence: "Ask me about dates." },
];

/** Business: what the campaign should achieve. Seeds the description draft. */
const BUSINESS_GOAL_CHIPS: Array<{ label: string; sentence: string }> = [
  {
    label: "Get people into the store",
    sentence: "We want more people through the door.",
  },
  {
    label: "Launch something new",
    sentence: "We are launching something new and want the neighbourhood to know.",
  },
  {
    label: "Grow our following",
    sentence: "We want to grow a genuinely local following.",
  },
  { label: "Sell out an event", sentence: "We have an event to fill." },
  {
    label: "Stay top of mind nearby",
    sentence: "We want to stay top of mind with people nearby.",
  },
];


/**
 * What a business is shopping for. This is the fork the whole brief hangs off:
 * pick Physical and the words Instagram and TikTok never appear; pick Virtual
 * and nobody is asked what neighbourhood they want.
 */
const BRIEF_SCOPE_CHIPS: Array<{
  label: string;
  value: "physical" | "virtual" | "both";
  help: string;
}> = [
  {
    label: "Physical space",
    value: "physical",
    help: "Windows, walls, counters, vehicles, boards",
  },
  {
    label: "Virtual / social",
    value: "virtual",
    help: "Posts, reels, stories, newsletters",
  },
  { label: "Both", value: "both", help: "Whatever reaches people locally" },
];

/** Physical placements a brief can ask for. Only shown for physical/both. */
const BRIEF_PHYSICAL_CHIPS = [
  "Storefront windows",
  "Walls & murals",
  "Counters & registers",
  "Vehicles",
  "Community boards",
  "Yards & fences",
  "A-frame signs",
  "Event booths",
  "Local teams & events",
  "Other",
];

/** Social platforms a brief can target. Only shown for virtual/both. */
const BRIEF_PLATFORM_CHIPS = [
  "Instagram",
  "TikTok",
  "YouTube",
  "X",
  "Facebook",
  "Newsletter",
  "Podcast",
  "Twitch",
  "LinkedIn",
  "Other",
];

/** Budget range presets: [low, high]. A range beats one number for a brief. */
const BUDGET_RANGE_CHIPS: Array<{
  label: string;
  min: number;
  max: number | null;
}> = [
  { label: "$50 – $150", min: 50, max: 150 },
  { label: "$150 – $500", min: 150, max: 500 },
  { label: "$500 – $1,500", min: 500, max: 1500 },
  { label: "$1,500 – $5,000", min: 1500, max: 5000 },
  // Open-ended. This used to carry max: 25000, so picking "$5,000+" quietly
  // wrote a $25,000 ceiling the member never saw, said or agreed to.
  { label: "$5,000+", min: 5000, max: null },
];

/** Business timing. Sets availability_notes plus the available_from/to window. */
const BUSINESS_TIMING_CHIPS: Array<{
  label: string;
  days: number;
  sentence: string;
}> = [
  {
    label: "Next 2 weeks",
    days: 14,
    sentence: "We’d like this live in the next two weeks.",
  },
  { label: "This month", days: 30, sentence: "We’d like this live this month." },
  { label: "Next month", days: 60, sentence: "We’re planning for next month." },
  { label: "Flexible", days: 90, sentence: "Our timing is flexible." },
];

/** Suggestion chips for a business's `deliverables`, social placements only. */
const DELIVERABLE_EXAMPLES = [
  "Tag @us",
  "Use our hashtag",
  "Link in bio for 48h",
  "Show the product on camera",
];

/**
 * Sponsorship host: what kind of organisation. Seeds the title AND the
 * profile's categories - the comment here used to claim the latter while
 * nothing wrote it, so a robotics team published with no categories at all
 * and could not be found by searching for one.
 */
const SPONSOR_ORG_OTHER = "Something else";

const SPONSOR_ORG_CHIPS = [
  "Robotics team",
  "Sports team",
  "Esports team",
  "Hackathon",
  "Conference",
  "Nonprofit",
  "Student org",
  "School club",
  "Festival",
  "Band or theater",
  // SPACE_KIND_CHIPS has always ended with an escape hatch and this did not,
  // so a scout troop, a PTA, a church group or an animal shelter had to file
  // itself under "Nonprofit". That label is not cosmetic: it opens their
  // description and, since it seeds profiles.categories, it is what somebody
  // searching finds them by.
  SPONSOR_ORG_OTHER,
];

/**
 * Sponsorship reach. Same three-way write as TRAFFIC_CHIPS, but the unit
 * differs between a season-long team and a single event - which is exactly the
 * distinction profiles.reach_unit exists to carry.
 */
const SPONSOR_REACH_CHIPS: Array<{
  label: string;
  count: number | null;
  unit: string;
  sentence: string;
}> = [
  {
    label: "Our team and families (~100)",
    count: 100,
    unit: "people a season",
    sentence: "Around 100 people across the season - the team and their families.",
  },
  {
    label: "A local crowd (~1,000)",
    count: 1000,
    unit: "people a season",
    sentence: "Around 1,000 people across the season.",
  },
  {
    label: "A regional event (~5,000)",
    count: 5000,
    unit: "people per event",
    sentence: "Around 5,000 people at the event.",
  },
  {
    label: "A big event (10,000+)",
    count: 10000,
    unit: "people per event",
    sentence: "10,000+ people at the event.",
  },
  // Same trap as the old traffic chip: picking "Not sure" satisfied the chip
  // but left reachCount empty, and the validator then refused to publish with
  // no way back except un-picking the answer they meant.
  { label: "I’ll put in a number", count: null, unit: "", sentence: "" },
];

/** What a sponsor actually receives. First two feed `format`, all feed `deliverables`. */
const SPONSOR_BENEFIT_CHIPS = [
  "Logo on jerseys",
  "Logo on the robot or kit",
  "Banner at events",
  "Named tier",
  "Social shoutouts",
  "Newsletter mention",
  "Booth or table",
  "Logo on our website",
  "Announcer shout-out",
  "Program ad",
];

/**
 * A tier's perks in menu order, not tap order.
 *
 * The card's offer line is built from the first two of these, and it used to
 * take them in whatever order the host happened to tap the chips - so a team
 * that picked "Newsletter mention" before "Logo on jerseys" published a card
 * led by the newsletter. SPONSOR_BENEFIT_CHIPS is already written most
 * tangible first; sorting by it makes the headline the two perks a sponsor
 * cares most about, every time.
 */
function orderedBenefits(benefits: string[]) {
  const rank = (item: string) => {
    const at = SPONSOR_BENEFIT_CHIPS.indexOf(item);
    return at === -1 ? SPONSOR_BENEFIT_CHIPS.length : at;
  };
  return [...benefits].sort((a, b) => rank(a) - rank(b));
}

/**
 * The one-line offer on a sponsorship card.
 *
 * Two perks and a count, rather than a bare first two. A new tier starts from
 * the whole menu and the host prunes downward, so lower tiers are usually
 * PREFIXES of higher ones - and a bare slice(0, 2) then published the same
 * sentence for Gold and Silver:
 *
 *   $1000 Gold    You get logo on jerseys and banner at events
 *   $500  Silver  You get logo on jerseys and banner at events
 *
 * A business could not tell what the extra $500 bought. The count is what
 * makes the levels different on the card, which is the whole reason each tier
 * publishes its own.
 */
function sponsorOfferLine(benefits: string[]) {
  const perks = orderedBenefits(benefits).map((item) => item.toLowerCase());
  if (perks.length <= 2) return joinList(perks);
  const rest = perks.length - 2;
  return joinList([...perks.slice(0, 2), `${rest} more`]);
}

/**
 * The one-line "Looking for" on a brief card.
 *
 * Two problems it fixes. A business that picks broadly published all of it:
 * every physical chip plus every platform is a 234-character run-on where a
 * card headline should be. And everything was lowercased, which is right for
 * "storefront windows" and wrong for a brand - the card asked for "instagram
 * and tiktok", and rendered X as "x".
 */
function briefWantsLine(placements: string[], platforms: string[]) {
  const wants = [
    ...placements.map((item) => item.toLowerCase()),
    ...platforms,
  ];
  if (wants.length <= 3) return joinList(wants);
  return joinList([...wants.slice(0, 3), `${wants.length - 3} more`]);
}

/** Sponsorship window. Sets availability_notes and the date pair. */
const SPONSOR_SEASON_CHIPS: Array<{
  label: string;
  days: number;
  sentence: string;
}> = [
  {
    label: "This season",
    days: 120,
    sentence: "This is a season-long sponsorship.",
  },
  { label: "This semester", days: 150, sentence: "This runs for the semester." },
  { label: "One event", days: 30, sentence: "This is for a single event." },
  { label: "Year-round", days: 365, sentence: "This runs year-round." },
];

/** Price presets per role. "Custom" reveals a number input. */
const PRICE_CHIPS: Record<string, number[]> = {
  creator: [50, 150, 300, 600],
  space_owner: [25, 75, 150, 400],
  sponsor_host: [250, 500, 1000, 2500],
};

/** Every unit the editor offers. The row's own value is unioned in at render. */


const PRICE_UNIT_CHIPS: Record<string, string[]> = {
  creator: ["post", "video", "story", "campaign", "week", "month", "day"],
  space_owner: ["week", "month", "day", "campaign"],
};

/**
 * Every answer in the onboarding flow, in one controlled object.
 *
 * The old flow read its values out of FormData at submit time, which stops
 * working the moment step 2 branches by role: `saveOnboarding` guarded each
 * field with `values.has(...)`, so a creator who picked TikTok but not
 * Instagram never rendered `social_instagram`, `values.has` returned false, and
 * every handle they typed was silently discarded in favour of the stored
 * profile. Chip groups are React state and never appear in FormData at all, so
 * they would write nothing. Controlled state removes the whole bug class.
 */
/**
 * One sponsorship level.
 *
 * A sponsorship host publishes one LISTING per tier, so this is the unit the
 * publish step maps over. Bronze/Silver/Gold is the shape of the category: the
 * old flow asked for a single price and a single flat benefit list, which
 * forced a team to either underprice a jersey logo or overprice a website
 * mention.
 */
type SponsorTier = {
  name: string;
  price: number | null;
  /** Optional upper end, for a team publishing one flexible level. */
  priceMax: number | null;
  /** How many sponsors fit at this level. */
  slots: number | null;
  /** A subset of the benefits chosen above - never a second free-for-all. */
  benefits: string[];
};

type CreatorOfferDetails = {
  title: string;
  format: string;
  price: number | null;
  price_unit: string;
  description: string;
  priceMax: number | null;
  spaceKind: string;
  streetAddress: string;
  location_area: string;
  spaceSize: string;
  surfaces: string[];
  installBy: "" | "owner" | "renter" | "either";
  traffic: string;
  trafficCount: number | null;
  availability: string;
  orgKind: string;
  orgOther: string;
  surfaceOther: string;
  reach: string;
  reachCount: number | null;
  funding: string;
  benefits: string[];
  season: string;
  tiers: SponsorTier[];
};

type CreatorOfferTouched = {
  title: boolean;
  description: boolean;
};

type OnboardingAnswers = {
  // Step 1 - identity, asked of every role exactly once.
  display_name: string;
  city: string;
  /** City centroid or a rounded GPS point, used only for nearby matching. */
  location: LocationPoint | null;
  bio: string;
  handle: string;
  /** Business only: the owner behind the business name. */
  contact_name: string;
  /** Everyone except business: how a booker reaches them. */
  contact_email: string;
  // Creator.
  platforms: string[];
  socials: Record<string, string>;
  followers: number | null;
  /** The currently visible Creator inventory workspace. */
  creatorOffer: "" | CreatorOfferType;
  /** Every Creator inventory path selected in the multi-select. */
  creatorOffers: CreatorOfferType[];
  /** The saved field values for each selected Creator inventory path. */
  creatorOfferDetails: Record<CreatorOfferType, CreatorOfferDetails>;
  /** Whether the member has replaced the generated title/body per path. */
  creatorOfferTouched: Record<CreatorOfferType, CreatorOfferTouched>;
  // The listing every role publishes.
  title: string;
  format: string;
  price: number | null;
  price_unit: string;
  description: string;
  categories: string[];
  // Space owner.
  spaceKind: string;
  /** The exact address. A physical listing is worth nothing without it. */
  streetAddress: string;
  location_area: string;
  /** Roughly how big it is, free text: "6 ft x 3 ft". The description helper
   *  has always told owners to add this by hand; now the form asks. */
  spaceSize: string;
  /** What can physically go up. The drafted description used to assert
   *  "suits a poster, a decal, or a printed card" for every single owner. */
  surfaces: string[];
  /** Who puts the artwork up. "either" is a real answer, not a missing one. */
  installBy: "" | "owner" | "renter" | "either";
  traffic: string;
  /** The number behind the traffic chip, editable. Without it "Not sure" was
   *  a dead end that published a space with no reach at all, which sorts it
   *  below every space that guessed. */
  trafficCount: number | null;
  availability: string;
  // Business.
  goals: string[];
  placements: string[];
  deliverables: string;
  artwork: "" | "supply" | "help";
  timing: string;
  /** Physical space, virtual placements, or both. Forks the whole brief. */
  /** The concrete thing being promoted: "our new cold brew", "the Saturday
   *  class", "the grand opening". Categories are too coarse to answer this. */
  promoting: string;
  briefScope: "" | "physical" | "virtual" | "both";
  /** Upper end of the budget range; `price` holds the lower end. */
  priceMax: number | null;
  /** Which social platforms a virtual brief wants to reach. */
  targetPlatforms: string[];
  /** Where the business wants physical space, which is not where THEY are. */
  wantedArea: string;
  /** Business setup only: campaign onboarding, or skip straight to browsing. */
  businessSetupPath: "" | "campaign" | "browse";
  // Sponsorship host.
  orgKind: string;
  /** What they typed after picking "Something else". */
  orgOther: string;
  /** Same, for the surfaces list. */
  surfaceOther: string;
  reach: string;
  /** The number behind the reach chip, editable - same fix as trafficCount. */
  reachCount: number | null;
  /** What the money is actually for: "the championship trip", "new kit".
   *  The most persuasive line a sponsor reads, and the flow never asked. */
  funding: string;
  benefits: string[];
  season: string;
  /** One to three levels. Each publishes its own card. */
  tiers: SponsorTier[];
};

/**
 * The one selection idiom in onboarding.
 *
 * Single- and multi-select share a component on purpose. The old flow rendered
 * the same "pick your roles" decision twice in two different visual languages -
 * 210px cards for the primary role, compact tinted rows for the extras -
 * stacked one above the other. Chips are now the only multi-select control in
 * the flow.
 *
 * Multi-select chips carry a leading check when active so their state does not
 * rest on the lime fill alone.
 */
function OptionalFieldLabel({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  return (
    <span className="field-label-line">
      {children}
      {" "}
      <span className="optional">{t("app.optional2")}</span>
    </span>
  );
}

const PROFILE_CROP_SIZE = 280;
const PROFILE_CROP_OUTPUT_SIZE = 1024;

type CropPosition = { x: number; y: number };
type ImageDimensions = { width: number; height: number };

function clampCropPosition(
  position: CropPosition,
  image: ImageDimensions,
  cropSize: number,
  zoom: number,
): CropPosition {
  const baseScale = Math.max(
    cropSize / image.width,
    cropSize / image.height,
  );
  const displayedWidth = image.width * baseScale * zoom;
  const displayedHeight = image.height * baseScale * zoom;
  const maxX = Math.max(0, (displayedWidth - cropSize) / 2);
  const maxY = Math.max(0, (displayedHeight - cropSize) / 2);

  return {
    x: Math.min(maxX, Math.max(-maxX, position.x)),
    y: Math.min(maxY, Math.max(-maxY, position.y)),
  };
}

/**
 * Pick, frame, and export the profile image before the onboarding form saves.
 * The crop is done in the browser so the stored avatar matches the preview,
 * even after the temporary object URL used by the editor disappears.
 */
function ProfilePhotoField({
  currentUrl,
  inputRef,
  value,
  onFileChange,
  onCropStateChange,
}: {
  currentUrl?: string;
  inputRef: { current: HTMLInputElement | null };
  value: File | null;
  onFileChange: (file: File | null) => void;
  onCropStateChange: (pending: boolean) => void;
}) {
  const { t, tx } = useLocale();
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceReadyFile, setSourceReadyFile] = useState<File | null>(null);
  const [imageDimensions, setImageDimensions] =
    useState<ImageDimensions | null>(null);
  const [cropSize, setCropSize] = useState(PROFILE_CROP_SIZE);
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState<CropPosition>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [cropError, setCropError] = useState("");
  const [cropping, setCropping] = useState(false);
  const [valuePreviewUrl, setValuePreviewUrl] = useState("");
  const [valuePreviewFile, setValuePreviewFile] = useState<File | null>(null);
  const cropSurfaceRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!sourceFile) return;

    let cancelled = false;
    const reader = new FileReader();
    reader.onload = () => {
      if (cancelled || typeof reader.result !== "string") return;
      const dataUrl = reader.result;
      const image = new Image();
      image.onload = () => {
        if (cancelled) return;
        setSourceUrl(dataUrl);
        setSourceReadyFile(sourceFile);
        setImageDimensions({
          width: image.naturalWidth || image.width,
          height: image.naturalHeight || image.height,
        });
      };
      image.onerror = () => {
        if (!cancelled) setCropError(tx("That photo could not be read."));
      };
      image.src = dataUrl;
    };
    reader.onerror = () => {
      if (!cancelled) setCropError(tx("That photo could not be read."));
    };
    reader.readAsDataURL(sourceFile);

    return () => {
      cancelled = true;
      reader.abort();
    };
  }, [sourceFile, tx]);

  useEffect(() => {
    if (!value) return;

    let cancelled = false;
    const reader = new FileReader();
    reader.onload = () => {
      if (cancelled || typeof reader.result !== "string") return;
      setValuePreviewUrl(reader.result);
      setValuePreviewFile(value);
    };
    reader.onerror = () => undefined;
    reader.readAsDataURL(value);
    return () => {
      cancelled = true;
      reader.abort();
    };
  }, [value]);

  useEffect(() => {
    const surface = cropSurfaceRef.current;
    if (!surface) return;

    const measure = () => {
      const nextSize = surface.getBoundingClientRect().width;
      if (nextSize > 0) setCropSize(nextSize);
    };
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [sourceUrl]);

  useEffect(
    () => () => {
      if (dragRef.current) dragRef.current = null;
      onCropStateChange(false);
    },
    [onCropStateChange],
  );

  const imageLayout = useMemo(() => {
    if (!imageDimensions) return null;
    const baseScale = Math.max(
      cropSize / imageDimensions.width,
      cropSize / imageDimensions.height,
    );
    return {
      scale: baseScale * zoom,
      width: imageDimensions.width * baseScale * zoom,
      height: imageDimensions.height * baseScale * zoom,
    };
  }, [cropSize, imageDimensions, zoom]);

  const boundedPosition = imageDimensions
    ? clampCropPosition(position, imageDimensions, cropSize, zoom)
    : position;

  function handleFilePick(file: File | null) {
    if (!file) return;
    if (
      !file.type ||
      !["image/jpeg", "image/png", "image/webp"].includes(file.type)
    ) {
      setCropError(tx("Choose a JPG, PNG, or WebP image."));
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setCropError("");
    setSourceReadyFile(null);
    setImageDimensions(null);
    setZoom(1);
    setPosition({ x: 0, y: 0 });
    onCropStateChange(true);
    setSourceFile(file);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!imageLayout || !imageDimensions) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    setDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !imageDimensions) {
      return;
    }
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    setPosition((current) =>
      clampCropPosition(
        { x: current.x + deltaX, y: current.y + deltaY },
        imageDimensions,
        cropSize,
        zoom,
      ),
    );
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function moveWithKeyboard(deltaX: number, deltaY: number) {
    if (!imageDimensions) return;
    setPosition((current) =>
      clampCropPosition(
        { x: current.x + deltaX, y: current.y + deltaY },
        imageDimensions,
        cropSize,
        zoom,
      ),
    );
  }

  function handleCropKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 24 : 8;
    const deltas: Record<string, CropPosition> = {
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    moveWithKeyboard(delta.x, delta.y);
  }

  function handleZoomChange(nextZoom: number) {
    setZoom(nextZoom);
    if (imageDimensions) {
      setPosition((current) =>
        clampCropPosition(current, imageDimensions, cropSize, nextZoom),
      );
    }
  }

  async function applyCrop() {
    if (
      cropping ||
      !sourceFile ||
      sourceReadyFile !== sourceFile ||
      !sourceUrl ||
      !imageDimensions ||
      !imageLayout
    ) {
      return;
    }

    setCropError("");
    setCropping(true);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("That photo could not be read."));
        element.src = sourceUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = PROFILE_CROP_OUTPUT_SIZE;
      canvas.height = PROFILE_CROP_OUTPUT_SIZE;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("That photo could not be cropped.");

      const sourceCropSize = cropSize / imageLayout.scale;
      const sourceX = Math.min(
        imageDimensions.width - sourceCropSize,
        Math.max(
          0,
          imageDimensions.width / 2 -
            boundedPosition.x / imageLayout.scale -
            sourceCropSize / 2,
        ),
      );
      const sourceY = Math.min(
        imageDimensions.height - sourceCropSize,
        Math.max(
          0,
          imageDimensions.height / 2 -
            boundedPosition.y / imageLayout.scale -
            sourceCropSize / 2,
        ),
      );

      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceCropSize,
        sourceCropSize,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/webp", 0.9),
      );
      if (!blob) throw new Error("That photo could not be cropped.");

      const baseName = sourceFile.name.replace(/\.[^/.]+$/, "") || "profile-photo";
      const extension =
        blob.type === "image/webp"
          ? "webp"
          : blob.type === "image/png"
            ? "png"
            : "jpg";
      const croppedFile = new File([blob], `${baseName}-cropped.${extension}`, {
        type: blob.type || "image/webp",
        lastModified: Date.now(),
      });
      onFileChange(croppedFile);
      onCropStateChange(false);
      setSourceFile(null);
      if (inputRef.current) inputRef.current.value = "";
    } catch (error) {
      setCropError(
        tx(error instanceof Error ? error.message : "That photo could not be cropped."),
      );
    } finally {
      setCropping(false);
    }
  }

  function cancelCrop() {
    onCropStateChange(false);
    setSourceFile(null);
    setCropError("");
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="profile-photo-picker">
      <input
        ref={inputRef}
        name="avatar_file"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={(event) => handleFilePick(event.target.files?.[0] ?? null)}
      />

      {sourceFile ? (
        <div className="profile-photo-crop-editor">
          <div
            ref={cropSurfaceRef}
            className={`profile-photo-crop-surface${dragging ? " is-dragging" : ""}`}
            role="region"
            aria-label={t("app.cropProfilePhotoDragTheImageTo")}
            tabIndex={0}
            onKeyDown={handleCropKeyDown}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
          >
            {sourceUrl && sourceReadyFile === sourceFile && imageLayout ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={sourceUrl}
                alt={t("app.profilePhotoCropPreview")}
                draggable={false}
                onLoad={(event) =>
                  setImageDimensions({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                style={{
                  height: imageLayout.height,
                  left: "50%",
                  top: "50%",
                  transform: `translate(calc(-50% + ${boundedPosition.x}px), calc(-50% + ${boundedPosition.y}px))`,
                  width: imageLayout.width,
                }}
              />
            ) : (
              <span className="profile-photo-crop-loading">{t("app.loadingPhoto")}</span>
            )}
            <span className="profile-photo-crop-outline" aria-hidden="true" />
          </div>
          <div className="profile-photo-crop-controls">
            <label className="profile-photo-zoom">
              <span>{t("app.zoom")}</span>
              <input
                type="range"
                min="1"
                max="3"
                step="0.01"
                value={zoom}
                aria-label={t("app.zoomProfilePhoto")}
                onChange={(event) => handleZoomChange(Number(event.target.value))}
              />
              <output>{Math.round(zoom * 100)}%</output>
            </label>
            <small>{t("app.dragThePhotoToChooseWhatAppears")}</small>
          </div>
          <div className="profile-photo-crop-actions">
            <button type="button" onClick={cancelCrop}>
              {t("app.cancel")}
            </button>
            <button
              type="button"
              className="button button-dark"
              disabled={!imageLayout || cropping}
              onClick={() => void applyCrop()}
            >
              {cropping ? t("app.preparing") : t("app.useThisCrop")}
            </button>
          </div>
        </div>
      ) : (
        <div className="profile-photo-preview-row">
          {((value && valuePreviewFile === value && valuePreviewUrl) ||
            (!value && currentUrl)) && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              className="profile-photo-preview"
              src={value ? valuePreviewUrl : currentUrl}
              alt={value ? t("app.selectedProfilePhoto") : t("app.currentProfilePhoto")}
            />
          )}
          <small>
            {value
              ? t("app.yourCroppedPhotoIsReadyChooseAnother")
              : currentUrl
                ? t("app.yourCurrentPhotoIsShownHereChoose")
                : t("app.chooseAPhotoThenDragItInto")}
          </small>
        </div>
      )}

      {cropError && (
        <small className="profile-photo-crop-error" role="alert">
          {cropError}
        </small>
      )}
    </div>
  );
}

const BUSINESS_BIO_MIN_WORDS = 5;
const BIO_MIN_CHARACTERS = 10;

function countWords(value: string) {
  return value.trim() ? value.trim().split(/\s+/).length : 0;
}

function usesWordBasedBioRequirement(role: Role | null) {
  return role === "business" || role === "creator";
}

function bioMeetsRequirement(value: string, role: Role | null) {
  return usesWordBasedBioRequirement(role)
    ? countWords(value) >= BUSINESS_BIO_MIN_WORDS
    : value.trim().length >= BIO_MIN_CHARACTERS;
}

function getBioRequirementHint(value: string, role: Role | null, t: Translate = translateEnglish) {
  if (usesWordBasedBioRequirement(role)) {
    const remaining = Math.max(0, BUSINESS_BIO_MIN_WORDS - countWords(value));

    if (remaining === 0) {
      return t("app.minimumReached");
    }

    return remaining === 1 ? t("app.oneMoreWordNeeded") : t("app.moreWordsNeeded", { count: remaining });
  }

  const remaining = Math.max(0, BIO_MIN_CHARACTERS - value.trim().length);

  if (remaining === 0) {
    return t("app.minimumReached");
  }

  return remaining === 1 ? t("app.oneMoreCharacterNeeded") : t("app.moreCharactersNeeded", { count: remaining });
}

function ChipRow({
  options,
  selected,
  onPick,
  multi = false,
  field,
  label,
  optional = false,
  hideLabel = false,
}: {
  options: string[];
  selected: string[];
  onPick: (value: string) => void;
  multi?: boolean;
  field: string;
  label: string;
  optional?: boolean;
  hideLabel?: boolean;
}) {
  const { t } = useLocale();
  // The label used to live only in aria-label, so a sighted member met several
  // required chip rows as unheaded rows of pills - "pick what kind of business
  // you are" was never written down anywhere. Rendering it fixes the same gap
  // for everyone at once, and gives reportMissing something focusable.
  const labelId = `chip-label-${field}`;
  return (
    <>
      {!hideLabel && (
        <span className="chip-label" id={labelId}>
          {label}
          {" "}
          {optional && <span className="optional">{t("app.optional2")}</span>}
        </span>
      )}
      <div
        className="filter-row onboarding-chips"
        data-field={field}
        role="group"
        aria-label={hideLabel ? label : undefined}
        aria-labelledby={hideLabel ? undefined : labelId}
        tabIndex={-1}
      >
        {options.map((option) => {
          const active = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              className={active ? "active" : ""}
              aria-pressed={active}
              onClick={() => onPick(option)}
            >
              {multi && active ? `✓ ${option}` : option}
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * The creator's platform selection, profile links and audience size as one
 * progressive question.
 *
 * The previous layout rendered every selected handle as a loose form field,
 * put Instagram's lookup button on a separate line, and left the follower
 * count visually unrelated to the platform it described. These rows keep the
 * platform identity, its public link and its primary-channel status together.
 */
function CreatorAudienceFields({
  answers,
  setAnswers,
  igAvatarBusy,
  igAvatar,
  igStats,
  onCheckInstagram,
}: {
  answers: OnboardingAnswers;
  setAnswers: Dispatch<SetStateAction<OnboardingAnswers>>;
  igAvatarBusy: boolean;
  igAvatar: string;
  igStats: IgStats | null;
  onCheckInstagram: (handle: string) => void;
}) {
  const { t, tx } = useLocale();
  const selectedPlatforms = answers.platforms
    .map((key) => socialPlatforms.find((platform) => platform.key === key))
    .filter((platform): platform is (typeof socialPlatforms)[number] =>
      Boolean(platform),
    );
  const primaryKey =
    answers.platforms.find((key) => (answers.socials[key] ?? "").trim()) ??
    answers.platforms[0] ??
    "";
  const primaryPlatform = socialPlatforms.find(
    (platform) => platform.key === primaryKey,
  );

  function togglePlatform(label: string) {
    const key = socialPlatforms.find((platform) => platform.label === label)?.key;
    if (!key) return;
    setAnswers((current) => ({
      ...current,
      platforms: current.platforms.includes(key)
        ? current.platforms.filter((item) => item !== key)
        : [...current.platforms, key],
    }));
  }

  function makePrimary(key: string) {
    setAnswers((current) => ({
      ...current,
      platforms: [key, ...current.platforms.filter((item) => item !== key)],
    }));
  }

  return (
    <div className="creator-audience-fieldset">
      <ChipRow
        field="platforms"
        label={t("app.chooseAllThatApply")}
        multi
        options={CREATOR_PLATFORMS.map(
          (key) =>
            socialPlatforms.find((platform) => platform.key === key)?.label ?? key,
        )}
        selected={selectedPlatforms.map((platform) => platform.label)}
        onPick={togglePlatform}
      />

      {selectedPlatforms.length > 0 && (
        <div className="audience-profile-list">
          <div className="audience-profile-heading">
            <div>
              <strong>{t("app.addYourProfiles")}</strong>
              <span>{t("app.addAHandleOrLinkForThe")}</span>
            </div>
            <small>{t("app.selectedplatformscountSelected", { selectedPlatformsCount: selectedPlatforms.length })}</small>
          </div>

          {selectedPlatforms.map((platform) => {
            const value = answers.socials[platform.key] ?? "";
            const isPrimary = platform.key === primaryKey;
            const canBePrimary = Boolean(value.trim());
            const placeholder =
              platform.key === "newsletter"
                ? "Newsletter link"
                : platform.key === "podcast"
                  ? "Show link"
                  : "@yourhandle";

            return (
              <div
                className={`audience-profile-row${isPrimary ? " is-primary" : ""}`}
                key={platform.key}
              >
                <div className="audience-platform-id">
                  <span aria-hidden="true">{tx(platform.short)}</span>
                  <strong>{tx(platform.label)}</strong>
                </div>
                <label
                  className="audience-handle-field"
                  htmlFor={`audience-${platform.key}`}
                >
                  <span className="sr-only">{t("app.labelHandleOrLink", { label: tx(platform.label) })}</span>
                  <input
                    id={`audience-${platform.key}`}
                    value={value}
                    onChange={(event) =>
                      setAnswers((current) => ({
                        ...current,
                        socials: {
                          ...current.socials,
                          [platform.key]: event.target.value,
                        },
                      }))
                    }
                    placeholder={placeholder}
                  />
                </label>
                <div className="audience-row-actions">
                  {platform.key === "instagram" && (
                    <button
                      type="button"
                      className="audience-check"
                      disabled={igAvatarBusy || !value.trim()}
                      onClick={() => onCheckInstagram(value)}
                    >
                      {igAvatarBusy ? t("app.checking") : t("app.check")}
                    </button>
                  )}
                  {isPrimary ? (
                    <span className="audience-primary-badge">{t("app.primary")}</span>
                  ) : (
                    <button
                      type="button"
                      className="audience-primary-action"
                      disabled={!canBePrimary}
                      onClick={() => makePrimary(platform.key)}
                      title={
                        canBePrimary
                          ? t("app.useLabelAsYourPrimaryChannel", { label: tx(platform.label) })
                          : t("app.addYourLabelProfileFirst", { label: tx(platform.label) })
                      }
                    >
                      {t("app.makePrimary")}
                    </button>
                  )}
                </div>

                {platform.key === "instagram" && igAvatar && (
                  <span className="ig-avatar-preview audience-row-result">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={igAvatar} alt={t("app.instagramProfilePreview")} />
                    <small>
                      {t("app.profileFoundUploadYourOwnPhotoIn")}
                    </small>
                  </span>
                )}
                {platform.key === "instagram" && igStats && (
                  <small
                    className="ig-sync-note audience-row-result"
                    role="status"
                  >
                    {igStats.throttled
                      ? t("app.instagramIsRateLimitingUsAddYour")
                      : igStats.error
                        ? t("app.weCouldntReadThatProfileYouCan")
                        : t("app.foundUsernameCompactnumberFollowers", { username: igStats.username ?? "", compactNumber: compactNumber(igStats.followers ?? 0) })}
                  </small>
                )}
              </div>
            );
          })}

          <label className="audience-size-field">
            <span>
              {primaryPlatform
                ? t("app.labelAudienceSize", { label: tx(primaryPlatform.label) })
                : t("app.audienceSize")}
              <small className="optional">{t("app.optional")}</small>
            </span>
            <small>{t("app.anEstimateIsFineThisHelpsBrands")}</small>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={2000000000}
              value={answers.followers ?? ""}
              onChange={(event) =>
                setAnswers((current) => ({
                  ...current,
                  followers: event.target.value
                    ? Number(event.target.value)
                    : null,
                }))
              }
              placeholder="18,400"
            />
          </label>

          <div className="audience-filing-note" aria-live="polite">
            <span aria-hidden="true">↳</span>
            <p>
              {t("app.yourCardWillAppearUnder")}{" "}<b>{creatorChannel(answers)}</b>{t("app.onlyProfilesWithAHandleOrLink")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The answers that survive a change of role.
 *
 * Identity, not shape: who you are and how to reach you do not change because
 * you switched from renting a window to selling posts. contact_name and
 * contact_email used to be missing from this list, so a creator who typed
 * their email, looked at the Business pane, and came back found the box empty
 * - three of the four roles ask for that address.
 */
const ROLE_SWITCH_KEEPS = [
  "display_name",
  "city",
  "location",
  "bio",
  "handle",
  "contact_name",
  "contact_email",
  "categories",
  "platforms",
  "socials",
  "followers",
] as const;

const CREATOR_OFFER_VALUES: CreatorOfferType[] = [
  "social",
  "physical",
  "sponsorship",
];

function emptyCreatorOfferDetails(
  offer: CreatorOfferType = "social",
): CreatorOfferDetails {
  return {
    title: "",
    format: "",
    price: null,
    price_unit: defaultCreatorPriceUnit(offer),
    description: "",
    priceMax: null,
    spaceKind: "",
    streetAddress: "",
    location_area: "",
    spaceSize: "",
    surfaces: [],
    installBy: "",
    traffic: "",
    trafficCount: null,
    availability: "",
    orgKind: "",
    orgOther: "",
    surfaceOther: "",
    reach: "",
    reachCount: null,
    funding: "",
    benefits: [],
    season: "",
    tiers: [emptyTier("Gold")],
  };
}

function emptyCreatorOfferDetailsMap() {
  return CREATOR_OFFER_VALUES.reduce(
    (map, offer) => {
      map[offer] = emptyCreatorOfferDetails(offer);
      return map;
    },
    {} as Record<CreatorOfferType, CreatorOfferDetails>,
  );
}

function emptyCreatorOfferTouched() {
  return CREATOR_OFFER_VALUES.reduce(
    (map, offer) => {
      map[offer] = { title: false, description: false };
      return map;
    },
    {} as Record<CreatorOfferType, CreatorOfferTouched>,
  );
}

function cloneCreatorOfferDetails(
  details: CreatorOfferDetails,
): CreatorOfferDetails {
  return {
    ...details,
    surfaces: [...details.surfaces],
    benefits: [...details.benefits],
    tiers: details.tiers.map((tier) => ({
      ...tier,
      benefits: [...tier.benefits],
    })),
  };
}

function selectedCreatorOffers(
  answers: Pick<OnboardingAnswers, "creatorOffers" | "creatorOffer">,
) {
  const selected = Array.isArray(answers.creatorOffers)
    ? answers.creatorOffers.filter((offer): offer is CreatorOfferType =>
        CREATOR_OFFER_VALUES.includes(offer),
      )
    : [];
  const unique = Array.from(new Set(selected));
  if (unique.length) return unique;
  return answers.creatorOffer &&
    CREATOR_OFFER_VALUES.includes(answers.creatorOffer)
    ? [answers.creatorOffer]
    : [];
}

function creatorOfferDetailsFromAnswers(
  answers: OnboardingAnswers,
): CreatorOfferDetails {
  return {
    title: answers.title,
    format: answers.format,
    price: answers.price,
    price_unit: answers.price_unit,
    description: answers.description,
    priceMax: answers.priceMax,
    spaceKind: answers.spaceKind,
    streetAddress: answers.streetAddress,
    location_area: answers.location_area,
    spaceSize: answers.spaceSize,
    surfaces: [...answers.surfaces],
    installBy: answers.installBy,
    traffic: answers.traffic,
    trafficCount: answers.trafficCount,
    availability: answers.availability,
    orgKind: answers.orgKind,
    orgOther: answers.orgOther,
    surfaceOther: answers.surfaceOther,
    reach: answers.reach,
    reachCount: answers.reachCount,
    funding: answers.funding,
    benefits: [...answers.benefits],
    season: answers.season,
    tiers: answers.tiers.map((tier) => ({
      ...tier,
      benefits: [...tier.benefits],
    })),
  };
}

function creatorOfferView(
  answers: OnboardingAnswers,
  offer: CreatorOfferType,
): OnboardingAnswers {
  const stored = answers.creatorOfferDetails?.[offer];
  const details =
    answers.creatorOffer === offer
      ? creatorOfferDetailsFromAnswers(answers)
      : stored
        ? cloneCreatorOfferDetails(stored)
        : emptyCreatorOfferDetails(offer);
  return {
    ...answers,
    ...details,
    creatorOffer: offer,
    creatorOffers: [offer],
  };
}

/**
 * Keep a location useful for proximity without keeping an exact device pin.
 * Two decimal places gives a city-level approximation; the public profile
 * still only exposes the member's typed city string.
 */
function normalizeLocationPoint(value: unknown): LocationPoint | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { latitude?: unknown; longitude?: unknown };
  if (raw.latitude == null || raw.longitude == null) return null;
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return {
    latitude: Number(latitude.toFixed(2)),
    longitude: Number(longitude.toFixed(2)),
  };
}

function locationPointFromProfile(
  source: Pick<Profile, "location_latitude" | "location_longitude">,
) {
  return normalizeLocationPoint({
    latitude: source.location_latitude,
    longitude: source.location_longitude,
  });
}

function normalizeOnboardingAnswers(
  raw: Partial<OnboardingAnswers> | undefined,
): OnboardingAnswers {
  const merged = { ...emptyAnswers(), ...(raw ?? {}) } as OnboardingAnswers;
  const details = emptyCreatorOfferDetailsMap();
  const rawDetails = raw?.creatorOfferDetails;
  for (const offer of CREATOR_OFFER_VALUES) {
    const supplied = rawDetails?.[offer];
    details[offer] = supplied
      ? {
          ...emptyCreatorOfferDetails(offer),
          ...supplied,
          surfaces: [...(supplied.surfaces ?? [])],
          benefits: [...(supplied.benefits ?? [])],
          tiers: (supplied.tiers ?? [emptyTier("Gold")]).map((tier) => ({
            ...emptyTier("Gold"),
            ...tier,
            benefits: [...(tier.benefits ?? [])],
          })),
        }
      : details[offer];
  }
  const active =
    merged.creatorOffer && CREATOR_OFFER_VALUES.includes(merged.creatorOffer)
      ? merged.creatorOffer
      : "";
  // Drafts saved before the per-offer map existed still have their active
  // fields at the root. Preserve them as the first selected offer rather than
  // making the member retype the listing.
  if (active && !rawDetails?.[active]) {
    details[active] = creatorOfferDetailsFromAnswers(merged);
  }
  const touched = emptyCreatorOfferTouched();
  for (const offer of CREATOR_OFFER_VALUES) {
    touched[offer] = {
      ...touched[offer],
      ...(raw?.creatorOfferTouched?.[offer] ?? {}),
    };
  }
  const location = normalizeLocationPoint(raw?.location);
  return {
    ...merged,
    location,
    creatorOffers: selectedCreatorOffers(merged),
    creatorOfferDetails: details,
    creatorOfferTouched: touched,
  };
}

/**
 * Whether a role switch would throw away work.
 *
 * Derived by diffing against emptyAnswers() rather than checking a hand-kept
 * list of fields, so a question added to a role pane is covered the day it
 * lands instead of the day somebody remembers this function exists.
 */
function roleAnswersFilled(answers: OnboardingAnswers) {
  const blank = emptyAnswers();
  const kept = new Set<string>(ROLE_SWITCH_KEEPS);
  return (Object.keys(blank) as Array<keyof OnboardingAnswers>).some(
    (key) =>
      !kept.has(key) &&
      JSON.stringify(answers[key]) !== JSON.stringify(blank[key]),
  );
}

/** The answers to start a different role's flow with. */
function answersForNewRole(current: OnboardingAnswers): OnboardingAnswers {
  const next = emptyAnswers();
  for (const key of ROLE_SWITCH_KEEPS) {
    // Same list the confirm prompt measures against, so what is kept and what
    // is counted as lost can never disagree.
    (next[key] as unknown) = current[key];
  }
  return next;
}

function emptyAnswers(): OnboardingAnswers {
  return {
    display_name: "",
    city: "",
    location: null,
    bio: "",
    handle: "",
    contact_name: "",
    contact_email: "",
    platforms: [],
    socials: {},
    followers: null,
    creatorOffer: "",
    creatorOffers: [],
    creatorOfferDetails: emptyCreatorOfferDetailsMap(),
    creatorOfferTouched: emptyCreatorOfferTouched(),
    title: "",
    format: "",
    price: null,
    price_unit: "",
    description: "",
    categories: [],
    spaceKind: "",
    streetAddress: "",
    location_area: "",
    spaceSize: "",
    surfaces: [],
    installBy: "",
    traffic: "",
    trafficCount: null,
    availability: "",
    goals: [],
    placements: [],
    deliverables: "",
    artwork: "",
    timing: "",
    promoting: "",
    briefScope: "",
    priceMax: null,
    targetPlatforms: [],
    wantedArea: "",
    businessSetupPath: "",
    orgKind: "",
    orgOther: "",
    surfaceOther: "",
    reach: "",
    reachCount: null,
    funding: "",
    benefits: [],
    season: "",
    // No price. "Gold" and "1000" survive as PLACEHOLDERS on the inputs, so
    // the shape is obvious, but firstTierProblem's !tier.price branch forces a
    // real decision - the old seed published an invented $1,000 for anyone who
    // skipped past it.
    tiers: [emptyTier("Gold")],
  };
}

/** A blank level, prefilled with a name so the first one is not work. */
function emptyTier(name: string): SponsorTier {
  return { name, price: null, priceMax: null, slots: null, benefits: [] };
}

/**
 * The names offered as levels are added, in the order a team would add them.
 *
 * Downward: the first tier a host writes is their top one. The `price` these
 * used to carry was never read - emptyTier was called with null - so it is
 * gone; PRICE_CHIPS.sponsor_host is what actually suggests a number now.
 */
const TIER_PRESETS = ["Gold", "Silver", "Bronze", "Supporter", "Friend"];

/**
 * How many levels a sponsorship can publish.
 *
 * Was `TIER_PRESETS.length`, which made the ceiling on what a team may offer
 * an accident of how many nice names happened to be in a list - three - and
 * plenty of teams run four or five. Now it is a number chosen for its own
 * reason: past five, a business scrolling the marketplace is reading one
 * team's price list rather than browsing.
 */
const MAX_TIERS = 5;

/**
 * Which flow an invited business lands in.
 *
 * The outreach queue already made this call when it decided what to write to
 * them: a SUPPLY prospect was emailed about renting out their own space, a
 * DEMAND one about running a campaign. Asking them to pick a role again is
 * asking a question we answered before we hit send.
 *
 * Still a pick, not a lock - the picker is on screen and they can change it.
 */
/** Only a uuid is ever put back into a redirect URL. */
const UUID_PARAM =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function activeBusinessReferralCode(propValue = "") {
  const urlValue =
    typeof window === "undefined"
      ? ""
      : new URLSearchParams(window.location.search).get("ref") ?? "";
  const candidate = propValue || urlValue;
  return isBusinessReferralCode(candidate)
    ? normalizeBusinessReferralCode(candidate)
    : "";
}

function authNextPath(referralCode = "") {
  const query = new URLSearchParams();
  const params = new URLSearchParams(window.location.search);
  const inviteToken = params.get("p") ?? "";
  if (UUID_PARAM.test(inviteToken)) query.set("p", inviteToken);
  const activeReferral = activeBusinessReferralCode(referralCode);
  if (activeReferral) query.set("ref", activeReferral);
  const preserved = query.toString();
  return preserved ? `/?${preserved}` : "/dashboard";
}

function inviteRole(invite: Invite): Role {
  return invite.intent === "SUPPLY" ? "creator" : "business";
}

/**
 * The onboarding answers an invite link can fill in for someone.
 *
 * Only the three things we are actually sure of, all of them already on the
 * business's own website: their name, their town, and which side of the
 * marketplace we approached them about. Not their bio, not their category
 * chips, not a price - the whole point of the last week's work was to stop the
 * flow publishing sentences nobody wrote, and a prefill that invents a
 * description would be the worst offender yet.
 *
 * The city gains a state because every prospect is Californian and the plain
 * town name would fragment the market filter - "Brea", "Brea, CA" and
 * "brea, CA" are already three separate filters in live data.
 */
function prefillFromInvite(invite: Invite): OnboardingAnswers {
  const base = emptyAnswers();
  const city = invite.city.trim();
  return {
    ...base,
    display_name: invite.business.trim(),
    city: city ? (city.includes(",") ? city : `${city}, CA`) : "",
  };
}

/** Seed the answers from a stored profile so re-entry is not a blank form. */
function answersFromProfile(
  source: Profile | null,
  invite?: Invite | null,
): OnboardingAnswers {
  // No stored profile means this is first-run setup, which is the only time an
  // invite is relevant. Routing the prefill through here rather than through
  // the initial useState means every path that reseeds - including
  // seedRolePickers(null) - keeps it, and a real profile always wins.
  const base = !source && invite ? prefillFromInvite(invite) : emptyAnswers();
  if (!source) return base;
  const storedCreatorOffer =
    source.creator_offer === "social" ||
    source.creator_offer === "physical" ||
    source.creator_offer === "sponsorship"
      ? source.creator_offer
      : "";
  const storedCreatorOffers = Array.from(
    new Set(
      (Array.isArray(source.creator_offers) ? source.creator_offers : []).filter(
        (offer): offer is CreatorOfferType =>
          CREATOR_OFFER_VALUES.includes(offer),
      ),
    ),
  );
  const creatorOffers = storedCreatorOffers.length
    ? storedCreatorOffers
    : storedCreatorOffer
      ? [storedCreatorOffer]
      : [];
  return normalizeOnboardingAnswers({
    ...base,
    creatorOffer:
      creatorOffers[0] || storedCreatorOffer || creatorOfferForRole(source.role),
    creatorOffers,
    display_name: source.display_name ?? "",
    city: source.city ?? "",
    location: locationPointFromProfile(source),
    bio: source.bio ?? "",
    handle: source.handle ?? "",
    contact_name: source.contact_name ?? "",
    contact_email: source.contact_email ?? "",
    categories: source.categories ?? [],
    followers: source.followers || null,
    socials: Object.fromEntries(
      Object.entries(source.social_links ?? {}).map(([key, value]) => [
        key,
        String(value ?? ""),
      ]),
    ),
    platforms: Object.entries(source.social_links ?? {})
      .filter(([, value]) => Boolean(value))
      .map(([key]) => key),
  });
}

/** A date N days from today, as the YYYY-MM-DD a `date` column wants. */
function isoDaysFromToday(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

/** "a, b and c" - used wherever chips become a sentence fragment. */
function joinList(items: string[]) {
  const clean = items.filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? "";
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

/**
 * Space owners and sponsorship hosts are legacy profile roles. Their inventory
 * now lives under Creator, but old rows still need their original listing
 * shape until a member edits or republishes them.
 */
function creatorOfferForRole(
  role: Role | null | undefined,
  answers?: Pick<OnboardingAnswers, "creatorOffer" | "creatorOffers">,
): "" | CreatorOfferType {
  if (role === "space_owner") return "physical";
  if (role === "sponsor_host") return "sponsorship";
  if (role === "creator") {
    return (
      answers?.creatorOffers?.[0] ||
      answers?.creatorOffer ||
      "social"
    );
  }
  return "";
}

function isPhysicalOffer(role: Role, answers: OnboardingAnswers) {
  return creatorOfferForRole(role, answers) === "physical";
}

function isSponsorshipOffer(role: Role, answers: OnboardingAnswers) {
  return creatorOfferForRole(role, answers) === "sponsorship";
}

/**
 * The slice of the Web Speech API the notes box uses. Chrome, Safari and Edge
 * ship it (Chrome under the webkit prefix); Firefox does not, so the mic is
 * hidden there. Typed by hand because lib.dom only declares it in some TS
 * versions. Recognition runs in the browser - no key, no request from us.
 */
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Notes box cap, matching the server: typed words plus a transcript. */
const AI_NOTES_MAX = 1200;
/**
 * Form fields sent back with a second Fill so the model improves what is
 * there instead of starting over - including anything the owner edited.
 */
const CURRENT_DRAFT_FIELDS = [
  "title",
  "format",
  "description",
  "demographics",
  "space_size",
  "availability_notes",
  "minimum_booking",
  "deliverables",
] as const;

/** Longest voice note the recorder path takes; the server caps the bytes too. */
const RECORDING_MAX_MS = 60_000;

/**
 * Whether the built-in recogniser is worth trying. Brave ships Chromium's
 * API surface with Google's speech service switched off: start() succeeds,
 * then a "network" error ends the session with no words. Record there.
 */
function speechRecognitionUsable() {
  if (typeof navigator === "undefined") return false;
  if ((navigator as { brave?: unknown }).brave) return false;
  return Boolean(speechRecognitionCtor());
}

/**
 * A container this browser can record and the server can read. Null when
 * the browser cannot record at all; empty when it can but names no type it
 * supports, in which case the recorder picks its own.
 */
function recordingMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Re-encode a photo as a modest JPEG before sending it for an AI draft.
 *
 * Phones hand over 4-12 MB HEIC-turned-JPEGs. Vercel caps a function's request
 * body at 4.5 MB and base64 adds a third on top, so the original cannot be
 * posted as-is - and the model needs nowhere near that many pixels to see a
 * window. 1280 px on the long edge at 0.85 lands around 200-400 KB.
 */
async function photoToJpegBase64(file: Blob, maxEdge = 1280): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("That photo could not be read."));
      element.src = url;
    });
    const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("That photo could not be read.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return dataUrl.slice(dataUrl.indexOf(",") + 1);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A recording straight out of MediaRecorder - an in-browser screen or camera
 * recorder - carries no length in its header, so duration reads Infinity
 * until the browser has seen the end of the file. Seeking past the end makes
 * it look, and durationchange follows with the real number. Phone videos
 * never need this; it is over in a moment for the ones that do.
 */
async function settleDuration(video: HTMLVideoElement) {
  if (Number.isFinite(video.duration)) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      video.removeEventListener("durationchange", onChange);
      resolve();
    };
    const onChange = () => {
      if (Number.isFinite(video.duration)) done();
    };
    const timer = window.setTimeout(done, 8_000);
    video.addEventListener("durationchange", onChange);
    video.currentTime = 1e101;
  });
}

/** Every 360 camera and phone panorama mode exports equirectangular: exactly twice as wide as tall. */
function looksSpherical(width: number, height: number) {
  return width > 0 && height > 0 && Math.abs(width / height - 2) < 0.06;
}

type TourProbe = { kind: "video" | "photo"; width: number; height: number; seconds: number };

/**
 * Size and shape of a picked walkthrough file, read in the browser before
 * anything uploads: video or photo, its pixels (a 2:1 frame is almost
 * certainly a 360 file) and, for a video, its length. Rejects a video this
 * browser cannot decode, which is the earliest anyone can be told that an
 * HEVC .mov will not play for most visitors.
 */
async function probeTourFile(file: File): Promise<TourProbe> {
  const url = URL.createObjectURL(file);
  try {
    if (TOUR_PHOTO_TYPES.includes(file.type)) {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("That photo could not be read."));
        element.src = url;
      });
      return { kind: "photo", width: image.naturalWidth, height: image.naturalHeight, seconds: 0 };
    }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(
          () => reject(new Error("That video took too long to read. Try a shorter clip.")),
          20_000,
        );
        video.onloadedmetadata = () => {
          window.clearTimeout(timer);
          resolve();
        };
        video.onerror = () => {
          window.clearTimeout(timer);
          reject(
            new Error(
              "That video could not be played here. Export it as MP4 (H.264) - on an iPhone, \"Most Compatible\" - and try again.",
            ),
          );
        };
        video.src = url;
      });
      await settleDuration(video);
      return {
        kind: "video",
        width: video.videoWidth,
        height: video.videoHeight,
        seconds: Number.isFinite(video.duration) ? video.duration : 0,
      };
    } finally {
      video.removeAttribute("src");
      video.load();
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Stills from a walkthrough video for Fill with AI: evenly spaced through
 * the clip, small JPEGs. The model needs a handful of frames to see how a
 * space is laid out, not the whole file, and Vercel caps a request body at
 * 4.5 MB. A saved walkthrough is read straight from the bucket, which
 * answers with access-control-allow-origin: *, so the canvas stays readable.
 */
async function videoStills(
  source: Blob | string,
  count = TOUR_FRAMES,
  maxEdge = TOUR_FRAME_EDGE,
): Promise<string[]> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  if (typeof source === "string") video.crossOrigin = "anonymous";
  // In the document, out of sight: iOS has painted black frames from a video
  // that was never attached anywhere.
  video.style.cssText = "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(video);
  const url = typeof source === "string" ? source : URL.createObjectURL(source);
  const until = (event: string, ms: number) =>
    new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        window.clearTimeout(timer);
        video.removeEventListener(event, done);
        video.removeEventListener("error", failed);
        if (error) reject(error);
        else resolve();
      };
      const done = () => finish();
      const failed = () => finish(new Error("That video could not be read."));
      const timer = window.setTimeout(
        () => finish(new Error("The video took too long to read.")),
        ms,
      );
      video.addEventListener(event, done);
      video.addEventListener("error", failed);
    });
  try {
    const loaded = until("loadedmetadata", 20_000);
    video.src = url;
    await loaded;
    await settleDuration(video);
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!duration || !video.videoWidth) return [];
    const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return [];
    // A three-second clip has two distinct moments in it, not six.
    const wanted = Math.max(1, Math.min(count, Math.ceil(duration / 2)));
    const stills: string[] = [];
    for (let index = 0; index < wanted; index += 1) {
      const seeked = until("seeked", 15_000);
      video.currentTime = Math.min(
        duration * ((index + 0.5) / wanted),
        Math.max(0, duration - 0.1),
      );
      await seeked;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      stills.push(dataUrl.slice(dataUrl.indexOf(",") + 1));
    }
    return stills;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    if (typeof source !== "string") URL.revokeObjectURL(url);
  }
}

function defaultCreatorPriceUnit(offer: CreatorOfferType) {
  return offer === "physical" ? "week" : "post";
}

function creatorPricePresets(offer: "" | CreatorOfferType) {
  return offer === "physical" ? PRICE_CHIPS.space_owner : PRICE_CHIPS.creator;
}

/** A legacy role is still allowed in stored data, but reads as Creator now. */
function canonicalRole(role: Role): Role {
  return role === "space_owner" || role === "sponsor_host" ? "creator" : role;
}

/**
 * The reach number and its unit.
 *
 * Returns null when the member said "Not sure" so the caller can leave whatever
 * they already had. Publishing 0 would put "0 people a day" on their card,
 * which is a claim they never made.
 */
function deriveReach(
  role: Role,
  answers: OnboardingAnswers,
): { avg_views: number | null; reach_unit: string | null } {
  if (isPhysicalOffer(role, answers)) {
    // The typed count wins. The chips are shortcuts that fill it in, so an
    // owner who knows their real number is never overruled by a bracket.
    const count = answers.trafficCount ?? null;
    if (!count || count < 1) return { avg_views: null, reach_unit: null };
    return { avg_views: count, reach_unit: "people a day" };
  }
  if (isSponsorshipOffer(role, answers)) {
    const chip = SPONSOR_REACH_CHIPS.find((item) => item.label === answers.reach);
    const count = answers.reachCount ?? null;
    if (!count || count < 1) return { avg_views: null, reach_unit: null };
    // The chip still decides the UNIT - a season and an event are different
    // things - but the number is whatever they typed.
    return { avg_views: count, reach_unit: chip?.unit || "people a season" };
  }
  return { avg_views: null, reach_unit: null };
}

/**
 * The human sentence for a space's foot traffic.
 *
 * Prefers the chip's own copy, but only while the count still matches it: the
 * moment an owner types their real number, "About 300 people a day, mostly
 * local regulars" stops being true and a plain sentence takes over.
 */
function trafficSentence(answers: OnboardingAnswers): string {
  const chip = TRAFFIC_CHIPS.find((item) => item.label === answers.traffic);
  const count = answers.trafficCount ?? null;
  if (chip && chip.count !== null && chip.count === count) return chip.sentence;
  if (!count || count < 1) return "";
  return `About ${count.toLocaleString("en-US")} people walk past on a normal day.`;
}

/**
 * The human sentence for a sponsorship host's reach.
 *
 * Keeps the chip's copy while the count still matches it, and falls back to a
 * plain sentence the moment a team types their own number.
 */
function reachSentence(answers: OnboardingAnswers): string {
  const chip = SPONSOR_REACH_CHIPS.find((item) => item.label === answers.reach);
  const count = answers.reachCount ?? null;
  if (chip && chip.count !== null && chip.count === count) return chip.sentence;
  if (!count || count < 1) return "";
  const unit = chip?.unit || "people a season";
  return `Around ${count.toLocaleString("en-US")} ${unit}.`;
}

/**
 * The prefilled body copy for the listing.
 *
 * These are drafts in a real editable textarea, not fixed strings. Every branch
 * is written to clear the 60 characters `listingIsReady` requires, because a
 * listing that fails that check is sunk below every complete one by
 * `listingRank` - a flow that publishes thin rows is a flow that publishes rows
 * nobody sees.
 */
function composeDescription(role: Role, answers: OnboardingAnswers): string {
  const bio = answers.bio.trim();
  const city = answers.city.trim();
  if (creatorOfferForRole(role, answers) === "social") {
    const platforms = answers.platforms
      .map((key) => socialPlatforms.find((p) => p.key === key)?.label ?? key)
      .filter(Boolean);
    return [
      bio,
      platforms.length ? `I post mostly on ${joinList(platforms)}.` : "",
      answers.format ? `This offer is ${formatOffer(answers.format)}.` : "",
      answers.categories.length
        ? `It suits ${joinList(answers.categories.map((c) => c.toLowerCase()))} brands${city ? ` around ${city}` : ""}.`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (isPhysicalOffer(role, answers)) {
    const where = answers.location_area.trim() || city;
    const size = answers.spaceSize.trim();
    const install = INSTALL_CHIPS.find(
      (item) => item.value === answers.installBy,
    );
    return [
      answers.spaceKind ? `${answers.spaceKind}${where ? ` in ${where}` : ""}.` : "",
      // The one line they wrote about themselves in step 1 was collected,
      // required, and then never reached any rendered sentence for this role.
      bio,
      size ? `It is about ${size}.` : "",
      trafficSentence(answers),
      // What can go up is now ANSWERED, not asserted. The old draft told every
      // owner's readers it "suits a poster, a decal, or a printed card" and
      // that the owner would put it up - two offers they never made.
      resolvedSurfaces(answers).length
        ? `It works for ${joinList(
            resolvedSurfaces(answers).map((item) => item.toLowerCase()),
          )}.`
        : "",
      install?.sentence ?? "",
      // The chip's own sentence, not the chip's label bolted onto a colon.
      // "Availability: available now." is not something a person writes.
      AVAILABILITY_CHIPS.find((item) => item.label === answers.availability)
        ?.sentence ?? "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (role === "business") {
    const goalSentences = BUSINESS_GOAL_CHIPS.filter((item) =>
      answers.goals.includes(item.label),
    )
      .map((item) => item.sentence)
      .join(" ");
    const artwork =
      answers.artwork === "supply"
        ? "We'll supply the artwork."
        : answers.artwork === "help"
          ? "We'd want help making the artwork."
          : "";
    return [
      answers.promoting.trim()
        ? `We're promoting ${answers.promoting.trim()}.`
        : "",
      goalSentences,
      bio,
      // Where they want SPACE, not where they happen to be - a Brea business
      // can be briefing for a window in Long Beach - and only when the brief
      // asks for physical space at all.
      answers.placements.length && answers.briefScope !== "virtual"
        ? `We're looking for ${joinList(
            answers.placements.map((p) => p.toLowerCase()),
          )}${
            answers.wantedArea.trim() || city
              ? ` around ${answers.wantedArea.trim() || city}`
              : ""
          }.`
        : "",
      // A band, said as a band. "Our budget is $150" was false for every
      // business that picked a range.
      answers.price
        ? `Our budget is ${priceLabel({
            price_cents: dollarsToCents(answers.price),
            price_max_cents:
              answers.priceMax == null ? null : dollarsToCents(answers.priceMax),
          })}.`
        : "",
      artwork,
      BUSINESS_TIMING_CHIPS.find((item) => item.label === answers.timing)
        ?.sentence ?? "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (isSponsorshipOffer(role, answers)) {
    const funding = answers.funding.trim();
    return [
      orgLabel(answers) ? `${orgLabel(answers)}${city ? ` in ${city}` : ""}.` : "",
      bio,
      // The single most persuasive line a sponsor reads, and the flow used to
      // ask a team for their org type and their reach but never for this.
      funding ? `We're raising for ${funding}.` : "",
      reachSentence(answers),
      SPONSOR_SEASON_CHIPS.find((item) => item.label === answers.season)
        ?.sentence ?? "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return bio;
}

/**
 * The per-tier sentences appended to every sponsorship card.
 *
 * These are deliberately NOT part of the editable draft. They used to be, and
 * the result was a card that listed the perks twice: the textarea showed the
 * whole benefit menu ("Sponsors get logo on jerseys, banner at events and
 * social shoutouts."), the host added a line of their own - which set
 * descriptionTouched - and publish then appended the tier's own perk sentence
 * on top of the copy that already contained one. Keeping the tail out of the
 * body means the host edits only their own words and each tier card still
 * differs, which is the entire point of publishing one card per tier.
 */
/**
 * What can actually go up, with "Something else" replaced by what they typed.
 *
 * Everywhere the list is written - listings.deliverables, the "It works for X"
 * sentence, the validator - goes through here, so the placeholder chip never
 * reaches a card as the name of a surface.
 */
function resolvedSurfaces(answers: OnboardingAnswers) {
  const typed = answers.surfaceOther.trim();
  return answers.surfaces
    .map((item) => (item === SURFACE_OTHER ? typed : item))
    .filter(Boolean);
}

/**
 * What this organisation calls itself, in its own words where it gave them.
 *
 * Everywhere the org type is written - the opening sentence of the
 * description, profiles.categories, the validator - goes through here, so
 * "Something else" never reaches a card.
 */
function orgLabel(answers: OnboardingAnswers) {
  return answers.orgKind === SPONSOR_ORG_OTHER
    ? answers.orgOther.trim()
    : answers.orgKind;
}

function tierSentences(answers: OnboardingAnswers, tier?: SponsorTier) {
  const perks = orderedBenefits(
    tier?.benefits.length ? tier.benefits : answers.benefits,
  );
  return [
    perks.length
      ? `${tier?.name.trim() ? `${tier.name.trim()} sponsors get` : "Sponsors get"} ${joinList(
          perks.map((b) => b.toLowerCase()),
        )}.`
      : "",
    tier?.slots ? `Room for ${tier.slots} at this level.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The longest title a listing carries, and the one place that decides it.
 *
 * The title INPUT has always carried maxLength={120}, so a typed title cannot
 * exceed this. A COMPOSED one could: publish did `.slice(0, 120)` while the
 * preview rendered the untrimmed string, so a team whose name is long saw one
 * headline on screen and published another, cut mid-word:
 *
 *   preview   Brea Olinda High School Competitive Robotics Team 4414 — Gold
 *             sponsor for the championship trip to Houston and new competition kit
 *   published ... for the championship trip to Houston and new compe
 *
 * A sponsorship host has no title input at all, so there was nowhere to fix it.
 */
const TITLE_MAX = 120;

/** Trim to the cap on a word boundary, and say that it was trimmed. */
function fitTitle(text: string) {
  const clean = text.trim();
  if (clean.length <= TITLE_MAX) return clean;
  const cut = clean.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  // Only break at a space if one falls late enough to leave a real title;
  // a single 200-character word still has to be cut somewhere.
  const kept = space > TITLE_MAX * 0.6 ? cut.slice(0, space) : cut;
  return `${kept.trimEnd()}…`;
}

/** The suggested `title`, regenerated as the answers that feed it change. */
function composeTitle(
  role: Role,
  answers: OnboardingAnswers,
  tier?: SponsorTier,
): string {
  const name = answers.display_name.trim();
  const city = answers.city.trim();
  if (isPhysicalOffer(role, answers)) {
    if (!answers.spaceKind) return "";
    // "Window, Brea" was the weakest title of the four roles: two windows in
    // one town produced a byte-identical headline and neither said whose it
    // was. Lead with the name, the way a business brief now does.
    const where = answers.location_area.trim() || city;
    const kind = answers.spaceKind.toLowerCase();
    if (name) return where ? `${name} — ${kind} in ${where}` : `${name} — ${kind}`;
    return where ? `${answers.spaceKind}, ${where}` : answers.spaceKind;
  }
  if (creatorOfferForRole(role, answers) === "social") {
    const primary = answers.platforms[0];
    const label = socialPlatforms.find((p) => p.key === primary)?.label;
    if (!label) return name;
    return name ? `${label} — ${name}` : label;
  }
  if (role === "business") {
    // Prefer the thing they are actually promoting. "Brea Coffee Bar - our new
    // cold brew" tells a creator what the job is; "- August campaign" does not.
    const what = answers.promoting.trim();
    if (name && what) return `${name} — ${what}`;
    const month = new Intl.DateTimeFormat("en", { month: "long" }).format(
      new Date(),
    );
    return name ? `${name} — ${month} campaign` : "";
  }
  if (isSponsorshipOffer(role, answers)) {
    if (!name) return "";
    // Every team used to get the identical "- season sponsor", so two teams
    // in one town were indistinguishable and the same team relisting next
    // year produced a byte-identical headline. The tier separates the levels;
    // what they are raising for separates the seasons.
    const level = tier?.name.trim();
    const head = level ? `${name} — ${level} sponsor` : `${name} — season sponsor`;
    const funding = answers.funding.trim();
    if (!funding) return head;
    // What they are raising for is the part worth dropping when the whole
    // thing will not fit: cutting it loses a clause, cutting the other end
    // loses the team's own name.
    const full = `${head} for ${funding}`;
    return full.length <= TITLE_MAX ? full : head;
  }
  return "";
}

/**
 * What the title field actually contains.
 *
 * Display, validation and publish MUST agree on this. They used to differ: the
 * field rendered `touched ? answers.title : composeTitle(...)` while publish
 * used `answers.title.trim() || composeTitle(...)`. So a member who typed a
 * title and then cleared it saw an empty box and published the generated one -
 * and a business that deleted its description specifically to keep the budget
 * off the card published the budget anyway.
 *
 * Untouched means "show them the draft and mean it". Touched means the words
 * are theirs, including when they are none.
 */
function effectiveTitle(
  role: Role,
  answers: OnboardingAnswers,
  touched: { title: boolean },
  tier?: SponsorTier,
) {
  // A sponsorship host never edits one title - each tier composes its own -
  // so an edited `title` must not overwrite all three.
  //
  // fitTitle here rather than at the publish call, so the preview, the
  // validator and the insert cannot disagree about the headline: the cap is
  // applied once, to the value all three read.
  if (isSponsorshipOffer(role, answers)) {
    return fitTitle(composeTitle(role, answers, tier));
  }
  return fitTitle(
    touched.title ? answers.title : composeTitle(role, answers),
  );
}

function effectiveDescription(
  role: Role,
  answers: OnboardingAnswers,
  touched: { description: boolean },
  tier?: SponsorTier,
) {
  const body = descriptionBody(role, answers, touched);
  if (!isSponsorshipOffer(role, answers)) return body;
  return [body, tierSentences(answers, tier)].filter(Boolean).join(" ");
}

/**
 * Just the member's own words - theirs if they edited, our draft if they did
 * not. This is exactly what the textarea holds, which is why the validator
 * measures THIS and not the published string: the per-tier perk tail would
 * otherwise pad a two-word description past the minimum without the host ever
 * seeing the characters that got them there.
 */
function descriptionBody(
  role: Role,
  answers: OnboardingAnswers,
  touched: { description: boolean },
) {
  return touched.description
    ? answers.description.trim()
    : composeDescription(role, answers).trim();
}

/**
 * The platform a creator's card is filed under.
 *
 * This is the marketplace's primary filter, and it used to be
 * `answers.platforms[0]` - the chip they happened to tap FIRST. A creator
 * whose audience is on TikTok but who tapped Instagram first was filed under
 * Instagram, and worse, a platform picked but left without a handle still set
 * the channel while `socialLinks` dropped it: the card advertised a platform
 * the profile carried no link for.
 *
 * Preferring a platform they actually gave a handle for fixes both, and asks
 * them nothing they were not already being asked.
 */
function creatorChannel(answers: OnboardingAnswers) {
  const withHandle = answers.platforms.find((key) =>
    (answers.socials[key] ?? "").trim(),
  );
  const key = withHandle ?? answers.platforms[0];
  return socialPlatforms.find((p) => p.key === key)?.label ?? "Other";
}

/**
 * The `listings` row a completed onboarding publishes.
 *
 * Every value lands in a column that already exists. `channel` carries no DB
 * CHECK, which is what lets "Sponsorship" ship with no migration - the
 * marketplace's channel chips are derived from live listings, so it gets its
 * own filter automatically. "Business brief" is the existing magic string that
 * isBrief() renders as a Wanted card.
 */
function buildListingDraft(
  role: Role,
  answers: OnboardingAnswers,
  touched: { title: boolean; description: boolean },
  tier?: SponsorTier,
) {
  const base = {
    title: effectiveTitle(role, answers, touched, tier),
    description: effectiveDescription(role, answers, touched, tier),
    price_cents: dollarsToCents(answers.price ?? 0),
    price_max_cents: null as number | null,
    format: answers.format.trim(),
    demographics: "",
    location_area: "",
    street_address: "",
    space_size: "",
    surface_types: [] as string[],
    install_by: null as string | null,
    sponsor_tier: null as string | null,
    sponsor_slots: null as number | null,
    brief_scope: null as string | null,
    target_platforms: [] as string[],
    availability_notes: "",
    available_from: null as string | null,
    available_to: null as string | null,
    deliverables: "",
    channel: "Other",
    price_unit: "campaign",
  };

  if (creatorOfferForRole(role, answers) === "social") {
    return {
      ...base,
      channel: creatorChannel(answers),
      price_unit: answers.price_unit || "post",
    };
  }

  if (isPhysicalOffer(role, answers)) {
    const kind = SPACE_KIND_CHIPS.find((item) => item.label === answers.spaceKind);
    const free = AVAILABILITY_CHIPS.find(
      (item) => item.label === answers.availability,
    );
    const size = answers.spaceSize.trim();
    const unit = answers.price_unit || "week";
    return {
      ...base,
      channel: kind?.channel ?? "Other",
      price_unit: unit,
      price_max_cents:
        answers.priceMax == null ? null : dollarsToCents(answers.priceMax),
      // Falls back to the city they already gave, so this is a real optional
      // field: the placeholder shows what will be used, and clearing it is
      // allowed rather than snapping back under their cursor.
      location_area: answers.location_area.trim() || answers.city.trim(),
      street_address: answers.streetAddress.trim(),
      space_size: size,
      surface_types: resolvedSurfaces(answers),
      install_by: answers.installBy || null,
      deliverables: resolvedSurfaces(answers).join("\n"),
      demographics: trafficSentence(answers),
      availability_notes: answers.availability,
      // A space with no date window cannot be matched to a campaign that runs
      // in October. "Ask me" still writes nothing, because that is the answer.
      available_from:
        free && free.startDays !== null
          ? isoDaysFromToday(free.startDays)
          : null,
      available_to:
        free && free.startDays !== null
          ? isoDaysFromToday(free.startDays + free.days)
          : null,
      format:
        base.format ||
        `${size ? `${size} ` : ""}${(answers.spaceKind || "space").toLowerCase()} for a ${unit}`,
    };
  }

  if (role === "business") {
    const timing = BUSINESS_TIMING_CHIPS.find(
      (item) => item.label === answers.timing,
    );
    const scope = answers.briefScope || null;
    // What the card reads after "Looking for". A physical-only brief must not
    // advertise platforms it never asked about, and vice versa.
    const wants = briefWantsLine(
      scope !== "virtual" ? answers.placements : [],
      scope !== "physical" ? answers.targetPlatforms : [],
    );
    return {
      ...base,
      channel: "Business brief",
      price_unit: "campaign",
      format: wants,
      deliverables: answers.deliverables.trim(),
      brief_scope: scope,
      target_platforms: scope !== "physical" ? answers.targetPlatforms : [],
      // Where they want the space, which is not necessarily where they are.
      location_area:
        scope !== "virtual"
          ? answers.wantedArea.trim() || answers.city.trim()
          : "",
      price_max_cents:
        answers.priceMax == null ? null : dollarsToCents(answers.priceMax),
      availability_notes: answers.timing,
      available_from: timing ? isoDaysFromToday(0) : null,
      available_to: timing ? isoDaysFromToday(timing.days) : null,
    };
  }

  if (isSponsorshipOffer(role, answers)) {
    const season = SPONSOR_SEASON_CHIPS.find(
      (item) => item.label === answers.season,
    );
    const perks = tier?.benefits.length ? tier.benefits : answers.benefits;
    return {
      ...base,
      channel: "Sponsorship",
      // The form promised "per sponsor" while the card rendered "/ partner",
      // on the same screen. One word, and the form's was the honest one.
      price_unit: "sponsor",
      price_cents: dollarsToCents(tier?.price ?? answers.price ?? 0),
      price_max_cents:
        tier?.priceMax == null ? null : dollarsToCents(tier.priceMax),
      sponsor_tier: tier?.name.trim() || null,
      sponsor_slots: tier?.slots ?? null,
      format: sponsorOfferLine(perks),
      deliverables: orderedBenefits(perks).join("\n"),
      demographics: reachSentence(answers),
      availability_notes: answers.season,
      available_from: season ? isoDaysFromToday(0) : null,
      available_to: season ? isoDaysFromToday(season.days) : null,
    };
  }

  return base;
}

/**
 * Every listings row this onboarding publishes.
 *
 * One for every role except a sponsorship host, who publishes one card PER
 * TIER - which is the whole point: a business browsing can find the level it
 * can afford instead of one bundled price that fits nobody.
 */
function buildListingDrafts(
  role: Role,
  answers: OnboardingAnswers,
  touched: { title: boolean; description: boolean },
) {
  if (canonicalRole(role) === "creator") {
    const offers = selectedCreatorOffers(answers);
    return offers.flatMap((offer) => {
      const view = creatorOfferView(answers, offer);
      const offerTouched =
        offer === answers.creatorOffer
          ? touched
          : answers.creatorOfferTouched?.[offer] ?? {
              title: false,
              description: false,
            };
      if (!isSponsorshipOffer("creator", view)) {
        return [buildListingDraft("creator", view, offerTouched)];
      }
      const tiers = completeTiers(view);
      return tiers.length
        ? tiers.map((tier) =>
            buildListingDraft("creator", view, offerTouched, tier),
          )
        : [buildListingDraft("creator", view, offerTouched)];
    });
  }
  if (!isSponsorshipOffer(role, answers)) {
    return [buildListingDraft(role, answers, touched)];
  }
  const tiers = completeTiers(answers);
  if (!tiers.length) return [buildListingDraft(role, answers, touched)];
  return tiers.map((tier) => buildListingDraft(role, answers, touched, tier));
}

/**
 * The first thing wrong with any tier, as [message, data-field].
 *
 * Walks tiers in the order they render so an error scrolls forward. Every
 * message names the level by number, because "Set a price" is useless when
 * three price inputs are on screen.
 */
/**
 * Everything still missing from the tiers, in the order the cards sit.
 *
 * Returns the whole list rather than the first problem so the flow can tell a
 * host how much is left instead of bouncing them from one field to the next,
 * one press of Publish at a time. Every message falls back to "tier 1" when
 * the level has no name yet - the old short-circuit meant the name was always
 * filled in by the time the others could fire, and collecting them all would
 * otherwise produce "Set what one  sponsor pays."
 */
function tierProblems(answers: OnboardingAnswers, t: Translate = translateEnglish): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < answers.tiers.length; i += 1) {
    const tier = answers.tiers[i];
    const label = t("app.tierNumber", { number: i + 1 });
    const named = tier.name.trim() || label.toLowerCase();
    if (!tier.name.trim()) {
      out.push([t("app.nameTier", { tier: label }), `tierName${i}`]);
    }
    if (!tier.price || tier.price < 1) {
      out.push([t("app.setTierPrice", { tier: named }), `tierPrice${i}`]);
    }
    // listings_price_max_valid rejects this at the database, where it surfaces
    // as a generic "something went wrong".
    if (
      typeof tier.priceMax === "number" &&
      typeof tier.price === "number" &&
      tier.priceMax < tier.price
    ) {
      out.push([
        t("app.tierUpperPriceBelowLower", { tier: named }),
        `tierPriceMax${i}`,
      ]);
    }
    if (!tier.benefits.length) {
      out.push([
        t("app.pickTierBenefits", { tier: named }),
        `tierBenefits${i}`,
      ]);
    }
  }
  // Two levels at the same price are one level with two names, and they
  // publish as two near-identical cards.
  const prices = answers.tiers.map((tier) => tier.price);
  const duplicate = prices.findIndex(
    (price, i) => price !== null && prices.indexOf(price) !== i,
  );
  if (duplicate > 0) {
    out.push([
      "Two tiers are priced the same — give them different prices or drop one.",
      `tierPrice${duplicate}`,
    ]);
  }
  return out;
}

/** The tiers actually filled in, most expensive first. */
function completeTiers(answers: OnboardingAnswers): SponsorTier[] {
  return answers.tiers
    .filter((tier) => tier.name.trim() && tier.price && tier.price >= 1)
    .slice()
    .sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
}

function creatorOfferLabel(offer: CreatorOfferType) {
  return (
    CREATOR_OFFER_TYPES.find((item) => item.value === offer)?.label ?? offer
  );
}

function creatorOfferIsReady(
  answers: OnboardingAnswers,
  offer: CreatorOfferType,
) {
  const view = creatorOfferView(answers, offer);
  const touched = view.creatorOfferTouched?.[offer] ?? {
    title: false,
    description: false,
  };
  const titleReady =
    isSponsorshipOffer("creator", view) ||
    effectiveTitle("creator", view, touched).trim().length >=
      LISTING_READY_MIN.title;
  const descriptionReady =
    descriptionBody("creator", view, touched).trim().length >=
    LISTING_READY_MIN.description;
  const priceReady = isSponsorshipOffer("creator", view)
    ? tierProblems(view).length === 0
    : Boolean(view.price && view.price >= 1) &&
      !(
        typeof view.priceMax === "number" &&
        typeof view.price === "number" &&
        view.priceMax < view.price
      );
  if (!titleReady || !descriptionReady || !priceReady) return false;
  if (offer === "social") {
    return view.platforms.length > 0 && view.format.trim().length >= 10;
  }
  if (offer === "physical") {
    return Boolean(
      view.spaceKind &&
        view.spaceSize.trim() &&
        view.surfaces.length &&
        (!view.surfaces.includes(SURFACE_OTHER) || view.surfaceOther.trim()) &&
        view.installBy &&
        view.trafficCount &&
        view.trafficCount >= 1 &&
        view.availability,
    );
  }
  return Boolean(
    view.orgKind &&
      (view.orgKind !== SPONSOR_ORG_OTHER || view.orgOther.trim()) &&
      view.funding.trim() &&
      view.reachCount &&
      view.reachCount >= 1 &&
      view.season &&
      view.benefits.length &&
      tierProblems(view).length === 0,
  );
}

function emptyBusinessPreferences(): BusinessPreferences {
  return {
    categories: [],
    goals: [],
    briefScope: "",
    placements: [],
    targetPlatforms: [],
    wantedArea: "",
    timing: "",
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeBusinessPreferences(
  raw: unknown,
  fallbackCategories: string[] = [],
): BusinessPreferences {
  const source =
    raw && typeof raw === "object"
      ? (raw as Partial<BusinessPreferences> & { goal?: unknown })
      : {};
  const briefScope =
    source.briefScope === "physical" ||
    source.briefScope === "virtual" ||
    source.briefScope === "both"
      ? source.briefScope
      : "";
  return {
    ...emptyBusinessPreferences(),
    categories: stringArray(source.categories).length
      ? stringArray(source.categories)
      : [...fallbackCategories],
    // Written as `goals` since multi-select; rows saved before that carry a
    // single `goal` string, so read either and never lose what someone chose.
    goals: stringArray(source.goals).length
      ? stringArray(source.goals)
      : typeof source.goal === "string" && source.goal
        ? [source.goal as string]
        : [],
    briefScope,
    placements: stringArray(source.placements),
    targetPlatforms: stringArray(source.targetPlatforms),
    wantedArea: typeof source.wantedArea === "string" ? source.wantedArea : "",
    timing: typeof source.timing === "string" ? source.timing : "",
  };
}

function businessPreferencesFromAnswers(
  answers: OnboardingAnswers,
): BusinessPreferences {
  return {
    categories: [...answers.categories],
    goals: [...answers.goals],
    briefScope: answers.briefScope,
    placements: [...answers.placements],
    targetPlatforms: [...answers.targetPlatforms],
    wantedArea: answers.wantedArea.trim(),
    timing: answers.timing,
  };
}

function businessPreferencesForProfile(
  profile: Profile,
  ownListings: Listing[] = [],
): BusinessPreferences {
  if (profile.business_preferences) {
    return normalizeBusinessPreferences(
      profile.business_preferences,
      profile.categories,
    );
  }
  const brief = ownListings.find((listing) => isBrief(listing));
  if (!brief) {
    return normalizeBusinessPreferences(null, profile.categories);
  }
  return normalizeBusinessPreferences(
    {
      categories: profile.categories,
      briefScope: brief.brief_scope,
      placements: brief.format
        .split(/\n|,\s*/)
        .map((item) => item.trim())
        .filter(Boolean),
      targetPlatforms: brief.target_platforms,
      wantedArea: brief.location_area,
      timing: brief.availability_notes,
    },
    profile.categories,
  );
}

type CreatorRecommendation = {
  listing: Listing;
  score: number;
  reasons: string[];
};

function lower(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

function recommendationCategoryOverlap(
  categories: string[],
  listing: Listing,
) {
  const listingText = [
    listing.title,
    listing.format,
    listing.description,
    listing.owner.bio,
    ...(listing.owner.categories ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return categories.filter((category) =>
    listingText.includes(category.trim().toLowerCase()),
  );
}

function creatorPostRecommendations(
  listings: Listing[],
  profile: Profile,
  ownListings: Listing[],
  blockedProfileIds: string[],
  t: Translate = translateEnglish,
): CreatorRecommendation[] {
  const preferences = businessPreferencesForProfile(profile, ownListings);
  const targetPlatforms = preferences.targetPlatforms.map(lower);
  const wantedArea = lower(preferences.wantedArea || profile.city);
  const goalText = lower(preferences.goals.join(" "));
  const goalWords = goalText
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);
  return listings
    .filter((listing) => {
      if (listing.owner.id === profile.id) return false;
      if (blockedProfileIds.includes(listing.owner.id)) return false;
      if (isInternalAccount(listing.owner) || isBrief(listing)) return false;
      // A Physical-only brief should surface windows, walls, and vehicles in
      // the marketplace instead of filling this creator-post lane with
      // inventory the business explicitly ruled out.
      if (preferences.briefScope === "physical") return false;
      if (!profileHasRole(listing.owner, "creator")) return false;
      return [
        "Instagram",
        "TikTok",
        "YouTube",
        "X",
        "Facebook",
        "Newsletter",
        "Podcast",
        "Twitch",
        "LinkedIn",
      ].includes(listing.channel);
    })
    .map((listing) => {
      const reasons: string[] = [];
      let score = 0;
      const platformMatch = targetPlatforms.includes(lower(listing.channel));
      if (platformMatch) {
        score += 38;
        reasons.push(t("app.reasonMatchesTargetPlatform"));
      }
      if (
        preferences.briefScope === "virtual" ||
        preferences.briefScope === "both"
      ) {
        score += 6;
        reasons.push(t("app.reasonFitsVirtualBrief"));
      }
      const categoryOverlap = recommendationCategoryOverlap(
        preferences.categories,
        listing,
      );
      if (categoryOverlap.length) {
        score += Math.min(30, categoryOverlap.length * 15);
        reasons.push(t("app.reasonFits", { categories: categoryOverlap.slice(0, 2).join(t("app.andJoiner")) }));
      }
      const locationText = lower(listingCity(listing));
      if (wantedArea && locationText.includes(wantedArea)) {
        score += 18;
        reasons.push(t("app.reasonNear", { area: String(preferences.wantedArea ?? "") }));
      } else if (
        lower(listingCity(listing)).split(",")[0] ===
        lower(preferences.wantedArea || profile.city).split(",")[0]
      ) {
        score += 12;
        reasons.push(t("app.reasonLocalMarket"));
      }
      const listingText = lower(
        [
          listing.title,
          listing.format,
          listing.description,
          listing.owner.bio,
        ].join(" "),
      );
      if (goalWords.some((word) => listingText.includes(word))) {
        score += 10;
        reasons.push(t("app.reasonSupportsGoal"));
      }
      if (
        preferences.timing &&
        lower(listing.availability_notes).includes(lower(preferences.timing))
      ) {
        score += 8;
        reasons.push(t("app.reasonFitsTiming"));
      }
      if (listing.owner.verified) {
        score += 5;
        reasons.push(t("app.reasonVerified"));
      }
      if (!reasons.length) reasons.push(t("app.reasonAvailable"));
      return { listing, score, reasons };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        listingRank(a.listing) - listingRank(b.listing) ||
        shuffleKey(a.listing.id) - shuffleKey(b.listing.id),
    )
    .slice(0, 4);
}

/**
 * Accounts that exist only to exercise the product. They are real logins with
 * real rows, so every flow can be tested end to end, but a visitor must never
 * be shown one as a member - and that means hiding their LISTINGS too, not just
 * their profile card. Driven by the is_internal column rather than the display
 * name, which broke the moment a test account was renamed. The name check stays
 * as a belt-and-braces fallback for rows predating the column.
 */
function isInternalAccount(person: Profile) {
  if (person.is_internal) return true;
  const name = person.display_name.trim().toLowerCase();
  return name.startsWith("sidespace qa") || name === "support";
}

/**
 * Shrink an image in the browser before uploading. Falls back to the original
 * file if anything about the canvas path fails, so a save never breaks over an
 * optimisation. Only jpeg/png/webp reach here, all of which the bucket accepts.
 */
async function downscaleForUpload(
  file: File,
  maxEdge: number,
): Promise<{ body: Blob; contentType: string; extension: string }> {
  const original = {
    body: file as Blob,
    contentType: file.type,
    extension: file.name.split(".").pop()?.toLowerCase() || "jpg",
  };
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") {
    return original;
  }
  try {
    const bitmap = await createImageBitmap(file);
    const longest = Math.max(bitmap.width, bitmap.height);
    // Already small enough, and small files are not worth re-encoding.
    if (longest <= maxEdge && file.size <= 600_000) {
      bitmap.close();
      return original;
    }
    const scale = Math.min(1, maxEdge / longest);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return original;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", 0.82),
    );
    if (!blob || blob.size >= file.size) return original;
    return { body: blob, contentType: "image/webp", extension: "webp" };
  } catch {
    return original;
  }
}

/**
 * Members should never be shown Postgres internals. supabase-js returns
 * PostgrestError as a plain object, not an Error, so `instanceof Error` misses
 * every database failure and the real reason gets thrown away.
 */
function friendlyDbError(error: unknown): string {
  const raw =
    typeof error === "string"
      ? error
      : ((error as { message?: string } | null)?.message ?? "");
  const code = (error as { code?: string } | null)?.code ?? "";

  if (/row-level security/i.test(raw)) {
    // A refusal here has several causes - a block in either direction, a
    // listing that was just paused or removed, an account that was deleted,
    // or an unfinished profile. Naming only blocking told people they had been
    // blocked when nobody had blocked anyone, which is worse than vague.
    return "That is not available any more. The listing may have been paused or removed, or one of you may have blocked the other.";
  }
  if (/listing_cap_reached/i.test(raw)) {
    return "You have reached the limit of 25 listings. Email support and we can remove one for you.";
  }
  if (/out of range|numeric field overflow/i.test(raw)) {
    return "That number is too large. Use a smaller amount.";
  }
  if (code === "23505" || /duplicate key/i.test(raw)) {
    return "That already exists.";
  }
  if (code === "23514" || /violates check constraint/i.test(raw)) {
    return "Some of those details are too short or too long. Check the highlighted fields and try again.";
  }
  if (code === "23503" || /foreign key/i.test(raw)) {
    return "Something this refers to is no longer available. Refresh and try again.";
  }
  if (/fetch|network|Failed to fetch/i.test(raw)) {
    return "We could not reach the server. Check your connection and try again.";
  }
  // Anything already written for humans (our own thrown Errors) passes through.
  if (raw && !/violates|constraint|relation |column |syntax error/i.test(raw)) {
    return raw;
  }
  return "Something went wrong. Please try again.";
}

function compactNumber(value: number) {
  return Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function roleLabel(role: Role) {
  return roleCopy[canonicalRole(role)].label;
}

/**
 * Tidy free-text offers so the card reads as a sentence. Members type things
 * like "24/7" or "100 Hours"; this lowercases a leading capital when the rest
 * of the word is lowercase, and trims stray punctuation, without touching
 * deliberate capitals like "Instagram".
 */
function formatOffer(raw: string) {
  const text = raw.trim().replace(/[.\s]+$/, "");
  if (!text) return "";
  const [first, ...rest] = text.split(" ");
  const looksLikeSentenceStart =
    /^[A-Z][a-z]*$/.test(first) && !/^(I|Instagram|TikTok|YouTube)$/.test(first);
  return [looksLikeSentenceStart ? first.toLowerCase() : first, ...rest].join(
    " ",
  );
}

/**
 * A "business brief" runs the other way: the poster WANTS space rather than
 * offering it, so its card has to read as a request, not an offer.
 */
/**
 * What a listing costs, as a card should read it.
 *
 * A business brief now carries a budget RANGE - `price_cents` is the low end and
 * `price_max_cents` the high end - because "what's your budget" is a band, not a
 * number. Every other listing has a single price and renders unchanged.
 */
function priceLabel(
  listing: Pick<Listing, "price_cents" | "price_max_cents">,
  locale: Locale = "en",
  formatPrice: ((usdCents: number) => string) | undefined = undefined,
) {
  const format =
    formatPrice ??
    ((usdCents: number) => formatLocalizedCurrency(locale, usdCents));
  const low = listing.price_cents;
  const high = listing.price_max_cents;
  if (typeof high === "number" && high > low) {
    return `${format(low)}–${format(high)}`;
  }
  return format(low);
}

function isBrief(listing: Pick<Listing, "channel">) {
  return listing.channel === "Business brief";
}

function isFixedPriceListing(
  listing: Pick<Listing, "price_cents" | "price_max_cents">,
) {
  return (
    typeof listing.price_max_cents !== "number" ||
    listing.price_max_cents <= listing.price_cents
  );
}

/** Legacy listings keep their original channel, but edit as Creator inventory. */
function isPhysicalListing(
  listing: Pick<
    Listing,
    | "channel"
    | "surface_types"
    | "install_by"
    | "space_size"
    | "street_address"
  >,
) {
  return (
    ["Storefront", "Vehicle", "Wall / mural", "Room / interior", "Community board"].includes(
      listing.channel,
    ) ||
    Boolean(
      listing.surface_types?.length ||
        listing.install_by ||
        listing.space_size ||
        listing.street_address,
    )
  );
}

/** Legacy listings keep their original channel, but edit as Creator inventory. */
function isSponsorshipListing(
  listing: Pick<Listing, "channel" | "sponsor_tier" | "sponsor_slots">,
) {
  return (
    listing.channel === "Sponsorship" ||
    Boolean(listing.sponsor_tier || listing.sponsor_slots)
  );
}

/**
 * Stable pseudo-random key from the id. Gives the grid a mixed, non-
 * chronological feel without reshuffling on every render (which would fight
 * hydration and make the page jump).
 */
function shuffleKey(id: string) {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 100000;
  }
  return hash;
}

/**
 * A listing is "ready" when it would not embarrass the marketplace: it says
 * enough for someone to decide. Thin ones sink below the complete ones.
 */
/**
 * What the marketplace counts as a complete listing.
 *
 * listingRank sorts anything failing this below every complete listing, and
 * nothing ever told the owner. At the time of writing 3 of the 16 live member
 * listings are in that state - one short title, two short descriptions - so
 * roughly a fifth of the inventory is being quietly sunk by a rule its owners
 * have never been shown.
 *
 * One constant, so the ranking, the onboarding validator and the note on the
 * My listings card cannot drift apart about where the bar is.
 */
const LISTING_READY_MIN = { title: 8, format: 10, description: 60 };

/**
 * What a listing is still missing, phrased for the person who has to fix it.
 * An empty list means the grid treats it as complete.
 */
/**
 * The offer statuses that still need somebody to do something.
 *
 * A countered request is still open: the other side can accept, decline or
 * revise it. Anything else - accepted, confirmed, completed, declined,
 * cancelled, refunded - is history.
 */
const OPEN_REQUEST_STATUSES = ["pending", "countered"];

function listingGaps(
  listing: Pick<Listing, "title" | "format" | "description"> & Partial<Pick<Listing, "timing_kind" | "deliverables">>,
) {
  const gaps: string[] = [];
  if (listing.title.trim().length < LISTING_READY_MIN.title) {
    gaps.push("a longer title");
  }
  if (listing.format.trim().length < LISTING_READY_MIN.format) {
    gaps.push("more detail in what the buyer gets");
  }
  if (!listing.timing_kind && listing.description.trim().length < LISTING_READY_MIN.description) {
    gaps.push("a longer description");
  }
  return gaps;
}

function listingIsReady(listing: Listing) {
  return listingGaps(listing).length === 0;
}

/**
 * Real and complete first, then real but thin, then samples, then briefs.
 *
 * A brief is a business asking for space, not space anyone can book, so it
 * answers a different question from every other card in the grid. Mixed in by
 * recency a single fresh brief took the top of the marketplace and read as the
 * headline listing. It stays in the grid - "wanted" is a card people can
 * answer, and the role filter exists to find them - it just stops arriving
 * first.
 */
/**
 * The city shown with a listing is the listing's own, falling back to the
 * owner's profile city only when the listing did not say. One member can own a
 * car in Brea and a dorm door in Berkeley; each card must read as where that
 * space actually is, not where its owner lives.
 */
function listingCity(
  listing: Pick<Listing, "location_area"> & { owner: Pick<Profile, "city"> },
) {
  return listing.location_area || listing.owner.city;
}

function listingRank(listing: Listing) {
  if (isBrief(listing)) return 3;
  if (listing.owner.is_demo) return 2;
  return listingIsReady(listing) ? 0 : 1;
}

/** Every role a profile acts as, primary first. */
function profileRoles(profile: Pick<Profile, "role" | "extra_roles">): Role[] {
  const extras = (profile.extra_roles ?? []).filter(
    (role): role is Role => role !== profile.role,
  );
  return Array.from(
    new Set([profile.role, ...extras].map((role) => canonicalRole(role))),
  );
}

function profileHasRole(
  profile: Pick<Profile, "role" | "extra_roles">,
  role: Role,
) {
  return profileRoles(profile).includes(canonicalRole(role));
}

function rolesLabel(
  profile: Pick<Profile, "role" | "extra_roles">,
  locale: Locale = "en",
) {
  return profileRoles(profile)
    .map((role) => localizeRole(locale, role))
    .join(" · ");
}

/** Characters as a person counts them, matching Postgres char_length. */
function charCount(value: string) {
  return Array.from(value).length;
}

function listingBookingMinDate(
  listing: Pick<Listing, "available_from" | "lead_time_days" | "booking_timezone">,
) {
  const today = calendarToday(listing.booking_timezone);
  const leadTime = Math.max(0, listing.lead_time_days ?? 0);
  const leadDate = addCalendarDays(today, leadTime);
  return [today, leadDate, listing.available_from ?? today].sort().at(-1) ?? today;
}

function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    // Array.from, not [0]: indexing a string splits a surrogate pair down the
    // middle, so a name starting with an emoji rendered as the replacement
    // glyph instead of a letter.
    .map((part) => Array.from(part)[0] ?? "")
    .join("")
    .toUpperCase();
}

function normalizeSocialUrl(
  platform: (typeof socialPlatforms)[number],
  value: string,
) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return url.protocol === "http:" || url.protocol === "https:"
        ? url.toString()
        : "";
    } catch {
      return "";
    }
  }
  // No base means there is no canonical URL to build - a newsletter or a
  // podcast name is not a handle on a known host. Store what they typed rather
  // than inventing "https://<empty>name".
  if (!platform.base) return trimmed;
  return `${platform.base}${trimmed.replace(/^@/, "")}`;
}

function listingImages(listing: Listing) {
  return listing.image_urls?.length
    ? listing.image_urls
    : [listing.image_url].filter(Boolean);
}

/**
 * The photos a listing actually shows.
 *
 * A business brief is a wanted ad - "here is the campaign, who has the space"
 * - and businesses write them without a photo of anything, because there is
 * nothing yet to photograph. Publishing seeded those with the stock cover, so
 * every brief arrived carrying a picture of somebody else's market stall and
 * presented it as the campaign. A brief now shows a photo only when the
 * business uploaded one.
 *
 * The seed already sitting in the column on older briefs is read as no photo
 * here rather than migrated away: no row has to be rewritten, and a business
 * that uploads later simply replaces it. Only briefs are filtered - the
 * default is still a sensible cover for space that exists and was listed
 * without a picture of it.
 */
function listingPhotos(listing: Listing) {
  const images = listingImages(listing);
  return isBrief(listing)
    ? images.filter((url) => url !== DEFAULT_LISTING_IMAGE)
    : images;
}

/** A listing's cover photo, or "" when a brief has none of its own. */
function listingCover(listing: Listing) {
  const photos = listingPhotos(listing);
  if (photos[0]) return photos[0];
  return isBrief(listing) ? "" : DEFAULT_LISTING_IMAGE;
}

/**
 * A listing's cover, or the quiet panel that stands in for one.
 *
 * Not an <img> with an empty src: a browser treats that as a broken image and
 * draws the torn-page icon, which reads as a fault rather than as a brief that
 * simply has no photo. The panel carries no words - it sits at 52px on a
 * dashboard row and at full width on a card, and any label would be clipped at
 * one of those sizes.
 */
function ListingCover({
  listing,
  alt = "",
}: {
  listing: Listing;
  alt?: string;
}) {
  const cover = listingCover(listing);
  if (!cover) {
    return <span className="listing-cover-blank" aria-hidden="true" />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={cover} alt={alt} loading="lazy" decoding="async" />
  );
}

/** Newest messages fetched per thread. See loadMessages for why this is bounded. */
const MESSAGE_PAGE_SIZE = 100;

/**
 * Upper bound on people-showcase cards, matching the query limit so the fetch
 * is the single real bound.
 *
 * This exists to stop an unbounded render, NOT to curate. It was briefly set to
 * 12 while the marketplace had 14 real members, which quietly hid two of them -
 * the opposite of what the showcase is for. Keep it at or above the profiles
 * query limit; if that limit changes, change this with it.
 */
const SHOWCASE_LIMIT = 60;

/**
 * Support contact shown in-app. NOTE: app/terms/page.tsx and
 * app/privacy/page.tsx still publish kveldanda987@gmail.com instead. Those are
 * legal pages, so unifying them is a decision for the founders rather than a
 * bug fix - but the two addresses should not stay divergent.
 */
const SUPPORT_EMAIL = "sidespacesupport@gmail.com";

// Constructed once at module scope. Intl.DateTimeFormat is among the most
// expensive built-ins to construct - locale resolution plus ICU allocation -
// and these were being rebuilt per row inside render bodies.
const DATE_FORMATS = new Map<Locale, Intl.DateTimeFormat>();
const TIME_FORMATS = new Map<Locale, Intl.DateTimeFormat>();

/** One formatter per language, built the first time that language asks. */
function dateFormat(locale: Locale) {
  let format = DATE_FORMATS.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(localeTag(locale), {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    DATE_FORMATS.set(locale, format);
  }
  return format;
}

function timeFormat(locale: Locale) {
  let format = TIME_FORMATS.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(localeTag(locale), {
      hour: "numeric",
      minute: "2-digit",
    });
    TIME_FORMATS.set(locale, format);
  }
  return format;
}

/**
 * What a date chip is about to publish, said out loud.
 *
 * "Available now" writes a real 90-day window into available_from/available_to
 * and the listing page renders it as "Booking window: 27 Aug - 25 Nov" - a
 * commitment in specific dates that the owner picked a one-word chip for and
 * never saw. Showing the window here is the difference between a shortcut and
 * a guess published in their name.
 */
function windowNote(startDays: number | null, days: number, t: Translate = translateEnglish, locale: Locale = DEFAULT_LOCALE) {
  if (startDays === null) {
    return t("app.noDatesOnCard");
  }
  return t("app.cardWillShowDates", {
    start: displayDate(isoDaysFromToday(startDays), t, locale),
    end: displayDate(isoDaysFromToday(startDays + days), t, locale),
  });
}

function displayDate(value?: string | null, t: Translate = translateEnglish, locale: Locale = DEFAULT_LOCALE) {
  if (!value) return t("app.flexible");
  return dateFormat(locale).format(new Date(`${value}T00:00:00Z`));
}

function displayDateTime(value?: string | null, t: Translate = translateEnglish, locale: Locale = DEFAULT_LOCALE) {
  if (!value) return t("app.notSet");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(localeTag(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function safeProfiles(value: unknown): Profile[] {
  return Array.isArray(value) ? (value as Profile[]) : [];
}

function safeListings(value: unknown): Listing[] {
  if (!Array.isArray(value)) return [];
  const normalized = (value as Array<Omit<Listing, "owner"> & { owner: Profile | Profile[] }>)
    .map((listing) => ({
      ...listing,
      owner: Array.isArray(listing.owner) ? listing.owner[0] : listing.owner,
      like_count: normalizeLikeCount(listing.like_count),
    }))
    // The owner embed is a left join, so a listing whose owner row is hidden by
    // RLS (or absent) arrives with owner null while the type asserts it is a
    // Profile. Every consumer then dereferences owner.display_name unguarded
    // and takes the whole grid down with it. Drop those rows here instead.
    .filter((listing) => Boolean(listing.owner));
  return normalized as Listing[];
}

function Avatar({
  profile,
  size = "normal",
}: {
  profile: Profile;
  size?: "small" | "normal" | "large";
}) {
  return (
    <span className={`avatar avatar-${size}`}>
      {profile.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={profile.avatar_url} alt="" loading="lazy" decoding="async" />
      ) : (
        initials(profile.display_name)
      )}
    </span>
  );
}

function ListingLikeButton({
  title,
  likeCount,
  liked,
  isAuthenticated,
  canLike,
  disabledReason,
  disabled,
  placement,
  onToggle,
}: {
  title: string;
  likeCount?: number | string | null;
  liked: boolean;
  isAuthenticated: boolean;
  canLike: boolean;
  disabledReason?: string;
  disabled?: boolean;
  placement: "card" | "detail";
  onToggle: () => void;
}) {
  const count = normalizeLikeCount(likeCount);
  const countLabel = `${count} ${count === 1 ? "like" : "likes"}`;
  const actionLabel = !canLike
    ? disabledReason || "You cannot like this listing"
    : isAuthenticated
      ? `${liked ? "Unlike" : "Like"} ${title}`
      : `Sign in to like ${title}`;

  return (
    <button
      type="button"
      className={`listing-like-button listing-like-button-${placement}${liked ? " is-liked" : ""}`}
      aria-label={`${actionLabel}. ${countLabel}.`}
      aria-pressed={canLike ? liked : undefined}
      disabled={disabled || !canLike}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      <span className="listing-heart" aria-hidden="true">
        {liked ? "♥" : "♡"}
      </span>
      <span className="listing-like-number" aria-hidden="true">
        {compactNumber(count)}
      </span>
      <span className="sr-only">{countLabel}</span>
    </button>
  );
}

function SocialLinks({ profile, compact = false }: { profile: Profile; compact?: boolean }) {
  const { t, tx } = useLocale();
  const links = socialPlatforms
    .map((platform) => ({
      ...platform,
      url: profile.social_links?.[platform.key] ?? "",
    }))
    .filter((platform) => /^https?:\/\//i.test(platform.url));

  if (!links.length) return null;

  return (
    <nav className={`social-links ${compact ? "social-links-compact" : ""}`} aria-label={t("app.displayNameSocialProfiles", { display_name: profile.display_name })}>
      {links.map((platform) => (
        <a
          key={platform.key}
          href={platform.url}
          target="_blank"
          rel="noreferrer"
          aria-label={t("app.displayNameOnLabelValue", { display_name: profile.display_name, label: tx(platform.label), value: profile.social_verification?.[platform.key] === "verified"
              ? ", connected and verified"
              : ", self-reported link" })}
        >
          <b>{tx(platform.short)}</b>
          {!compact && <span>{tx(platform.label)}</span>}
          {profile.social_verification?.[platform.key] === "verified" && (
            <i title={t("app.connectedAndVerified")}>✓</i>
          )}
        </a>
      ))}
    </nav>
  );
}

// `iframe` is in here for Google's sign-in button, which renders inside one:
// without it the dialog's Tab cycle stepped straight over the first control on
// the sign-in screen and a keyboard user could not reach it at all.
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

/**
 * A dialog cannot read which control opened it: by the time it mounts the
 * browser has already dropped focus to <body>. Remember the last real focus
 * target so the dialog can hand focus back when it closes.
 */
let lastFocusedElement: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target as HTMLElement | null;
      if (target && target !== document.body && !target.closest(".modal-card")) {
        lastFocusedElement = target;
      }
    },
    true,
  );
}

// Every Modal listens on `document` in the capture phase, so when one dialog
// opens on top of another (a listing editor from the account dashboard, a gate
// from anywhere) BOTH handlers run - listeners on the same node are not
// stopped by stopPropagation. The outer one then saw focus sitting outside its
// own card and hauled it back, and Escape closed the parent out from under the
// child. Only the dialog on top of this stack reacts to keys.
const openModals: HTMLElement[] = [];

/**
 * The page behind an open overlay must not scroll.
 *
 * Nothing stopped it. Reading a listing and spinning the wheel past the end of
 * the dialog scrolled the marketplace underneath it, so closing the dialog left
 * you somewhere else in the grid than where you opened it - 600px further down,
 * hunting for the card you had just been looking at. The same happened behind
 * the messages drawer. It also pins the small jump the browser makes when it
 * scrolls the clicked card fully into view as it takes focus.
 *
 * Counted, because overlays stack: a listing, then the seller's profile over
 * it. Only the first lock records the position and only the last unlock
 * restores it, so closing the inner one does not release the outer one's hold.
 *
 * position: fixed rather than overflow: hidden, which iOS Safari ignores for
 * the body. The scrollbar's width is handed back as padding, so the page does
 * not jump sideways at the moment the scrollbar disappears.
 */
let scrollLocks = 0;
let lockedScrollY = 0;

function lockPageScroll() {
  if (scrollLocks++ > 0) return;
  lockedScrollY = window.scrollY;
  const gutter = window.innerWidth - document.documentElement.clientWidth;
  const style = document.body.style;
  style.position = "fixed";
  style.top = `-${lockedScrollY}px`;
  style.left = "0";
  style.right = "0";
  style.width = "100%";
  if (gutter > 0) style.paddingRight = `${gutter}px`;
}

function unlockPageScroll() {
  if (scrollLocks === 0 || --scrollLocks > 0) return;
  const style = document.body.style;
  style.position = "";
  style.top = "";
  style.left = "";
  style.right = "";
  style.width = "";
  style.paddingRight = "";
  // The stylesheet asks for smooth scrolling, which would animate the page
  // back to where it already was. Put it there outright.
  const root = document.documentElement;
  const previous = root.style.scrollBehavior;
  root.style.scrollBehavior = "auto";
  window.scrollTo(0, lockedScrollY);
  root.style.scrollBehavior = previous;
}

function Modal({
  children,
  onClose,
  label,
  wide = false,
  elevated = false,
}: {
  children: ReactNode;
  onClose: () => void;
  /**
   * Accessible name for the dialog. Required: the focus effect deliberately
   * focuses the card itself, so a screen reader announces this the moment the
   * dialog opens. Without it every overlay in the app announced as an unnamed
   * "dialog" and the user had to explore to find out what had appeared.
   */
  label: string;
  wide?: boolean;
  /** Gate dialogs (auth, onboarding) that must outrank any other overlay. */
  elevated?: boolean;
}) {
  const { t } = useLocale();
  const cardRef = useRef<HTMLElement | null>(null);
  // The focus effect must run exactly once per modal lifetime, but Escape
  // still needs the freshest onClose closure; a ref bridges the two.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    openModals.push(card);
    lockPageScroll();
    const isTopmost = () => openModals[openModals.length - 1] === card;
    const active = document.activeElement as HTMLElement | null;
    const opener =
      active && active !== document.body ? active : lastFocusedElement;

    // Move focus into the dialog so keyboard and screen reader users land
    // inside it instead of on the page behind the overlay. Deferred by a
    // frame because the browser restores focus to the clicked trigger once
    // the click that opened this finishes dispatching.
    // Focus the dialog itself rather than a child: screen readers announce
    // the dialog, and a child can be replaced by a later re-render. Re-assert
    // a few times because content arriving after mount (the Google button,
    // loaded listings) can drop focus back to the body.
    let attempts = 0;
    const focusTimer = window.setInterval(() => {
      attempts += 1;
      if (isTopmost() && !card.contains(document.activeElement)) {
        card.focus({ preventScroll: true });
      }
      if (attempts >= 6) window.clearInterval(focusTimer);
    }, 80);

    function onKeyDown(event: KeyboardEvent) {
      if (!isTopmost()) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(
        card!.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => element.offsetParent !== null);
      if (!items.length) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      // If focus fell out of the dialog (its content was swapped under it,
      // e.g. an onboarding step change), bring Tab back to the top instead of
      // letting it wander behind the overlay.
      if (!card!.contains(document.activeElement)) {
        event.preventDefault();
        firstItem.focus();
        return;
      }
      // Keep Tab inside the dialog rather than wandering behind it.
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearInterval(focusTimer);
      document.removeEventListener("keydown", onKeyDown, true);
      const at = openModals.indexOf(card);
      if (at !== -1) openModals.splice(at, 1);
      unlockPageScroll();
      // Send focus back where it came from so the page does not lose place.
      if (opener && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
    // Deliberately run once per modal lifetime. Depending on onClose meant
    // every parent re-render (toasts, the 4.6s step-widget timer, realtime
    // updates) re-ran this effect: the cleanup handed focus to the opener
    // BEHIND the dialog and the restarted grab-timer then pulled it onto the
    // card - stealing the caret from whatever field the member was typing in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`modal-layer ${elevated ? "modal-layer-top" : ""}`}
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        ref={cardRef}
        className={`modal-card ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="close-button" onClick={onClose} aria-label={t("app.close")}>
          ×
        </button>
        {children}
      </section>
    </div>
  );
}

function CreatorOfferSwitcher({
  answers,
  onSelect,
  isOfferComplete,
}: {
  answers: OnboardingAnswers;
  onSelect: (offer: CreatorOfferType) => void;
  isOfferComplete?: (offer: CreatorOfferType) => boolean;
}) {
  const { t } = useLocale();
  const offers = selectedCreatorOffers(answers);
  if (!offers.length) return null;
  const isSingleOffer = offers.length === 1;
  const activeOffer = offers[0];
  const activeOfferReady = isOfferComplete
    ? isOfferComplete(activeOffer)
    : creatorOfferIsReady(answers, activeOffer);
  return (
    <div
      className={
        "creator-offer-workspace field-wide" +
        (isSingleOffer ? " is-single" : "")
      }
    >
      <div className="creator-offer-workspace-heading">
        <div>
          <span>{isSingleOffer ? t("app.currentListing") : t("app.selectedOffers")}</span>
          <strong>
            {isSingleOffer
              ? creatorOfferLabel(activeOffer)
              : t("app.fillInEachOneBeforeYouPublish")}
          </strong>
        </div>
        <small>
          {isSingleOffer
            ? activeOfferReady
              ? t("app.complete")
              : t("app.needsDetails")
            : t("app.offerscountListingsPlanned", { offersCount: offers.length })}
        </small>
      </div>
      {!isSingleOffer && (
        <>
          <div
            className="creator-offer-tabs"
            role="tablist"
            aria-label={t("app.chooseWhichOfferToEdit")}
          >
            {offers.map((offer) => {
              const active = answers.creatorOffer === offer;
              const ready = isOfferComplete
                ? isOfferComplete(offer)
                : creatorOfferIsReady(answers, offer);
              return (
                <button
                  key={offer}
                  type="button"
                  className={
                    "creator-offer-tab" +
                    (active ? " active" : "") +
                    (ready ? " is-complete" : "")
                  }
                  role="tab"
                  aria-selected={active}
                  onClick={() => onSelect(offer)}
                >
                  <span>{creatorOfferLabel(offer)}</span>
                  <small>{ready ? t("app.complete") : t("app.needsDetails")}</small>
                </button>
              );
            })}
          </div>
          <p className="creator-offer-workspace-note">
            {t("app.youAreEditing")}{" "}
            <b>{creatorOfferLabel(answers.creatorOffer || offers[0])}</b>{t("app.eachSelectedPathGetsItsOwnListing")}
          </p>
        </>
      )}
    </div>
  );
}

function PreferenceChipGroup({
  label,
  options,
  selected,
  multi = false,
  onPick,
}: {
  label: string;
  options: Array<{ label: string; value: string }>;
  selected: string | string[];
  multi?: boolean;
  onPick: (value: string) => void;
}) {
  const { tx } = useLocale();
  return (
    <fieldset className="preference-chip-group">
      <legend>{label}</legend>
      <div className="preference-chip-row">
        {options.map((option) => {
          const active = multi
            ? (selected as string[]).includes(option.value)
            : selected === option.value;
          return (
            <button
              key={option.value}
              type="button"
              className={active ? "active" : ""}
              aria-pressed={active}
              onClick={() => onPick(option.value)}
            >
              {multi && active ? "✓ " : ""}
              {tx(option.label)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function OnboardingPreviewCards({
  role,
  answers,
  touched,
  previewPhotoUrl,
}: {
  role: Role;
  answers: OnboardingAnswers;
  touched: { title: boolean; description: boolean };
  previewPhotoUrl: string;
}) {
  const { t } = useLocale();
  const drafts = buildListingDrafts(role, answers, touched);
  const isMulti = drafts.length > 1;
  return (
    <div
      className={"onboarding-preview field-wide" + (isMulti ? " has-multiple" : "")}
    >
      <div className="onboarding-preview-heading">
        <span>
          {isMulti
            ? "These are the " + drafts.length + " listings people will see"
            : t("app.thisIsWhatPeopleWillSee")}
        </span>
        {isMulti && (
          <small>{t("app.oneCardPerSelectedOfferOrSponsorship")}</small>
        )}
      </div>
      <div className="preview-card-grid">
        {drafts.map((draft, index) => {
          const hasPrice = draft.price_cents > 0;
          return (
            <article
              className="preview-card"
              key={draft.channel + "-" + String(index)}
            >
              {previewPhotoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  className="preview-card-photo"
                  src={previewPhotoUrl}
                  alt=""
                />
              ) : (
                <p className="preview-card-photo is-empty">
                  {t("app.addAPhotoAboveItFillsThe")}
                </p>
              )}
              <div className="preview-card-top">
                <span
                  className={
                    role === "business"
                      ? "preview-chip is-brief"
                      : "preview-chip"
                  }
                >
                  {role === "business" ? t("market.wanted") : draft.channel}
                </span>
                <small className="preview-offer">
                  {answers.display_name.trim() || t("app.yourName")}
                  {answers.city.trim() ? " · " + answers.city.trim() : ""}
                </small>
              </div>
              <div className="preview-card-body">
                <strong>{draft.title || t("app.untitledListing")}</strong>
                <span className="preview-offer">
                  {draft.format.trim()
                    ? role === "business"
                      ? "Looking for " + draft.format.trim()
                      : "You get " + formatOffer(draft.format)
                    : t("app.addWhatPeopleGetAbove")}
                </span>
                <p className="preview-card-blurb">
                  {draft.description || t("app.yourDescriptionWillShowHere")}
                </p>
                <div className="preview-card-foot">
                  {role === "business" && (
                    <span className="preview-lead">{t("market.budget")}</span>
                  )}
                  <b className={hasPrice ? undefined : "preview-price-empty"}>
                    {hasPrice ? priceLabel(draft) : t("app.addAPrice")}
                  </b>
                  <small>/ {draft.price_unit}</small>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The dashboard stat icons.
 *
 * Drawn on the same 16px grid at the same 1.5 stroke as the arrow in the
 * tile's action row, so a tile reads as one drawing rather than a font
 * character next to an SVG.
 */
const DASHBOARD_STAT_ICONS = {
  listings: "M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h6.5",
  incoming: "M8 2.75v6.5M5.25 6.5 8 9.25l2.75-2.75M2.75 11.25v1a1 1 0 0 0 1 1h8.5a1 1 0 0 0 1-1v-1",
  outgoing: "M8 13.25v-6.5M5.25 9.5 8 6.75l2.75 2.75M2.75 4.75v-1a1 1 0 0 1 1-1h8.5a1 1 0 0 1 1 1v1",
  messages: "M13.25 8.5c0 2.6-2.35 4.75-5.25 4.75a6 6 0 0 1-1.9-.3l-3.35 1 1-2.75A4.5 4.5 0 0 1 2.75 8.5c0-2.6 2.35-4.75 5.25-4.75s5.25 2.15 5.25 4.75Z",
  payments: "M2.75 6.25h10.5M3.75 3.75h8.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-6.5a1 1 0 0 1 1-1ZM5 9.75h2",
  analytics: "M3 13V9.5M6.33 13V6M9.67 13V8.25M13 13V3.5",
  likes: "M8 13.25S2.75 9.9 2.75 6.2a2.7 2.7 0 0 1 5.25-.9 2.7 2.7 0 0 1 5.25.9c0 3.7-5.25 7.05-5.25 7.05Z",
} as const;

function DashboardStatIcon({
  name,
}: {
  name: keyof typeof DASHBOARD_STAT_ICONS;
}) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d={DASHBOARD_STAT_ICONS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function MarketplaceApp({
  initialProfiles = null,
  initialListings = null,
  invite = null,
  route = "home",
  initialQuery = "",
  initialLocation = "",
  initialRoleFilter = "all",
  initialChannel = "All",
  initialSort = "latest",
  referralCode = "",
  referralCreditCents = null,
  openProfile = false,
  openOnboarding = false,
}: {
  /** Server-rendered marketplace, so crawlers and link previews see real
   *  members instead of the seeded demo set. Null when Supabase was
   *  unreachable, in which case the demo seed is used exactly as before. */
  initialProfiles?: unknown;
  initialListings?: unknown;
  /** Resolved from ?p= on the invite link in a cold email. See prefillFromInvite. */
  invite?: Invite | null;
  /** The shared Business referral code, preserved through auth redirects. */
  referralCode?: string;
  /** Server-validated value for a dynamic founder-created referral. */
  referralCreditCents?: number | null;
  /** One-shot intent from the public header to open profile settings. */
  openProfile?: boolean;
  /** One-shot intent from a signed-in public CTA to resume incomplete onboarding. */
  openOnboarding?: boolean;
  /** Public information architecture route. The marketplace/auth engine stays
   * mounted so every route keeps the same dialogs, sessions, and handlers. */
  route?: SideSpaceRoute;
  initialQuery?: string;
  initialLocation?: string;
  initialRoleFilter?: RoleFilter;
  initialChannel?: string;
  initialSort?: ListingSort;
} = {}) {
  const {
    locale,
    formatNumber: formatLocalizedNumber,
    formatListingPrice,
    t,
    tx,
  } = useLocale();
  const seededProfiles = useMemo(() => {
    const loaded = safeProfiles(initialProfiles);
    return loaded.length ? loaded : demoProfiles;
  }, [initialProfiles]);
  const seededListings = useMemo(() => {
    const loaded = safeListings(initialListings);
    return loaded.length ? loaded : demoListings;
  }, [initialListings]);

  const configured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
  const localPreviewAvailable =
    !configured && process.env.NODE_ENV === "development";
  const supabase = useMemo(
    () => (configured ? createClient() : null),
    [configured],
  );

  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>(seededProfiles);
  const [listings, setListings] = useState<Listing[]>(seededListings);
  const [ownListings, setOwnListings] = useState<Listing[]>([]);
  const [ownListingsLoading, setOwnListingsLoading] = useState(false);
  const [listingAnalytics, setListingAnalytics] = useState<ListingAnalytics[]>([]);
  // Co-visit counts for the listings this browser has shown interest in. Empty
  // until the site has real traffic, which is exactly when it starts to matter.
  const [cooccurrence, setCooccurrence] = useState<CooccurrenceIndex | null>(null);
  const [likedListingIds, setLikedListingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [likesLoading, setLikesLoading] = useState(false);
  const [pendingLikeIds, setPendingLikeIds] = useState<Set<string>>(
    () => new Set(),
  );
  const likeRequestsRef = useRef(new Set<string>());
  const [loading, setLoading] = useState(configured);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signup");
  const [accountOpen, setAccountOpen] = useState(false);
  const [businessPreferencesDraft, setBusinessPreferencesDraft] =
    useState<BusinessPreferences>(() => emptyBusinessPreferences());
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingPreview, setOnboardingPreview] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(1);
  const [onboardingDirection, setOnboardingDirection] = useState<1 | -1>(1);
  const [creatorOfferDirection, setCreatorOfferDirection] = useState<1 | -1>(1);
  // Mirrors onboardingOpen for callbacks with stale closures (loadOwnProfile
  // is memoized against supabase only).
  const onboardingOpenRef = useRef(false);
  useEffect(() => {
    onboardingOpenRef.current = onboardingOpen;
  }, [onboardingOpen]);
  // Pick up a listing that was left unfinished. Runs on sign-in rather than on
  // mount because the key is per-user, and expires after a week so a stale
  // draft never resurfaces as a surprise.
  useEffect(() => {
    if (!user) {
      setOnboardingDraft(null);
      return;
    }
    try {
      const raw = window.localStorage.getItem(`sidespace.onboarding.${user.id}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        role?: Role | null;
        answers?: OnboardingAnswers;
        savedAt?: number;
      };
      const week = 7 * 24 * 60 * 60 * 1000;
      if (!parsed.answers || Date.now() - (parsed.savedAt ?? 0) > week) {
        window.localStorage.removeItem(`sidespace.onboarding.${user.id}`);
        return;
      }
      setOnboardingDraft({
        role: parsed.role ?? null,
        answers: normalizeOnboardingAnswers(parsed.answers),
      });
    } catch {
      // Unparseable or unavailable storage. The draft is a convenience.
    }
  }, [user]);
  // The auth user whose profile state is already loaded, so background auth
  // events (token refresh, tab refocus) do not trigger redundant reloads.
  const lastAuthUserIdRef = useRef<string | null>(null);
  // Set when the profile READ failed, so a null profile is not mistaken for
  // "no profile exists" and turned into a doomed insert.
  const profileLoadFailedRef = useRef(false);
  // Guards against a slower earlier thread fetch overwriting a newer one.
  const threadSeqRef = useRef(0);
  // In-flight guard for the message composer, so a double click cannot send
  // the same message twice.
  const sendingMessageRef = useRef(false);
  const inboxCardRef = useRef<HTMLElement | null>(null);
  // Null until the member actually picks, so step 1 is a real gate. This used
  // to default to "business": anyone who scrolled past the role cards was
  // silently filed as a Business, and role drives the RLS policy that decides
  // whether they may list at all.
  const [selectedRole, setSelectedRole] = useState<Role | null>(
    invite ? inviteRole(invite) : null,
  );
  // A returning member already answered this, and their stored role counts as
  // an answer - otherwise "Edit profile" would refuse to advance until they
  // re-tapped a card they chose months ago.
  // An invite counts as answered: the outreach queue already decided which
  // side of the marketplace this business was approached about, and the card
  // is pre-selected on screen where they can change it.
  const [roleTouched, setRoleTouched] = useState(Boolean(invite));
  const [extraRoles, setExtraRoles] = useState<Role[]>([]);
  /**
   * "setup" builds a profile AND the member's first listing. "edit" is the
   * profile editor.
   *
   * The same modal is both: three of the seven setOnboardingOpen(true) call
   * sites are re-entry points for members who are already onboarded ("Edit
   * profile", the hero CTA, and the dashboard's "Add photo"). Without this
   * flag, turning step 2 into a listing composer would walk someone who
   * clicked "Edit profile" through publishing a second listing, with no way
   * left to change their bio.
   */
  const [onboardingMode, setOnboardingMode] = useState<"setup" | "edit">(
    "setup",
  );
  const [onboardingError, setOnboardingError] = useState("");
  // Keep the primary action available before a step is complete. When a
  // member presses it early, this names and highlights the first answer still
  // needed instead of making the action disappear and leaving them to guess.
  const [onboardingInvalidField, setOnboardingInvalidField] = useState("");
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [answers, setAnswers] = useState<OnboardingAnswers>(() =>
    answersFromProfile(null, invite),
  );
  // File inputs cannot be controlled, so these are read at publish time rather
  // than mirrored into `answers`.
  // The title and description show a generated draft that keeps updating as
  // the chips change - until the member edits it, at which point it is theirs
  // and we stop overwriting their words.
  const [titleTouched, setTitleTouched] = useState(false);
  const [descriptionTouched, setDescriptionTouched] = useState(false);
  /**
   * A half-finished onboarding, if there is one.
   *
   * Written only when the profile saved but the listing did not, and read only
   * by the dashboard checklist. Kept for seven days: an unfinished listing is
   * worth offering back tomorrow, not in a month.
   */
  const [onboardingDraft, setOnboardingDraft] = useState<{
    role: Role | null;
    answers: OnboardingAnswers;
  } | null>(null);
  /**
   * Chosen files, captured on change instead of read from the DOM at submit.
   *
   * A file input cannot be controlled, but it CAN be unmounted - and only one
   * step is mounted at a time now. The avatar input lives on step 1 while the
   * only submit button lives on step 2, so reading `ref.current.files` at
   * publish time always found a detached input and silently dropped the photo.
   * The listing photo inputs had the mirror-image bug: pressing "← Back" to fix
   * a typo unmounted them and threw the selection away without saying so.
   */
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarCropPending, setAvatarCropPending] = useState(false);
  const [listingFiles, setListingFiles] = useState<File[]>([]);
  const listingFilesRef = useRef<File[]>([]);
  function setPendingListingFiles(files: File[]) {
    listingFilesRef.current = files;
    setListingFiles(files);
  }
  const [aiFilling, setAiFilling] = useState(false);
  const [aiQuestions, setAiQuestions] = useState<string[]>([]);
  /** What the model says it can see in the owner's photo, shown so a wrong "fact" is caught before it is published. */
  const [aiObservations, setAiObservations] = useState<string[]>([]);
  /**
   * Street View attached to the address while editing: the capture month and
   * panorama id the listing will store, plus a transient preview URL when the
   * frame was just fetched (null for a saved one, which the card shows live
   * instead). Google's terms allow keeping nothing of the imagery itself.
   */
  const [streetView, setStreetView] = useState<{ captured: string; pano: string; url: string | null } | null>(null);
  const [streetViewLoading, setStreetViewLoading] = useState(false);
  /** The walkthrough file picked in the editor, read for size and shape so the form can say what it will do with it. */
  const [tourPick, setTourPick] = useState<(TourProbe & { file: File }) | null>(null);
  /** Whether that file is spherical (360): guessed from a 2:1 frame, and the owner's to change. */
  const [tourSpherical, setTourSpherical] = useState(false);
  /** "View whole street": the Street View panorama opened on the listing page. */
  const [streetPanoOpen, setStreetPanoOpen] = useState(false);
  const [listening, setListening] = useState(false);
  /** How words are coming in while listening: the browser's own recogniser, or a recording the server transcribes. */
  const [voiceMode, setVoiceMode] = useState<"speech" | "recording">("speech");
  const aiNotesRef = useRef<HTMLTextAreaElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** Set once the built-in recogniser has failed this session; later taps record instead. */
  const speechFailedRef = useRef(false);
  const recorderRef = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    timer: number;
    discard: boolean;
  } | null>(null);
  useEffect(
    () => () => {
      recognitionRef.current?.abort();
      const active = recorderRef.current;
      if (active) {
        active.discard = true;
        window.clearTimeout(active.timer);
        active.stream.getTracks().forEach((track) => track.stop());
      }
    },
    [],
  );
  /**
   * The photo the onboarding preview shows.
   *
   * A real listing card is mostly picture - the image is the whole top half,
   * above the name - and the preview had none, so the member's model of what
   * they were publishing was missing its largest element. Held as an object
   * URL and revoked when it changes, or every re-pick leaks a blob.
   */
  const [previewPhotoUrl, setPreviewPhotoUrl] = useState("");
  const [galleryFiles, setGalleryFiles] = useState<File[]>([]);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const onboardingFormRef = useRef<HTMLFormElement | null>(null);
  const [onboardingBookings, setOnboardingBookings] = useState<Partial<Record<CreatorOfferType, {
    schedule: BookingSchedule; deliverables: string; cancellation: string;
  }>>>({});
  const activeBookingOffer = answers.creatorOffer || "social";
  const onboardingSchedule = onboardingBookings[activeBookingOffer]?.schedule ?? {};
  const onboardingDeliverables = onboardingBookings[activeBookingOffer]?.deliverables ?? "";
  const onboardingCancellation = onboardingBookings[activeBookingOffer]?.cancellation ?? "";
  function updateOnboardingBooking(change: Partial<{ schedule: BookingSchedule; deliverables: string; cancellation: string }>) {
    setOnboardingBookings((current) => ({ ...current, [activeBookingOffer]: {
      schedule: current[activeBookingOffer]?.schedule ?? {},
      deliverables: current[activeBookingOffer]?.deliverables ?? "",
      cancellation: current[activeBookingOffer]?.cancellation ?? "", ...change,
    } }));
  }
  function bookingForDraft(draft: ReturnType<typeof buildListingDraft>) {
    return onboardingBookings[isSponsorshipListing(draft) ? "sponsorship" : isPhysicalListing(draft) ? "physical" : "social"];
  }
  const [, setListingInstantEnabled] = useState(false);
  const [listingOpen, setListingOpen] = useState(false);
  const [composerRevision, setComposerRevision] = useState(0);
  const [listingPreview, setListingPreview] = useState(false);
  const [newListingDrafts, setNewListingDrafts] = useState<Partial<Record<CreatorOfferType, { listing: Partial<Listing> & { draft_price?: string; draft_price_max?: string; ai_notes?: string }; files: File[] }>>>({});
  function switchListingFormKind(kind: CreatorOfferType, form: HTMLFormElement | null) {
    if (form) {
      const values = new FormData(form);
      const text = (name: string) => String(values.get(name) ?? "");
      const snapshot: Partial<Listing> = Object.fromEntries(["title","channel","format","description","deliverables","price_unit","location_area","availability_notes","available_from","available_to","minimum_booking","demographics","cancellation_policy","space_size","street_address","install_by","sponsor_tier","brief_scope"].map((name) => [name,text(name)]));
      Object.assign(snapshot, {
        draft_price: text("price"), draft_price_max: text("price_max"), ai_notes: text("ai_notes"),
        timing_kind: text("timing_kind") || null, pricing_kind: text("pricing_kind") || null,
        lead_time_days: Number(text("lead_time_days") || 0), minimum_duration_days: Number(text("minimum_duration_days") || 1),
        booking_duration_days: Number(text("booking_duration_days") || 1), booking_timezone: text("booking_timezone"),
        instant_booking_enabled: values.get("instant_booking_enabled") === "on", availability_dates: JSON.parse(text("availability_dates") || "[]"),
        surface_types: values.getAll("surface_types").map(String), target_platforms: values.getAll("target_platforms").map(String),
        sponsor_slots: Number(text("sponsor_slots")) || null,
      });
      setNewListingDrafts((current) => ({ ...current, [newListingOffer]: { listing: snapshot, files: listingFilesRef.current.filter((file) => file.size > 0) } }));
    }
    setAiQuestions([]);
    setAiObservations([]);
    setPendingListingFiles(newListingDrafts[kind]?.files ?? []);
    setNewListingOffer(kind);
    setListingInstantEnabled(Boolean(newListingDrafts[kind]?.listing.instant_booking_enabled));
  }
  const [listingFeedback, setListingFeedback] = useState("");
  const [, setFormatPreview] = useState("");
  const [editingListing, setEditingListing] = useState<Listing | null>(null);
  const [newListingOffer, setNewListingOffer] =
    useState<CreatorOfferType>("social");
  // Which role's questions the listing editor should ask. An existing listing
  // keeps whatever shape it was published with; a new one follows the member.
  // A brief is identified by its CHANNEL, not by the owner's role - a space
  // owner can post a brief too - so the two are deliberately separate.
  const listingRole: Role | null = profile?.role ?? null;
  // Who is asked for platforms, handles and a follower count when editing their
  // social offer. Anyone who already carries that data from an older row can
  // still change or clear it.
  const showAudienceFields =
    selectedRole === "creator" &&
    (answers.creatorOffer === "social" ||
      Boolean(profile?.followers) ||
      Object.values(profile?.social_links ?? {}).some(Boolean));
  const editingListingIsPhysical =
    listingRole === "space_owner" ||
    Boolean(editingListing && isPhysicalListing(editingListing)) ||
    Boolean(!editingListing && canonicalRole(listingRole ?? "consumer") === "creator" && newListingOffer === "physical");
  const editingListingIsSponsorship =
    listingRole === "sponsor_host" ||
    Boolean(editingListing && isSponsorshipListing(editingListing)) ||
    Boolean(!editingListing && canonicalRole(listingRole ?? "consumer") === "creator" && newListingOffer === "sponsorship");
  const editingListingIsBrief = editingListing
    ? isBrief(editingListing)
    : listingRole === "business" || (listingPreview && selectedRole === "business");
  const listingFormKind: ListingFormKind = editingListingIsBrief
    ? "brief"
    : editingListingIsPhysical
      ? "physical"
      : editingListingIsSponsorship
        ? "sponsorship"
        : "social";
  /**
   * What a listing published without photos is seeded with - the default
   * cover or a profile photo. These give way when real photos arrive; a
   * photo the owner uploaded to the listing never does.
   */
  const listingSeedImages = new Set(
    [DEFAULT_LISTING_IMAGE, profile?.avatar_url, ...(profile?.gallery_urls ?? [])].filter(Boolean),
  );

  /**
   * Take the photos a member just picked, and point the preview at the first.
   *
   * All four role panes call this instead of setListingFiles, so the URL is
   * minted in the event that produced the file and the one it replaces is
   * revoked in the same breath - no render-phase side effect, and no blob left
   * behind when somebody re-picks five times before they are happy.
   */
  function chooseListingFiles(files: File[]) {
    setPendingListingFiles(files);
    if (previewPhotoUrl) URL.revokeObjectURL(previewPhotoUrl);
    const file = files.find((item) => item.size > 0);
    setPreviewPhotoUrl(file ? URL.createObjectURL(file) : "");
  }

  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  /** The listing whose "delete?" confirmation is open. */
  const [deleteListingTarget, setDeleteListingTarget] = useState<Listing | null>(null);
  const [deleteAccountError, setDeleteAccountError] = useState("");
  const [igAvatar, setIgAvatar] = useState("");
  const [igStats, setIgStats] = useState<IgStats | null>(null);
  const [igAvatarBusy, setIgAvatarBusy] = useState(false);
  const igAvatarSeqRef = useRef(0);
  const igAvatarPromiseRef = useRef<Promise<string> | null>(null);
  // Last handle we actually looked up, and the storage object that lookup
  // produced, so repeat blurs are free and superseded photos get cleaned up.
  const igSyncedHandleRef = useRef("");
  const igSyncedUrlRef = useRef("");
  const [selectedListing, setSelectedListing] = useState<Listing | null>(null);
  const listingViewRequestsRef = useRef(new Set<string>());
  const recordListingView = useCallback(async (listingId: string) => {
    if (!configured || listingViewRequestsRef.current.has(listingId)) return;
    listingViewRequestsRef.current.add(listingId);
    try {
      await fetch("/api/analytics/listing-view", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listingId }),
        cache: "no-store",
        keepalive: true,
      });
    } catch {
      // Analytics must never block opening a listing detail view.
    }
  }, [configured]);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(0);
  // The photos the open listing shows, and whether its media column holds
  // anything at all. A brief with no photo, no Street View and no walkthrough
  // has an empty left column, and the layout closes it up rather than leaving
  // a 520px hole beside the copy.
  const detailPhotos = selectedListing ? listingPhotos(selectedListing) : [];
  const detailCopy = selectedListing;
  const detailHasMedia = Boolean(
    selectedListing &&
      (detailPhotos.length ||
        selectedListing.street_view_captured ||
        selectedListing.tour_url),
  );
  // Opening your own listing used to offer you the buyer's controls - book it,
  // offer on it, message yourself - which all dead-end, while the controls that
  // do apply to it (edit, pause, delete) lived only on the dashboard. Owning it
  // swaps the whole action block.
  const viewingOwnListing = Boolean(
    selectedListing && profile && selectedListing.owner.id === profile.id,
  );
  const [inboxOpen, setInboxOpen] = useState(false);
  // Distinguishes still-fetching and failed from genuinely empty, so the
  // drawer stops asserting a member has no conversations before it knows,
  // and permanently if the fetch failed.
  const [inboxState, setInboxState] = useState("loading");
  const [threads, setThreads] = useState<
    Array<Conversation & { other: Profile; preview?: string }>
  >([]);
  const [activeThread, setActiveThread] = useState<Conversation | null>(null);
  // The resync listeners are registered once per session, so they cannot
  // close over activeThread without being torn down and rebuilt on every
  // thread change. A ref gives them the current thread instead.
  const activeThreadRef = useRef<Conversation | null>(null);
  // Read through refs inside realtime handlers. Listing these as effect deps
  // instead tore the websocket down and rejoined it on every thread open, and
  // an INSERT committed during that gap is never replayed.
  const profileRef = useRef<Profile | null>(null);
  const blockedIdsRef = useRef<string[]>([]);
  const [activeContact, setActiveContact] = useState<Profile | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [campaignRequests, setCampaignRequests] = useState<CampaignRequest[]>([]);
  /**
   * Which side of the offer table the campaigns section is showing.
   *
   * The dashboard stat tiles count incoming and outgoing offers separately, so
   * they need to land somewhere that shows that side alone - otherwise both
   * tiles scroll to the same undifferentiated list and the count you clicked
   * is nowhere on screen.
   */
  const [campaignSide, setCampaignSide] =
    useState<"all" | "incoming" | "outgoing">("all");
  /**
   * Whether the offers section is narrowed to work that is still open.
   *
   * The stat tiles count only pending and countered offers - that is what
   * "waiting on your reply" means. The section they navigate to listed every
   * offer ever made, so a member with two open offers and fifteen finished
   * bookings clicked "2" and landed on a list of seventeen. The tiles set this
   * so the number they clicked is the number they arrive at; it renders as a
   * pill the member can clear to see the rest.
   */
  const [campaignOpenOnly, setCampaignOpenOnly] = useState(false);
  const [paymentTransactions, setPaymentTransactions] = useState<PaymentTransaction[]>([]);
  const [adCreditBalanceCents, setAdCreditBalanceCents] = useState(0);
  const [creatorPortfolio, setCreatorPortfolio] = useState<CreatorPortfolioItem[]>([]);
  const [creatorReviews, setCreatorReviews] = useState<CreatorReview[]>([]);
  const [selectedCreatorPortfolio, setSelectedCreatorPortfolio] =
    useState<CreatorPortfolioItem[]>([]);
  const [selectedCreatorReviews, setSelectedCreatorReviews] =
    useState<CreatorReview[]>([]);
  /**
   * The seller whose profile is open over a listing, and everything they have
   * live. Fetched rather than filtered out of `listings`: that array holds
   * only the most recent rows the grid asked for, so a member with an older
   * listing would have looked like they had fewer than they do.
   */
  const [selectedOwner, setSelectedOwner] = useState<Profile | null>(null);
  const [ownerListings, setOwnerListings] = useState<Listing[]>([]);
  const [ownerListingsLoading, setOwnerListingsLoading] = useState(false);
  const [stripeAccountStatus, setStripeAccountStatus] =
    useState<StripeAccountStatus | null>(null);
  const [campaignListing, setCampaignListing] = useState<Listing | null>(null);
  const campaignListingCopy = campaignListing;
  const [campaignFeedback, setCampaignFeedback] = useState("");
  const [campaignRequestMode, setCampaignRequestMode] =
    useState<CampaignRequestMode>("offer");
  const [counteringRequest, setCounteringRequest] = useState<CampaignRequest | null>(null);
  const [verificationRequest, setVerificationRequest] =
    useState<VerificationRequest | null>(null);
  const [verificationOpen, setVerificationOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState<{
    profile: Profile;
    listing?: Listing;
  } | null>(null);
  const [blockedProfileIds, setBlockedProfileIds] = useState<string[]>([]);
  // Whether the block list has been fetched at least once, so gates can wait
  // for it rather than acting on an empty list.
  const [blockedLoaded, setBlockedLoaded] = useState(false);
  const [blockedProfiles, setBlockedProfiles] = useState<
    Array<{ id: string; display_name: string }>
  >([]);
  const [unreadCount, setUnreadCount] = useState(0);
  // Distinguishes "still loading the profile" from "checked, and there is
  // none" — otherwise a signed-in user without a profile row sits on the
  // loading screen forever.
  const [profileChecked, setProfileChecked] = useState(false);
  // True once getUser() has answered, whether or not it found anyone. Stays
  // true across sign-out: the session question is settled either way.
  // With no Supabase client there is no async session check to wait for. Mark
  // the local/demo session resolved immediately so shared listing URLs can
  // still open instead of waiting forever on an auth request that cannot run.
  const [sessionResolved, setSessionResolved] = useState(!configured);
  const [activeStep, setActiveStep] = useState(0);
  // The steps band only cycles while it is on screen, so it is always
  // step 01 that greets someone scrolling into it.
  const [stepsLive, setStepsLive] = useState(false);
  const stepsRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState(initialQuery);
  const [locationQuery, setLocationQuery] = useState(initialLocation);
  const [roleFilter, setRoleFilter] = useState<RoleFilter>(initialRoleFilter);
  const [channelFilter, setChannelFilter] = useState(initialChannel);
  const [listingSort, setListingSort] = useState<ListingSort>(initialSort);
  const [toast, setToastState] = useState<{
    text: string;
    tone: ToastTone;
  } | null>(null);
  /**
   * Show a toast, and say what kind it is when the words do not.
   *
   * The second argument exists for the failures our failure vocabulary does
   * not recognise - "No microphone was found on this device" has none of it -
   * which were being announced with a green tick, as if they had worked.
   * Passing "" clears the toast.
   */
  const setToast = useCallback(
    (text: string, tone?: ToastTone, vars?: Record<string, string | number>) => {
      // The tone is read from the English before it is translated: the
      // failure vocabulary the inference knows is English.
      setToastState(
        text ? { text: tx(text, vars), tone: toastTone(text, tone) } : null,
      );
    },
    [tx],
  );
  const [busy, setBusy] = useState(false);
  const [googleOAuthEnabled, setGoogleOAuthEnabled] = useState(false);
  // Set once the on-domain token exchange has been refused, so the redirect
  // fallback can never re-enter itself.
  const googleFallbackRef = useRef(false);

  const loadMarketplace = useCallback(async () => {
    if (!supabase) return;

    // Public marketing routes only need enough real inventory to prove the
    // marketplace exists. The full browser remains intentionally denser.
    const profileLimit = route === "marketplace" ? 60 : 12;
    const listingLimit = route === "marketplace" ? 200 : 12;

    const [profilesResult, listingsResult, likeCountsResult] = await Promise.all([
      supabase
        .from("marketplace_profiles")
        .select(PUBLIC_PROFILE_COLUMNS)
        .eq("onboarding_complete", true)
        .neq("role", "consumer")
        .order("verified", { ascending: false })
        // Bounded to match the showcase row, which renders a card per profile.
        .limit(profileLimit),
      supabase
        .from("listings")
        // Not `*`: street_address is the exact address of someone's shop or
        // home, and this payload reaches every visitor. loadOwnListings below
        // keeps `*` because it is scoped to the owner.
        .select(
          `${PUBLIC_LISTING_COLUMNS}, owner:profiles!listings_owner_profile_id_fkey(${PUBLIC_PROFILE_COLUMNS})`,
        )
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(listingLimit),
      supabase.from("listing_like_counts").select(LISTING_LIKE_COUNT_COLUMNS),
    ]);

    if (!profilesResult.error) {
      const loaded = safeProfiles(profilesResult.data);
      setProfiles(loaded.length ? loaded : demoProfiles);
    }
    if (!listingsResult.error) {
      const loaded = safeListings(
        mergeListingLikeCounts(
          listingsResult.data,
          likeCountsResult.error ? null : likeCountsResult.data,
        ),
      );
      setListings(loaded.length ? loaded : demoListings);
    }
    // Count loading is intentionally best-effort. The listing payload and
    // existing browse experience remain usable if the aggregate view is
    // temporarily unavailable during a rollout.
  }, [route, supabase]);

  const loadLikedListings = useCallback(
    async (currentUser: User) => {
      if (!supabase) {
        setLikedListingIds(new Set());
        setLikesLoading(false);
        return;
      }

      // Clear a previous account's optimistic state before the new account's
      // relationship query returns.
      setLikedListingIds(new Set());
      setLikesLoading(true);
      const { data, error } = await supabase
        .from("listing_likes")
        .select("listing_id")
        .eq("user_id", currentUser.id);

      // A member can sign out while this read is in flight. Do not let the
      // old account's likes leak into the next session.
      if (lastAuthUserIdRef.current !== currentUser.id) return;
      if (!error) {
        const rows = (data ?? []) as Array<{ listing_id?: unknown }>;
        const ids = new Set<string>();
        for (const row of rows) {
          if (typeof row.listing_id === "string") ids.add(row.listing_id);
        }
        setLikedListingIds(ids);
      }
      setLikesLoading(false);
    },
    [supabase],
  );

  const loadOwnListings = useCallback(
    async (ownProfile: Profile) => {
      if (!supabase) return;
      setOwnListingsLoading(true);
      const { data, error } = await supabase
        .from("my_listings")
        .select("*")
        .eq("owner_profile_id", ownProfile.id)
        .order("created_at", { ascending: false });

      if (error) {
        setToast("We could not load your listings. Please try again.");
      } else {
        const saved = (data as Array<Omit<Listing, "owner">> | null) ?? [];
        setOwnListings(saved.map((listing) => ({ ...listing, owner: ownProfile })));
      }
      setOwnListingsLoading(false);
    },
    [setToast, supabase],
  );

  /**
   * How many people met each of the member's own listings.
   *
   * Reads the security-invoker view, so "own" is decided by the listings
   * policy rather than by a filter written here. Fails soft on purpose: a
   * dashboard that cannot show a number is worth more than one that shows an
   * error, and the same instinct governs the like counts on the public grid.
   */
  const loadListingAnalytics = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase
      .from("my_listing_analytics")
      .select(
        "listing_id, title, status, impressions, clicks, impressions_7d, clicks_7d, like_count, offers",
      );
    if (error) {
      console.error("[analytics] own listing analytics unavailable:", error);
      return;
    }
    setListingAnalytics((data as ListingAnalytics[] | null) ?? []);
  }, [supabase]);

  /**
   * Unread count for the badge, scoped to the same conversations the inbox
   * actually shows. Relying on RLS alone counted messages from blocked members
   * whose threads loadInbox filters out, so the badge could never reach zero.
   */
  const countUnread = useCallback(
    async (
      ownProfile: Profile,
      blockedIds: string[],
    ): Promise<{ count: number | null; error: unknown }> => {
      if (!supabase) return { count: null, error: new Error("No client") };
      let query = supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .neq("sender_profile_id", ownProfile.id)
        .is("read_at", null);
      if (blockedIds.length) {
        query = query.not(
          "sender_profile_id",
          "in",
          `(${blockedIds.join(",")})`,
        );
      }
      const { count, error } = await query;
      return { count, error };
    },
    [supabase],
  );

  const loadAccountMarketplaceState = useCallback(
    async (ownProfile: Profile) => {
      if (!supabase) return;
      const [campaignResult, verificationResult, blocksResult, transactionsResult, stripeStatusResult, creditResult] =
        await Promise.all([
          supabase
            .from("campaign_requests")
            .select(
              "*, listing:listings!campaign_requests_listing_id_fkey(id,title,channel,price_cents,price_unit), requester:profiles!campaign_requests_requester_profile_id_fkey(id,display_name,avatar_url,city), owner:profiles!campaign_requests_owner_profile_id_fkey(id,display_name,avatar_url,city)",
            )
            .or(
              `requester_profile_id.eq.${ownProfile.id},owner_profile_id.eq.${ownProfile.id}`,
            )
            .order("updated_at", { ascending: false }),
          supabase
            .from("verification_requests")
            .select("*")
            .eq("profile_id", ownProfile.id)
            .maybeSingle(),
          supabase
            .from("profile_blocks")
            .select(
              "blocked_profile_id, blocked:profiles!profile_blocks_blocked_profile_id_fkey(id,display_name,avatar_url,city)",
            )
            .eq("blocker_profile_id", ownProfile.id),
          stripeConfigured
            ? fetch("/api/stripe/transactions", { cache: "no-store" })
            : Promise.resolve(null),
          stripeConfigured && profileHasRole(ownProfile, "creator")
            ? fetch("/api/stripe/connect/status", { cache: "no-store" })
            : Promise.resolve(null),
          ownProfile.role === "business"
            ? fetch("/api/payments/credits", { cache: "no-store" })
            : Promise.resolve(null),
        ]);

      if (!campaignResult.error) {
        setCampaignRequests(
          (campaignResult.data as unknown as CampaignRequest[] | null) ?? [],
        );
      }
      if (!verificationResult.error) {
        setVerificationRequest(
          (verificationResult.data as VerificationRequest | null) ?? null,
        );
      }
      if (transactionsResult?.ok) {
        const payload = (await transactionsResult.json()) as {
          transactions?: PaymentTransaction[];
        };
        setPaymentTransactions(payload.transactions ?? []);
      }
      if (stripeStatusResult?.ok) {
        setStripeAccountStatus(
          (await stripeStatusResult.json()) as StripeAccountStatus,
        );
      } else if (!profileHasRole(ownProfile, "creator")) {
        setStripeAccountStatus(null);
      }
      if (creditResult?.ok) {
        const payload = (await creditResult.json()) as { balanceCents?: unknown };
        const balanceCents = Number(payload.balanceCents ?? 0);
        if (Number.isSafeInteger(balanceCents) && balanceCents >= 0) {
          setAdCreditBalanceCents(balanceCents);
        }
      } else if (ownProfile.role !== "business") {
        setAdCreditBalanceCents(0);
      }
      if (canonicalRole(ownProfile.role) === "creator") {
        const [portfolioResult, reviewsResult] = await Promise.all([
          supabase
            .from("creator_portfolio_items")
            .select("*")
            .eq("creator_profile_id", ownProfile.id)
            .order("sort_order", { ascending: true })
            .order("created_at", { ascending: false }),
          supabase
            .from("creator_reviews")
            .select("*")
            .eq("creator_profile_id", ownProfile.id)
            .order("created_at", { ascending: false }),
        ]);
        if (!portfolioResult.error) {
          setCreatorPortfolio(
            (portfolioResult.data as CreatorPortfolioItem[] | null) ?? [],
          );
        }
        if (!reviewsResult.error) {
          setCreatorReviews((reviewsResult.data as CreatorReview[] | null) ?? []);
        }
      } else {
        setCreatorPortfolio([]);
        setCreatorReviews([]);
      }
      let blockedIds = blockedIdsRef.current;
      if (!blocksResult.error) {
        const rows = (blocksResult.data ?? []) as unknown as Array<{
          blocked_profile_id: string;
          blocked: { id: string; display_name: string } | null;
        }>;
        blockedIds = rows.map((item) => item.blocked_profile_id);
        setBlockedProfileIds(blockedIds);
        setBlockedProfiles(
          rows.map((item) => ({
            id: item.blocked_profile_id,
            display_name: item.blocked?.display_name ?? "Member",
          })),
        );
      }
      // Set this even when the blocks read failed. blocksPending gates the
      // entire marketplace grid, so leaving it false turned one transient
      // network error into a permanent wall of skeletons with no way out.
      blockedIdsRef.current = blockedIds;
      setBlockedLoaded(true);

      // Count unread only AFTER blocks resolve, and exclude blocked senders.
      // loadInbox drops conversations with a blocked member, so counting their
      // messages here left a badge above zero that nothing on screen could
      // clear - every unread message is by definition from the other party, so
      // filtering on sender covers exactly those hidden threads.
      const unreadResult = await countUnread(ownProfile, blockedIds);
      if (!unreadResult.error) {
        setUnreadCount(unreadResult.count ?? 0);
      }
    },
    [countUnread, supabase],
  );

  useEffect(() => {
    if (!supabase || !selectedListing) {
      return;
    }
    let cancelled = false;
    const creatorId = selectedListing.owner.id;
    void Promise.all([
      supabase
        .from("creator_portfolio_items")
        .select("*")
        .eq("creator_profile_id", creatorId)
        .eq("published", true)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: false }),
      supabase
        .from("creator_reviews")
        .select("*")
        .eq("creator_profile_id", creatorId)
        .order("created_at", { ascending: false })
        .limit(12),
    ]).then(([portfolioResult, reviewsResult]) => {
      if (cancelled) return;
      setSelectedCreatorPortfolio(
        portfolioResult.error
          ? []
          : ((portfolioResult.data as CreatorPortfolioItem[] | null) ?? []),
      );
      setSelectedCreatorReviews(
        reviewsResult.error
          ? []
          : ((reviewsResult.data as CreatorReview[] | null) ?? []),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [selectedListing, supabase]);

  const loadOwnProfile = useCallback(
    async (currentUser: User) => {
      if (!supabase) return;
      const { data, error } = await supabase
        .from("my_profiles")
        .select("*")
        .eq("auth_user_id", currentUser.id)
        .maybeSingle();
      if (error) {
        // A failed read is NOT "this member has no profile". Leaving profile
        // null here made the next save take the insert branch, which then dies
        // on the auth_user_id unique constraint - locking the member out of
        // their own profile for the rest of the session.
        profileLoadFailedRef.current = true;
        setProfileChecked(true);
        setToast("We could not load your saved profile. Please refresh and try again.");
        return;
      }
      const ownRow = (data as Profile | null) ?? null;
      // contact_email, contact_name and business_preferences live in
      // profile_contacts now - profiles is readable by every anonymous
      // visitor. Folded back on here so the rest of the app sees one profile.
      const own = ownRow
        ? withProfileContacts(
            ownRow,
            await loadProfileContacts(supabase, ownRow.id),
          )
        : null;
      profileLoadFailedRef.current = false;
      // Publish the profile BEFORE the account queries, not after. The two
      // calls below are five more round trips, and for their whole duration
      // profileChecked was true while profile was still null - which is
      // exactly the state the signed-out marketing hero renders on. Every
      // returning member was shown 'Join SideSpace' and a marketing page
      // until those finished.
      setProfile(own);
      // Seed the onboarding state before marking the profile ready. The
      // public CTA can ask the dashboard to reopen setup as soon as this read
      // completes, and it must see the saved answers rather than blank state.
      // Background auth events still leave an active onboarding session alone.
      if (!onboardingOpenRef.current) {
        const stored = own?.role ? canonicalRole(own.role) : null;
        const pickable =
          stored && PICKABLE_ROLES.includes(stored) ? stored : null;
        setSelectedRole(pickable);
        setRoleTouched(Boolean(pickable));
        setExtraRoles(
          ((own?.extra_roles as Role[] | undefined) ?? []).filter((role) =>
            EXTRA_ROLE_OPTIONS.includes(role),
          ),
        );
        setAnswers(answersFromProfile((own as Profile | null) ?? null));
        if (!own?.onboarding_complete) {
          setOnboardingMode("setup");
          setOnboardingStep(1);
          setOnboardingInvalidField("");
          setOnboardingOpen(true);
        }
      }
      setProfileChecked(true);
      if (own) {
        await Promise.all([
          loadOwnListings(own),
          loadAccountMarketplaceState(own),
          loadListingAnalytics(),
        ]);
      } else {
        setOwnListings([]);
        // A signed-in member with no profile row yet cannot have blocked
        // anyone. loadAccountMarketplaceState is the only other place that
        // sets this, and it never runs on this branch - so without it
        // blocksPending stayed true forever and the marketplace grid was
        // frozen on skeletons for every user mid-signup.
        blockedIdsRef.current = [];
        setBlockedProfileIds([]);
        setBlockedProfiles([]);
        setBlockedLoaded(true);
      }
    },
    [
      loadAccountMarketplaceState,
      loadListingAnalytics,
      loadOwnListings,
      setToast,
      supabase,
    ],
  );

  useEffect(() => {
    if (!supabase) return;

    let mounted = true;
    const startup = window.setTimeout(() => {
      const needsMarketplaceInventory = [
        "home",
        "marketplace",
        "creators",
        // The business dashboard ranks creator posts from this same bounded,
        // public inventory. Without the fetch, it stayed on demo fallbacks
        // even after the member's account and preferences had loaded.
        "dashboard",
      ].includes(route);
      void Promise.all([
        supabase.auth.getUser(),
        needsMarketplaceInventory ? loadMarketplace() : Promise.resolve(),
      ]).then(
        ([authResult]) => {
          if (!mounted) return;
          const currentUser = authResult.data.user;
          setUser(currentUser);
          if (currentUser) {
            lastAuthUserIdRef.current = currentUser.id;
            void loadLikedListings(currentUser);
            void loadOwnProfile(currentUser);
          }
          setSessionResolved(true);
          setLoading(false);
        },
      );
    }, 0);

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (event: AuthChangeEvent, session: Session | null) => {
      const currentUser = session?.user ?? null;
      setUser(currentUser);
      setSessionResolved(true);
      if (currentUser) {
        // Supabase fires TOKEN_REFRESHED in the background and re-fires
        // SIGNED_IN whenever the tab regains focus. Those say nothing new
        // about the profile, and reloading on them churned state underneath
        // open modals - resetting onboarding mid-typing. Reload only when
        // the signed-in user actually changes or their account was updated.
        const isDifferentUser = lastAuthUserIdRef.current !== currentUser.id;
        lastAuthUserIdRef.current = currentUser.id;
        if (isDifferentUser) {
          void loadLikedListings(currentUser);
        }
        if (
          isDifferentUser ||
          event === "USER_UPDATED" ||
          event === "PASSWORD_RECOVERY"
        ) {
          window.setTimeout(() => void loadOwnProfile(currentUser), 0);
        }
        if (event === "PASSWORD_RECOVERY") {
          setAccountOpen(true);
          setToast("Choose a new password in Profile & settings.");
        }
      } else {
        // A background sign-out must wipe exactly what an explicit one wipes.
        // This branch used to clear a smaller set, leaving the previous
        // member's unread badge on screen for the next person.
        lastAuthUserIdRef.current = null;
        threadSeqRef.current += 1;
        clearSessionState();
      }
      },
    );

    return () => {
      mounted = false;
      window.clearTimeout(startup);
      subscription.unsubscribe();
    };
  }, [
    loadLikedListings,
    loadMarketplace,
    loadOwnProfile,
    route,
    setToast,
    supabase,
  ]);

  useEffect(() => {
    if (!configured) return;

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const publishableKey =
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if (!supabaseUrl || !publishableKey) return;

    let mounted = true;
    void fetch(`${supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: publishableKey },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((settings: { external?: { google?: boolean } } | null) => {
        if (mounted) {
          setGoogleOAuthEnabled(Boolean(settings?.external?.google));
        }
      })
      .catch(() => {
        if (mounted) setGoogleOAuthEnabled(false);
      });

    return () => {
      mounted = false;
    };
  }, [configured]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3600);
    return () => window.clearTimeout(timer);
  }, [setToast, toast]);

  // Badge updates whether or not the inbox is open. RLS scopes the stream to
  // conversations this member belongs to.
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  // Keyed on profile.id rather than the profile object, and reading everything
  // else through refs. Listing activeThread here rejoined the websocket on
  // every thread open and close, and postgres_changes never replays what was
  // committed during the gap - so messages that landed mid-switch were missed
  // by the badge entirely.
  const profileId = profile?.id ?? null;
  useEffect(() => {
    if (!supabase || !profileId) return;
    const channel = supabase
      .channel(`inbound-messages:${profileId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload: { new: Record<string, unknown> }) => {
          const incoming = payload.new as unknown as Message;
          if (incoming.sender_profile_id === profileId) return;
          // A blocked member's thread is hidden from the inbox, so counting
          // their message would raise a badge nothing on screen can clear.
          if (blockedIdsRef.current.includes(incoming.sender_profile_id)) {
            return;
          }
          const openThread = activeThreadRef.current;
          if (openThread && incoming.conversation_id === openThread.id) {
            return;
          }
          setUnreadCount((current) => current + 1);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [profileId, supabase]);

  useEffect(() => {
    if (!supabase || !activeThread) return;
    const channel = supabase
      .channel(`messages:${activeThread.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${activeThread.id}`,
        },
        (payload: { new: Record<string, unknown> }) => {
          const incoming = payload.new as unknown as Message;
          setMessages((current) =>
            current.some((message) => message.id === incoming.id)
              ? current
              : [...current, incoming],
          );
          // The member is looking at this thread, so the message is read as
          // soon as it lands. Without writing that back, the global listener's
          // increment is never cancelled and the badge keeps a phantom unread
          // for a message already on screen.
          if (profile && incoming.sender_profile_id !== profile.id) {
            void supabase
              .from("messages")
              .update({ read_at: new Date().toISOString() })
              .eq("id", incoming.id)
              .is("read_at", null)
              .then(() => reconcileUnreadCount(profile));
          }
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [activeThread, supabase]);

  // Nothing above recovers rows missed while the websocket was down:
  // postgres_changes delivers only what is committed while the channel is
  // joined, and rejoining does not replay the gap. A member who closes the
  // lid mid-conversation therefore comes back to a transcript that says the
  // other side never replied. Re-read the open thread whenever the tab
  // returns to the foreground or the network comes back.
  useEffect(() => {
    activeThreadRef.current = activeThread;
  }, [activeThread]);

  useEffect(() => {
    if (!supabase || !profile) return;

    let running = false;
    async function resync() {
      if (!supabase || !profile || running) return;
      running = true;
      try {
        const thread = activeThreadRef.current;
        if (thread) {
          const { data, error } = await supabase
            .from("messages")
            .select("*")
            .eq("conversation_id", thread.id)
            // Same bound as loadMessages: newest-first with an explicit limit,
            // reversed for display, so the 1000-row cap cannot truncate away
            // the recent end of a long thread.
            .order("created_at", { ascending: false })
            .limit(MESSAGE_PAGE_SIZE);
          // Ignore a resync for a thread the member has since left.
          if (!error && activeThreadRef.current?.id === thread.id) {
            const rows = ((data as Message[] | null) ?? []).slice().reverse();
            setMessages((current) => {
              // Merge rather than replace so an in-flight optimistic send is
              // not dropped by a resync that raced it.
              const seen = new Set(rows.map((row) => row.id));
              const pending = current.filter((m) => !seen.has(m.id));
              return pending.length ? [...rows, ...pending] : rows;
            });
            const unread = rows.filter(
              (m) => m.sender_profile_id !== profile.id && !m.read_at,
            );
            if (unread.length) {
              await supabase
                .from("messages")
                .update({ read_at: new Date().toISOString() })
                .eq("conversation_id", thread.id)
                .neq("sender_profile_id", profile.id)
                .is("read_at", null);
            }
          }
        }
        await reconcileUnreadCount(profile);
      } finally {
        running = false;
      }
    }

    function onVisible() {
      if (document.visibilityState === "visible") void resync();
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      window.removeEventListener("focus", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, supabase]);

  /** Real listings lead the hero preview; samples only pad it out. */
  const heroListings = useMemo(
    () =>
      listings
        .filter(
          (listing) =>
            !isInternalAccount(listing.owner) &&
            !blockedProfileIds.includes(listing.owner.id),
        )
        .sort((a, b) => Number(a.owner.is_demo) - Number(b.owner.is_demo))
        .slice(0, 4),
    [blockedProfileIds, listings],
  );

  /**
   * The four figures in the stat band, all derived from what is actually
   * on the marketplace rather than written down anywhere. A hard-coded
   * number here would drift the moment a member publishes or pauses, and
   * this band sits directly above the grid that would contradict it.
   */
  const marketplaceStats = useMemo(() => {
    const live = listings.filter(
      (listing) =>
        !isInternalAccount(listing.owner) &&
        !blockedProfileIds.includes(listing.owner.id),
    );
    const cities = new Set(
      live
        .map((listing) =>
          // Members write their city freehand, so "Fullerton, CA" and
          // "Fullerton" are one place and must not count twice.
          String(listingCity(listing) ?? "")
            .split(",")[0]
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    );
    const owners = new Set(live.map((listing) => listing.owner.id));
    const channelKinds = new Set(live.map((listing) => listing.channel));
    return {
      listings: live.length,
      members: owners.size,
      cities: cities.size,
      channels: channelKinds.size,
    };
  }, [blockedProfileIds, listings]);

  const ownerIdsWithListings = useMemo(
    () => new Set(listings.map((listing) => listing.owner.id)),
    [listings],
  );

  // Live listing count per member, for the showcase cards.
  const listingCountByOwner = useMemo(() => {
    const counts = new Map<string, number>();
    for (const listing of listings) {
      counts.set(listing.owner.id, (counts.get(listing.owner.id) ?? 0) + 1);
    }
    return counts;
  }, [listings]);

  /** 0 = real member with listings, 1 = real member without, 2 = sample. */
  function rankPerson(person: Profile) {
    if (person.is_demo) return 2;
    return ownerIdsWithListings.has(person.id) ? 0 : 1;
  }

  // Every real member, listings first and bigger audiences first; demo
  // profiles only pad the row while the community is still smaller than one
  // screen of cards.
  const showcasePeople = useMemo(() => {
    const visible = profiles.filter(
      (person) =>
        !blockedProfileIds.includes(person.id) && !isInternalAccount(person),
    );
    const ranked = visible
      .slice()
      .sort(
        (a, b) =>
          rankPerson(a) - rankPerson(b) ||
          (b.followers || b.avg_views) - (a.followers || a.avg_views) ||
          a.display_name.localeCompare(b.display_name),
      );
    // Only the demo padding used to be capped, so the real-member list grew
    // without bound - every profile in the table rendered into a single
    // horizontal flex row, each with its own avatar request. Cap both.
    const real = ranked
      .filter((person) => !person.is_demo)
      .slice(0, SHOWCASE_LIMIT);
    const demoFill = ranked
      .filter((person) => person.is_demo)
      .slice(0, Math.max(0, 8 - real.length));
    return [...real, ...demoFill];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, blockedProfileIds, ownerIdsWithListings]);

  const channels = useMemo(
    () => [
      "All",
      // Built from live data, so a test account's channel would otherwise add
      // its own filter chip to the marketplace.
      ...Array.from(
        new Set(
          listings
            .filter(
              (item) =>
                !isInternalAccount(item.owner) &&
                // A blocked member's chip is a filter that can only ever
                // return nothing, and it leaks that they still have a
                // listing in that category.
                !blockedProfileIds.includes(item.owner.id),
            )
            .map((item) => item.channel),
        ),
      ),
    ],
    [blockedProfileIds, listings],
  );

  // A filter can outlive its chip: pause or re-channel the last listing in a
  // category and the selected channel no longer exists. Left as-is the grid
  // renders empty and reports "0 open listings" while every chip, "All"
  // included, shows unpressed, so nothing on screen explains the emptiness.
  // Derived rather than corrected in an effect, which would cost a second
  // render and still paint one frame of the empty grid.
  const activeChannel =
    !listings.length || channels.includes(channelFilter)
      ? channelFilter
      : "All";

  // Suggestions come from the same public city/area labels used on cards.
  // They are not reverse-geocoded and never include street addresses.
  const locationOptions = useMemo(() => {
    const values = new Set<string>();
    for (const listing of listings) {
      if (blockedProfileIds.includes(listing.owner.id)) continue;
      if (isInternalAccount(listing.owner)) continue;
      const location = listingCity(listing).trim();
      if (location) values.add(location);
    }
    return Array.from(values).sort((left, right) =>
      compareLocations(left, right, localeTag(locale)),
    );
  }, [blockedProfileIds, listings, locale]);

  // True while we know there is a member but not yet who they have blocked.
  // The server-rendered markup is shared and cached, so it cannot leave
  // blocked listings out; the client has to hold them back until it knows.
  const blocksPending = Boolean(user) && !blockedLoaded;

  // Derived rather than filtered at load time, so a block list that resolves
  // after the inbox opened still hides the thread. Leaving it visible left a
  // composer whose every send failed at the RLS layer, blaming a paused
  // listing rather than the block the member applied themselves.
  const visibleThreads = useMemo(
    () =>
      threads.filter((thread) => !blockedProfileIds.includes(thread.other.id)),
    [blockedProfileIds, threads],
  );

  const visibleListings = useMemo(() => {
    // Show nothing rather than something they asked never to see again.
    // The grid renders a skeleton for this case, so it reads as loading
    // rather than as an empty marketplace.
    if (blocksPending) return [];
    const normalized = query.trim().toLowerCase();
    const normalizedLocation = locationQuery.trim();
    const popularityNow = listingSort === "popular" ? Date.now() : 0;
    return listings.filter((listing) => {
      if (blockedProfileIds.includes(listing.owner.id)) return false;
      // A test account's listings must not appear in the marketplace, the
      // channel filters, or the "N open listings" count.
      if (isInternalAccount(listing.owner)) return false;
      // Direction matters more than who posted it: a business can offer space
      // (Troy VEX sells Instagram posts) and a creator can want space. Only
      // the "Business brief" channel means "wanted".
      const wanted = isBrief(listing);
      const roleMatches =
        roleFilter === "all" ||
        (roleFilter === "business"
          ? wanted
          : roleFilter === "supply"
            ? !wanted
            : !wanted && profileHasRole(listing.owner, roleFilter));
      const channelMatches =
        activeChannel === "All" || listing.channel === activeChannel;
      const locationMatches =
        !normalizedLocation ||
        locationMatchScore(listingCity(listing), normalizedLocation) > 0;
      const copy = listing;
      // Includes the listing's own location and offer line: both are shown on
      // the card, so searching "Walnut" or "decal" should find them. Optional
      // fields are coalesced so the literal string "undefined" never becomes
      // searchable text.
      //
      // The owner's categories are in here because onboarding ASKS for them -
      // a twelve-chip multi-select every creator and business taps through -
      // and until now the answer was stored, published to anonymous readers,
      // and read by nothing except one sentence of a draft description. A
      // question that changes nothing is a question that should not be asked;
      // making it searchable is the cheaper of the two ways to fix that.
      const text = [
        copy.title,
        listing.channel,
        copy.description,
        copy.demographics,
        copy.format,
        listing.location_area ?? "",
        listing.owner.display_name,
        listing.owner.city,
        (listing.owner.categories ?? []).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return (
        roleMatches &&
        channelMatches &&
        locationMatches &&
        (!normalized || text.includes(normalized))
      );
    })
      // Members first, samples last; within each band the order is mixed
      // rather than newest-first so one fresh post cannot dominate the top.
      .sort(
        (a, b) =>
          (listingSort === "location"
            ? locationMatchScore(listingCity(b), normalizedLocation) -
                locationMatchScore(listingCity(a), normalizedLocation) ||
              compareLocations(listingCity(a), listingCity(b), localeTag(locale))
            : listingSort === "popular"
              ? comparePopularListings(a, b, popularityNow)
              : 0) ||
          listingRank(a) - listingRank(b) ||
          shuffleKey(a.id) - shuffleKey(b.id),
      );
  }, [
    activeChannel,
    blocksPending,
    blockedProfileIds,
    listingSort,
    listings,
    locale,
    locationQuery,
    query,
    roleFilter,
  ]);
  const requestableListingCount = useMemo(
    () => visibleListings.filter((listing) => isListingRequestable(listing)).length,
    [visibleListings],
  );

  /**
   * Count a listing as seen only once somebody actually reached it.
   *
   * Re-attached whenever the grid changes, because filtering swaps the cards
   * out underneath. Every card is unobserved the moment it counts, so this
   * stays cheap however long the page gets.
   */
  useEffect(() => {
    if (route !== "marketplace") return;
    return watchListingImpressions(document);
  }, [route, visibleListings]);

  /**
   * What this browser has looked at lately, read once per marketplace visit.
   *
   * Deliberately not reactive: re-reading on every render would re-rank the row
   * under the member's cursor as they browsed, which is worse than a row that
   * settles when the page loads.
   */
  const [visitorAffinity, setVisitorAffinity] = useState<
    ReturnType<typeof affinityEvents>
  >([]);
  useEffect(() => {
    if (route !== "marketplace") return;
    // Deferred rather than set synchronously: localStorage cannot be read
    // while rendering without the server and the client disagreeing about the
    // first paint, and setting state straight from an effect makes React
    // render twice for nothing. The startup effect defers the same way.
    const timer = window.setTimeout(() => setVisitorAffinity(affinityEvents()), 0);
    return () => window.clearTimeout(timer);
  }, [route]);

  /**
   * "People who looked at that looked at this", fetched for the handful of
   * listings this visitor has shown interest in.
   *
   * Returns nothing until the site has traffic, and the recommender is written
   * to expect that - so this is a no-op today and an upgrade later, with no
   * further change here.
   */
  useEffect(() => {
    if (!supabase || route !== "marketplace" || !visitorAffinity.length) return;
    let cancelled = false;
    const seeds = [...new Set(visitorAffinity.map((event) => event.listingId))].slice(0, 20);
    void (async () => {
      const { data, error } = await supabase.rpc("listing_cooccurrence", {
        seed_ids: seeds,
      });
      if (cancelled || error || !Array.isArray(data)) return;
      const index: CooccurrenceIndex = new Map();
      for (const row of data as Array<{
        listing_id: string;
        paired_listing_id: string;
        visitors: number;
      }>) {
        const inner = index.get(row.listing_id) ?? new Map<string, number>();
        inner.set(row.paired_listing_id, Number(row.visitors) || 0);
        index.set(row.listing_id, inner);
      }
      setCooccurrence(index);
    })();
    return () => {
      cancelled = true;
    };
  }, [route, supabase, visitorAffinity]);

  /**
   * The row above the grid.
   *
   * Scored over the listings already in memory rather than through a server
   * ranking call - with a catalogue this size that is both simpler and faster.
   * Past a few hundred listings it would need to move behind an RPC.
   */
  const forYou = useMemo(() => {
    if (route !== "marketplace" || blocksPending || !listings.length) {
      return { items: [], personalised: false };
    }
    return recommendListings({
      candidates: listings,
      events: visitorAffinity,
      nowMs: Date.now(),
      viewerProfileId: profile?.id ?? null,
      blockedProfileIds: new Set(blockedProfileIds),
      cooccurrence,
      limit: 4,
    });
  }, [
    blockedProfileIds,
    blocksPending,
    cooccurrence,
    listings,
    profile?.id,
    route,
    visitorAffinity,
  ]);

  const creatorRecommendations = useMemo(
    () =>
      profile?.role === "business" && !blocksPending
        ? creatorPostRecommendations(
            listings,
            profile,
            ownListings,
            blockedProfileIds, t,
          )
        : [],
    [blocksPending, blockedProfileIds, listings, ownListings, profile, t],
  );

  // Reveal widgets as they scroll into view, and cycle the how-it-works steps
  // so the section reads as something live rather than static copy.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]"),
    );
    if (reduceMotion || !("IntersectionObserver" in window)) {
      targets.forEach((element) => element.classList.add("is-visible"));
      return;
    }
    // Content is visible by default; only opt into the hidden start state
    // once we know the observer is running, so a failure can never leave
    // real content invisible.
    document.documentElement.classList.add("reveal-ready");
    const observer = new IntersectionObserver(
      (entries) => {
        // Elements that cross the line in the same callback are one group, so
        // they get a short stagger and arrive as a sequence rather than a
        // single slab. `--reveal-delay` had been read by the stylesheet and
        // never written by anything, which is why every reveal until now
        // fired in unison.
        let inBatch = 0;
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const element = entry.target as HTMLElement;
            if (inBatch > 0) {
              element.style.setProperty(
                "--reveal-delay",
                `${Math.min(inBatch, 4) * 55}ms`,
              );
            }
            inBatch += 1;
            element.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.15 },
    );
    targets.forEach((element) => observer.observe(element));
    // Backstop: whatever has not revealed within a few seconds is shown
    // anyway, so a stuck observer never hides the page.
    const failsafe = window.setTimeout(() => {
      targets.forEach((element) => element.classList.add("is-visible"));
    }, 3000);

    /*
     * Sections that mount later still get observed.
     *
     * `reveal-ready` holds every [data-reveal] at opacity 0 until the observer
     * says otherwise, and the observer only ever sees the elements that
     * existed when this effect last ran. A section gated on data that arrives
     * afterwards - payments on a Stripe round-trip, analytics on the member's
     * own listings - therefore mounts into a document that hides it and never
     * looks at it again, and stays invisible for the life of the page.
     *
     * That has now happened three times, each time fixed by adding one more
     * dependency, which only ever fixes the section somebody already noticed.
     * Watching the tree instead closes the whole class: whatever mounts, gets
     * observed, gets revealed.
     */
    const watchLateArrivals = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const late = node.matches("[data-reveal]")
            ? [node]
            : Array.from(node.querySelectorAll<HTMLElement>("[data-reveal]"));
          for (const element of late) {
            if (element.classList.contains("is-visible")) continue;
            observer.observe(element);
            // The original failsafe's list was captured before this element
            // existed, so it needs its own.
            window.setTimeout(() => element.classList.add("is-visible"), 3000);
          }
        }
      }
    });
    watchLateArrivals.observe(document.body, { childList: true, subtree: true });

    return () => {
      window.clearTimeout(failsafe);
      observer.disconnect();
      watchLateArrivals.disconnect();
    };
  }, [listings, user, profile, paymentTransactions.length]);

  // The cycle used to start on mount and never stop, so by the time anyone
  // scrolled this far the band was mid-story - you would arrive at step 02 or
  // 03 with no idea you had missed the beginning. It runs only while the band
  // is on screen now, and rewinds to 01 every time it comes back into view, so
  // the first thing anyone sees is the first step. Leaving the viewport drops
  // `steps-live`, which parks the widgets on their finished, readable frame
  // and lets the whole story restart in sync on the way back.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const band = stepsRef.current;
    if (!band) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // `"IntersectionObserver" in window` would narrow `window` to never in the
    // else branch, which is where the timer lives.
    if (typeof IntersectionObserver === "undefined") {
      // No observer: better a band that cycles from the top than one frozen
      // on step 01 forever. Deferred a frame rather than set synchronously,
      // which would cascade a second render out of this effect.
      const frame = window.requestAnimationFrame(() => setStepsLive(true));
      const fallback = window.setInterval(() => {
        setActiveStep((current) => (current + 1) % 3);
      }, STEP_CYCLE_MS);
      return () => {
        window.cancelAnimationFrame(frame);
        window.clearInterval(fallback);
      };
    }
    let timer = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (timer) return;
          setActiveStep(0);
          setStepsLive(true);
          // Matches the widget animation cycle so each story finishes before
          // the section moves on.
          timer = window.setInterval(() => {
            setActiveStep((current) => (current + 1) % 3);
          }, STEP_CYCLE_MS);
        } else {
          window.clearInterval(timer);
          timer = 0;
          setStepsLive(false);
          setActiveStep(0);
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(band);
    return () => {
      window.clearInterval(timer);
      observer.disconnect();
    };
  }, []);

  // The callback route exchanges the recovery code server-side, so the client
  // never sees a PASSWORD_RECOVERY event. The ?recovery=1 marker it redirects
  // back with is what opens the new-password form.
  useEffect(() => {
    if (typeof window === "undefined" || !user) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("recovery") !== "1") return;
    url.searchParams.delete("recovery");
    window.history.replaceState({}, "", url.toString());
    const timer = window.setTimeout(() => {
      setAccountOpen(true);
      setToast("Choose a new password below.");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [setToast, user]);

  // The auth callback redirects here with ?authError=callback when the code
  // exchange fails. Without this the member lands back on the signed-out page
  // with no explanation, having just approved the Google consent screen or
  // clicked a confirmation link, and cannot tell whether the account exists.
  // No `user` dependency: the whole point is that they are not signed in.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("authError") !== "callback") return;
    url.searchParams.delete("authError");
    window.history.replaceState({}, "", url.toString());
    const timer = window.setTimeout(() => {
      setToast(
        "We could not finish signing you in. That link may have expired or been opened in a different browser. Try again below.",
      );
      setAuthMode("signin");
      setAuthOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [setToast]);

  // Lightweight public pages hand account actions to the dedicated dashboard
  // instead of shipping this entire marketplace engine in their first bundle.
  // Consume the one-shot intent here, then remove it so refresh/back never
  // reopens a dialog the visitor already dismissed.
  useEffect(() => {
    if (
      route !== "dashboard" ||
      !sessionResolved ||
      typeof window === "undefined"
    ) {
      return;
    }
    const url = new URL(window.location.href);
    const requestedMode = url.searchParams.get("auth");
    if (requestedMode !== "signin" && requestedMode !== "signup") return;
    url.searchParams.delete("auth");
    window.history.replaceState({}, "", url.toString());
    if (requestedMode === "signup" && user) return;
    const timer = window.setTimeout(() => {
      setAuthMode(requestedMode);
      setAuthOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [route, sessionResolved, user]);

  useEffect(() => {
    if (route !== "dashboard" || !profile || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const checkout = url.searchParams.get("checkout");
    const connect = url.searchParams.get("connect");
    if (!checkout && !connect) return;
    url.searchParams.delete("checkout");
    url.searchParams.delete("session_id");
    url.searchParams.delete("connect");
    window.history.replaceState({}, "", url.toString());
    const timer = window.setTimeout(() => {
      setAccountOpen(true);
      setToast(
        checkout === "success"
          ? "Payment submitted. Stripe is confirming it now."
          : checkout === "cancelled"
            ? "Checkout was cancelled. Nothing was marked paid."
            : connect === "return"
              ? "Stripe setup returned successfully. We are refreshing your payout status."
              : "Continue the secure Stripe setup to receive payouts.",
      );
      void loadAccountMarketplaceState(profile);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAccountMarketplaceState, profile, route, setToast]);

  useEffect(() => {
    if (selectedListing || typeof window === "undefined") return;
    // Blocks load after the marketplace, so opening a deep link before they
    // are known would show a blocked member's listing, and the early return
    // above then stops the effect ever re-checking.
    // Two separate waits, and conflating them broke one audience or the
    // other: `user` is null on the first render whether or not anyone is
    // signed in, and profileChecked only turns true for members WITH a
    // profile - gating on it killed every shared link for signed-out
    // visitors. So: wait for the session answer always, and for the block
    // list only when there is someone whose blocks could apply.
    if (!sessionResolved) return;
    if (user && !blockedLoaded) return;
    const listingId = new URL(window.location.href).searchParams.get("listing");
    if (!listingId) return;
    // Resolve against the blocked filter too, or a deep link would open a
    // listing from someone the member blocked - which the branch below already
    // claims to handle.
    const linkedListing = listings.find(
      (listing) =>
        listing.id === listingId &&
        !blockedProfileIds.includes(listing.owner.id),
    );
    if (linkedListing) {
      const timer = window.setTimeout(() => {
        setSelectedPhotoIndex(0);
        setSelectedListing(linkedListing);
        void recordListingView(linkedListing.id);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    // The link points at a listing that is paused, removed, hidden by a block
    // - or simply outside the 200 most recent, which is all `listings` holds.
    // Nothing else in the app ever fetches a listing by id, so a shared link
    // to the 201st listing reported it "no longer available" while it was
    // live and browsable. Ask the database before saying that.
    if (loading || !listings.length) return;
    let cancelled = false;
    void (async () => {
      if (supabase) {
        const [listingResult, likeCountsResult] = await Promise.all([
          supabase
            .from("listings")
            // A deep link, so anyone with the URL gets this row - narrowed for
            // the same reason as the grid.
            .select(
              `${PUBLIC_LISTING_COLUMNS}, owner:profiles!listings_owner_profile_id_fkey(${PUBLIC_PROFILE_COLUMNS})`,
            )
            .eq("id", listingId)
            .eq("status", "active")
            .maybeSingle(),
          supabase
            .from("listing_like_counts")
            .select(LISTING_LIKE_COUNT_COLUMNS)
            .eq("listing_id", listingId)
            .maybeSingle(),
        ]);
        if (cancelled) return;
        const [resolved] = safeListings(
          mergeListingLikeCounts(
            listingResult.data ? [listingResult.data] : [],
            likeCountsResult.error ? null : likeCountsResult.data ? [likeCountsResult.data] : [],
          ),
        );
        if (resolved && !blockedProfileIds.includes(resolved.owner.id)) {
          setSelectedPhotoIndex(0);
          setSelectedListing(resolved);
          void recordListingView(resolved.id);
          return;
        }
      }
      if (cancelled) return;
      setToast("That listing is no longer available.");
      const url = new URL(window.location.href);
      url.searchParams.delete("listing");
      window.history.replaceState({}, "", url.toString());
    })();
    return () => {
      cancelled = true;
    };
  }, [
    blockedLoaded,
    blockedProfileIds,
    listings,
    loading,
    recordListingView,
    selectedListing,
    sessionResolved,
    setToast,
    supabase,
    user,
  ]);

  function captureCurrentLocation() {
    if (!navigator.geolocation) {
      setLocationError(
        tx("This browser cannot share a U.S. location. Choose a U.S. city and state instead."),
      );
      return;
    }

    setLocationError("");
    setLocationBusy(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const location = normalizeLocationPoint({
          latitude: coords.latitude,
          longitude: coords.longitude,
        });
        if (!location) {
          setLocationBusy(false);
          setLocationError(
            tx("We could not read a usable location. Type your city and state instead."),
          );
          return;
        }
        void fetch(
          `/api/geo?lat=${encodeURIComponent(String(coords.latitude))}&lon=${encodeURIComponent(String(coords.longitude))}`,
        )
          .then(async (response) => {
            const body = (await response.json()) as {
              place?: { label?: string; countryCode?: string };
              error?: string;
            };
            if (
              !response.ok ||
              !body.place?.label ||
              body.place.countryCode !== "US"
            ) {
              throw new Error(body.error || "lookup failed");
            }
            setAnswers((current) => ({
              ...current,
              city: body.place!.label!,
              location,
            }));
          })
          .catch(() => {
            setLocationError(
              tx("SideSpace currently supports U.S. locations only. Choose a U.S. city and state instead."),
            );
          })
          .finally(() => {
            setLocationBusy(false);
          });
      },
      (error) => {
        setLocationBusy(false);
        setLocationError(
          tx(error.code === 1
            ? "Location permission was not granted. Choose a U.S. city and state instead."
            : error.code === 2
              ? "We could not find your location. Choose a U.S. city and state instead."
              : "Finding your location took too long. Choose a U.S. city and state instead."),
        );
      },
      {
        enableHighAccuracy: false,
        maximumAge: 5 * 60 * 1000,
        timeout: 10 * 1000,
      },
    );
  }

  /**
   * Seed BOTH role pickers from the stored profile. Openers used to seed only
   * the primary role, so extra roles toggled during an edit the member then
   * abandoned - or left behind by the previous account on a shared device -
   * were still in state and got written on the next save.
   */
  function seedRolePickers(source: Profile | null) {
    const stored = source?.role ? canonicalRole(source.role) : null;
    // A retired `consumer` row has no card to highlight, so treat it as
    // unanswered and make them choose rather than pre-selecting something they
    // never picked.
    //
    // With no stored profile at all, an invite stands in: the queue already
    // decided what to write to this business, so it can decide which flow they
    // land in. A member who HAS a profile is never overridden by a link.
    const pickable =
      stored && PICKABLE_ROLES.includes(stored)
        ? stored
        : !source && invite
          ? inviteRole(invite)
          : null;
    setSelectedRole(pickable);
    setRoleTouched(Boolean(pickable));
    setExtraRoles(
      ((source?.extra_roles as Role[] | undefined) ?? []).filter((role) =>
        EXTRA_ROLE_OPTIONS.includes(role),
      ),
    );
    setAnswers(answersFromProfile(source, invite));
    setOnboardingError("");
    setLocationError("");
    // Otherwise a second open keeps treating the generated title and
    // description as hand-written, and stops regenerating them.
    setTitleTouched(false);
    setDescriptionTouched(false);
    setAvatarFile(null);
    setAvatarCropPending(false);
    chooseListingFiles([]);
    setGalleryFiles([]);
  }

  function openAccountPanel() {
    setAccountOpen(true);
    if (profile) {
      setBusinessPreferencesDraft(
        businessPreferencesForProfile(profile, ownListings),
      );
      void loadOwnListings(profile);
    }
  }

  function openSignupOrDashboard() {
    if (user) {
      if (!profile?.onboarding_complete) {
        if (profileLoadFailedRef.current) {
          setToast(
            "We could not load your saved profile. Please refresh and try again.",
          );
          return;
        }
        // Let the profile load finish before opening setup, otherwise a
        // partially completed profile can be replaced by blank initial state.
        if (!profileChecked) {
          if (route !== "dashboard") {
            window.location.assign("/dashboard?onboarding=1");
          }
          return;
        }
        setAuthOpen(false);
        setOnboardingMode("setup");
        setOnboardingStep(1);
        setOnboardingInvalidField("");
        setOnboardingOpen(true);
        return;
      }
      if (route !== "dashboard") window.location.assign("/dashboard");
      return;
    }
    setAuthMode("signup");
    setAuthOpen(true);
  }

  // Public pages send profile intent through the lightweight dashboard route.
  // Consume it once after the member profile is ready so the header opens the
  // same Profile surface no matter where a signed-in member started.
  const profileIntentHandledRef = useRef(false);
  // Public pages use this one-shot intent to reopen setup for an account that
  // exists but has not completed onboarding yet.
  const onboardingIntentHandledRef = useRef(false);
  useEffect(() => {
    if (
      !openProfile ||
      !profile ||
      profileIntentHandledRef.current ||
      typeof window === "undefined"
    ) {
      return;
    }
    profileIntentHandledRef.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("profile");
    window.history.replaceState({}, "", url.toString());
    openAccountPanel();
    // openAccountPanel intentionally stays a local action rather than a
    // dependency: its closure is refreshed with the profile above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openProfile, profile]);

  // Public pages cannot ship the full onboarding engine, so an incomplete
  // signed-in member arrives here with a one-shot intent. Wait for the owner
  // profile read before opening so Google accounts with no profile row and
  // accounts with partially saved data both resume safely.
  useEffect(() => {
    if (
      !openOnboarding ||
      route !== "dashboard" ||
      !sessionResolved ||
      onboardingIntentHandledRef.current ||
      typeof window === "undefined"
    ) {
      return;
    }
    if (!user) {
      onboardingIntentHandledRef.current = true;
      const url = new URL(window.location.href);
      url.searchParams.delete("onboarding");
      window.history.replaceState({}, "", url.toString());
      return;
    }
    if (!profileChecked) return;

    onboardingIntentHandledRef.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("onboarding");
    window.history.replaceState({}, "", url.toString());
    if (
      profileLoadFailedRef.current ||
      profile?.onboarding_complete ||
      onboardingOpenRef.current
    ) {
      return;
    }
    setAuthOpen(false);
    setOnboardingMode("setup");
    setOnboardingStep(1);
    setOnboardingInvalidField("");
    setOnboardingOpen(true);
  }, [openOnboarding, profile, profileChecked, route, sessionResolved, user]);

  function updateCreatorOfferSelection(
    offer: CreatorOfferType,
    remove = false,
    activateOffer?: CreatorOfferType,
  ) {
    const currentOffers = selectedCreatorOffers(answers);
    const details = {
      ...answers.creatorOfferDetails,
    };
    const touched = {
      ...answers.creatorOfferTouched,
    };
    if (answers.creatorOffer) {
      details[answers.creatorOffer] = creatorOfferDetailsFromAnswers(answers);
      touched[answers.creatorOffer] = {
        title: titleTouched,
        description: descriptionTouched,
      };
    }
    const nextOffers = remove
      ? currentOffers.filter((item) => item !== offer)
      : currentOffers.includes(offer)
        ? currentOffers
        : [...currentOffers, offer];
    const nextActive =
      activateOffer ??
      (remove && answers.creatorOffer === offer
        ? nextOffers[0] ?? ""
        : answers.creatorOffer || offer);
    const nextDetails = nextActive
      ? details[nextActive] ?? emptyCreatorOfferDetails(nextActive)
      : emptyCreatorOfferDetails("social");
    const nextTouched = nextActive
      ? touched[nextActive] ?? { title: false, description: false }
      : { title: false, description: false };
    setTitleTouched(nextTouched.title);
    setDescriptionTouched(nextTouched.description);
    setAnswers({
      ...answers,
      creatorOffers: nextOffers,
      creatorOffer: nextActive,
      creatorOfferDetails: details,
      creatorOfferTouched: touched,
      ...cloneCreatorOfferDetails(nextDetails),
    });
  }

  function toggleCreatorOffer(offer: CreatorOfferType) {
    const selected = selectedCreatorOffers(answers);
    updateCreatorOfferSelection(offer, selected.includes(offer));
  }

  function switchCreatorOffer(offer: CreatorOfferType) {
    const offers = selectedCreatorOffers(answers);
    if (!offers.includes(offer)) return;
    const currentIndex = answers.creatorOffer
      ? offers.indexOf(answers.creatorOffer)
      : -1;
    const nextIndex = offers.indexOf(offer);
    if (currentIndex !== -1 && nextIndex !== currentIndex) {
      setCreatorOfferDirection(nextIndex > currentIndex ? 1 : -1);
    }
    updateCreatorOfferSelection(offer, false, offer);
  }

  async function saveBusinessPreferences(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (!supabase || !profile) {
      setToast("Sign in to save campaign preferences.", "problem");
      return;
    }
    setPreferencesSaving(true);
    const { error } = await saveProfileContacts(supabase, profile.id, {
      business_preferences: businessPreferencesDraft,
    });
    setPreferencesSaving(false);
    if (error) {
      setToast(friendlyDbError(error));
      return;
    }
    const saved = {
      ...profile,
      business_preferences: businessPreferencesDraft,
    } as Profile;
    setProfile(saved);
    setBusinessPreferencesDraft(
      normalizeBusinessPreferences(
        saved.business_preferences,
        saved.categories,
      ),
    );
    setToast("Campaign preferences saved. Recommendations are up to date.");
  }

  /**
   * Reopen onboarding to finish a listing.
   *
   * The only reader of the localStorage draft. It exists for one state: the
   * profile write succeeded and the listing write did not, so the member is on
   * the marketplace with nothing to book. Their answers come straight back
   * rather than being retyped into a different form.
   */
  function resumeOnboardingDraft() {
    seedRolePickers(profile);
    const draft = onboardingDraft;
    if (draft) {
      const draftRole = draft.role ? canonicalRole(draft.role) : null;
      if (draftRole && PICKABLE_ROLES.includes(draftRole)) {
        setSelectedRole(draftRole);
        setRoleTouched(true);
      }
      const draftAnswers = normalizeOnboardingAnswers(draft.answers);
      setAnswers(draftAnswers);
      const activeOffer = draftAnswers.creatorOffer;
      setTitleTouched(
        activeOffer
          ? draftAnswers.creatorOfferTouched[activeOffer].title
          : Boolean(draftAnswers.title),
      );
      setDescriptionTouched(
        activeOffer
          ? draftAnswers.creatorOfferTouched[activeOffer].description
          : Boolean(draftAnswers.description),
      );
    }
    setOnboardingMode("setup");
    setOnboardingStep(5);
    setOnboardingInvalidField("");
    setOnboardingOpen(true);
  }

  /** Open the modal as the profile editor rather than first-run setup. */
  function openProfileEditor(step: 1 | 2 = 1) {
    seedRolePickers(profile);
    setOnboardingPreview(false);
    setOnboardingMode("edit");
    setOnboardingStep(step);
    setOnboardingInvalidField("");
    setOnboardingOpen(true);
  }

  /**
   * Run the complete first-use flow without inventing a fake Supabase session.
   * This exists only in `next dev` when the public Supabase variables are
   * absent. Validation, progressive disclosure, transitions, and the final
   * listing preview are real; the final action deliberately writes nothing.
   */
  function openOnboardingPreview() {
    seedRolePickers(null);
    setOnboardingPreview(true);
    setOnboardingMode("setup");
    setOnboardingStep(1);
    setOnboardingInvalidField("");
    setAuthOpen(false);
    setOnboardingOpen(true);
  }

  function requireAccount(action: () => void) {
    if (localPreviewAvailable) {
      openOnboardingPreview();
      return;
    }
    if (!configured) {
      setToast(
        "Connect Supabase to enable public accounts and messaging.",
        "problem",
      );
      return;
    }
    // Every overlay shares one z-index and the listing detail is a later
    // sibling, so it paints OVER any dialog opened while it is up. Without
    // this, a signed-out visitor pressing the main CTA got an auth dialog
    // they could not see, with focus trapped inside it.
    if ((!user || !profile?.onboarding_complete) && selectedListing) {
      closeListing();
    }
    if (!user) {
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
    if (!profile?.onboarding_complete) {
      // Always setup, never the profile editor: this gate only fires for
      // someone who has not finished onboarding, and a stale "edit" mode would
      // hand them the editor and no way to publish anything.
      setOnboardingMode("setup");
      setOnboardingStep(1);
      setOnboardingInvalidField("");
      setOnboardingOpen(true);
      return;
    }
    action();
  }

  async function uploadImages(files: File[], folder: "profiles" | "listings") {
    if (!supabase || !user || !files.length) return [];
    if (files.length > 6) {
      throw new Error("Choose up to 6 photos at a time.");
    }

    // Validate the WHOLE batch before a single byte is uploaded. Checking
    // inside the loop meant a bad third file threw only after the first two
    // were already committed, and the bucket's SELECT policy makes anything
    // in it publicly readable forever with no way to delete it from the
    // product. The member was told the upload failed while their photos sat
    // on a public URL.
    for (const file of files) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        throw new Error(`${file.name} must be a JPG, PNG, or WebP image.`);
      }
      if (file.size > 8 * 1024 * 1024) {
        throw new Error(`${file.name} is larger than 8 MB.`);
      }
    }

    const uploaded: string[] = [];
    const paths: string[] = [];
    try {
      for (const file of files) {
        // A phone photo is several thousand pixels wide; nothing on the site
        // paints one larger than ~520px. Uploading the original meant every
        // visitor downloaded megabytes to fill a 42px avatar circle.
        // Downscale in the browser before it ever leaves the device.
        const prepared = await downscaleForUpload(
          file,
          folder === "profiles" ? 1024 : 1600,
        );
        const extension = prepared.extension;
        const path = `${user.id}/${folder}/${crypto.randomUUID()}.${extension}`;
        const { error } = await supabase.storage
          .from("marketplace-media")
          .upload(path, prepared.body, {
            contentType: prepared.contentType,
            upsert: false,
          });
        if (error) throw error;

        paths.push(path);
        const { data } = supabase.storage
          .from("marketplace-media")
          .getPublicUrl(path);
        uploaded.push(data.publicUrl);
      }
    } catch (error) {
      // Validation cannot catch everything: the network can drop, storage
      // can reject. A half-finished batch still leaves public files behind,
      // so take back what did land before reporting the failure. Best
      // effort by design - if the cleanup itself fails there is nothing
      // useful to tell the member, and the original error is the one that
      // matters.
      if (paths.length) {
        try {
          await supabase.storage.from("marketplace-media").remove(paths);
        } catch {
          // Swallowed on purpose. Reporting a cleanup failure on top of an
          // upload failure tells the member nothing they can act on.
        }
      }
      throw error;
    }
    return uploaded;
  }

  function patchListingLikeCount(listingId: string, likeCount: number) {
    setListings((current) =>
      current.map((listing) =>
        listing.id === listingId ? { ...listing, like_count: likeCount } : listing,
      ),
    );
    setOwnListings((current) =>
      current.map((listing) =>
        listing.id === listingId ? { ...listing, like_count: likeCount } : listing,
      ),
    );
    setSelectedListing((current) =>
      current?.id === listingId ? { ...current, like_count: likeCount } : current,
    );
  }

  async function refreshListingLikeCount(listingId: string) {
    if (!supabase) return;
    const { data, error } = await supabase
      .from("listing_like_counts")
      .select(LISTING_LIKE_COUNT_COLUMNS)
      .eq("listing_id", listingId)
      .maybeSingle();
    if (!error && data) {
      patchListingLikeCount(listingId, normalizeLikeCount(data.like_count));
    }
  }

  async function toggleListingLike(listing: Listing) {
    const listingId = listing.id;
    if (likeRequestsRef.current.has(listingId)) return;
    if (!supabase) {
      setToast("Sign in to like listings.", "problem");
      return;
    }
    if (!user) {
      setAuthMode("signin");
      setAuthOpen(true);
      setToast("Sign in to like listings.", "problem");
      return;
    }
    if (listing.owner.is_demo || profile?.id === listing.owner.id) {
      setToast("You cannot like your own listing.");
      return;
    }

    const currentUser = user;
    const wasLiked = likedListingIds.has(listingId);
    const previousCount = normalizeLikeCount(listing.like_count);
    const optimisticCount = Math.max(0, previousCount + (wasLiked ? -1 : 1));
    likeRequestsRef.current.add(listingId);
    setPendingLikeIds((current) => new Set(current).add(listingId));
    setLikedListingIds((current) => {
      const next = new Set(current);
      if (wasLiked) next.delete(listingId);
      else next.add(listingId);
      return next;
    });
    patchListingLikeCount(listingId, optimisticCount);

    try {
      const result = wasLiked
        ? await supabase
            .from("listing_likes")
            .delete()
            .eq("listing_id", listingId)
            .eq("user_id", currentUser.id)
        : await supabase.from("listing_likes").upsert(
            { listing_id: listingId, user_id: currentUser.id },
            { onConflict: "listing_id,user_id", ignoreDuplicates: true },
          );
      if (result.error) throw result.error;
      // Only a like teaches the row anything; taking one back should not.
      if (!wasLiked) trackLike(listingId);
      await refreshListingLikeCount(listingId);
    } catch (error) {
      if (lastAuthUserIdRef.current === currentUser.id) {
        setLikedListingIds((current) => {
          const next = new Set(current);
          if (wasLiked) next.add(listingId);
          else next.delete(listingId);
          return next;
        });
        patchListingLikeCount(listingId, previousCount);
        setToast(friendlyDbError(error));
      }
    } finally {
      likeRequestsRef.current.delete(listingId);
      setPendingLikeIds((current) => {
        const next = new Set(current);
        next.delete(listingId);
        return next;
      });
    }
  }

  function setListingSortAndUrl(next: ListingSort) {
    setListingSort(next);
    const url = new URL(window.location.href);
    if (next !== "latest") url.searchParams.set("sort", next);
    else url.searchParams.delete("sort");
    window.history.replaceState(null, "", url);
  }

  function setLocationAndUrl(next: string) {
    const trimmed = next.trim();
    setLocationQuery(next);
    const url = new URL(window.location.href);
    if (trimmed) {
      url.searchParams.set("location", trimmed);
      // A location search should feel stable: keep the strongest city/area
      // matches first instead of letting popularity shuffle them away.
      setListingSort("location");
      url.searchParams.set("sort", "location");
    } else {
      url.searchParams.delete("location");
      if (listingSort === "location") {
        setListingSort("latest");
        url.searchParams.delete("sort");
      }
    }
    window.history.replaceState(null, "", url);
  }

  function openListing(listing: Listing) {
    // The one place every detail open passes through - card, dashboard,
    // recommendation row, seller profile - so it is the one place a click has
    // to be recorded.
    trackClick(listing.id);
    setSelectedPhotoIndex(0);
    setStreetPanoOpen(false);
    setSelectedCreatorPortfolio([]);
    setSelectedCreatorReviews([]);
    setSelectedListing(listing);
    void recordListingView(listing.id);
    const url = new URL(window.location.href);
    url.searchParams.set("listing", listing.id);
    window.history.replaceState(null, "", url);
  }

  function closeListing() {
    setSelectedListing(null);
    setStreetPanoOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("listing");
    window.history.replaceState(null, "", url);
  }

  /**
   * The seller's profile, opened from the listing you are reading.
   *
   * A listing is one thing someone offers; the question a buyer asks next is
   * "what else have they got?". This answers it without leaving the listing -
   * the profile opens over it, and closing comes straight back.
   */
  async function openOwnerProfile(owner: Profile) {
    setSelectedOwner(owner);
    setOwnerListings([]);
    if (!supabase) return;
    setOwnerListingsLoading(true);
    const { data, error } = await supabase
      .from("listings")
      .select(
        `${PUBLIC_LISTING_COLUMNS}, owner:profiles!listings_owner_profile_id_fkey(${PUBLIC_PROFILE_COLUMNS})`,
      )
      .eq("owner_profile_id", owner.id)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(50);
    // A profile that cannot list its listings is still worth showing, so a
    // failure leaves the header and an empty state rather than an error.
    if (error) console.error("[owner profile] listings fetch failed", error);
    setOwnerListings(error ? [] : safeListings(data));
    setOwnerListingsLoading(false);
  }

  function closeOwnerProfile() {
    setSelectedOwner(null);
    setOwnerListings([]);
    setOwnerListingsLoading(false);
  }

  /**
   * Following a listing from the profile replaces the profile rather than
   * stacking on it: two dialogs deep, Escape stops meaning what a reader
   * expects it to mean.
   */
  function openListingFromProfile(listing: Listing) {
    closeOwnerProfile();
    openListing(listing);
  }

  async function handleAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    const values = new FormData(event.currentTarget);
    const email = String(values.get("email") ?? "").trim();
    const password = String(values.get("password") ?? "");
    setBusy(true);

    if (authMode === "signup") {
      const nextPath = authNextPath(referralCode);
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { display_name: String(values.get("name") ?? "").trim() },
          // Preserve personalized outreach through email confirmation just as
          // the Google flow does. Everyone else lands in the dedicated account
          // area instead of returning to a marketing page.
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`,
        },
      });
      setBusy(false);
      if (error) return setToast(friendlyDbError(error));
      setAuthOpen(false);
      if (data.session) {
        setUser(data.user);
        setOnboardingMode("setup");
        setOnboardingStep(1);
        setOnboardingInvalidField("");
        setOnboardingOpen(true);
      } else {
        setToast("Check your email to confirm your SideSpace account.");
      }
      return;
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setBusy(false);
    if (error) return setToast(friendlyDbError(error));
    setUser(data.user);
    setAuthOpen(false);
    window.location.assign("/dashboard");
  }

  /**
   * Which controls a role must answer before it can publish.
   *
   * Returned as [message, fieldName] so the caller can both explain the problem
   * and put the cursor on it. The old flow toasted and moved on; a toast is
   * gone in four seconds and never says where to look.
   */
  /**
   * Everything still unanswered on the current step, in the order it renders.
   *
   * This used to stop at the first problem, which is all publish needs - but
   * it meant the only way to find out how much was left was to press Publish,
   * get bounced to one field, fix it, and press again. A space owner answers
   * nine required questions on step 2; that is nine rounds of being surprised.
   * Collecting the whole list lets the flow say what is outstanding while they
   * are still filling it in.
   */
  function allMissingAnswers(): Array<[string, string]> {
    const role = selectedRole;
    const out: Array<[string, string]> = [];
    const need = (unmet: boolean, message: string, field: string) => {
      if (unmet) out.push([message, field]);
    };

    need(!roleTouched || !role, "Pick how you’ll use SideSpace first.", "role");
    need(
      !answers.display_name.trim(),
      "Add your display name before continuing.",
      "display_name",
    );
    need(
      !answers.city.trim(),
      "Add your city or market before continuing.",
      "city",
    );
    need(
      Boolean(answers.city.trim()) &&
        !isUnitedStatesPlaceLabel(answers.city.trim()),
      "Choose a U.S. city and state from the suggestions.",
      "city",
    );
    need(
      !bioMeetsRequirement(answers.bio, role),
      role === "business"
        ? "Describe your business in at least five words."
        : role === "creator"
          ? "Describe what you do in at least five words."
        : "Add one line about you — at least a few words.",
      "bio",
    );
    // Only a MALFORMED address is a problem; leaving it blank is allowed.
    need(
      role !== "business" &&
        Boolean(answers.contact_email.trim()) &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(answers.contact_email.trim()),
      "That email doesn't look right.",
      "contact_email",
    );

    // Edit mode only touches profile fields. Its second screen is optional.
    if (onboardingMode === "edit" || !role) return out;

    if (role === "creator") {
      const offers = selectedCreatorOffers(answers);
      need(
        !offers.length,
        "Choose at least one way you can advertise.",
        "creatorOffer",
      );
      for (const offer of offers) {
        const view = creatorOfferView(answers, offer);
        const field = (name: string) => "offer:" + offer + ":" + name;
        if (offer === "social") {
          need(
            !view.platforms.length,
            "Pick at least one place you post for your Online offer.",
            field("platforms"),
          );
          need(
            view.format.trim().length < 10,
            "Say what a brand actually gets in your Online offer.",
            field("format"),
          );
        }
        if (offer === "physical") {
          need(
            !view.spaceKind,
            "Pick what kind of space your Physical offer is.",
            field("spaceKind"),
          );
          need(
            !view.spaceSize.trim(),
            "Say roughly how big your Physical offer is.",
            field("spaceSize"),
          );
          need(
            !view.surfaces.length,
            "Pick what can actually go up in your Physical offer.",
            field("surfaces"),
          );
          need(
            view.surfaces.includes(SURFACE_OTHER) && !view.surfaceOther.trim(),
            "Say what else can go up in your Physical offer.",
            field("surfaceOther"),
          );
          need(
            !view.installBy,
            "Say who puts up your Physical offer.",
            field("installBy"),
          );
          need(
            !view.trafficCount || view.trafficCount < 1,
            "Add roughly how many people walk past your Physical offer a day.",
            field("trafficCount"),
          );
          need(
            !view.availability,
            "Pick when your Physical offer is free.",
            field("availability"),
          );
        }
        if (offer === "sponsorship") {
          need(
            !view.orgKind,
            "Pick what kind of organization your Sponsorship offer is.",
            field("orgKind"),
          );
          need(
            view.orgKind === SPONSOR_ORG_OTHER && !view.orgOther.trim(),
            "Say what kind of organization your Sponsorship offer is.",
            field("orgOther"),
          );
          need(
            !view.funding.trim(),
            "Say what your Sponsorship offer is raising for.",
            field("funding"),
          );
          need(
            !view.reachCount || view.reachCount < 1,
            "Add roughly how many people will see your Sponsorship offer.",
            field("reachCount"),
          );
          need(
            !view.season,
            "Pick how long your Sponsorship offer lasts.",
            field("season"),
          );
          need(
            !view.benefits.length,
            "Pick what a Sponsorship offer could give a sponsor.",
            field("benefits"),
          );
          out.push(
            ...tierProblems(view, t).map(
              ([message, tierField]) =>
                [message, field(tierField)] as [string, string],
            ),
          );
        }
        const touched =
          offer === answers.creatorOffer
            ? { title: titleTouched, description: descriptionTouched }
            : view.creatorOfferTouched?.[offer] ?? {
                title: false,
                description: false,
              };
        const shownTitle = effectiveTitle("creator", view, touched);
        const shownDescription = descriptionBody("creator", view, touched);
        if (offer !== "sponsorship") {
          need(
            shownTitle.trim().length < LISTING_READY_MIN.title,
            shownTitle.trim()
              ? "That " + creatorOfferLabel(offer) + " title is too short."
              : "Give your " + creatorOfferLabel(offer) + " offer a title.",
            field("title"),
          );
          need(
            !view.price || view.price < 1,
            "Set a price for your " + creatorOfferLabel(offer) + " offer.",
            field("price"),
          );
        }
        if (
          offer === "physical" &&
          typeof view.priceMax === "number" &&
          typeof view.price === "number" &&
          view.priceMax < view.price
        ) {
          need(
            true,
            "The top of your Physical price range is below the bottom.",
            field("priceMax"),
          );
        }
        need(
          shownDescription.trim().length < LISTING_READY_MIN.description,
          "Add a bit more detail to your " +
            creatorOfferLabel(offer) +
            " offer.",
          field("description"),
        );
      }
    }
    if (role === "business") {
      // Browse skips the brief entirely. Campaign fields stay required only
      // when they chose to post one.
      if (answers.businessSetupPath === "browse") {
        return out;
      }
      need(
        answers.businessSetupPath !== "campaign",
        "Choose whether to start a campaign or browse listings.",
        "businessSetupPath",
      );
      if (answers.businessSetupPath !== "campaign") return out;
      // Same order the questions are rendered in, so the error scrolls forward
      // through the pane rather than jumping back past something answered.
      need(
        !answers.promoting.trim(),
        "Say what you're promoting — a few words is enough.",
        "promoting",
      );
      need(!answers.goals.length, "Pick what the campaign should do.", "goals");
      need(
        !answers.briefScope,
        "Pick whether you want physical space, social, or both.",
        "briefScope",
      );
      need(
        answers.briefScope !== "virtual" && !answers.placements.length,
        "Pick the kind of space you want.",
        "placements",
      );
      need(
        answers.briefScope !== "physical" && !answers.targetPlatforms.length,
        "Pick at least one platform to target.",
        "targetPlatforms",
      );
      need(!answers.timing, "Pick when you want it to run.", "timing");
    }
    // Validate exactly what the member can see, via the same helpers publish
    // uses - so an emptied field fails here instead of silently republishing
    // the draft they deleted.
    const touched = { title: titleTouched, description: descriptionTouched };
    if (role === "business") {
      const shownTitle = effectiveTitle(role, answers, touched);
      const shownDescription = descriptionBody(role, answers, touched);
      need(
        shownTitle.trim().length < LISTING_READY_MIN.title,
        shownTitle.trim()
          ? "That title is too short — the marketplace sorts thin listings last."
          : "Give this brief a title.",
        "title",
      );
      need(
        !answers.price || answers.price < 1,
        "Set a price of at least $1.",
        "price",
      );
      // listings_price_max_valid (0017) rejects a max below the min at the
      // database, where it surfaces as a generic "something went wrong".
      need(
        typeof answers.priceMax === "number" &&
          typeof answers.price === "number" &&
          answers.priceMax < answers.price,
        "The top of the range is below the bottom.",
        "priceMax",
      );
      need(
        shownDescription.trim().length < LISTING_READY_MIN.description,
        "Add a bit more detail — a sentence or two is what makes a card worth opening.",
        "description",
      );
    }
    return out;
  }

  /** The setup slide that owns a field, used by validation and Back links. */
  function onboardingStepForField(field: string) {
    if (onboardingMode === "edit") {
      return ["role", "display_name", "city", "bio", "contact_email"].includes(
        field,
      )
        ? 1
        : 2;
    }
    const fieldName =
      field.match(/^offer:(social|physical|sponsorship):(.+)$/)?.[2] ?? field;
    if (fieldName === "role") return 1;
    if (["display_name", "city", "bio", "contact_email"].includes(fieldName)) {
      return 2;
    }

    const stepThree: Record<string, string[]> = {
      creator: [
        "creatorOffer",
        "platforms",
        "spaceKind",
        "streetAddress",
        "location_area",
        "spaceSize",
        "orgKind",
        "orgOther",
        "funding",
        "reach",
        "reachCount",
        "season",
      ],
      space_owner: ["spaceKind", "streetAddress", "location_area", "spaceSize"],
      business: [
        "businessSetupPath",
        "promoting",
        "categories",
        "goals",
        "briefScope",
        "placements",
        "targetPlatforms",
        "wantedArea",
        "deliverables",
      ],
      sponsor_host: [
        "orgKind",
        "orgOther",
        "funding",
        "reach",
        "reachCount",
        "season",
      ],
    };
    if (selectedRole && stepThree[selectedRole]?.includes(fieldName)) return 3;
    if (
      selectedRole === "business" &&
      ["price", "priceMax"].includes(fieldName)
    ) {
      return 4;
    }
    if (
      fieldName === "benefits" ||
      fieldName.startsWith("tier") ||
      [
        "format",
        "surfaces",
        "surfaceOther",
        "installBy",
        "traffic",
        "trafficCount",
        "availability",
        "artwork",
        "timing",
      ].includes(fieldName)
    ) {
      return 4;
    }
    return 5;
  }

  function missingAnswers() {
    const stepProblems = allMissingAnswers().filter(
      ([, field]) => onboardingStepForField(field) === onboardingStep,
    );
    // Creator offer fields are shown one selected offer at a time. Keep the
    // visible section answerable without making an unfinished sibling offer
    // hide the action for the offer currently on screen. Publish still calls
    // allMissingAnswers() directly, so the final submit remains global.
    if (
      onboardingMode === "setup" &&
      selectedRole === "creator" &&
      onboardingStep >= 3 &&
      onboardingStep <= 5 &&
      answers.creatorOffer
    ) {
      return stepProblems.filter(([, field]) => {
        const offer = field.match(
          /^offer:(social|physical|sponsorship):/,
        )?.[1];
        return !offer || offer === answers.creatorOffer;
      });
    }
    return stepProblems;
  }

  function creatorOfferSectionIsComplete(offer: CreatorOfferType) {
    if (onboardingStep === 5) {
      return creatorOfferIsReady(answers, offer);
    }
    return !allMissingAnswers().some(([, field]) => {
      const match = field.match(
        /^offer:(social|physical|sponsorship):(.+)$/,
      );
      return (
        match?.[1] === offer && onboardingStepForField(field) === onboardingStep
      );
    });
  }

  function nextSelectedCreatorOffer() {
    if (
      onboardingMode !== "setup" ||
      selectedRole !== "creator" ||
      onboardingStep < 3 ||
      onboardingStep > 5
    ) {
      return null;
    }
    const activeOffer = answers.creatorOffer;
    if (!activeOffer) return null;
    const offers = selectedCreatorOffers(answers);
    const currentIndex = offers.indexOf(activeOffer);
    return currentIndex === -1 ? null : offers[currentIndex + 1] ?? null;
  }

  function isCurrentOnboardingStepComplete() {
    const identityStepVisible =
      onboardingMode === "edit" || onboardingStep === 2;
    return missingAnswers().length === 0 &&
      (!identityStepVisible || !avatarCropPending);
  }

  /**
   * Keep short onboarding slides quiet until their answers are complete. A
   * visible early action is useful when there are several required details to
   * work through, but it adds noise to a one- or two-answer slide.
   */
  function shouldShowOnboardingPrimaryAction() {
    return (
      isCurrentOnboardingStepComplete() || missingAnswers().length > 2
    );
  }

  /** What the current slide blocks on: the first thing missing, or nothing. */
  function firstMissingAnswer(): [string, string] | null {
    return missingAnswers()[0] ?? null;
  }

  function onboardingStepCount() {
    return onboardingMode === "edit" ? 2 : 5;
  }

  function goToOnboardingStep(step: number) {
    const next = Math.max(1, Math.min(onboardingStepCount(), step));
    setOnboardingDirection(next >= onboardingStep ? 1 : -1);
    setOnboardingError("");
    setOnboardingInvalidField("");
    setOnboardingStep(next);
    window.requestAnimationFrame(() => {
      onboardingFormRef.current
        ?.closest<HTMLElement>(".modal-card")
        ?.scrollTo({ top: 0, behavior: "auto" });
    });
  }

  /**
   * Surface a validation failure where the member is actually looking.
   *
   * The primary action is sticky on mobile, so someone can press Publish from
   * below the field that is missing. Scrolling the control into view is what
   * makes a sticky footer safe.
   */
  /** Patch one tier in place. Every tier input goes through this. */
  function updateTier(index: number, patch: Partial<SponsorTier>) {
    setAnswers((current) => ({
      ...current,
      tiers: current.tiers.map((tier, i) =>
        i === index ? { ...tier, ...patch } : tier,
      ),
    }));
  }

  /**
   * Put the member in front of one question.
   *
   * Split out of reportMissing because the outstanding-answers line jumps to a
   * field WITHOUT raising an error: nothing has gone wrong when somebody taps
   * "3 still to answer" on their way down the form, and painting the red
   * banner for it would teach them to ignore the banner.
   */
  function scrollToField(field: string) {
    const form = onboardingFormRef.current;
    const target =
      form?.querySelector<HTMLElement>(`[data-field="${field}"]`) ??
      form?.elements.namedItem(field);
    if (target instanceof HTMLElement) {
      revealInvalidField(target);
      target.setAttribute("aria-invalid", "true");
      const describedBy = (target.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter(Boolean);
      if (!describedBy.includes("onboarding-error")) {
        target.setAttribute(
          "aria-describedby",
          [...describedBy, "onboarding-error"].join(" "),
        );
      }
      target.scrollIntoView({ block: "center", behavior: "auto" });
      const focusTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLButtonElement
          ? target
          : target.querySelector<HTMLElement>(
              "input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])",
            ) ?? target;
      focusTarget.focus();
    }
  }

  function clearOnboardingInvalidField(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return;
    const field =
      target.closest<HTMLElement>("[data-field]") ??
      target.closest<HTMLElement>(".city-autocomplete")?.querySelector<HTMLElement>(
        "[data-field]",
      );
    if (!field || field.dataset.field !== onboardingInvalidField) return;
    setOnboardingInvalidField("");
    field.removeAttribute("aria-invalid");
    const describedBy = (field.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter((value) => value && value !== "onboarding-error");
    if (describedBy.length) {
      field.setAttribute("aria-describedby", describedBy.join(" "));
    } else {
      field.removeAttribute("aria-describedby");
    }
  }

  function reportMissing(problem: [string, string]) {
    const [message, field] = problem;
    const offerField = field.match(
      /^offer:(social|physical|sponsorship):(.+)$/,
    );
    const fieldName = offerField?.[2] ?? field;
    if (offerField && offerField[1] !== answers.creatorOffer) {
      switchCreatorOffer(offerField[1] as CreatorOfferType);
    }
    const targetStep = onboardingStepForField(field);
    if (targetStep !== onboardingStep) {
      goToOnboardingStep(targetStep);
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => scrollToField(fieldName)),
      );
    } else {
      window.requestAnimationFrame(() => scrollToField(fieldName));
    }
    setOnboardingInvalidField(fieldName);
    setOnboardingError(tx(message));
  }

  function advanceOnboarding() {
    if (avatarCropPending) {
      setOnboardingError(tx("Finish positioning your photo, or cancel the crop, before continuing."));
      return;
    }
    const problem = firstMissingAnswer();
    if (problem) {
      reportMissing(problem);
      return;
    }
    setOnboardingInvalidField("");
    const nextOffer = nextSelectedCreatorOffer();
    if (nextOffer) {
      switchCreatorOffer(nextOffer);
      return;
    }
    goToOnboardingStep(onboardingStep + 1);
  }

  function startBusinessCampaign() {
    setAnswers((current) => ({
      ...current,
      businessSetupPath: "campaign",
    }));
    setOnboardingError("");
  }

  function browseBusinessListings() {
    setAnswers((current) => ({
      ...current,
      businessSetupPath: "browse",
    }));
    void publishOnboarding(null, { skipListing: true });
  }

  async function signInWithGoogle() {
    if (!supabase) return;
    // Carry invite and referral parameters through the OAuth round trip.
    // Without this, an outreach recipient returns from /auth/callback without
    // the context that makes the $5 Business promotion eligible.
    const nextPath = authNextPath(referralCode);
    const next = `?next=${encodeURIComponent(nextPath)}`;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback${next}`,
      },
    });
    if (error) setToast(friendlyDbError(error));
  }

  /**
   * Finish a Google sign-in that happened on our own domain.
   *
   * The ID token buys the same session the redirect would have: same client
   * id, so the same Google account is the same existing user. There is no
   * round trip through /auth/callback to carry the invite and referral
   * parameters, so this lands on the path that callback would have chosen.
   *
   * A refused token is not a dead end. It means the exchange is not configured
   * (the client id has to be listed on Supabase's Google provider for ID
   * tokens to be accepted), and the redirect flow still works - so it takes
   * over. Once, guarded: a fallback that could re-enter itself would bounce
   * somebody between two sign-in screens.
   */
  async function completeGoogleSignIn(token: string, nonce: string) {
    if (!supabase || googleFallbackRef.current) return;
    setBusy(true);
    const { data, error } = await supabase.auth.signInWithIdToken({
      provider: "google",
      token,
      nonce,
    });
    setBusy(false);
    if (error) {
      googleFallbackRef.current = true;
      console.error(
        "[google sign-in] token refused, falling back to the redirect flow:",
        error,
      );
      void signInWithGoogle();
      return;
    }
    setUser(data.user);
    setAuthOpen(false);
    window.location.assign(authNextPath(referralCode));
  }

  /**
   * Finish onboarding: write the profile, and in setup mode publish the first
   * listing too — unless a business chose to browse listings instead.
   *
   * WRITE ORDER IS LOAD-BEARING. The profile must exist with
   * onboarding_complete = true before the listing insert, because
   * "Members create their own listings" (0009:118-124) has
   * `profiles.onboarding_complete` in its WITH CHECK. Insert the listing first
   * and RLS rejects it.
   *
   * There is deliberately no SECURITY DEFINER RPC wrapping the two writes in a
   * transaction. Such a function runs as the table owner, so
   * protect_profile_trust_fields (0005:9-37) - which gates its whole body on
   * `current_user = 'authenticated'` - would stop pinning verified,
   * verification_status, social_verification, is_demo and auth_user_id. Trading
   * that guard for atomicity is a bad deal when the non-atomic failure mode is
   * recoverable, which it is: see the catch below.
   */
  async function publishOnboarding(
    event?: FormEvent<HTMLFormElement> | null,
    options?: { skipListing?: boolean },
  ) {
    event?.preventDefault();
    const skipListing =
      Boolean(options?.skipListing) ||
      (selectedRole === "business" && answers.businessSetupPath === "browse");

    if (avatarCropPending) {
      setOnboardingError(tx("Finish positioning your photo, or cancel the crop, before saving."));
      return;
    }

    const identityFields = new Set([
      "role",
      "display_name",
      "city",
      "bio",
      "contact_email",
    ]);
    const problem = skipListing
      ? (allMissingAnswers().find(([, field]) => identityFields.has(field)) ??
        null)
      : (allMissingAnswers()[0] ?? null);
    if (problem) {
      reportMissing(problem);
      return;
    }
    setOnboardingError("");

    const role = selectedRole;
    if (!role) {
      reportMissing(["Pick how you’ll use SideSpace first.", "role"]);
      return;
    }

    if (!skipListing && role !== "business") {
      const drafts = buildListingDrafts(role, answers, { title: titleTouched, description: descriptionTouched });
      const invalid = drafts.find((draft) => {
        const setup = bookingForDraft(draft);
        return setup?.schedule.instant_booking_enabled && (!isFixedPriceListing(draft) || !availableStartDates(setup.schedule).length ||
          setup.deliverables.trim().length < 2 || setup.deliverables.trim().length > 1000 ||
          setup.cancellation.trim().length < 2 || setup.cancellation.trim().length > 1000);
      });
      if (invalid) {
        setOnboardingError(tx("For “{title}”, add a fixed price, open dates, deliverables, and cancellation terms to enable instant booking.", { title: invalid.title }));
        setOnboardingStep(5);
        return;
      }
    }

    if (onboardingPreview) {
      setOnboardingOpen(false);
      setOnboardingPreview(false);
      setOnboardingStep(1);
      setToast("Onboarding preview complete. Nothing was saved.");
      return;
    }

    if (!supabase || !user) return;

    setBusy(true);
    let savedProfile: Profile | null = null;
    let adCreditAwarded = 0;
    let adCreditSyncFailed = false;
    try {
      // Re-read the stored row before building the payload, every time. It
      // decides insert-vs-update, whether the Google identity photo may be used
      // as a fallback, and gallery_urls merges out of it - so a stale in-memory
      // copy silently overwrites fresher data from another tab.
      const { data: fresh, error: freshError } = await supabase
        .from("my_profiles")
        .select("*")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (freshError) {
        throw new Error(
          "We could not reach your profile just now. Check your connection and try again, nothing was lost.",
        );
      }
      const freshRow = (fresh as Profile | null) ?? null;
      const existing = freshRow
        ? withProfileContacts(
            freshRow,
            await loadProfileContacts(supabase, freshRow.id),
          )
        : null;
      profileLoadFailedRef.current = false;

      const avatarFiles = avatarFile && avatarFile.size > 0 ? [avatarFile] : [];
      const chosenListingFiles = listingFiles.filter((file) => file.size > 0);
      const chosenGalleryFiles = galleryFiles.filter((file) => file.size > 0);

      const existingGalleryCount = (existing?.gallery_urls ?? []).length;
      if (existingGalleryCount + chosenGalleryFiles.length > 6) {
        throw new Error(
          `You can keep 6 photos. You have ${existingGalleryCount} and picked ${chosenGalleryFiles.length}. Remove some first, or choose fewer.`,
        );
      }

      const [avatarUploads, galleryUploads] = await Promise.all([
        uploadImages(avatarFiles, "profiles"),
        uploadImages(chosenGalleryFiles, "profiles"),
      ]);

      // Only the platforms actually picked contribute a handle. This is the
      // whole reason the flow moved off FormData: the old code guarded on
      // `values.has("social_instagram")`, so a creator who picked TikTok and
      // not Instagram had every handle they typed thrown away.
      // Iterate the catalogue, not the selection. Visiting only the selected
      // platforms meant a member who unticked TikTok kept their old TikTok URL
      // from `existing` - and since the platform chips are re-derived from
      // social_links on reopen, the chip ticked itself again. The deselection
      // was both invisible and self-reverting. Keys outside the catalogue
      // (anything legacy) are left untouched.
      const socialLinks: Record<string, string> = {
        ...(existing?.social_links ?? {}),
      };
      for (const platform of socialPlatforms) {
        const url = answers.platforms.includes(platform.key)
          ? normalizeSocialUrl(platform, answers.socials[platform.key] ?? "")
          : "";
        if (url) socialLinks[platform.key] = url;
        else delete socialLinks[platform.key];
      }

      const syncedIgAvatar = igAvatarPromiseRef.current
        ? await igAvatarPromiseRef.current
        : igAvatar;

      const creatorOffers =
        canonicalRole(role) === "creator"
          ? selectedCreatorOffers(answers)
          : [];
      const primaryCreatorOffer = creatorOffers[0];
      const reachAnswers = primaryCreatorOffer
        ? creatorOfferView(answers, primaryCreatorOffer)
        : answers;
      const reach = deriveReach(role, reachAnswers);
      // Onboarding no longer asks for a handle - a business gives its business
      // name and everyone else an email - but an existing handle is preserved
      // rather than blanked out from under a legacy member.
      const handle = (answers.handle || existing?.handle || "")
        .trim()
        .replace(/^@/, "");

      const payload = {
        auth_user_id: user.id,
        role,
        creator_offer:
          canonicalRole(role) === "creator"
            ? primaryCreatorOffer ||
              existing?.creator_offer ||
              creatorOfferForRole(role, answers) ||
              "social"
            : null,
        creator_offers:
          canonicalRole(role) === "creator"
            ? creatorOffers.length
              ? creatorOffers
              : [existing?.creator_offer || "social"]
            : [],
        business_preferences:
          role === "business" && onboardingMode === "setup"
            ? businessPreferencesFromAnswers(answers)
            : existing?.business_preferences ?? null,
        extra_roles: Array.from(
          new Set(
            extraRoles.filter(
              (extra) => extra !== role && EXTRA_ROLE_OPTIONS.includes(extra),
            ),
          ),
        ),
        display_name: answers.display_name.trim(),
        handle: handle || null,
        contact_name: answers.contact_name.trim(),
        contact_email: answers.contact_email.trim(),
        city: answers.city.trim(),
        location_latitude: answers.location?.latitude ?? null,
        location_longitude: answers.location?.longitude ?? null,
        bio: answers.bio.trim(),
        // A sponsorship offer is never shown the category chips - what they
        // are is already answered, in their own words, by the organisation
        // chip. Reusing it costs them no taps and makes "robotics" or
        // "festival" find them.
        categories:
          isSponsorshipOffer(role, answers) && orgLabel(answers)
            ? [orgLabel(answers)]
            : answers.categories,
        // A null follower count means "not answered", and must not overwrite a
        // number they gave earlier with 0.
        //
        // Clamped here rather than trusting the input: the field that enforces
        // min={0} is only mounted in the creator branch, and a role switch
        // carries `followers` across. A negative number typed as a creator and
        // then switched to Space owner otherwise reaches profiles_followers_check
        // and fails the ENTIRE profile write, with an error naming a field that
        // is no longer on screen.
        // When the field is ON SCREEN, an empty box means zero - not "keep
        // whatever is stored". The old `??` chain fell back to the existing
        // value, so a member who typed a follower count by mistake could never
        // remove it, and on the person card `followers || avg_views` meant that
        // number permanently replaced their real reach.
        followers: showAudienceFields
          ? Math.max(0, answers.followers ?? 0)
          : Math.max(0, answers.followers ?? existing?.followers ?? 0),
        avg_views: Math.max(0, reach.avg_views ?? existing?.avg_views ?? 0),
        reach_unit: reach.reach_unit ?? existing?.reach_unit ?? "weekly looks",
        audience_age: existing?.audience_age ?? "",
        website: existing?.website ?? "",
        avatar_url:
          avatarUploads[0] ||
          existing?.avatar_url ||
          syncedIgAvatar ||
          // Only seed from the Google identity on FIRST setup. For an existing
          // member an empty avatar means they deliberately deleted it.
          (existing
            ? ""
            : String(
                user.user_metadata.avatar_url ??
                  user.user_metadata.picture ??
                  "",
              )) ||
          "",
        social_links: socialLinks,
        gallery_urls: Array.from(
          new Set([...(existing?.gallery_urls ?? []), ...galleryUploads]),
        ).slice(0, 6),
        onboarding_complete: true,
        is_demo: false,
      };

      // The private fields are peeled off before the write: profiles is
      // world-readable, so anything private left in this payload would be
      // republished to every anonymous caller.
      const { profile: profileWrite, contacts } = splitProfileWrite(payload);
      const result = existing
        ? await supabase
            .from("profiles")
            .update(profileWrite)
            .eq("id", existing.id)
            .select(PUBLIC_PROFILE_COLUMNS)
            .single()
        : await supabase
            .from("profiles")
            .insert(profileWrite)
            .select(PUBLIC_PROFILE_COLUMNS)
            .single();
      if (result.error) throw result.error;

      const writtenProfile = {
        ...(existing ?? { auth_user_id: user.id }),
        ...(result.data as Partial<Profile>),
        location_latitude: payload.location_latitude,
        location_longitude: payload.location_longitude,
        auth_user_id: existing?.auth_user_id ?? user.id,
      } as Profile;
      // Deliberately not fatal. The profile row is already committed, and
      // these three fields are recoverable by saving again - contact_email in
      // particular only overrides the account address the payment routes
      // already fall back to. Failing onboarding here would strand a member
      // whose profile did save.
      const contactsWrite = await saveProfileContacts(
        supabase,
        writtenProfile.id,
        contacts,
      );
      if (contactsWrite.error) {
        console.error(
          "Could not save private profile fields",
          contactsWrite.error,
        );
      }
      savedProfile = withProfileContacts(writtenProfile, contacts) as Profile;
      setProfile(savedProfile);

      // The database function is the authority for the promotion: it checks
      // the shared referral code, the authenticated email, the completed
      // Business profile, and the one-time redemption constraint. A transient
      // failure does not undo a saved profile; saving again safely retries the
      // same idempotent grant.
      const inviteToken = new URLSearchParams(window.location.search).get("p") ?? "";
      const activeReferral = activeBusinessReferralCode(referralCode);
      if (role === "business" && activeReferral) {
        try {
          const redemption = await supabase.rpc(
            "redeem_business_referral_credit",
            { referral_code: activeReferral },
          );
          if (redemption.error) {
            adCreditSyncFailed = true;
            console.error("Could not redeem Business onboarding ad credit", redemption.error);
          } else {
            const result = Array.isArray(redemption.data)
              ? redemption.data[0]
              : redemption.data;
            adCreditAwarded = Number(result?.awarded_cents ?? 0);
          }
        } catch (error) {
          adCreditSyncFailed = true;
          console.error("Could not redeem Business onboarding ad credit", error);
        }
      } else if (role === "business" && UUID_PARAM.test(inviteToken)) {
        // Keep already-sent personalized DEMAND links useful. The database
        // wrapper now records the redemption by authenticated email too, so
        // forwarding an old link cannot mint a second credit for that email.
        try {
          const redemption = await supabase.rpc(
            "redeem_business_signup_ad_credit",
            { invite_token: inviteToken },
          );
          if (redemption.error) {
            adCreditSyncFailed = true;
            console.error("Could not redeem Business onboarding ad credit", redemption.error);
          } else {
            const result = Array.isArray(redemption.data)
              ? redemption.data[0]
              : redemption.data;
            adCreditAwarded = Number(result?.awarded_cents ?? 0);
          }
        } catch (error) {
          adCreditSyncFailed = true;
          console.error("Could not redeem Business onboarding ad credit", error);
        }
      }

      if (onboardingMode === "setup") {
        if (!skipListing) {
          // Uploaded only after the profile write succeeds. Uploading first meant
          // a failed profile save left the photos sitting in a public bucket with
          // nothing referencing them and no way to reach them again.
          //
          // Not sliced to 6: uploadImages enforces its own cap and reports it,
          // where slicing here would silently publish 6 of the 8 someone picked.
          const listingUploads = await uploadImages(
            chosenListingFiles,
            "listings",
          );
          // Plural. A sponsorship offer publishes one row per tier; everyone
          // else publishes exactly one, which is the same code path with a
          // one-element array.
          const drafts = buildListingDrafts(role, answers, {
            title: titleTouched,
            description: descriptionTouched,
          });
          // Listing photos are written to the listing ONLY, never mirrored into
          // profiles.gallery_urls. removeProfilePhoto already exists to repair
          // listings that share a URL with a deleted gallery photo, re-pointing
          // them at the default cover; double-writing would make that the
          // guaranteed fate of every listing this flow creates.
          //
          // A business publishes a brief - a wanted ad, usually written before
          // there is anything to photograph - and the chain ends there for
          // them. Their own logo still stands in, because a brief under the
          // business's mark reads as theirs; the stock cover never did, and
          // gave every campaign a photo of somebody else's market stall.
          const cover =
            listingUploads[0] ||
            payload.avatar_url ||
            payload.gallery_urls[0] ||
            (role === "business" ? "" : DEFAULT_LISTING_IMAGE);
          // Captured before the map: narrowing on the outer binding does not
          // survive into a closure, and this is the only reference inside one.
          const ownerId = savedProfile.id;
          const inserted = await supabase
            .from("listings")
            .insert(
              drafts.map((draft) => ({
                ...draft,
                ...(role !== "business" && bookingForDraft(draft)?.schedule.instant_booking_enabled ? {
                  ...bookingForDraft(draft)!.schedule,
                  deliverables: bookingForDraft(draft)!.deliverables.trim(),
                  cancellation_policy: bookingForDraft(draft)!.cancellation.trim(),
                } : {}),
                owner_profile_id: ownerId,
                image_url: cover,
                image_urls: listingUploads.length
                  ? listingUploads
                  : cover
                    ? [cover]
                    : [],
                status: "active",
                provenance_status: "owner_attested",
                availability_confirmed_at: new Date().toISOString(),
              })),
            )
          .select(PUBLIC_LISTING_COLUMNS);
          if (inserted.error) throw inserted.error;

          window.localStorage.removeItem(`sidespace.onboarding.${user.id}`);
          setOnboardingDraft(null);
          setOnboardingOpen(false);
          setOnboardingStep(1);
          resetIgAvatarSync();
          await Promise.all([
            loadMarketplace(),
            loadOwnListings(savedProfile),
            loadAccountMarketplaceState(savedProfile),
          ]);
          setToast(
            role === "business"
              ? adCreditAwarded
                ? `Your brief is live. ${formatCents(adCreditAwarded)} in ad credit is ready for your first campaign.`
                : adCreditSyncFailed
                  ? "Your brief is live. We could not confirm the intro ad credit yet — refresh your dashboard and try again."
                  : "Your brief is live. We’ll tell you the moment someone answers."
                : canonicalRole(role) === "creator" && drafts.length > 1
                  ? "You’re live. " + drafts.length + " listings are on the marketplace."
                : `You’re live. “${drafts[0].title}” is on the marketplace.`,
          );
          return;
        }

        window.localStorage.removeItem(`sidespace.onboarding.${user.id}`);
        setOnboardingDraft(null);
        setOnboardingOpen(false);
        setOnboardingStep(1);
        resetIgAvatarSync();
        setRoleFilter("supply");
        await Promise.all([
          loadMarketplace(),
          loadOwnListings(savedProfile),
          loadAccountMarketplaceState(savedProfile),
        ]);
        setToast(
          adCreditAwarded
            ? `You’re in. ${formatCents(adCreditAwarded)} in ad credit is ready when you start a campaign.`
            : adCreditSyncFailed
              ? "You’re in. We could not confirm the intro ad credit yet — refresh your dashboard and try again."
              : "You’re in. Browse listings, or start a campaign whenever you’re ready.",
        );
        if (route !== "marketplace") {
          window.location.assign("/marketplace?role=supply");
        }
        return;
      }

      setOnboardingOpen(false);
      setOnboardingStep(1);
      resetIgAvatarSync();
      await Promise.all([
        loadMarketplace(),
        loadOwnListings(savedProfile),
        loadAccountMarketplaceState(savedProfile),
      ]);
      setToast(
        adCreditAwarded
          ? `${formatCents(adCreditAwarded)} in ad credit is ready for your first campaign.`
          : adCreditSyncFailed
            ? "Saved. We could not confirm the intro ad credit yet — refresh your dashboard and try again."
            : "Saved. Your profile is up to date.",
      );
    } catch (error) {
      // The profile write succeeding and the listing write failing is a real
      // state, and it is recoverable: they are on the marketplace, and the
      // draft survives. Rolling the profile back would be worse - it would
      // take away the thing that did work.
      if (savedProfile) {
        try {
          window.localStorage.setItem(
            `sidespace.onboarding.${user.id}`,
            JSON.stringify({ role: selectedRole, answers, savedAt: Date.now() }),
          );
          setOnboardingDraft({ role: selectedRole, answers });
        } catch {
          // Private browsing, or storage full. The draft is a convenience.
        }
        setOnboardingOpen(false);
        setOnboardingStep(1);
        await Promise.all([
          loadMarketplace(),
          loadOwnListings(savedProfile),
          loadAccountMarketplaceState(savedProfile),
        ]);
        // Include the actual reason. This branch swallowed it, so a listing
        // rejected for a fixable reason (a number too large, a title too long)
        // read as an unexplained failure and Publish looped on the same value.
        const why = friendlyDbError(error);
        setToast(
          "Your profile is saved, but the listing didn’t post.{value} Nothing you typed is lost — open it again from your dashboard.", undefined, { value: why ? ` ${why}` : "" },
        );
      } else if ((error as { code?: string })?.code === "23505") {
        // A duplicate @handle. profiles_handle_unique is a unique index on
        // lower(handle), and the generic message for it is "That already
        // exists." - shown above step 2, while the handle field is on step 1
        // and not even in the DOM. Send them back to the field that is wrong.
        setOnboardingStep(1);
        window.requestAnimationFrame(() =>
          reportMissing(["That @handle is taken. Try another.", "handle"]),
        );
      } else {
        setOnboardingError(
          tx(friendlyDbError(error) || "Could not save your profile."),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * Pour an AI draft into the uncontrolled listing form.
   *
   * The form reads its values from the DOM at submit time, so filling it means
   * setting element values - the same way the kind chooser already sets the
   * channel and price unit. Fields the current form does not render (the
   * physical-only surface and install groups on a social listing) are simply
   * skipped. Nothing is saved: the member reads it over and presses Publish.
   */
  function applyListingDraft(form: HTMLFormElement, draft: ListingDraft) {
    const setValue = (name: string, value: string) => {
      const element = form.elements.namedItem(name);
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        element.value = value;
      } else if (element instanceof HTMLSelectElement) {
        const match = Array.from(element.options).find(
          (option) => option.value === value,
        );
        if (match) element.value = value;
      }
    };
    // Only write what the model actually said. A blank means "not stated",
    // and must never wipe something the member already typed or saved.
    if (draft.title) setValue("title", draft.title);
    setValue("channel", draft.channel);
    if (draft.format) setValue("format", draft.format);
    if (draft.description) setValue("description", draft.description);
    if (draft.demographics) setValue("demographics", draft.demographics);
    if (draft.location_area) setValue("location_area", draft.location_area);
    if (draft.space_size) setValue("space_size", draft.space_size);
    const selectedUnit = (form.elements.namedItem("price_unit") as HTMLInputElement | null)?.value;
    const fixed = (form.elements.namedItem("pricing_kind") as HTMLInputElement | null)?.value === "fixed";
    const unitMatches = !selectedUnit || selectedUnit === draft.price_unit || (fixed && !["day", "week", "month"].includes(draft.price_unit));
    if (draft.price_dollars !== null && unitMatches) setValue("price", String(draft.price_dollars));
    const basis = form.elements.namedItem("pricing_kind");
    // Preserve the selected pricing basis; surface AI rate suggestions for review.
    if (!(basis instanceof HTMLSelectElement) && !(basis instanceof HTMLInputElement)) setValue("price_unit", draft.price_unit);
    if (basis && String((basis as HTMLInputElement).value) && draft.price_unit !== String((form.elements.namedItem("price_unit") as HTMLInputElement)?.value)) {
      setAiQuestions((current) => [...current, `The draft suggests a price per ${draft.price_unit}. Check your selected price unit.`]);
    }
    if (draft.minimum_booking) setValue("minimum_booking", draft.minimum_booking);
    if (draft.availability_notes) {
      setValue("availability_notes", draft.availability_notes);
    }
    if (draft.deliverables) setValue("deliverables", draft.deliverables);
    form
      .querySelectorAll<HTMLInputElement>('input[name="surface_types"]')
      .forEach((box) => {
        box.checked = draft.surface_types.includes(
          box.value as ListingDraft["surface_types"][number],
        );
      });
    if (draft.install_by) {
      setValue("install_by", draft.install_by);
      form
        .querySelectorAll<HTMLInputElement>('input[name="install_by"]')
        .forEach((radio) => {
          radio.checked = radio.value === draft.install_by;
        });
    }
    if (draft.format) setFormatPreview(draft.format);
  }

  /**
   * Dictate into the notes box, then draft.
   *
   * Two ways in. Chrome, Safari and Edge recognise speech themselves, so
   * words appear as they are said and nothing but text leaves the device.
   * Everything else - Firefox, Brave, in-app browsers, or a recogniser that
   * fails part-way - records the voice note and the server transcribes it.
   * Either way, when listening ends with something new, Fill with AI runs on
   * it; ending with nothing new spends nothing.
   *
   * recognition.start() is called synchronously inside the tap. An await in
   * front of it (the old microphone pre-flight) put the call outside the
   * user gesture, which some browsers answer with a silent "not-allowed".
   */
  function startListening() {
    const field = aiNotesRef.current;
    if (!field) return;
    if (!speechFailedRef.current && speechRecognitionUsable()) {
      startRecognition(field);
    } else {
      void startRecording(field, false);
    }
  }

  function startRecognition(field: HTMLTextAreaElement) {
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      void startRecording(field, false);
      return;
    }
    const recognition = new Ctor();
    recognition.lang = navigator.language || "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    const before = field.value.trim();
    let settled = "";
    let heard = false;
    let recordInstead = false;
    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const chunk = result[0]?.transcript ?? "";
        if (result.isFinal) settled += `${chunk} `;
        else interim += chunk;
      }
      heard = true;
      field.value = [before, `${settled}${interim}`.trim()]
        .filter(Boolean)
        .join(" ")
        .slice(0, AI_NOTES_MAX);
    };
    recognition.onerror = (event) => {
      const code = event.error ?? "";
      if (code === "not-allowed") {
        setToast(
          "The microphone (or speech recognition) is blocked for this site. Allow it - the lock or mic icon in the address bar, or Settings > Safari > Microphone on an iPhone - then tap Speak again.",
          "problem",
        );
      } else if (code === "no-speech") {
        setToast(
          "Didn't hear anything. Check that the mic isn't muted, tap Speak, and start talking straight away.",
          "problem",
        );
      } else if (code === "audio-capture") {
        setToast(
          "No microphone was found on this device. Type a few words instead.",
          "problem",
        );
      } else if (code !== "aborted") {
        // network, service-not-allowed, language-not-supported: the
        // recogniser is the problem, not the mic. Record instead, now and
        // for the rest of this session.
        speechFailedRef.current = true;
        recordInstead = true;
      }
    };
    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
      if (recordInstead) {
        void startRecording(field, true);
        return;
      }
      if (heard && field.value.trim() && field.value.trim() !== before) {
        void fillListingWithAi(field.form);
      }
    };
    recognitionRef.current = recognition;
    setVoiceMode("speech");
    setListening(true);
    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
      speechFailedRef.current = true;
      void startRecording(field, true);
    }
  }

  /**
   * Record a voice note and hand it to the server to transcribe. Used where
   * the browser cannot recognise speech itself, or right after its
   * recogniser failed (`afterSpeechFailed`, which changes what the messages
   * say - and that call comes from a callback, not a tap, so a browser that
   * wants a gesture for the mic gets told to tap again).
   */
  async function startRecording(field: HTMLTextAreaElement, afterSpeechFailed: boolean) {
    const type = recordingMimeType();
    if (type === null || !navigator.mediaDevices?.getUserMedia) {
      setToast(
        "Voice input isn't available in this browser. Type a few words instead.",
        "problem",
      );
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      setToast(
        name === "NotAllowedError" || name === "SecurityError"
          ? afterSpeechFailed
            ? "Speech recognition didn't work in this browser. Tap Speak again and SideSpace will record you instead."
            : "The microphone is blocked for this site. Allow it - the lock or mic icon in the address bar - then tap Speak again."
          : name === "NotFoundError"
            ? "No microphone was found on this device. Type a few words instead."
            : "The microphone could not be opened. Type a few words instead.",
      );
      return;
    }
    let recorder: MediaRecorder;
    try {
      recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      setToast(
        "Recording isn't available in this browser. Type a few words instead.",
        "problem",
      );
      return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = () => {
      const active = recorderRef.current;
      recorderRef.current = null;
      if (active) window.clearTimeout(active.timer);
      stream.getTracks().forEach((track) => track.stop());
      if (active?.discard) return;
      setListening(false);
      const blob = new Blob(chunks, { type: recorder.mimeType || type || "audio/webm" });
      // A tap-and-release leaves a few hundred bytes of container and no voice.
      if (blob.size < 2_000) {
        setToast("Didn't hear anything. Check the mic and try again, or type a few words.");
        return;
      }
      if (blob.size > 2_200_000) {
        setToast("That recording is too long. Keep it under a minute.");
        return;
      }
      void blobToBase64(blob)
        .then((data) => fillListingWithAi(field.form, { data, mimeType: blob.type }))
        .catch(() =>
          setToast("That recording could not be read. Try again, or type a few words."),
        );
    };
    const timer = window.setTimeout(() => {
      if (recorderRef.current?.recorder === recorder && recorder.state === "recording") {
        recorder.stop();
      }
    }, RECORDING_MAX_MS);
    recorderRef.current = { recorder, stream, timer, discard: false };
    try {
      recorder.start();
    } catch {
      recorderRef.current = null;
      window.clearTimeout(timer);
      stream.getTracks().forEach((track) => track.stop());
      setToast("Recording could not start. Type a few words instead.");
      return;
    }
    setVoiceMode("recording");
    setListening(true);
    setToast(
      afterSpeechFailed
        ? "Speech recognition didn't work here, so SideSpace is recording instead. Talk now, then tap Stop & fill."
        : "Recording. Say what it is, where, the price, and who sees it, then tap Stop & fill.",
    );
  }

  function stopListening() {
    recognitionRef.current?.stop();
    const active = recorderRef.current;
    if (active && active.recorder.state !== "inactive") active.recorder.stop();
  }

  /** Forget the helper state that belongs to one editing session. */
  function resetAiHelpers() {
    setAiQuestions([]);
    setAiObservations([]);
    if (streetView?.url) URL.revokeObjectURL(streetView.url);
    setStreetView(null);
    setTourPick(null);
    setTourSpherical(false);
  }

  function clearStreetView() {
    if (streetView?.url) URL.revokeObjectURL(streetView.url);
    setStreetView(null);
  }

  /**
   * Look up Google Street View for the exact address. Outdoor imagery only,
   * so a storefront or a wall on a street usually works and a dorm corridor
   * gets a polite no. The frame is a preview; the listing keeps only the
   * capture month, and buyers see the frame fetched live from Google under
   * the photos, labelled. The owner can drop it again; Street View can be
   * years old.
   */
  async function importStreetView(form: HTMLFormElement | null) {
    if (!form || streetViewLoading) return;
    const addressField = form.elements.namedItem("street_address");
    const address =
      addressField instanceof HTMLInputElement ? addressField.value.trim() : "";
    if (address.length < 5) {
      setToast(
        "Type the exact street address first, then try Street View again.",
        "problem",
      );
      return;
    }
    setStreetViewLoading(true);
    try {
      const response = await fetch("/api/listings/streetview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, city: profile?.city ?? "" }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error || "Street View is not available right now.");
      }
      const blob = await response.blob();
      const captured = response.headers.get("x-street-view-date") ?? "";
      const pano = response.headers.get("x-street-view-pano") ?? "";
      if (streetView?.url) URL.revokeObjectURL(streetView.url);
      setStreetView({ captured, pano, url: URL.createObjectURL(blob) });
      setToast(
        "Street View attached. Buyers see it under your photos, labelled and fetched live from Google, with a View whole street button for the 360 view. Remove it if it does not show your spot.",
      );
    } catch (error) {
      setToast(
        error instanceof Error ? error.message : "Street View is not available right now.",
      );
    } finally {
      setStreetViewLoading(false);
    }
  }

  async function fillListingWithAi(
    form: HTMLFormElement | null,
    audio?: { data: string; mimeType: string },
  ) {
    if (!form || aiFilling) return;
    const notesField = form.elements.namedItem("ai_notes");
    const notes =
      notesField instanceof HTMLTextAreaElement ? notesField.value.trim() : "";
    const photos = form.elements.namedItem("listing_photos");
    const picked = photos instanceof HTMLInputElement ? Array.from(photos.files ?? []) : [];
    const file =
      picked.find((item) => item.size > 0) ??
      null;
    // The walkthrough too: the one just picked, else the one the listing
    // already has. Stills are cut here, in the browser.
    const tourSource: { kind: TourKind; source: Blob | string } | null = tourPick
      ? {
          kind: tourPick.kind === "photo" ? "photo360" : tourSpherical ? "video360" : "video",
          source: tourPick.file,
        }
      : editingListing?.tour_url && editingListing.tour_kind
        ? { kind: editingListing.tour_kind, source: editingListing.tour_url }
        : null;
    if (!file && !notes && !audio && !tourSource) {
      setToast(
        "Add a photo, a walkthrough, or a few words first, then press Fill with AI.",
        "problem",
      );
      return;
    }
    // Whatever is in the form now - a first draft the owner edited, or
    // answers typed straight into the fields - goes back so the second Fill
    // improves it instead of overwriting it.
    const current: Record<string, string> = {};
    CURRENT_DRAFT_FIELDS.forEach((name) => {
      const element = form.elements.namedItem(name);
      const value =
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value.trim()
          : "";
      if (value) current[name] = value;
    });
    setAiFilling(true);
    setAiQuestions([]);
    setAiObservations([]);
    let tourSkipped = false;
    let tour: { kind: TourKind; frames: string[] } | null = null;
    try {
      const image = file ? await photoToJpegBase64(file) : null;
      if (tourSource) {
        let frames: string[] = [];
        try {
          frames =
            tourSource.kind === "photo360"
              ? [
                  await photoToJpegBase64(
                    typeof tourSource.source === "string"
                      ? await (await fetch(tourSource.source)).blob()
                      : tourSource.source,
                    1600,
                  ),
                ]
              : await videoStills(tourSource.source);
        } catch {
          // The draft still runs on the rest; the toast says so.
          tourSkipped = true;
        }
        // Vercel caps a request body at 4.5 MB. Drop stills from the end
        // until the whole thing fits with room to spare.
        const budget = 3_800_000 - (image?.length ?? 0) - (audio?.data.length ?? 0);
        while (frames.length && frames.reduce((sum, frame) => sum + frame.length, 0) > budget) {
          frames = frames.slice(0, -1);
        }
        if (frames.length) tour = { kind: tourSource.kind, frames };
      }
      const response = await fetch("/api/listings/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notes,
          image,
          tour,
          current: Object.keys(current).length ? current : null,
          audio: audio ? { data: audio.data, mime_type: audio.mimeType } : null,
          kind: listingFormKind === "brief" ? "physical" : listingFormKind,
          city: profile?.city ?? "",
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { draft?: ListingDraft; transcript?: string; error?: string }
        | null;
      if (!response.ok || !payload?.draft) {
        throw new Error(
          payload?.error || "SideSpace could not draft this listing right now.",
        );
      }
      applyListingDraft(form, payload.draft);
      if (payload.transcript && notesField instanceof HTMLTextAreaElement) {
        // Show what was heard, after whatever was typed, so a misheard word
        // can be fixed and the draft run again.
        notesField.value = [notes, payload.transcript]
          .filter(Boolean)
          .join(" ")
          .slice(0, AI_NOTES_MAX);
      }
      const followupQuestions = payload.draft.questions ?? [];
      setAiQuestions((current) => [...current, ...followupQuestions]);
      setAiObservations(payload.draft.photo_observations ?? []);
      const asked = payload.draft.questions?.length ?? 0;
      const skipped = tourSkipped
        ? " The walkthrough could not be read here, so this draft went without it."
        : "";
      setToast(
        (asked
          ? `Filled what you told me. ${asked} quick question${asked === 1 ? "" : "s"} below - answer them and fill again.`
          : file || tour
            ? "Drafted. Read it over and change anything before you publish."
            : "Drafted from your words. Add a photo and fill again for a better draft, or edit this one.") +
          skipped,
      );
    } catch (error) {
      setToast(
        error instanceof Error
          ? error.message
          : "SideSpace could not draft this listing right now.",
      );
    } finally {
      setAiFilling(false);
    }
  }

  /** A walkthrough file just picked: read it, guess whether it is 360, and say so in the form. */
  async function onTourPicked(file: File | null) {
    if (!file) {
      setTourPick(null);
      setTourSpherical(false);
      return;
    }
    if (![...TOUR_VIDEO_TYPES, ...TOUR_PHOTO_TYPES].includes(file.type)) {
      setTourPick(null);
      setToast(
        "A walkthrough is an MP4, WebM, or .mov video, or a JPG, PNG, or WebP 360° photo.",
        "problem",
      );
      return;
    }
    if (file.size > TOUR_MAX_BYTES) {
      setTourPick(null);
      setToast(
        "{name} is {round} MB and the limit is 50 MB. Trim it, or export it smaller, and pick it again.", undefined, { name: file.name, round: Math.round(file.size / 1024 / 1024) },
      );
      return;
    }
    try {
      const probe = await probeTourFile(file);
      setTourPick({ ...probe, file });
      setTourSpherical(looksSpherical(probe.width, probe.height));
    } catch (error) {
      setTourPick(null);
      setToast(error instanceof Error ? error.message : "That file could not be read.");
    }
  }

  /**
   * One walkthrough into the tours bucket. A 360 photo is painted on a
   * sphere, so it keeps far more pixels than a listing photo: 4096 wide is
   * the widest texture every phone GPU takes. Video goes up as it is - the
   * browser cannot re-encode it - which is what the 50 MB ceiling is for.
   */
  async function uploadTour(pick: TourProbe & { file: File }, spherical: boolean) {
    if (!supabase || !user) throw new Error("Sign in again to add a walkthrough.");
    let body: Blob = pick.file;
    let contentType = pick.file.type;
    let extension =
      pick.file.name.split(".").pop()?.toLowerCase() || (pick.kind === "video" ? "mp4" : "jpg");
    if (pick.kind === "photo") {
      const prepared = await downscaleForUpload(pick.file, 4096);
      body = prepared.body;
      contentType = prepared.contentType;
      extension = prepared.extension;
    }
    if (body.size > TOUR_MAX_BYTES) {
      throw new Error(`${pick.file.name} is larger than 50 MB.`);
    }
    const path = `${user.id}/listings/${crypto.randomUUID()}.${extension}`;
    const { error } = await supabase.storage.from("marketplace-tours").upload(path, body, {
      contentType,
      upsert: false,
      // The path is unique, so the file never changes under this URL and
      // the CDN may keep it for a year: a listing opened twice serves the
      // video from the edge, not from the bucket and its egress.
      cacheControl: "31536000",
    });
    if (error) throw error;
    const { data } = supabase.storage.from("marketplace-tours").getPublicUrl(path);
    const kind: TourKind = pick.kind === "photo" ? "photo360" : spherical ? "video360" : "video";
    return { url: data.publicUrl, kind, path };
  }

  /** Keep the editor, the owner's lists and the open listing on the row just written. */
  function rememberListing(updated: Listing) {
    setEditingListing((current) => (current?.id === updated.id ? updated : current));
    setOwnListings((current) =>
      current.map((listing) => (listing.id === updated.id ? updated : listing)),
    );
    setSelectedListing((current) => (current?.id === updated.id ? updated : current));
  }

  /** Take the walkthrough off a listing, at the owner's request and only then. The file goes too. */
  async function removeListingTour(listing: Listing) {
    if (!supabase || !profile || !listing.tour_url) return;
    if (!window.confirm(t("app.removeTheWalkthroughFromThisListingThe"))) {
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase
        .from("listings")
        .update({ tour_url: "", tour_kind: "" })
        .eq("id", listing.id)
        .eq("owner_profile_id", profile.id)
        .select(PUBLIC_LISTING_COLUMNS)
        .single();
      if (error) throw error;
      const path = storagePathFromUrl(listing.tour_url, "marketplace-tours");
      if (path) {
        await supabase.storage.from("marketplace-tours").remove([path]).catch(() => undefined);
      }
      rememberListing({
        ...listing,
        ...(data as Partial<Omit<Listing, "owner">>),
        owner: listing.owner,
      } as Listing);
      setToast("Walkthrough removed.");
      await loadMarketplace();
    } catch (error) {
      setToast(friendlyDbError(error) || "Could not remove the walkthrough.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Take one photo off a listing - at the owner's request, and only then;
   * nothing else on the site removes an uploaded photo. The file goes too,
   * unless the profile or another listing still shows it.
   */
  async function removeListingPhoto(listing: Listing, url: string) {
    if (!supabase || !profile) return;
    if (!window.confirm(t("app.removeThisPhotoFromTheListing"))) return;
    setBusy(true);
    try {
      const remaining = listingImages(listing).filter((item) => item !== url);
      // Taking the last photo off a brief can leave it with none, which is how
      // most briefs are written anyway. Anything else is a listing of real
      // space, where a stock cover beats an empty frame.
      const cover =
        remaining[0] ||
        profile.gallery_urls?.[0] ||
        profile.avatar_url ||
        (isBrief(listing) ? "" : DEFAULT_LISTING_IMAGE);
      const { data, error } = await supabase
        .from("listings")
        .update({
          image_url: cover,
          image_urls: remaining.length ? remaining : cover ? [cover] : [],
        })
        .eq("id", listing.id)
        .eq("owner_profile_id", profile.id)
        .select(PUBLIC_LISTING_COLUMNS)
        .single();
      if (error) throw error;
      const stillShown = new Set<string>([
        profile.avatar_url ?? "",
        ...(profile.gallery_urls ?? []),
        ...ownListings
          .filter((item) => item.id !== listing.id)
          .flatMap((item) => listingImages(item)),
      ]);
      const path = stillShown.has(url) ? null : storagePathFromUrl(url);
      if (path) {
        await supabase.storage.from("marketplace-media").remove([path]).catch(() => undefined);
      }
      rememberListing({
        ...listing,
        ...(data as Partial<Omit<Listing, "owner">>),
        owner: listing.owner,
      } as Listing);
      setToast(
        remaining.length
          ? "Photo removed."
          : "Photo removed. The listing shows a stand-in cover until you add one.",
      );
      await loadMarketplace();
    } catch (error) {
      setToast(friendlyDbError(error) || "Could not remove that photo.");
    } finally {
      setBusy(false);
    }
  }

  /** Put one of the listing's photos first: it becomes the cover on every card. */
  async function makeListingCover(listing: Listing, url: string) {
    if (!supabase || !profile) return;
    setBusy(true);
    try {
      const ordered = [url, ...listingImages(listing).filter((item) => item !== url)];
      const { data, error } = await supabase
        .from("listings")
        .update({ image_url: url, image_urls: ordered })
        .eq("id", listing.id)
        .eq("owner_profile_id", profile.id)
        .select(PUBLIC_LISTING_COLUMNS)
        .single();
      if (error) throw error;
      rememberListing({
        ...listing,
        ...(data as Partial<Omit<Listing, "owner">>),
        owner: listing.owner,
      } as Listing);
      setToast("Cover photo updated.");
      await loadMarketplace();
    } catch (error) {
      setToast(friendlyDbError(error) || "Could not change the cover.");
    } finally {
      setBusy(false);
    }
  }

  async function saveListing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (listingPreview) { setListingFeedback(tx("Preview complete. Nothing was saved.")); return; }
    if (!supabase) return;
    if (!profile) {
      // The session ended while they were typing. The form is uncontrolled and
      // still mounted, so everything they wrote is intact - say so and offer
      // the way back, rather than letting Publish do nothing forever.
      setListingFeedback(
        tx("Your session ended. Sign in again, then press Publish — everything you typed is still here."),
      );
      setAuthMode("signin");
      setAuthOpen(true);
      return;
    }
    const listingForm = event.currentTarget;
    const invalid = (name: string, message: string): never => {
      const target = listingForm.elements.namedItem(name);
      if (target instanceof HTMLElement) { revealInvalidField(target); target.focus(); }
      throw new Error(message);
    };
    const values = new FormData(listingForm);
    const selectedListingFiles = listingFilesRef.current.filter((file) => file.size > 0);
    // A brief published with nothing keeps nothing rather than picking up the
    // stock cover. (Only the insert path reads this; an edit leaves the image
    // columns alone unless photos were chosen.)
    const fallbackImage =
      editingListing?.image_url ||
      profile.gallery_urls?.[0] ||
      profile.avatar_url ||
      (editingListingIsBrief ? "" : DEFAULT_LISTING_IMAGE);
    setListingFeedback("");
    setBusy(true);
    try {
      // The owner's photos stay, in their order, cover first; new ones go
      // after them. Only the seed a photo-less listing was given gives way.
      // Nothing an owner uploaded is ever dropped here - that takes their
      // Remove in the editor - so the cap is checked before a byte uploads
      // rather than trimmed off the end afterwards.
      const keptImages = editingListing
        ? listingImages(editingListing).filter((url) => !listingSeedImages.has(url))
        : [];
      if (keptImages.length + selectedListingFiles.length > MAX_LISTING_PHOTOS) {
        const room = MAX_LISTING_PHOTOS - keptImages.length;
        throw new Error(
          room > 0
            ? `This listing has ${keptImages.length} photos, so you can add ${room} more. Remove one first to add others.`
            : `This listing already has ${MAX_LISTING_PHOTOS} photos. Remove one first to add another.`,
        );
      }
      if (tourPick?.kind === "photo" && !tourSpherical) {
        throw new Error(
          "That walkthrough photo is not a 360° panorama - a 360° photo is exactly twice as wide as tall. Regular photos go in the photos field.",
        );
      }
      const fields = {
        timing_kind: (String(values.get("timing_kind") ?? "") || null) as BookingSchedule["timing_kind"],
        pricing_kind: (String(values.get("pricing_kind") ?? "") || null) as BookingSchedule["pricing_kind"],
        minimum_duration_days: Number(values.get("minimum_duration_days") ?? 1),
        instant_booking_enabled: !editingListingIsBrief && values.get("instant_booking_enabled") === "on",
        availability_dates: JSON.parse(String(values.get("availability_dates") ?? "[]")) as string[],
        booking_duration_days: Number(values.get("booking_duration_days") ?? 1),
        booking_timezone: String(values.get("booking_timezone") ?? "UTC"),
        title: String(values.get("title") ?? "").trim(),
        channel: String(values.get("channel") ?? "").trim(),
        format: String(values.get("format") || values.get("deliverables") || "").trim().split("\n")[0].slice(0, 140),
        price_cents: dollarsToCents(String(values.get("price") ?? "0")),
        price_max_cents: values.get("price_max")
          ? dollarsToCents(String(values.get("price_max")))
          : null,
        price_unit: String(values.get("price_unit") ?? "campaign").trim(),
        description: String(values.get("description") ?? "").trim(),
        demographics: String(values.get("demographics") ?? "").trim(),
        location_area: String(values.get("location_area") ?? "").trim(),
        availability_notes: String(
          values.get("availability_notes") ?? "",
        ).trim(),
        available_from: String(values.get("available_from") ?? "") || null,
        available_to: String(values.get("available_to") ?? "") || null,
        lead_time_days: Number(values.get("lead_time_days") ?? 0) || 0,
        minimum_booking: String(
          values.get("minimum_booking") ?? "",
        ).trim(),
        deliverables: String(values.get("deliverables") ?? "").trim(),
        cancellation_policy: String(
          values.get("cancellation_policy") ?? "",
        ).trim(),
        provenance_status: "owner_attested" as const,
        availability_confirmed_at: new Date().toISOString(),
        // The role-shaped half, spread in only when that section actually
        // rendered. getAll() is why these are real checkboxes rather than the
        // chip component: an uncontrolled form hands us the array with no
        // state to seed. But an unchecked group and an absent group both give
        // [], so each section carries a hidden marker and a section that was
        // not on screen contributes no keys at all - `update` is partial, so
        // the stored values survive untouched.
        ...(values.get("has_space_section")
          ? {
              surface_types: values.getAll("surface_types").map(String),
              install_by: String(values.get("install_by") ?? "") || null,
              space_size: String(values.get("space_size") ?? "").trim(),
              street_address: String(values.get("street_address") ?? "").trim(),
              // Street View: the listing keeps only the capture month, which
              // is the card's caption and its on/off switch, and Google's
              // panorama id, which opens the 360 view of the street.
              street_view_captured: streetView?.captured ?? "",
              street_view_pano: streetView?.captured ? streetView.pano : "",
            }
          : {}),
        ...(values.get("has_sponsor_section")
          ? {
              sponsor_tier:
                String(values.get("sponsor_tier") ?? "").trim() || null,
              sponsor_slots: Number(values.get("sponsor_slots") ?? 0) || null,
            }
          : {}),
        ...(values.get("has_brief_section")
          ? {
              brief_scope: String(values.get("brief_scope") ?? "") || null,
              target_platforms: values.getAll("target_platforms").map(String),
            }
          : {}),
      };

      // `required` is satisfied by a space, and these are trimmed to empty just
      // above, so a nameless listing could publish. There is no CHECK on
      // listings.title to catch it server-side.
      const missing = (
        [
          ["title", "a listing title"],
          ["channel", "where it appears"],
          ["format", "what the buyer gets"],
          ["deliverables", "what’s included"],
        ] as Array<[keyof typeof fields, string]>
      ).find(([key]) => !String(fields[key] ?? "").trim());
      if (missing) {
        invalid(missing[0], `Add ${missing[1]} before publishing.`);
      }
      if (!Number.isSafeInteger(fields.price_cents) || fields.price_cents < 0) {
        throw new Error("Enter a price of 0 or more.");
      }
      // listings_price_max_valid (0017) rejects this at the database, where it
      // reaches the member as an unreadable 23514.
      if (
        typeof fields.price_max_cents === "number" &&
        fields.price_max_cents < fields.price_cents
      ) {
        invalid("price_max", "The maximum price must be at least the starting price.");
      }
      if (
        fields.available_from &&
        fields.available_to &&
        fields.available_to < fields.available_from
      ) {
        invalid("available_to", "Availability must end on or after it starts.");
      }

      if (fields.instant_booking_enabled) {
        if (!isFixedPriceListing(fields) || fields.price_cents <= 0 || fields.deliverables.length < 2 || fields.deliverables.length > 1000 || fields.cancellation_policy.length < 2 || fields.cancellation_policy.length > 1000) {
          throw new Error("Add a price, what’s included, and cancellation terms to allow instant booking.");
        }
        if (!availableStartDates(fields).length) {
          throw new Error("Choose available dates that allow the required notice and minimum duration.");
        }
      }

      const saved = editingListing
        ? await supabase
            .from("listings")
            .update(fields)
            .eq("id", editingListing.id)
            .eq("owner_profile_id", profile.id)
            .select(PUBLIC_LISTING_COLUMNS)
            .single()
        : await supabase
            .from("listings")
            .insert({
              ...fields,
              owner_profile_id: profile.id,
              image_url: fallbackImage,
              image_urls: fallbackImage ? [fallbackImage] : [],
              status: "active",
            })
            .select(PUBLIC_LISTING_COLUMNS)
            .single();
      if (saved.error) throw saved.error;

      let savedListing = {
        ...(editingListing ?? {}),
        ...fields,
        ...(saved.data as Partial<Omit<Listing, "owner">>),
        owner: profile,
      } as Listing;
      setOwnListings((current) => [
        savedListing,
        ...current.filter((listing) => listing.id !== savedListing.id),
      ]);

      let photoWarning = "";
      if (selectedListingFiles.length) {
        try {
          const uploadedImages = await uploadImages(selectedListingFiles, "listings");
          const imageUrls = [...keptImages, ...uploadedImages].slice(0, MAX_LISTING_PHOTOS);
          if (imageUrls.length) {
            const updated = await supabase
              .from("listings")
              .update({ image_url: imageUrls[0], image_urls: imageUrls })
              .eq("id", savedListing.id)
              .eq("owner_profile_id", profile.id)
              .select(PUBLIC_LISTING_COLUMNS)
              .single();
            if (updated.error) throw updated.error;
            savedListing = {
              ...savedListing,
              ...(updated.data as Partial<Omit<Listing, "owner">>),
              owner: profile,
            };
            setOwnListings((current) =>
              current.map((listing) =>
                listing.id === savedListing.id ? savedListing : listing,
              ),
            );
          }
        } catch (photoError) {
          // The listing row is already committed, so this is not fatal - but
          // swallowing the reason left the member retrying a file that will
          // never work (too large, wrong format, offline) with no way to know.
          const why = friendlyDbError(photoError);
          photoWarning = ` The listing is saved, but the photos could not upload${
            why ? `: ${why}` : "."
          } You can add them from Edit listing.`;
        }
      }

      let tourWarning = "";
      if (tourPick) {
        try {
          const uploaded = await uploadTour(tourPick, tourSpherical);
          const previous = savedListing.tour_url ?? "";
          const updated = await supabase
            .from("listings")
            .update({ tour_url: uploaded.url, tour_kind: uploaded.kind })
            .eq("id", savedListing.id)
            .eq("owner_profile_id", profile.id)
            .select(PUBLIC_LISTING_COLUMNS)
            .single();
          if (updated.error) {
            // Nothing points at the file; do not leave it public.
            await supabase.storage
              .from("marketplace-tours")
              .remove([uploaded.path])
              .catch(() => undefined);
            throw updated.error;
          }
          savedListing = {
            ...savedListing,
            ...(updated.data as Partial<Omit<Listing, "owner">>),
            owner: profile,
          };
          setOwnListings((current) =>
            current.map((listing) =>
              listing.id === savedListing.id ? savedListing : listing,
            ),
          );
          // The one it replaces is the owner's to drop: they chose the new one.
          const oldPath =
            previous && previous !== uploaded.url
              ? storagePathFromUrl(previous, "marketplace-tours")
              : null;
          if (oldPath) {
            await supabase.storage
              .from("marketplace-tours")
              .remove([oldPath])
              .catch(() => undefined);
          }
        } catch (tourError) {
          const why = friendlyDbError(tourError);
          tourWarning = ` The walkthrough could not upload${
            why ? `: ${why}` : "."
          } You can add it from Edit listing.`;
        }
      }

      const wasEditing = Boolean(editingListing);
      const remainingDraft = !wasEditing && Object.entries(newListingDrafts).find(([kind, draft]) => kind !== newListingOffer && draft?.listing.title);
      const anotherTier = !wasEditing && values.get("add_another_tier") === "on";
      setListingOpen(Boolean(remainingDraft) || anotherTier);
      if (anotherTier) {
        setNewListingDrafts((current) => ({ ...current, sponsorship: { listing: { ...fields, title: "", sponsor_tier: "", price_cents: undefined }, files: selectedListingFiles } }));
        setComposerRevision((current) => current + 1);
      }
      if (remainingDraft && !anotherTier) {
        setNewListingOffer(remainingDraft[0] as CreatorOfferType);
        setNewListingDrafts((current) => { const next = { ...current }; delete next[newListingOffer]; return next; });
      }
      resetAiHelpers();
      setEditingListing(null);
      setAccountOpen(false);
      setToast(
        wasEditing
          ? `Your listing changes are saved.${photoWarning}${tourWarning}`
          : `Your listing is live and ready to manage in Dashboard.${photoWarning}${tourWarning}`,
      );
      await Promise.all([loadMarketplace(), loadOwnListings(profile)]);
    } catch (error) {
      const message =
        friendlyDbError(error) || "Could not save your listing. Please try again.";
      setListingFeedback(tx(message));
      setToast(message);
    } finally {
      setBusy(false);
    }
  }

  async function loadMessages(conversation: Conversation, contact: Profile) {
    if (!supabase) return;
    // Opening B while A's fetch is still running must not paint A's private
    // messages under B's name and photo - the member would be reading one
    // person's words while every reply they typed went to a different person.
    const seq = ++threadSeqRef.current;
    setActiveThread(conversation);
    setActiveContact(contact);
    setMessages([]);
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversation.id)
      // Newest-first with an explicit bound, reversed below for display.
      // Ordering ascending with no limit let PostgREST's 1000-row cap truncate
      // from the wrong end: a long conversation rendered its oldest thousand
      // messages and silently hid everything recent, including the reply the
      // member had just been notified about.
      .order("created_at", { ascending: false })
      .limit(MESSAGE_PAGE_SIZE);
    if (seq !== threadSeqRef.current) return;
    if (error) {
      // Without this an existing conversation renders as permanently empty,
      // which reads as "they never replied" rather than "we could not load it".
      setToast(friendlyDbError(error) || "We could not load that conversation.");
      return;
    }
    const rows = ((data as Message[] | null) ?? []).slice().reverse();
    // Merge rather than replace. setActiveThread above already committed, so
    // the per-thread realtime channel is subscribed and may have appended a
    // message while this fetch was in flight; a wholesale replace dropped it
    // until the next reload.
    setMessages((current) => {
      const seen = new Set(rows.map((row) => row.id));
      const pending = current.filter((message) => !seen.has(message.id));
      return pending.length ? [...rows, ...pending] : rows;
    });
    if (profile) {
      const unreadHere = rows.filter(
        (message) =>
          message.sender_profile_id !== profile.id && !message.read_at,
      );
      if (unreadHere.length) {
        await supabase
          .from("messages")
          .update({ read_at: new Date().toISOString() })
          .eq("conversation_id", conversation.id)
          .neq("sender_profile_id", profile.id)
          .is("read_at", null);
      }
      // Recount unconditionally, from the database rather than subtracting
      // locally: the two sides of this counter never saw the same set of
      // messages, so it drifted. Gating this on unreadHere.length left the
      // badge stuck whenever another session had already marked the thread
      // read - opening the conversation was then the one action that could
      // not clear it.
      await reconcileUnreadCount(profile);
    }
  }


  /** Existing thread with this member, or null. Never creates one. */
  async function findConversation(target: Profile) {
    if (!supabase || !profile || target.id === profile.id) return null;
    const [participantA, participantB] = [profile.id, target.id].sort();
    const { data } = await supabase
      .from("conversations")
      .select("*")
      .eq("participant_a", participantA)
      .eq("participant_b", participantB)
      .maybeSingle();
    return (data as Conversation | null) ?? null;
  }

  /**
   * Recount unread from the database rather than trusting the running total.
   * The badge is incremented by the realtime listener and decremented when a
   * thread is opened, but those two do not see the same set of messages - the
   * listener skips anything for the thread already on screen - so the count
   * drifted and could reach zero while unread messages were still waiting.
   */
  async function reconcileUnreadCount(ownProfile: Profile) {
    if (!supabase) return;
    // Read the block list through the ref, not the state variable: this runs
    // from realtime handlers that captured an older render, and the count has
    // to match the set loadInbox renders or the badge never reaches zero.
    const { count, error } = await countUnread(
      ownProfile,
      blockedIdsRef.current,
    );
    if (!error) setUnreadCount(count ?? 0);
  }

  async function loadInbox() {
    if (!supabase || !profile) return;
    setInboxState("loading");
    const { data: conversationData, error } = await supabase
      .from("conversations")
      .select("*")
      .or(
        `participant_a.eq.${profile.id},participant_b.eq.${profile.id}`,
      )
      .order("updated_at", { ascending: false });
    if (error) {
      setInboxState("error");
      return setToast(friendlyDbError(error));
    }
    const conversations = (conversationData as Conversation[] | null) ?? [];
    const otherIds = conversations.map((item) =>
      item.participant_a === profile.id
        ? item.participant_b
        : item.participant_a,
    );
    const { data: peopleData } = otherIds.length
      ? await supabase
          .from("profiles")
          .select(PUBLIC_PROFILE_COLUMNS)
          .in("id", otherIds)
      : { data: [] };
    const people = safeProfiles(peopleData);
    setThreads(
      conversations
        .map((item) => ({
          ...item,
          other: people.find((person) =>
            [item.participant_a, item.participant_b].includes(person.id),
          )!,
        }))
        .filter((item) => item.other),
    );
    // Deliberately stored unfiltered. Blocking is applied by `visibleThreads`,
    // which re-derives whenever the block list changes - filtering here instead
    // baked in whatever blockedProfileIds happened to hold at load time, and
    // the inbox is reachable before loadAccountMarketplaceState resolves, so a
    // blocked member's thread stayed visible for the rest of the session.
    setInboxState("ready");
  }

  async function ensureConversation(target: Profile) {
    if (!supabase || !profile || target.id === profile.id) return;
    const [participantA, participantB] = [profile.id, target.id].sort();
    let { data } = await supabase
      .from("conversations")
      .select("*")
      .eq("participant_a", participantA)
      .eq("participant_b", participantB)
      .maybeSingle();
    if (!data) {
      const inserted = await supabase
        .from("conversations")
        .insert({
          participant_a: participantA,
          participant_b: participantB,
        })
        .select()
        .single();
      if (inserted.error) return setToast(friendlyDbError(inserted.error));
      data = inserted.data;
    }
    return data as Conversation;
  }

  async function startConversation(target: Profile) {
    const conversation = await ensureConversation(target);
    if (!conversation) return;
    setInboxOpen(true);
    await loadInbox();
    await loadMessages(conversation, target);
  }

  function openCampaignFlow(
    listing: Listing,
    mode: CampaignRequestMode = "offer",
  ) {
    if (!isListingRequestable(listing)) {
      setToast(
        listing.owner.is_demo
          ? "This is a clearly labeled example, not inventory you can request."
          : "This listing is view-only until its owner confirms the source and availability.",
      );
      return;
    }
    if (mode === "buy_now" && isBrief(listing)) {
      setToast(
        "Business briefs use Make an offer so you can propose the right fit.",
        "problem",
      );
      return;
    }
    if (mode === "buy_now" && !isFixedPriceListing(listing)) {
      setToast(
        "This listing has a price range. Make an offer to agree on the exact terms.",
        "problem",
      );
      return;
    }
    requireAccount(() => {
      if (listing.owner.id === profile?.id) {
        setToast(
          "This is your listing. Manage incoming requests in Dashboard.",
          "problem",
        );
        return;
      }
      // Opening the offer form is the strongest thing somebody does short of
      // paying, so it is weighted heaviest in what we show them next.
      trackOffer(listing.id);
      closeListing();
      setCampaignFeedback("");
      setCampaignRequestMode(mode);
      setCampaignListing(listing);
    });
  }

  function openCampaignRequest(listing: Listing) {
    openCampaignFlow(listing, "offer");
  }

  async function submitCampaignRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !campaignListing) return;
    if (!profile) {
      // Session ended mid-offer; the form still holds everything they wrote.
      setCampaignFeedback(
        tx("Your session ended. Sign in again, then send it — your details are still here."),
      );
      setAuthMode("signin");
      setAuthOpen(true);
      return;
    }
    setCampaignFeedback("");
    const form = event.currentTarget;
    const values = new FormData(form);
    const startDate = String(values.get("start_date") ?? "");
    const endDate = String(values.get("end_date") ?? "");
    if (!startDate || !endDate) {
      setCampaignFeedback(tx("Choose your delivery date or campaign dates."));
      return;
    }
    if (endDate < startDate) {
      setCampaignFeedback(tx("Choose an end date on or after the start date."));
      return;
    }
    // A window that has already elapsed cannot be run. The common way in is a
    // mistyped year on the native date picker, which otherwise commits both
    // sides to negotiating a campaign that can never happen.
    if (endDate < calendarToday(campaignListing.booking_timezone)) {
      setCampaignFeedback(
        tx("That campaign window has already ended. Pick dates that run today or later."),
      );
      return;
    }
    if (campaignRequestMode === "buy_now") {
      const minimumDate = listingBookingMinDate(campaignListing);
      if (startDate < minimumDate) {
        setCampaignFeedback(
          tx("This listing needs dates starting {displayDate} or later.", { displayDate: displayDate(minimumDate, t, locale) }),
        );
        return;
      }
      if (campaignListing.available_to && endDate > campaignListing.available_to) {
        setCampaignFeedback(
          tx("Choose an end date on or before {displayDate}.", { displayDate: displayDate(campaignListing.available_to, t, locale) }),
        );
        return;
      }
    }

    setBusy(true);
    // Validate against the database's own bounds BEFORE creating anything.
    // This used to open the conversation first, so a brief the database then
    // rejected left a permanent empty thread in the owner's inbox and showed
    // the member a raw constraint error.
    const campaignName = String(values.get("campaign_name") || campaignListing.title).trim().slice(0, 120);
    const goals = String(values.get("goals") ?? "").trim();
    const notes = String(values.get("notes") ?? "").trim();
    const isBookAsListed = campaignRequestMode === "buy_now";
    const listedDeliverables =
      campaignListing.deliverables?.trim() || campaignListing.format.trim();
    const deliverables = isBookAsListed
      ? listedDeliverables
      : String(values.get("requested_deliverables") ?? "").trim();
    const budgetInput = String(values.get("budget") ?? "").trim();
    const proposedBudget = Number(budgetInput);

    // Count the way Postgres does. JS .length counts UTF-16 code units, so five
    // emoji read as 10 and slipped past a minimum the database then rejected -
    // after the conversation had already been created.
    if (charCount(campaignName) < 2 || charCount(campaignName) > 120) {
      setBusy(false);
      return setCampaignFeedback(tx("Give the campaign a name between 2 and 120 characters."));
    }
    if (charCount(goals) > 1500) {
      setBusy(false);
      return setCampaignFeedback(
        tx("Keep campaign details under 1,500 characters."),
      );
    }
    if (charCount(deliverables) < 2 || charCount(deliverables) > 1000) {
      setBusy(false);
      return setCampaignFeedback(tx("Say what you are asking for (2 to 1000 characters)."));
    }
    if (charCount(notes) > 2000) {
      setBusy(false);
      return setCampaignFeedback(tx("Notes are limited to 2000 characters."));
    }
    if (
      !isBookAsListed &&
      (!budgetInput || !Number.isFinite(proposedBudget) || proposedBudget < 0)
    ) {
      setBusy(false);
      return setCampaignFeedback(tx("Enter a budget of 0 or more."));
    }

    let budgetCents = campaignListing.price_cents;
    if (isBookAsListed) {
      const quoted = Number(values.get("quote_subtotal"));
      if (!Number.isSafeInteger(quoted) || quoted <= 0 || !values.get("quote_version")) {
        setBusy(false); setCampaignFeedback(tx("Choose available dates and wait for the price before sending.")); return;
      }
      budgetCents = quoted;
    }
    if (!isBookAsListed) {
      try {
        budgetCents = dollarsToCents(budgetInput);
      } catch (error) {
        setBusy(false);
        return setCampaignFeedback(
          tx(error instanceof Error
            ? error.message
            : "Enter a dollar amount with no more than two decimals."),
        );
      }
    }

    // Was this pair already talking? If so the thread is pre-existing and
    // reusing it costs nothing. If not, do NOT open one yet: a request the
    // database still rejects would strand an empty thread in both inboxes.
    const existingConversation = await findConversation(campaignListing.owner);

    const inserted = await supabase
      .from("campaign_requests")
      .insert({
        listing_id: campaignListing.id,
        requester_profile_id: profile.id,
        owner_profile_id: campaignListing.owner.id,
        conversation_id: existingConversation?.id ?? null,
        purchase_mode: campaignRequestMode,
        timing_kind: campaignListing.timing_kind ?? null,
        listing_terms: isBookAsListed ? { listing_updated_at: String(values.get("quote_version")) } : {},
        campaign_name: campaignName,
        goals,
        requested_deliverables: deliverables,
        budget_cents: budgetCents,
        start_date: startDate,
        end_date: endDate,
        notes,
        status: "pending",
      })
      .select()
      .single();

    if (inserted.error) {
      setBusy(false);
      setCampaignFeedback(tx(friendlyDbError(inserted.error)));
      return;
    }

    // The request is safely stored, so a thread is now warranted. Open one if
    // this pair had none, and attach it to the request.
    const conversation =
      existingConversation ?? (await ensureConversation(campaignListing.owner));
    if (conversation) {
      if (!existingConversation) {
        const insertedRequestId = (inserted.data as { id: string }).id;
        const linked = await supabase.rpc(
          "link_campaign_request_conversation",
          {
            target_request_id: insertedRequestId,
            target_conversation_id: conversation.id,
          },
        );
        if (linked.error || linked.data !== insertedRequestId) {
          // Not fatal: the request and the thread both exist, they are just not
          // cross-linked. Say so rather than pretending it all worked.
          setToast(
            "{value} sent, but we could not attach it to the message thread.", undefined, { value: isBookAsListed ? "Booking request" : "Offer" },
          );
        }
      }
      await supabase.from("messages").insert({
        conversation_id: conversation.id,
        sender_profile_id: profile.id,
        body: `${isBookAsListed ? "Book as listed" : "Offer"}: ${campaignName}\n${bookingDateLabel(campaignListing.timing_kind, startDate, endDate)} · Budget ${formatCents(budgetCents)}\n${isBookAsListed ? "Listed deliverables" : "Requested"}: ${deliverables}`,
      });
    }

    setCampaignListing(null);
    setCampaignRequestMode("offer");
    setBusy(false);
    setToast(
      campaignListing.owner.is_demo
        ? `Demo ${isBookAsListed ? "booking" : "offer"} saved. This sample profile is not a real recipient.`
        : isBookAsListed
          ? "Booking request sent. The owner will confirm availability before payment."
            : "Offer sent. You can track it in Dashboard.",
    );
    await Promise.all([
      loadAccountMarketplaceState(profile),
      loadInbox(),
    ]);
  }

  async function respondToCampaignRequest(
    request: CampaignRequest,
    status: "accepted" | "declined" | "cancelled",
  ) {
    if (!supabase || !profile) return;
    setBusy(true);
    const { error } = await supabase.rpc("respond_campaign_request", {
      request_id: request.id,
      next_status: status,
      proposed_budget_cents: null,
      response_message: "",
    });
    setBusy(false);
    if (error) {
      // The definer function raises its own human-readable messages for
      // out-of-order transitions, so pass those through unchanged.
      setToast(friendlyDbError(error));
      await loadAccountMarketplaceState(profile);
      return;
    }
    setToast(
      status === "accepted"
        ? `${request.purchase_mode === "buy_now" ? "Booking" : "Offer"} accepted. Payment is required before the work is confirmed.`
        : status === "declined"
          ? `${request.purchase_mode === "buy_now" ? "Booking" : "Offer"} declined.`
          : `${request.purchase_mode === "buy_now" ? "Booking" : "Offer"} cancelled.`,
    );
    await loadAccountMarketplaceState(profile);
  }

  async function openStripeFlow(
    endpoint: "/api/stripe/connect/onboard" | "/api/stripe/connect/login",
  ) {
    setBusy(true);
    try {
      const response = await fetch(endpoint, { method: "POST" });
      const payload = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !payload.url) {
        throw new Error(payload.error || "Stripe did not return a secure link.");
      }
      window.location.assign(payload.url);
    } catch (error) {
      setToast(
        error instanceof Error
          ? error.message
          : "Could not open Stripe. Please try again.",
      );
      setBusy(false);
    }
  }

  function startInstantCheckout(listing: Listing, bookingDate: string, bookingEndDate: string) {
    requireAccount(() => {
      if (listing.owner_profile_id === profile?.id) {
        setToast(
          "This is your listing. Manage its available dates in Dashboard.",
          "problem",
        );
        return;
      }
      void (async () => {
        setBusy(true);
        try {
          const response = await fetch("/api/stripe/checkout", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ listingId: listing.id, bookingDate, bookingEndDate, listingUpdatedAt: listing.updated_at }),
          });
          const result = await response.json() as { url?: string; error?: string };
          if (!response.ok || !result.url) throw new Error(result.error || "Could not open checkout. Please try again.");
          window.location.assign(result.url);
        } catch (error) {
          setToast(error instanceof Error ? error.message : "Could not open checkout.");
          setBusy(false);
        }
      })();
    });
  }

  async function startCampaignCheckout(campaignRequestId: string) {
    if (!profile) return;
    setBusy(true);
    try {
      const response = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ campaignRequestId }),
      });
      const payload = (await response.json()) as { url?: string; error?: string };
      if (!response.ok || !payload.url) {
        throw new Error(payload.error || "Checkout could not be created.");
      }
      window.location.assign(payload.url);
    } catch (error) {
      setToast(
        error instanceof Error
          ? error.message
          : "Checkout could not be created. Please try again.",
      );
      setBusy(false);
      await loadAccountMarketplaceState(profile);
    }
  }

  async function runCampaignPaymentAction(
    transaction: PaymentTransaction,
    action: "deliver" | "confirm" | "report_issue" | "escalate",
  ) {
    if (!profile) return;
    let details: string | undefined;
    if (action === "report_issue") {
      const entered = window.prompt(
        "Describe what is incomplete or needs to be resolved. The Creator will be able to discuss it with you in Messages.",
      );
      if (entered === null) return;
      details = entered.trim();
      if (details.length < 10) {
        setToast("Please describe the issue in at least 10 characters.");
        return;
      }
    }
    setBusy(true);
    try {
      const response = await fetch(
        `/api/payments/transactions/${transaction.id}/actions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, details }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "That action could not be completed.");
      setToast(
        action === "deliver"
          ? "Campaign marked delivered. The payer now has 72 hours to review it."
          : action === "confirm"
            ? "Work confirmed. The Creator payout was released."
            : action === "report_issue"
              ? "Issue reported. The payout remains pending while you resolve it together."
              : "Issue escalated to SideSpace for staff review.",
      );
      await loadAccountMarketplaceState(profile);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "That action could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCreatorPortfolioItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !profile || canonicalRole(profile.role) !== "creator") return;
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    const { error } = await supabase.from("creator_portfolio_items").insert({
      creator_profile_id: profile.id,
      title: String(values.get("title") ?? "").trim(),
      description: String(values.get("description") ?? "").trim(),
      kind: String(values.get("kind") ?? "project"),
      media_url: String(values.get("media_url") ?? "").trim(),
      project_url: String(values.get("project_url") ?? "").trim(),
      sort_order: creatorPortfolio.length,
      published: true,
    });
    setBusy(false);
    if (error) return setToast(friendlyDbError(error));
    form.reset();
    setToast("Portfolio item published to your Creator profile.");
    await loadAccountMarketplaceState(profile);
  }

  async function deleteCreatorPortfolioItem(itemId: string) {
    if (!supabase || !profile) return;
    setBusy(true);
    const { error } = await supabase
      .from("creator_portfolio_items")
      .delete()
      .eq("id", itemId)
      .eq("creator_profile_id", profile.id);
    setBusy(false);
    if (error) return setToast(friendlyDbError(error));
    setToast("Portfolio item removed.");
    await loadAccountMarketplaceState(profile);
  }

  async function submitCreatorReview(transaction: PaymentTransaction) {
    if (!profile) return;
    const ratingInput = window.prompt("Rate the Creator from 1 to 5.", "5");
    if (ratingInput === null) return;
    const rating = Number(ratingInput);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      setToast("Choose a whole-number rating from 1 to 5.");
      return;
    }
    const review = window.prompt(
      "Share what the Creator delivered and what it was like to work together.",
    );
    if (review === null) return;
    if (review.trim().length < 10) {
      setToast("Write at least 10 characters so the review is useful.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(
        `/api/payments/transactions/${transaction.id}/review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rating, review: review.trim() }),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Review could not be saved.");
      setToast("Review published on the Creator's profile.");
      await loadAccountMarketplaceState(profile);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Review could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function submitCounteroffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !profile || !counteringRequest) return;
    if (counteringRequest.purchase_mode === "buy_now") {
      setCounteringRequest(null);
      setToast("Book-as-listed terms are fixed. Send an offer if they need to change.");
      return;
    }
    const values = new FormData(event.currentTarget);
    setBusy(true);
    const { error } = await supabase.rpc("respond_campaign_request", {
      request_id: counteringRequest.id,
      next_status: "countered",
      proposed_budget_cents: dollarsToCents(
        String(values.get("counter_budget") ?? "0"),
      ),
      response_message: String(values.get("counter_message") ?? "").trim(),
    });
    setBusy(false);
    if (error) {
      setToast(friendlyDbError(error));
      return;
    }
    setCounteringRequest(null);
    setToast("Counteroffer sent to the requester.");
    await loadAccountMarketplaceState(profile);
  }

  async function submitVerificationRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !profile || profile.role === "consumer") return;
    const values = new FormData(event.currentTarget);
    setBusy(true);
    const { data, error } = await supabase
      .from("verification_requests")
      .insert({
        profile_id: profile.id,
        verification_type: profile.role,
        evidence_url: String(values.get("evidence_url") ?? "").trim(),
        social_platform: String(values.get("social_platform") ?? "").trim(),
        social_handle: String(values.get("social_handle") ?? "").trim(),
        message: String(values.get("verification_message") ?? "").trim(),
        status: "pending",
      })
      .select()
      .single();
    setBusy(false);
    if (error) {
      setToast(friendlyDbError(error));
      return;
    }
    setVerificationRequest(data as VerificationRequest);
    setVerificationOpen(false);
    setProfile((current) =>
      current ? { ...current, verification_status: "pending" } : current,
    );
    setToast("Verification request submitted for SideSpace review.");
  }

  async function submitProfileReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !profile || !reportTarget) return;
    const values = new FormData(event.currentTarget);
    setBusy(true);
    const { error } = await supabase.from("profile_reports").insert({
      reporter_profile_id: profile.id,
      reported_profile_id: reportTarget.profile.id,
      listing_id: reportTarget.listing?.id ?? null,
      reason: String(values.get("reason") ?? "other"),
      details: String(values.get("details") ?? "").trim(),
      status: "open",
    });
    setBusy(false);
    if (error) {
      setToast(friendlyDbError(error));
      return;
    }
    setReportTarget(null);
    setToast("Report submitted. The SideSpace team will review it.");
  }

  async function blockProfile(target: Profile) {
    if (!supabase || !profile || target.id === profile.id) return;
    setBusy(true);
    const { error } = await supabase.from("profile_blocks").insert({
      blocker_profile_id: profile.id,
      blocked_profile_id: target.id,
    });
    setBusy(false);
    if (error && error.code !== "23505") {
      setToast(friendlyDbError(error));
      return;
    }
    const nextBlocked = blockedProfileIds.includes(target.id)
      ? blockedProfileIds
      : [...blockedProfileIds, target.id];
    blockedIdsRef.current = nextBlocked;
    setBlockedProfileIds(nextBlocked);
    setBlockedProfiles((current) =>
      current.some((item) => item.id === target.id)
        ? current
        : [...current, { id: target.id, display_name: target.display_name }],
    );
    // The thread drops out of the inbox via `visibleThreads` as soon as the
    // block list updates above; it is deliberately left in the raw `threads`
    // list so unblocking restores it without a reload.
    if (activeThread && activeContact?.id === target.id) {
      setActiveThread(null);
      setActiveContact(null);
      setMessages([]);
    }
    // closeListing() also drops ?listing= from the URL; leaving it would let
    // the deep-link effect immediately reopen the listing just blocked.
    closeListing();
    // Their unread messages are still unread rows in the database, but the
    // thread is gone from the inbox. Recount now that the ref excludes them,
    // otherwise the badge keeps a count for conversations that no longer
    // appear anywhere on screen.
    await reconcileUnreadCount(profile);
    setToast(
      "{display_name} is now hidden. You can undo this in Profile & settings.", undefined, { display_name: target.display_name },
    );
  }

  async function unblockProfile(blockedId: string, name: string) {
    if (!supabase || !profile) return;
    setBusy(true);
    const { error } = await supabase
      .from("profile_blocks")
      .delete()
      .eq("blocker_profile_id", profile.id)
      .eq("blocked_profile_id", blockedId);
    setBusy(false);
    if (error) {
      setToast(friendlyDbError(error));
      return;
    }
    const nextBlocked = blockedProfileIds.filter((id) => id !== blockedId);
    blockedIdsRef.current = nextBlocked;
    setBlockedProfileIds(nextBlocked);
    void reconcileUnreadCount(profile);
    setBlockedProfiles((current) =>
      current.filter((item) => item.id !== blockedId),
    );
    setToast("{name} is visible again.", undefined, { name });
    await loadMarketplace();
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !profile || !activeThread) return;
    // Nothing disables the composer while the insert is in flight, so without
    // this a second click sends the same message twice - and the first thing a
    // listing owner sees is the same pitch pasted twice.
    if (sendingMessageRef.current) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const body = String(values.get("body") ?? "").trim();
    if (!body) return;
    sendingMessageRef.current = true;
    const thread = activeThread;
    // Capture the thread sequence so a send that resolves after the member
    // switched conversations is not painted into the wrong transcript.
    const sendSeq = threadSeqRef.current;
    try {
      const { data, error } = await supabase
        .from("messages")
        .insert({
          conversation_id: thread.id,
          sender_profile_id: profile.id,
          body,
        })
        .select()
        .single();
      if (error) {
        // Keep what they typed so it can be retried rather than retyped.
        setToast(friendlyDbError(error));
        return;
      }
      form.reset();
      // Show it immediately rather than waiting on the realtime round trip,
      // which otherwise makes a sent message look like it vanished.
      const saved = data as Message | null;
      if (saved && threadSeqRef.current === sendSeq) {
        setMessages((current) =>
          current.some((message) => message.id === saved.id)
            ? current
            : [...current, saved],
        );
      }
    } finally {
      sendingMessageRef.current = false;
    }
  }

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !user) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const currentPassword = String(values.get("current_password") ?? "");
    const password = String(values.get("new_password") ?? "");
    const confirmation = String(values.get("confirm_password") ?? "");

    if (password.length < 8) {
      setToast("Use at least 8 characters for your new password.");
      return;
    }
    if (password !== confirmation) {
      setToast("The two passwords do not match.", "problem");
      return;
    }
    if (!currentPassword) {
      setToast("Enter your current password to confirm the change.", "problem");
      return;
    }

    setBusy(true);
    // Reauthenticate first. updateUser({ password }) only needs a live session,
    // so anyone reaching an unlocked, signed-in browser could set a new
    // password without knowing the old one and lock the owner out of their own
    // account. Supabase's secure_password_change is off for this project
    // (supabase/config.toml), so this check is the only thing standing there.
    if (!user.email) {
      setBusy(false);
      setToast("Your account has no email address, so we cannot verify it's you.");
      return;
    }
    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });
    if (reauthError) {
      setBusy(false);
      setToast("That current password is not right.", "problem");
      return;
    }

    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setToast(friendlyDbError(error));
      return;
    }
    form.reset();
    setToast("Your password has been updated.");
  }

  async function emailPasswordReset(explicitEmail?: string) {
    if (!supabase) return;
    const address = (explicitEmail ?? user?.email ?? "").trim();
    if (!address) {
      setToast(
        "Enter your email address first, then choose Forgot password.",
        "problem",
      );
      return;
    }
    setBusy(true);
    const { error } = await supabase.auth.resetPasswordForEmail(address, {
      // The callback exchanges the code server-side, so mark the return trip
      // and let the client open the password form.
      redirectTo: `${window.location.origin}/auth/callback?next=%2F%3Frecovery%3D1`,
    });
    setBusy(false);
    if (error) {
      setToast(friendlyDbError(error));
      return;
    }
    setToast("A secure reset link was sent to {address}.", undefined, { address });
  }

  async function updateListingStatus(listing: Listing) {
    if (!supabase || !profile) return;
    const nextStatus = listing.status === "active" ? "paused" : "active";
    setBusy(true);
    const { error } = await supabase
      .from("listings")
      .update({ status: nextStatus })
      .eq("id", listing.id)
      .eq("owner_profile_id", profile.id);
    setBusy(false);
    if (error) {
      setToast(friendlyDbError(error));
      return;
    }
    setToast(nextStatus === "active" ? "Listing is live again." : "Listing paused.");
    // The listing page can be the thing that was just paused, and it holds its
    // own copy of the row - without this it keeps offering "Pause listing"
    // after the pause went through.
    setSelectedListing((current) =>
      current && current.id === listing.id
        ? { ...current, status: nextStatus }
        : current,
    );
    await Promise.all([loadMarketplace(), loadOwnListings(profile)]);
  }

  /**
   * Delete one of your own listings. The database function refuses when
   * money has moved on it (the payment record must keep pointing at a
   * listing), declines any open request first so the business hears, then
   * removes the row; requests go with it. Photos come out of storage
   * afterwards - only the ones nothing else of yours still shows, because a
   * listing published without photos is seeded with the profile picture.
   */
  async function deleteListing(listing: Listing) {
    if (!supabase || !profile) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("delete_own_listing", {
      target_listing_id: listing.id,
    });
    if (error) {
      setBusy(false);
      setToast(friendlyDbError(error));
      return;
    }
    const declined = typeof data === "number" ? data : 0;
    setDeleteListingTarget(null);
    if (selectedListing?.id === listing.id) setSelectedListing(null);

    const stillShown = new Set<string>([
      profile.avatar_url ?? "",
      ...(profile.gallery_urls ?? []),
      ...ownListings
        .filter((item) => item.id !== listing.id)
        .flatMap((item) => listingImages(item)),
    ]);
    const paths = listingImages(listing)
      .filter((url) => url && !stillShown.has(url))
      .map((url) => storagePathFromUrl(url))
      .filter((path): path is string => Boolean(path));
    if (paths.length) {
      // Best effort: a stray file in the bucket is recoverable, and a
      // cleanup failure reported on top of a successful delete only confuses.
      await supabase.storage
        .from("marketplace-media")
        .remove(paths)
        .catch(() => undefined);
    }
    const tourPath = listing.tour_url
      ? storagePathFromUrl(listing.tour_url, "marketplace-tours")
      : null;
    if (tourPath) {
      await supabase.storage
        .from("marketplace-tours")
        .remove([tourPath])
        .catch(() => undefined);
    }
    setBusy(false);
    setToast(
      declined
        ? `Listing deleted. ${declined} open request${declined === 1 ? " was" : "s were"} declined and the sender${declined === 1 ? "" : "s"} told.`
        : "Listing deleted.",
    );
    await Promise.all([
      loadMarketplace(),
      loadOwnListings(profile),
      loadAccountMarketplaceState(profile),
    ]);
  }

  function clearSessionState() {
    setProfile(null);
    setProfileChecked(false);
    setOwnListings([]);
    setLikedListingIds(new Set());
    setLikesLoading(false);
    setPendingLikeIds(new Set());
    likeRequestsRef.current.clear();
    setCampaignRequests([]);
    setPaymentTransactions([]);
    setAdCreditBalanceCents(0);
    setCreatorPortfolio([]);
    setCreatorReviews([]);
    setSelectedCreatorPortfolio([]);
    setSelectedCreatorReviews([]);
    setStripeAccountStatus(null);
    setVerificationRequest(null);
    setBlockedProfileIds([]);
    setBlockedLoaded(false);
    setBlockedProfiles([]);
    setThreads([]);
    setActiveThread(null);
    setActiveContact(null);
    setMessages([]);
    setInboxOpen(false);
    setAccountOpen(false);
    setOnboardingOpen(false);
    setUnreadCount(0);
    blockedIdsRef.current = [];
    // These overlays render on their own state alone, with no `&& profile`
    // guard. Leaving them mounted through a sign-out left a dialog on screen
    // whose submit handler returns early on the now-null profile - a form that
    // looks live, accepts input, and silently does nothing when submitted.
    setCounteringRequest(null);
    setReportTarget(null);
    setSelectedListing(null);
    setEditingListing(null);
    setListingOpen(false);
    resetAiHelpers();
    setVerificationOpen(false);
    setDeleteAccountOpen(false);
    resetIgAvatarSync();
  }

  async function signOut() {
    const { error } = (await supabase?.auth.signOut()) ?? { error: null };
    // auth-js clears the local session before the network call and reports
    // an error if the server leg fails. Ask what actually happened rather
    // than trusting the error: claiming they are still signed in when the
    // session is already gone is the dangerous direction to be wrong in,
    // and the Log out button they are told to retry has already unmounted.
    const stillSignedIn = error
      ? Boolean((await supabase?.auth.getSession())?.data.session)
      : false;
    if (error && stillSignedIn) {
      // Never claim to have signed someone out while their session cookie is
      // still valid: on a shared machine the next person would be restored
      // into this account. Say it failed and leave them signed in.
      setToast(
        "We could not sign you out. Check your connection and try again — you are still signed in.",
      );
      return;
    }
    setUser(null);
    lastAuthUserIdRef.current = null;
    clearSessionState();
    setToast("Signed out.");
  }

  /** Public storage URLs look like .../object/public/<bucket>/<path>. */
  function storagePathFromUrl(url: string, bucket = "marketplace-media") {
    const marker = `/${bucket}/`;
    const index = url.indexOf(marker);
    if (index === -1) return null;
    return decodeURIComponent(url.slice(index + marker.length).split("?")[0]);
  }

  async function removeProfilePhoto(url: string, kind: "gallery" | "avatar") {
    if (!supabase || !profile) return;
    if (
      !window.confirm(
        kind === "avatar"
          ? "Remove your profile photo?"
          : "Remove this photo from your profile?",
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const nextGallery =
        kind === "gallery"
          ? (profile.gallery_urls ?? []).filter((item) => item !== url)
          : profile.gallery_urls ?? [];
      const patch =
        kind === "gallery"
          ? { gallery_urls: nextGallery }
          : { avatar_url: "" };

      const { data, error } = await supabase
        .from("profiles")
        .update(patch)
        .eq("id", profile.id)
        .select(PUBLIC_PROFILE_COLUMNS)
        .single();
      if (error) throw error;
      const updatedProfile = {
        ...profile,
        ...(data as Partial<Profile>),
      } as Profile;
      setProfile(updatedProfile);

      // A listing published without photos of its own is seeded with the
      // member's profile image, so the same URL can be a live listing's cover.
      // Repoint those listings BEFORE destroying the file, or they render a
      // dead image forever with no way to recover the original.
      const { data: owned, error: ownedError } = await supabase
        .from("listings")
        .select("id,image_url,image_urls")
        .eq("owner_profile_id", profile.id);
      // Never destroy the file on a failed lookup: a listing that still
      // points at it would render a dead image with no way back.
      if (ownedError) throw ownedError;
      const affected = (owned ?? []).filter(
        (listing: { image_url: string | null; image_urls: string[] | null }) =>
          listing.image_url === url || (listing.image_urls ?? []).includes(url),
      );
      for (const listing of affected as Array<{
        id: string;
        image_url: string | null;
        image_urls: string[] | null;
      }>) {
        const remaining = (
          listing.image_urls?.length
            ? listing.image_urls
            : [listing.image_url ?? ""]
        ).filter((item) => item && item !== url);
        const { error: repairError } = await supabase
          .from("listings")
          .update({
            image_url: remaining[0] ?? DEFAULT_LISTING_IMAGE,
            image_urls: remaining,
          })
          .eq("id", listing.id)
          .eq("owner_profile_id", profile.id);
        // Leave the file in place if a listing could not be repaired; a photo
        // that outlives its use is recoverable, a broken listing is not.
        if (repairError) throw repairError;
      }

      // Remove the underlying file so it stops being publicly reachable.
      // Only files we uploaded live under this bucket; external URLs are
      // simply dropped from the profile.
      const path = storagePathFromUrl(url);
      if (path) {
        await supabase.storage.from("marketplace-media").remove([path]);
      }
      setToast(
        affected.length
          ? `Photo removed. ${affected.length} listing${affected.length === 1 ? "" : "s"} using it now show the default cover.`
          : kind === "avatar"
            ? "Profile photo removed."
            : "Photo removed.",
      );
      // Pass the row the update returned, not the `profile` captured when this
      // handler was created - that snapshot still carries the URL just deleted,
      // so the refresh re-seeded listings with the dead image.
      await Promise.all([loadMarketplace(), loadOwnListings(updatedProfile)]);
    } catch (error) {
      setToast(
        friendlyDbError(error) || "Could not remove that photo.",
      );
    } finally {
      setBusy(false);
    }
  }

  function resetIgAvatarSync() {
    igAvatarSeqRef.current += 1;
    igAvatarPromiseRef.current = null;
    // Deliberately not deleting igSyncedUrlRef here: this also runs straight
    // after a successful save, where that photo is now the member's avatar.
    igSyncedHandleRef.current = "";
    igSyncedUrlRef.current = "";
    setIgAvatar("");
    setIgStats(null);
    setIgAvatarBusy(false);
  }

  // Fill the follower box from Instagram, but never argue with a number the
  // member typed in themselves.
  /**
   * Fill in the follower count from a successful Instagram lookup, without
   * overwriting a number the member typed themselves.
   *
   * This used to poke the value straight into a form input, which forced
   * saveOnboarding to re-read the live DOM at submit time because the FormData
   * snapshot predated the await. Now that followers is controlled state - and
   * genuinely null rather than the string "0" when unanswered - "did they
   * already answer?" is just a null check.
   */
  function prefillFollowers(followers: number | null | undefined) {
    if (typeof followers !== "number" || followers <= 0) return;
    setAnswers((current) =>
      current.followers ? current : { ...current, followers },
    );
  }

  // A photo fetched for a handle the member then changed away from is dead
  // weight in a public bucket, so drop it as soon as it is superseded.
  async function discardSyncedIgPhoto(url: string) {
    if (!supabase || !url) return;
    const path = storagePathFromUrl(url);
    if (!path) return;
    await supabase.storage
      .from("marketplace-media")
      .remove([path])
      .catch(() => undefined);
  }

  async function syncInstagramAvatar(
    rawHandle: string,
    form?: HTMLFormElement | null,
  ) {
    if (!supabase) return;
    const handle = rawHandle.trim();
    const seq = ++igAvatarSeqRef.current;
    if (!handle) {
      igAvatarPromiseRef.current = null;
      void discardSyncedIgPhoto(igSyncedUrlRef.current);
      igSyncedUrlRef.current = "";
      igSyncedHandleRef.current = "";
      setIgAvatar("");
      setIgStats(null);
      // This branch never started a request, but an older one may still be in
      // flight and will return stale; clear the flag or the submit button
      // stays disabled with nothing left to wait for.
      setIgAvatarBusy(false);
      return;
    }
    // onBlur fires whether or not the field changed, and every lookup that
    // wants a photo costs an upload, so only re-run when the handle is new.
    if (handle === igSyncedHandleRef.current) {
      // A lookup for a handle the member has since reverted may still be in
      // flight, and it resolves "" once superseded. Drop it, or the save would
      // block on it and then discard the photo the preview is still showing.
      igAvatarPromiseRef.current = null;
      setIgAvatarBusy(false);
      return;
    }

    // A photo the member already has or is uploading always wins, but the
    // follower count is worth fetching either way. Tell the server, so it
    // reads the stats without downloading and storing a photo we would bin.
    // The avatar input is a ref now rather than a named form control, because
    // onboarding's fields are controlled state and the lookup is triggered by
    // an explicit button instead of a blur on the form.
    // Read the captured file, not the input: onboarding's avatar field lives on
    // step 1 and this runs from step 2, where that input is unmounted.
    const fileInput = form?.elements.namedItem("avatar_file");
    const photoAlreadyChosen =
      Boolean(profile?.avatar_url) ||
      Boolean(avatarFile) ||
      (fileInput instanceof HTMLInputElement &&
        (fileInput.files?.length ?? 0) > 0);

    setIgAvatarBusy(true);
    const client = supabase;
    const lookup = (async () => {
      try {
        const { data, error } = await client.functions.invoke("ig-avatar", {
          body: { handle, want_photo: !photoAlreadyChosen },
        });
        if (error) {
          // invoke() treats our 404/503 as an error, so the explanation we
          // wrote server-side only survives if we read the response body.
          const context = (error as { context?: Response }).context;
          const detail = context ? await context.json().catch(() => null) : null;
          if (seq === igAvatarSeqRef.current) {
            // A non-JSON error body (gateway HTML, a network drop) left this
            // null, so the busy state cleared and the note rendered nothing at
            // all - the member saw a spinner finish and no outcome, with no
            // hint they could just type the number in.
            setIgStats(
              (detail as IgStats | null) ?? {
                error:
                  "We could not reach Instagram just now — type your follower count in yourself.",
              },
            );
          }
          return "";
        }
        if (!data || typeof data !== "object") return "";
        const stats = data as IgStats;
        const url = String(stats.url ?? "");
        if (seq !== igAvatarSeqRef.current) {
          // Superseded mid-flight: nothing will ever show this photo.
          void discardSyncedIgPhoto(url);
          return "";
        }
        setIgStats(stats);
        prefillFollowers(stats.followers);
        igSyncedHandleRef.current = handle;
        if (url) {
          void discardSyncedIgPhoto(igSyncedUrlRef.current);
          igSyncedUrlRef.current = url;
        }
        return url;
      } catch {
        // Same reasoning as the error branch above: never clear the busy state
        // without leaving the member something to read.
        if (seq === igAvatarSeqRef.current) {
          setIgStats({
            error:
              "We could not reach Instagram just now — type your follower count in yourself.",
          });
        }
        return "";
      }
    })();
    igAvatarPromiseRef.current = lookup;
    const url = await lookup;
    if (seq !== igAvatarSeqRef.current) return;
    setIgAvatar(url);
    setIgAvatarBusy(false);
    if (url) {
      setToast("Found your Instagram photo — it will be your profile photo.");
    }
  }

  function passwordCapable(account: User) {
    return (account.identities ?? []).some(
      (identity) => identity.provider === "email",
    );
  }

  async function deleteAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !user) return;
    const values = new FormData(event.currentTarget);
    const usesPassword = passwordCapable(user);
    const body = usesPassword
      ? { password: String(values.get("delete_password") ?? "") }
      : { confirmation: String(values.get("delete_confirmation") ?? "").trim() };

    setDeleteAccountError("");
    if (!usesPassword && body.confirmation !== "DELETE") {
      setDeleteAccountError(tx("Type DELETE exactly to confirm."));
      return;
    }

    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("delete-account", {
        body,
      });
      if (error) {
        let message = "Could not delete your account. Please try again.";
        try {
          const context = (error as { context?: Response }).context;
          if (context) {
            const parsed = await context.json();
            if (parsed?.error) message = String(parsed.error);
          }
        } catch {
          /* keep default message */
        }
        throw new Error(message);
      }
      if (data && typeof data === "object" && "error" in data && data.error) {
        throw new Error(String(data.error));
      }

      await supabase.auth.signOut();
      setDeleteAccountOpen(false);
      setUser(null);
      clearSessionState();
      setToast("Your account and all of its data have been deleted.");
      await loadMarketplace();
    } catch (error) {
      setDeleteAccountError(
        tx(error instanceof Error
          ? error.message
          : "Could not delete your account. Please try again."),
      );
    } finally {
      setBusy(false);
    }
  }

  function openInbox() {
    requireAccount(() => {
      setInboxOpen(true);
      void loadInbox();
    });
  }

  /**
   * Move the page to a dashboard section and leave the keyboard there too.
   *
   * `scrollIntoView` alone moves the viewport but not focus, so a keyboard or
   * screen-reader user who activates one of these lands visually on the
   * section while their next Tab continues from the control they left. The
   * `tabindex="-1"` on the section headers makes it focusable without adding
   * it to the tab order.
   */
  function goToDashboardSection(id: string) {
    const target = document.getElementById(id);
    if (!target) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({
      behavior: still ? "auto" : "smooth",
      block: "start",
    });
    target.focus({ preventScroll: true });
  }

  // The inbox is a full-screen overlay but was the one surface not built on
  // Modal, so it had no dialog role, no focus entry, no Escape and no focus
  // trap: a keyboard user who opened Messages had to tab through the whole
  // page hidden behind the scrim to reach it, and a screen reader announced
  // nothing at all. This gives it the same treatment every other overlay has.
  useEffect(() => {
    if (!inboxOpen) return;
    const card = inboxCardRef.current;
    if (!card) return;
    const opener = document.activeElement as HTMLElement | null;
    lockPageScroll();
    card.focus({ preventScroll: true });

    function onKeyDown(event: KeyboardEvent) {
      if (!card) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        closeInbox();
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(
        card.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => element.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (!card.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      unlockPageScroll();
      if (opener && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxOpen]);

  // The global unread listener treats activeThread as "already on screen" and
  // skips the badge for it. Leaving it set after the drawer closes meant the
  // last conversation you opened never notified you again all session.
  function closeInbox() {
    setInboxOpen(false);
    threadSeqRef.current += 1;
    setActiveThread(null);
    setActiveContact(null);
    setMessages([]);
  }

  function openListingEditor() {
    requireAccount(() => {
      if (profile?.role === "consumer") {
        setToast(
          "Finish your Business or Creator profile before publishing a listing.",
          "problem",
        );
        return;
      }
      setListingFeedback("");
      setFormatPreview("");
      setEditingListing(null);
      setStreetView(null);
      setTourPick(null);
      setTourSpherical(false);
      setListingInstantEnabled(false);
      setNewListingOffer("social");
      setListingPreview(false);
      setNewListingDrafts({});
      setPendingListingFiles([]);
      setListingOpen(true);
    });
  }

  function openListingEdit(listing: Listing) {
    setListingPreview(false);
    setListingFeedback("");
    setFormatPreview(listing.format ?? "");
    setEditingListing(listing);
    setStreetView(
      listing.street_view_captured
        ? {
            captured: listing.street_view_captured,
            pano: listing.street_view_pano ?? "",
            url: null,
          }
        : null,
    );
    setTourPick(null);
    setTourSpherical(false);
    setListingInstantEnabled(listing.instant_booking_enabled ?? false);
    setPendingListingFiles([]);
    setNewListingOffer(
      isSponsorshipListing(listing)
        ? "sponsorship"
        : isPhysicalListing(listing)
          ? "physical"
          : "social",
    );
    setAccountOpen(false);
    setListingOpen(true);
  }

  function openListingChat(listing: Listing) {
    requireAccount(() => void startConversation(listing.owner));
  }

  function greeting() {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  }

  /** One honest sentence about what needs attention right now. */
  function dashboardStatus() {
    if (!profile) return "";
    if (!profile.onboarding_complete) {
      return "Finish your profile to go live on the marketplace.";
    }
    // A request you countered is still waiting on you - you can accept,
    // decline or revise it - so it must not vanish from your own status line.
    const incoming = campaignRequests.filter(
      (request) =>
        request.owner_profile_id === profile.id &&
        OPEN_REQUEST_STATUSES.includes(request.status),
    ).length;
    // A counteroffer sits with the REQUESTER: they are the only party who can
    // accept it. Counting only owner-side rows meant the dashboard told them
    // nothing needed their attention while a priced offer waited on them.
    const awaitingYou = campaignRequests.filter(
      (request) =>
        request.requester_profile_id === profile.id &&
        request.status === "countered",
    ).length;
    const parts: string[] = [];
    if (incoming) {
      parts.push(
        `${incoming} offer or booking${incoming === 1 ? "" : "s"} waiting on you`,
      );
    }
    if (awaitingYou) {
      parts.push(
        `${awaitingYou} counteroffer${awaitingYou === 1 ? "" : "s"} to review`,
      );
    }
    if (unreadCount) {
      parts.push(`${unreadCount} unread message${unreadCount === 1 ? "" : "s"}`);
    }
    // A listing with gaps is sorted below complete ones and says so on its own
    // card. Leaving it out of the status line meant the dashboard could open
    // with "nothing needs your attention" directly above a listing telling the
    // member it needs a longer title.
    const unfinished = ownListings.filter(
      (listing) =>
        // Business briefs are excluded: listingGaps measures `format`, which
        // the brief form derives rather than asks for, so a brief could be
        // reported unfinished with nothing the member could do about it.
        listing.channel !== "Business brief" && listingGaps(listing).length > 0,
    ).length;
    if (unfinished) {
      parts.push(
        `${unfinished} listing${unfinished === 1 ? "" : "s"} to finish`,
      );
    }
    if (parts.length) return `You have ${parts.join(" and ")}.`;
    if (profile.role !== "consumer" && !ownListings.length) {
      return "Nothing is listed yet. Add your first space or audience to start getting requests.";
    }
    return "Nothing needs your attention right now.";
  }

  /**
   * One listing's figures, or an honest sentence when there are none.
   *
   * Four zeroes tell an owner nothing and read like a fault. The same
   * judgement is already made for the follower row on a person card: it only
   * appears when there is a number in it.
   */
  function renderListingFigures(listingId: string) {
    const row = listingAnalytics.find((entry) => entry.listing_id === listingId);
    if (!row) return null;
    if (!row.impressions && !row.clicks && !row.like_count && !row.offers) {
      return (
        <p className="listing-figures-empty">
          {t("app.nobodyHasReachedThisOneYet")}
        </p>
      );
    }
    return (
      <div className="listing-figures">
        <span>
          <small>{t("app.seenBy")}</small>
          <b>{compactNumber(row.impressions)}</b>
        </span>
        <span>
          <small>{t("app.opened")}</small>
          <b>{compactNumber(row.clicks)}</b>
        </span>
        <span>
          <small>{t("app.likes")}</small>
          <b>{compactNumber(row.like_count)}</b>
        </span>
        <span>
          <small>{t("app.offers")}</small>
          <b>{compactNumber(row.offers)}</b>
        </span>
      </div>
    );
  }

  /**
   * Everything the member's listings did, added up.
   *
   * "Seen by" is people, not paint count: one row per person per day, so
   * scrolling a card past twenty times is one. That is why the label says
   * people rather than views - the number would be a lie the other way round.
   */
  function renderDashboardAnalytics() {
    if (!ownListings.length) return null;
    const totals = listingAnalytics.reduce(
      (sum, row) => ({
        impressions: sum.impressions + row.impressions,
        clicks: sum.clicks + row.clicks,
        likes: sum.likes + row.like_count,
        offers: sum.offers + row.offers,
        impressions7d: sum.impressions7d + row.impressions_7d,
      }),
      { impressions: 0, clicks: 0, likes: 0, offers: 0, impressions7d: 0 },
    );
    const anything =
      totals.impressions || totals.clicks || totals.likes || totals.offers;

    return (
      <section
        className="account-section dashboard-work-section"
        id="dashboard-analytics"
        aria-label={t("app.analytics")}
        tabIndex={-1}
        data-reveal
      >
        <div className="account-section-heading">
          <div>
            <p className="eyebrow">{t("app.analytics")}</p>
            <h3>{t("app.howYourListingsAreDoing")}</h3>
            <p className="account-section-lede">
              {t("app.countedPerPersonPerDaySoOne")}
            </p>
          </div>
        </div>

        {anything ? (
          <>
            <div className="dashboard-grid">
              <div className="dashboard-stat dashboard-stat-readout">
                <span className="dashboard-stat-top">
                  <small>{t("app.seenBy")}</small>
                  <span className="dashboard-stat-icon">
                    <DashboardStatIcon name="analytics" />
                  </span>
                </span>
                <strong>{compactNumber(totals.impressions)}</strong>
                <span className="dashboard-stat-caption">
                  {totals.impressions === 1 ? t("app.person") : t("app.people")}
                  {totals.impressions7d
                    ? t("app.impressions7dThisWeek", { impressions7d: compactNumber(totals.impressions7d) })
                    : ""}
                </span>
              </div>
              <div className="dashboard-stat dashboard-stat-readout">
                <span className="dashboard-stat-top">
                  <small>{t("app.opened")}</small>
                  <span className="dashboard-stat-icon">
                    <DashboardStatIcon name="outgoing" />
                  </span>
                </span>
                <strong>{compactNumber(totals.clicks)}</strong>
                <span className="dashboard-stat-caption">
                  {totals.impressions
                    ? t("app.roundOfThoseWhoSaw", { round: Math.round((totals.clicks / totals.impressions) * 100) })
                    : t("app.nobodyYet")}
                </span>
              </div>
              <div className="dashboard-stat dashboard-stat-readout">
                <span className="dashboard-stat-top">
                  <small>{t("app.likes")}</small>
                  <span className="dashboard-stat-icon">
                    <DashboardStatIcon name="likes" />
                  </span>
                </span>
                <strong>{compactNumber(totals.likes)}</strong>
                <span className="dashboard-stat-caption">
                  {totals.likes === 1 ? t("app.member") : t("app.members")}{" "}{t("app.likedOne")}
                </span>
              </div>
              <div className="dashboard-stat dashboard-stat-readout">
                <span className="dashboard-stat-top">
                  <small>{t("app.offers")}</small>
                  <span className="dashboard-stat-icon">
                    <DashboardStatIcon name="incoming" />
                  </span>
                </span>
                <strong>{compactNumber(totals.offers)}</strong>
                <span className="dashboard-stat-caption">
                  {totals.offers === 1 ? t("app.offer2") : t("app.offers2")}{" "}{t("app.received")}
                </span>
              </div>
            </div>
            <p className="account-section-lede dashboard-analytics-note">
              {t("app.perListingFiguresAreOnEachCard")}
            </p>
          </>
        ) : (
          <div className="dashboard-panel-empty">
            <strong>{t("app.nothingToCountYet")}</strong>
            <p>
              {t("app.weStartedCountingTheMomentYourListing")}
            </p>
          </div>
        )}
      </section>
    );
  }

  function renderDashboardListings() {
    if (!profile) return null;
    return (
      <section
        className="account-section dashboard-work-section"
        id="dashboard-listings-all"
        aria-label={t("app.listings")}
        tabIndex={-1}
        data-reveal
      >
        <div className="account-section-heading">
          <div>
            <p className="eyebrow">{t("app.listings")}</p>
            <h2>{t("app.manageWhatYouHavePublished")}</h2>
            <p className="account-section-lede">
              {t("app.keepYourAudiencePlacementOrSponsorshipOffer")}
            </p>
          </div>
          {profile.role !== "consumer" && (
            <button
              className="button button-dark button-small"
              onClick={openListingEditor}
            >
              {t("app.newListing")}{" "}<span>＋</span>
            </button>
          )}
        </div>

        {ownListingsLoading ? (
          <div className="account-empty">{t("app.loadingYourSavedListings")}</div>
        ) : ownListings.length ? (
            <div className="my-listings-grid">
            {ownListings.map((listing) => {
              const copy = listing;
              return (
              <article className="my-listing-card" key={listing.id}>
                <ListingCover
                  listing={listing}
                  alt={copy.title + " listing"}
                />
                <div>
                  <span className={`listing-status status-${listing.status}`}>
                    {listing.status}
                  </span>
                  <h4>{copy.title}</h4>
                  <p>
                    {isBrief(listing)
                      ? t("market.wanted")
                      : localizeListingChannel(locale, listing.channel)}{" "}
                    • {priceLabel(listing, locale, formatListingPrice)}/{localizeListingUnit(locale, pricingLabel(listing))}
                  </p>
                  {(() => {
                    const gaps = listingGaps(listing);
                    if (!gaps.length) return null;
                    return (
                      <p className="listing-gap">
                        {t("app.sortedBelowCompleteListingsItNeedsGaps", { gaps: joinList(gaps) })}
                      </p>
                    );
                  })()}
                  {renderListingFigures(listing.id)}
                  <div className="my-listing-actions">
                    <button onClick={() => openListing(listing)}>{t("app.view")}</button>
                    <button onClick={() => openListingEdit(listing)}>{t("app.edit")}</button>
                    <button
                      disabled={busy}
                      onClick={() => void updateListingStatus(listing)}
                    >
                      {listing.status === "active" ? t("app.pause") : t("app.makeActive")}
                    </button>
                    <button
                      className="is-danger"
                      disabled={busy}
                      onClick={() => setDeleteListingTarget(listing)}
                    >
                      {t("app.delete2")}
                    </button>
                  </div>
                </div>
              </article>
              );
            })}
          </div>
        ) : (
          <div className="account-empty">
            <strong>{t("app.noListingsYet")}</strong>
            <p>
              {t("app.yourFirstListingWillAppearHereImmediately")}
            </p>
            {profile.role !== "consumer" && (
              <button
                className="button button-coral button-small"
                onClick={openListingEditor}
              >
                {t("app.createMyFirstListing")}{" "}<span>↗</span>
              </button>
            )}
          </div>
        )}
      </section>
    );
  }

  function renderDashboardCampaigns() {
    if (!profile) return null;
    const matches = (request: CampaignRequest, side: typeof campaignSide) => {
      const sideOk =
        side === "all"
          ? true
          : side === "incoming"
            ? request.owner_profile_id === profile.id
            : request.requester_profile_id === profile.id;
      return (
        sideOk &&
        (!campaignOpenOnly || OPEN_REQUEST_STATUSES.includes(request.status))
      );
    };
    const sides = [
      { key: "all" as const, label: "All" },
      { key: "incoming" as const, label: "To you" },
      { key: "outgoing" as const, label: "You sent" },
    ];
    const sideCount = (key: (typeof sides)[number]["key"]) =>
      campaignRequests.filter((request) => matches(request, key)).length;
    const visibleRequests = campaignRequests.filter((request) =>
      matches(request, campaignSide),
    );
    return (
      <section
        className="account-section dashboard-work-section"
        id="dashboard-campaigns-all"
        aria-label={t("app.offersAndBookings")}
        tabIndex={-1}
        data-reveal
      >
        <div className="account-section-heading">
          <div>
            <p className="eyebrow">{t("app.offersBookings")}</p>
            <h2>{t("app.reviewEveryOfferAndNextStep")}</h2>
            <p className="account-section-lede">
              {t("app.acceptCounterPayAndKeepActiveWork")}
            </p>
          </div>
          <div className="segmented-row">
          {campaignOpenOnly && (
            <button
              type="button"
              className="filter-pill"
              onClick={() => setCampaignOpenOnly(false)}
            >
              {t("app.openOnly")}
              <span aria-hidden="true">×</span>
              <span className="sr-only">{t("app.clearThisFilter")}</span>
            </button>
          )}
          <div className="segmented" role="radiogroup" aria-label={t("app.filterOffers")}>
            {sides.map((side, index) => (
              <button
                key={side.key}
                type="button"
                role="radio"
                className="segmented-option"
                aria-checked={campaignSide === side.key}
                // Only the selected option is tabbable, and the arrows move
                // between them: the roving-tabindex half of the radio pattern,
                // without which a radiogroup is a worse lie than the toggles.
                tabIndex={campaignSide === side.key ? 0 : -1}
                onKeyDown={(event) => {
                  const step =
                    event.key === "ArrowRight" || event.key === "ArrowDown"
                      ? 1
                      : event.key === "ArrowLeft" || event.key === "ArrowUp"
                        ? -1
                        : 0;
                  if (!step) return;
                  event.preventDefault();
                  const next = sides[(index + step + sides.length) % sides.length];
                  setCampaignSide(next.key);
                  const group = event.currentTarget.parentElement;
                  const buttons = group?.querySelectorAll("button");
                  const target = buttons?.[sides.indexOf(next)];
                  if (target instanceof HTMLElement) target.focus();
                }}
                onClick={() => setCampaignSide(side.key)}
              >
                {tx(side.label)}
                <b>{sideCount(side.key)}</b>
              </button>
            ))}
          </div>
          </div>
        </div>

        {visibleRequests.length ? (
          <div className="campaign-request-list">
            {visibleRequests.map((request) => {
              const incoming = request.owner_profile_id === profile.id;
              const other = incoming ? request.requester : request.owner;
              const payment = paymentTransactions.find(
                (item) => item.campaign_request_id === request.id,
              );
              const isPayer = request.payer_profile_id === profile.id;
              const isPayee = request.payee_profile_id === profile.id;
              const isBookAsListed = request.purchase_mode === "buy_now";
              const acceptedMoney = request.accepted_subtotal_cents
                ? calculatePaymentBreakdown(request.accepted_subtotal_cents)
                : null;
              const promoPreview = acceptedMoney && isPayer && !payment
                ? applyAdCreditToCheckout({ ...acceptedMoney, availableCents: adCreditBalanceCents })
                : null;
              return (
                <article className="campaign-request-card" key={request.id}>
                  <header>
                    <div>
                      <small>
                        {incoming ? t("app.incoming") : t("app.youSent")} · {request.instant_booking ? t("app.instantBooking") : isBookAsListed ? t("app.bookAsListed") : t("app.offer")}
                      </small>
                      <h4>{request.campaign_name}</h4>
                      <p>
                        {request.listing?.title ??
                          (request.status === "accepted" || request.status === "completed"
                            ? t("app.thisListingIsNotCurrentlyPublic")
                            : t("app.listingNoLongerAvailable"))}
                        {" · "}
                        {other.display_name}
                      </p>
                    </div>
                    <span
                      className={`request-status status-${payment?.status ?? request.status}`}
                    >
                      {payment?.status?.replaceAll("_", " ") ?? request.status}
                    </span>
                  </header>
                  <div className="campaign-request-facts">
                    <span>
                      <small>{t("app.dates")}</small>
                      <b>
                        {bookingDateLabel(request.timing_kind, request.start_date, request.end_date, t, locale)}
                      </b>
                    </span>
                    <span>
                      <small>{isBookAsListed ? t("app.listedPrice") : t("market.budget")}</small>
                      <b>{formatCents(request.budget_cents)}</b>
                    </span>
                    <span>
                      <small>{isBookAsListed ? t("app.listedDeliverables") : t("app.requested")}</small>
                      <b>{request.requested_deliverables}</b>
                    </span>
                  </div>
                  {request.listing_terms?.cancellation_policy && <details className="composer-options"><summary>{t("app.agreedCancellationTerms")}</summary><p>{request.listing_terms.cancellation_policy}</p></details>}
                  {request.goals && (
                    <p className="campaign-request-brief">
                      <small>{t("app.goal")}</small>
                      {request.goals}
                    </p>
                  )}
                  {request.notes && (
                    <p className="campaign-request-brief">
                      <small>{t("app.notes")}</small>
                      {request.notes}
                    </p>
                  )}
                  {request.counter_budget_cents != null && (
                    <div className="counter-summary">
                      <strong>
                        {request.status === "accepted"
                          ? t("app.agreedAtCounterBudgetCents", { counter_budget_cents: formatCents(request.counter_budget_cents) })
                          : t("app.counterofferCounterBudgetCents", { counter_budget_cents: formatCents(request.counter_budget_cents) })}
                      </strong>
                      {request.counter_message && <p>{request.counter_message}</p>}
                    </div>
                  )}
                  {acceptedMoney && isPayer && (
                    <div className="campaign-request-facts">
                      <span>
                        <small>{t("app.campaign")}</small>
                        <b>{formatCents(acceptedMoney.subtotalCents)}</b>
                      </span>
                      <span>
                        <small>{t("app.sidespaceBuyerFee5")}</small>
                        <b>{formatCents(acceptedMoney.buyerFeeCents)}</b>
                      </span>
                      <span>
                        <small>{promoPreview ? t("app.estimatedTotalBeforeTax") : t("app.totalBeforeTax")}</small>
                        <b>
                          {formatCents(
                            payment?.charged_total_cents ?? promoPreview?.chargedTotalCents ?? acceptedMoney.customerTotalCents,
                          )}
                        </b>
                      </span>
                      {(payment?.ad_credit_cents ?? promoPreview?.adCreditCents ?? 0) > 0 && (
                        <span>
                          <small>{t("app.promoCredit")}</small>
                          <b>−{formatCents(payment?.ad_credit_cents ?? promoPreview?.adCreditCents ?? 0)}</b>
                        </span>
                      )}
                    </div>
                  )}
                  {acceptedMoney && isPayer && !payment && adCreditBalanceCents > 0 && (
                    <p className="campaign-request-brief">
                      <small>{t("app.availableAdCredit")}</small>
                      {t("app.adcreditcentsCanApplyAtCheckoutAnyRemaining", { adCreditCents: formatCents(applyAdCreditToCheckout({
                        ...acceptedMoney, availableCents: adCreditBalanceCents,
                      }).adCreditCents) })}
                    </p>
                  )}
                  {acceptedMoney && isPayee && (
                    <div className="campaign-request-facts">
                      <span>
                        <small>{t("app.campaign")}</small>
                        <b>{formatCents(acceptedMoney.subtotalCents)}</b>
                      </span>
                      <span>
                        <small>{t("app.sidespaceCreatorFee5")}</small>
                        <b>−{formatCents(acceptedMoney.creatorFeeCents)}</b>
                      </span>
                      <span>
                        <small>{t("app.yourEarnings")}</small>
                        <b>{formatCents(acceptedMoney.creatorPayoutCents)}</b>
                      </span>
                    </div>
                  )}
                  {(payment?.tax_cents ?? 0) > 0 && isPayer && (
                    <p className="campaign-request-brief">
                      <small>{t("app.taxCollectedByStripe")}</small>
                      {formatCents(payment?.tax_cents ?? 0)}
                    </p>
                  )}
                  <div className="campaign-request-actions">
                    {incoming && request.status === "pending" && (
                      <button
                        className="button button-dark button-small"
                        disabled={busy}
                        onClick={() => void respondToCampaignRequest(request, "accepted")}
                      >
                        {t("app.accept")}
                      </button>
                    )}
                    {incoming &&
                      request.purchase_mode !== "buy_now" &&
                      OPEN_REQUEST_STATUSES.includes(request.status) && (
                        <button onClick={() => setCounteringRequest(request)}>
                          {request.status === "countered" ? t("app.reviseCounteroffer") : t("app.counteroffer")}
                        </button>
                      )}
                    {incoming && OPEN_REQUEST_STATUSES.includes(request.status) && (
                      <button
                        disabled={busy}
                        onClick={() => void respondToCampaignRequest(request, "declined")}
                      >
                        {t("app.decline")}
                      </button>
                    )}
                    {!incoming && request.status === "countered" && (
                      <button
                        className="button button-dark button-small"
                        disabled={busy}
                        onClick={() => void respondToCampaignRequest(request, "accepted")}
                      >
                        {t("app.acceptCounteroffer")}
                      </button>
                    )}
                    {!incoming && OPEN_REQUEST_STATUSES.includes(request.status) && (
                      <button
                        disabled={busy}
                        onClick={() => void respondToCampaignRequest(request, "cancelled")}
                      >
                        {isBookAsListed ? t("app.cancelBooking") : t("app.cancelOffer")}
                      </button>
                    )}
                    {request.status === "accepted" && (
                      <>
                        {isPayer && (
                          <button
                            className="button button-coral button-small"
                            disabled={busy}
                            onClick={() => void startCampaignCheckout(request.id)}
                          >
                            {payment?.status === "checkout_open"
                              ? t("app.continueSecureCheckout")
                              : t("app.paySecurelyWithStripe")}
                          </button>
                        )}
                        {isPayee &&
                          profileHasRole(profile, "creator") &&
                          !stripeAccountStatus?.ready && (
                            <button
                              className="button button-dark button-small"
                              disabled={busy}
                              onClick={() =>
                                void openStripeFlow("/api/stripe/connect/onboard")
                              }
                            >
                              {t("app.finishPayoutSetup")}
                            </button>
                          )}
                        <button onClick={openInbox}>{t("app.continueInMessages")}</button>
                      </>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : campaignRequests.length ? (
          <div className="account-empty">
            <strong>
              {campaignOpenOnly
                ? t("app.nothingHereNeedsYouRightNow")
                : campaignSide === "incoming"
                  ? t("app.noOffersWaitingOnYou")
                  : t("app.youHaveNotSentAnyOffers")}
            </strong>
            <p>
              {campaignRequests.length === 1
                ? t("app.oneOfferOutsideThisFilter")
                : t("app.offersOutsideThisFilter", { count: campaignRequests.length })}
            </p>
            <button
              className="button button-ghost button-small"
              type="button"
              onClick={() => {
                setCampaignSide("all");
                setCampaignOpenOnly(false);
              }}
            >
              {t("app.showAllOffers")}{" "}<span>→</span>
            </button>
          </div>
        ) : (
          <div className="account-empty">
            <strong>{t("app.noOffersOrBookingsYet")}</strong>
            <p>{t("app.openAListingToBookAnAvailable")}</p>
            <a className="button button-ghost button-small" href="/marketplace">
              {t("home.finalBrowse")}{" "}<span>↗</span>
            </a>
          </div>
        )}
      </section>
    );
  }

  function renderDashboardPayments() {
    if (!profile || paymentTransactions.length === 0) return null;
    return (
      <section
        className="account-section dashboard-work-section"
        id="dashboard-payments"
        aria-label={t("app.payments")}
        tabIndex={-1}
        data-reveal
      >
        <div className="account-section-heading">
          <div>
            <p className="eyebrow">{t("app.payments")}</p>
            <h2>{t("app.trackMoneyInMotion")}</h2>
            <p className="account-section-lede">
              {t("app.paymentDeliveryReviewRefundAndPayoutStatus")}
            </p>
          </div>
          <span className="section-count">{t("app.paymenttransactionscountTotal", { paymentTransactionsCount: paymentTransactions.length })}</span>
        </div>
        <div className="campaign-request-list">
          {paymentTransactions.map((transaction) => {
            const buyer = transaction.business_profile_id === profile.id;
            const reviewExpired = transaction.review_deadline
              ? Date.now() >= new Date(transaction.review_deadline).getTime()
              : false;
            const statusLabel =
              transaction.workflow_status === "refund_pending"
                ? "Refund processing"
                : transaction.payout_status === "released"
                  ? "Payout released"
                  : transaction.payout_status === "releasing"
                    ? "Releasing payout"
                    : transaction.workflow_status === "awaiting_payer_review"
                      ? "Awaiting payer review"
                      : transaction.issue_status === "escalated"
                        ? "Issue escalated"
                        : transaction.issue_status === "open"
                          ? "Issue open"
                          : transaction.payout_status === "pending"
                            ? "Payout pending"
                            : transaction.workflow_status.replaceAll("_", " ");
            return (
              <article className="campaign-request-card" key={transaction.id}>
                <header>
                  <div>
                    <small>{buyer ? t("app.businessPayment") : t("app.creatorEarnings")}</small>
                    <h4>{transaction.campaign_name}</h4>
                    <p>{transaction.listing_title}</p>
                  </div>
                  <span className={`request-status status-${transaction.workflow_status}`}>
                    {statusLabel}
                  </span>
                </header>
                <div className="campaign-request-facts">
                  <span>
                    <small>{buyer ? t("app.campaign") : t("app.grossCampaign")}</small>
                    <b>{formatCents(transaction.subtotal_cents)}</b>
                  </span>
                  <span>
                    <small>{buyer ? t("app.buyerFee") : t("app.creatorFee")}</small>
                    <b>
                      {buyer ? "" : "−"}
                      {formatCents(
                        buyer ? transaction.buyer_fee_cents : transaction.creator_fee_cents,
                      )}
                    </b>
                  </span>
                  <span>
                    <small>{buyer ? t("app.totalBeforeTax") : t("app.yourEarnings")}</small>
                    <b>
                      {formatCents(
                        buyer
                          ? transaction.charged_total_cents ?? transaction.customer_total_cents
                          : transaction.creator_payout_cents,
                      )}
                    </b>
                  </span>
                </div>
                {buyer && (transaction.ad_credit_cents ?? 0) > 0 && (
                  <p className="campaign-request-brief">
                    <small>{t("app.adCreditApplied")}</small>
                    {t("app.formatcentsPromotionalCreditItCannotBeWithdrawn", { formatCents: formatCents(transaction.ad_credit_cents ?? 0) })}
                  </p>
                )}
                {transaction.refunded_cents > 0 && (
                  <p className="campaign-request-brief">
                    <small>{t("app.refunded")}</small>
                    {formatCents(transaction.refunded_cents)}
                  </p>
                )}
                {transaction.payout_status === "pending" &&
                  transaction.workflow_status === "paid_payout_pending" && (
                    <div className="campaign-request-brief">
                      <small>{buyer ? t("app.creatorPayout") : t("app.paymentPending")}</small>
                      {buyer
                        ? t("app.yourPaymentIsVerifiedTheCreatorCan")
                        : t("app.theCustomerPaidInFullYourEarnings")}
                    </div>
                  )}
                {transaction.delivered_at && transaction.review_deadline && (
                  <div className="campaign-request-brief">
                    <small>
                      {buyer ? t("app.creatorMarkedThisCampaignDelivered") : t("app.reviewPeriodEnds")}
                    </small>
                    {buyer && t("app.deliveredDeliveredAt", { delivered_at: displayDateTime(transaction.delivered_at, t, locale) })}
                    {t("app.reviewDeadlineReviewDeadline", { review_deadline: displayDateTime(transaction.review_deadline, t, locale) })}
                    {!buyer &&
                      t("app.payoutIsExpectedAfterThatTimeUnless")}
                    {reviewExpired &&
                      transaction.payout_status !== "released" &&
                      transaction.issue_status === "none" &&
                      t("app.theDeadlineHasPassedAutomaticReleaseIs")}
                  </div>
                )}
                {transaction.issue_status !== "none" && transaction.issue && (
                  <div className="counter-summary">
                    <strong>
                      {transaction.issue_status === "escalated"
                        ? t("app.issueEscalatedToSidespace")
                        : transaction.issue_status === "resolved"
                          ? t("app.issueResolved")
                          : t("app.resolveWithTheCreator")}
                    </strong>
                    <p>{transaction.issue.details}</p>
                    {transaction.issue_status === "open" && (
                      <p>
                        {t("app.payoutRemainsPendingUseMessagesToTry")}
                      </p>
                    )}
                  </div>
                )}
                {transaction.payout_status === "released" && (
                  <div className="campaign-request-brief">
                    <small>{t("app.payoutReleased")}</small>
                    {buyer
                      ? t("app.theCreatorPayoutHasBeenReleasedAnd")
                      : t("app.payoutAmountCentsWasReleasedValue", { payout_amount_cents: formatCents(transaction.payout_amount_cents), value: transaction.payout_released_at
                            ? ` on ${displayDateTime(transaction.payout_released_at, t, locale)}`
                            : "" })}
                  </div>
                )}
                {transaction.review && (
                  <div className="campaign-request-brief">
                    <small>{t("app.creatorReviewRating5", { rating: transaction.review.rating })}</small>
                    {transaction.review.review_text}
                  </div>
                )}
                {transaction.payout_issue && (
                  <div className="campaign-request-brief">
                    <small>{t("app.payoutReleaseNeedsAttention")}</small>
                    {t("app.sidespaceCouldNotFinishTheTransferYet")}
                  </div>
                )}
                <div className="campaign-request-actions">
                  {!buyer &&
                    transaction.workflow_status === "paid_payout_pending" &&
                    transaction.payout_status === "pending" && (
                      <button
                        className="button button-dark button-small"
                        disabled={busy}
                        onClick={() => void runCampaignPaymentAction(transaction, "deliver")}
                      >
                        {busy ? t("app.updating") : t("app.markCampaignDelivered")}
                      </button>
                    )}
                  {buyer &&
                    transaction.workflow_status === "awaiting_payer_review" &&
                    transaction.issue_status === "none" &&
                    transaction.payout_status === "pending" &&
                    !reviewExpired && (
                      <>
                        <button
                          className="button button-coral button-small"
                          disabled={busy}
                          onClick={() => void runCampaignPaymentAction(transaction, "confirm")}
                        >
                          {busy ? t("app.releasing") : t("app.confirmWorkCompleted")}
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void runCampaignPaymentAction(transaction, "report_issue")
                          }
                        >
                          {t("app.reportAnIssue")}
                        </button>
                      </>
                    )}
                  {transaction.issue_status === "open" && (
                    <button onClick={openInbox}>{t("app.resolveWithTheCreator")}</button>
                  )}
                  {buyer && transaction.issue_status === "open" && (
                    <button
                      disabled={busy}
                      onClick={() => void runCampaignPaymentAction(transaction, "escalate")}
                    >
                      {t("app.escalateToSidespace")}
                    </button>
                  )}
                  {buyer && transaction.payout_status === "released" && !transaction.review && (
                    <button
                      className="button button-dark button-small"
                      disabled={busy}
                      onClick={() => void submitCreatorReview(transaction)}
                    >
                      {t("app.reviewCreator")}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    );
  }

  // The old root-page marketing sections remain in this file temporarily as
  // refactor reference, but never mount. Keeping the functional marketplace
  // branch live while route QA is underway avoids mixing a broad deletion
  // into the auth/listing preservation work.
  const legacyPublicSections = false;

  return (
    <main>
      <a className="ss-skip-link" href="#main-content">
        {t("chrome.skipToMain")}
      </a>
      <SiteHeader
        route={route}
        loading={loading}
        viewer={
          profile
            ? {
                displayName: profile.display_name,
                avatarUrl: profile.avatar_url,
              }
            : null
        }
        unreadCount={unreadCount}
        onMessages={openInbox}
        onSignIn={() => {
          setAuthMode("signin");
          setAuthOpen(true);
        }}
        onJoin={openSignupOrDashboard}
        onAccount={openAccountPanel}
      />

      {route === "dashboard" && (loading || (user && !profile && !profileChecked) ? (
        <section
          className="dashboard"
          id="main-content"
          tabIndex={-1}
          aria-label={t("app.loadingYourDashboard")}
        >
          <div className="dashboard-head">
            <div>
              <p className="eyebrow">{t("app.yourDashboard")}</p>
              <h1 className="dashboard-title">
                {t("app.settingThings")}{" "}<em>{t("app.up")}</em>
              </h1>
              <p className="dashboard-sub">{t("app.oneMomentWhileWeLoadYourDashboard")}</p>
            </div>
          </div>
        </section>
      ) : user && profile ? (
        <section
          className="dashboard"
          id="main-content"
          tabIndex={-1}
          aria-label={t("app.yourSidespaceDashboard")}
        >
          <div className="dashboard-head">
            <div>
              <p className="eyebrow">{rolesLabel(profile, locale)} · {profile.city || t("app.addYourCity")}</p>
              <h1 className="dashboard-title">
                <em>{greeting()},</em>{" "}
                {profile.display_name.split(" ")[0] || t("app.there")}.
              </h1>
              <p className="dashboard-sub">{dashboardStatus()}</p>
            </div>
            {/*
              * Messages and Profile both live in the sticky site header, which
              * is on screen at every scroll position and already carries the
              * unread badge. Repeating them here gave the same number three
              * formats within one viewport. Only the action you cannot start
              * from the header stays.
              */}
            <div className="dashboard-actions">
              {profile.role !== "consumer" && (
                <button className="button button-dark" onClick={openListingEditor}>
                  {t("app.newListing")}
                  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    <path
                      d="M8 3.5v9M3.5 8h9"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {(() => {
            const supplyPath = (
              <a
                className="dashboard-path"
                href="/marketplace?role=business"
                key="supply"
              >
                <span>{t("app.imACreatorOrHost")}</span>
                <strong>{t("app.findBusinessBriefs")}</strong>
                <p>{t("app.seeLocalCampaignsThatNeedYourAudience")}</p>
                <b>{t("app.browseBriefs")}</b>
              </a>
            );
            const demandPath = (
              <a
                className="dashboard-path"
                href="/marketplace?role=supply"
                key="demand"
              >
                <span>{t("app.imABusiness")}</span>
                <strong>{t("app.bookLocalReach")}</strong>
                <p>{t("app.chooseACreatorOrSpacePickAn")}</p>
                <b>{t("app.browseCreatorsAndSpaces")}</b>
              </a>
            );
            // Both stay: a creator books other creators often enough that
            // hiding one would be wrong. But leading with the side the member
            // is not on made half the biggest block on the page address
            // somebody else.
            const ownSideFirst =
              profileHasRole(profile, "creator") ||
              profileHasRole(profile, "space_owner") ||
              profileHasRole(profile, "sponsor_host");
            return (
              <div className="dashboard-paths" data-reveal>
                {ownSideFirst
                  ? [supplyPath, demandPath]
                  : [demandPath, supplyPath]}
              </div>
            );
          })()}

          <div className="dashboard-grid">
            {(() => {
              const active = ownListings.filter(
                (item) => item.status === "active",
              ).length;
              const paused = ownListings.filter(
                (item) => item.status === "paused",
              ).length;
              const incoming = campaignRequests.filter(
                (request) =>
                  request.owner_profile_id === profile.id &&
                  OPEN_REQUEST_STATUSES.includes(request.status),
              ).length;
              const outgoing = campaignRequests.filter(
                (request) =>
                  request.requester_profile_id === profile.id &&
                  OPEN_REQUEST_STATUSES.includes(request.status),
              ).length;
              // Every tile is a way in, not a readout. A number with nowhere
              // to click is the thing that made this dashboard feel inert:
              // you could see that three people were waiting on you and still
              // had to go hunting for them.
              const cards: Array<{
                label: string;
                value: number;
                caption: string;
                icon: keyof typeof DASHBOARD_STAT_ICONS;
                tone: string;
                action: string;
                go: () => void;
              }> = [
                {
                  label: "Live listings",
                  value: active,
                  caption: paused
                    ? `${paused} paused`
                    : "Visible in the marketplace",
                  icon: "listings" as const,
                  tone: active ? "" : "muted",
                  action: "Manage listings",
                  go: () => goToDashboardSection("dashboard-listings-all"),
                },
                {
                  label: "Offers to you",
                  value: incoming,
                  caption: incoming ? "Waiting on your reply" : "Nothing pending",
                  icon: "incoming" as const,
                  tone: incoming ? "alert" : "muted",
                  action: "Review offers",
                  go: () => {
                    setCampaignSide("incoming");
                    // The tile counted open work only; the section has to
                    // agree, or the number just clicked is nowhere on screen.
                    setCampaignOpenOnly(true);
                    goToDashboardSection("dashboard-campaigns-all");
                  },
                },
                {
                  label: "Offers you sent",
                  value: outgoing,
                  caption: outgoing ? "Awaiting a reply" : "None open",
                  icon: "outgoing" as const,
                  tone: outgoing ? "" : "muted",
                  action: "Track your offers",
                  go: () => {
                    setCampaignSide("outgoing");
                    // The tile counted open work only; the section has to
                    // agree, or the number just clicked is nowhere on screen.
                    setCampaignOpenOnly(true);
                    goToDashboardSection("dashboard-campaigns-all");
                  },
                },
                {
                  label: "Unread messages",
                  value: unreadCount,
                  caption: unreadCount ? "In your inbox" : "All caught up",
                  icon: "messages" as const,
                  tone: unreadCount ? "alert" : "muted",
                  action: "Open inbox",
                  go: openInbox,
                },
              ];
              if (ownListings.length) {
                const reached = listingAnalytics.reduce(
                  (sum, row) => sum + row.impressions,
                  0,
                );
                cards.push({
                  label: "People reached",
                  value: reached,
                  caption: reached ? "Across your listings" : "Counting from now",
                  icon: "analytics" as const,
                  tone: reached ? "" : "muted",
                  action: "See analytics",
                  go: () => goToDashboardSection("dashboard-analytics"),
                });
              }
              if (paymentTransactions.length) {
                cards.push({
                  label: "Payments",
                  value: paymentTransactions.length,
                  caption: "Money in motion",
                  icon: "payments" as const,
                  tone: "muted",
                  action: "See payment status",
                  go: () => goToDashboardSection("dashboard-payments"),
                });
              }
              return cards.map((card) => (
                <button
                  className="dashboard-stat"
                  type="button"
                  key={card.label}
                  onClick={card.go}
                  aria-label={`${card.action}. ${card.label}: ${card.value}, ${card.caption}.`}
                >
                  <span className="dashboard-stat-top">
                    <small>{tx(card.label)}</small>
                    <span className={`dashboard-stat-icon ${card.tone}`}>
                      <DashboardStatIcon name={card.icon} />
                    </span>
                  </span>
                  <strong>{card.value}</strong>
                  <span className="dashboard-stat-caption">{card.caption}</span>
                  <span className="dashboard-stat-action">
                    {card.action}
                    <svg
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                      focusable="false"
                    >
                      <path
                        d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                </button>
              ));
            })()}
          </div>

          <AccountBalance
            key={profile.id}
            profileId={profile.id}
            canEarn={profileHasRole(profile, "creator")}
            canRedeem={profile.role === "business"}
            stripeConfigured={stripeConfigured}
            busy={busy}
            onCreditsChange={setAdCreditBalanceCents}
            onStripe={(path) => {
              if (path === "/api/stripe/connect/login" || path === "/api/stripe/connect/onboard") {
                void openStripeFlow(path);
              }
            }}
            onRedeem={async (code) => {
              if (!supabase) throw new Error("Sign in to redeem a code.");
              const { data, error } = await supabase.rpc("redeem_business_referral_credit", { referral_code: code });
              if (error) throw error;
              const result = Array.isArray(data) ? data[0] : data;
              return Number(result?.awarded_cents ?? 0);
            }}
            renderDialog={(content, close) => <Modal label={t("app.yourBalance")} onClose={close}>{content}</Modal>}
          />

          {profile.role === "business" && (
            <section
              className="dashboard-panel dashboard-recommendations-panel"
              id="creator-recommendations"
              data-reveal
            >
              <header className="dashboard-panel-heading">
                <div>
                  <p className="eyebrow">{t("app.recommendedForYourCampaign")}</p>
                  <h2>{t("app.creatorPostsThatFitYourBrief")}</h2>
                  <p>
                    {t("app.rankedFromYourCategoryGoalPlatformTiming")}
                  </p>
                </div>
                <button
                  className="button button-ghost button-small"
                  onClick={openAccountPanel}
                >
                  {t("app.editPreferences")}{" "}<span>⚙</span>
                </button>
              </header>
              {creatorRecommendations.length ? (
                <div className="dashboard-recommendation-grid">
                  {creatorRecommendations.map((recommendation) => {
                    const copy = recommendation.listing;
                    return (
                    <article
                      className="dashboard-recommendation-card"
                      key={recommendation.listing.id}
                    >
                      <ListingCover listing={recommendation.listing} />
                      <div className="dashboard-recommendation-body">
                        <div className="dashboard-recommendation-meta">
                          <span>
                            {isBrief(recommendation.listing)
                              ? t("market.wanted")
                              : localizeListingChannel(locale, recommendation.listing.channel)}
                          </span>
                          <small>
                            {recommendation.listing.owner.display_name} ·{" "}
                            {listingCity(recommendation.listing)}
                          </small>
                        </div>
                        <strong>{copy.title}</strong>
                        <p>{copy.description}</p>
                        <small className="dashboard-recommendation-reason">
                          {recommendation.reasons.slice(0, 2).join(" · ")}
                        </small>
                        <div className="dashboard-recommendation-actions">
                          <button
                            onClick={() =>
                              openCampaignRequest(recommendation.listing)
                            }
                          >
                            {t("app.makeAnOffer")}
                          </button>
                          <button
                            className="dashboard-text-action"
                            onClick={() => openListing(recommendation.listing)}
                          >
                            {t("app.viewDetails")}
                          </button>
                        </div>
                      </div>
                    </article>
                    );
                  })}
                </div>
              ) : (
                <div className="dashboard-panel-empty">
                  <strong>{t("app.wereStillBuildingYourShortlist")}</strong>
                  <p>
                    {t("app.addATargetPlatformOrCategoryIn")}
                  </p>
                </div>
              )}
            </section>
          )}

          {(() => {
            const setUp =
              profile.onboarding_complete && Boolean(profile.avatar_url);
            const listed =
              profile.role === "consumer" ? true : ownListings.length > 0;
            // A finished checklist is not a record of achievement, it is a
            // block of struck-through text where working controls used to be.
            if (setUp && listed) return null;
            // ownListings starts empty and fills in a later tick, so a member
            // with six listings briefly looked like a member with none - the
            // checklist flashed "Publish your first listing" and vanished.
            if (setUp && ownListingsLoading) return null;
            return (
          <ol className="dashboard-checklist">
            <li className={profile.onboarding_complete ? "done" : ""}>
              <span>{profile.onboarding_complete ? "✓" : "1"}</span>
              <div>
                <strong>{t("app.completeYourProfile")}</strong>
                <p>{t("app.roleCityAndAShortIntroduction")}</p>
              </div>
              {!profile.onboarding_complete && (
                <button
                  className="button button-coral button-small"
                  onClick={() => {
                    setOnboardingMode("setup");
                    setOnboardingStep(1);
                    setOnboardingInvalidField("");
                    setOnboardingOpen(true);
                  }}
                >
                  {t("app.finishSetup")}
                </button>
              )}
            </li>
            <li className={profile.avatar_url ? "done" : ""}>
              <span>{profile.avatar_url ? "✓" : "2"}</span>
              <div>
                <strong>{t("app.addAProfilePhoto")}</strong>
                <p>{t("app.profilesWithAFaceOrLogoGet")}</p>
              </div>
              {!profile.avatar_url && (
                <button
                  className="button button-ghost button-small"
                  onClick={() => openProfileEditor(1)}
                >
                  {t("app.addPhoto")}
                </button>
              )}
            </li>
            {profile.role !== "consumer" ? (
              <li className={ownListings.length ? "done" : ""}>
                <span>{ownListings.length ? "✓" : "3"}</span>
                <div>
                  <strong>{t("app.publishYourFirstListing")}</strong>
                  <p>
                    {onboardingDraft
                      ? t("app.everythingYouTypedIsStillHere")
                      : t("app.yourSpaceOrAudienceCannotBeBooked")}
                  </p>
                </div>
                {!ownListings.length && (
                  <button
                    className="button button-coral button-small"
                    // Resume onboarding rather than opening the 16-control
                    // listing form this redesign exists to replace. If the
                    // profile saved but the listing insert failed, the answers
                    // are still in localStorage and come straight back.
                    onClick={resumeOnboardingDraft}
                  >
                    {onboardingDraft ? t("app.finishMyListing") : t("app.createListing")}
                  </button>
                )}
              </li>
            ) : (
              <li>
                <span>3</span>
                <div>
                  <strong>{t("app.findYourFirstPlacement")}</strong>
                  <p>{t("app.browseCreatorsAndSpacesThenMessageThe")}</p>
                </div>
                <a className="button button-ghost button-small" href="/marketplace">
                  {t("app.browse")}
                </a>
              </li>
            )}
          </ol>
            );
          })()}

          <div className="dashboard-work-sections">
            {renderDashboardAnalytics()}
            {renderDashboardListings()}
            {renderDashboardCampaigns()}
            {renderDashboardPayments()}
          </div>
        </section>
      ) : (
        <DashboardGate
          onSignIn={() => {
            setAuthMode("signin");
            setAuthOpen(true);
          }}
          onJoin={openSignupOrDashboard}
        />
      ))}

      {route === "home" && (
        <LandingPage
          listings={heroListings}
          onJoin={openSignupOrDashboard}
          onList={openListingEditor}
        />
      )}

      {/* Was five hard-coded labels, three of which named channels nobody
          had actually listed. It now scrolls the real channel list off the
          marketplace, so it can never advertise something that is not for
          sale. Two identical tracks translating -50% make the loop seamless;
          aria-hidden because it is decoration and the same information is
          in the filter chips below, which are reachable and announced. */}
      {legacyPublicSections && (<section
        className="signal-strip"
        aria-hidden="true"
      >
        <div className="signal-track">
          {[...channels.filter((channel) => channel !== "All"),
            ...channels.filter((channel) => channel !== "All")].map(
            (channel, index) => (
              <span className="signal-item" key={`${channel}-${index}`}>
                {channel}
              </span>
            ),
          )}
        </div>
      </section>)}

      {/* Sits directly above the marketplace, so every figure is derived
          from the same listings the grid renders. Hidden entirely while
          blocks are still loading rather than announcing counts that are
          about to change under the reader. */}
      {legacyPublicSections && !blocksPending && marketplaceStats.listings > 0 && (
        <section className="stat-band" aria-label={t("app.marketplaceAtAGlance")}>
          <div className="stat-cell">
            <b>{marketplaceStats.listings}</b>
            <span>{t("app.listingsLive2")}</span>
          </div>
          <div className="stat-cell">
            <b>{marketplaceStats.members}</b>
            <span>{t("app.membersOfferingSpace")}</span>
          </div>
          <div className="stat-cell">
            <b>{marketplaceStats.cities}</b>
            <span>{t("app.citiesCovered")}</span>
          </div>
          <div className="stat-cell">
            <b>{marketplaceStats.channels}</b>
            <span>{t("app.kindsOfSpace")}</span>
          </div>
        </section>
      )}

      {legacyPublicSections && (<section className="how-section" id="how">
        <div className="how-intro">
          <h2>{t("app.findItMessage")}{" "}<em>{t("home.howTitleAccent")}</em></h2>
        </div>
        <div className={stepsLive ? "steps steps-live" : "steps"} ref={stepsRef}>
          {[
            {
              icon: "⌕",
              title: "Find the right fit",
              copy: "Search local creators, briefs, and physical spaces.",
              widget: (
                <div className="mock mock-search" aria-hidden="true">
                  <div className="mock-field">
                    <span>⌕</span>
                    <em>{t("app.cafeWindowBrea")}</em>
                    <i className="mock-caret" />
                  </div>
                  <div className="mock-chips">
                    <b>{t("home.inventoryStorefront")}</b>
                    <b>Instagram</b>
                    <b>{t("home.inventoryVehicle")}</b>
                  </div>
                  <ul className="mock-results">
                    <li>
                      <span className="mock-thumb" />
                      <div>
                        <strong>{t("app.mainStreetWindow")}</strong>
                        <small>{t("app.n4Week")}</small>
                      </div>
                    </li>
                    <li>
                      <span className="mock-thumb" />
                      <div>
                        <strong>{t("market.channelCounterCard")}</strong>
                        <small>{t("app.n3Week")}</small>
                      </div>
                    </li>
                    <li>
                      <span className="mock-thumb" />
                      <div>
                        <strong>{t("app.rearWindowDecal")}</strong>
                        <small>{t("app.n5Week")}</small>
                      </div>
                    </li>
                  </ul>
                </div>
              ),
            },
            {
              icon: "@",
              title: "Talk it through",
              copy: "Agree on the idea, timing, price, and creative details.",
              widget: (
                <div className="mock mock-chat" aria-hidden="true">
                  <div className="mock-bubble them">
                    {t("app.hiIsTheWindowFreeTheFirst")}
                  </div>
                  <div className="mock-bubble me">
                    {t("app.itIsICanHoldItFor")}
                  </div>
                  <div className="mock-bubble them">
                    {t("app.perfectSendingARequestNow")}
                  </div>
                  <div className="mock-typing">
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              ),
            },
            {
              icon: "✓",
              title: "Book the work",
              copy: "Confirm the plan and put the local campaign in motion.",
              widget: (
                <div className="mock mock-deal" aria-hidden="true">
                  <div className="mock-deal-head">
                    <strong>{t("app.springLaunch")}</strong>
                    <span className="mock-status">{t("app.accepted")}</span>
                  </div>
                  <dl className="mock-deal-facts">
                    <div>
                      <dt>{t("app.dates")}</dt>
                      <dd>{t("app.mar1Mar8")}</dd>
                    </div>
                    <div>
                      <dt>{t("app.agreed")}</dt>
                      <dd>$32</dd>
                    </div>
                  </dl>
                  <div className="mock-deal-check">✓</div>
                </div>
              ),
            },
          ].map((step, index) => (
            <article
              key={step.title}
              className={activeStep === index ? "step-active" : ""}
              aria-current={activeStep === index ? "step" : undefined}
              tabIndex={0}
              onClick={() => setActiveStep(index)}
              onFocus={() => setActiveStep(index)}
              onMouseEnter={() => {
                if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
                  setActiveStep(index);
                }
              }}
            >
              <span>{`0${index + 1}`}</span>
              <div className="step-icon">{step.icon}</div>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
              <div className="step-widget">{step.widget}</div>
              <i className="step-progress" aria-hidden="true" />
            </article>
          ))}
        </div>
      </section>)}

      {route === "marketplace" && (<div className="ss-marketplace-page" id="main-content"><section className="market-section" id="market">
        <div className="section-top">
          <div>
            <p className="section-label">
              {listingSort === "popular"
                ? t("market.popularLabel")
                : t("market.label")}
            </p>
            <h1>
              {t("market.titleLead")} <em>{t("market.titleAccent")}</em>
            </h1>
          </div>
          <p>
            {t("market.description")}
          </p>
        </div>

        {/* Which side of the marketplace someone is on decides what they
            should even be looking at, so ask it plainly first. */}
        <div
          className="intent-switch"
          role="group"
          aria-label={t("market.intentAria")}
        >
          <button
            type="button"
            className={roleFilter === "supply" ? "active" : ""}
            aria-pressed={roleFilter === "supply"}
            onClick={() => {
              setRoleFilter("supply");
              setChannelFilter("All");
            }}
          >
            <strong>{t("market.advertise")}</strong>
            <small>{t("market.advertiseDescription")}</small>
          </button>
          <button
            type="button"
            className={roleFilter === "business" ? "active" : ""}
            aria-pressed={roleFilter === "business"}
            onClick={() => {
              setRoleFilter("business");
              setChannelFilter("All");
            }}
          >
            <strong>{t("market.offer")}</strong>
            <small>{t("market.offerDescription")}</small>
          </button>
          {roleFilter !== "all" && (
            <button
              type="button"
              className="intent-clear"
              onClick={() => setRoleFilter("all")}
            >
              {t("market.showEverything")}
            </button>
          )}
        </div>

        <div className="market-controls">
          <div className="market-searches">
            <label className="search-control">
              <span aria-hidden="true">⌕</span>
              <input
                type="search"
                aria-label={t("market.searchAria")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("market.searchPlaceholder")}
              />
            </label>
            <div className="search-control location-control">
              <span aria-hidden="true">⌖</span>
              <input
                type="search"
                aria-label={t("market.locationAria")}
                list="ss-market-location-options"
                value={locationQuery}
                onChange={(event) => setLocationAndUrl(event.target.value)}
                placeholder={t("market.locationPlaceholder")}
              />
              {locationQuery && (
                <button
                  type="button"
                  className="clear-location"
                  aria-label={t("market.clearLocation")}
                  onClick={() => setLocationAndUrl("")}
                >
                  ×
                </button>
              )}
              <datalist id="ss-market-location-options">
                {locationOptions.map((location) => (
                  <option key={location} value={location} />
                ))}
              </datalist>
            </div>
          </div>
          {/* A group of filters, not tabs: these narrow one grid rather than
              swapping panels, and role="tablist" without role="tab" children
              left the active filter signalled by background colour alone. */}
          <div
            className="role-tabs"
            role="group"
            aria-label={t("market.ownerTypeAria")}
          >
            {(
                [
                ["all", "market.everything"],
                ["supply", "market.advertisingAvailable"],
                ["creator", "market.creators"],
                ["business", "market.spaceWanted"],
              ] as Array<[RoleFilter, TranslationKey]>
            ).map(([value, labelKey]) => (
              <button
                key={value}
                type="button"
                className={roleFilter === value ? "active" : ""}
                aria-pressed={roleFilter === value}
                onClick={() => setRoleFilter(value)}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div
          className="filter-row"
          role="group"
          aria-label={t("market.channelAria")}
        >
          {channels.map((channel) => (
            <button
              key={channel}
              type="button"
              className={activeChannel === channel ? "active" : ""}
              aria-pressed={activeChannel === channel}
              onClick={() => setChannelFilter(channel)}
            >
              {channel === "All"
                ? t("market.everything")
                : localizeListingChannel(locale, channel)}
            </button>
          ))}
          {/* Announce the new count when a filter changes, so the result of
              pressing a filter is not visible-only. */}
          <span className="result-count" role="status" aria-live="polite">
            {blocksPending
              ? t("market.loading")
              : `${formatLocalizedNumber(visibleListings.length)} ${visibleListings.length === 1 ? t("market.listing") : t("market.listings")} · ${formatLocalizedNumber(requestableListingCount)} ${t("market.available")} · ${formatLocalizedNumber(visibleListings.length - requestableListingCount)} ${t("market.viewOnly")}`}
          </span>
        </div>

        <div className="listing-discovery-toolbar">
          <div
            className="listing-sort"
            role="group"
            aria-label={t("market.orderAria")}
          >
            <span className="listing-sort-label">{t("market.browseBy")}</span>
            <button
              type="button"
              className={listingSort === "popular" ? "active" : ""}
              aria-pressed={listingSort === "popular"}
              onClick={() => setListingSortAndUrl("popular")}
            >
              {t("market.popularNow")}
            </button>
            <button
              type="button"
              className={listingSort === "location" ? "active" : ""}
              aria-pressed={listingSort === "location"}
              onClick={() => setListingSortAndUrl("location")}
            >
              {t("market.locationSort")}
            </button>
            <button
              type="button"
              className={listingSort === "latest" ? "active" : ""}
              aria-pressed={listingSort === "latest"}
              onClick={() => setListingSortAndUrl("latest")}
            >
              {t("market.latest")}
            </button>
          </div>
          {locationQuery ? (
            <p className="listing-sort-note">
              {visibleListings.length
                ? t("market.locationNote", { location: locationQuery })
                : t("market.noLocationMatches", { location: locationQuery })}
            </p>
          ) : listingSort === "popular" ? (
            <p className="listing-sort-note">
              {t("market.popularityNote")}
            </p>
          ) : null}
        </div>

        {forYou.items.length >= 3 && (
          <section className="listing-foryou" aria-labelledby="listing-foryou-heading">
            <div className="listing-foryou-head">
              <span className="eyebrow">
                {forYou.personalised
                  ? t("market.pickedForYou")
                  : t("market.popularRightNow")}
              </span>
              <h3 id="listing-foryou-heading">
                {forYou.personalised
                  ? t("market.basedOnLooking")
                  : t("market.openingMost")}
              </h3>
            </div>
            <div className="listing-foryou-row">
              {forYou.items.map(({ listing, reasons }) => {
                const copy = listing;
                return (
                  <article
                    className="listing-foryou-card"
                    key={listing.id}
                    data-listing-id={listing.id}
                  >
                    <button
                      type="button"
                      className="listing-foryou-image"
                      onClick={() => openListing(listing)}
                      aria-label={t("market.openListing", { title: copy.title })}
                    >
                      <ListingCover listing={listing} />
                    </button>
                    <div className="listing-foryou-body">
                      <button
                        type="button"
                        className="listing-foryou-title"
                        onClick={() => openListing(listing)}
                      >
                        {copy.title}
                      </button>
                      <small>
                        {listing.owner.display_name} · {listingCity(listing)}
                      </small>
                      {reasons.length > 0 && (
                        <p className="listing-foryou-reason">{reasons.map((reason) => t(reason.key, reason.vars)).join(" · ")}</p>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        <div className="listing-grid">
          {blocksPending &&
            Array.from({ length: 6 }, (_, index) => (
              <div className="listing-skeleton" key={`skeleton-${index}`} />
            ))}
          {visibleListings.map((listing) => {
            const copy = listing;
            return (
              <article
                className="listing-card"
                key={listing.id}
                data-listing-id={listing.id}
              >
              <button
                className={`listing-image${
                  listingCover(listing) ? "" : " is-blank"
                }`}
                onClick={() => openListing(listing)}
              >
                <ListingCover listing={listing} />
                <span
                  className={`listing-channel ${isBrief(listing) ? "is-brief" : ""}`}
                >
                  {isBrief(listing)
                    ? t("market.wanted")
                    : localizeListingChannel(locale, listing.channel)}
                </span>
                {listingPhotos(listing).length > 1 && (
                  <span className="photo-count">
                    {formatLocalizedNumber(listingPhotos(listing).length)} {t("market.photos")}
                  </span>
                )}
                {listing.tour_kind && (
                  <span className="tour-badge">
                    {listing.tour_kind === "video" ? `▶ ${t("market.video")}` : "360°"}
                  </span>
                )}
                {/* A 34px circular heart pill sat here on every card - the
                    exact affordance every marketplace uses for "save" - with
                    no handler and no favorites feature behind it. Removed
                    rather than hidden: a control that does nothing when
                    clicked is worse than no control. Restore it alongside a
                    real favorites feature, not before. */}
                <span className="image-hint" aria-hidden="true">
                  {t("market.clickToView")} {" "}
                  <b aria-hidden="true" className="ss-icon-arrow ss-icon-east">
                    →
                  </b>
                </span>
              </button>
              <ListingLikeButton
                placement="card"
                title={copy.title}
                likeCount={listing.like_count}
                liked={likedListingIds.has(listing.id)}
                isAuthenticated={Boolean(user)}
                canLike={
                  !listing.owner.is_demo && profile?.id !== listing.owner.id
                }
                disabledReason={
                  listing.owner.is_demo
                    ? "Likes are unavailable on sample listings"
                    : profile?.id === listing.owner.id
                      ? "You cannot like your own listing"
                      : undefined
                }
                disabled={
                  pendingLikeIds.has(listing.id) ||
                  (Boolean(user) && likesLoading)
                }
                onToggle={() => void toggleListingLike(listing)}
              />
              <div className="listing-body">
                <div className="owner-line">
                  <Avatar profile={listing.owner} size="small" />
                  <div>
                    <strong>
                      {listing.owner.display_name}
                      {listing.owner.verified && <span className="verified">✓</span>}
                      {listing.owner.is_demo && (
                        <span className="sample-badge">{t("chrome.demo")}</span>
                      )}
                    </strong>
                    <small>
                      {rolesLabel(listing.owner, locale)} · {listingCity(listing)}
                    </small>
                  </div>
                </div>
                <button
                  className="listing-title"
                  onClick={() => openListing(listing)}
                >
                  {copy.title}
                </button>
                <p className="listing-blurb">{copy.description}</p>
                <div className="listing-offer">
                  <span className="listing-offer-label">
                    {isBrief(listing)
                      ? t("market.lookingFor")
                      : t("market.youGet")}
                  </span>
                  <span className="listing-offer-value">
                    {formatOffer(copy.format)}
                  </span>
                </div>
                <button
                  className="listing-more"
                  onClick={() => openListing(listing)}
                >
                  {t("market.learnMore")} {" "}
                  <span aria-hidden="true" className="ss-icon-arrow ss-icon-east">
                    →
                  </span>
                </button>
                <footer>
                  <div>
                    {isBrief(listing) && (
                      <span className="price-lead">{t("market.budget")}</span>
                    )}
                    <strong>{priceLabel(listing, locale, formatListingPrice)}</strong>
                    <small> / {localizeListingUnit(locale, pricingLabel(listing))}</small>
                  </div>
                  <button
                    disabled={!isListingRequestable(listing)}
                    onClick={() =>
                      isListingRequestable(listing) && !isBrief(listing)
                        ? openListing(listing)
                        : openCampaignRequest(listing)
                    }
                    title={
                      isListingRequestable(listing)
                        ? isBrief(listing)
                          ? undefined
                          : listing.instant_booking_enabled
                            ? t("market.chooseDateTitle")
                            : t("market.makeOfferTitle")
                        : t("market.ownerConfirmTitle")
                    }
                  >
                    {isListingRequestable(listing)
                      ? isBrief(listing)
                        ? t("market.offerMySpace")
                        : listing.instant_booking_enabled
                          ? t("market.chooseDates")
                          : t("market.viewBookingOptions")
                      : t("market.viewOnlyButton")}{" "}
                    <span aria-hidden="true" className="ss-icon-arrow">
                      ↗
                    </span>
                  </button>
                </footer>
              </div>
              </article>
            );
          })}
        </div>
        {!visibleListings.length && !blocksPending && (
          <div className="empty-state">
            <span>⌕</span>
            <h3>{t("market.noMatches")}</h3>
            <p>{t("market.tryBroader")}</p>
            <button
              className="button button-dark"
              onClick={() => {
                setQuery("");
                setLocationAndUrl("");
                setRoleFilter("all");
                setChannelFilter("All");
              }}
            >
              {t("market.clearFilters")}
            </button>
          </div>
        )}
      </section></div>)}

      {legacyPublicSections && (<section className="spaces-section" id="spaces">
        <div className="spaces-heading">
          <h2>
            {t("app.everyLocalSpot")}
            <br />
            {t("app.canBecome")}{" "}<em>{t("app.reach")}</em>
          </h2>
          <p>
            {t("app.aProduceStandBarberMirrorBakeryWindow")}
          </p>
          <div className="spaces-actions">
            <button
              className="button button-light"
              onClick={openListingEditor}
            >
              {t("app.listASpace")}{" "}<span>↗</span>
            </button>
            <button
              className="button button-coral"
              // Through requireAccount, not straight to the editor. This
              // section renders for a signed-in member whose profile is still
              // null, and edit mode skips the listing insert while still
              // writing onboarding_complete = true - which would mint exactly
              // the unbookable ghost profile this flow exists to stop.
              onClick={() => requireAccount(() => openProfileEditor(1))}
            >
              {user ? t("app.editMyProfile") : t("app.signUpFree")} <span>↗</span>
            </button>
          </div>
        </div>
        <div className="space-collage">
          <figure className="space-tile tile-wide">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/photos/roadside-farm-stand.jpg" alt={t("app.roadsideFarmStand")} loading="lazy" decoding="async" />
            <figcaption>
              <strong>{t("app.roadsideFarmStand")}</strong>
              <span>{t("app.dinubaCaOwnerSetsTheRate")}</span>
            </figcaption>
          </figure>
          <figure className="space-tile">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/photos/small-town-barber.jpg" alt={t("app.smallTownBarberShop")} loading="lazy" decoding="async" />
            <figcaption>
              <strong>{t("app.barberWaitingBench")}</strong>
              <span>{t("app.lanesboroMn3Week")}</span>
            </figcaption>
          </figure>
          <figure className="space-tile">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/photos/rural-market.jpg" alt={t("app.ruralMainStreetMarket")} loading="lazy" decoding="async" />
            <figcaption>
              <strong>{t("app.marketCounterCard")}</strong>
              <span>{t("app.mercerWi4Week")}</span>
            </figcaption>
          </figure>
        </div>
      </section>)}

      {legacyPublicSections && (<section className="people-section" id="creators">
        <div className="section-top">
          <div>
            <p className="section-label">{t("app.creatorsHostsAndBusinesses")}</p>
            <h2>{t("app.smallTown")}{" "}<em>{t("app.realInfluence")}</em></h2>
          </div>
          <p>
            {t("app.rentACreatorsInstagramStoryTiktokReach")}
          </p>
        </div>
        <div className="people-row">
          {showcasePeople.map((person) => (
            <article key={person.id} className="person-card">
              <Avatar profile={person} size="large" />
              <span className="person-role">{rolesLabel(person, locale)}</span>
              {person.is_demo && <span className="person-demo">{t("app.demoProfile")}</span>}
              {!person.is_demo && person.verified && (
                <span className="person-verified">{t("app.verifiedBySidespace")}</span>
              )}
              <h3>{person.display_name}</h3>
              <p>{displayHandle(person.handle ?? "") || person.city}</p>
              <SocialLinks profile={person} compact />
              {Boolean(person.gallery_urls?.length) && (
                <div className="profile-gallery-preview" aria-label={t("app.displayNamePhotos", { display_name: person.display_name })}>
                  {person.gallery_urls?.slice(0, 3).map((url, index) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={`${url}-${index}`} src={url} alt="" loading="lazy" decoding="async" />
                  ))}
                </div>
              )}
              {Boolean(
                person.followers ||
                  person.avg_views ||
                  person.audience_age ||
                  listingCountByOwner.get(person.id),
              ) && (
                // The row is bordered top and bottom, so drop it entirely rather
                // than framing a "0 weekly looks" for someone who has not filled it in.
                <div className="person-stats">
                  {Boolean(person.followers || person.avg_views) && (
                    <span>
                      <b>{compactNumber(person.followers || person.avg_views)}</b>
                      {person.followers
                        ? t("app.followers")
                        : ` ${person.reach_unit || "weekly looks"}`}
                    </span>
                  )}
                  {Boolean(listingCountByOwner.get(person.id)) && (
                    <span>
                      <b>{listingCountByOwner.get(person.id)}</b>
                      {listingCountByOwner.get(person.id) === 1
                        ? t("app.listingLive")
                        : t("app.listingsLive")}
                    </span>
                  )}
                  {Boolean(person.audience_age) && <span>{person.audience_age}</span>}
                </div>
              )}
              <button onClick={() => requireAccount(() => void startConversation(person))}>
                {t("app.sayHello")}
              </button>
            </article>
            ))}
        </div>
      </section>)}

      {/* Sits immediately before pricing, because the honest argument for
          the price is the comparison, not the number. A real table rather
          than a grid of divs: it is tabular data, screen readers announce
          the row and column headers, and it stays readable if the CSS never
          loads. */}
      {legacyPublicSections && (<section className="compare-section" aria-labelledby="compare-heading">
        <div className="compare-intro">
          <p className="eyebrow">{t("app.beforeAndAfter")}</p>
          <h2 id="compare-heading">
            {t("app.localAdvertisingTheOldWayAnd")}{" "}<em>{t("app.thisWay")}</em>
          </h2>
          <p className="compare-lede">
            {t("app.theSameSixQuestionsEveryOwnerAsks")}
          </p>
        </div>
        <div className="compare-scroll">
          <table className="compare-table">
            <thead>
              <tr>
                <th scope="col">{t("app.area")}</th>
                <th scope="col">{t("app.traditional")}</th>
                <th scope="col">SideSpace</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Getting started", "Call for a rate card, wait", "Post a listing in a minute"],
                ["Minimum spend", "Hundreds, often more", "None"],
                ["Who you deal with", "An agency or an ad platform", "The Creator offering the inventory"],
                ["Setting the price", "Take the rate you are given", "You name it, and you can counter"],
                ["Local reach", "Sold by postcode, roughly", "A specific window on a specific street"],
                ["Cost to list", "Not an option for most spaces", "Free"],
              ].map(([area, before, after]) => (
                <tr key={area}>
                  <th scope="row">{area}</th>
                  <td>{before}</td>
                  <td className="compare-ours">{after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>)}
      {legacyPublicSections && (<section className="pricing-section" id="pricing">
        <div className="pricing-intro">
          <div>
            <p className="eyebrow">{t("chrome.pricing")}</p>
            <h2>{t("app.startFreeGrowWhenYouAreReady")}</h2>
            <p className="pricing-note">
              {t("app.profilesListingsBrowsingRequestsAndMessagesHave")}
            </p>
          </div>
        </div>

        <div className="pricing-grid">
          <article className="pricing-card">
            <div>
              <span className="plan-label">{t("app.payAsYouGo")}</span>
              <h3>{t("app.free")}</h3>
              <p className="plan-price">
                <strong>$0</strong><span>{t("app.month")}</span>
              </p>
              <p>{t("app.forSmallBusinessesTestingTheirFirstLocal")}</p>
            </div>
            <ul>
              <li><b>{t("app.noSubscription")}</b>{" "}{t("app.orListingFee")}</li>
              <li>{t("app.browseEveryCreatorAndSpace")}</li>
              <li>{t("app.directPrivateMessaging")}</li>
              <li>{t("app.noMinimumCampaignSpend")}</li>
            </ul>
            <button
              className="pricing-button"
              onClick={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
            >
              {t("pricing.heroButton")}{" "}<span>↗</span>
            </button>
          </article>

          <article className="pricing-card pricing-card-featured">
            <span className="popular-badge">{t("app.businesses")}</span>
            <div>
              <span className="plan-label">{t("app.paidCampaign")}</span>
              <h3>5%</h3>
              <p className="plan-price">
                <strong>+5%</strong><span>{t("app.buyerFee2")}</span>
              </p>
              <p>{t("app.addedToTheAcceptedCampaignPriceBefore")}</p>
            </div>
            <ul>
              <li>{t("app.hostedStripeCheckout")}</li>
              <li>{t("app.taxCalculatedWhenApplicable")}</li>
              <li>{t("app.oneTimeInvoiceReceipt")}</li>
              <li>{t("app.noMonthlyPlan")}</li>
            </ul>
            <button
              className="pricing-button pricing-button-lime"
              onClick={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
            >
              {t("app.findACampaignPartner")}{" "}<span>↗</span>
            </button>
          </article>

          <article className="pricing-card">
            <div>
              <span className="plan-label">{t("app.creatorsAndHosts")}</span>
              <h3>5%</h3>
              <p className="plan-price">
                <strong>−5%</strong><span>{t("app.creatorFee2")}</span>
              </p>
              <p>{t("app.deductedFromTheAcceptedCampaignPrice")}</p>
            </div>
            <ul>
              <li>{t("app.stripeHostedPayoutOnboarding")}</li>
              <li>{t("app.clearEarningsBeforeAcceptance")}</li>
              <li>{t("app.paymentStatusInSidespace")}</li>
              <li>{t("app.noSubscriptionOrListingFee")}</li>
            </ul>
            <button
              className="pricing-button"
              onClick={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
            >
              {t("app.listYourReach")}{" "}<span>↗</span>
            </button>
          </article>
        </div>

      </section>)}

      {legacyPublicSections && (<section className="final-cta">
        <div>
          <h2>
            {t("app.readyFor")}
            <br />
            <em>{t("app.liftoffLocally")}</em>
          </h2>
        </div>
        <div>
          <p>
            {t("app.browseTheMarketplaceNowOrCreateA")}
          </p>
          <button
            className="button button-coral"
            onClick={() => {
              setAuthMode("signup");
              setAuthOpen(true);
            }}
          >
            {t("app.createYourFreeProfile")}{" "}<span>↗</span>
          </button>
        </div>
      </section>)}

      {legacyPublicSections && (<footer className="site-footer">
        <a className="brand footer-brand" href="#top">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt=""
            aria-hidden="true"
            className="brand-mark"
            width={31}
            height={31}
          />
          <span>SideSpace</span>
        </a>
        <p>{t("app.localReachMadeBookable")}</p>
        <nav>
          <a href="#how">{t("chrome.howItWorks")}</a>
          <a href="#market">{t("chrome.marketplace")}</a>
          <a href="#creators">{t("app.creatorInventory")}</a>
          <a href="#pricing">{t("chrome.pricing")}</a>
          <a href="/terms">{t("chrome.terms")}</a>
          <a href="/privacy">{t("chrome.privacy")}</a>
          <button onClick={openInbox}>{t("chrome.messages")}</button>
        </nav>
        <small>{t("chrome.yearSidespace", { year: new Date().getFullYear() })}</small>
      </footer>)}

      <SiteFooter
        onJoin={openSignupOrDashboard}
      />

      {authOpen && (
        <Modal
          elevated
          label={authMode === "signup" ? t("chrome.joinSideSpace") : t("app.signInToSidespace")}
          onClose={() => setAuthOpen(false)}
        >
          <div className="modal-heading">
            <p className="eyebrow">{t("app.yourSidespaceAccount")}</p>
            <h2>
              {authMode === "signup"
                ? invite
                  ? t("app.setUpBusiness", { business: invite.business })
                  : t("app.joinTheNetwork")
                : t("app.welcomeBack")}
            </h2>
            <p>
              {authMode !== "signup"
                ? t("app.signInToManageYourProfileListings")
                : invite
                  ? // They were written to by name. Landing on "Join the
                    // network" makes the email look like a mail-merge, which
                    // is the one thing the outreach rules exist to avoid.
                    t("app.oneAccountThenTheQuestionsWeCould")
                  : t("app.browsePubliclyCreateAnAccountWhenYoure")}
            </p>
          </div>
          {!configured && (
            <div className="setup-notice">
              <strong>
                {localPreviewAvailable
                  ? t("app.localOnboardingPreview")
                  : t("app.backendConnectionNeeded")}
              </strong>
              <p>
                {localPreviewAvailable
                  ? t("app.testEveryOnboardingStepWithSeededData")
                  : t("app.thisPreviewIsUsingSeededMarketplaceData")}
              </p>
            </div>
          )}
          {authMode === "signup" &&
            (activeBusinessReferralCode(referralCode) ||
              (invite && inviteRole(invite) === "business")) && (
            <div className="setup-notice ad-credit-signup-notice">
              <strong>
                {t("app.your")}{" "}{activeBusinessReferralCode(referralCode) ? t("app.referral") : t("app.invite")}{" "}{t("app.includes")}{" "}
                {activeBusinessReferralCode(referralCode)
                  ? referralCreditCents
                    ? t("app.referralcreditcentsIn", { referralCreditCents: formatCents(referralCreditCents) })
                    : ""
                  : t("app.businessSignupCreditCentsIn", { BUSINESS_SIGNUP_CREDIT_CENTS: formatCents(BUSINESS_SIGNUP_CREDIT_CENTS) })}
                {t("app.adCredit")}
              </strong>
              <p>
                {t("app.completeTheBusinessSetupAndItWill")}
              </p>
            </div>
          )}
          {localPreviewAvailable ? (
            <button
              type="button"
              className="button button-dark button-full preview-onboarding-button"
              onClick={openOnboardingPreview}
            >
              {t("app.previewOnboarding")}{" "}<span>→</span>
            </button>
          ) : (
            <>
              {googleOAuthEnabled && (
                <>
                  {/* Google's own button, on our domain, so its account
                      chooser says SideSpace. Falls back to the redirect
                      button whenever that path is unavailable. */}
                  <GoogleSignInButton
                    clientId={GOOGLE_CLIENT_ID}
                    onCredential={(token, nonce) => {
                      void completeGoogleSignIn(token, nonce);
                    }}
                    fallback={
                      <button
                        className="google-button"
                        onClick={signInWithGoogle}
                      >
                        <b>{t("app.g")}</b>{" "}{t("app.continueWithGoogle")}
                      </button>
                    }
                  />
                  <div className="form-divider">
                    <span>{t("app.orUseEmail")}</span>
                  </div>
                </>
              )}
              <form className="stack-form" onSubmit={handleAuth}>
                {authMode === "signup" && (
                  <label>
                    {t("app.yourName")}
                    <input name="name" required placeholder={t("app.alexMorgan")} />
                  </label>
                )}
                <label>
                  {t("app.emailAddress")}
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    placeholder={t("app.youExampleCom")}
                  />
                </label>
                <label>
                  {t("app.password")}
                  <input
                    name="password"
                    type="password"
                    minLength={8}
                    autoComplete={
                      authMode === "signup" ? "new-password" : "current-password"
                    }
                    required
                    placeholder={t("app.atLeast8Characters")}
                  />
                </label>
                <button
                  className="button button-dark button-full"
                  disabled={busy || !configured}
                >
                  {busy
                    ? t("app.oneMoment2")
                    : authMode === "signup"
                      ? t("app.createMyAccount")
                      : t("chrome.signIn")}
                  <span>↗</span>
                </button>
                {authMode === "signin" && (
                  <button
                    type="button"
                    className="switch-auth"
                    disabled={busy || !configured}
                    onClick={(event) => {
                      const form = event.currentTarget.form;
                      const field = form?.elements.namedItem("email");
                      const address =
                        field instanceof HTMLInputElement ? field.value : "";
                      void emailPasswordReset(address);
                    }}
                  >
                    {t("app.forgotYourPassword")}
                  </button>
                )}
              </form>
              <button
                className="switch-auth"
                onClick={() =>
                  setAuthMode((mode) =>
                    mode === "signup" ? "signin" : "signup",
                  )
                }
              >
                {authMode === "signup"
                  ? t("app.alreadyAMemberSignIn")
                  : t("app.newHereCreateAnAccount")}
              </button>
              <p className="security-note">
                {t("app.passwordsAreHandledBySupabaseAuthAnd")}
              </p>
            </>
          )}
        </Modal>
      )}

      {accountOpen && user && profile && (
        <Modal
          label={t("app.profileAndSettings")}
          onClose={() => setAccountOpen(false)}
          wide
        >
          <div className="account-dashboard">
            <header className="account-hero">
              <Avatar profile={profile} size="large" />
              <div>
                <p className="eyebrow">{t("app.yourSidespaceProfile")}</p>
                <h2>{profile.display_name}</h2>
                <p>
                  {user.email} <span>•</span> {rolesLabel(profile, locale)} <span>•</span>{" "}
                  {profile.city || t("app.locationNotAdded")}
                </p>
              </div>
              <span className="saved-account-badge">{t("app.profileSaved")}</span>
            </header>

            <div className="profile-action-panel">
              <div>
                <p className="eyebrow">{t("app.profileControls")}</p>
                <h3>{t("app.showUpTheWayYouWant")}</h3>
                <p>
                  {t("app.updateThePublicDetailsBusinessesAndCreators")}
                </p>
              </div>
              <button
                className="button button-dark"
                onClick={() => {
                  setAccountOpen(false);
                  openProfileEditor(1);
                }}
              >
                {t("app.editProfile")}{" "}<span>↗</span>
              </button>
            </div>

            <nav className="profile-section-nav" aria-label={t("app.profileSettings")}>
              {profile.role === "business" && (
                <a href="#campaign-preferences">{t("app.preferences")}</a>
              )}
              {stripeConfigured && profileHasRole(profile, "creator") && (
                <a href="#payouts">{t("app.payouts")}</a>
              )}
              {canonicalRole(profile.role) === "creator" && (
                <a href="#portfolio">{t("app.portfolio")}</a>
              )}
              <a href="#profile-trust">{t("app.trust")}</a>
              <a href="#profile-security">{t("app.security")}</a>
              <a
                className="profile-dashboard-link"
                href="/dashboard"
                onClick={() => setAccountOpen(false)}
              >
                {t("app.openDashboard")}
              </a>
            </nav>

            {profile.role === "business" && (
              <section
                className="account-section preferences-section"
                id="campaign-preferences"
              >
                <div className="account-section-heading">
                  <div>
                    <p className="eyebrow">{t("app.campaignPreferences")}</p>
                    <h3>{t("app.tellUsWhatAGoodCreatorLooks")}</h3>
                    <p className="account-section-lede">
                      {t("app.theseChoicesShapeTheCreatorPostsWe")}
                    </p>
                  </div>
                  <span className="section-count">{t("app.alwaysEditable")}</span>
                </div>
                <form
                  className="preferences-form"
                  onSubmit={saveBusinessPreferences}
                >
                  <div className="preferences-grid">
                    <PreferenceChipGroup
                      label={t("app.yourCategory")}
                      multi
                      options={CATEGORY_CHIPS.map((value) => ({
                        label: value,
                        value,
                      }))}
                      selected={businessPreferencesDraft.categories}
                      onPick={(value) =>
                        setBusinessPreferencesDraft((current) => ({
                          ...current,
                          categories: current.categories.includes(value)
                            ? current.categories.filter((item) => item !== value)
                            : [...current.categories, value],
                        }))
                      }
                    />
                    <PreferenceChipGroup
                      label={t("app.campaignGoal")}
                      options={BUSINESS_GOAL_CHIPS.map(({ label }) => ({
                        label,
                        value: label,
                      }))}
                      multi
                      selected={businessPreferencesDraft.goals}
                      onPick={(value) =>
                        setBusinessPreferencesDraft((current) => ({
                          ...current,
                          goals: current.goals.includes(value)
                            ? current.goals.filter((item) => item !== value)
                            : [...current.goals, value],
                        }))
                      }
                    />
                    <PreferenceChipGroup
                      label={t("app.whatYouWantToBook")}
                      options={BRIEF_SCOPE_CHIPS.map(({ label, value }) => ({
                        label,
                        value,
                      }))}
                      selected={businessPreferencesDraft.briefScope}
                      onPick={(value) =>
                        setBusinessPreferencesDraft((current) => ({
                          ...current,
                          briefScope:
                            current.briefScope === value
                              ? ""
                              : (value as BusinessPreferences["briefScope"]),
                        }))
                      }
                    />
                    <PreferenceChipGroup
                      label={t("app.physicalPlacements")}
                      multi
                      options={BRIEF_PHYSICAL_CHIPS.map((value) => ({
                        label: value,
                        value,
                      }))}
                      selected={businessPreferencesDraft.placements}
                      onPick={(value) =>
                        setBusinessPreferencesDraft((current) => ({
                          ...current,
                          placements: current.placements.includes(value)
                            ? current.placements.filter((item) => item !== value)
                            : [...current.placements, value],
                        }))
                      }
                    />
                    <PreferenceChipGroup
                      label={t("app.creatorPlatforms")}
                      multi
                      options={BRIEF_PLATFORM_CHIPS.map((value) => ({
                        label: value,
                        value,
                      }))}
                      selected={businessPreferencesDraft.targetPlatforms}
                      onPick={(value) =>
                        setBusinessPreferencesDraft((current) => ({
                          ...current,
                          targetPlatforms: current.targetPlatforms.includes(value)
                            ? current.targetPlatforms.filter((item) => item !== value)
                            : [...current.targetPlatforms, value],
                        }))
                      }
                    />
                  </div>
                  <div className="preferences-input-grid">
                    <label>
                      {t("app.preferredArea")}
                      <span className="optional">{t("app.optional2")}</span>
                      <small>{t("app.usedToPrioritizeLocalCreatorsAndSpaces")}</small>
                      <input
                        value={businessPreferencesDraft.wantedArea}
                        onChange={(event) =>
                          setBusinessPreferencesDraft((current) => ({
                            ...current,
                            wantedArea: event.target.value,
                          }))
                        }
                        placeholder={profile.city || t("app.downtownBerkeley")}
                      />
                    </label>
                    <PreferenceChipGroup
                      label={t("app.timing")}
                      options={BUSINESS_TIMING_CHIPS.map(({ label }) => ({
                        label,
                        value: label,
                      }))}
                      selected={businessPreferencesDraft.timing}
                      onPick={(value) =>
                        setBusinessPreferencesDraft((current) => ({
                          ...current,
                          timing: current.timing === value ? "" : value,
                        }))
                      }
                    />
                  </div>
                  <div className="preferences-save-row">
                    <p>{t("app.recommendationsRefreshAsSoonAsYouSave")}</p>
                    <button
                      className="button button-dark button-small"
                      disabled={preferencesSaving}
                    >
                      {preferencesSaving ? t("app.saving2") : t("app.savePreferences")}{" "}
                      <span>✓</span>
                    </button>
                  </div>
                </form>
              </section>
            )}

            {stripeConfigured && profileHasRole(profile, "creator") && (
              <section className="account-section" id="payouts">
                <div className="account-section-heading">
                  <div>
                    <p className="eyebrow">{t("app.stripePayouts")}</p>
                    <h3>{t("app.getPaidThroughAVerifiedAccount")}</h3>
                  </div>
                  <span className="section-count">
                    {stripeAccountStatus?.ready
                      ? t("app.ready")
                      : stripeAccountStatus?.connected
                        ? t("app.needsAttention")
                        : t("app.notSetUp")}
                  </span>
                </div>
                <div className="account-empty">
                  <strong>
                    {stripeAccountStatus?.ready
                      ? t("app.yourStripeAccountCanReceiveCampaignPayouts")
                      : t("app.finishStripesSecureOnboardingBeforeABusiness")}
                  </strong>
                  <p>
                    {t("app.stripeCollectsIdentityAndBankDetailsOn")}
                  </p>
                  <button
                    className="button button-dark button-small"
                    disabled={busy}
                    onClick={() =>
                      void openStripeFlow(
                        stripeAccountStatus?.ready
                          ? "/api/stripe/connect/login"
                          : "/api/stripe/connect/onboard",
                      )
                    }
                  >
                    {stripeAccountStatus?.ready
                      ? t("app.managePayoutsInStripe")
                      : stripeAccountStatus?.connected
                        ? t("app.continueStripeSetup")
                        : t("app.setUpStripePayouts")}
                  </button>
                </div>
              </section>
            )}

            {canonicalRole(profile.role) === "creator" && (
              <section className="account-section" id="portfolio">
                <div className="account-section-heading">
                  <div>
                    <p className="eyebrow">{t("app.publicCreatorPortfolio")}</p>
                    <h3>{t("app.showBusinessesWorkTheyCanTrust")}</h3>
                    <p>
                      {t("app.addCampaignExamplesVideosCaseStudiesOr")}
                    </p>
                  </div>
                  <span className="section-count">{t("app.creatorportfoliocountItems", { creatorPortfolioCount: creatorPortfolio.length })}</span>
                </div>
                {creatorPortfolio.length > 0 && (
                  <div className="campaign-request-list">
                    {creatorPortfolio.map((item) => (
                      <article className="campaign-request-card" key={item.id}>
                        <header>
                          <div>
                            <small>{item.kind.replaceAll("_", " ")}</small>
                            <h4>{item.title}</h4>
                          </div>
                          <span className="request-status status-active">{t("app.published")}</span>
                        </header>
                        {item.description && <p>{item.description}</p>}
                        <div className="campaign-request-actions">
                          {(item.project_url || item.media_url) && (
                            <a
                              className="button button-dark button-small"
                              href={item.project_url || item.media_url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {t("app.viewWork")}
                            </a>
                          )}
                          <button
                            disabled={busy}
                            onClick={() => void deleteCreatorPortfolioItem(item.id)}
                          >
                            {t("app.remove")}
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
                <form className="field-grid campaign-form" onSubmit={submitCreatorPortfolioItem}>
                  <label>
                    {t("app.workTitle")}
                    <input name="title" required minLength={2} maxLength={120} />
                  </label>
                  <label>
                    {t("app.type")}
                    <select name="kind" defaultValue="project">
                      <option value="video">{t("market.video")}</option>
                      <option value="campaign">{t("app.campaign")}</option>
                      <option value="case_study">{t("app.caseStudy")}</option>
                      <option value="project">{t("app.project")}</option>
                      <option value="other">{t("app.other")}</option>
                    </select>
                  </label>
                  <label>
                    {t("app.mediaUrl")}
                    <input name="media_url" type="url" placeholder={t("app.https")} />
                  </label>
                  <label>
                    {t("app.projectUrl")}
                    <input name="project_url" type="url" placeholder={t("app.https")} />
                  </label>
                  <label className="field-wide">
                    {t("app.whatDidYouMake")}
                    <textarea
                      name="description"
                      maxLength={1200}
                      placeholder={t("app.scopeDeliverablesResultAndYourRole")}
                    />
                  </label>
                  <button className="button button-dark field-wide" disabled={busy}>
                    {busy ? t("app.publishing") : t("app.addToPublicPortfolio")}
                  </button>
                </form>
                {creatorReviews.length > 0 && (
                  <div className="campaign-request-brief">
                    <small>{t("app.verifiedCampaignReviews")}</small>
                    {creatorReviews.length === 1 ? t("app.oneReview") : t("app.countReviews", { count: creatorReviews.length })}{" "}{t("app.value5Average", { value: (
                      creatorReviews.reduce((sum, review) => sum + review.rating, 0) /
                      creatorReviews.length
                    ).toFixed(1) })}
                  </div>
                )}
              </section>
            )}

            <section className="account-section trust-section" id="profile-trust">
              <div className="account-section-heading">
                <div>
                  <p className="eyebrow">{t("app.profileTrust")}</p>
                  <h3>{t("app.makeYourIdentityEasierToTrust")}</h3>
                </div>
                <span
                  className={`trust-state trust-${
                    profile.verified
                      ? "verified"
                      : verificationRequest?.status ??
                        profile.verification_status ??
                        "unverified"
                  }`}
                >
                  {profile.verified
                    ? t("app.verifiedBySidespace")
                    : verificationRequest?.status === "pending"
                      ? t("app.reviewPending")
                      : t("app.notVerifiedYet")}
                </span>
              </div>
              <div className="trust-grid">
                <div>
                  <span>✓</span>
                  <strong>{t("app.accountEmailActive")}</strong>
                  <p>{user.email}</p>
                </div>
                <div>
                  <span>@</span>
                  <strong>{t("app.socialLinks")}</strong>
                  <p>
                    {Object.keys(profile.social_links ?? {}).length
                      ? t("app.keyscountSelfReportedProfileLinkValue", { keysCount: Object.keys(profile.social_links ?? {}).length, value: Object.keys(profile.social_links ?? {}).length === 1 ? "" : "s" })
                      : t("app.addSocialProfilesFromEditProfile")}
                  </p>
                </div>
                <div>
                  <span>{profile.verified ? "✓" : "?"}</span>
                  <strong>{t("app.sidespaceReview")}</strong>
                  <p>
                    {profile.verified
                      ? t("app.evidenceReviewedByTheSidespaceTeam")
                      : verificationRequest?.status === "pending"
                        ? t("app.yourEvidenceIsWaitingForReview")
                        : t("app.submitPublicEvidenceForManualReview")}
                  </p>
                </div>
              </div>
              {/* A rejected request is still a request, so gating purely on
                  `!verificationRequest` hid this button forever after one
                  rejection - the copy said "before resubmitting" next to no
                  way to resubmit. Rejected members get the button back. */}
              {profile.role !== "consumer" &&
                !profile.verified &&
                (!verificationRequest ||
                  verificationRequest.status === "rejected") && (
                  <button
                    className="button button-dark button-small"
                    onClick={() => setVerificationOpen(true)}
                  >
                    {verificationRequest?.status === "rejected"
                      ? t("app.resubmitEvidence")
                      : t("app.requestVerification")}{" "}
                    <span>↗</span>
                  </button>
                )}
              {verificationRequest?.status === "rejected" && (
                <p className="trust-help">
                  {t("app.moreInformationIsNeededContactSupportEmail", { SUPPORT_EMAIL })}
                </p>
              )}
            </section>

            <section className="account-section settings-section" id="profile-security">
              <div className="account-section-heading">
                <div>
                  <p className="eyebrow">{t("app.loginSecurity")}</p>
                  <h3>{t("app.keepYourAccountProtected")}</h3>
                </div>
                <div className="account-storage-note">
                  <span>✓</span>
                  <p>
                    {t("app.yourLoginProfileListingsAndMessagesAre")}
                  </p>
                </div>
              </div>

              <div className="settings-grid">
                <div className="login-summary">
                  <small>{t("app.signedInEmail")}</small>
                  <strong>{user.email}</strong>
                  <p>
                    {t("app.loginMethodValue", { value: String(user.app_metadata.provider ?? "email") })}
                  </p>
                  <button
                    type="button"
                    onClick={() => void emailPasswordReset(user.email)}
                    disabled={busy}
                  >
                    {t("app.emailMeAPasswordResetLink")}
                  </button>
                </div>
                <form className="stack-form account-password-form" onSubmit={updatePassword}>
                  <label>
                    {t("app.currentPassword")}
                    <input
                      name="current_password"
                      type="password"
                      autoComplete="current-password"
                      required
                      placeholder={t("app.confirmItsYou")}
                    />
                  </label>
                  <label>
                    {t("app.newPassword")}
                    <input
                      name="new_password"
                      type="password"
                      minLength={8}
                      autoComplete="new-password"
                      required
                      placeholder={t("app.atLeast8Characters")}
                    />
                  </label>
                  <label>
                    {t("app.confirmNewPassword")}
                    <input
                      name="confirm_password"
                      type="password"
                      minLength={8}
                      autoComplete="new-password"
                      required
                      placeholder={t("app.typeItAgain")}
                    />
                  </label>
                  <button className="button button-dark button-full" disabled={busy}>
                    {busy ? t("app.saving") : t("app.updatePassword")} <span>✓</span>
                  </button>
                </form>
              </div>

              <div className="photo-manager">
                <strong>{t("app.yourPhotos")}</strong>
                <p>
                  {t("app.removeAnythingYouNoLongerWantOn")}
                </p>
                <div className="photo-manager-grid">
                  {profile.avatar_url && (
                    <figure className="saved-media">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={profile.avatar_url}
                        alt={t("app.yourProfilePhoto")}
                        loading="lazy"
                        decoding="async"
                      />
                      <figcaption>{t("app.profilePhoto")}</figcaption>
                      <button
                        type="button"
                        className="saved-media-remove"
                        disabled={busy}
                        aria-label={t("app.removeProfilePhoto")}
                        title={t("app.removeProfilePhoto")}
                        onClick={() =>
                          void removeProfilePhoto(profile.avatar_url, "avatar")
                        }
                      >
                        ×
                      </button>
                    </figure>
                  )}
                  {(profile.gallery_urls ?? []).map((url, index) => (
                    <figure className="saved-media" key={url}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={url}
                        alt={t("app.profilePhotoValue", { value: index + 1 })}
                        loading="lazy"
                        decoding="async"
                      />
                      <button
                        type="button"
                        className="saved-media-remove"
                        disabled={busy}
                        aria-label={t("app.removePhotoValue", { value: index + 1 })}
                        title={t("app.removePhoto")}
                        onClick={() => void removeProfilePhoto(url, "gallery")}
                      >
                        ×
                      </button>
                    </figure>
                  ))}
                </div>
                {!profile.avatar_url &&
                  !(profile.gallery_urls ?? []).length && (
                    <p className="photo-manager-empty">
                      {t("app.noPhotosYetAddThemFromEdit")}
                    </p>
                  )}
              </div>

              {blockedProfiles.length > 0 && (
                <div className="blocked-list">
                  <strong>{t("app.blockedMembers")}</strong>
                  <p>
                    {t("app.theyCannotMessageYouOrRequestYour")}
                  </p>
                  <ul>
                    {blockedProfiles.map((blocked) => (
                      <li key={blocked.id}>
                        <span>{blocked.display_name}</span>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void unblockProfile(blocked.id, blocked.display_name)
                          }
                        >
                          {t("app.unblock")}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <button
                className="button button-dark button-full account-signout-button"
                onClick={signOut}
              >
                {t("app.logOutOfSidespace")}{" "}<span>→</span>
              </button>

              {/* Destructive action sits last, after the everyday one. */}
              <div className="danger-zone">
                <div>
                  <strong>{t("app.deleteAccount")}</strong>
                  <p>
                    {t("app.permanentlyRemovesYourProfileListingsConversationsAnd")}
                  </p>
                </div>
                <button
                  type="button"
                  className="button button-danger button-small"
                  onClick={() => {
                    setDeleteAccountError("");
                    setDeleteAccountOpen(true);
                  }}
                >
                  {t("app.deleteMyAccount")}
                </button>
              </div>
            </section>
          </div>
        </Modal>
      )}

      {deleteListingTarget && (
        <Modal
          label={t("app.deleteListing")}
          onClose={() => {
            if (!busy) setDeleteListingTarget(null);
          }}
        >
          <div className="modal-heading">
            <p className="eyebrow">{t("app.deleteListing")}</p>
            <h2>{`Take \u201c${deleteListingTarget.title}\u201d down for good?`}</h2>
            <p>
              {t("app.itLeavesTheMarketplaceRightAwayAnd")}
            </p>
          </div>
          <div className="form-submit">
            <button
              type="button"
              disabled={busy}
              onClick={() => setDeleteListingTarget(null)}
            >
              {t("app.keepIt")}
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={busy}
              onClick={() => void deleteListing(deleteListingTarget)}
            >
              {busy ? t("app.deleting") : t("app.deleteListing")}
            </button>
          </div>
        </Modal>
      )}

      {deleteAccountOpen && user && (
        <Modal
          label={t("app.deleteYourAccount")}
          onClose={() => {
            if (!busy) {
              setDeleteAccountOpen(false);
              setDeleteAccountError("");
            }
          }}
        >
          <div className="modal-heading">
            <p className="eyebrow">{t("app.deleteAccount")}</p>
            <h2>{t("app.thisIsPermanent")}</h2>
            <p>
              {t("app.deletingYourAccountRemovesYourProfileEvery")}
            </p>
          </div>
          {deleteAccountError && (
            <div className="form-feedback" role="alert">
              <p>{deleteAccountError}</p>
            </div>
          )}
          <form className="stack-form" onSubmit={deleteAccount}>
            {passwordCapable(user) ? (
              <label>
                {t("app.confirmYourPasswordToContinue")}
                <input
                  name="delete_password"
                  type="password"
                  autoComplete="current-password"
                  required
                  placeholder={t("app.yourCurrentPassword")}
                />
              </label>
            ) : (
              <label>
                {t("app.typeDeleteToConfirm")}
                <input
                  name="delete_confirmation"
                  required
                  autoComplete="off"
                  placeholder={t("app.delete")}
                />
                <small>
                  {t("app.yourAccountDoesNotUseAnEmail")}
                </small>
              </label>
            )}
            <div className="form-submit">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDeleteAccountOpen(false);
                  setDeleteAccountError("");
                }}
              >
                {t("app.keepMyAccount")}
              </button>
              <button className="button button-danger" disabled={busy}>
                {busy ? t("app.deleting") : t("app.permanentlyDelete")}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {onboardingOpen && (user || onboardingPreview) && (
        <Modal
          elevated
          label={
            onboardingPreview
              ? t("app.previewSidespaceOnboarding")
              : onboardingMode === "edit"
              ? t("app.editYourSidespaceProfile")
              : t("app.setUpYourSidespaceAccount")
          }
          onClose={() => {
            setOnboardingOpen(false);
            setOnboardingPreview(false);
            setOnboardingStep(1);
            setOnboardingError("");
            setOnboardingInvalidField("");
            setAvatarCropPending(false);
            resetIgAvatarSync();
          }}
          wide
        >
          <div className="onboarding-top">
            <div>
              <p className="eyebrow">
                {onboardingPreview
                  ? t("app.localOnboardingPreview")
                  : onboardingMode === "edit"
                  ? t("app.editYourProfile")
                  : t("app.setUpYourAccount")}
              </p>
              <h2>
                {onboardingMode === "edit"
                  ? t("app.updateYourDetails")
                  : t("app.letsGetYouOnTheMarketplace")}
              </h2>
            </div>
            <div className="step-count">
              {Array.from({ length: onboardingStepCount() }, (_, index) => (
                <span
                  className={onboardingStep >= index + 1 ? "active" : ""}
                  key={index}
                />
              ))}
              <small>
                {t("app.stepOnboardingstepOfOnboardingstepcount", { onboardingStep, onboardingStepCount: onboardingStepCount() })}
              </small>
            </div>
          </div>

          {onboardingMode === "setup" &&
            (onboardingPreview ? (
              <div className="setup-notice preview-mode-notice">
                <strong>{t("app.nothingInThisPreviewIsSaved")}</strong>
                <p>
                  {t("app.useAnySampleAnswersYouLikeYou")}
                </p>
              </div>
            ) : invite && !profile ? (
              /* An invited business should never be asked to type its own
                 name. But a prefill they cannot see the origin of is just the
                 form asserting things about them, which is the thing this
                 whole flow has been fixed to stop doing - so it says where it
                 came from and that they are free to change it. */
              <div className="setup-notice">
                <strong>
                  {invite.owner_first_name?.trim()
                    ? t("app.hiOwnerFirstNameWeStartedThis", { owner_first_name: invite.owner_first_name.trim(), business: invite.business })
                    : t("app.weStartedThisForBusiness", { business: invite.business })}
                </strong>
                <p>
                  {t("app.filledInFromYourOwnWebsiteSo")}
                </p>
              </div>
            ) : (
              <div className="setup-notice">
                <strong>{t("app.nobodyCanSeeYouYet")}</strong>
                <p>
                  {t("app.yourProfileAppearsInSearchOnceYou")}
                </p>
              </div>
            ))}

          <form
            ref={onboardingFormRef}
            className="onboarding-form"
            data-invalid-field={onboardingInvalidField || undefined}
            onChangeCapture={(event) =>
              clearOnboardingInvalidField(event.target)
            }
            onClickCapture={(event) =>
              clearOnboardingInvalidField(event.target)
            }
            onSubmit={publishOnboarding}
          >
            {onboardingError && (
              <div
                className="form-feedback"
                id="onboarding-error"
                role="alert"
              >
                <p>{onboardingError}</p>
              </div>
            )}

            {/* ---------------------------------------------------------------
                STEP 1 - identity. Shared by both marketplace roles.
                --------------------------------------------------------------- */}
            {(onboardingStep === 1 ||
              (onboardingMode === "setup" && onboardingStep === 2)) && (
              <div
                className="form-step active onboarding-slide"
                data-direction={onboardingDirection > 0 ? "forward" : "back"}
                key={`${onboardingMode}-${onboardingStep}`}
              >
                <h3>
                  {onboardingStep === 1
                    ? t("app.whichOfTheseIsYou")
                    : t("app.startWithTheBasics")}
                </h3>
                <p>
                  {onboardingStep === 1
                    ? t("app.thisChangesWhatWeAskNextYou")
                    : t("app.aFewDetailsMakeTheRestOf")}
                </p>
                {onboardingStep === 1 && (
                <div
                  className="role-choice-grid"
                  data-field="role"
                  role="group"
                  aria-label={t("app.chooseHowYouWillUseSidespace")}
                  tabIndex={-1}
                >
                  {PICKABLE_ROLES.map((role) => (
                    <button
                      key={role}
                      type="button"
                      aria-pressed={selectedRole === role}
                      className={selectedRole === role ? "active" : ""}
                      onClick={() => {
                        const from = selectedRole;
                        const switching = from !== null && from !== role;
                        // Changing role changes what step 2 asks, and the four
                        // shapes are not interchangeable, so the role-shaped
                        // answers have to go - a creator must not inherit the
                        // space owner's "per week" and a half-built space.
                        //
                        // But step 2 has a Back button, so this is reachable
                        // with nine answered questions behind it, and it used
                        // to discard them without a word. Ask first, and only
                        // when there is something to lose.
                        if (switching && roleAnswersFilled(answers)) {
                          const ok = window.confirm(
                            t("app.switchingToLabelClearsWhatYouFilled", { label: tx(roleCopy[role].label), label2: tx(roleCopy[from].label) }),
                          );
                          if (!ok) return;
                        }
                        setSelectedRole(role);
                        setRoleTouched(true);
                        setOnboardingError("");
                        setExtraRoles((current) =>
                          current.filter((extra) => extra !== role),
                        );
                        if (switching) {
                          setTitleTouched(false);
                          setDescriptionTouched(false);
                          setAnswers(answersForNewRole);
                        }
                        if (onboardingMode === "setup") {
                          window.requestAnimationFrame(() =>
                            goToOnboardingStep(2),
                          );
                        }
                      }}
                    >
                      <span>{roleCopy[role].icon}</span>
                      <small>{tx(roleCopy[role].eyebrow)}</small>
                      <strong>{tx(roleCopy[role].label)}</strong>
                      <p>{tx(roleCopy[role].short)}</p>
                    </button>
                  ))}
                </div>
                )}

                  {(onboardingMode === "edit" || onboardingStep === 2) && (
                <div className="field-grid onboarding-identity-fields">
                  <label>
                    {selectedRole === "business" ? t("app.businessName") : t("app.yourName")}
                    <input
                      autoFocus={onboardingMode === "setup" && onboardingStep === 2}
                      name="display_name"
                      data-field="display_name"
                      maxLength={80}
                      value={answers.display_name}
                      onChange={(event) =>
                        setAnswers((current) => ({
                          ...current,
                          display_name: event.target.value,
                        }))
                      }
                      placeholder={
                        selectedRole === "business"
                          ? t("app.breaCoffeeBar")
                          : t("app.mayaAlvarez")
                      }
                    />
                  </label>
                  {(onboardingMode === "edit" ||
                    Boolean(answers.display_name.trim())) && (
                  <label className="progressive-field">
                    <span className="location-field-label">{t("app.whereAreYouBased")}</span>
                    <small>{t("app.uSCityAndStateThisIs")}</small>
                    <div className="location-input-row">
                      <CityAutocomplete
                        value={answers.city}
                        disabled={busy || locationBusy}
                        placeholder={t("app.breaCa")}
                        onChange={(city) => {
                          setLocationError("");
                          setAnswers((current) => ({
                            ...current,
                            city,
                            location: null,
                          }));
                        }}
                        onSelect={(place) => {
                          setLocationError("");
                          setAnswers((current) => ({
                            ...current,
                            city: place.label,
                            location: normalizeLocationPoint({
                              latitude: place.latitude,
                              longitude: place.longitude,
                            }),
                          }));
                        }}
                      />
                      <button
                        type="button"
                        className="button button-small location-button"
                        disabled={busy || locationBusy}
                        onClick={captureCurrentLocation}
                      >
                        {locationBusy ? t("app.finding") : t("app.useMyLocation")}
                      </button>
                    </div>
                    {locationError ? (
                      <small className="location-data-status is-error" role="alert">
                        {locationError}
                      </small>
                    ) : answers.location ? (
                      <small className="location-data-status" role="status">
                        {t("app.uSCityLevelLocationSavedYour")}
                      </small>
                    ) : (
                      <small className="location-data-status">
                        {t("app.uSLocationsOnlyChooseAResult")}
                      </small>
                    )}
                  </label>
                  )}
                  {(onboardingMode === "edit" ||
                    Boolean(answers.city.trim())) && (
                  <label className="field-wide progressive-field">
                    {selectedRole === "business"
                      ? t("app.oneLineAboutYourBusiness")
                      : t("app.oneLineAboutYou")}
                    <small>
                      {selectedRole === "business"
                        ? t("app.describeWhatYouDoInAtLeast2")
                        : selectedRole === "creator"
                          ? t("app.describeWhatYouDoInAtLeast")
                          : t("app.oneSentenceItSitsUnderYourName")}
                      {" "}
                      <span
                        className="field-character-count"
                        aria-live="polite"
                        data-complete={
                          bioMeetsRequirement(answers.bio, selectedRole)
                            ? "true"
                            : "false"
                        }
                      >
                        {getBioRequirementHint(answers.bio, selectedRole, t)}
                      </span>
                    </small>
                    <input
                      name="bio"
                      data-field="bio"
                      maxLength={160}
                      value={answers.bio}
                      onChange={(event) =>
                        setAnswers((current) => ({
                          ...current,
                          bio: event.target.value,
                        }))
                      }
                      placeholder={
                        selectedRole === "business"
                          ? t("app.thirdWaveCoffeeBarOnBirchOpen")
                          : t("app.analogFashionAndHonestCityGuidesFor")
                      }
                    />
                  </label>
                  )}
                  {(onboardingMode === "edit" ||
                    answers.bio.trim().length > 0) && (
                  <>
                  <div className="field-wide media-upload-field progressive-field">
                    <OptionalFieldLabel>
                      {selectedRole === "business" ? t("app.addYourLogo") : t("app.addAProfilePhoto")}
                    </OptionalFieldLabel>
                    <ProfilePhotoField
                      currentUrl={profile?.avatar_url}
                      inputRef={avatarInputRef}
                      value={avatarFile}
                      onFileChange={setAvatarFile}
                      onCropStateChange={setAvatarCropPending}
                    />
                    <small>
                      {t("app.profilesWithAFaceOrALogo")}
                      {profile?.avatar_url
                        ? t("app.leaveEmptyToKeepYourCurrentPhoto")
                        : ""}
                    </small>
                  </div>
                  {/* A business gives the person behind the name; everyone
                      else gives an email. Nobody is asked for an @handle any
                      more - it was a unique-indexed field that meant nothing
                      to the person filling it in. */}
                  {selectedRole === "business" ? (
                    <label className="progressive-field">
                      <OptionalFieldLabel>{t("app.yourName")}</OptionalFieldLabel>
                      <small>{t("app.whoABookerIsActuallyWritingTo")}</small>
                      {/* Every other example in this flow is invented -
                          "Maya Alvarez", "Brea Coffee Bar". This placeholder
                          was the founder's own name, shown as ghost text in a
                          box asking a stranger for theirs. */}
                      <input
                        name="contact_name"
                        data-field="contact_name"
                        maxLength={80}
                        value={answers.contact_name}
                        onChange={(event) =>
                          setAnswers((current) => ({
                            ...current,
                            contact_name: event.target.value,
                          }))
                        }
                        placeholder={t("app.danaOkafor")}
                      />
                    </label>
                  ) : (
                    <label className="progressive-field">
                      <OptionalFieldLabel>{t("app.email")}</OptionalFieldLabel>
                      <small>{t("app.howPeopleReachYouAboutABooking")}</small>
                      <input
                        name="contact_email"
                        data-field="contact_email"
                        type="email"
                        inputMode="email"
                        autoComplete="email"
                        maxLength={120}
                        value={answers.contact_email}
                        onChange={(event) =>
                          setAnswers((current) => ({
                            ...current,
                            contact_email: event.target.value,
                          }))
                        }
                        placeholder={t("app.youExampleCom")}
                      />
                    </label>
                  )}
                  </>
                  )}
                </div>
                )}

                {(onboardingMode !== "setup" || onboardingStep !== 1) && (
                  <div
                    className="onboarding-actions"
                    data-ready={isCurrentOnboardingStepComplete() ? "true" : "false"}
                  >
                    {onboardingMode === "setup" && onboardingStep === 2 ? (
                      <button
                        type="button"
                        onClick={() => goToOnboardingStep(1)}
                      >
                        {t("app.back")}
                      </button>
                    ) : (
                      <span />
                    )}
                    {shouldShowOnboardingPrimaryAction() && (
                      <span className="onboarding-primary-action-enter">
                        <span
                          className="onboarding-required-status"
                          role="status"
                          aria-live="polite"
                        >
                          {missingAnswers().length
                            ? t("app.missinganswerscountRequiredValueLeft", { missingAnswersCount: missingAnswers().length, value: missingAnswers().length === 1
                                  ? "detail"
                                  : "details" })
                            : t("app.readyToContinue")}
                        </span>
                        <button
                          type="button"
                          className="button button-dark"
                          onClick={advanceOnboarding}
                        >
                          {onboardingStep === 1
                            ? onboardingMode === "edit"
                              ? t("app.nextYourDetails")
                              : t("app.continue")
                            : selectedRole === "business"
                              ? t("app.continue")
                              : selectedRole === "creator"
                                ? t("app.nextWhatYouHaveToAdvertise")
                                : t("app.next")}{" "}
                          <span>→</span>
                        </button>
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ---------------------------------------------------------------
                STEP 2 - the thing they came to publish.
                Conditionally RENDERED, not display:none, so an unchosen role's
                controls are genuinely absent from the DOM.
                --------------------------------------------------------------- */}
            {((onboardingMode === "edit" && onboardingStep === 2) ||
              (onboardingMode === "setup" && onboardingStep >= 3)) && (
              <div
                className="form-step active onboarding-slide"
                data-direction={onboardingDirection > 0 ? "forward" : "back"}
                key={`${onboardingMode}-${onboardingStep}`}
              >
                {onboardingMode === "edit" ? (
                  <>
                    <h3>{t("app.yourDetails")}</h3>
                    <p>{t("app.thisIsWhatPeopleSeeOnYour")}</p>
                    {/* Gated. This block asks which platforms you post on and
                        your follower count, and it used to render for EVERY
                        role - so a barbershop or a robotics team opening their
                        own profile was asked for a follower count that means
                        nothing to them. It is not merely irrelevant: the person
                        card renders `followers || avg_views`, so a number typed
                        here REPLACES "300 people a day" with "N followers" and,
                        because publish falls back to the stored value, clearing
                        the box could not undo it.

                        Shown for creators, and for anyone who already has this
                        data from a legacy row so they can still edit it. */}
                    {showAudienceFields && (
                      <>
                        <div className="form-subsection field-wide">
                          <span>{t("app.yourAudience")}</span>
                          <h4>{t("app.whereCanBrandsFindYou")}</h4>
                          <p>
                            {t("app.chooseEveryPlatformYouUseThenAdd")}
                          </p>
                        </div>
                        <CreatorAudienceFields
                          answers={answers}
                          setAnswers={setAnswers}
                          igAvatarBusy={igAvatarBusy}
                          igAvatar={igAvatar}
                          igStats={igStats}
                          onCheckInstagram={(handle) =>
                            void syncInstagramAvatar(handle)
                          }
                        />
                      </>
                    )}
                    <div className="field-grid">
                      <label className="field-wide media-upload-field">
                        <OptionalFieldLabel>{t("app.profilePhotos")}</OptionalFieldLabel>
                        <input
                          name="gallery_files"
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          multiple
                          onChange={(event) =>
                            setGalleryFiles(Array.from(event.target.files ?? []))
                          }
                        />
                        <small>{t("app.upTo6PhotosOnYourProfile")}</small>
                      </label>
                    </div>
                    <div className="form-subsection field-wide">
                      <span>{t("app.aboutYou")}</span>
                      <h4>{t("app.whatKindOfWorkIsThis")}</h4>
                    </div>
                    <ChipRow
                      field="categories"
                      label={t("app.whatKindOfWork")}
                      optional
                      multi
                      options={CATEGORY_CHIPS}
                      selected={answers.categories}
                      onPick={(value) =>
                        setAnswers((current) => ({
                          ...current,
                          categories: current.categories.includes(value)
                            ? current.categories.filter((item) => item !== value)
                            : [...current.categories, value],
                        }))
                      }
                    />
                  </>
                ) : (
                  <>
                    <h3>
                      {onboardingStep === 5
                        ? t("app.reviewWhatPeopleWillSee")
                        : onboardingStep === 4
                          ? selectedRole === "creator"
                            ? answers.creatorOffer === "physical"
                              ? t("app.makeThePlacementBookable")
                              : answers.creatorOffer === "sponsorship"
                                ? t("app.buildTheSponsorshipLevels")
                                : answers.creatorOffer === "social"
                                  ? t("app.buildYourFirstOffer")
                                  : t("app.chooseYourWayToAdvertise")
                            : t("app.setThePracticalDetails")
                          : selectedRole === "creator"
                            ? answers.creatorOffer === "physical"
                              ? t("app.showUsThePlacement")
                              : answers.creatorOffer === "sponsorship"
                                ? t("app.tellUsAboutTheOrganization")
                                : answers.creatorOffer === "social"
                                  ? t("app.tellUsAboutYourAudience")
                                  : t("app.chooseYourWayToAdvertise")
                            : selectedRole === "business" &&
                                answers.businessSetupPath !== "campaign"
                              ? t("app.howDoYouWantToStart")
                              : t("app.shapeTheCampaign")}
                    </h3>
                    <p>
                      {onboardingStep === 5
                        ? t("app.makeAnyFinalEditsThenPublishWhen")
                        : onboardingStep === 4
                          ? t("app.clearExpectationsMakeTheFirstConversationMuch")
                          : selectedRole === "business"
                            ? answers.businessSetupPath === "campaign"
                              ? t("app.aFocusedBriefGetsBetterRepliesFrom")
                              : t("app.postACampaignNowOrBrowseListings")
                            : answers.creatorOffer
                              ? t("app.aFewSpecificAnswersMakeYourListing")
                              : t("app.startByChoosingTheKindOfAdvertising")}
                    </p>
                    {selectedRole === "creator" && onboardingStep > 3 && (
                      <CreatorOfferSwitcher
                        answers={answers}
                        onSelect={switchCreatorOffer}
                        isOfferComplete={creatorOfferSectionIsComplete}
                      />
                    )}

                    {/* ---------------- CREATOR ---------------- */}
                    {selectedRole === "creator" && (
                      <div
                        className="creator-offer-section-slide"
                        data-direction={
                          creatorOfferDirection > 0 ? "forward" : "back"
                        }
                        key={answers.creatorOffer || "no-creator-offer"}
                      >
                        {onboardingStep === 3 && (
                        <>
                        <div className="form-subsection field-wide">
                          <span>{t("app.yourWayToAdvertise")}</span>
                          <h4>{t("app.whatDoYouHaveToOffer")}</h4>
                          <p>
                            {t("app.selectEveryKindOfReachYouWant")}
                          </p>
                        </div>
                        <div
                          className="scope-grid creator-offer-grid"
                          data-field="creatorOffer"
                          role="group"
                          aria-label={t("app.whatKindOfAdvertisingYouOffer")}
                        >
                          {CREATOR_OFFER_TYPES.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              aria-pressed={answers.creatorOffers.includes(
                                option.value,
                              )}
                              className={
                                answers.creatorOffers.includes(option.value)
                                  ? "active"
                                  : ""
                              }
                              onClick={() => toggleCreatorOffer(option.value)}
                            >
                              <strong>{tx(option.label)}</strong>
                              <small>{tx(option.help)}</small>
                              <span className="offer-card-state">
                                {answers.creatorOffers.includes(option.value)
                                  ? t("app.selected")
                                  : t("app.select")}
                              </span>
                            </button>
                          ))}
                        </div>
                        <CreatorOfferSwitcher
                          answers={answers}
                          onSelect={switchCreatorOffer}
                          isOfferComplete={creatorOfferSectionIsComplete}
                        />

                        {answers.creatorOffer === "social" && (
                          <>
                          <div className="form-subsection field-wide">
                            <span>{t("app.yourAudience")}</span>
                            <h4>{t("app.whereCanBrandsFindYou")}</h4>
                            <p>
                              {t("app.chooseEveryPlatformYouUseThenAdd")}
                            </p>
                          </div>
                          <CreatorAudienceFields
                            answers={answers}
                            setAnswers={setAnswers}
                            igAvatarBusy={igAvatarBusy}
                            igAvatar={igAvatar}
                            igStats={igStats}
                            onCheckInstagram={(handle) =>
                              void syncInstagramAvatar(handle)
                            }
                          />
                          </>
                        )}

                        </>
                        )}

                        {onboardingStep === 4 && answers.creatorOffer === "social" && (
                        <>
                        <div className="form-subsection field-wide">
                          <h4>{t("app.whatDoesABrandActuallyGet")}</h4>
                        </div>
                        {/* Only when there are any: an empty flex row still
                            takes its margin, leaving a gap under the header
                            for anyone who has not picked a platform yet. */}
                        {answers.platforms.some(
                          (key) => (CREATOR_OFFER_EXAMPLES[key] ?? []).length,
                        ) && (
                          <>
                            <span className="offer-examples-label field-wide">
                              {t("app.orStartFromOneOfThese")}
                            </span>
                            <div className="offer-examples">
                              {answers.platforms
                                .flatMap((key) => CREATOR_OFFER_EXAMPLES[key] ?? [])
                                .slice(0, 6)
                                .map((example) => (
                                  <button
                                    key={example}
                                    type="button"
                                    onClick={() =>
                                      setAnswers((current) => ({
                                        ...current,
                                        format: example,
                                      }))
                                    }
                                  >
                                    {example}
                                  </button>
                                ))}
                            </div>
                          </>
                        )}
                        <div className="field-grid">
                          <label className="field-wide">
                            {t("app.whatTheyGet")}
                            {/* 140 to match the listing editor. At 60 a creator
                                who wanted "one in-feed post plus three stories
                                over 48 hours, with a link in bio" found the
                                field stopping accepting keystrokes, with no
                                message - measured in Chromium. */}
                            <input
                              data-field="format"
                              maxLength={140}
                              value={answers.format}
                              onChange={(event) =>
                                setAnswers((current) => ({
                                  ...current,
                                  format: event.target.value,
                                }))
                              }
                              placeholder={t("app.threeInstagramStoriesOver48Hours")}
                            />
                          </label>
                          {answers.format.trim() && (
                            <p className="offer-preview field-wide">
                              {t("app.yourCardWillRead")}{" "}
                              <strong>{t("app.youGetFormat", { format: formatOffer(answers.format) })}</strong>
                            </p>
                          )}
                        </div>
                        <details className="onboarding-optional-disclosure field-wide">
                          <summary>
                            <span>
                              {t("app.whatKindOfWork")}{" "}
                              <span className="optional">{t("app.optional2")}</span>
                            </span>
                            <small>
                              {answers.categories.length
                                ? t("app.categoriescountSelected", { categoriesCount: answers.categories.length })
                                : t("app.addCategories")}
                            </small>
                          </summary>
                          <div className="onboarding-optional-disclosure-body">
                            <ChipRow
                              field="categories"
                              label={t("app.whatKindOfWork")}
                              multi
                              hideLabel
                              options={CATEGORY_CHIPS}
                              selected={answers.categories}
                              onPick={(value) =>
                                setAnswers((current) => ({
                                  ...current,
                                  categories: current.categories.includes(value)
                                    ? current.categories.filter((item) => item !== value)
                                    : [...current.categories, value],
                                }))
                              }
                            />
                          </div>
                        </details>
                        <div className="field-grid">
                          <label className="field-wide media-upload-field">
                            <OptionalFieldLabel>
                              {t("app.photosOfYourWork")}
                            </OptionalFieldLabel>
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              multiple
                              onChange={(event) =>
                                chooseListingFiles(
                                  Array.from(event.target.files ?? []),
                                )
                              }
                            />
                            <small>
                              {t("app.add13PhotosWithoutOneYour")}
                            </small>
                          </label>
                        </div>
                        </>
                        )}
                      </div>
                    )}

                    {/* ---------------- CREATOR: PHYSICAL PLACEMENT ---------------- */}
                    {selectedRole === "creator" && answers.creatorOffer === "physical" && (
                      <>
                        {onboardingStep === 3 && (
                        <>
                        <div className="form-subsection field-wide">
                          <span>{t("app.theSpace")}</span>
                          <h4>{t("app.whatKindOfSpaceIsIt")}</h4>
                        </div>
                        <ChipRow
                          field="spaceKind"
                          label={t("app.kindOfSpace")}
                          options={SPACE_KIND_CHIPS.map((item) => item.label)}
                          selected={answers.spaceKind ? [answers.spaceKind] : []}
                          onPick={(value) =>
                            setAnswers((current) => ({
                              ...current,
                              spaceKind: value,
                            }))
                          }
                        />
                        <div className="field-grid">
                          <label className="field-wide">
                            <OptionalFieldLabel>{t("app.exactAddress")}</OptionalFieldLabel>
                            {/* This used to end "listings are fetched whole,
                                so do not put anything here you would not make
                                public" - true when written, and false since
                                the address was taken out of the public column
                                list and out of the anon grant. Measured on the
                                live database: anon has no table-level SELECT
                                on listings and has_column_privilege for
                                street_address is false, so a visitor or a
                                crawler cannot reach it at all. A signed-in
                                member still can, because `authenticated`
                                keeps a table-wide grant, and that is the line
                                the copy now draws. */}
                            <small>
                              {t("app.usedForTheMapLinkBelowSo")}
                            </small>
                            <input
                              data-field="streetAddress"
                              maxLength={240}
                              value={answers.streetAddress}
                              onChange={(event) =>
                                setAnswers((current) => ({
                                  ...current,
                                  streetAddress: event.target.value,
                                }))
                              }
                              placeholder={t("app.n1398SolanoAveAlbanyCa94706")}
                            />
                            {answers.streetAddress.trim().length > 6 && (
                              /* A plain Maps link, not an embed: the Maps
                                 Embed and Street View APIs both need a billed
                                 key in the client bundle, and this gives the
                                 same "let me look at the block" for nothing. */
                              <a
                                className="map-preview-link"
                                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                                  answers.streetAddress.trim(),
                                )}`}
                                target="_blank"
                                rel="noreferrer noopener"
                              >
                                {t("app.seeThisSpotOnGoogleMaps")}
                              </a>
                            )}
                          </label>
                          <label>
                            <OptionalFieldLabel>
                              {t("app.whatBuyersSeeOnTheCard")}
                            </OptionalFieldLabel>
                            <small>
                              {t("app.aStreetOrNeighborhoodShownPubliclyInstead")}
                            </small>
                            <input
                              data-field="location_area"
                              value={answers.location_area}
                              onChange={(event) =>
                                setAnswers((current) => ({
                                  ...current,
                                  location_area: event.target.value,
                                }))
                              }
                              placeholder={answers.city || t("app.downtownBrea")}
                            />
                          </label>
                          {/* The description helper has always told owners to
                              "add the size" by hand. This is the form finally
                              asking, so the draft can say it for them. */}
                          <label>
                            {t("app.howBigIsIt")}
                            <small>
                              {t("app.roughlyWidthByHeightIsEnoughIt")}
                            </small>
                            <input
                              data-field="spaceSize"
                              maxLength={80}
                              value={answers.spaceSize}
                              onChange={(event) =>
                                setAnswers((current) => ({
                                  ...current,
                                  spaceSize: event.target.value,
                                }))
                              }
                              placeholder={t("app.n6Ft3Ft")}
                            />
                          </label>
                          <label className="field-wide media-upload-field">
                            <OptionalFieldLabel>
                              {t("app.photosOfTheSpace")}
                            </OptionalFieldLabel>
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              multiple
                              onChange={(event) =>
                                chooseListingFiles(
                                  Array.from(event.target.files ?? []),
                                )
                              }
                            />
                            <small>
                              {t("app.oneGoodPhotoRoughlyDoublesYourRequests")}
                            </small>
                          </label>
                        </div>

                        </>
                        )}

                        {onboardingStep === 4 && (
                        <>
                        <div className="form-subsection field-wide">
                          <span>{t("app.whatCanGoUp")}</span>
                          <h4>{t("app.whatWorksHereAndWhoPutsIt")}</h4>
                          <p>
                            {t("app.theFirstThingABuyerAsksBefore")}
                          </p>
                        </div>
                        <ChipRow
                          field="surfaces"
                          label={t("app.everythingYoudAllow")}
                          multi
                          options={SURFACE_CHIPS}
                          selected={answers.surfaces}
                          onPick={(value) =>
                            setAnswers((current) => {
                              const dropping = current.surfaces.includes(value);
                              return {
                                ...current,
                                surfaces: dropping
                                  ? current.surfaces.filter(
                                      (item) => item !== value,
                                    )
                                  : [...current.surfaces, value],
                                // Un-picking the chip clears the text, or a
                                // surface they took back keeps publishing.
                                surfaceOther:
                                  value === SURFACE_OTHER && dropping
                                    ? ""
                                    : current.surfaceOther,
                              };
                            })
                          }
                        />
                        {answers.surfaces.includes(SURFACE_OTHER) && (
                          <div className="field-grid">
                            <label className="field-wide">
                              {t("app.whatElseCanGoUp")}
                              <small>
                                {t("app.aFewWordsItJoinsTheList")}
                              </small>
                              <input
                                data-field="surfaceOther"
                                maxLength={60}
                                value={answers.surfaceOther}
                                onChange={(event) =>
                                  setAnswers((current) => ({
                                    ...current,
                                    surfaceOther: event.target.value,
                                  }))
                                }
                                placeholder={t("app.aShelfForProductSamples")}
                              />
                            </label>
                          </div>
                        )}
                        <ChipRow
                          field="installBy"
                          label={t("app.whoPutsItUp")}
                          options={INSTALL_CHIPS.map((item) => item.label)}
                          selected={
                            INSTALL_CHIPS.filter(
                              (item) => item.value === answers.installBy,
                            ).map((item) => item.label)
                          }
                          onPick={(value) => {
                            const chip = INSTALL_CHIPS.find(
                              (item) => item.label === value,
                            );
                            if (!chip) return;
                            setAnswers((current) => ({
                              ...current,
                              installBy: chip.value,
                            }));
                          }}
                        />

                        <div className="form-subsection field-wide">
                          <span>{t("app.howBusyIsIt")}</span>
                          <h4>{t("app.peopleWhoWalkPastOnANormal")}</h4>
                        </div>
                        <ChipRow
                          field="traffic"
                          label={t("app.footTraffic")}
                          options={TRAFFIC_CHIPS.map((item) => item.label)}
                          selected={answers.traffic ? [answers.traffic] : []}
                          onPick={(value) => {
                            const chip = TRAFFIC_CHIPS.find(
                              (item) => item.label === value,
                            );
                            setAnswers((current) => ({
                              ...current,
                              traffic: value,
                              // The chip is a shortcut that fills the number in;
                              // the number is what actually publishes.
                              trafficCount:
                                chip && chip.count !== null
                                  ? chip.count
                                  : current.trafficCount,
                            }));
                          }}
                        />
                        <div className="field-grid">
                          <label>
                            {t("app.peopleADay")}
                            <small>
                              {t("app.pickAChipToFillThisIn")}
                            </small>
                            <input
                              type="number"
                              min={1}
                              max={2000000000}
                              data-field="trafficCount"
                              value={answers.trafficCount ?? ""}
                              onChange={(event) =>
                                setAnswers((current) => ({
                                  ...current,
                                  trafficCount: event.target.value
                                    ? Number(event.target.value)
                                    : null,
                                }))
                              }
                              placeholder="300"
                            />
                          </label>
                        </div>

                        <div className="form-subsection field-wide">
                          <span>{t("app.availability")}</span>
                          <h4>{t("app.whenIsItFree")}</h4>
                        </div>
                        <ChipRow
                          field="availability"
                          label={t("app.availability")}
                          options={AVAILABILITY_CHIPS.map((item) => item.label)}
                          selected={
                            answers.availability ? [answers.availability] : []
                          }
                          onPick={(value) =>
                            setAnswers((current) => ({
                              ...current,
                              availability: value,
                            }))
                          }
                        />
                        {(() => {
                          const free = AVAILABILITY_CHIPS.find(
                            (item) => item.label === answers.availability,
                          );
                          return free ? (
                            <p className="chip-note field-wide">
                              {windowNote(free.startDays, free.days, t, locale)}
                            </p>
                          ) : null;
                        })()}
                        </>
                        )}
                      </>
                    )}

                    {/* ---------------- BUSINESS ---------------- */}
                    {selectedRole === "business" && (
                      <>
                        {onboardingStep === 3 &&
                          answers.businessSetupPath !== "campaign" && (
                        <div
                          className="onboarding-path-grid onboarding-primary-action-enter"
                          data-field="businessSetupPath"
                        >
                          <button
                            type="button"
                            className="button button-dark"
                            onClick={startBusinessCampaign}
                          >
                            {t("app.startACampaign")}{" "}<span>→</span>
                          </button>
                          <button
                            type="button"
                            className="button button-dark"
                            disabled={busy}
                            onClick={browseBusinessListings}
                          >
                            {busy ? t("app.opening") : t("app.browseAvailableListings")}{" "}
                            <span>→</span>
                          </button>
                        </div>
                        )}
                        {onboardingStep === 3 &&
                          answers.businessSetupPath === "campaign" && (
                        <div className="progressive-field field-wide">
                        <div className="form-subsection field-wide">
                          <span>{t("app.whatYourePromoting")}</span>
                          <h4>{t("app.whatAreYouActuallyRunningThisFor")}</h4>
                          <p>
                            {t("app.theSpecificThingAProductAnOpening")}
                          </p>
                        </div>
                        <div className="field-grid">
                          <label className="field-wide">
                            {t("app.inAFewWords")}
                            <small>
                              {t("app.finishTheSentenceWerePromoting")}
                            </small>
                            <input
                              data-field="promoting"
                              maxLength={80}
                              value={answers.promoting}
                              onChange={(event) =>
                                setAnswers((current) => ({
                                  ...current,
                                  promoting: event.target.value,
                                }))
                              }
                              placeholder={t("app.ourNewColdBrew")}
                            />
                          </label>
                        </div>
                        <ChipRow
                          field="categories"
                          label={t("app.whatKindOfBusinessYouAre")}
                          optional
                          multi
                          options={CATEGORY_CHIPS}
                          selected={answers.categories}
                          onPick={(value) =>
                            setAnswers((current) => ({
                              ...current,
                              categories: current.categories.includes(value)
                                ? current.categories.filter((item) => item !== value)
                                : [...current.categories, value],
                            }))
                          }
                        />

                        <div className="form-subsection field-wide">
                          <span>{t("app.theGoal")}</span>
                          <h4>{t("app.whatShouldThisCampaignDo")}</h4>
                        </div>
                        <ChipRow
                          field="goals"
                          label={t("app.whatItShouldDo")}
                          multi
                          options={BUSINESS_GOAL_CHIPS.map((item) => item.label)}
                          selected={answers.goals}
                          onPick={(value) =>
                            setAnswers((current) => ({
                              ...current,
                              goals: current.goals.includes(value)
                                ? current.goals.filter((item) => item !== value)
                                : [...current.goals, value],
                            }))
                          }
                        />
                        {/* The fork. Everything below reshapes around it: pick
                            Physical and no platform is ever mentioned; pick
                            Virtual and nobody is asked what block they want. */}
                        <div className="form-subsection field-wide">
                          <span>{t("app.whatAreYouAfter")}</span>
                          <h4>{t("app.physicalSpaceSocialOrBoth")}</h4>
                        </div>
                        <div
                          className="scope-grid"
                          data-field="briefScope"
                          role="group"
                          aria-label={t("app.whatKindOfSpaceYouWant")}
                        >
                          {BRIEF_SCOPE_CHIPS.map((chip) => (
                            <button
                              key={chip.value}
                              type="button"
                              aria-pressed={answers.briefScope === chip.value}
                              className={
                                answers.briefScope === chip.value ? "active" : ""
                              }
                              onClick={() =>
                                setAnswers((current) => ({
                                  ...current,
                                  briefScope: chip.value,
                                }))
                              }
                            >
                              <strong>{tx(chip.label)}</strong>
                              <small>{tx(chip.help)}</small>
                            </button>
                          ))}
                        </div>

                        {answers.briefScope !== "" &&
                          answers.briefScope !== "virtual" && (
                            <>
                              <div className="form-subsection field-wide">
                                <span>{t("app.theSpace")}</span>
                                <h4>{t("app.whatKindAndWhere")}</h4>
                              </div>
                              <ChipRow
                                field="placements"
                                label={t("app.kindsOfSpace")}
                                multi
                                options={BRIEF_PHYSICAL_CHIPS}
                                selected={answers.placements}
                                onPick={(value) =>
                                  setAnswers((current) => ({
                                    ...current,
                                    placements: current.placements.includes(value)
                                      ? current.placements.filter(
                                          (item) => item !== value,
                                        )
                                      : [...current.placements, value],
                                  }))
                                }
                              />
                              <div className="field-grid">
                                <label className="field-wide">
                                  <OptionalFieldLabel>
                                    {t("app.whereDoYouWantIt")}
                                  </OptionalFieldLabel>
                                  <small>
                                    {t("app.theNeighborhoodOrStreetYouWantTo")}
                                  </small>
                                  <input
                                    data-field="wantedArea"
                                    maxLength={120}
                                    value={answers.wantedArea}
                                    onChange={(event) =>
                                      setAnswers((current) => ({
                                        ...current,
                                        wantedArea: event.target.value,
                                      }))
                                    }
                                    placeholder={
                                      answers.city
                                        ? t("app.downtownSplit", { split: answers.city.split(",")[0] })
                                        : t("app.downtownBrea")
                                    }
                                  />
                                </label>
                              </div>
                            </>
                          )}

                        {answers.briefScope !== "" &&
                          answers.briefScope !== "physical" && (
                            <>
                              <div className="form-subsection field-wide">
                                <span>{t("app.theAudience")}</span>
                                <h4>{t("app.whichPlatformsShouldItRunOn")}</h4>
                              </div>
                              <ChipRow
                                field="targetPlatforms"
                                label={t("app.platformsToTarget")}
                                multi
                                options={BRIEF_PLATFORM_CHIPS}
                                selected={answers.targetPlatforms}
                                onPick={(value) =>
                                  setAnswers((current) => ({
                                    ...current,
                                    targetPlatforms:
                                      current.targetPlatforms.includes(value)
                                        ? current.targetPlatforms.filter(
                                            (item) => item !== value,
                                          )
                                        : [...current.targetPlatforms, value],
                                  }))
                                }
                              />
                              <div className="field-grid">
                                <label className="field-wide">
                                  <OptionalFieldLabel>
                                    {t("app.anythingACreatorMustInclude")}
                                  </OptionalFieldLabel>
                                  <input
                                    data-field="deliverables"
                                    maxLength={200}
                                    value={answers.deliverables}
                                    onChange={(event) =>
                                      setAnswers((current) => ({
                                        ...current,
                                        deliverables: event.target.value,
                                      }))
                                    }
                                    placeholder={t("app.tagUsLinkInBioFor48h")}
                                  />
                                  {/* Below the box now, not above it: these
                                      fill the field, and every other example
                                      row in the product sits under the thing
                                      it fills. */}
                                  <span className="offer-examples-label">
                                    {t("app.orTapToAddOne")}
                                  </span>
                                  <span className="offer-examples">
                                    {DELIVERABLE_EXAMPLES.map((example) => {
                                      // Already in the list? Tapping again used
                                      // to append it a second time - "Tag @us,
                                      // Tag @us" - so it toggles instead.
                                      const parts = answers.deliverables
                                        .split(",")
                                        .map((item) => item.trim())
                                        .filter(Boolean);
                                      const picked = parts.includes(example);
                                      return (
                                        <button
                                          key={example}
                                          type="button"
                                          className={picked ? "is-picked" : ""}
                                          onClick={() =>
                                            setAnswers((current) => {
                                              const list = current.deliverables
                                                .split(",")
                                                .map((item) => item.trim())
                                                .filter(Boolean);
                                              const next = list.includes(example)
                                                ? list.filter(
                                                    (item) => item !== example,
                                                  )
                                                : [...list, example];
                                              return {
                                                ...current,
                                                deliverables: next.join(", "),
                                              };
                                            })
                                          }
                                        >
                                          {example}
                                        </button>
                                      );
                                    })}
                                  </span>
                                </label>
                              </div>
                            </>
                          )}

                        </div>
                        )}

                        {onboardingStep === 4 && (
                        <>
                        {/* The artwork they need carried. Uploaded here so a
                            creator or space owner can see exactly what they'd
                            be posting before they answer. */}
                        <div className="form-subsection field-wide">
                          <span>{t("app.yourArtwork")}</span>
                          <h4>{t("app.whatDoYouNeedPosted")}</h4>
                        </div>
                        <div className="field-grid">
                          <label className="field-wide media-upload-field">
                            <OptionalFieldLabel>{t("app.flyerStoryOrClip")}</OptionalFieldLabel>
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              multiple
                              onChange={(event) =>
                                chooseListingFiles(
                                  Array.from(event.target.files ?? []),
                                )
                              }
                            />
                            <small>
                              {t("app.uploadTheGraphicYouWantInThe")}
                            </small>
                          </label>
                        </div>
                        <ChipRow
                          field="artwork"
                          label={t("app.whoMakesTheArtwork")}
                          optional
                          options={[
                            "I’ll supply the artwork",
                            "I need help making it",
                          ]}
                          selected={
                            answers.artwork === "supply"
                              ? ["I’ll supply the artwork"]
                              : answers.artwork === "help"
                                ? ["I need help making it"]
                                : []
                          }
                          onPick={(value) =>
                            setAnswers((current) => {
                              const next =
                                value === "I’ll supply the artwork"
                                  ? "supply"
                                  : "help";
                              // Tapping the picked chip again clears it. This
                              // question is optional, but once answered there
                              // was no way back, and the answer writes a
                              // sentence into the published description.
                              return {
                                ...current,
                                artwork: current.artwork === next ? "" : next,
                              };
                            })
                          }
                        />

                        <div className="form-subsection field-wide">
                          <span>{t("app.budgetAndTiming")}</span>
                          <h4>{t("app.whatCanYouSpendAndWhen")}</h4>
                        </div>
                        <ChipRow
                          field="budgetRange"
                          label={t("app.budgetRange")}
                          options={BUDGET_RANGE_CHIPS.map((item) => item.label)}
                          selected={BUDGET_RANGE_CHIPS.filter(
                            (item) =>
                              item.min === answers.price &&
                              item.max === answers.priceMax,
                          ).map((item) => item.label)}
                          onPick={(value) => {
                            const chip = BUDGET_RANGE_CHIPS.find(
                              (item) => item.label === value,
                            );
                            if (!chip) return;
                            setAnswers((current) => ({
                              ...current,
                              price: chip.min,
                              priceMax: chip.max,
                            }));
                          }}
                        />
                        <div className="field-grid">
                          <label>
                            {t("app.budgetFrom")}
                            <input
                              type="number"
                              min={1}
                              max={2000000000}
                              data-field="price"
                              value={answers.price ?? ""}
                              onChange={(event) =>
                                setAnswers((current) => ({
                                  ...current,
                                  price: event.target.value
                                    ? Number(event.target.value)
                                    : null,
                                }))
                              }
                              placeholder="150"
                            />
                          </label>
                          <label>
                            <OptionalFieldLabel>{t("app.upTo")}</OptionalFieldLabel>
                            <small>{t("app.leaveBlankForAFlatBudget")}</small>
                            <input
                              type="number"
                              min={1}
                              max={2000000000}
                              data-field="priceMax"
                              value={answers.priceMax ?? ""}
                              onChange={(event) =>
                                setAnswers((current) => ({
                                  ...current,
                                  priceMax: event.target.value
                                    ? Number(event.target.value)
                                    : null,
                                }))
                              }
                              placeholder="500"
                            />
                          </label>
                        </div>
                        <ChipRow
                          field="timing"
                          label={t("app.whenItShouldRun")}
                          options={BUSINESS_TIMING_CHIPS.map((item) => item.label)}
                          selected={answers.timing ? [answers.timing] : []}
                          onPick={(value) =>
                            setAnswers((current) => ({ ...current, timing: value }))
                          }
                        />
                        {(() => {
                          const timing = BUSINESS_TIMING_CHIPS.find(
                            (item) => item.label === answers.timing,
                          );
                          return timing ? (
                            <p className="chip-note field-wide">
                              {windowNote(0, timing.days, t, locale)}
                            </p>
                          ) : null;
                        })()}
                        </>
                        )}
                      </>
                    )}

                    {/* ---------------- CREATOR: SPONSORSHIP ---------------- */}
                    {selectedRole === "creator" && answers.creatorOffer === "sponsorship" && (
                      <>
                        {onboardingStep === 3 && (
                        <>
                        <div className="form-subsection field-wide">
                          <span>{t("app.yourOrganization")}</span>
                          <h4>{t("app.whatAreYou")}</h4>
                        </div>
                        <ChipRow
                          field="orgKind"
                          label={t("app.whatKindOfOrganization")}
                          options={SPONSOR_ORG_CHIPS}
                          selected={answers.orgKind ? [answers.orgKind] : []}
                          onPick={(value) =>
                            setAnswers((current) => ({
                              ...current,
                              orgKind: value,
                              // Switching back to a real chip clears the text,
                              // or "Scout troop" keeps opening the description
                              // of a team that now calls itself a Nonprofit.
                              orgOther:
                                value === SPONSOR_ORG_OTHER ? current.orgOther : "",
                            }))
                          }
                        />
                        {answers.orgKind === SPONSOR_ORG_OTHER && (
                          <div className="field-grid">
                            <label className="field-wide">
                              {t("app.soWhatAreYou")}
                              <small>
                                {t("app.aCoupleOfWordsItOpensYour")}
                              </small>
                              <input
                                data-field="orgOther"
                                maxLength={40}
                                value={answers.orgOther}
                                onChange={(event) =>
                                  setAnswers((current) => ({
                                    ...current,
                                    orgOther: event.target.value,
                                  }))
                                }
                                placeholder={t("app.scoutTroop")}
                              />
                            </label>
                          </div>
                        )}
                        <div className="form-subsection field-wide">
                          <span>{t("app.whatItsFor")}</span>
                          <h4>{t("app.whatAreYouRaisingMoneyFor")}</h4>
                          <p>
                            {t("app.theChampionshipTripNewKitCompetitionFees")}
                          </p>
                        </div>
                        <div className="field-grid">
                          <label className="field-wide">
                            {t("app.inAFewWords")}
                            <small>
                              {t("app.finishTheSentenceWereRaisingFor")}
                            </small>
                            <input
                              data-field="funding"
                              maxLength={70}
                              value={answers.funding}
                              onChange={(event) =>
                                setAnswers((current) => ({
                                  ...current,
                                  funding: event.target.value,
                                }))
                              }
                              placeholder={t("app.theChampionshipTrip")}
                            />
                          </label>
                        </div>

                        <div className="form-subsection field-wide">
                          <span>{t("app.yourReach")}</span>
                          <h4>{t("app.howManyPeopleWillSeeIt")}</h4>
                        </div>
                        <ChipRow
                          field="reach"
                          label={t("app.roughlyHowMany")}
                          options={SPONSOR_REACH_CHIPS.map((item) => item.label)}
                          selected={answers.reach ? [answers.reach] : []}
                          onPick={(value) => {
                            const chip = SPONSOR_REACH_CHIPS.find(
                              (item) => item.label === value,
                            );
                            setAnswers((current) => ({
                              ...current,
                              reach: value,
                              reachCount:
                                chip && chip.count !== null
                                  ? chip.count
                                  : current.reachCount,
                            }));
                          }}
                        />
                        <div className="field-grid">
                          <label>
                            {t("app.howManyPeople")}
                            <small>
                              {t("app.pickAChipToFillThisIn2")}
                            </small>
                            <input
                              type="number"
                              min={1}
                              max={2000000000}
                              data-field="reachCount"
                              value={answers.reachCount ?? ""}
                              onChange={(event) =>
                                setAnswers((current) => ({
                                  ...current,
                                  reachCount: event.target.value
                                    ? Number(event.target.value)
                                    : null,
                                }))
                              }
                              placeholder="1000"
                            />
                          </label>
                        </div>

                        {/* These chips used to render straight under "How many
                            people will see it?", so "One event" read as an
                            answer about headcount. */}
                        <div className="form-subsection field-wide">
                          <span>{t("app.whenItRuns")}</span>
                          <h4>{t("app.howLongDoesASponsorshipLast")}</h4>
                        </div>
                        <ChipRow
                          field="season"
                          label={t("app.whenItRuns")}
                          options={SPONSOR_SEASON_CHIPS.map((item) => item.label)}
                          selected={answers.season ? [answers.season] : []}
                          onPick={(value) =>
                            setAnswers((current) => ({ ...current, season: value }))
                          }
                        />
                        {(() => {
                          const season = SPONSOR_SEASON_CHIPS.find(
                            (item) => item.label === answers.season,
                          );
                          return season ? (
                            <p className="chip-note field-wide">
                              {windowNote(0, season.days, t, locale)}
                            </p>
                          ) : null;
                        })()}

                        </>
                        )}

                        {onboardingStep === 4 && (
                        <>
                        <div className="form-subsection field-wide">
                          <span>{t("app.theMenu")}</span>
                          <h4>{t("app.whatCouldASponsorGet")}</h4>
                          <p>
                            {t("app.everythingYouWouldEverOfferAtAny")}
                          </p>
                        </div>
                        <ChipRow
                          field="benefits"
                          label={t("app.everythingYouCouldOffer")}
                          multi
                          options={SPONSOR_BENEFIT_CHIPS}
                          selected={answers.benefits}
                          onPick={(value) =>
                            setAnswers((current) => ({
                              ...current,
                              benefits: current.benefits.includes(value)
                                ? current.benefits.filter((item) => item !== value)
                                : [...current.benefits, value],
                              // Dropping a perk from the menu drops it from
                              // every tier, or a tier keeps advertising a
                              // benefit the team just said they do not offer.
                              tiers: current.benefits.includes(value)
                                ? current.tiers.map((tier) => ({
                                    ...tier,
                                    benefits: tier.benefits.filter(
                                      (item) => item !== value,
                                    ),
                                  }))
                                : current.tiers,
                            }))
                          }
                        />

                        {/* ---- the tiers, one card each on the marketplace ---- */}
                        <div className="form-subsection field-wide">
                          <span>{t("app.yourTiers")}</span>
                          <h4>{t("app.breakItIntoLevelsOrKeepOne")}</h4>
                          <p>
                            {t("app.eachTierPublishesItsOwnCardSo")}
                          </p>
                        </div>
                        {answers.tiers.map((tier, index) => (
                          <div className="tier-card field-wide" key={index}>
                            <div className="tier-card-head">
                              <span>{t("app.tier")}{" "}{index + 1}</span>
                              {answers.tiers.length > 1 && (
                                <button
                                  type="button"
                                  aria-label={t("app.removeTierValueValue2", { value: index + 1, value2: tier.name.trim() ? `, ${tier.name.trim()}` : "" })}
                                  onClick={() => {
                                    // Only ask when there is something to lose.
                                    // A freshly added, still-empty tier should
                                    // close as easily as it opened.
                                    const filled =
                                      tier.price !== null ||
                                      tier.priceMax !== null ||
                                      tier.slots !== null ||
                                      tier.benefits.length > 0;
                                    if (
                                      filled &&
                                      !window.confirm(
                                        t("app.removeValueWhatYouFilledInFor", { value: tier.name.trim() || `tier ${index + 1}` }),
                                      )
                                    ) {
                                      return;
                                    }
                                    setAnswers((current) => ({
                                      ...current,
                                      tiers: current.tiers.filter(
                                        (_, i) => i !== index,
                                      ),
                                    }));
                                  }}
                                >
                                  {t("app.remove")}
                                </button>
                              )}
                            </div>
                            <div className="field-grid">
                              <label>
                                {t("app.nameThisLevel")}
                                <input
                                  data-field={`tierName${index}`}
                                  maxLength={40}
                                  value={tier.name}
                                  onChange={(event) =>
                                    updateTier(index, { name: event.target.value })
                                  }
                                  placeholder={t("app.gold")}
                                />
                              </label>
                              <label>
                                <OptionalFieldLabel>{t("app.spotsAtThisLevel")}</OptionalFieldLabel>
                                <small>{t("app.leaveBlankIfYouDontNeedA")}</small>
                                <input
                                  type="number"
                                  min={1}
                                  max={10000}
                                  data-field={`tierSlots${index}`}
                                  value={tier.slots ?? ""}
                                  onChange={(event) =>
                                    updateTier(index, {
                                      slots: event.target.value
                                        ? Number(event.target.value)
                                        : null,
                                    })
                                  }
                                  placeholder="3"
                                />
                              </label>
                              <label>
                                {t("app.whatOneSponsorPays")}
                                <input
                                  type="number"
                                  min={1}
                                  max={2000000000}
                                  data-field={`tierPrice${index}`}
                                  value={tier.price ?? ""}
                                  onChange={(event) =>
                                    updateTier(index, {
                                      price: event.target.value
                                        ? Number(event.target.value)
                                        : null,
                                    })
                                  }
                                  placeholder="1000"
                                />
                                {/* PRICE_CHIPS.sponsor_host has existed since
                                    this role shipped and was never rendered:
                                    the shared preset row is gated off for a
                                    host, because their price is per tier. So
                                    the hardest number in the flow was the only
                                    one offered no help. */}
                                <span className="offer-examples-label">
                                  {t("app.orTapACommonOne")}
                                </span>
                                <span className="offer-examples">
                                  {(PRICE_CHIPS.sponsor_host ?? []).map(
                                    (amount) => (
                                      <button
                                        type="button"
                                        key={amount}
                                        className={
                                          tier.price === amount ? "is-picked" : ""
                                        }
                                        onClick={() =>
                                          updateTier(index, { price: amount })
                                        }
                                      >
                                        ${amount.toLocaleString("en-US")}
                                      </button>
                                    ),
                                  )}
                                </span>
                              </label>
                              <label>
                                <OptionalFieldLabel>{t("app.upTo")}</OptionalFieldLabel>
                                <small>{t("app.leaveBlankForAFlatTier")}</small>
                                <input
                                  type="number"
                                  min={1}
                                  max={2000000000}
                                  data-field={`tierPriceMax${index}`}
                                  value={tier.priceMax ?? ""}
                                  onChange={(event) =>
                                    updateTier(index, {
                                      priceMax: event.target.value
                                        ? Number(event.target.value)
                                        : null,
                                    })
                                  }
                                  placeholder="2500"
                                />
                              </label>
                            </div>
                            {answers.benefits.length ? (
                              <ChipRow
                                field={`tierBenefits${index}`}
                                label={t("app.whatValueIncludes", { value: tier.name || "this level" })}
                                multi
                                options={answers.benefits}
                                selected={tier.benefits}
                                onPick={(value) =>
                                  updateTier(index, {
                                    benefits: tier.benefits.includes(value)
                                      ? tier.benefits.filter(
                                          (item) => item !== value,
                                        )
                                      : [...tier.benefits, value],
                                  })
                                }
                              />
                            ) : (
                              <p className="tier-empty">
                                {t("app.pickWhatASponsorCouldGetAbove")}
                              </p>
                            )}
                          </div>
                        ))}
                        {answers.tiers.length >= MAX_TIERS && (
                          // The button used to vanish here, so a host who
                          // wanted a fifth level just found the control gone.
                          <p className="chip-note field-wide">
                            {t("app.maxTiersLevelsIsTheMostA", { MAX_TIERS })}
                          </p>
                        )}
                        {answers.tiers.length < MAX_TIERS && (
                          <button
                            type="button"
                            className="tier-add field-wide"
                            onClick={() =>
                              setAnswers((current) => {
                                // Pick the first preset not already in use.
                                // Indexing by length handed back a duplicate as
                                // soon as anyone renamed or removed a tier, and
                                // the validator then rejected the row it had
                                // just created for them.
                                const taken = new Set(
                                  current.tiers.map((tier) =>
                                    tier.name.trim().toLowerCase(),
                                  ),
                                );
                                const next =
                                  TIER_PRESETS.find(
                                    (preset) => !taken.has(preset.toLowerCase()),
                                  ) ?? "";
                                return {
                                  ...current,
                                  tiers: [
                                    ...current.tiers,
                                    {
                                      ...emptyTier(next),
                                      // A new level starts from the whole menu
                                      // rather than empty: most hosts run one
                                      // tier, and making them re-tick the same
                                      // perks they just chose is pure
                                      // re-answering.
                                      benefits: [...current.benefits],
                                    },
                                  ],
                                };
                              })
                            }
                          >
                            {t("app.addAnotherTier")}
                          </button>
                        )}
                        <div className="field-grid">
                          <label className="field-wide media-upload-field">
                            <OptionalFieldLabel>{t("app.photos")}</OptionalFieldLabel>
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              multiple
                              onChange={(event) =>
                                chooseListingFiles(
                                  Array.from(event.target.files ?? []),
                                )
                              }
                            />
                            <small>
                              {t("app.aPhotoOfTheTeamTheRobot")}
                            </small>
                          </label>
                        </div>
                        </>
                        )}
                      </>
                    )}

                    {/* ---------------- shared: title, price, description ------- */}
                    {onboardingStep === 5 && (
                    <>
                    <div className="form-subsection field-wide">
                      <span>
                        {selectedRole === "business"
                          ? t("app.yourBrief")
                          : answers.creatorOffer === "physical"
                            ? t("app.yourPlacement")
                            : answers.creatorOffer === "sponsorship"
                              ? t("app.yourSponsorship")
                              : t("app.yourOffer")}
                      </span>
                      <h4>
                        {selectedRole === "business"
                          ? t("app.nameTheBriefAndSetTheBudget")
                          : answers.creatorOffer === "physical"
                            ? t("app.nameThePlacementAndSetTheRent")
                            : answers.creatorOffer === "sponsorship"
                              ? t("app.tellThemWhoTheydBeBacking")
                              : t("app.nameTheOfferAndSetYourRate")}
                      </h4>
                    </div>
                    <div className="field-grid">
                      {selectedRole !== "business" && (
                        <>
                          <ListingAvailabilityFields key={activeBookingOffer} listing={onboardingSchedule} onChange={(schedule) => updateOnboardingBooking({ schedule })} />
                          {onboardingSchedule.instant_booking_enabled && <>
                            <label className="field-wide">{t("app.exactlyWhatTheBuyerReceives")}
                              <small>{t("app.includeQuantitiesHowLongTheAdStays")}</small>
                              <textarea value={onboardingDeliverables} maxLength={1000} onChange={(event) => updateOnboardingBooking({ deliverables: event.target.value })} placeholder={t("app.oneInstagramReelLiveForAtLeast")} />
                            </label>
                            <label className="field-wide">{t("app.cancellationTerms")}
                              <input value={onboardingCancellation} maxLength={1000} onChange={(event) => updateOnboardingBooking({ cancellation: event.target.value })} placeholder={t("app.freeCancellationUntil48HoursBeforeThe")} />
                            </label>
                          </>}
                        </>
                      )}
                      {/* A sponsorship offer names each level in the tier editor,
                          and every tier composes its own headline from that name
                          plus what they are raising for. One shared title input
                          here would overwrite all three. */}
                      {!isSponsorshipOffer(selectedRole ?? "creator", answers) && (
                      <label className="field-wide">
                        {selectedRole === "business"
                          ? t("app.nameThisBrief")
                          : answers.creatorOffer === "physical"
                            ? t("app.nameThisPlacement")
                            : t("app.nameThisOffer")}
                        <input
                          data-field="title"
                          maxLength={120}
                          value={
                            titleTouched
                              ? answers.title
                              : composeTitle(selectedRole ?? "creator", answers)
                          }
                          onChange={(event) => {
                            setTitleTouched(true);
                            setAnswers((current) => ({
                              ...current,
                              title: event.target.value,
                              creatorOfferTouched: current.creatorOffer
                                ? {
                                    ...current.creatorOfferTouched,
                                    [current.creatorOffer]: {
                                      ...current.creatorOfferTouched[
                                        current.creatorOffer
                                      ],
                                      title: true,
                                    },
                                  }
                                : current.creatorOfferTouched,
                            }));
                          }}
                          placeholder={
                            selectedRole === "business"
                              ? t("app.breaCoffeeBarOurNewColdBrew")
                              : answers.creatorOffer === "physical"
                                ? t("app.mayasBarbershopWindowInDowntownBrea")
                                : t("app.instagramReelMayaAlvarez")
                          }
                        />
                      </label>
                      )}
                      {/* A business already gave a budget range above; asking
                          again here would duplicate both the question and the
                          data-field the validator scrolls to. */}
                      {selectedRole !== "business" &&
                        !isSponsorshipOffer(selectedRole ?? "creator", answers) && (
                      <label>
                        {answers.creatorOffer === "physical" ? t("app.priceFrom") : t("app.price")}
                        <input
                          type="number"
                          min={1}
                          // listings.price is an integer column; without this a
                          // budget of 3000000000 reaches Postgres as "integer
                          // out of range". Matches every other numeric input.
                          max={2000000000}
                          data-field="price"
                          value={answers.price ?? ""}
                          onChange={(event) =>
                            setAnswers((current) => ({
                              ...current,
                              price: event.target.value
                                ? Number(event.target.value)
                                : null,
                            }))
                          }
                          placeholder="150"
                        />
                      </label>
                      )}
                      {/* A week in December is not a week in February, and a
                          mural is not a poster. A space owner could only post
                          one number, so "$150-400 depending on how long" was
                          unsayable - the same band a business brief has had
                          since price_max landed. */}
                      {isPhysicalOffer(selectedRole ?? "creator", answers) && (
                        <label>
                          <OptionalFieldLabel>{t("app.upTo")}</OptionalFieldLabel>
                          <small>{t("app.leaveBlankForAFlatRate")}</small>
                          <input
                            type="number"
                            min={1}
                            max={2000000000}
                            data-field="priceMax"
                            value={answers.priceMax ?? ""}
                            onChange={(event) =>
                              setAnswers((current) => ({
                                ...current,
                                priceMax: event.target.value
                                  ? Number(event.target.value)
                                  : null,
                              }))
                            }
                            placeholder="400"
                          />
                        </label>
                      )}
                      {isSponsorshipOffer(selectedRole ?? "creator", answers) ? null : selectedRole ===
                        "business" ? (
                        <p className="offer-preview">{t("app.budgetIsPerCampaign")}</p>
                      ) : (
                        <label>
                          {t("app.per")}
                          <select
                            value={
                              answers.price_unit ||
                              (answers.creatorOffer === "physical" ? "week" : "post")
                            }
                            onChange={(event) =>
                              setAnswers((current) => ({
                                ...current,
                                price_unit: event.target.value,
                              }))
                            }
                          >
                            {(
                              PRICE_UNIT_CHIPS[selectedRole ?? "creator"] ?? [
                                "campaign",
                              ]
                            ).map((unit) => (
                              <option key={unit} value={unit}>
                                {unit}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </div>
                    {selectedRole !== "business" &&
                      !isSponsorshipOffer(selectedRole ?? "creator", answers) &&
                      Boolean(PRICE_CHIPS[selectedRole ?? ""]) && (
                      <ChipRow
                        field="price_presets"
                        label={t("app.orPickACommonRate")}
                        options={(selectedRole === "creator"
                          ? creatorPricePresets(answers.creatorOffer)
                          : PRICE_CHIPS[selectedRole ?? ""] ?? []
                        ).map(
                          (amount) => `$${amount}`,
                        )}
                        selected={answers.price ? [`$${answers.price}`] : []}
                        onPick={(value) =>
                          setAnswers((current) => ({
                            ...current,
                            price: Number(value.replace("$", "")),
                          }))
                        }
                      />
                    )}
                    <div className="field-grid">
                      <label className="field-wide">
                        {selectedRole === "business"
                          ? t("app.whatShouldWhoeverAnswersKnow")
                          : answers.creatorOffer === "physical"
                            ? t("app.whatIsThePlacementActuallyLike")
                            : answers.creatorOffer === "sponsorship"
                              ? t("app.whyShouldSomeoneSponsorYou")
                              : t("app.whatDoesABrandGetInYour")}
                        <small>
                          {selectedRole === "business"
                            ? t("app.weDraftedThisFromYourAnswersSay")
                            : answers.creatorOffer === "physical"
                              ? t("app.weDraftedThisFromYourAnswersAdd")
                              : answers.creatorOffer === "sponsorship"
                                ? t("app.weDraftedThisFromYourAnswersAdd3")
                                : t("app.weDraftedThisFromYourAnswersAdd2")}
                        </small>
                        <textarea
                          data-field="description"
                          value={
                            descriptionTouched
                              ? answers.description
                              : composeDescription(
                                  selectedRole ?? "creator",
                                  answers,
                                )
                          }
                          onChange={(event) => {
                            setDescriptionTouched(true);
                            setAnswers((current) => ({
                              ...current,
                              description: event.target.value,
                              creatorOfferTouched: current.creatorOffer
                                ? {
                                    ...current.creatorOfferTouched,
                                    [current.creatorOffer]: {
                                      ...current.creatorOfferTouched[
                                        current.creatorOffer
                                      ],
                                      description: true,
                                    },
                                  }
                                : current.creatorOfferTouched,
                            }));
                          }}
                        />
                        {/* The perk sentence is appended per tier at publish,
                            so it is deliberately not in the box. Saying so is
                            what stops a host from typing it themselves and
                            ending up with it on the card twice. */}
                        {isSponsorshipOffer(selectedRole ?? "creator", answers) && (
                          <span className="chip-note">
                            {t("app.eachTierCardEndsWithItsOwn")}
                            {completeTiers(answers)[0]?.name.trim()
                              ? t("app.nameSponsorsGet", { name: completeTiers(answers)[0].name.trim() })
                              : t("app.goldSponsorsGet")}
                            {t("app.youDontNeedToWriteItHere")}
                          </span>
                        )}
                      </label>
                    </div>

                    {/* What they are about to publish, rendered from the live
                        answers. A business sees the Wanted variant because it
                        passes the same isBrief check the real card does, so
                        the preview cannot drift from the marketplace. */}
                    <>
                    <OnboardingPreviewCards
                      role={selectedRole ?? "creator"}
                      answers={answers}
                      touched={{
                        title: titleTouched,
                        description: descriptionTouched,
                      }}
                      previewPhotoUrl={previewPhotoUrl}
                    />
                    <div className="onboarding-preview-legacy field-wide">
                      <span>
                        {isSponsorshipOffer(selectedRole ?? "creator", answers) &&
                        completeTiers(answers).length > 1
                          ? t("app.thisIsWhatPeopleWillSeeAnswerscount", { answersCount: completeTiers(answers).length })
                          : t("app.thisIsWhatPeopleWillSee")}
                      </span>
                      <div className="preview-card">
                        {/* A real card is a photo with text under it. Without
                            this the preview quietly implied the picture was a
                            detail, and a member could finish onboarding never
                            realising they had published a card with nothing on
                            the half of it people look at first. */}
                        {previewPhotoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            className="preview-card-photo"
                            src={previewPhotoUrl}
                            alt=""
                          />
                        ) : (
                          <p className="preview-card-photo is-empty">
                            {t("app.addAPhotoAboveItFillsThe")}
                          </p>
                        )}
                        <div className="preview-card-top">
                          <span
                            className={
                              selectedRole === "business"
                                ? "preview-chip is-brief"
                                : "preview-chip"
                            }
                          >
                            {selectedRole === "business"
                              ? t("market.wanted")
                              : buildListingDraft(selectedRole ?? "creator", answers, {
                                  title: titleTouched,
                                  description: descriptionTouched,
                                }).channel}
                          </span>
                          <small className="preview-offer">
                            {answers.display_name.trim() || t("app.yourName")}
                            {answers.city.trim() ? ` · ${answers.city.trim()}` : ""}
                          </small>
                        </div>
                        <div className="preview-card-body">
                          <strong>
                            {effectiveTitle(
                              selectedRole ?? "creator",
                              answers,
                              { title: titleTouched },
                              completeTiers(answers)[0],
                            ) || t("app.untitledListing")}
                          </strong>
                          <span className="preview-offer">
                            {(() => {
                              const draft = buildListingDraft(
                                selectedRole ?? "creator",
                                answers,
                                {
                                  title: titleTouched,
                                  description: descriptionTouched,
                                },
                                completeTiers(answers)[0],
                              );
                              const offer = draft.format.trim();
                              if (!offer) return "Add what people get above.";
                              return selectedRole === "business"
                                ? `Looking for ${offer}`
                                : `You get ${formatOffer(offer)}`;
                            })()}
                          </span>
                          {/* The description is the longest thing the member
                              writes and the preview never showed a word of it.
                              Clamped to two lines in CSS, exactly as the real
                              card's blurb is. */}
                          <p className="preview-card-blurb">
                            {descriptionBody(
                              selectedRole ?? "creator",
                              answers,
                              { description: descriptionTouched },
                            ) || t("app.yourDescriptionWillShowHere")}
                          </p>
                          <div className="preview-card-foot">
                            {selectedRole === "business" && (
                              <span className="preview-lead">{t("market.budget")}</span>
                            )}
                            <b
                              className={
                                (isSponsorshipOffer(selectedRole ?? "creator", answers)
                                  ? completeTiers(answers)[0]?.price
                                  : answers.price)
                                  ? undefined
                                  : "preview-price-empty"
                              }
                            >
                              {(() => {
                                // A sponsorship offer has no single price; the
                                // top tier is what this card shows.
                                const top = completeTiers(answers)[0];
                                const price =
                                  isSponsorshipOffer(selectedRole ?? "creator", answers)
                                    ? top?.price
                                    : answers.price;
                                // Not "$0". Before a price is entered the old
                                // preview showed "$0 / sponsor", which reads as
                                // an offer to work for free rather than as a
                                // field still to fill in.
                                if (!price) return "Add a price";
                                return priceLabel({
                                  price_cents: dollarsToCents(price),
                                  price_max_cents:
                                    isSponsorshipOffer(selectedRole ?? "creator", answers)
                                      ? top?.priceMax == null
                                        ? null
                                        : dollarsToCents(top.priceMax)
                                      : answers.priceMax == null
                                        ? null
                                        : dollarsToCents(answers.priceMax),
                                }, locale);
                              })()}
                            </b>
                            <small>
                              /{" "}
                              {
                                buildListingDraft(
                                  selectedRole ?? "creator",
                                  answers,
                                  {
                                    title: titleTouched,
                                    description: descriptionTouched,
                                  },
                                  completeTiers(answers)[0],
                                ).price_unit
                              }
                            </small>
                          </div>
                        </div>
                      </div>
                    </div>
                    </>

                    </>
                    )}

                  </>
                )}

                {/* Outside the setup/edit ternary on purpose. Secondary roles
                    drive the role badge and the marketplace filter, and if this
                    only rendered during setup an established member could never
                    add or drop one - the old flow offered it in both modes. */}
                {(onboardingMode === "edit" || onboardingStep === 5) && (
                <>
                <div className="form-subsection field-wide">
                  <span>{t("app.anythingElse")}</span>
                  <h4>{t("app.doYouDoMoreThanOneOf")}</h4>
                  <p>
                    {t("app.youllShowUpInEachOfThese")}
                  </p>
                </div>
                <ChipRow
                  field="extra_roles"
                  label={t("app.otherThingsYouDo")}
                  optional
                  multi
                  options={EXTRA_ROLE_OPTIONS.filter(
                    (role) => role !== selectedRole,
                  ).map((role) => roleCopy[role].label)}
                  selected={extraRoles.map((role) => roleCopy[role].label)}
                  onPick={(label) => {
                    const role = EXTRA_ROLE_OPTIONS.find(
                      (item) => roleCopy[item].label === label,
                    );
                    if (!role) return;
                    setExtraRoles((current) =>
                      current.includes(role)
                        ? current.filter((item) => item !== role)
                        : [...current, role],
                    );
                  }}
                />
                </>
                )}

                <div
                  className="onboarding-actions"
                  data-ready={
                    selectedRole === "business" &&
                    onboardingMode === "setup" &&
                    onboardingStep === 3 &&
                    answers.businessSetupPath !== "campaign"
                      ? "false"
                      : isCurrentOnboardingStepComplete()
                        ? "true"
                        : "false"
                  }
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        selectedRole === "business" &&
                        onboardingStep === 3 &&
                        answers.businessSetupPath === "campaign"
                      ) {
                        setAnswers((current) => ({
                          ...current,
                          businessSetupPath: "",
                        }));
                        return;
                      }
                      goToOnboardingStep(onboardingStep - 1);
                    }}
                  >
                    {t("app.back")}
                  </button>
                  {shouldShowOnboardingPrimaryAction() && (
                    <span className="onboarding-primary-action-enter">
                      <span
                        className="onboarding-required-status"
                        role="status"
                        aria-live="polite"
                      >
                        {missingAnswers().length
                          ? t("app.missinganswerscountRequiredValueLeft", { missingAnswersCount: missingAnswers().length, value: missingAnswers().length === 1
                                ? "detail"
                                : "details" })
                          : t("app.readyToContinue")}
                      </span>
                      {onboardingMode === "setup" &&
                      (onboardingStep < 5 || Boolean(nextSelectedCreatorOffer())) ? (
                        <button
                          type="button"
                          className="button button-dark"
                          onClick={advanceOnboarding}
                        >
                          {selectedRole === "creator"
                            ? nextSelectedCreatorOffer()
                              ? t("app.nextSection")
                              : t("app.next")
                            : onboardingStep === 3
                              ? t("app.nextTheDetails")
                              : t("app.nextReview")}{" "}
                          <span>→</span>
                        </button>
                      ) : (
                        <button
                          type="submit"
                          className="button button-coral"
                          // Also gated on the Instagram lookup: publishOnboarding
                          // snapshots `answers` before it awaits that promise, so a
                          // follower count the lookup fills in afterwards would be
                          // saved as 0 while the member reads "Found @you - 18.4K".
                          disabled={busy || igAvatarBusy}
                        >
                          {busy
                            ? t("app.publishing2")
                            : onboardingPreview
                              ? t("app.finishPreview")
                              : onboardingMode === "edit"
                                ? t("app.saveChanges")
                                : selectedRole === "business"
                                  ? t("app.postMyBrief")
                                  : t("app.publishAndFinish")}{" "}
                          <span>✓</span>
                        </button>
                      )}
                    </span>
                  )}
                </div>
              </div>
            )}
          </form>
          {profile && (
            <button
              className="signout-link"
              onClick={signOut}
            >
              {t("app.signOutOfThisAccount")}
            </button>
          )}
        </Modal>
      )}

      {listingOpen && (
        <Modal
          label={editingListing ? t("app.editListing") : t("app.createAListing")}
          onClose={() => {
            setListingOpen(false);
            resetAiHelpers();
            setEditingListing(null);
            setListingFeedback("");
          }}
          wide
        >
          <div className="modal-heading"><h2>{editingListing ? t("app.editListing") : editingListingIsBrief ? t("app.createACampaign") : t("app.createAListing")}</h2></div>
          {listingFeedback && (
            <div className="form-feedback" role="alert">
              <strong>{t("app.yourListingWasNotSavedYet")}</strong>
              <p>{listingFeedback}</p>
            </div>
          )}
          <form
            key={editingListing?.id ?? "new-listing"}
            className="field-grid listing-form listing-composer"
            onInvalidCapture={(event) => revealInvalidField(event.target)}
            onSubmit={saveListing}
          >
            {!editingListing && !editingListingIsBrief && <div className="composer-kind field-wide" role="group" aria-label={t("app.offerType")}>
              {CREATOR_OFFER_TYPES.map((option) => <button type="button" key={option.value} disabled={busy || aiFilling || listening} aria-pressed={newListingOffer === option.value}
                onClick={(event) => switchListingFormKind(option.value, event.currentTarget.form)}>{tx(option.label)}</button>)}
            </div>}
            <ListingComposerFields key={`${editingListing?.id ?? newListingOffer}-${composerRevision}`} listing={editingListing ?? newListingDrafts[newListingOffer]?.listing}
              kind={listingFormKind} city={profile?.city || answers.city} audience={profile?.audience_age}
              channels={LISTING_CHANNELS} surfaces={SURFACE_CHIPS} installers={INSTALL_CHIPS} platforms={BRIEF_PLATFORM_CHIPS}
              draftFiles={newListingDrafts[newListingOffer]?.files} onFilesChange={setPendingListingFiles} onInstantChange={setListingInstantEnabled}
              hasSavedPhotos={Boolean(editingListing && listingImages(editingListing).some((url) => !listingSeedImages.has(url)))}
              aiTools={!editingListingIsBrief ? (<div className="field-wide ai-fill">
                <p>{t("app.describeYourOfferPriceAndAudienceReview")}</p>
<div className="ai-fill-row">
                  <textarea
                    ref={aiNotesRef}
                    name="ai_notes"
                    defaultValue={newListingDrafts[newListingOffer]?.listing.ai_notes || ""}
                    rows={2}
                    maxLength={AI_NOTES_MAX}
                    placeholder={
                      listingFormKind === "physical"
                        ? t("app.frontWindowOnMainStreetAbout4")
                        : listingFormKind === "sponsorship"
                          ? t("app.highSchoolRoboticsTeam40MembersAbout")
                          : t("app.foodAndCoffeeAccount12kFollowersMostly")
                    }
                  />
                  <button
                    type="button"
                    className={`ai-fill-mic${listening ? " is-listening" : ""}`}
                    aria-pressed={listening}
                    aria-label={
                      listening
                        ? t("app.stopListeningAndDraftTheListing")
                        : t("app.describeTheSpaceOutLoudThenDraft")
                    }
                    disabled={busy || aiFilling}
                    onClick={() => {
                      if (listening) stopListening();
                      else void startListening();
                    }}
                  >
                    {listening ? t("app.stopFill") : t("app.speakFill")}{" "}
                    <span>{listening ? "■" : "🎤"}</span>
                  </button>
                </div>
                {listening && (
                  <small className="ai-fill-status" role="status">
                    {voiceMode === "recording"
                      ? t("app.recordingUpToAMinuteSayWhat")
                      : t("app.listeningSayWhatItIsWhereThe")}
                  </small>
                )}
                {aiObservations.length > 0 && (
                  <div className="ai-fill-questions is-observations" role="status">
                    <strong>{t("app.fromWhatItSawCheckTheseAre")}</strong>
                    <ul>
                      {aiObservations.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                    <small>
                      {t("app.anythingWrongHereIsWrongInThe")}
                    </small>
                  </div>
                )}
                {aiQuestions.length > 0 && (
                  <div className="ai-fill-questions" role="status">
                    <strong>{t("app.stillNeededItWillNotGuessThese")}</strong>
                    <ol>
                      {aiQuestions.map((question) => (
                        <li key={question}>{question}</li>
                      ))}
                    </ol>
                    <small>
                      {t("app.addTheAnswersInTheBoxAbove")}
                    </small>
                  </div>
                )}
                <button
                  type="button"
                  className="button button-dark"
                  disabled={busy || aiFilling}
                  onClick={(event) => fillListingWithAi(event.currentTarget.form)}
                >
                  {aiFilling ? t("app.drafting") : t("app.fillWithAi")} <span>✦</span>
                </button>
              </div>) : undefined}
              spaceTools={(<div className="street-view">
                  <button
                    type="button"
                    disabled={busy || streetViewLoading}
                    onClick={(event) => void importStreetView(event.currentTarget.form)}
                  >
                    {streetViewLoading
                      ? t("app.lookingUpStreetView")
                      : streetView
                        ? t("app.refreshTheStreetView")
                        : t("app.addAGoogleStreetViewOfThis")}
                  </button>
                  {streetView && (
                    <figure className="street-view-card">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={
                          streetView.url ??
                          (editingListing ? `/api/listings/${editingListing.id}/street-view` : "")
                        }
                        alt={t("app.googleStreetViewOfTheAddress")}
                      />
                      <figcaption>
                        {t("app.googleStreetView")}{streetView.captured ? `, ${streetView.captured}` : ""}{t("app.shownUnderYourPhotosLabelledFetchedLive")}
                        {streetView.pano && (
                          <a
                            href={streetPanoUrl(streetView.pano)}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {t("app.viewWholeStreet2")}
                          </a>
                        )}
                        <button type="button" onClick={clearStreetView}>
                          {t("app.remove")}
                        </button>
                      </figcaption>
                    </figure>
                  )}
                </div>)}
            />
            {editingListing &&
              listingImages(editingListing).some((url) => !listingSeedImages.has(url)) && (
                <div className="listing-photo-manager field-wide">
                  <strong>{t("app.photosOnThisListing")}</strong>
                  <p>
                    {t("app.theFirstIsTheCoverAddingPhotos")}
                  </p>
                  <div className="photo-manager-grid">
                    {listingImages(editingListing)
                      .filter((url) => !listingSeedImages.has(url))
                      .map((url, index) => (
                        <figure className="saved-media" key={url}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={url}
                            alt={t("app.listingPhotoValue", { value: index + 1 })}
                            loading="lazy"
                            decoding="async"
                          />
                          {index === 0 ? (
                            <figcaption>{t("app.cover")}</figcaption>
                          ) : (
                            <button
                              type="button"
                              className="saved-media-cover"
                              disabled={busy}
                              onClick={() => void makeListingCover(editingListing, url)}
                            >
                              {t("app.makeCover")}
                            </button>
                          )}
                          <button
                            type="button"
                            className="saved-media-remove"
                            disabled={busy}
                            aria-label={t("app.removePhotoValue", { value: index + 1 })}
                            title={t("app.removePhoto")}
                            onClick={() => void removeListingPhoto(editingListing, url)}
                          >
                            ×
                          </button>
                        </figure>
                      ))}
                  </div>
                </div>
              )}
            <label className="field-wide media-upload-field">
              {editingListing?.tour_url ? t("app.replaceTheWalkthrough") : t("app.addAWalkthroughOptional")}
              <input
                name="listing_tour"
                type="file"
                accept="video/mp4,video/webm,video/quicktime,image/jpeg,image/png,image/webp"
                onChange={(event) => void onTourPicked(event.currentTarget.files?.[0] ?? null)}
              />
              <small>
                {t("app.aShortVideoWalkingThroughTheSpace")}
              </small>
            </label>
            {tourPick && (
              <div className="tour-pick field-wide" role="status">
                <span>
                  {tourPick.kind === "video"
                    ? t("app.videoRoundSWidthHeight", { round: Math.round(tourPick.seconds), width: tourPick.width, height: tourPick.height })
                    : t("app.photoWidthHeight", { width: tourPick.width, height: tourPick.height })}
                  {` · ${(tourPick.file.size / 1024 / 1024).toFixed(1)} MB`}
                </span>
                <label className="chip-check">
                  <input
                    type="checkbox"
                    checked={tourSpherical}
                    onChange={(event) => setTourSpherical(event.currentTarget.checked)}
                  />
                  <span>{t("app.n360Spherical")}</span>
                </label>
                <small>
                  {tourSpherical
                    ? t("app.opensInThe360ViewerBuyersDrag")
                    : tourPick.kind === "photo"
                      ? t("app.tick360OnlyIfThisIsA")
                      : t("app.playsAsAPlainVideoTick360")}
                </small>
              </div>
            )}
            {editingListing?.tour_url && editingListing.tour_kind && !tourPick && (
              <div className="tour-current field-wide">
                <span>
                  {editingListing.tour_kind === "video"
                    ? t("app.walkthroughVideoAttached")
                    : editingListing.tour_kind === "video360"
                      ? t("app.n360VideoAttached")
                      : t("app.n360PhotoAttached")}
                </span>
                <a href={editingListing.tour_url} target="_blank" rel="noreferrer noopener">
                  {t("app.open")}
                </a>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void removeListingTour(editingListing)}
                >
                  {t("app.remove")}
                </button>
              </div>
            )}
            <div className="form-submit field-wide">
              <button
                type="button"
                onClick={() => {
                  setListingOpen(false);
                  resetAiHelpers();
                  setEditingListing(null);
                  setListingFeedback("");
                }}
              >
                {t("app.cancel")}
              </button>
              <button className="button button-coral" disabled={busy}>
                {busy
                  ? t("app.savingListing")
                  : editingListing
                    ? t("app.saveChanges")
                    : Object.entries(newListingDrafts).some(([kind, draft]) => kind !== newListingOffer && draft?.listing.title) ? t("app.publishAndContinue") : editingListingIsBrief ? t("app.publishCampaign") : t("app.publishListing")}{" "}
                <span>↗</span>
              </button>
            </div>
          </form>
        </Modal>
      )}

      {selectedListing && (
        <Modal
          label={detailCopy?.title ?? selectedListing.title}
          onClose={closeListing}
          wide
        >
          <div className={`detail-layout${detailHasMedia ? "" : " has-no-media"}`}>
            {detailHasMedia && (
            <div className="detail-media">
              {detailPhotos.length > 0 && (
              <figure>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={detailPhotos[selectedPhotoIndex] || detailPhotos[0]}
                  alt={t("app.valuePhotoValue2", { value: detailCopy?.title ?? selectedListing.title, value2: selectedPhotoIndex + 1 })}
                />
                <span className="listing-channel">
                  {isBrief(selectedListing)
                    ? t("market.wanted")
                    : localizeListingChannel(locale, selectedListing.channel)}
                </span>
              </figure>
              )}
              {detailPhotos.length > 1 && (
                <div className="detail-thumbnails" aria-label={t("app.listingPhotos")}>
                  {detailPhotos.map((url, index) => (
                    <button
                      key={`${url}-${index}`}
                      className={selectedPhotoIndex === index ? "active" : ""}
                      onClick={() => setSelectedPhotoIndex(index)}
                      aria-label={t("app.viewPhotoValue", { value: index + 1 })}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt="" loading="lazy" decoding="async" />
                    </button>
                  ))}
                </div>
              )}
              {selectedListing.street_view_captured && (
                <figure className="street-view-card detail-street-view">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/listings/${selectedListing.id}/street-view`}
                    alt={t("app.googleStreetViewOfTheAddress")}
                    loading="lazy"
                    decoding="async"
                  />
                  {/* The whole street, in 360: Google's panorama by id, in
                      the page when a browser key for the Maps Embed API is
                      set, else on Google Maps in a new tab. Either way the
                      imagery comes from Google as it is looked at. */}
                  {streetPanoOpen && STREET_VIEW_EMBED_KEY && selectedListing.street_view_pano && (
                    <iframe
                      className="street-view-embed"
                      title={t("app.googleStreetViewOfTheWholeStreet")}
                      src={`https://www.google.com/maps/embed/v1/streetview?key=${encodeURIComponent(STREET_VIEW_EMBED_KEY)}&pano=${encodeURIComponent(selectedListing.street_view_pano)}`}
                      allowFullScreen
                      loading="lazy"
                      referrerPolicy="no-referrer-when-downgrade"
                    />
                  )}
                  <figcaption>
                    {t("app.googleStreetViewStreetViewCapturedThe", { street_view_captured: selectedListing.street_view_captured })}
                    {selectedListing.street_view_pano &&
                      (STREET_VIEW_EMBED_KEY ? (
                        <button
                          type="button"
                          className="street-view-open"
                          onClick={() => setStreetPanoOpen((open) => !open)}
                        >
                          {streetPanoOpen ? t("app.closeTheStreetView") : t("app.viewWholeStreet")}
                        </button>
                      ) : (
                        <a
                          className="street-view-open"
                          href={streetPanoUrl(selectedListing.street_view_pano)}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {t("app.viewWholeStreet2")}
                        </a>
                      ))}
                  </figcaption>
                </figure>
              )}
              <ListingTour listing={selectedListing} />
            </div>
            )}
            <div className="detail-copy">
              <div className="owner-line">
                {/* The whole identity is the control, the way a marketplace
                    seller's name is: avatar, name and role all lead to the
                    same place, so nobody has to hunt for the small link. */}
                <button
                  type="button"
                  className="owner-line-link"
                  onClick={() => void openOwnerProfile(selectedListing.owner)}
                  aria-label={t("app.seeDisplayNameSProfileAndOther", { display_name: selectedListing.owner.display_name })}
                >
                  <Avatar profile={selectedListing.owner} />
                  <div>
                    <strong>
                      {selectedListing.owner.display_name}
                      {selectedListing.owner.verified && (
                        <span className="verified">✓</span>
                      )}
                    </strong>
                    <small>
                      {rolesLabel(selectedListing.owner, locale)} ·{" "}
                      {selectedListing.owner.city}
                    </small>
                  </div>
                </button>
                <span
                  className={`owner-trust-badge ${
                    selectedListing.owner.verified ? "verified-owner" : ""
                  }`}
                >
                  {selectedListing.owner.is_demo
                    ? t("app.demoProfile")
                    : selectedListing.owner.verified
                      ? t("app.verifiedBySidespace")
                      : t("app.unverifiedProfile")}
                </span>
              </div>
              {!isListingRequestable(selectedListing) && (
                <div className="listing-provenance-notice is-view-only">
                  <span>
                    {t("app.thisListingIsViewOnlyUntilIts")}
                  </span>
                </div>
              )}
              <SocialLinks profile={selectedListing.owner} />
              {(selectedCreatorReviews.length > 0 || selectedCreatorPortfolio.length > 0) && (
                <div className="detail-terms">
                  {selectedCreatorReviews.length > 0 && (
                    <div>
                      <small>{t("app.verifiedSidespaceReviews")}</small>
                      <p>
                        <strong>
                          {(
                            selectedCreatorReviews.reduce(
                              (sum, review) => sum + review.rating,
                              0,
                            ) / selectedCreatorReviews.length
                          ).toFixed(1)}
                          /5
                        </strong>{" "}{selectedCreatorReviews.length === 1
                          ? t("app.fromOneCompletedCampaign")
                          : t("app.fromCompletedCampaigns", { count: selectedCreatorReviews.length })}
                      </p>
                      <p>“{selectedCreatorReviews[0].review_text}”</p>
                    </div>
                  )}
                  {selectedCreatorPortfolio.length > 0 && (
                    <div>
                      <small>{t("app.creatorPortfolio")}</small>
                      {selectedCreatorPortfolio.map((item) => (
                        <p key={item.id}>
                          <strong>{item.title}</strong>
                          {item.description ? ` — ${item.description}` : ""}{" "}
                          {(item.project_url || item.media_url) && (
                            <a
                              href={item.project_url || item.media_url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {t("app.viewReplaceall", { replaceAll: item.kind.replaceAll("_", " ") })}
                            </a>
                          )}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="detail-title-row">
                <h2>{detailCopy?.title ?? selectedListing.title}</h2>
                <ListingLikeButton
                  placement="detail"
                  title={detailCopy?.title ?? selectedListing.title}
                  likeCount={selectedListing.like_count}
                  liked={likedListingIds.has(selectedListing.id)}
                  isAuthenticated={Boolean(user)}
                  canLike={
                    !selectedListing.owner.is_demo &&
                    profile?.id !== selectedListing.owner.id
                  }
                  disabledReason={
                    selectedListing.owner.is_demo
                      ? "Likes are unavailable on sample listings"
                      : profile?.id === selectedListing.owner.id
                        ? "You cannot like your own listing"
                        : undefined
                  }
                  disabled={
                    pendingLikeIds.has(selectedListing.id) ||
                    (Boolean(user) && likesLoading)
                  }
                  onToggle={() => void toggleListingLike(selectedListing)}
                />
              </div>
              <p className="listing-included">
                {detailCopy?.deliverables || detailCopy?.format}
              </p>
              <div className="detail-price"><strong>{priceLabel(selectedListing, locale, formatListingPrice)}</strong><span> / {localizeListingUnit(locale, pricingLabel(selectedListing))}</span></div>
              <div className="detail-facts">
                <div><small>{t("market.locationSort")}</small><strong>{listingCity(selectedListing)}</strong></div>
                <div><small>{t("app.timing")}</small><strong>{isBrief(selectedListing) ? selectedListing.available_from && selectedListing.available_to ? bookingDateLabel(selectedListing.timing_kind,selectedListing.available_from,selectedListing.available_to, t, locale) : t("app.flexible") : selectedListing.timing_kind === "deadline" ? t("app.chooseADeliveryDeadline") : t("app.chooseYourCampaignDates")}</strong></div>
                {!!selectedListing.lead_time_days && <div><small>{t("app.noticeNeeded")}</small><strong>{t("app.leadTimeDaysDays", { lead_time_days: selectedListing.lead_time_days })}</strong></div>}
                {selectedListing.timing_kind === "date_range" && selectedListing.pricing_kind !== "fixed" && <div><small>{t("app.minimumDuration")}</small><strong>{selectedListing.minimum_duration_days ?? 1} {(selectedListing.minimum_duration_days ?? 1) === 1 ? t("home.unitDay") : t("app.days")}</strong></div>}
              </div>
              <details className="composer-options"><summary>{t("app.detailsAndBookingTerms")}</summary>
                {detailCopy?.description && detailCopy.description !== detailCopy.deliverables && <p>{detailCopy.description}</p>}
                {selectedListing.space_size && <p><strong>{t("app.size")}{" "}</strong>{selectedListing.space_size}</p>}
                {!!selectedListing.surface_types?.length && <p><strong>{t("app.allowedFormats")}{" "}</strong>{selectedListing.surface_types.join(", ")}</p>}
                {selectedListing.install_by && <p><strong>{t("app.installation")}{" "}</strong>{tx(INSTALL_CHIPS.find((item) => item.value === selectedListing.install_by)?.label ?? "") || selectedListing.install_by}</p>}
                {selectedListing.sponsor_tier && <p><strong>{t("app.tier2")}{" "}</strong>{selectedListing.sponsor_tier}</p>}
                {selectedListing.sponsor_slots != null && <p><strong>{t("app.availableSpots")}{" "}</strong>{selectedListing.sponsor_slots}</p>}
                {isBrief(selectedListing) && !!selectedListing.target_platforms?.length && <p><strong>{t("app.targetPlatforms")}{" "}</strong>{selectedListing.target_platforms.join(", ")}</p>}
                {isBrief(selectedListing) && selectedListing.brief_scope && <p><strong>{t("app.placements")}{" "}</strong>{selectedListing.brief_scope === "both" ? t("app.physicalAndOnline") : selectedListing.brief_scope === "physical" ? t("app.physical") : t("app.online")}</p>}
                {detailCopy?.demographics && <p><strong>{t("app.audience")}{" "}</strong>{detailCopy.demographics}</p>}
                {detailCopy?.availability_notes && <p>{detailCopy.availability_notes}</p>}
                {(selectedListing.available_from || selectedListing.available_to) && <p>{t("app.availableAvailableFromAvailableTo", { available_from: displayDate(selectedListing.available_from, t, locale), available_to: displayDate(selectedListing.available_to, t, locale) })}</p>}
                {detailCopy?.minimum_booking && <p>{detailCopy.minimum_booking}</p>}
                <p><strong>{t("app.cancellation")}{" "}</strong>{detailCopy?.cancellation_policy || t("app.agreeWithTheOwnerBeforePayment")}</p>
              </details>
              {!viewingOwnListing && isListingRequestable(selectedListing) && !isBrief(selectedListing) && selectedListing.instant_booking_enabled && selectedListing.price_cents > 0 && (
                <InstantBookingPanel key={selectedListing.id} listing={selectedListing} busy={busy}
                  onCheckout={(start, end) => startInstantCheckout(selectedListing, start, end)} />
              )}
              {!viewingOwnListing && isListingRequestable(selectedListing) && !isBrief(selectedListing) && <div className="detail-primary-actions">
                {!selectedListing.instant_booking_enabled && isFixedPriceListing(selectedListing) && <button className="button button-coral" onClick={() => openCampaignFlow(selectedListing,"buy_now")}>{t("app.requestABooking")}</button>}
                <button className={`button ${!selectedListing.instant_booking_enabled && !isFixedPriceListing(selectedListing) ? "button-coral" : "button-ghost"}`} onClick={() => openCampaignFlow(selectedListing,"offer")}>{t("app.makeACustomOffer")}</button>
              </div>}
              {viewingOwnListing ? (
                <div className="detail-owner-actions">
                  <p>
                    {t("app.thisIsYourListing")}
                    {selectedListing.status === "active"
                      ? t("app.itIsLiveInTheMarketplace")
                      : t("app.itIsPausedSoNobodyCanSee")}
                  </p>
                  {renderListingFigures(selectedListing.id)}
                  <div className="detail-primary-actions">
                    <button
                      className="button button-coral"
                      onClick={() => {
                        // Both of these open another dialog, so this one closes
                        // first: the confirm and the editor render earlier in
                        // the tree and would otherwise be painted over by the
                        // listing page still sitting on top of them.
                        const listing = selectedListing;
                        closeListing();
                        openListingEdit(listing);
                      }}
                    >
                      {t("app.editListing")}
                    </button>
                    <button
                      className="button button-ghost"
                      disabled={busy}
                      onClick={() => void updateListingStatus(selectedListing)}
                    >
                      {selectedListing.status === "active"
                        ? t("app.pauseListing")
                        : t("app.makeItLiveAgain")}
                    </button>
                    <button
                      className="button button-ghost is-danger"
                      disabled={busy}
                      onClick={() => {
                        const listing = selectedListing;
                        closeListing();
                        setDeleteListingTarget(listing);
                      }}
                    >
                      {t("app.deleteListing")}
                    </button>
                  </div>
                </div>
              ) : (
              <div className="detail-primary-actions">
                {(!isListingRequestable(selectedListing) || isBrief(selectedListing)) && (
                  <button
                    className="button button-coral"
                    disabled={!isListingRequestable(selectedListing)}
                    onClick={() => openCampaignRequest(selectedListing)}
                  >
                    {isListingRequestable(selectedListing)
                      ? t("market.offerMySpace")
                      : t("market.viewOnlyButton")}{" "}
                    <span aria-hidden="true" className="ss-icon-arrow">
                      ↗
                    </span>
                  </button>
                )}
                <button
                  className="button button-ghost"
                  onClick={() => {
                    const listing = selectedListing;
                    closeListing();
                    openListingChat(listing);
                  }}
                >
                  {t("app.messageOwner")}{" "}
                  <span aria-hidden="true" className="ss-icon-arrow">
                    ↗
                  </span>
                </button>
              </div>
              )}
              <div className="detail-safety-actions">
                <button
                  onClick={() => {
                    // navigator.clipboard is undefined outside a secure
                    // context, so the unguarded call threw synchronously - and
                    // the toast claiming success ran before the write had
                    // resolved, so a denied permission still said "copied".
                    void (async () => {
                      const url = window.location.href;
                      try {
                        if (!navigator.clipboard) throw new Error("unavailable");
                        await navigator.clipboard.writeText(url);
                        setToast("Listing link copied.");
                      } catch {
                        setToast(
                          "Could not copy the link. Copy it from the address bar.",
                        );
                      }
                    })();
                  }}
                >
                  {t("app.shareListing")}
                </button>
                {selectedListing.owner.id !== profile?.id && (
                  <>
                    <button
                      onClick={() =>
                        requireAccount(() =>
                          setReportTarget({
                            profile: selectedListing.owner,
                            listing: selectedListing,
                          }),
                        )
                      }
                    >
                      {t("app.reportListing")}
                    </button>
                    <button
                      onClick={() =>
                        requireAccount(() => {
                          const owner = selectedListing.owner;
                          if (
                            window.confirm(
                              t("app.blockDisplayNameTheyWillNotBe", { display_name: owner.display_name }),
                            )
                          ) {
                            void blockProfile(owner);
                          }
                        })
                      }
                    >
                      {t("app.blockMember")}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {selectedOwner && (
        <Modal
          label={t("app.displayNameSProfile", { display_name: selectedOwner.display_name })}
          onClose={closeOwnerProfile}
          wide
        >
          <div className="seller-profile">
            <header className="seller-profile-head">
              <Avatar profile={selectedOwner} size="large" />
              <div>
                <h2>
                  {selectedOwner.display_name}
                  {selectedOwner.verified && <span className="verified">✓</span>}
                </h2>
                <p className="seller-profile-meta">
                          {rolesLabel(selectedOwner, locale)}
                  {selectedOwner.city ? ` · ${selectedOwner.city}` : ""}
                  {displayHandle(selectedOwner.handle ?? "")
                    ? ` · ${displayHandle(selectedOwner.handle ?? "")}`
                    : ""}
                </p>
                <span
                  className={`owner-trust-badge ${
                    selectedOwner.verified ? "verified-owner" : ""
                  }`}
                >
                  {selectedOwner.is_demo
                    ? t("app.demoProfile")
                    : selectedOwner.verified
                      ? t("app.verifiedBySidespace")
                      : t("app.unverifiedProfile")}
                </span>
              </div>
            </header>

            {selectedOwner.bio && <p className="seller-profile-bio">{selectedOwner.bio}</p>}
            <SocialLinks profile={selectedOwner} />

            {/* Same rule as the person card: a row of zeroes says less than
                no row at all, so it only appears when there is a number. */}
            {Boolean(
              selectedOwner.followers ||
                selectedOwner.avg_views ||
                selectedOwner.audience_age,
            ) && (
              <div className="person-stats seller-profile-stats">
                {Boolean(selectedOwner.followers || selectedOwner.avg_views) && (
                  <span>
                    <b>
                      {compactNumber(
                        selectedOwner.followers || selectedOwner.avg_views,
                      )}
                    </b>
                    {selectedOwner.followers
                      ? t("app.followers")
                      : ` ${selectedOwner.reach_unit || "weekly looks"}`}
                  </span>
                )}
                {Boolean(selectedOwner.audience_age) && (
                  <span>{selectedOwner.audience_age}</span>
                )}
              </div>
            )}

            <div className="seller-profile-listings">
              <div className="seller-profile-listings-head">
                <strong>
                  {ownerListingsLoading
                    ? t("app.everythingTheyHaveLive")
                    : ownerListings.length === 1
                      ? t("app.n1ListingLive")
                      : t("app.ownerlistingscountListingsLive", { ownerListingsCount: ownerListings.length })}
                </strong>
              </div>
              {ownerListingsLoading ? (
                <p className="seller-profile-empty">{t("app.loadingTheirListings")}</p>
              ) : ownerListings.length ? (
                <div className="seller-listing-grid">
                  {ownerListings.map((listing) => {
                    const copy = listing;
                    return (
                      <button
                        type="button"
                        className="seller-listing"
                        key={listing.id}
                        onClick={() => openListingFromProfile(listing)}
                        aria-current={
                          listing.id === selectedListing?.id ? "true" : undefined
                        }
                      >
                        <ListingCover listing={listing} />
                        <span className="seller-listing-body">
                          <span className="seller-listing-channel">
                            {isBrief(listing)
                              ? t("market.wanted")
                              : localizeListingChannel(locale, listing.channel)}
                          </span>
                          <strong>{copy.title}</strong>
                          <span className="seller-listing-price">
                            {priceLabel(listing, locale, formatListingPrice)} / {localizeListingUnit(locale, pricingLabel(listing))}
                          </span>
                          {listing.id === selectedListing?.id && (
                            <span className="seller-listing-current">
                              {t("app.theOneYouWereReading")}
                            </span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="seller-profile-empty">
                  {t("app.nothingLiveRightNow")}
                </p>
              )}
            </div>

            {profile?.id !== selectedOwner.id && (
              <button
                className="button button-dark"
                onClick={() =>
                  requireAccount(() => void startConversation(selectedOwner))
                }
              >
                {t("app.messageDisplayName", { display_name: selectedOwner.display_name })} <span>↗</span>
              </button>
            )}
          </div>
        </Modal>
      )}

      {campaignListing && (
        <Modal
          label={t("app.valueOnValue2", { value: campaignRequestMode === "buy_now" ? "Book as listed" : "Make an offer", value2: campaignListingCopy?.title ?? campaignListing.title })}
          onClose={() => {
            setCampaignListing(null);
            setCampaignRequestMode("offer");
          }}
          wide
        >
          <div className="modal-heading"><h2>{campaignRequestMode === "buy_now" ? t("app.requestABooking") : t("app.makeACustomOffer")}</h2><p>{campaignListingCopy?.title ?? campaignListing.title}</p></div>
          {campaignRequestMode === "buy_now" && <div className="booking-terms-summary"><strong>{t("app.whatsIncluded")}</strong><p>{campaignListingCopy?.deliverables || campaignListingCopy?.format}</p>
            <details><summary>{t("app.bookingAndCancellationTerms")}</summary><p>{campaignListingCopy?.cancellation_policy || t("app.agreeCancellationTermsWithTheOwnerBefore")}</p><p>{campaignListingCopy?.minimum_booking}</p></details>
          </div>}
          <form className="field-grid campaign-form" onSubmit={submitCampaignRequest} onInvalidCapture={(event) => revealInvalidField(event.target)}>
            <BookingFields listing={campaignListing} quoteRequired={campaignRequestMode === "buy_now"} />
            {campaignRequestMode !== "buy_now" && <>
              <label className="field-wide">{t("app.offerTotal")}<input name="budget" type="number" min="0" step="0.01" max="2000000000" required defaultValue={centsToInputDollars(campaignListing.price_cents)} /></label>
            <label className="field-wide">{isBrief(campaignListing) ? t("app.whatYoullDeliver") : t("app.whatYouNeed")}<textarea name="requested_deliverables" required minLength={2} maxLength={1000} defaultValue={campaignListingCopy?.deliverables || campaignListingCopy?.format} /></label>
            </>}
            <details className="composer-options field-wide"><summary>{t("app.campaignDetailsOptional")}</summary><div className="field-grid">
              <label className="field-wide">{t("app.campaignName")}<input name="campaign_name" maxLength={120} defaultValue={campaignListingCopy?.title ?? campaignListing.title} /></label>
              <label className="field-wide">{t("app.whatAreYouPromoting")}<textarea name="goals" maxLength={1500} /></label>
              <label className="field-wide">{t("app.notesOrQuestions")}<textarea name="notes" maxLength={2000} /></label>
            </div></details>
            {campaignFeedback && <p className="field-error field-wide" role="alert">{campaignFeedback}</p>}
            <small className="field-wide">{campaignRequestMode === "buy_now" ? t("app.theOwnerConfirmsBeforeYouPay") : t("app.nothingIsChargedWhenYouSendAn")}</small>
            <div className="form-submit field-wide">
              <button
                type="button"
                onClick={() => {
                  setCampaignListing(null);
                  setCampaignRequestMode("offer");
                }}
              >
                {t("app.cancel")}
              </button>
              <button className="button button-coral" disabled={busy}>
                {busy
                  ? campaignRequestMode === "buy_now"
                    ? t("app.sendingBooking")
                    : t("app.sendingOffer")
                  : campaignRequestMode === "buy_now"
                    ? t("app.sendBookingRequest")
                    : t("app.sendOffer")}{" "}
                <span>↗</span>
              </button>
            </div>
          </form>
        </Modal>
      )}

      {counteringRequest && (
        <Modal
          label={t("app.suggestDifferentTerms")}
          onClose={() => setCounteringRequest(null)}
        >
          <div className="modal-heading">
            <p className="eyebrow">{t("app.counteroffer")}</p>
            <h2>{t("app.suggestDifferentTerms2")}</h2>
            <p>{t("app.explainWhatYouCanDeliverAndWhat")}</p>
          </div>
          <form className="stack-form" onSubmit={submitCounteroffer}>
            <label>
              {t("app.counterBudget")}
              <input
                name="counter_budget"
                type="number"
                max="2000000000"
                min="0"
                required
                // The standing counteroffer when there is one: pre-filling
                // the requester's original number meant an owner revising
                // only the wording silently withdrew their own price.
                defaultValue={
                  centsToInputDollars(
                    counteringRequest.counter_budget_cents ??
                      counteringRequest.budget_cents,
                  )
                }
              />
            </label>
            <label>
              {t("app.counterofferDetails")}
              <textarea
                name="counter_message"
                required
                minLength={10}
                placeholder={t("app.explainTheRevisedTimingScopeOrDeliverables")}
              />
            </label>
            <button className="button button-coral button-full" disabled={busy}>
              {busy ? t("app.sending") : t("app.sendCounteroffer")} <span>↗</span>
            </button>
          </form>
        </Modal>
      )}

      {verificationOpen && profile && profile.role !== "consumer" && (
        <Modal
          label={t("app.submitVerificationEvidence")}
          onClose={() => setVerificationOpen(false)}
        >
          <div className="modal-heading">
            <p className="eyebrow">{t("app.sidespaceVerification")}</p>
            <h2>{t("app.submitEvidenceForReview")}</h2>
            <p>
              {t("app.aSocialLinkIsSelfReportedUntil")}
            </p>
          </div>
          <form className="stack-form" onSubmit={submitVerificationRequest}>
            <label>
              {t("app.publicBusinessOrPortfolioUrl")}
              <input
                name="evidence_url"
                type="url"
                required
                placeholder={t("app.httpsYourbusinessComAbout")}
              />
            </label>
            <label>
              {t("app.primarySocialPlatform")}
              <select name="social_platform" defaultValue="instagram">
                <option value="instagram">Instagram</option>
                <option value="tiktok">TikTok</option>
                <option value="youtube">YouTube</option>
                <option value="facebook">{t("app.facebook")}</option>
                <option value="x">{t("app.x")}</option>
                <option value="none">{t("app.noSocialAccount")}</option>
              </select>
            </label>
            <label>
              {t("app.socialHandleOrProfileUrl")}
              <input name="social_handle" placeholder={t("app.yourhandle")} />
            </label>
            <label>
              {t("app.whatShouldWeVerify")}
              <textarea
                name="verification_message"
                placeholder={t("app.tellUsHowTheWebsiteAndSocial")}
              />
            </label>
            <button className="button button-dark button-full" disabled={busy}>
              {busy ? t("app.submitting") : t("app.submitForManualReview")}{" "}
              <span>↗</span>
            </button>
          </form>
        </Modal>
      )}

      {reportTarget && (
        <Modal
          label={t("app.reportDisplayName", { display_name: reportTarget.profile.display_name })}
          onClose={() => setReportTarget(null)}
        >
          <div className="modal-heading">
            <p className="eyebrow">{t("app.safetyReport")}</p>
            <h2>{t("app.reportDisplayName", { display_name: reportTarget.profile.display_name })}</h2>
            <p>{t("app.reportsArePrivateAndReviewedByThe")}</p>
          </div>
          <form className="stack-form" onSubmit={submitProfileReport}>
            <label>
              {t("app.reason")}
              <select name="reason" defaultValue="misleading">
                <option value="misleading">{t("app.misleadingListingOrMetrics")}</option>
                <option value="spam">{t("app.spamOrUnwantedPromotion")}</option>
                <option value="unsafe">{t("app.unsafeOrProhibitedContent")}</option>
                <option value="impersonation">{t("app.impersonation")}</option>
                <option value="other">{t("app.other")}</option>
              </select>
            </label>
            <label>
              {t("app.details")}
              <textarea
                name="details"
                required
                minLength={10}
                placeholder={t("app.describeWhatHappenedAndWhatTheTeam")}
              />
            </label>
            <button className="button button-dark button-full" disabled={busy}>
              {busy ? t("app.submitting") : t("app.submitPrivateReport")}
            </button>
          </form>
        </Modal>
      )}

      {inboxOpen && (
        <div className="drawer-layer" onMouseDown={closeInbox}>
          <aside
            ref={inboxCardRef}
            className="inbox-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={t("chrome.messages")}
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <p className="eyebrow">{t("app.privateConversations")}</p>
                <h2>{t("chrome.messages")}</h2>
              </div>
              <button onClick={closeInbox} aria-label={t("app.closeMessages")}>
                ×
              </button>
            </header>
            <div className="inbox-layout">
              <div className={`thread-list ${activeContact ? "mobile-hide" : ""}`}>
                {inboxState !== "ready" ? (
                  <div className="inbox-empty">
                    <span>@</span>
                    <h3>
                      {inboxState === "loading"
                        ? t("app.loadingYourConversations")
                        : t("app.weCouldNotLoadYourConversations")}
                    </h3>
                    <p>
                      {inboxState === "loading"
                        ? t("app.oneMoment")
                        : t("app.checkYourConnectionAndReopenMessages")}
                    </p>
                  </div>
                ) : !visibleThreads.length ? (
                  <div className="inbox-empty">
                    <span>@</span>
                    <h3>{t("app.yourInboxIsReady")}</h3>
                    <p>{t("app.messageAListingOwnerToStartA")}</p>
                  </div>
                ) : (
                  visibleThreads.map((thread) => (
                    <button
                      key={thread.id}
                      className={activeThread?.id === thread.id ? "active" : ""}
                      onClick={() => void loadMessages(thread, thread.other)}
                    >
                      <Avatar profile={thread.other} size="small" />
                      <div>
                        <strong>{thread.other.display_name}</strong>
                        <small>{roleLabel(thread.other.role)}</small>
                      </div>
                      <span>›</span>
                    </button>
                  ))
                )}
              </div>
              <div className={`conversation ${!activeContact ? "mobile-hide" : ""}`}>
                {activeContact && activeThread ? (
                  <>
                    <div className="conversation-head">
                      <button
                        className="mobile-back"
                        aria-label={t("app.backToConversations")}
                        onClick={() => {
                          setActiveContact(null);
                          setActiveThread(null);
                        }}
                      >
                        ←
                      </button>
                      <Avatar profile={activeContact} size="small" />
                      <div>
                        <strong>{activeContact.display_name}</strong>
                        <small>
                          {roleLabel(activeContact.role)} · {activeContact.city}
                          {activeContact.is_demo && t("app.automatedDemoReplies")}
                        </small>
                      </div>
                    </div>
                    <div className="message-stream">
                      {!messages.length && (
                        <div className="message-start">
                          <Avatar profile={activeContact} />
                          <h3>{t("app.startWithSomethingSpecific")}</h3>
                          <p>
                            {t("app.mentionTheListingYourTimelineAndWhat")}
                          </p>
                        </div>
                      )}
                      {messages.map((message) => {
                        const mine =
                          message.sender_profile_id === profile?.id;
                        const sender = mine
                          ? "You"
                          : activeContact?.display_name ?? "Them";
                        return (
                        <div
                          key={message.id}
                          className={`message ${mine ? "mine" : ""}`}
                        >
                          {/* Position and bubble colour were the only
                              signal for who sent this, so a thread was
                              unreadable without sight. */}
                          <span className="sr-only">{sender}: </span>
                          <p>{message.body}</p>
                          <small>
                            {timeFormat(locale).format(new Date(message.created_at))}
                          </small>
                        </div>
                        );
                      })}
                    </div>
                    {/* Keyed on the thread: the textarea is uncontrolled, so
                        without this React reuses the same DOM node when you
                        switch conversations and an unsent draft follows you
                        into the wrong person's chat. */}
                    <form
                      key={activeThread.id}
                      className="message-form"
                      onSubmit={sendMessage}
                    >
                      <textarea
                        name="body"
                        required
                        placeholder={t("app.writeAMessage")}
                        rows={2}
                      />
                      <button>{t("app.send")}</button>
                    </form>
                  </>
                ) : (
                  <div className="conversation-placeholder">
                    <span>↗</span>
                    <h3>{t("app.chooseAConversation")}</h3>
                    <p>{t("app.yourPrivateMessagesWillAppearHere")}</p>
                  </div>
                )}
              </div>
            </div>
          </aside>
        </div>
      )}

      {/* Always mounted so screen readers announce changes; role=status is
          only honoured on a region that already exists in the DOM. */}
      <div className="toast-region" role="status" aria-live="polite" aria-atomic="true">
        {toast && (
          <div
            className={`toast ${toast.tone === "problem" ? "toast-problem" : ""}`}
          >
            <span aria-hidden="true">
              {toast.tone === "problem" ? "!" : "✓"}
            </span>
            {toast.text}
          </div>
        )}
      </div>
    </main>
  );
}
