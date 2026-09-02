"use client";

import dynamic from "next/dynamic";
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
  isBusinessReferralCode,
  normalizeBusinessReferralCode,
} from "@/lib/payments/ad-credits";
import {
  isListingRequestable,
  type ListingProvenanceStatus,
} from "@/lib/listings/provenance";
import type { ListingDraft } from "@/lib/listings/draft";
import {
  DashboardGate,
  LandingPage,
} from "@/app/components/PublicPages";
import {
  SiteFooter,
  SiteHeader,
  type SideSpaceRoute,
} from "@/app/components/SiteChrome";

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

type Listing = {
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
  created_at?: string;
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
  campaign_name: string;
  goals: string;
  requested_deliverables: string;
  budget_cents: number;
  start_date: string;
  end_date: string;
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
  goal: string;
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
const LISTING_FORM_HINTS: Record<
  ListingFormKind,
  {
    titleExample: string;
    titlePlaceholder: string;
    formatPlaceholder: string;
    formatExamples: string[];
    minimumPlaceholder: string;
    descriptionPlaceholder: string;
    deliverablesPlaceholder: string;
  }
> = {
  brief: {
    titleExample: "Window space for our spring opening",
    titlePlaceholder: "Looking for a storefront window in Brea",
    formatPlaceholder: "a storefront window on a busy street",
    formatExamples: [
      "a storefront window on a busy street",
      "three Instagram stories from a local creator",
      "a counter card in a cafe for 30 days",
    ],
    minimumPlaceholder: "One week, or one run",
    descriptionPlaceholder:
      "What you\u2019re promoting, what the artwork looks like, and the kind of place you want it seen.",
    deliverablesPlaceholder:
      "Photos of the placement, or a link to the post, once it\u2019s up.",
  },
  physical: {
    titleExample: "Cafe window, Main Street",
    titlePlaceholder: "Cafe window, Main Street",
    formatPlaceholder: "one letter-size poster in my front window for a week",
    formatExamples: [
      "one letter-size poster in my front window for a week",
      "one 18 by 24 inch poster, displayed for a week",
      "a card on the counter for 30 days",
    ],
    minimumPlaceholder: "1 week, or 3 days",
    descriptionPlaceholder:
      "A 4 by 6 foot front window facing the sidewalk on Main Street. A few hundred people walk past on a weekday, mostly locals on a lunch break.",
    deliverablesPlaceholder:
      "A photo of your poster in the window the day it goes up, and another at the end of the week.",
  },
  sponsorship: {
    titleExample: "Home-game banner, fall season",
    titlePlaceholder: "Home-game banner, fall season",
    formatPlaceholder: "your logo on the team banner for the full season",
    formatExamples: [
      "your logo on the team banner for the full season",
      "a named tier on our sponsor page and jerseys",
      "a shout-out at every home game",
    ],
    minimumPlaceholder: "One season, or one event",
    descriptionPlaceholder:
      "Who the team or event is, how many people turn up, and what a sponsor\u2019s money pays for.",
    deliverablesPlaceholder:
      "Photos of your logo on the banner or jerseys, and the sponsor-page link.",
  },
  social: {
    titleExample: "Three-story launch package",
    titlePlaceholder: "Three-story launch package",
    formatPlaceholder: "three Instagram stories over 48 hours",
    formatExamples: [
      "three Instagram stories over 48 hours",
      "one in-feed post",
      "a 30-second segment in my next video",
    ],
    minimumPlaceholder: "1 story, or one post",
    descriptionPlaceholder:
      "What a brand gets, your turnaround, who your audience is, and anything you won\u2019t do.",
    deliverablesPlaceholder:
      "Screenshots of the story or post with view counts after 24 hours, and a link.",
  },
};

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
const PRICE_UNIT_OPTIONS = [
  "campaign",
  "day",
  "week",
  "month",
  "post",
  "video",
  "story",
  "mention",
  "sponsor",
  "partner",
];

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
  /** Rounded to two decimals before it leaves the browser. */
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
  goal: string;
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
  return (
    <span className="field-label-line">
      {children}
      {" "}
      <span className="optional">optional</span>
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
        if (!cancelled) setCropError("That photo could not be read.");
      };
      image.src = dataUrl;
    };
    reader.onerror = () => {
      if (!cancelled) setCropError("That photo could not be read.");
    };
    reader.readAsDataURL(sourceFile);

    return () => {
      cancelled = true;
      reader.abort();
    };
  }, [sourceFile]);

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
      setCropError("Choose a JPG, PNG, or WebP image.");
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
        error instanceof Error ? error.message : "That photo could not be cropped.",
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
            aria-label="Crop profile photo. Drag the image to reposition it."
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
                alt="Profile photo crop preview"
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
              <span className="profile-photo-crop-loading">Loading photo…</span>
            )}
            <span className="profile-photo-crop-outline" aria-hidden="true" />
          </div>
          <div className="profile-photo-crop-controls">
            <label className="profile-photo-zoom">
              <span>Zoom</span>
              <input
                type="range"
                min="1"
                max="3"
                step="0.01"
                value={zoom}
                aria-label="Zoom profile photo"
                onChange={(event) => handleZoomChange(Number(event.target.value))}
              />
              <output>{Math.round(zoom * 100)}%</output>
            </label>
            <small>Drag the photo to choose what appears in the circle.</small>
          </div>
          <div className="profile-photo-crop-actions">
            <button type="button" onClick={cancelCrop}>
              Cancel
            </button>
            <button
              type="button"
              className="button button-dark"
              disabled={!imageLayout || cropping}
              onClick={() => void applyCrop()}
            >
              {cropping ? "Preparing…" : "Use this crop"}
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
              alt={value ? "Selected profile photo" : "Current profile photo"}
            />
          )}
          <small>
            {value
              ? "Your cropped photo is ready. Choose another photo to adjust it."
              : currentUrl
                ? "Your current photo is shown here. Choose another photo to replace it."
                : "Choose a photo, then drag it into place."}
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

function getBioRequirementHint(value: string) {
  const remaining = Math.max(0, 10 - value.trim().length);

  if (remaining === 0) {
    return "Minimum reached";
  }

  return `${remaining} more ${remaining === 1 ? "character" : "characters"} needed`;
}

function ChipRow({
  options,
  selected,
  onPick,
  multi = false,
  field,
  label,
  optional = false,
}: {
  options: string[];
  selected: string[];
  onPick: (value: string) => void;
  multi?: boolean;
  field: string;
  label: string;
  optional?: boolean;
}) {
  // The label used to live only in aria-label, so a sighted member met several
  // required chip rows as unheaded rows of pills - "pick what kind of business
  // you are" was never written down anywhere. Rendering it fixes the same gap
  // for everyone at once, and gives reportMissing something focusable.
  const labelId = `chip-label-${field}`;
  return (
    <>
      <span className="chip-label" id={labelId}>
        {label}
        {" "}
        {optional && <span className="optional">optional</span>}
      </span>
      <div
        className="filter-row onboarding-chips"
        data-field={field}
        role="group"
        aria-labelledby={labelId}
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
        label="Choose all that apply"
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
              <strong>Add your profiles</strong>
              <span>Add a handle or link for the ones you want shown.</span>
            </div>
            <small>{selectedPlatforms.length} selected</small>
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
                  <span aria-hidden="true">{platform.short}</span>
                  <strong>{platform.label}</strong>
                </div>
                <label
                  className="audience-handle-field"
                  htmlFor={`audience-${platform.key}`}
                >
                  <span className="sr-only">{platform.label} handle or link</span>
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
                      {igAvatarBusy ? "Checking…" : "Check"}
                    </button>
                  )}
                  {isPrimary ? (
                    <span className="audience-primary-badge">Primary</span>
                  ) : (
                    <button
                      type="button"
                      className="audience-primary-action"
                      disabled={!canBePrimary}
                      onClick={() => makePrimary(platform.key)}
                      title={
                        canBePrimary
                          ? `Use ${platform.label} as your primary channel`
                          : `Add your ${platform.label} profile first`
                      }
                    >
                      Make primary
                    </button>
                  )}
                </div>

                {platform.key === "instagram" && igAvatar && (
                  <span className="ig-avatar-preview audience-row-result">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={igAvatar} alt="Instagram profile preview" />
                    <small>
                      Profile found. Upload your own photo in step 1 to replace it.
                    </small>
                  </span>
                )}
                {platform.key === "instagram" && igStats && (
                  <small
                    className="ig-sync-note audience-row-result"
                    role="status"
                  >
                    {igStats.throttled
                      ? "Instagram is rate-limiting us. Add your audience size below and carry on."
                      : igStats.error
                        ? "We couldn’t read that profile. You can still add your audience size below."
                        : `Found @${igStats.username} — ${compactNumber(igStats.followers ?? 0)} followers.`}
                  </small>
                )}
              </div>
            );
          })}

          <label className="audience-size-field">
            <span>
              {primaryPlatform
                ? `${primaryPlatform.label} audience size`
                : "Audience size"}
              <small className="optional">Optional</small>
            </span>
            <small>An estimate is fine. This helps brands compare reach.</small>
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
              Your card will appear under <b>{creatorChannel(answers)}</b>.
              Only profiles with a handle or link are shown publicly.
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
    goal: "",
    placements: [],
    deliverables: "",
    artwork: "",
    timing: "",
    promoting: "",
    briefScope: "",
    priceMax: null,
    targetPlatforms: [],
    wantedArea: "",
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

/** Same file, whichever FileList it came out of. */
function sameFile(a: File, b: File) {
  return (
    a === b ||
    (a.name === b.name && a.size === b.size && a.lastModified === b.lastModified)
  );
}
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
async function photoToJpegBase64(file: File, maxEdge = 1280): Promise<string> {
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
    const goal = BUSINESS_GOAL_CHIPS.find((item) => item.label === answers.goal);
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
      goal?.sentence ?? "",
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
function tierProblems(answers: OnboardingAnswers): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < answers.tiers.length; i += 1) {
    const tier = answers.tiers[i];
    const label = `Tier ${i + 1}`;
    const named = tier.name.trim() || label.toLowerCase();
    if (!tier.name.trim()) {
      out.push([`Name ${label} — Gold, Founding Partner, anything.`, `tierName${i}`]);
    }
    if (!tier.price || tier.price < 1) {
      out.push([`Set what one ${named} sponsor pays.`, `tierPrice${i}`]);
    }
    // listings_price_max_valid rejects this at the database, where it surfaces
    // as a generic "something went wrong".
    if (
      typeof tier.priceMax === "number" &&
      typeof tier.price === "number" &&
      tier.priceMax < tier.price
    ) {
      out.push([
        `${named}'s upper price is below its lower one.`,
        `tierPriceMax${i}`,
      ]);
    }
    if (!tier.benefits.length) {
      out.push([
        `Pick what a ${named} sponsor actually gets.`,
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
    goal: "",
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
      ? (raw as Partial<BusinessPreferences>)
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
    goal: typeof source.goal === "string" ? source.goal : "",
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
    goal: answers.goal,
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
): CreatorRecommendation[] {
  const preferences = businessPreferencesForProfile(profile, ownListings);
  const targetPlatforms = preferences.targetPlatforms.map(lower);
  const wantedArea = lower(preferences.wantedArea || profile.city);
  const goalText = lower(preferences.goal);
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
        reasons.push("matches your target platform");
      }
      if (
        preferences.briefScope === "virtual" ||
        preferences.briefScope === "both"
      ) {
        score += 6;
        reasons.push("fits your virtual brief");
      }
      const categoryOverlap = recommendationCategoryOverlap(
        preferences.categories,
        listing,
      );
      if (categoryOverlap.length) {
        score += Math.min(30, categoryOverlap.length * 15);
        reasons.push("fits " + categoryOverlap.slice(0, 2).join(" and "));
      }
      const locationText = lower(listingCity(listing));
      if (wantedArea && locationText.includes(wantedArea)) {
        score += 18;
        reasons.push("near " + preferences.wantedArea);
      } else if (
        lower(listingCity(listing)).split(",")[0] ===
        lower(preferences.wantedArea || profile.city).split(",")[0]
      ) {
        score += 12;
        reasons.push("in your local market");
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
        reasons.push("supports your campaign goal");
      }
      if (
        preferences.timing &&
        lower(listing.availability_notes).includes(lower(preferences.timing))
      ) {
        score += 8;
        reasons.push("fits your timing");
      }
      if (listing.owner.verified) {
        score += 5;
        reasons.push("SideSpace verified");
      }
      if (!reasons.length) reasons.push("available in your marketplace");
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

// Toasts carry both good news and bad, and a green tick on "Add your city
// before continuing" reads as if it worked. Every message is authored in this
// file, so matching our own failure vocabulary is reliable; an unmatched
// message just keeps the old tick rather than claiming something false.
const PROBLEM_TOAST =
  /\b(could not|cannot|can't|failed|unable|must|before continuing|at least|invalid|not available|already|too (large|many|big|long|short)|expired|try again|sorry|no longer|denied|wrong|missing|did not|needs?|add your|enter a|pick a|choose a|keep it|limit|reached|not enough)\b/i;

function toastIsProblem(message: string) {
  return PROBLEM_TOAST.test(message);
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
function priceLabel(listing: Pick<Listing, "price_cents" | "price_max_cents">) {
  const low = listing.price_cents;
  const high = listing.price_max_cents;
  if (typeof high === "number" && high > low) {
    return `${formatCents(low)}–${formatCents(high)}`;
  }
  return formatCents(low);
}

function isBrief(listing: Pick<Listing, "channel">) {
  return listing.channel === "Business brief";
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
function listingGaps(
  listing: Pick<Listing, "title" | "format" | "description">,
) {
  const gaps: string[] = [];
  if (listing.title.trim().length < LISTING_READY_MIN.title) {
    gaps.push("a longer title");
  }
  if (listing.format.trim().length < LISTING_READY_MIN.format) {
    gaps.push("more detail in what the buyer gets");
  }
  if (listing.description.trim().length < LISTING_READY_MIN.description) {
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

function rolesLabel(profile: Pick<Profile, "role" | "extra_roles">) {
  return profileRoles(profile).map(roleLabel).join(" · ");
}

/** Characters as a person counts them, matching Postgres char_length. */
function charCount(value: string) {
  return Array.from(value).length;
}

/** Today in the viewer's own local day, as YYYY-MM-DD for date inputs. */
function todayIso() {
  return new Date().toLocaleDateString("en-CA");
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
const DATE_FORMAT = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const TIME_FORMAT = new Intl.DateTimeFormat("en", {
  hour: "numeric",
  minute: "2-digit",
});

/**
 * What a date chip is about to publish, said out loud.
 *
 * "Available now" writes a real 90-day window into available_from/available_to
 * and the listing page renders it as "Booking window: 27 Aug - 25 Nov" - a
 * commitment in specific dates that the owner picked a one-word chip for and
 * never saw. Showing the window here is the difference between a shortcut and
 * a guess published in their name.
 */
function windowNote(startDays: number | null, days: number) {
  if (startDays === null) {
    return "No dates go on your card — people will message you to ask.";
  }
  return `Your card will show ${displayDate(
    isoDaysFromToday(startDays),
  )} – ${displayDate(isoDaysFromToday(startDays + days))}. You can change the exact dates on your listing any time.`;
}

function displayDate(value?: string | null) {
  if (!value) return "Flexible";
  return DATE_FORMAT.format(new Date(`${value}T00:00:00Z`));
}

function displayDateTime(value?: string | null) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function safeProfiles(value: unknown): Profile[] {
  return Array.isArray(value) ? (value as Profile[]) : [];
}

function safeListings(value: unknown): Listing[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Omit<Listing, "owner"> & { owner: Profile | Profile[] }>)
    .map((listing) => ({
      ...listing,
      owner: Array.isArray(listing.owner) ? listing.owner[0] : listing.owner,
    }))
    // The owner embed is a left join, so a listing whose owner row is hidden by
    // RLS (or absent) arrives with owner null while the type asserts it is a
    // Profile. Every consumer then dereferences owner.display_name unguarded
    // and takes the whole grid down with it. Drop those rows here instead.
    .filter((listing): listing is Listing => Boolean(listing.owner));
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

function SocialLinks({ profile, compact = false }: { profile: Profile; compact?: boolean }) {
  const links = socialPlatforms
    .map((platform) => ({
      ...platform,
      url: profile.social_links?.[platform.key] ?? "",
    }))
    .filter((platform) => /^https?:\/\//i.test(platform.url));

  if (!links.length) return null;

  return (
    <nav className={`social-links ${compact ? "social-links-compact" : ""}`} aria-label={`${profile.display_name} social profiles`}>
      {links.map((platform) => (
        <a
          key={platform.key}
          href={platform.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`${profile.display_name} on ${platform.label}${
            profile.social_verification?.[platform.key] === "verified"
              ? ", connected and verified"
              : ", self-reported link"
          }`}
        >
          <b>{platform.short}</b>
          {!compact && <span>{platform.label}</span>}
          {profile.social_verification?.[platform.key] === "verified" && (
            <i title="Connected and verified">✓</i>
          )}
        </a>
      ))}
    </nav>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
        <button className="close-button" onClick={onClose} aria-label="Close">
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
}: {
  answers: OnboardingAnswers;
  onSelect: (offer: CreatorOfferType) => void;
}) {
  const offers = selectedCreatorOffers(answers);
  if (!offers.length) return null;
  return (
    <div className="creator-offer-workspace field-wide">
      <div className="creator-offer-workspace-heading">
        <div>
          <span>Selected offers</span>
          <strong>Fill in each one before you publish.</strong>
        </div>
        <small>
          {offers.length} listing{offers.length === 1 ? "" : "s"} planned
        </small>
      </div>
      <div
        className="creator-offer-tabs"
        role="tablist"
        aria-label="Choose which offer to edit"
      >
        {offers.map((offer) => {
          const active = answers.creatorOffer === offer;
          const ready = creatorOfferIsReady(answers, offer);
          return (
            <button
              key={offer}
              type="button"
              className={"creator-offer-tab" + (active ? " active" : "")}
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(offer)}
            >
              <span>{creatorOfferLabel(offer)}</span>
              <small>{ready ? "Ready" : "Needs details"}</small>
            </button>
          );
        })}
      </div>
      <p className="creator-offer-workspace-note">
        You are editing{" "}
        <b>{creatorOfferLabel(answers.creatorOffer || offers[0])}</b>. Each
        selected path gets its own listing, and you can come back to edit any
        of them later.
      </p>
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
              {option.label}
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
            : "This is what people will see"}
        </span>
        {isMulti && (
          <small>One card per selected offer or sponsorship tier.</small>
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
                  Add a photo above — it fills the top half of your card.
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
                  {role === "business" ? "Wanted" : draft.channel}
                </span>
                <small className="preview-offer">
                  {answers.display_name.trim() || "Your name"}
                  {answers.city.trim() ? " · " + answers.city.trim() : ""}
                </small>
              </div>
              <div className="preview-card-body">
                <strong>{draft.title || "Untitled listing"}</strong>
                <span className="preview-offer">
                  {draft.format.trim()
                    ? role === "business"
                      ? "Looking for " + draft.format.trim()
                      : "You get " + formatOffer(draft.format)
                    : "Add what people get above."}
                </span>
                <p className="preview-card-blurb">
                  {draft.description || "Your description will show here."}
                </p>
                <div className="preview-card-foot">
                  {role === "business" && (
                    <span className="preview-lead">Budget</span>
                  )}
                  <b className={hasPrice ? undefined : "preview-price-empty"}>
                    {hasPrice ? priceLabel(draft) : "Add a price"}
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

export default function MarketplaceApp({
  initialProfiles = null,
  initialListings = null,
  invite = null,
  route = "home",
  initialQuery = "",
  initialRoleFilter = "all",
  initialChannel = "All",
  referralCode = "",
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
  /** Public information architecture route. The marketplace/auth engine stays
   * mounted so every route keeps the same dialogs, sessions, and handlers. */
  route?: SideSpaceRoute;
  initialQuery?: string;
  initialRoleFilter?: RoleFilter;
  initialChannel?: string;
} = {}) {
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
  const [aiFilling, setAiFilling] = useState(false);
  const [aiQuestions, setAiQuestions] = useState<string[]>([]);
  /** What the model says it can see in the owner's photo, shown so a wrong "fact" is caught before it is published. */
  const [aiObservations, setAiObservations] = useState<string[]>([]);
  /** A Google Street View frame of the exact address: the file (also in the photo picker), its preview URL, and the capture date. */
  const [streetView, setStreetView] = useState<{ file: File; url: string; date: string } | null>(null);
  const [streetViewLoading, setStreetViewLoading] = useState(false);
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
  const [listingOpen, setListingOpen] = useState(false);
  const [listingFeedback, setListingFeedback] = useState("");
  const [formatPreview, setFormatPreview] = useState("");
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
    : listingRole === "business";
  const listingFormKind: ListingFormKind = editingListingIsBrief
    ? "brief"
    : editingListingIsPhysical
      ? "physical"
      : editingListingIsSponsorship
        ? "sponsorship"
        : "social";
  const listingHints = LISTING_FORM_HINTS[listingFormKind];

  /**
   * Take the photos a member just picked, and point the preview at the first.
   *
   * All four role panes call this instead of setListingFiles, so the URL is
   * minted in the event that produced the file and the one it replaces is
   * revoked in the same breath - no render-phase side effect, and no blob left
   * behind when somebody re-picks five times before they are happy.
   */
  function chooseListingFiles(files: File[]) {
    setListingFiles(files);
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
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(0);
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
  const [paymentTransactions, setPaymentTransactions] = useState<PaymentTransaction[]>([]);
  const [adCreditBalanceCents, setAdCreditBalanceCents] = useState(0);
  const [creatorPortfolio, setCreatorPortfolio] = useState<CreatorPortfolioItem[]>([]);
  const [creatorReviews, setCreatorReviews] = useState<CreatorReview[]>([]);
  const [selectedCreatorPortfolio, setSelectedCreatorPortfolio] =
    useState<CreatorPortfolioItem[]>([]);
  const [selectedCreatorReviews, setSelectedCreatorReviews] =
    useState<CreatorReview[]>([]);
  const [stripeAccountStatus, setStripeAccountStatus] =
    useState<StripeAccountStatus | null>(null);
  const [campaignListing, setCampaignListing] = useState<Listing | null>(null);
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
  const [roleFilter, setRoleFilter] = useState<RoleFilter>(initialRoleFilter);
  const [channelFilter, setChannelFilter] = useState(initialChannel);
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleOAuthEnabled, setGoogleOAuthEnabled] = useState(false);

  const loadMarketplace = useCallback(async () => {
    if (!supabase) return;

    // Public marketing routes only need enough real inventory to prove the
    // marketplace exists. The full browser remains intentionally denser.
    const profileLimit = route === "marketplace" ? 60 : 12;
    const listingLimit = route === "marketplace" ? 200 : 12;

    const [profilesResult, listingsResult] = await Promise.all([
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
    ]);

    if (!profilesResult.error) {
      const loaded = safeProfiles(profilesResult.data);
      setProfiles(loaded.length ? loaded : demoProfiles);
    }
    if (!listingsResult.error) {
      const loaded = safeListings(listingsResult.data);
      setListings(loaded.length ? loaded : demoListings);
    }
  }, [route, supabase]);

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
    [supabase],
  );

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
      setProfileChecked(true);
      if (own) {
        await Promise.all([
          loadOwnListings(own),
          loadAccountMarketplaceState(own),
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
      // This reload runs on every auth event, and Supabase fires those in the
      // background (token refresh, tab refocus). If the member is mid-way
      // through onboarding, resetting the step or the role picker here
      // unmounts the very fields they are typing into and throws their input
      // away - which is exactly what "it kicked me out while typing" was.
      // Only seed the picker and open the modal when it is not already open.
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
          setOnboardingOpen(true);
        }
      }
    },
    [loadAccountMarketplaceState, loadOwnListings, supabase],
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
        if (
          isDifferentUser ||
          event === "USER_UPDATED" ||
          event === "PASSWORD_RECOVERY"
        ) {
          window.setTimeout(() => void loadOwnProfile(currentUser), 0);
        }
        if (event === "PASSWORD_RECOVERY") {
          setAccountOpen(true);
          setToast("Choose a new password in Account settings.");
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
  }, [loadMarketplace, loadOwnProfile, route, supabase]);

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
  }, [toast]);

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

  /**
   * Markets that already exist, for the onboarding city field.
   *
   * Built from profiles already in memory - no API key, no geocoder, no
   * per-load cost - and it converges members on the exact strings the
   * marketplace filters already match, instead of a free-text field producing
   * "Brea", "Brea CA" and "brea, california" for one town.
   */
  const knownMarkets = useMemo(
    () =>
      Array.from(
        new Set(profiles.map((person) => person.city.trim()).filter(Boolean)),
      ).sort(),
    [profiles],
  );

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
        listing.title,
        listing.channel,
        listing.description,
        listing.demographics,
        listing.format,
        listing.location_area ?? "",
        listing.owner.display_name,
        listing.owner.city,
        (listing.owner.categories ?? []).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return roleMatches && channelMatches && (!normalized || text.includes(normalized));
    })
      // Members first, samples last; within each band the order is mixed
      // rather than newest-first so one fresh post cannot dominate the top.
      .sort(
        (a, b) =>
          listingRank(a) - listingRank(b) ||
          shuffleKey(a.id) - shuffleKey(b.id),
      );
  }, [activeChannel, blocksPending, blockedProfileIds, listings, query, roleFilter]);
  const requestableListingCount = useMemo(
    () => visibleListings.filter((listing) => isListingRequestable(listing)).length,
    [visibleListings],
  );

  const creatorRecommendations = useMemo(
    () =>
      profile?.role === "business" && !blocksPending
        ? creatorPostRecommendations(
            listings,
            profile,
            ownListings,
            blockedProfileIds,
          )
        : [],
    [blocksPending, blockedProfileIds, listings, ownListings, profile],
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
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
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
    return () => {
      window.clearTimeout(failsafe);
      observer.disconnect();
    };
  }, [listings, user, profile]);

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
  }, [user]);

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
  }, []);

  // Lightweight public pages hand account actions to the dedicated dashboard
  // instead of shipping this entire marketplace engine in their first bundle.
  // Consume the one-shot intent here, then remove it so refresh/back never
  // reopens a dialog the visitor already dismissed.
  useEffect(() => {
    if (route !== "dashboard" || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const requestedMode = url.searchParams.get("auth");
    if (requestedMode !== "signin" && requestedMode !== "signup") return;
    url.searchParams.delete("auth");
    window.history.replaceState({}, "", url.toString());
    const timer = window.setTimeout(() => {
      setAuthMode(requestedMode);
      setAuthOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [route]);

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
  }, [loadAccountMarketplaceState, profile, route]);

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
        const { data } = await supabase
          .from("listings")
          // A deep link, so anyone with the URL gets this row - narrowed for
          // the same reason as the grid.
          .select(
            `${PUBLIC_LISTING_COLUMNS}, owner:profiles!listings_owner_profile_id_fkey(${PUBLIC_PROFILE_COLUMNS})`,
          )
          .eq("id", listingId)
          .eq("status", "active")
          .maybeSingle();
        if (cancelled) return;
        const [resolved] = safeListings(data ? [data] : []);
        if (resolved && !blockedProfileIds.includes(resolved.owner.id)) {
          setSelectedPhotoIndex(0);
          setSelectedListing(resolved);
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
    selectedListing,
    sessionResolved,
    supabase,
    user,
  ]);

  function captureCurrentLocation() {
    if (!navigator.geolocation) {
      setLocationError(
        "This browser cannot share a location. Type your city and state instead.",
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
        setLocationBusy(false);
        if (!location) {
          setLocationError(
            "We could not read a usable location. Type your city and state instead.",
          );
          return;
        }
        setAnswers((current) => ({ ...current, location }));
      },
      (error) => {
        setLocationBusy(false);
        setLocationError(
          error.code === 1
            ? "Location permission was not granted. Type your city and state instead."
            : error.code === 2
              ? "We could not find your location. Type your city and state instead."
              : "Finding your location took too long. Type your city and state instead.",
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

  function updateCreatorOfferSelection(
    offer: CreatorOfferType,
    remove = false,
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
      remove && answers.creatorOffer === offer
        ? nextOffers[0] ?? ""
        : answers.creatorOffer || offer;
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
    if (!selectedCreatorOffers(answers).includes(offer)) return;
    updateCreatorOfferSelection(offer);
  }

  async function saveBusinessPreferences(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (!supabase || !profile) {
      setToast("Sign in to save campaign preferences.");
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
    setOnboardingOpen(true);
  }

  /** Open the modal as the profile editor rather than first-run setup. */
  function openProfileEditor(step: 1 | 2 = 1) {
    seedRolePickers(profile);
    setOnboardingPreview(false);
    setOnboardingMode("edit");
    setOnboardingStep(step);
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
    setAuthOpen(false);
    setOnboardingOpen(true);
  }

  function requireAccount(action: () => void) {
    if (localPreviewAvailable) {
      openOnboardingPreview();
      return;
    }
    if (!configured) {
      setToast("Connect Supabase to enable public accounts and messaging.");
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

  function openListing(listing: Listing) {
    setSelectedPhotoIndex(0);
    setSelectedCreatorPortfolio([]);
    setSelectedCreatorReviews([]);
    setSelectedListing(listing);
    const url = new URL(window.location.href);
    url.searchParams.set("listing", listing.id);
    window.history.replaceState(null, "", url);
  }

  function closeListing() {
    setSelectedListing(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("listing");
    window.history.replaceState(null, "", url);
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
      answers.bio.trim().length < 10,
      "Add one line about you — at least a few words.",
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
            ...tierProblems(view).map(
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
      // Same order the questions are rendered in, so the error scrolls forward
      // through the pane rather than jumping back past something answered.
      need(
        !answers.promoting.trim(),
        "Say what you're promoting — a few words is enough.",
        "promoting",
      );
      need(!answers.goal, "Pick what the campaign should do.", "goal");
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
        "promoting",
        "categories",
        "goal",
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
    return allMissingAnswers().filter(
      ([, field]) => onboardingStepForField(field) === onboardingStep,
    );
  }

  function isCurrentOnboardingStepComplete() {
    const identityStepVisible =
      onboardingMode === "edit" || onboardingStep === 2;
    return missingAnswers().length === 0 &&
      (!identityStepVisible || !avatarCropPending);
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
      target.scrollIntoView({ block: "center", behavior: "auto" });
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      ) {
        target.focus();
      }
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
    setOnboardingError(message);
  }

  function advanceOnboarding() {
    if (avatarCropPending) {
      setOnboardingError("Finish positioning your photo, or cancel the crop, before continuing.");
      return;
    }
    const problem = firstMissingAnswer();
    if (problem) {
      reportMissing(problem);
      return;
    }
    goToOnboardingStep(onboardingStep + 1);
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
   * Finish onboarding: write the profile, and in setup mode publish the first
   * listing too.
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
  async function publishOnboarding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (avatarCropPending) {
      setOnboardingError("Finish positioning your photo, or cancel the crop, before saving.");
      return;
    }

    const problem = allMissingAnswers()[0] ?? null;
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
    let adCreditAwarded = false;
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
            adCreditAwarded = Number(result?.awarded_cents ?? 0) > 0;
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
            adCreditAwarded = Number(result?.awarded_cents ?? 0) > 0;
          }
        } catch (error) {
          adCreditSyncFailed = true;
          console.error("Could not redeem Business onboarding ad credit", error);
        }
      }

      if (onboardingMode === "setup") {
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
        const cover =
          listingUploads[0] ||
          payload.avatar_url ||
          payload.gallery_urls[0] ||
          DEFAULT_LISTING_IMAGE;
        // Captured before the map: narrowing on the outer binding does not
        // survive into a closure, and this is the only reference inside one.
        const ownerId = savedProfile.id;
        const inserted = await supabase
          .from("listings")
          .insert(
            drafts.map((draft) => ({
              ...draft,
              owner_profile_id: ownerId,
              image_url: cover,
              image_urls: listingUploads.length ? listingUploads : [cover],
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
              ? `Your brief is live. ${formatCents(BUSINESS_SIGNUP_CREDIT_CENTS)} in ad credit is ready for your first campaign.`
              : adCreditSyncFailed
                ? "Your brief is live. We could not confirm the intro ad credit yet — refresh your dashboard and try again."
                : "Your brief is live. We’ll tell you the moment someone answers."
              : canonicalRole(role) === "creator" && drafts.length > 1
                ? "You’re live. " + drafts.length + " listings are on the marketplace."
              : `You’re live. “${drafts[0].title}” is on the marketplace.`,
        );
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
          ? `${formatCents(BUSINESS_SIGNUP_CREDIT_CENTS)} in ad credit is ready for your first campaign.`
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
          `Your profile is saved, but the listing didn’t post.${why ? ` ${why}` : ""} Nothing you typed is lost — open it again from your dashboard.`,
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
          friendlyDbError(error) || "Could not save your profile.",
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
    if (draft.price_dollars !== null) setValue("price", String(draft.price_dollars));
    setValue("price_unit", draft.price_unit);
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
        );
      } else if (code === "no-speech") {
        setToast(
          "Didn't hear anything. Check that the mic isn't muted, tap Speak, and start talking straight away.",
        );
      } else if (code === "audio-capture") {
        setToast("No microphone was found on this device. Type a few words instead.");
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
      setToast("Voice input isn't available in this browser. Type a few words instead.");
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
      setToast("Recording isn't available in this browser. Type a few words instead.");
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
    if (streetView) URL.revokeObjectURL(streetView.url);
    setStreetView(null);
  }

  /**
   * Put a file into the photo picker without losing what is already there.
   * A file input's list is read-only, but a DataTransfer builds a new one.
   */
  function addFileToPicker(form: HTMLFormElement, file: File) {
    const input = form.elements.namedItem("listing_photos");
    if (!(input instanceof HTMLInputElement)) return;
    const transfer = new DataTransfer();
    Array.from(input.files ?? []).forEach((item) => {
      if (!sameFile(item, file)) transfer.items.add(item);
    });
    transfer.items.add(file);
    input.files = transfer.files;
  }

  function removeFileFromPicker(form: HTMLFormElement, file: File) {
    const input = form.elements.namedItem("listing_photos");
    if (!(input instanceof HTMLInputElement)) return;
    const transfer = new DataTransfer();
    Array.from(input.files ?? []).forEach((item) => {
      if (!sameFile(item, file)) transfer.items.add(item);
    });
    input.files = transfer.files;
  }

  function clearStreetView(form: HTMLFormElement | null) {
    if (streetView) {
      URL.revokeObjectURL(streetView.url);
      if (form) removeFileFromPicker(form, streetView.file);
    }
    setStreetView(null);
  }

  /**
   * Fetch a Google Street View frame of the exact address and add it to the
   * photos. Outdoor imagery only, so a storefront or a wall on a street
   * usually works and a dorm corridor gets a polite no. The owner can drop
   * it again; Street View can be years old.
   */
  async function importStreetView(form: HTMLFormElement | null) {
    if (!form || streetViewLoading) return;
    const addressField = form.elements.namedItem("street_address");
    const address =
      addressField instanceof HTMLInputElement ? addressField.value.trim() : "";
    if (address.length < 5) {
      setToast("Type the exact street address first, then try Street View again.");
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
      const date = response.headers.get("x-street-view-date") ?? "";
      const file = new File([blob], "street-view.jpg", {
        type: "image/jpeg",
        lastModified: Date.now(),
      });
      if (streetView) {
        URL.revokeObjectURL(streetView.url);
        removeFileFromPicker(form, streetView.file);
      }
      addFileToPicker(form, file);
      setStreetView({ file, url: URL.createObjectURL(file), date });
      setToast("Street View added to your photos. Remove it if it does not show your spot.");
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
    // The owner's own photo leads. The Street View frame travels separately,
    // labelled for what it is, so the model never mistakes it for the space.
    const picked = photos instanceof HTMLInputElement ? Array.from(photos.files ?? []) : [];
    const file =
      picked.find((item) => item.size > 0 && !(streetView && sameFile(item, streetView.file))) ??
      null;
    if (!file && !notes && !audio && !streetView) {
      setToast("Add a photo or a few words first, then press Fill with AI.");
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
    try {
      const image = file ? await photoToJpegBase64(file) : null;
      const streetImage = streetView ? await blobToBase64(streetView.file) : null;
      const response = await fetch("/api/listings/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notes,
          image,
          street_image: streetImage,
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
      setAiQuestions(payload.draft.questions ?? []);
      setAiObservations(payload.draft.photo_observations ?? []);
      const asked = payload.draft.questions?.length ?? 0;
      setToast(
        asked
          ? `Filled what you told me. ${asked} quick question${asked === 1 ? "" : "s"} below - answer them and fill again.`
          : file
            ? "Drafted. Read it over and change anything before you publish."
            : "Drafted from your words. Add a photo and fill again for a better draft, or edit this one.",
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

  async function saveListing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    if (!profile) {
      // The session ended while they were typing. The form is uncontrolled and
      // still mounted, so everything they wrote is intact - say so and offer
      // the way back, rather than letting Publish do nothing forever.
      setListingFeedback(
        "Your session ended. Sign in again, then press Publish — everything you typed is still here.",
      );
      setAuthMode("signin");
      setAuthOpen(true);
      return;
    }
    const values = new FormData(event.currentTarget);
    const listingFiles = values
      .getAll("listing_photos")
      .filter((value): value is File => value instanceof File && value.size > 0);
    const fallbackImage =
      editingListing?.image_url ||
      profile.gallery_urls?.[0] ||
      profile.avatar_url ||
      DEFAULT_LISTING_IMAGE;
    setListingFeedback("");
    setBusy(true);
    try {
      const fields = {
        title: String(values.get("title") ?? "").trim(),
        channel: String(values.get("channel") ?? "").trim(),
        format: String(values.get("format") ?? "").trim(),
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
          ["description", "a description"],
        ] as Array<[keyof typeof fields, string]>
      ).find(([key]) => !String(fields[key] ?? "").trim());
      if (missing) {
        throw new Error(`Add ${missing[1]} before publishing.`);
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
        throw new Error("The top of the range is below the bottom.");
      }
      if (
        fields.available_from &&
        fields.available_to &&
        fields.available_to < fields.available_from
      ) {
        throw new Error("Availability must end on or after it starts.");
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
              image_urls: [fallbackImage],
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
      if (listingFiles.length) {
        try {
          const uploadedImages = await uploadImages(listingFiles, "listings");
          const placeholderImages = new Set(
            [
              "/photos/market-creator.jpg",
              profile.avatar_url,
              ...(profile.gallery_urls ?? []),
            ].filter(Boolean),
          );
          const existingImages = editingListing
            ? listingImages(savedListing).filter(
                (url) => !placeholderImages.has(url),
              )
            : [];
          const imageUrls = [...uploadedImages, ...existingImages].slice(0, 6);
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

      const wasEditing = Boolean(editingListing);
      setListingOpen(false);
      resetAiHelpers();
      setEditingListing(null);
      setAccountOpen(true);
      setToast(
        wasEditing
          ? `Your listing changes are saved.${photoWarning}`
          : `Your listing is live and saved to My listings.${photoWarning}`,
      );
      await Promise.all([loadMarketplace(), loadOwnListings(profile)]);
    } catch (error) {
      const message =
        friendlyDbError(error) || "Could not save your listing. Please try again.";
      setListingFeedback(message);
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

  function openCampaignRequest(listing: Listing) {
    if (!isListingRequestable(listing)) {
      setToast(
        listing.owner.is_demo
          ? "This is a clearly labeled example, not inventory you can request."
          : "This listing is view-only until its owner confirms the source and availability.",
      );
      return;
    }
    requireAccount(() => {
      if (listing.owner.id === profile?.id) {
        setToast("This is your listing. Manage incoming requests from your account.");
        return;
      }
      closeListing();
      setCampaignListing(listing);
    });
  }

  async function submitCampaignRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !campaignListing) return;
    if (!profile) {
      // Session ended mid-brief; the form still holds everything they wrote.
      setToast(
        "Your session ended. Sign in again, then send the request — your brief is still here.",
      );
      setAuthMode("signin");
      setAuthOpen(true);
      return;
    }
    const form = event.currentTarget;
    const values = new FormData(form);
    const startDate = String(values.get("start_date") ?? "");
    const endDate = String(values.get("end_date") ?? "");
    if (!startDate || !endDate) {
      setToast("Choose the dates your campaign should run.");
      return;
    }
    if (endDate < startDate) {
      setToast("Choose an end date on or after the start date.");
      return;
    }
    // A window that has already elapsed cannot be run. The common way in is a
    // mistyped year on the native date picker, which otherwise commits both
    // sides to negotiating a campaign that can never happen.
    if (endDate < todayIso()) {
      setToast(
        "That campaign window has already ended. Pick dates that run today or later.",
      );
      return;
    }

    setBusy(true);
    // Validate against the database's own bounds BEFORE creating anything.
    // This used to open the conversation first, so a brief the database then
    // rejected left a permanent empty thread in the owner's inbox and showed
    // the member a raw constraint error.
    const campaignName = String(values.get("campaign_name") ?? "").trim();
    const budget = Number(values.get("budget") ?? 0);
    const goals = String(values.get("goals") ?? "").trim();
    const deliverables = String(
      values.get("requested_deliverables") ?? "",
    ).trim();
    const notes = String(values.get("notes") ?? "").trim();

    // Count the way Postgres does. JS .length counts UTF-16 code units, so five
    // emoji read as 10 and slipped past a minimum the database then rejected -
    // after the conversation had already been created.
    if (charCount(campaignName) < 2 || charCount(campaignName) > 120) {
      setBusy(false);
      return setToast("Give the campaign a name between 2 and 120 characters.");
    }
    if (charCount(goals) < 10 || charCount(goals) > 1500) {
      setBusy(false);
      return setToast(
        "Describe your goal in at least 10 characters (1500 max).",
      );
    }
    if (charCount(deliverables) < 2 || charCount(deliverables) > 1000) {
      setBusy(false);
      return setToast("Say what you are asking for (2 to 1000 characters).");
    }
    if (charCount(notes) > 2000) {
      setBusy(false);
      return setToast("Notes are limited to 2000 characters.");
    }
    if (!Number.isFinite(budget) || budget < 0) {
      setBusy(false);
      return setToast("Enter a budget of 0 or more.");
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
        campaign_name: campaignName,
        goals,
        requested_deliverables: deliverables,
        budget_cents: dollarsToCents(budget),
        start_date: startDate,
        end_date: endDate,
        notes,
        status: "pending",
      })
      .select()
      .single();

    if (inserted.error) {
      setBusy(false);
      setToast(friendlyDbError(inserted.error));
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
            "Request sent, but we could not attach it to the message thread.",
          );
        }
      }
      await supabase.from("messages").insert({
        conversation_id: conversation.id,
        sender_profile_id: profile.id,
        body: `Campaign request: ${campaignName}\n${displayDate(startDate)} to ${displayDate(endDate)} · Budget $${budget}\nRequested: ${deliverables}`,
      });
    }

    setCampaignListing(null);
    setBusy(false);
    setToast(
      campaignListing.owner.is_demo
        ? "Demo request saved. This sample profile is not a real recipient."
        : "Campaign request sent. You can track it from your account.",
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
        ? "Campaign accepted. Payment is required before the work is confirmed."
        : status === "declined"
          ? "Campaign request declined."
          : "Campaign request cancelled.",
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
      `${target.display_name} is now hidden. You can undo this in Account settings.`,
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
    setToast(`${name} is visible again.`);
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
      setToast("The two passwords do not match.");
      return;
    }
    if (!currentPassword) {
      setToast("Enter your current password to confirm the change.");
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
      setToast("That current password is not right.");
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
      setToast("Enter your email address first, then choose Forgot password.");
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
    setToast(`A secure reset link was sent to ${address}.`);
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

  /** Public storage URLs look like .../object/public/marketplace-media/<path>. */
  function storagePathFromUrl(url: string) {
    const marker = "/marketplace-media/";
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
      setDeleteAccountError("Type DELETE exactly to confirm.");
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
        error instanceof Error
          ? error.message
          : "Could not delete your account. Please try again.",
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
        );
        return;
      }
      setListingFeedback("");
      setFormatPreview("");
      setEditingListing(null);
      setNewListingOffer("social");
      setListingOpen(true);
    });
  }

  function openListingEdit(listing: Listing) {
    setListingFeedback("");
    setFormatPreview(listing.format ?? "");
    setEditingListing(listing);
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
        ["pending", "countered"].includes(request.status),
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
        `${incoming} campaign request${incoming === 1 ? "" : "s"} waiting on you`,
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
    if (parts.length) return `You have ${parts.join(" and ")}.`;
    if (profile.role !== "consumer" && !ownListings.length) {
      return "Nothing is listed yet. Add your first space or audience to start getting requests.";
    }
    return "Nothing needs your attention right now.";
  }

  // The old root-page marketing sections remain in this file temporarily as
  // refactor reference, but never mount. Keeping the functional marketplace
  // branch live while route QA is underway avoids mixing a broad deletion
  // into the auth/listing preservation work.
  const legacyPublicSections = false;

  return (
    <main>
      <a className="ss-skip-link" href="#main-content">
        Skip to main content
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
        onJoin={() => {
          setAuthMode("signup");
          setAuthOpen(true);
        }}
        onAccount={openAccountPanel}
      />

      {route === "dashboard" && (loading || (user && !profile && !profileChecked) ? (
        <section className="dashboard" aria-label="Loading your dashboard">
          <div className="dashboard-head">
            <div>
              <p className="eyebrow">Your dashboard</p>
              <h1 className="dashboard-title">
                Setting things <em>up...</em>
              </h1>
              <p className="dashboard-sub">One moment while we load your account.</p>
            </div>
          </div>
        </section>
      ) : user && profile ? (
        <section className="dashboard" aria-label="Your SideSpace dashboard">
          <div className="dashboard-head">
            <div>
              <p className="eyebrow">{rolesLabel(profile)} · {profile.city || "Add your city"}</p>
              <h1 className="dashboard-title">
                {greeting()},{" "}
                <em>{profile.display_name.split(" ")[0] || "there"}.</em>
              </h1>
              <p className="dashboard-sub">{dashboardStatus()}</p>
            </div>
            <div className="dashboard-actions">
              {profile.role !== "consumer" && (
                <button className="button button-dark" onClick={openListingEditor}>
                  New listing <span>＋</span>
                </button>
              )}
              <button className="button button-ghost" onClick={openInbox}>
                Messages
                {unreadCount > 0 ? ` (${unreadCount})` : ""} <span>→</span>
              </button>
              <button
                className="button button-ghost"
                onClick={openAccountPanel}
              >
                Account <span>↗</span>
              </button>
            </div>
          </div>

          <div className="dashboard-paths" data-reveal>
            <a
              className="dashboard-path"
              href="/marketplace?role=business"
            >
              <span>I&rsquo;m a creator or host</span>
              <strong>Find business briefs</strong>
              <p>See local campaigns that need your audience or space.</p>
              <b>Browse briefs →</b>
            </a>
            <a
              className="dashboard-path"
              href="/marketplace?role=supply"
            >
              <span>I&rsquo;m a business</span>
              <strong>Book local reach</strong>
              <p>Choose a creator or physical space, then send a request.</p>
              <b>Browse creators and spaces →</b>
            </a>
          </div>

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
                  ["pending", "countered"].includes(request.status),
              ).length;
              const outgoing = campaignRequests.filter(
                (request) =>
                  request.requester_profile_id === profile.id &&
                  (request.status === "pending" ||
                    request.status === "countered"),
              ).length;
              const cards = [
                {
                  label: "Live listings",
                  value: active,
                  caption: paused
                    ? `${paused} paused`
                    : "Visible in the marketplace",
                  icon: "▤",
                  tone: active ? "" : "muted",
                },
                {
                  label: "Requests to you",
                  value: incoming,
                  caption: incoming ? "Waiting on your reply" : "Nothing pending",
                  icon: "✉",
                  tone: incoming ? "alert" : "muted",
                },
                {
                  label: "Requests you sent",
                  value: outgoing,
                  caption: outgoing ? "Awaiting a reply" : "None open",
                  icon: "↗",
                  tone: "muted",
                },
                {
                  label: "Unread messages",
                  value: unreadCount,
                  caption: unreadCount ? "In your inbox" : "All caught up",
                  icon: "◍",
                  tone: unreadCount ? "alert" : "muted",
                },
              ];
              return cards.map((card) => (
                <div className="dashboard-stat" data-reveal key={card.label}>
                  <div className="dashboard-stat-top">
                    <small>{card.label}</small>
                    <span className={`dashboard-stat-icon ${card.tone}`}>
                      {card.icon}
                    </span>
                  </div>
                  <strong>{card.value}</strong>
                  <span className="dashboard-stat-caption">{card.caption}</span>
                </div>
              ));
            })()}
          </div>

          {profile.role === "business" && (
            <section className="dashboard-panel ad-credit-panel" id="ad-credit" data-reveal>
              <div>
                <p className="eyebrow">Advertising credit</p>
                <h2>
                  {adCreditBalanceCents > 0
                    ? `${formatCents(adCreditBalanceCents)} ready for your next campaign.`
                    : "Your advertising credit balance is $0."}
                </h2>
                <p>
                  Applied automatically at secure checkout. Promotional credit cannot be
                  withdrawn or transferred.
                </p>
              </div>
              <a className="button button-ghost button-small" href="/marketplace?role=supply">
                Find creators and spaces <span>↗</span>
              </a>
            </section>
          )}

          <div className="dashboard-workspace">
            <section
              className="dashboard-panel dashboard-inventory-panel"
              id="dashboard-listings"
              data-reveal
            >
              <header className="dashboard-panel-heading">
                <div>
                  <p className="eyebrow">Your inventory</p>
                  <h2>What people can book.</h2>
                  <p>Keep your live offers clear, current, and easy to reach.</p>
                </div>
                {profile.role !== "consumer" && (
                  <button
                    className="button button-dark button-small"
                    onClick={openListingEditor}
                  >
                    New listing <span>＋</span>
                  </button>
                )}
              </header>
              {ownListingsLoading ? (
                <div className="dashboard-panel-empty">Loading your listings…</div>
              ) : ownListings.length ? (
                <div className="dashboard-listing-list">
                  {ownListings.slice(0, 4).map((listing) => (
                    <article className="dashboard-listing-row" key={listing.id}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={listing.image_url || DEFAULT_LISTING_IMAGE}
                        alt=""
                        loading="lazy"
                      />
                      <div className="dashboard-listing-copy">
                        <div>
                          <span
                            className={
                              "listing-status status-" + listing.status
                            }
                          >
                            {listing.status}
                          </span>
                          <small>{listing.channel}</small>
                        </div>
                        <strong>{listing.title}</strong>
                        <p>
                          {priceLabel(listing)} / {listing.price_unit}
                        </p>
                      </div>
                      <div className="dashboard-row-actions">
                        <button onClick={() => openListing(listing)}>View</button>
                        <button onClick={() => openListingEdit(listing)}>Edit</button>
                      </div>
                    </article>
                  ))}
                  {ownListings.length > 4 && (
                    <button
                      className="dashboard-text-action"
                      onClick={openAccountPanel}
                    >
                      View all {ownListings.length} listings →
                    </button>
                  )}
                </div>
              ) : (
                <div className="dashboard-panel-empty">
                  <strong>Your first listing belongs here.</strong>
                  <p>Put your audience, space, or campaign brief in front of the marketplace.</p>
                  {profile.role !== "consumer" && (
                    <button
                      className="button button-coral button-small"
                      onClick={openListingEditor}
                    >
                      Create a listing <span>↗</span>
                    </button>
                  )}
                </div>
              )}
            </section>

            <section
              className="dashboard-panel dashboard-campaigns-panel"
              id="dashboard-campaigns"
              data-reveal
            >
              {(() => {
                const activeRequests = campaignRequests
                  .filter((request) =>
                    ["pending", "countered", "accepted", "confirmed"].includes(
                      request.status,
                    ),
                  )
                  .slice(0, 4);
                return (
                  <>
                    <header className="dashboard-panel-heading">
                      <div>
                        <p className="eyebrow">Campaigns</p>
                        <h2>Work in motion.</h2>
                        <p>Requests, replies, and next actions in one place.</p>
                      </div>
                      <button
                        className="dashboard-text-action"
                        onClick={openAccountPanel}
                      >
                        View all →
                      </button>
                    </header>
                    {activeRequests.length ? (
                      <div className="dashboard-request-list">
                        {activeRequests.map((request) => {
                          const incoming =
                            request.owner_profile_id === profile.id;
                          const other = incoming
                            ? request.requester
                            : request.owner;
                          return (
                            <article
                              className="dashboard-request-row"
                              key={request.id}
                            >
                              <span className="dashboard-request-avatar">
                                {initials(other.display_name)}
                              </span>
                              <div className="dashboard-request-copy">
                                <div>
                                  <small>
                                    {incoming ? "Incoming" : "You sent"} ·{" "}
                                    {request.status}
                                  </small>
                                  <b>{formatCents(request.budget_cents)}</b>
                                </div>
                                <strong>{request.campaign_name}</strong>
                                <p>
                                  {request.listing?.title ?? "Listing"} ·{" "}
                                  {other.display_name}
                                </p>
                              </div>
                              <div className="dashboard-row-actions">
                                {incoming && request.status === "pending" && (
                                  <button
                                    className="dashboard-row-primary"
                                    disabled={busy}
                                    onClick={() =>
                                      void respondToCampaignRequest(
                                        request,
                                        "accepted",
                                      )
                                    }
                                  >
                                    Accept
                                  </button>
                                )}
                                {incoming &&
                                  ["pending", "countered"].includes(
                                    request.status,
                                  ) && (
                                    <button
                                      onClick={() => setCounteringRequest(request)}
                                    >
                                      Counter
                                    </button>
                                  )}
                                {!incoming && request.status === "countered" && (
                                  <button
                                    className="dashboard-row-primary"
                                    disabled={busy}
                                    onClick={() =>
                                      void respondToCampaignRequest(
                                        request,
                                        "accepted",
                                      )
                                    }
                                  >
                                    Accept counter
                                  </button>
                                )}
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="dashboard-panel-empty">
                        <strong>No active campaigns yet.</strong>
                        <p>
                          Browse the marketplace, or publish an offer so the
                          right partner can find you.
                        </p>
                        <a
                          className="button button-ghost button-small"
                          href="/marketplace"
                        >
                          Browse marketplace <span>↗</span>
                        </a>
                      </div>
                    )}
                  </>
                );
              })()}
            </section>
          </div>

          {profile.role === "business" && (
            <section
              className="dashboard-panel dashboard-recommendations-panel"
              id="creator-recommendations"
              data-reveal
            >
              <header className="dashboard-panel-heading">
                <div>
                  <p className="eyebrow">Recommended for your campaign</p>
                  <h2>Creator posts that fit your brief.</h2>
                  <p>
                    Ranked from your category, goal, platform, timing, and
                    location preferences.
                  </p>
                </div>
                <button
                  className="button button-ghost button-small"
                  onClick={openAccountPanel}
                >
                  Edit preferences <span>⚙</span>
                </button>
              </header>
              {creatorRecommendations.length ? (
                <div className="dashboard-recommendation-grid">
                  {creatorRecommendations.map((recommendation) => (
                    <article
                      className="dashboard-recommendation-card"
                      key={recommendation.listing.id}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={
                          recommendation.listing.image_url ||
                          DEFAULT_LISTING_IMAGE
                        }
                        alt=""
                        loading="lazy"
                      />
                      <div className="dashboard-recommendation-body">
                        <div className="dashboard-recommendation-meta">
                          <span>{recommendation.listing.channel}</span>
                          <small>
                            {recommendation.listing.owner.display_name} ·{" "}
                            {listingCity(recommendation.listing)}
                          </small>
                        </div>
                        <strong>{recommendation.listing.title}</strong>
                        <p>{recommendation.listing.description}</p>
                        <small className="dashboard-recommendation-reason">
                          {recommendation.reasons.slice(0, 2).join(" · ")}
                        </small>
                        <div className="dashboard-recommendation-actions">
                          <button
                            onClick={() =>
                              openCampaignRequest(recommendation.listing)
                            }
                          >
                            Request <span>↗</span>
                          </button>
                          <button
                            className="dashboard-text-action"
                            onClick={() => openListing(recommendation.listing)}
                          >
                            View details
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="dashboard-panel-empty">
                  <strong>We’re still building your shortlist.</strong>
                  <p>
                    Add a target platform or category in preferences, then
                    refresh the marketplace as new creators join.
                  </p>
                </div>
              )}
            </section>
          )}

          <ol className="dashboard-checklist" data-reveal>
            <li className={profile.onboarding_complete ? "done" : ""}>
              <span>{profile.onboarding_complete ? "✓" : "1"}</span>
              <div>
                <strong>Complete your profile</strong>
                <p>Role, city, and a short introduction.</p>
              </div>
              {!profile.onboarding_complete && (
                <button
                  className="button button-coral button-small"
                  onClick={() => {
                    setOnboardingMode("setup");
                    setOnboardingStep(1);
                    setOnboardingOpen(true);
                  }}
                >
                  Finish setup
                </button>
              )}
            </li>
            <li className={profile.avatar_url ? "done" : ""}>
              <span>{profile.avatar_url ? "✓" : "2"}</span>
              <div>
                <strong>Add a profile photo</strong>
                <p>Profiles with a face or logo get far more replies.</p>
              </div>
              {!profile.avatar_url && (
                <button
                  className="button button-ghost button-small"
                  onClick={() => openProfileEditor(1)}
                >
                  Add photo
                </button>
              )}
            </li>
            {profile.role !== "consumer" ? (
              <li className={ownListings.length ? "done" : ""}>
                <span>{ownListings.length ? "✓" : "3"}</span>
                <div>
                  <strong>Publish your first listing</strong>
                  <p>
                    {onboardingDraft
                      ? "Everything you typed is still here."
                      : "Your space or audience cannot be booked until it is listed."}
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
                    {onboardingDraft ? "Finish my listing" : "Create listing"}
                  </button>
                )}
              </li>
            ) : (
              <li>
                <span>3</span>
                <div>
                  <strong>Find your first placement</strong>
                  <p>Browse creators and spaces, then message the owner directly.</p>
                </div>
                <a className="button button-ghost button-small" href="/marketplace">
                  Browse
                </a>
              </li>
            )}
          </ol>
        </section>
      ) : (
        <DashboardGate
          onSignIn={() => {
            setAuthMode("signin");
            setAuthOpen(true);
          }}
          onJoin={() => {
            setAuthMode("signup");
            setAuthOpen(true);
          }}
        />
      ))}

      {route === "home" && (
        <LandingPage
          listings={heroListings}
          onJoin={() => {
            setAuthMode("signup");
            setAuthOpen(true);
          }}
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
        <section className="stat-band" aria-label="Marketplace at a glance">
          <div className="stat-cell">
            <b>{marketplaceStats.listings}</b>
            <span>Listings live</span>
          </div>
          <div className="stat-cell">
            <b>{marketplaceStats.members}</b>
            <span>Members offering space</span>
          </div>
          <div className="stat-cell">
            <b>{marketplaceStats.cities}</b>
            <span>Cities covered</span>
          </div>
          <div className="stat-cell">
            <b>{marketplaceStats.channels}</b>
            <span>Kinds of space</span>
          </div>
        </section>
      )}

      {legacyPublicSections && (<section className="how-section" id="how">
        <div className="how-intro">
          <h2>Find it. Message. <em>Make it happen.</em></h2>
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
                    <em>cafe window, Brea</em>
                    <i className="mock-caret" />
                  </div>
                  <div className="mock-chips">
                    <b>Storefront</b>
                    <b>Instagram</b>
                    <b>Vehicle</b>
                  </div>
                  <ul className="mock-results">
                    <li>
                      <span className="mock-thumb" />
                      <div>
                        <strong>Main Street window</strong>
                        <small>$4 / week</small>
                      </div>
                    </li>
                    <li>
                      <span className="mock-thumb" />
                      <div>
                        <strong>Counter card</strong>
                        <small>$3 / week</small>
                      </div>
                    </li>
                    <li>
                      <span className="mock-thumb" />
                      <div>
                        <strong>Rear-window decal</strong>
                        <small>$5 / week</small>
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
                    Hi! Is the window free the first week of March?
                  </div>
                  <div className="mock-bubble me">
                    It is. I can hold it for you.
                  </div>
                  <div className="mock-bubble them">
                    Perfect, sending a request now.
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
                    <strong>Spring launch</strong>
                    <span className="mock-status">Accepted</span>
                  </div>
                  <dl className="mock-deal-facts">
                    <div>
                      <dt>Dates</dt>
                      <dd>Mar 1 – Mar 8</dd>
                    </div>
                    <div>
                      <dt>Agreed</dt>
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
            <p className="section-label">Marketplace</p>
            <h1>Find the right audience or <em>spot.</em></h1>
          </div>
          <p>
            Search Instagram, TikTok, newsletters, local audiences, towns, or
            physical formats. See the details, meet the owner, and start a
            private conversation.
          </p>
        </div>

        {/* Which side of the marketplace someone is on decides what they
            should even be looking at, so ask it plainly first. */}
        <div className="intent-switch" role="group" aria-label="What are you here for?">
          <button
            type="button"
            className={roleFilter === "supply" ? "active" : ""}
            aria-pressed={roleFilter === "supply"}
            onClick={() => {
              setRoleFilter("supply");
              setChannelFilter("All");
            }}
          >
            <strong>I want to advertise</strong>
            <small>Buy space from local people and creators</small>
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
            <strong>I have advertising to offer</strong>
            <small>List your audience, placement, or sponsorship inventory</small>
          </button>
          {roleFilter !== "all" && (
            <button
              type="button"
              className="intent-clear"
              onClick={() => setRoleFilter("all")}
            >
              Show everything
            </button>
          )}
        </div>

        <div className="market-controls">
          <label className="search-control">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              aria-label="Search listings by platform, creator, space, or city"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search Instagram, creators, spaces, cities..."
            />
          </label>
          {/* A group of filters, not tabs: these narrow one grid rather than
              swapping panels, and role="tablist" without role="tab" children
              left the active filter signalled by background colour alone. */}
          <div className="role-tabs" role="group" aria-label="Listing owner type">
            {(
                [
                ["all", "Everything"],
                ["supply", "Advertising available"],
                ["creator", "Creators"],
                ["business", "Space wanted"],
              ] as Array<[RoleFilter, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={roleFilter === value ? "active" : ""}
                aria-pressed={roleFilter === value}
                onClick={() => setRoleFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-row" role="group" aria-label="Channel">
          {channels.map((channel) => (
            <button
              key={channel}
              type="button"
              className={activeChannel === channel ? "active" : ""}
              aria-pressed={activeChannel === channel}
              onClick={() => setChannelFilter(channel)}
            >
              {channel}
            </button>
          ))}
          {/* Announce the new count when a filter changes, so the result of
              pressing a filter is not visible-only. */}
          <span className="result-count" role="status" aria-live="polite">
            {blocksPending
              ? "Loading the marketplace"
              : `${visibleListings.length} listing${visibleListings.length === 1 ? "" : "s"} · ${requestableListingCount} requestable · ${visibleListings.length - requestableListingCount} view-only`}
          </span>
        </div>

        <div className="listing-grid">
          {blocksPending &&
            Array.from({ length: 6 }, (_, index) => (
              <div className="listing-skeleton" key={`skeleton-${index}`} />
            ))}
          {visibleListings.map((listing) => (
            <article className="listing-card" key={listing.id}>
              <button
                className="listing-image"
                onClick={() => openListing(listing)}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={listing.image_url} alt="" loading="lazy" decoding="async" />
                <span
                  className={`listing-channel ${isBrief(listing) ? "is-brief" : ""}`}
                >
                  {isBrief(listing) ? "Wanted" : listing.channel}
                </span>
                {listingImages(listing).length > 1 && (
                  <span className="photo-count">
                    {listingImages(listing).length} photos
                  </span>
                )}
                {/* A 34px circular heart pill sat here on every card - the
                    exact affordance every marketplace uses for "save" - with
                    no handler and no favorites feature behind it. Removed
                    rather than hidden: a control that does nothing when
                    clicked is worse than no control. Restore it alongside a
                    real favorites feature, not before. */}
                <span className="image-hint" aria-hidden="true">
                  Click to view <b>→</b>
                </span>
              </button>
              <div className="listing-body">
                <div className="owner-line">
                  <Avatar profile={listing.owner} size="small" />
                  <div>
                    <strong>
                      {listing.owner.display_name}
                      {listing.owner.verified && <span className="verified">✓</span>}
                      {listing.owner.is_demo && (
                        <span className="sample-badge">Demo</span>
                      )}
                    </strong>
                    <small>
                      {rolesLabel(listing.owner)} · {listingCity(listing)}
                    </small>
                  </div>
                </div>
                <button
                  className="listing-title"
                  onClick={() => openListing(listing)}
                >
                  {listing.title}
                </button>
                <p className="listing-blurb">{listing.description}</p>
                <div className="listing-offer">
                  <span className="listing-offer-label">
                    {isBrief(listing) ? "Looking for" : "You get"}
                  </span>
                  <span className="listing-offer-value">
                    {formatOffer(listing.format)}
                  </span>
                </div>
                <button
                  className="listing-more"
                  onClick={() => openListing(listing)}
                >
                  Learn more <span>→</span>
                </button>
                <footer>
                  <div>
                    {isBrief(listing) && (
                      <span className="price-lead">Budget</span>
                    )}
                    <strong>{priceLabel(listing)}</strong>
                    <small> / {listing.price_unit}</small>
                  </div>
                  <button
                    disabled={!isListingRequestable(listing)}
                    onClick={() => openCampaignRequest(listing)}
                    title={
                      isListingRequestable(listing)
                        ? undefined
                        : "The owner must confirm this listing before requests open."
                    }
                  >
                    {isListingRequestable(listing)
                      ? isBrief(listing)
                        ? "Offer my space"
                        : "Request"
                      : "View only"}{" "}
                    <span>↗</span>
                  </button>
                </footer>
              </div>
            </article>
          ))}
        </div>
        {!visibleListings.length && !blocksPending && (
          <div className="empty-state">
            <span>⌕</span>
            <h3>No exact matches yet.</h3>
            <p>Try a broader search or clear one of the filters.</p>
            <button
              className="button button-dark"
              onClick={() => {
                setQuery("");
                setRoleFilter("all");
                setChannelFilter("All");
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </section></div>)}

      {legacyPublicSections && (<section className="spaces-section" id="spaces">
        <div className="spaces-heading">
          <h2>
            Every local spot
            <br />
            can become <em>reach.</em>
          </h2>
          <p>
            A produce stand, barber mirror, bakery window, receipt footer, or
            local roundup can reach the exact people a nearby business needs.
          </p>
          <div className="spaces-actions">
            <button
              className="button button-light"
              onClick={openListingEditor}
            >
              List a space <span>↗</span>
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
              {user ? "Edit my profile" : "Sign up free"} <span>↗</span>
            </button>
          </div>
        </div>
        <div className="space-collage">
          <figure className="space-tile tile-wide">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/photos/roadside-farm-stand.jpg" alt="Roadside farm stand" loading="lazy" decoding="async" />
            <figcaption>
              <strong>Roadside farm stand</strong>
              <span>Dinuba, CA · owner sets the rate</span>
            </figcaption>
          </figure>
          <figure className="space-tile">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/photos/small-town-barber.jpg" alt="Small-town barber shop" loading="lazy" decoding="async" />
            <figcaption>
              <strong>Barber waiting bench</strong>
              <span>Lanesboro, MN · $3/week</span>
            </figcaption>
          </figure>
          <figure className="space-tile">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/photos/rural-market.jpg" alt="Rural Main Street market" loading="lazy" decoding="async" />
            <figcaption>
              <strong>Market counter card</strong>
              <span>Mercer, WI · $4/week</span>
            </figcaption>
          </figure>
        </div>
      </section>)}

      {legacyPublicSections && (<section className="people-section" id="creators">
        <div className="section-top">
          <div>
            <p className="section-label">Creators, hosts and businesses</p>
            <h2>Small town. <em>Real influence.</em></h2>
          </div>
          <p>
            Rent a creator’s Instagram Story, TikTok reach, or newsletter. Book
            a shopkeeper’s window, counter, vehicle, or land. Or meet the
            businesses looking to buy that space.
          </p>
        </div>
        <div className="people-row">
          {showcasePeople.map((person) => (
            <article key={person.id} className="person-card">
              <Avatar profile={person} size="large" />
              <span className="person-role">{rolesLabel(person)}</span>
              {person.is_demo && <span className="person-demo">Demo profile</span>}
              {!person.is_demo && person.verified && (
                <span className="person-verified">Verified by SideSpace</span>
              )}
              <h3>{person.display_name}</h3>
              <p>{displayHandle(person.handle ?? "") || person.city}</p>
              <SocialLinks profile={person} compact />
              {Boolean(person.gallery_urls?.length) && (
                <div className="profile-gallery-preview" aria-label={`${person.display_name} photos`}>
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
                        ? " followers"
                        : ` ${person.reach_unit || "weekly looks"}`}
                    </span>
                  )}
                  {Boolean(listingCountByOwner.get(person.id)) && (
                    <span>
                      <b>{listingCountByOwner.get(person.id)}</b>
                      {listingCountByOwner.get(person.id) === 1
                        ? " listing live"
                        : " listings live"}
                    </span>
                  )}
                  {Boolean(person.audience_age) && <span>{person.audience_age}</span>}
                </div>
              )}
              <button onClick={() => requireAccount(() => void startConversation(person))}>
                Say hello ↗
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
          <p className="eyebrow">Before and after</p>
          <h2 id="compare-heading">
            Local advertising, the old way and <em>this way.</em>
          </h2>
          <p className="compare-lede">
            The same six questions every owner asks on the first call, answered
            side by side.
          </p>
        </div>
        <div className="compare-scroll">
          <table className="compare-table">
            <thead>
              <tr>
                <th scope="col">Area</th>
                <th scope="col">Traditional</th>
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
            <p className="eyebrow">Pricing</p>
            <h2>Start free. Grow when you are ready.</h2>
            <p className="pricing-note">
              Profiles, listings, browsing, requests, and messages have no
              subscription. Campaign fees apply only when accepted work is paid.
            </p>
          </div>
        </div>

        <div className="pricing-grid">
          <article className="pricing-card">
            <div>
              <span className="plan-label">Pay as you go</span>
              <h3>Free</h3>
              <p className="plan-price">
                <strong>$0</strong><span>/month</span>
              </p>
              <p>For small businesses testing their first local campaigns.</p>
            </div>
            <ul>
              <li><b>No subscription</b> or listing fee</li>
              <li>Browse every creator and space</li>
              <li>Direct private messaging</li>
              <li>No minimum campaign spend</li>
            </ul>
            <button
              className="pricing-button"
              onClick={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
            >
              Create a free account <span>↗</span>
            </button>
          </article>

          <article className="pricing-card pricing-card-featured">
            <span className="popular-badge">Businesses</span>
            <div>
              <span className="plan-label">Paid campaign</span>
              <h3>5%</h3>
              <p className="plan-price">
                <strong>+5%</strong><span>buyer fee</span>
              </p>
              <p>Added to the accepted campaign price before tax.</p>
            </div>
            <ul>
              <li>Hosted Stripe Checkout</li>
              <li>Tax calculated when applicable</li>
              <li>One-time invoice receipt</li>
              <li>No monthly plan</li>
            </ul>
            <button
              className="pricing-button pricing-button-lime"
              onClick={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
            >
              Find a campaign partner <span>↗</span>
            </button>
          </article>

          <article className="pricing-card">
            <div>
              <span className="plan-label">Creators and hosts</span>
              <h3>5%</h3>
              <p className="plan-price">
                <strong>−5%</strong><span>creator fee</span>
              </p>
              <p>Deducted from the accepted campaign price.</p>
            </div>
            <ul>
              <li>Stripe-hosted payout onboarding</li>
              <li>Clear earnings before acceptance</li>
              <li>Payment status in SideSpace</li>
              <li>No subscription or listing fee</li>
            </ul>
            <button
              className="pricing-button"
              onClick={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
            >
              List your reach <span>↗</span>
            </button>
          </article>
        </div>

      </section>)}

      {legacyPublicSections && (<section className="final-cta">
        <div>
          <h2>
            Ready for
            <br />
            <em>liftoff, locally?</em>
          </h2>
        </div>
        <div>
          <p>
            Browse the marketplace now, or create a profile to list your
            audience, storefront, vehicle, land, or any useful local space.
          </p>
          <button
            className="button button-coral"
            onClick={() => {
              setAuthMode("signup");
              setAuthOpen(true);
            }}
          >
            Create your free profile <span>↗</span>
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
        <p>Local reach, made bookable.</p>
        <nav>
          <a href="#how">How it works</a>
          <a href="#market">Marketplace</a>
          <a href="#creators">Creator inventory</a>
          <a href="#pricing">Pricing</a>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
          <button onClick={openInbox}>Messages</button>
        </nav>
        <small>© {new Date().getFullYear()} SideSpace</small>
      </footer>)}

      <SiteFooter
        onJoin={() => {
          setAuthMode("signup");
          setAuthOpen(true);
        }}
      />

      {authOpen && (
        <Modal
          elevated
          label={authMode === "signup" ? "Join SideSpace" : "Sign in to SideSpace"}
          onClose={() => setAuthOpen(false)}
        >
          <div className="modal-heading">
            <p className="eyebrow">Your SideSpace account</p>
            <h2>
              {authMode === "signup"
                ? invite
                  ? `Set up ${invite.business}.`
                  : "Join the network."
                : "Welcome back."}
            </h2>
            <p>
              {authMode !== "signup"
                ? "Sign in to manage your profile, listings, and conversations."
                : invite
                  ? // They were written to by name. Landing on "Join the
                    // network" makes the email look like a mail-merge, which
                    // is the one thing the outreach rules exist to avoid.
                    "One account, then the questions we could not answer for you. Most of it is already filled in."
                  : "Browse publicly. Create an account when you’re ready to list or message."}
            </p>
          </div>
          {!configured && (
            <div className="setup-notice">
              <strong>
                {localPreviewAvailable
                  ? "Local onboarding preview"
                  : "Backend connection needed"}
              </strong>
              <p>
                {localPreviewAvailable
                  ? "Test every onboarding step with seeded data. Preview mode never creates an account or saves anything."
                  : "This preview is using seeded marketplace data. Add the two Supabase environment variables to activate accounts."}
              </p>
            </div>
          )}
          {authMode === "signup" &&
            (activeBusinessReferralCode(referralCode) ||
              (invite && inviteRole(invite) === "business")) && (
            <div className="setup-notice ad-credit-signup-notice">
              <strong>
                Your {activeBusinessReferralCode(referralCode) ? "referral" : "invite"} includes {formatCents(BUSINESS_SIGNUP_CREDIT_CENTS)} in ad credit
              </strong>
              <p>
                Complete the Business setup and it will be applied automatically to advertising
                checkout. It cannot be withdrawn or transferred.
              </p>
            </div>
          )}
          {localPreviewAvailable ? (
            <button
              type="button"
              className="button button-dark button-full preview-onboarding-button"
              onClick={openOnboardingPreview}
            >
              Preview onboarding <span>→</span>
            </button>
          ) : (
            <>
              {googleOAuthEnabled && (
                <>
                  <button
                    className="google-button"
                    onClick={signInWithGoogle}
                  >
                    <b>G</b> Continue with Google
                  </button>
                  <div className="form-divider">
                    <span>or use email</span>
                  </div>
                </>
              )}
              <form className="stack-form" onSubmit={handleAuth}>
                {authMode === "signup" && (
                  <label>
                    Your name
                    <input name="name" required placeholder="Alex Morgan" />
                  </label>
                )}
                <label>
                  Email address
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    placeholder="you@example.com"
                  />
                </label>
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    minLength={8}
                    autoComplete={
                      authMode === "signup" ? "new-password" : "current-password"
                    }
                    required
                    placeholder="At least 8 characters"
                  />
                </label>
                <button
                  className="button button-dark button-full"
                  disabled={busy || !configured}
                >
                  {busy
                    ? "One moment..."
                    : authMode === "signup"
                      ? "Create my account"
                      : "Sign in"}
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
                    Forgot your password?
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
                  ? "Already a member? Sign in"
                  : "New here? Create an account"}
              </button>
              <p className="security-note">
                Passwords are handled by Supabase Auth and never stored in the
                SideSpace application database.
              </p>
            </>
          )}
        </Modal>
      )}

      {accountOpen && user && profile && (
        <Modal label="Account settings" onClose={() => setAccountOpen(false)} wide>
          <div className="account-dashboard">
            <header className="account-hero">
              <Avatar profile={profile} size="large" />
              <div>
                <p className="eyebrow">Your SideSpace account</p>
                <h2>{profile.display_name}</h2>
                <p>
                  {user.email} <span>•</span> {rolesLabel(profile)} <span>•</span>{" "}
                  {profile.city || "Location not added"}
                </p>
              </div>
              <span className="saved-account-badge">Saved securely</span>
            </header>

            <div className="account-actions" aria-label="Account shortcuts">
              <button
                onClick={() => {
                  setAccountOpen(false);
                  openProfileEditor(1);
                }}
              >
                <span>Edit profile</span>
                <b>Update photos, links, and details</b>
              </button>
              <button
                onClick={() => {
                  setAccountOpen(false);
                  openListingEditor();
                }}
              >
                <span>Create a listing</span>
                <b>Add a space or marketing placement</b>
              </button>
              <button
                onClick={() => {
                  setAccountOpen(false);
                  openInbox();
                }}
              >
                <span>Messages</span>
                <b>Continue private conversations</b>
              </button>
              <button
                onClick={() =>
                  document
                    .getElementById("campaign-requests")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              >
                <span>Campaigns</span>
                <b>Review requests, dates, and offers</b>
              </button>
            </div>

            {profile.role === "business" && (
              <section className="account-section ad-credit-account-section" id="account-ad-credit">
                <div className="account-section-heading">
                  <div>
                    <p className="eyebrow">Advertising credit</p>
                    <h3>{formatCents(adCreditBalanceCents)} available for advertising.</h3>
                    <p className="account-section-lede">
                      It is applied automatically to eligible campaign checkout and cannot be
                      withdrawn or transferred.
                    </p>
                  </div>
                  <span className="section-count">Spend-only</span>
                </div>
              </section>
            )}

            {profile.role === "business" && (
              <section
                className="account-section preferences-section"
                id="campaign-preferences"
              >
                <div className="account-section-heading">
                  <div>
                    <p className="eyebrow">Campaign preferences</p>
                    <h3>Tell us what a good creator looks like.</h3>
                    <p className="account-section-lede">
                      These choices shape the creator posts we put first on your
                      dashboard. Change them whenever your next campaign changes.
                    </p>
                  </div>
                  <span className="section-count">Always editable</span>
                </div>
                <form
                  className="preferences-form"
                  onSubmit={saveBusinessPreferences}
                >
                  <div className="preferences-grid">
                    <PreferenceChipGroup
                      label="Your category"
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
                      label="Campaign goal"
                      options={BUSINESS_GOAL_CHIPS.map(({ label }) => ({
                        label,
                        value: label,
                      }))}
                      selected={businessPreferencesDraft.goal}
                      onPick={(value) =>
                        setBusinessPreferencesDraft((current) => ({
                          ...current,
                          goal: current.goal === value ? "" : value,
                        }))
                      }
                    />
                    <PreferenceChipGroup
                      label="What you want to book"
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
                      label="Physical placements"
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
                      label="Creator platforms"
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
                      Preferred area
                      <span className="optional">optional</span>
                      <small>Used to prioritize local creators and spaces.</small>
                      <input
                        value={businessPreferencesDraft.wantedArea}
                        onChange={(event) =>
                          setBusinessPreferencesDraft((current) => ({
                            ...current,
                            wantedArea: event.target.value,
                          }))
                        }
                        placeholder={profile.city || "Downtown Berkeley"}
                      />
                    </label>
                    <PreferenceChipGroup
                      label="Timing"
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
                    <p>Recommendations refresh as soon as you save.</p>
                    <button
                      className="button button-dark button-small"
                      disabled={preferencesSaving}
                    >
                      {preferencesSaving ? "Saving…" : "Save preferences"}{" "}
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
                    <p className="eyebrow">Stripe payouts</p>
                    <h3>Get paid through a verified account.</h3>
                  </div>
                  <span className="section-count">
                    {stripeAccountStatus?.ready
                      ? "Ready"
                      : stripeAccountStatus?.connected
                        ? "Needs attention"
                        : "Not set up"}
                  </span>
                </div>
                <div className="account-empty">
                  <strong>
                    {stripeAccountStatus?.ready
                      ? "Your Stripe account can receive campaign payouts."
                      : "Finish Stripe's secure onboarding before a business can pay you."}
                  </strong>
                  <p>
                    Stripe collects identity and bank details on its hosted pages.
                    SideSpace never stores your bank account information.
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
                      ? "Manage payouts in Stripe"
                      : stripeAccountStatus?.connected
                        ? "Continue Stripe setup"
                        : "Set up Stripe payouts"}
                  </button>
                </div>
              </section>
            )}

            <section className="account-section" id="campaign-requests">
              <div className="account-section-heading">
                <div>
                  <p className="eyebrow">Campaign requests</p>
                  <h3>From first idea to accepted work.</h3>
                </div>
                <span className="section-count">{campaignRequests.length} total</span>
              </div>

              {campaignRequests.length ? (
                <div className="campaign-request-list">
                  {campaignRequests.map((request) => {
                    const incoming = request.owner_profile_id === profile.id;
                    const other = incoming ? request.requester : request.owner;
                    const payment = paymentTransactions.find(
                      (item) => item.campaign_request_id === request.id,
                    );
                    const isPayer = request.payer_profile_id === profile.id;
                    const isPayee = request.payee_profile_id === profile.id;
                    const acceptedMoney = request.accepted_subtotal_cents
                      ? calculatePaymentBreakdown(request.accepted_subtotal_cents)
                      : null;
                    return (
                      <article className="campaign-request-card" key={request.id}>
                        <header>
                          <div>
                            <small>{incoming ? "Incoming request" : "Your request"}</small>
                            <h4>{request.campaign_name}</h4>
                            <p>
                              {/* A paused listing is hidden from everyone but
                                  its owner, so the other party's embed comes
                                  back null. The booking is still perfectly
                                  valid, so do not tell them it is gone. */}
                              {request.listing?.title ??
                                (request.status === "accepted" ||
                                request.status === "completed"
                                  ? "This listing is not currently public"
                                  : "Listing no longer available")}
                              {" · "}
                              {other.display_name}
                            </p>
                          </div>
                          <span className={`request-status status-${payment?.status ?? request.status}`}>
                            {payment?.status?.replaceAll("_", " ") ?? request.status}
                          </span>
                        </header>
                        <div className="campaign-request-facts">
                          <span>
                            <small>Dates</small>
                            <b>{displayDate(request.start_date)} – {displayDate(request.end_date)}</b>
                          </span>
                          <span>
                            <small>Budget</small>
                            <b>{formatCents(request.budget_cents)}</b>
                          </span>
                          <span>
                            <small>Requested</small>
                            <b>{request.requested_deliverables}</b>
                          </span>
                        </div>
                        {/* The request modal makes the goal mandatory and
                            promises the owner a clear brief, but nothing
                            ever rendered it - owners were accepting and
                            countering without the one thing the requester
                            was required to write. */}
                        {request.goals && (
                          <p className="campaign-request-brief">
                            <small>Goal</small>
                            {request.goals}
                          </p>
                        )}
                        {request.notes && (
                          <p className="campaign-request-brief">
                            <small>Notes</small>
                            {request.notes}
                          </p>
                        )}
                        {request.counter_budget_cents != null && (
                          <div className="counter-summary">
                            <strong>
                              {request.status === "accepted"
                                ? `Agreed at ${formatCents(request.counter_budget_cents)}`
                                : `Counteroffer: ${formatCents(request.counter_budget_cents)}`}
                            </strong>
                            {request.counter_message && (
                              <p>{request.counter_message}</p>
                            )}
                          </div>
                        )}
                        {acceptedMoney && isPayer && (
                          <div className="campaign-request-facts">
                            <span>
                              <small>Campaign</small>
                              <b>{formatCents(acceptedMoney.subtotalCents)}</b>
                            </span>
                            <span>
                              <small>SideSpace buyer fee (5%)</small>
                              <b>{formatCents(acceptedMoney.buyerFeeCents)}</b>
                            </span>
                            <span>
                              <small>Total before tax</small>
                              <b>
                                {formatCents(
                                  payment?.charged_total_cents ??
                                    acceptedMoney.customerTotalCents,
                                )}
                              </b>
                            </span>
                            {(payment?.ad_credit_cents ?? 0) > 0 && (
                              <span>
                                <small>Ad credit</small>
                                <b>−{formatCents(payment?.ad_credit_cents ?? 0)}</b>
                              </span>
                            )}
                          </div>
                        )}
                        {acceptedMoney &&
                          isPayer &&
                          !payment &&
                          adCreditBalanceCents > 0 && (
                            <p className="campaign-request-brief">
                              <small>Available ad credit</small>
                              {formatCents(adCreditBalanceCents)} will be applied automatically at
                              secure checkout. It cannot be withdrawn or transferred.
                            </p>
                          )}
                        {acceptedMoney && isPayee && (
                          <div className="campaign-request-facts">
                            <span>
                              <small>Campaign</small>
                              <b>{formatCents(acceptedMoney.subtotalCents)}</b>
                            </span>
                            <span>
                              <small>SideSpace creator fee (5%)</small>
                              <b>−{formatCents(acceptedMoney.creatorFeeCents)}</b>
                            </span>
                            <span>
                              <small>Your earnings</small>
                              <b>{formatCents(acceptedMoney.creatorPayoutCents)}</b>
                            </span>
                          </div>
                        )}
                        {(payment?.tax_cents ?? 0) > 0 && isPayer && (
                          <p className="campaign-request-brief">
                            <small>Tax collected by Stripe</small>
                            {formatCents(payment?.tax_cents ?? 0)}
                          </p>
                        )}
                        <div className="campaign-request-actions">
                          {/* Owners can act after countering - the earlier gate
                              on "pending" alone stranded them with an empty row.
                              But Accept is deliberately NOT offered once they
                              have countered: accepting your own counteroffer
                              would bind the requester to a price they never
                              agreed to. To take the original price, revise the
                              counter back to it and let them accept. */}
                          {incoming && request.status === "pending" && (
                            <button
                              className="button button-dark button-small"
                              disabled={busy}
                              onClick={() =>
                                void respondToCampaignRequest(request, "accepted")
                              }
                            >
                              Accept
                            </button>
                          )}
                          {incoming &&
                            ["pending", "countered"].includes(request.status) && (
                            <>
                              <button onClick={() => setCounteringRequest(request)}>
                                {request.status === "countered"
                                  ? "Revise counteroffer"
                                  : "Counteroffer"}
                              </button>
                              <button
                                disabled={busy}
                                onClick={() =>
                                  void respondToCampaignRequest(request, "declined")
                                }
                              >
                                Decline
                              </button>
                            </>
                          )}
                          {!incoming && request.status === "countered" && (
                            <button
                              className="button button-dark button-small"
                              disabled={busy}
                              onClick={() =>
                                void respondToCampaignRequest(request, "accepted")
                              }
                            >
                              Accept counteroffer
                            </button>
                          )}
                          {!incoming && ["pending", "countered"].includes(request.status) && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void respondToCampaignRequest(request, "cancelled")
                              }
                            >
                              Cancel request
                            </button>
                          )}
                          {request.status === "accepted" && (
                            <>
                              {isPayer && (
                                <button
                                  className="button button-coral button-small"
                                  disabled={busy}
                                  onClick={() =>
                                    void startCampaignCheckout(request.id)
                                  }
                                >
                                  {payment?.status === "checkout_open"
                                    ? "Continue secure checkout"
                                    : "Pay securely with Stripe"}
                                </button>
                              )}
                              {isPayee &&
                                profileHasRole(profile, "creator") &&
                                !stripeAccountStatus?.ready && (
                                <button
                                  className="button button-dark button-small"
                                  disabled={busy}
                                  onClick={() =>
                                    void openStripeFlow(
                                      "/api/stripe/connect/onboard",
                                    )
                                  }
                                >
                                  Finish payout setup
                                </button>
                              )}
                              <button
                                onClick={() => {
                                  setAccountOpen(false);
                                  openInbox();
                                }}
                              >
                                Continue in Messages
                              </button>
                            </>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="account-empty">
                  <strong>No campaign requests yet.</strong>
                  <p>Open a listing and choose Request this placement to start one.</p>
                </div>
              )}
            </section>

            {paymentTransactions.length > 0 && (
              <section className="account-section" id="payments">
                <div className="account-section-heading">
                  <div>
                    <p className="eyebrow">Payments and earnings</p>
                    <h3>A durable record of every Stripe checkout.</h3>
                  </div>
                  <span className="section-count">
                    {paymentTransactions.length} total
                  </span>
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
                            <small>{buyer ? "Business payment" : "Creator earnings"}</small>
                            <h4>{transaction.campaign_name}</h4>
                            <p>{transaction.listing_title}</p>
                          </div>
                          <span className={`request-status status-${transaction.workflow_status}`}>
                            {statusLabel}
                          </span>
                        </header>
                        <div className="campaign-request-facts">
                          <span>
                            <small>{buyer ? "Campaign" : "Gross campaign"}</small>
                            <b>{formatCents(transaction.subtotal_cents)}</b>
                          </span>
                          <span>
                            <small>{buyer ? "Buyer fee" : "Creator fee"}</small>
                            <b>
                              {buyer ? "" : "−"}
                              {formatCents(
                                buyer
                                  ? transaction.buyer_fee_cents
                                  : transaction.creator_fee_cents,
                              )}
                            </b>
                          </span>
                          <span>
                            <small>{buyer ? "Total before tax" : "Your earnings"}</small>
                            <b>
                              {formatCents(
                                buyer
                                  ? transaction.charged_total_cents ??
                                    transaction.customer_total_cents
                                  : transaction.creator_payout_cents,
                              )}
                            </b>
                          </span>
                        </div>
                        {buyer && (transaction.ad_credit_cents ?? 0) > 0 && (
                          <p className="campaign-request-brief">
                            <small>Ad credit applied</small>
                            −{formatCents(transaction.ad_credit_cents ?? 0)} promotional credit.
                            It cannot be withdrawn or transferred.
                          </p>
                        )}
                        {transaction.refunded_cents > 0 && (
                          <p className="campaign-request-brief">
                            <small>Refunded</small>
                            {formatCents(transaction.refunded_cents)}
                          </p>
                        )}
                        {transaction.payout_status === "pending" &&
                          transaction.workflow_status === "paid_payout_pending" && (
                            <div className="campaign-request-brief">
                              <small>{buyer ? "Creator payout" : "Payment pending"}</small>
                              {buyer
                                ? "Your payment is verified. The Creator can begin work; their payout stays pending until delivery is reviewed."
                                : "The customer paid in full. Your earnings remain pending until you mark the campaign delivered and the review period ends."}
                            </div>
                          )}
                        {transaction.delivered_at && transaction.review_deadline && (
                          <div className="campaign-request-brief">
                            <small>
                              {buyer
                                ? "Creator marked this campaign delivered"
                                : "Review period ends"}
                            </small>
                            {buyer && `Delivered ${displayDateTime(transaction.delivered_at)}. `}
                            Review deadline: {displayDateTime(transaction.review_deadline)}.
                            {!buyer && " Payout is expected after that time unless the payer reports an issue."}
                            {reviewExpired &&
                              transaction.payout_status !== "released" &&
                              transaction.issue_status === "none" &&
                              " The deadline has passed; automatic release is processing server-side."}
                          </div>
                        )}
                        {transaction.issue_status !== "none" && transaction.issue && (
                          <div className="counter-summary">
                            <strong>
                              {transaction.issue_status === "escalated"
                                ? "Issue escalated to SideSpace"
                                : transaction.issue_status === "resolved"
                                  ? "Issue resolved"
                                  : "Resolve with the Creator"}
                            </strong>
                            <p>{transaction.issue.details}</p>
                            {transaction.issue_status === "open" && (
                              <p>
                                Payout remains pending. Use Messages to try to resolve the issue
                                directly before escalating it.
                              </p>
                            )}
                          </div>
                        )}
                        {transaction.payout_status === "released" && (
                          <div className="campaign-request-brief">
                            <small>Payout released</small>
                            {buyer
                              ? "The Creator payout has been released and this campaign is complete."
                              : `${formatCents(transaction.payout_amount_cents)} was released${
                                  transaction.payout_released_at
                                    ? ` on ${displayDateTime(transaction.payout_released_at)}`
                                    : ""
                                }.`}
                          </div>
                        )}
                        {transaction.review && (
                          <div className="campaign-request-brief">
                            <small>Creator review · {transaction.review.rating}/5</small>
                            {transaction.review.review_text}
                          </div>
                        )}
                        {transaction.payout_issue && (
                          <div className="campaign-request-brief">
                            <small>Payout release needs attention</small>
                            SideSpace could not finish the transfer yet. It is safe to retry; no
                            duplicate payout will be created.
                          </div>
                        )}
                        <div className="campaign-request-actions">
                          {!buyer &&
                            transaction.workflow_status === "paid_payout_pending" &&
                            transaction.payout_status === "pending" && (
                              <button
                                className="button button-dark button-small"
                                disabled={busy}
                                onClick={() =>
                                  void runCampaignPaymentAction(transaction, "deliver")
                                }
                              >
                                {busy ? "Updating..." : "Mark campaign delivered"}
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
                                  onClick={() =>
                                    void runCampaignPaymentAction(transaction, "confirm")
                                  }
                                >
                                  {busy ? "Releasing..." : "Confirm work completed"}
                                </button>
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    void runCampaignPaymentAction(transaction, "report_issue")
                                  }
                                >
                                  Report an issue
                                </button>
                              </>
                            )}
                          {transaction.issue_status === "open" && (
                            <button
                              onClick={() => {
                                setAccountOpen(false);
                                openInbox();
                              }}
                            >
                              Resolve with the Creator
                            </button>
                          )}
                          {buyer && transaction.issue_status === "open" && (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void runCampaignPaymentAction(transaction, "escalate")
                              }
                            >
                              Escalate to SideSpace
                            </button>
                          )}
                          {buyer &&
                            transaction.payout_status === "released" &&
                            !transaction.review && (
                              <button
                                className="button button-dark button-small"
                                disabled={busy}
                                onClick={() => void submitCreatorReview(transaction)}
                              >
                                Review Creator
                              </button>
                            )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}

            {canonicalRole(profile.role) === "creator" && (
              <section className="account-section" id="portfolio">
                <div className="account-section-heading">
                  <div>
                    <p className="eyebrow">Public Creator portfolio</p>
                    <h3>Show businesses work they can trust.</h3>
                    <p>
                      Add campaign examples, videos, case studies, or project links.
                      Published items appear with your marketplace listings.
                    </p>
                  </div>
                  <span className="section-count">{creatorPortfolio.length} items</span>
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
                          <span className="request-status status-active">Published</span>
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
                              View work ↗
                            </a>
                          )}
                          <button
                            disabled={busy}
                            onClick={() => void deleteCreatorPortfolioItem(item.id)}
                          >
                            Remove
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
                <form className="field-grid campaign-form" onSubmit={submitCreatorPortfolioItem}>
                  <label>
                    Work title
                    <input name="title" required minLength={2} maxLength={120} />
                  </label>
                  <label>
                    Type
                    <select name="kind" defaultValue="project">
                      <option value="video">Video</option>
                      <option value="campaign">Campaign</option>
                      <option value="case_study">Case study</option>
                      <option value="project">Project</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                  <label>
                    Media URL
                    <input name="media_url" type="url" placeholder="https://…" />
                  </label>
                  <label>
                    Project URL
                    <input name="project_url" type="url" placeholder="https://…" />
                  </label>
                  <label className="field-wide">
                    What did you make?
                    <textarea
                      name="description"
                      maxLength={1200}
                      placeholder="Scope, deliverables, result, and your role."
                    />
                  </label>
                  <button className="button button-dark field-wide" disabled={busy}>
                    {busy ? "Publishing..." : "Add to public portfolio"}
                  </button>
                </form>
                {creatorReviews.length > 0 && (
                  <div className="campaign-request-brief">
                    <small>Verified campaign reviews</small>
                    {creatorReviews.length} review{creatorReviews.length === 1 ? "" : "s"} ·{" "}
                    {(
                      creatorReviews.reduce((sum, review) => sum + review.rating, 0) /
                      creatorReviews.length
                    ).toFixed(1)}
                    /5 average
                  </div>
                )}
              </section>
            )}

            <section className="account-section">
              <div className="account-section-heading">
                <div>
                  <p className="eyebrow">My listings</p>
                  <h3>Everything you have published.</h3>
                </div>
                {profile.role !== "consumer" && (
                  <button
                    className="button button-dark button-small"
                    onClick={() => {
                      setAccountOpen(false);
                      openListingEditor();
                    }}
                  >
                    New listing <span>+</span>
                  </button>
                )}
              </div>

              {ownListingsLoading ? (
                <div className="account-empty">Loading your saved listings...</div>
              ) : ownListings.length ? (
                <div className="my-listings-grid">
                  {ownListings.map((listing) => (
                    <article className="my-listing-card" key={listing.id}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={listing.image_url || "/photos/market-creator.jpg"}
                        alt={`${listing.title} listing`}
                        loading="lazy"
                        decoding="async"
                      />
                      <div>
                        <span className={`listing-status status-${listing.status}`}>
                          {listing.status}
                        </span>
                        <h4>{listing.title}</h4>
                        <p>
                          {listing.channel} • {priceLabel(listing)}/{listing.price_unit}
                        </p>
                        {/* The one place an owner can find out that the grid
                            is sinking their listing. listingRank has always
                            sorted a thin row below every complete one; this
                            says so, and says which piece is missing, next to
                            the Edit button that fixes it. */}
                        {(() => {
                          const gaps = listingGaps(listing);
                          if (!gaps.length) return null;
                          return (
                            <p className="listing-gap">
                              Sorted below complete listings — it needs{" "}
                              {joinList(gaps)}.
                            </p>
                          );
                        })()}
                        <div className="my-listing-actions">
                          <button
                            onClick={() => {
                              setAccountOpen(false);
                              openListing(listing);
                            }}
                          >
                            View
                          </button>
                          <button onClick={() => openListingEdit(listing)}>
                            Edit
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => void updateListingStatus(listing)}
                          >
                            {listing.status === "active" ? "Pause" : "Make active"}
                          </button>
                          <button
                            className="is-danger"
                            disabled={busy}
                            onClick={() => setDeleteListingTarget(listing)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="account-empty">
                  <strong>No listings yet.</strong>
                  <p>
                    Your first listing will appear here immediately after you publish it.
                  </p>
                  {profile.role !== "consumer" && (
                    <button
                      className="button button-coral button-small"
                      onClick={() => {
                        setAccountOpen(false);
                        openListingEditor();
                      }}
                    >
                      Create my first listing <span>↗</span>
                    </button>
                  )}
                </div>
              )}
            </section>

            <section className="account-section trust-section">
              <div className="account-section-heading">
                <div>
                  <p className="eyebrow">Profile trust</p>
                  <h3>Make your identity easier to trust.</h3>
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
                    ? "Verified by SideSpace"
                    : verificationRequest?.status === "pending"
                      ? "Review pending"
                      : "Not verified yet"}
                </span>
              </div>
              <div className="trust-grid">
                <div>
                  <span>✓</span>
                  <strong>Account email active</strong>
                  <p>{user.email}</p>
                </div>
                <div>
                  <span>@</span>
                  <strong>Social links</strong>
                  <p>
                    {Object.keys(profile.social_links ?? {}).length
                      ? `${Object.keys(profile.social_links ?? {}).length} self-reported profile link${Object.keys(profile.social_links ?? {}).length === 1 ? "" : "s"}`
                      : "Add social profiles from Edit profile"}
                  </p>
                </div>
                <div>
                  <span>{profile.verified ? "✓" : "?"}</span>
                  <strong>SideSpace review</strong>
                  <p>
                    {profile.verified
                      ? "Evidence reviewed by the SideSpace team"
                      : verificationRequest?.status === "pending"
                        ? "Your evidence is waiting for review"
                        : "Submit public evidence for manual review"}
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
                      ? "Resubmit evidence"
                      : "Request verification"}{" "}
                    <span>↗</span>
                  </button>
                )}
              {verificationRequest?.status === "rejected" && (
                <p className="trust-help">
                  More information is needed. Contact {SUPPORT_EMAIL} before resubmitting.
                </p>
              )}
            </section>

            <section className="account-section settings-section">
              <div className="account-section-heading">
                <div>
                  <p className="eyebrow">Login & security</p>
                  <h3>Account settings.</h3>
                </div>
                <div className="account-storage-note">
                  <span>✓</span>
                  <p>
                    Your login, profile, listings, and messages are stored with
                    Supabase and follow you across devices.
                  </p>
                </div>
              </div>

              <div className="settings-grid">
                <div className="login-summary">
                  <small>Signed-in email</small>
                  <strong>{user.email}</strong>
                  <p>
                    Login method: {String(user.app_metadata.provider ?? "email")}
                  </p>
                  <button
                    type="button"
                    onClick={() => void emailPasswordReset(user.email)}
                    disabled={busy}
                  >
                    Email me a password reset link
                  </button>
                </div>
                <form className="stack-form account-password-form" onSubmit={updatePassword}>
                  <label>
                    Current password
                    <input
                      name="current_password"
                      type="password"
                      autoComplete="current-password"
                      required
                      placeholder="Confirm it's you"
                    />
                  </label>
                  <label>
                    New password
                    <input
                      name="new_password"
                      type="password"
                      minLength={8}
                      autoComplete="new-password"
                      required
                      placeholder="At least 8 characters"
                    />
                  </label>
                  <label>
                    Confirm new password
                    <input
                      name="confirm_password"
                      type="password"
                      minLength={8}
                      autoComplete="new-password"
                      required
                      placeholder="Type it again"
                    />
                  </label>
                  <button className="button button-dark button-full" disabled={busy}>
                    {busy ? "Saving..." : "Update password"} <span>✓</span>
                  </button>
                </form>
              </div>

              <div className="photo-manager">
                <strong>Your photos</strong>
                <p>
                  Remove anything you no longer want on your profile. Deleted
                  photos are erased from storage, not just hidden.
                </p>
                <div className="photo-manager-grid">
                  {profile.avatar_url && (
                    <figure className="saved-media">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={profile.avatar_url}
                        alt="Your profile photo"
                        loading="lazy"
                        decoding="async"
                      />
                      <figcaption>Profile photo</figcaption>
                      <button
                        type="button"
                        className="saved-media-remove"
                        disabled={busy}
                        aria-label="Remove profile photo"
                        title="Remove profile photo"
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
                        alt={`Profile photo ${index + 1}`}
                        loading="lazy"
                        decoding="async"
                      />
                      <button
                        type="button"
                        className="saved-media-remove"
                        disabled={busy}
                        aria-label={`Remove photo ${index + 1}`}
                        title="Remove photo"
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
                      No photos yet. Add them from Edit profile.
                    </p>
                  )}
              </div>

              {blockedProfiles.length > 0 && (
                <div className="blocked-list">
                  <strong>Blocked members</strong>
                  <p>
                    They cannot message you or request your listings, and their
                    listings stay hidden from you.
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
                          Unblock
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
                Log out of SideSpace <span>→</span>
              </button>

              {/* Destructive action sits last, after the everyday one. */}
              <div className="danger-zone">
                <div>
                  <strong>Delete account</strong>
                  <p>
                    Permanently removes your profile, listings, conversations,
                    and campaign requests. This cannot be undone.
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
                  Delete my account
                </button>
              </div>
            </section>
          </div>
        </Modal>
      )}

      {deleteListingTarget && (
        <Modal
          label="Delete listing"
          onClose={() => {
            if (!busy) setDeleteListingTarget(null);
          }}
        >
          <div className="modal-heading">
            <p className="eyebrow">Delete listing</p>
            <h2>{`Take \u201c${deleteListingTarget.title}\u201d down for good?`}</h2>
            <p>
              It leaves the marketplace right away and its photos are removed.
              Any open request on it is declined and the business that sent it
              is told. A listing that has been paid for cannot be deleted -
              pause it instead. There is no undo.
            </p>
          </div>
          <div className="form-submit">
            <button
              type="button"
              disabled={busy}
              onClick={() => setDeleteListingTarget(null)}
            >
              Keep it
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={busy}
              onClick={() => void deleteListing(deleteListingTarget)}
            >
              {busy ? "Deleting..." : "Delete listing"}
            </button>
          </div>
        </Modal>
      )}

      {deleteAccountOpen && user && (
        <Modal
          label="Delete your account"
          onClose={() => {
            if (!busy) {
              setDeleteAccountOpen(false);
              setDeleteAccountError("");
            }
          }}
        >
          <div className="modal-heading">
            <p className="eyebrow">Delete account</p>
            <h2>This is permanent.</h2>
            <p>
              Deleting your account removes your profile, every listing you
              have published, your conversations, and your campaign requests.
              There is no way to recover them afterward.
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
                Confirm your password to continue
                <input
                  name="delete_password"
                  type="password"
                  autoComplete="current-password"
                  required
                  placeholder="Your current password"
                />
              </label>
            ) : (
              <label>
                Type DELETE to confirm
                <input
                  name="delete_confirmation"
                  required
                  autoComplete="off"
                  placeholder="DELETE"
                />
                <small>
                  Your account does not use an email + password login, so
                  typing DELETE confirms it is really you.
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
                Keep my account
              </button>
              <button className="button button-danger" disabled={busy}>
                {busy ? "Deleting..." : "Permanently delete"}
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
              ? "Preview SideSpace onboarding"
              : onboardingMode === "edit"
              ? "Edit your SideSpace profile"
              : "Set up your SideSpace account"
          }
          onClose={() => {
            setOnboardingOpen(false);
            setOnboardingPreview(false);
            setOnboardingStep(1);
            setOnboardingError("");
            setAvatarCropPending(false);
            resetIgAvatarSync();
          }}
          wide
        >
          <div className="onboarding-top">
            <div>
              <p className="eyebrow">
                {onboardingPreview
                  ? "Local onboarding preview"
                  : onboardingMode === "edit"
                  ? "Edit your profile"
                  : "Set up your account"}
              </p>
              <h2>
                {onboardingMode === "edit"
                  ? "Update your details."
                  : "Let’s get you on the marketplace."}
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
                Step {onboardingStep} of {onboardingStepCount()}
              </small>
            </div>
          </div>

          {onboardingMode === "setup" &&
            (onboardingPreview ? (
              <div className="setup-notice preview-mode-notice">
                <strong>Nothing in this preview is saved.</strong>
                <p>
                  Use any sample answers you like. You are testing the real
                  five-step flow, validation, transitions, and listing preview.
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
                    ? `Hi ${invite.owner_first_name.trim()} — we started this for ${invite.business}.`
                    : `We started this for ${invite.business}.`}
                </strong>
                <p>
                  Filled in from your own website, so check it and change
                  anything that is wrong. Nobody can see you until you finish.
                </p>
              </div>
            ) : (
              <div className="setup-notice">
                <strong>Nobody can see you yet.</strong>
                <p>
                  Your profile appears in search once you finish. Each screen
                  asks for one small part of your listing.
                </p>
              </div>
            ))}

          <form
            ref={onboardingFormRef}
            className="onboarding-form"
            onSubmit={publishOnboarding}
          >
            {onboardingError && (
              <div className="form-feedback" role="alert">
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
                    ? "Which of these is you?"
                    : "Start with the basics."}
                </h3>
                <p>
                  {onboardingStep === 1
                    ? "This changes what we ask next. You can add more later."
                    : "A few details make the rest of your listing feel personal."}
                </p>
                {onboardingStep === 1 && (
                <div className="role-choice-grid" data-field="role">
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
                            `Switching to ${roleCopy[role].label} clears what you filled in for ${roleCopy[from].label} — the two ask different questions. Your name, city, bio and contact details are kept.`,
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
                      }}
                    >
                      <span>{roleCopy[role].icon}</span>
                      <small>{roleCopy[role].eyebrow}</small>
                      <strong>{roleCopy[role].label}</strong>
                      <p>{roleCopy[role].short}</p>
                    </button>
                  ))}
                </div>
                )}

                  {(onboardingMode === "edit" || onboardingStep === 2) && (
                <div className="field-grid onboarding-identity-fields">
                  <label>
                    {selectedRole === "business" ? "Business name" : "Your name"}
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
                          ? "Brea Coffee Bar"
                          : "Maya Alvarez"
                      }
                    />
                  </label>
                  {(onboardingMode === "edit" ||
                    Boolean(answers.display_name.trim())) && (
                  <label className="progressive-field">
                    <span className="location-field-label">Where are you based?</span>
                    <small>City and state. This is how buyers filter.</small>
                    <div className="location-input-row">
                      <input
                        name="city"
                        data-field="city"
                        maxLength={80}
                        list="onboarding-market-list"
                        value={answers.city}
                        onChange={(event) => {
                          setLocationError("");
                          setAnswers((current) => ({
                            ...current,
                            city: event.target.value,
                            // A changed city makes an older device pin stale.
                            location: null,
                          }));
                        }}
                        placeholder="Brea, CA"
                      />
                      <button
                        type="button"
                        className="button button-small location-button"
                        disabled={busy || locationBusy}
                        onClick={captureCurrentLocation}
                      >
                        {locationBusy
                          ? "Finding…"
                          : answers.location
                            ? "Update pin"
                            : "Use my location"}
                      </button>
                    </div>
                    {locationError ? (
                      <small className="location-data-status is-error" role="alert">
                        {locationError}
                      </small>
                    ) : answers.location ? (
                      <small className="location-data-status" role="status">
                        ✓ City-level location saved. Your exact device location is never published.
                      </small>
                    ) : (
                      <small className="location-data-status">
                        Optional: save a rounded location pin for future nearby matching.
                      </small>
                    )}
                  </label>
                  )}
                  <datalist id="onboarding-market-list">
                    {knownMarkets.map((market) => (
                      <option key={market} value={market} />
                    ))}
                  </datalist>
                  {(onboardingMode === "edit" || Boolean(answers.city.trim())) && (
                  <label className="field-wide progressive-field">
                    {selectedRole === "business"
                      ? "One line about your business"
                      : "One line about you"}
                    <small>
                      {selectedRole === "business"
                        ? "What you do, in a sentence. This sits under your name on the brief."
                        : "One sentence. It sits under your name on every card."}
                      {" "}
                      <span
                        className="field-character-count"
                        aria-live="polite"
                        data-complete={
                          answers.bio.trim().length >= 10 ? "true" : "false"
                        }
                      >
                        {getBioRequirementHint(answers.bio)}
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
                          ? "Third-wave coffee bar on Birch, open since 2019."
                          : "Analog fashion and honest city guides for East LA."
                      }
                    />
                  </label>
                  )}
                  {(onboardingMode === "edit" ||
                    answers.bio.trim().length > 0) && (
                  <>
                  <div className="field-wide media-upload-field progressive-field">
                    <OptionalFieldLabel>
                      {selectedRole === "business" ? "Add your logo" : "Add a profile photo"}
                    </OptionalFieldLabel>
                    <ProfilePhotoField
                      currentUrl={profile?.avatar_url}
                      inputRef={avatarInputRef}
                      value={avatarFile}
                      onFileChange={setAvatarFile}
                      onCropStateChange={setAvatarCropPending}
                    />
                    <small>
                      Profiles with a face or a logo get far more replies.
                      {profile?.avatar_url
                        ? " Leave empty to keep your current photo."
                        : ""}
                    </small>
                  </div>
                  {/* A business gives the person behind the name; everyone
                      else gives an email. Nobody is asked for an @handle any
                      more - it was a unique-indexed field that meant nothing
                      to the person filling it in. */}
                  {selectedRole === "business" ? (
                    <label className="progressive-field">
                      <OptionalFieldLabel>Your name</OptionalFieldLabel>
                      <small>Who a booker is actually writing to.</small>
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
                        placeholder="Dana Okafor"
                      />
                    </label>
                  ) : (
                    <label className="progressive-field">
                      <OptionalFieldLabel>Email</OptionalFieldLabel>
                      <small>How people reach you about a booking.</small>
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
                        placeholder="you@example.com"
                      />
                    </label>
                  )}
                  </>
                  )}
                </div>
                )}

                {(onboardingStep > 1 || isCurrentOnboardingStepComplete()) && (
                <div
                  className="onboarding-actions"
                  data-ready={isCurrentOnboardingStepComplete() ? "true" : "false"}
                >
                  {onboardingMode === "setup" && onboardingStep === 2 ? (
                    <button
                      type="button"
                      onClick={() => goToOnboardingStep(1)}
                    >
                      ← Back
                    </button>
                  ) : (
                    <span />
                  )}
                  {isCurrentOnboardingStepComplete() && (
                    <span className="onboarding-primary-action-enter">
                      <button
                        type="button"
                        className="button button-dark"
                        onClick={advanceOnboarding}
                      >
                        {onboardingStep === 1
                          ? onboardingMode === "edit"
                            ? "Next: your details"
                            : "Continue"
                          : selectedRole === "business"
                            ? "Next: your campaign"
                            : selectedRole === "creator"
                              ? "Next: what you have to advertise"
                              : "Next"}{" "}
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
                    <h3>Your details</h3>
                    <p>This is what people see on your profile card.</p>
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
                          <span>Your audience</span>
                          <h4>Where can brands find you?</h4>
                          <p>
                            Choose every platform you use, then add the profiles
                            you want to show.
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
                        <OptionalFieldLabel>Profile photos</OptionalFieldLabel>
                        <input
                          name="gallery_files"
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          multiple
                          onChange={(event) =>
                            setGalleryFiles(Array.from(event.target.files ?? []))
                          }
                        />
                        <small>Up to 6 photos on your profile.</small>
                      </label>
                    </div>
                    <div className="form-subsection field-wide">
                      <span>About you</span>
                      <h4>What kind of work is this?</h4>
                    </div>
                    <ChipRow
                      field="categories"
                      label="What kind of work"
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
                        ? "Review what people will see."
                        : onboardingStep === 4
                          ? selectedRole === "creator"
                            ? answers.creatorOffer === "physical"
                              ? "Make the placement bookable."
                              : answers.creatorOffer === "sponsorship"
                                ? "Build the sponsorship levels."
                                : answers.creatorOffer === "social"
                                  ? "Build your first offer."
                                  : "Choose your way to advertise."
                            : "Set the practical details."
                          : selectedRole === "creator"
                            ? answers.creatorOffer === "physical"
                              ? "Show us the placement."
                              : answers.creatorOffer === "sponsorship"
                                ? "Tell us about the organization."
                                : answers.creatorOffer === "social"
                                  ? "Tell us about your audience."
                                  : "Choose your way to advertise."
                            : "Shape the campaign."}
                    </h3>
                    <p>
                      {onboardingStep === 5
                        ? "Make any final edits, then publish when it feels right."
                        : onboardingStep === 4
                          ? "Clear expectations make the first conversation much easier."
                          : selectedRole === "business"
                            ? "A focused brief gets better replies from creators and local spaces."
                            : answers.creatorOffer
                              ? "A few specific answers make your listing easier to trust."
                              : "Start by choosing the kind of advertising you have."}
                    </p>
                    {selectedRole === "creator" && onboardingStep > 3 && (
                      <CreatorOfferSwitcher
                        answers={answers}
                        onSelect={switchCreatorOffer}
                      />
                    )}

                    {/* ---------------- CREATOR ---------------- */}
                    {selectedRole === "creator" && (
                      <>
                        {onboardingStep === 3 && (
                        <>
                        <div className="form-subsection field-wide">
                          <span>Your way to advertise</span>
                          <h4>What do you have to offer?</h4>
                          <p>
                            Select every kind of reach you want to put to work.
                            We’ll create one listing for each.
                          </p>
                        </div>
                        <div
                          className="scope-grid creator-offer-grid"
                          data-field="creatorOffer"
                          role="group"
                          aria-label="What kind of advertising you offer"
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
                              <strong>{option.label}</strong>
                              <small>{option.help}</small>
                              <span className="offer-card-state">
                                {answers.creatorOffers.includes(option.value)
                                  ? "✓ Selected"
                                  : "Select"}
                              </span>
                            </button>
                          ))}
                        </div>
                        <CreatorOfferSwitcher
                          answers={answers}
                          onSelect={switchCreatorOffer}
                        />

                        {answers.creatorOffer === "social" && (
                          <>
                          <div className="form-subsection field-wide">
                            <span>Your audience</span>
                            <h4>Where can brands find you?</h4>
                            <p>
                              Choose every platform you use, then add the profiles
                              you want to show.
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
                          <span>Your first offer</span>
                          <h4>What does a brand actually get?</h4>
                        </div>
                        {/* Only when there are any: an empty flex row still
                            takes its margin, leaving a gap under the header
                            for anyone who has not picked a platform yet. */}
                        {answers.platforms.some(
                          (key) => (CREATOR_OFFER_EXAMPLES[key] ?? []).length,
                        ) && (
                          <>
                            <span className="offer-examples-label field-wide">
                              Or start from one of these:
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
                            What they get
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
                              placeholder="three Instagram stories over 48 hours"
                            />
                          </label>
                          {answers.format.trim() && (
                            <p className="offer-preview field-wide">
                              Your card will read:{" "}
                              <strong>You get {formatOffer(answers.format)}</strong>
                            </p>
                          )}
                        </div>
                        <ChipRow
                          field="categories"
                          label="What kind of work"
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
                        <div className="field-grid">
                          <label className="field-wide media-upload-field">
                            <OptionalFieldLabel>
                              Photos of your work
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
                              Add 1–3 photos. Without one, your card uses your
                              profile photo.
                            </small>
                          </label>
                        </div>
                        </>
                        )}
                      </>
                    )}

                    {/* ---------------- CREATOR: PHYSICAL PLACEMENT ---------------- */}
                    {selectedRole === "creator" && answers.creatorOffer === "physical" && (
                      <>
                        {onboardingStep === 3 && (
                        <>
                        <div className="form-subsection field-wide">
                          <span>The space</span>
                          <h4>What kind of space is it?</h4>
                        </div>
                        <ChipRow
                          field="spaceKind"
                          label="Kind of space"
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
                            <OptionalFieldLabel>Exact address</OptionalFieldLabel>
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
                              Used for the map link below, so you can check you
                              picked the right spot. It is never shown on your
                              card and visitors to the site cannot read it —
                              though anyone signed in to SideSpace could.
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
                              placeholder="1398 Solano Ave, Albany, CA 94706"
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
                                See this spot on Google Maps ↗
                              </a>
                            )}
                          </label>
                          <label>
                            <OptionalFieldLabel>
                              What buyers see on the card
                            </OptionalFieldLabel>
                            <small>
                              A street or neighborhood. Shown publicly instead of
                              the full address.
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
                              placeholder={answers.city || "Downtown Brea"}
                            />
                          </label>
                          {/* The description helper has always told owners to
                              "add the size" by hand. This is the form finally
                              asking, so the draft can say it for them. */}
                          <label>
                            How big is it?
                            <small>
                              Roughly. Width by height is enough — it is the
                              first thing a buyer asks.
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
                              placeholder="6 ft × 3 ft"
                            />
                          </label>
                          <label className="field-wide media-upload-field">
                            <OptionalFieldLabel>
                              Photos of the space
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
                              One good photo roughly doubles your requests. Take one
                              now if it’s in front of you.
                            </small>
                          </label>
                        </div>

                        </>
                        )}

                        {onboardingStep === 4 && (
                        <>
                        <div className="form-subsection field-wide">
                          <span>What can go up</span>
                          <h4>What works here, and who puts it up?</h4>
                          <p>
                            The first thing a buyer asks before they book. Pick
                            everything you would actually allow — and nothing you
                            would not.
                          </p>
                        </div>
                        <ChipRow
                          field="surfaces"
                          label="Everything you’d allow"
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
                              What else can go up?
                              <small>
                                A few words. It joins the list a buyer reads.
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
                                placeholder="a shelf for product samples"
                              />
                            </label>
                          </div>
                        )}
                        <ChipRow
                          field="installBy"
                          label="Who puts it up"
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
                          <span>How busy is it?</span>
                          <h4>People who walk past on a normal day.</h4>
                        </div>
                        <ChipRow
                          field="traffic"
                          label="Foot traffic"
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
                            People a day
                            <small>
                              Pick a chip to fill this in, or type your own
                              count. This is what shows on your card.
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
                          <span>Availability</span>
                          <h4>When is it free?</h4>
                        </div>
                        <ChipRow
                          field="availability"
                          label="Availability"
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
                              {windowNote(free.startDays, free.days)}
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
                        {onboardingStep === 3 && (
                        <>
                        <div className="form-subsection field-wide">
                          <span>What you’re promoting</span>
                          <h4>What are you actually running this for?</h4>
                          <p>
                            The specific thing — a product, an opening, a class,
                            an event. This becomes the headline of your brief.
                          </p>
                        </div>
                        <div className="field-grid">
                          <label className="field-wide">
                            In a few words
                            <small>
                              Finish the sentence: “We’re promoting…”
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
                              placeholder="our new cold brew"
                            />
                          </label>
                        </div>
                        <ChipRow
                          field="categories"
                          label="What kind of business you are"
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
                          <span>The goal</span>
                          <h4>What should this campaign do?</h4>
                        </div>
                        <ChipRow
                          field="goal"
                          label="What it should do"
                          options={BUSINESS_GOAL_CHIPS.map((item) => item.label)}
                          selected={answers.goal ? [answers.goal] : []}
                          onPick={(value) =>
                            setAnswers((current) => ({ ...current, goal: value }))
                          }
                        />
                        {/* The fork. Everything below reshapes around it: pick
                            Physical and no platform is ever mentioned; pick
                            Virtual and nobody is asked what block they want. */}
                        <div className="form-subsection field-wide">
                          <span>What are you after?</span>
                          <h4>Physical space, social, or both?</h4>
                        </div>
                        <div
                          className="scope-grid"
                          data-field="briefScope"
                          role="group"
                          aria-label="What kind of space you want"
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
                              <strong>{chip.label}</strong>
                              <small>{chip.help}</small>
                            </button>
                          ))}
                        </div>

                        {answers.briefScope !== "" &&
                          answers.briefScope !== "virtual" && (
                            <>
                              <div className="form-subsection field-wide">
                                <span>The space</span>
                                <h4>What kind, and where?</h4>
                              </div>
                              <ChipRow
                                field="placements"
                                label="Kinds of space"
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
                                    Where do you want it?
                                  </OptionalFieldLabel>
                                  <small>
                                    The neighborhood or street you want to be
                                    seen on — not necessarily where you are.
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
                                        ? `Downtown ${answers.city.split(",")[0]}`
                                        : "Downtown Brea"
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
                                <span>The audience</span>
                                <h4>Which platforms should it run on?</h4>
                              </div>
                              <ChipRow
                                field="targetPlatforms"
                                label="Platforms to target"
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
                                    Anything a creator must include?
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
                                    placeholder="Tag @us, link in bio for 48h"
                                  />
                                  {/* Below the box now, not above it: these
                                      fill the field, and every other example
                                      row in the product sits under the thing
                                      it fills. */}
                                  <span className="offer-examples-label">
                                    Or tap to add one:
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

                        </>
                        )}

                        {onboardingStep === 4 && (
                        <>
                        {/* The artwork they need carried. Uploaded here so a
                            creator or space owner can see exactly what they'd
                            be posting before they answer. */}
                        <div className="form-subsection field-wide">
                          <span>Your artwork</span>
                          <h4>What do you need posted?</h4>
                        </div>
                        <div className="field-grid">
                          <label className="field-wide media-upload-field">
                            <OptionalFieldLabel>Flyer, story, or clip</OptionalFieldLabel>
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
                              Upload the graphic you want in the window or on
                              the feed. Skip it and pick “I need help making it”
                              below.
                            </small>
                          </label>
                        </div>
                        <ChipRow
                          field="artwork"
                          label="Who makes the artwork"
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
                          <span>Budget and timing</span>
                          <h4>What can you spend, and when?</h4>
                        </div>
                        <ChipRow
                          field="budgetRange"
                          label="Budget range"
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
                            Budget from
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
                            <OptionalFieldLabel>up to</OptionalFieldLabel>
                            <small>Leave blank for a flat budget.</small>
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
                          label="When it should run"
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
                              {windowNote(0, timing.days)}
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
                          <span>Your organization</span>
                          <h4>What are you?</h4>
                        </div>
                        <ChipRow
                          field="orgKind"
                          label="What kind of organization"
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
                              So what are you?
                              <small>
                                A couple of words. It opens your description and
                                it is what people searching will find you by.
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
                                placeholder="Scout troop"
                              />
                            </label>
                          </div>
                        )}
                        <div className="form-subsection field-wide">
                          <span>What it’s for</span>
                          <h4>What are you raising money for?</h4>
                          <p>
                            The championship trip, new kit, competition fees. It
                            is the line a sponsor actually decides on, and it
                            becomes the headline of every tier.
                          </p>
                        </div>
                        <div className="field-grid">
                          <label className="field-wide">
                            In a few words
                            <small>
                              Finish the sentence: “We’re raising for…”
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
                              placeholder="the championship trip"
                            />
                          </label>
                        </div>

                        <div className="form-subsection field-wide">
                          <span>Your reach</span>
                          <h4>How many people will see it?</h4>
                        </div>
                        <ChipRow
                          field="reach"
                          label="Roughly how many"
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
                            How many people
                            <small>
                              Pick a chip to fill this in, or type your own
                              number. This is what shows on your card.
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
                          <span>When it runs</span>
                          <h4>How long does a sponsorship last?</h4>
                        </div>
                        <ChipRow
                          field="season"
                          label="When it runs"
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
                              {windowNote(0, season.days)}
                            </p>
                          ) : null;
                        })()}

                        </>
                        )}

                        {onboardingStep === 4 && (
                        <>
                        <div className="form-subsection field-wide">
                          <span>The menu</span>
                          <h4>What could a sponsor get?</h4>
                          <p>
                            Everything you would ever offer, at any level. You
                            split it into tiers next.
                          </p>
                        </div>
                        <ChipRow
                          field="benefits"
                          label="Everything you could offer"
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
                          <span>Your tiers</span>
                          <h4>Break it into levels, or keep one.</h4>
                          <p>
                            Each tier publishes its own card, so a business can
                            find you by what it can afford instead of one price
                            that fits nobody.
                          </p>
                        </div>
                        {answers.tiers.map((tier, index) => (
                          <div className="tier-card field-wide" key={index}>
                            <div className="tier-card-head">
                              <span>Tier {index + 1}</span>
                              {answers.tiers.length > 1 && (
                                <button
                                  type="button"
                                  aria-label={`Remove tier ${index + 1}${
                                    tier.name.trim() ? `, ${tier.name.trim()}` : ""
                                  }`}
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
                                        `Remove ${
                                          tier.name.trim() || `tier ${index + 1}`
                                        }? What you filled in for this level is lost.`,
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
                                  Remove
                                </button>
                              )}
                            </div>
                            <div className="field-grid">
                              <label>
                                Name this level
                                <input
                                  data-field={`tierName${index}`}
                                  maxLength={40}
                                  value={tier.name}
                                  onChange={(event) =>
                                    updateTier(index, { name: event.target.value })
                                  }
                                  placeholder="Gold"
                                />
                              </label>
                              <label>
                                <OptionalFieldLabel>Spots at this level</OptionalFieldLabel>
                                <small>Leave blank if you don’t need a cap.</small>
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
                                What one sponsor pays
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
                                  Or tap a common one:
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
                                <OptionalFieldLabel>up to</OptionalFieldLabel>
                                <small>Leave blank for a flat tier.</small>
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
                                label={`What ${tier.name || "this level"} includes`}
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
                                Pick what a sponsor could get above, then split
                                it across your levels here.
                              </p>
                            )}
                          </div>
                        ))}
                        {answers.tiers.length >= MAX_TIERS && (
                          // The button used to vanish here, so a host who
                          // wanted a fifth level just found the control gone.
                          <p className="chip-note field-wide">
                            {MAX_TIERS} levels is the most a listing set can
                            carry — past that a business is reading a price
                            list rather than browsing.
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
                            + Add another tier
                          </button>
                        )}
                        <div className="field-grid">
                          <label className="field-wide media-upload-field">
                            <OptionalFieldLabel>Photos</OptionalFieldLabel>
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
                              A photo of the team, the robot, or last year’s event.
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
                          ? "Your brief"
                          : answers.creatorOffer === "physical"
                            ? "Your placement"
                            : answers.creatorOffer === "sponsorship"
                              ? "Your sponsorship"
                              : "Your offer"}
                      </span>
                      <h4>
                        {selectedRole === "business"
                          ? "Name the brief and set the budget."
                          : answers.creatorOffer === "physical"
                            ? "Name the placement and set the rent."
                            : answers.creatorOffer === "sponsorship"
                              ? "Tell them who they’d be backing."
                              : "Name the offer and set your rate."}
                      </h4>
                    </div>
                    <div className="field-grid">
                      {/* A sponsorship offer names each level in the tier editor,
                          and every tier composes its own headline from that name
                          plus what they are raising for. One shared title input
                          here would overwrite all three. */}
                      {!isSponsorshipOffer(selectedRole ?? "creator", answers) && (
                      <label className="field-wide">
                        {selectedRole === "business"
                          ? "Name this brief"
                          : answers.creatorOffer === "physical"
                            ? "Name this placement"
                            : "Name this offer"}
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
                              ? "Brea Coffee Bar — our new cold brew"
                              : answers.creatorOffer === "physical"
                                ? "Maya’s Barbershop — window in Downtown Brea"
                                : "Instagram Reel — Maya Alvarez"
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
                        {answers.creatorOffer === "physical" ? "Price from" : "Price"}
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
                          <OptionalFieldLabel>up to</OptionalFieldLabel>
                          <small>Leave blank for a flat rate.</small>
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
                        <p className="offer-preview">Budget is per campaign</p>
                      ) : (
                        <label>
                          Per
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
                        label="Or pick a common rate"
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
                          ? "What should whoever answers know?"
                          : answers.creatorOffer === "physical"
                            ? "What is the placement actually like?"
                            : answers.creatorOffer === "sponsorship"
                              ? "Why should someone sponsor you?"
                              : "What does a brand get, in your words?"}
                        <small>
                          {selectedRole === "business"
                            ? "We drafted this from your answers. Say what the artwork is and anything a creator or space owner must know."
                            : answers.creatorOffer === "physical"
                              ? "We drafted this from your answers. Add the size, what sticks to it, and who walks past."
                              : answers.creatorOffer === "sponsorship"
                                ? "We drafted this from your answers. Add what the season looks like and who turns up."
                                : "We drafted this from your answers. Add turnaround, what you will not do, anything a brand should know."}
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
                            Each tier card ends with its own perks line
                            {completeTiers(answers)[0]?.name.trim()
                              ? ` — “${completeTiers(answers)[0].name.trim()} sponsors get…”`
                              : " — “Gold sponsors get…”"}
                            . You don’t need to write it here.
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
                          ? `This is what people will see — ${
                              completeTiers(answers).length
                            } cards, top tier shown`
                          : "This is what people will see"}
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
                            Add a photo above — it fills the top half of your
                            card.
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
                              ? "Wanted"
                              : buildListingDraft(selectedRole ?? "creator", answers, {
                                  title: titleTouched,
                                  description: descriptionTouched,
                                }).channel}
                          </span>
                          <small className="preview-offer">
                            {answers.display_name.trim() || "Your name"}
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
                            ) || "Untitled listing"}
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
                            ) || "Your description will show here."}
                          </p>
                          <div className="preview-card-foot">
                            {selectedRole === "business" && (
                              <span className="preview-lead">Budget</span>
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
                                });
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
                  <span>Anything else?</span>
                  <h4>Do you do more than one of these?</h4>
                  <p>
                    You’ll show up in each of these searches, from one account.
                  </p>
                </div>
                <ChipRow
                  field="extra_roles"
                  label="Other things you do"
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
                  data-ready={isCurrentOnboardingStepComplete() ? "true" : "false"}
                >
                  <button
                    type="button"
                    onClick={() => goToOnboardingStep(onboardingStep - 1)}
                  >
                    ← Back
                  </button>
                  {isCurrentOnboardingStepComplete() && (
                    <span className="onboarding-primary-action-enter">
                      {onboardingMode === "setup" && onboardingStep < 5 ? (
                        <button
                          type="button"
                          className="button button-dark"
                          onClick={advanceOnboarding}
                        >
                          {onboardingStep === 3
                            ? "Next: the details"
                            : "Next: review"}{" "}
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
                            ? "Publishing…"
                            : onboardingPreview
                              ? "Finish preview"
                              : onboardingMode === "edit"
                                ? "Save changes"
                                : selectedRole === "business"
                                  ? "Post my brief"
                                  : "Publish and finish"}{" "}
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
              Sign out of this account
            </button>
          )}
        </Modal>
      )}

      {listingOpen && (
        <Modal
          label={editingListing ? "Edit listing" : "Create a listing"}
          onClose={() => {
            setListingOpen(false);
            resetAiHelpers();
            setEditingListing(null);
            setListingFeedback("");
          }}
          wide
        >
          <div className="modal-heading">
            <p className="eyebrow">
              {editingListing ? "Edit listing" : "Create a listing"}
            </p>
            <h2>
              {editingListing
                ? "Update what people can book."
                : "What can people book?"}
            </h2>
            <p>
              {editingListing
                ? "Change any detail below. Your listing keeps its history, conversations, and campaign requests."
                : "List a social placement, creator package, business brief, wall, window, vehicle, room, or anything else with useful attention."}
            </p>
          </div>
          {listingFeedback && (
            <div className="form-feedback" role="alert">
              <strong>Your listing was not saved yet.</strong>
              <p>{listingFeedback}</p>
            </div>
          )}
          <form
            key={editingListing?.id ?? "new-listing"}
            className="field-grid listing-form"
            onSubmit={saveListing}
          >
            {/* A brief is a WANTED card. Asking its author "What are you
                offering?" and telling them to name it like "Cafe window, Main
                Street" describes the opposite of what they posted. */}
            <div className="form-subsection field-wide">
              <span>The basics</span>
              <h4>
                {editingListingIsBrief
                  ? "What are you looking for?"
                  : "What are you offering?"}
              </h4>
            </div>
            {canonicalRole(profile?.role ?? "consumer") === "creator" &&
              !editingListing && (
              <div className="field-wide">
                <div className="form-subsection">
                  <span>Creator inventory</span>
                  <h4>What kind of advertising do you have?</h4>
                  <p>
                    Pick the shape of this listing so we can keep the useful
                    details with it.
                  </p>
                </div>
                <div
                  className="scope-grid creator-offer-grid"
                  data-field="creatorOffer"
                  role="group"
                  aria-label="What kind of advertising this listing offers"
                >
                  {CREATOR_OFFER_TYPES.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={newListingOffer === option.value}
                      className={
                        newListingOffer === option.value ? "active" : ""
                      }
                      onClick={(event) => {
                        setNewListingOffer(option.value);
                        const channel =
                          event.currentTarget.form?.elements.namedItem("channel");
                        const priceUnit =
                          event.currentTarget.form?.elements.namedItem("price_unit");
                        if (channel instanceof HTMLSelectElement) {
                          channel.value =
                            option.value === "physical"
                              ? "Storefront"
                              : option.value === "sponsorship"
                                ? "Sponsorship"
                                : "Instagram";
                        }
                        if (priceUnit instanceof HTMLSelectElement) {
                          priceUnit.value = defaultCreatorPriceUnit(option.value);
                        }
                      }}
                    >
                      <strong>{option.label}</strong>
                      <small>{option.help}</small>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!editingListingIsBrief && (
              <div className="field-wide ai-fill">
                <div className="ai-fill-copy">
                  <strong>Fill with AI</strong>
                  <small>
                    Type it or tap the mic and say it. Cover these and the
                    whole listing gets drafted for you to edit:
                  </small>
                  <ul className="ai-fill-checklist">
                    <li>what it is and where</li>
                    <li>who sees it, roughly how many</li>
                    <li>the price, and per what</li>
                    <li>when it is available</li>
                    {listingFormKind === "physical" && (
                      <li>size, what can go up, who puts it up</li>
                    )}
                  </ul>
                  <small>
                    Anything you leave out, it asks you for. It never guesses
                    a price or a number.
                  </small>
                  <small className="ai-fill-tip">
                    Tip: add a photo of the space in the photos field below
                    first. Drafts are a lot better when the AI can see it.
                  </small>
                </div>
                <div className="ai-fill-row">
                  <textarea
                    ref={aiNotesRef}
                    name="ai_notes"
                    rows={2}
                    maxLength={AI_NOTES_MAX}
                    placeholder={
                      listingFormKind === "physical"
                        ? "Front window on Main Street, about 4 by 6 ft, maybe 300 people walk past on a weekday, $40 a week, posters or decals, I put it up, available now"
                        : listingFormKind === "sponsorship"
                          ? "High school robotics team, 40 members, about 200 parents at each of 8 home matches, banner plus a jersey patch, $250 a season, we install"
                          : "Food and coffee account, 12k followers mostly Bay Area students, one story with a link, $30 per story, two days notice"
                    }
                  />
                  <button
                    type="button"
                    className={`ai-fill-mic${listening ? " is-listening" : ""}`}
                    aria-pressed={listening}
                    aria-label={
                      listening
                        ? "Stop listening and draft the listing"
                        : "Describe the space out loud, then draft it"
                    }
                    disabled={busy || aiFilling}
                    onClick={() => {
                      if (listening) stopListening();
                      else void startListening();
                    }}
                  >
                    {listening ? "Stop & fill" : "Speak & fill"}{" "}
                    <span>{listening ? "■" : "🎤"}</span>
                  </button>
                </div>
                {listening && (
                  <small className="ai-fill-status" role="status">
                    {voiceMode === "recording"
                      ? "Recording, up to a minute. Say what it is, where, the price, and who sees it, then tap Stop & fill."
                      : "Listening. Say what it is, where, the price, and who sees it, then tap Stop & fill."}
                  </small>
                )}
                {aiObservations.length > 0 && (
                  <div className="ai-fill-questions is-observations" role="status">
                    <strong>From your photo - check these are right:</strong>
                    <ul>
                      {aiObservations.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                    <small>
                      Anything wrong here is wrong in the draft too. Say so in
                      the box above and fill again.
                    </small>
                  </div>
                )}
                {aiQuestions.length > 0 && (
                  <div className="ai-fill-questions" role="status">
                    <strong>Still needed - it will not guess these:</strong>
                    <ol>
                      {aiQuestions.map((question) => (
                        <li key={question}>{question}</li>
                      ))}
                    </ol>
                    <small>
                      Add the answers in the box above, typed or spoken, then
                      fill again.
                    </small>
                  </div>
                )}
                <button
                  type="button"
                  className="button button-dark"
                  disabled={busy || aiFilling}
                  onClick={(event) => fillListingWithAi(event.currentTarget.form)}
                >
                  {aiFilling ? "Drafting…" : "Fill with AI"} <span>✦</span>
                </button>
              </div>
            )}
            <label className="field-wide">
              {editingListingIsBrief ? "Name the brief" : "Listing title"}
              <small>
                {`A short name people will see first, like \u201c${listingHints.titleExample}\u201d.`}
              </small>
              <input
                name="title"
                required
                maxLength={120}
                defaultValue={editingListing?.title ?? ""}
                placeholder={listingHints.titlePlaceholder}
              />
            </label>
            <label>
              Where does it appear?
              <small>The kind of space or platform this runs on.</small>
              <select
                name="channel"
                required
                defaultValue={
                  editingListing?.channel ??
                  (newListingOffer === "physical"
                    ? "Storefront"
                    : newListingOffer === "sponsorship"
                      ? "Sponsorship"
                      : "Instagram")
                }
              >
                {/* A listing whose channel is not one of these had no
                    matching option, so the select fell back to the first and
                    saving ANY edit silently rewrote the channel to Instagram.
                    Seven live listings were in that state. Always offer the
                    listing's own value so editing never rewrites it. */}
                {Array.from(
                  new Set([
                    ...LISTING_CHANNELS,
                    ...(editingListing?.channel ? [editingListing.channel] : []),
                  ]),
                ).map((channel) => (
                  <option key={channel}>{channel}</option>
                ))}
              </select>
            </label>
            <label>
              {editingListingIsBrief ? "What you want back" : "What the buyer gets"}
              <small>
                Finish the sentence{" "}
                <b>
                  {editingListingIsBrief
                    ? "\u201cLooking for\u2026\u201d"
                    : "\u201cYou get\u2026\u201d"}
                </b>{" "}
                exactly as it should read on your card.
              </small>
              {/* 140, not 60. Onboarding composes this line from chips and
                  routinely runs past 60 - two live listings sit at 62 right
                  now - and maxLength does not truncate a value it inherits, it
                  just stops accepting keystrokes. Measured in Chromium: at 60
                  those owners can delete from their offer line but cannot add
                  a single character to it, and the field swallows the typing
                  with no message. The cap has to clear what the flow itself
                  writes. */}
              <input
                name="format"
                required
                maxLength={140}
                defaultValue={editingListing?.format ?? ""}
                placeholder={listingHints.formatPlaceholder}
                onChange={(event) => setFormatPreview(event.target.value)}
              />
              <span className="offer-preview" aria-live="polite">
                Your card will read:{" "}
                <b>
                  {editingListingIsBrief ? "Looking for " : "You get "}
                  {formatOffer(formatPreview || editingListing?.format || "") ||
                    "…"}
                </b>
              </span>
              {/* Unlabelled, these read as three things that already happened
                  to the field rather than three things you can tap. */}
              <span className="offer-examples-label">Or start from one of these:</span>
              <span className="offer-examples">
                {listingHints.formatExamples.map((example) => (
                  <button
                    type="button"
                    key={example}
                    onClick={(event) => {
                      const input =
                        event.currentTarget.form?.elements.namedItem("format");
                      if (input instanceof HTMLInputElement) {
                        input.value = example;
                        setFormatPreview(example);
                      }
                    }}
                  >
                    {example}
                  </button>
                ))}
              </span>
            </label>
            <div className="form-subsection field-wide">
              <span>Pricing</span>
              <h4>What does it cost?</h4>
            </div>
            <label>
              Price
              <input
                name="price"
                type="number"
                max="2000000000"
                min="2"
                required
                defaultValue={
                  editingListing
                    ? centsToInputDollars(editingListing.price_cents)
                    : ""
                }
                placeholder="2"
              />
              <small>Start at $2, or set any higher price that fits your placement.</small>
            </label>
            {/* A band, not a number. price_max has been written by onboarding
                since 0017 - by briefs, spaces and sponsorship tiers - and this
                form had no input for it, so a listing published with a range
                could never have that range changed or cleared. */}
            <label>
              Up to
              <small>Optional. Leave blank for a flat price.</small>
              <input
                name="price_max"
                type="number"
                min="1"
                max="2000000000"
                defaultValue={
                  editingListing?.price_max_cents == null
                    ? ""
                    : centsToInputDollars(editingListing.price_max_cents)
                }
                placeholder="400"
              />
            </label>
            <label>
              Priced per
              <small>What one unit of your price covers.</small>
              <select
                name="price_unit"
                defaultValue={
                  editingListing?.price_unit ??
                  (newListingOffer === "physical"
                    ? "week"
                    : newListingOffer === "sponsorship"
                      ? "sponsor"
                      : "post")
                }
              >
                {/* Same reasoning as `channel` above. Production carries
                    'story set' and 'run' from the 0002 seeds and onboarding now
                    writes 'sponsor'; none of those were in this list, so opening
                    such a listing selected nothing, the browser fell back to the
                    first option, and saving ANY edit silently rewrote the unit
                    to 'campaign'. There is deliberately no CHECK on
                    listings.price_unit (0016) so the column really can hold
                    anything - the select has to carry the row's own value. */}
                {Array.from(
                  new Set([
                    ...PRICE_UNIT_OPTIONS,
                    ...(editingListing?.price_unit
                      ? [editingListing.price_unit]
                      : []),
                  ]),
                ).map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-subsection field-wide">
              <span>Where and when</span>
              <h4>Location and availability.</h4>
              <p>Pulled from your profile where possible — adjust if this listing differs.</p>
            </div>
            <label className="field-wide">
              Where is it?
              <small>City or the area you cover. Prefilled from your profile.</small>
              <input
                name="location_area"
                defaultValue={editingListing?.location_area || profile?.city || ""}
                placeholder="Brea, CA · within 10 miles"
              />
            </label>
            <label>
              Available from
              <input
                name="available_from"
                type="date"
                defaultValue={editingListing?.available_from ?? ""}
              />
            </label>
            <label>
              Available until
              <input
                name="available_to"
                type="date"
                defaultValue={editingListing?.available_to ?? ""}
              />
            </label>
            <label>
              How much notice you need
              <small>Days between someone booking and you starting.</small>
              <input
                name="lead_time_days"
                type="number"
                max="2000000000"
                min="0"
                defaultValue={editingListing?.lead_time_days ?? 2}
              />
            </label>
            <label>
              Smallest booking you accept
              <small>Leave blank if you have no minimum.</small>
              <input
                name="minimum_booking"
                defaultValue={editingListing?.minimum_booking ?? ""}
                placeholder={listingHints.minimumPlaceholder}
              />
            </label>
            <div className="form-subsection field-wide">
              <span>Details</span>
              <h4>What buyers will read.</h4>
            </div>
            <label className="field-wide">
              {editingListingIsBrief ? "Describe the brief" : "Describe it"}
              {/* This used to read "where exactly it sits, and who walks past"
                  for every role - advice that means nothing to a creator
                  selling three stories, and describes the wrong side of the
                  deal entirely for a business posting a brief. */}
              <small>
                {editingListingIsBrief
                  ? "What you’re promoting, what the artwork is, and anything whoever answers must know."
                  : editingListingIsPhysical
                    ? "What it is, where exactly it sits, and who walks past."
                    : editingListingIsSponsorship
                      ? "What the season looks like, who turns up, and what a sponsor’s money pays for."
                      : listingRole === "creator"
                        ? "What a brand gets, your turnaround, and anything you won’t do."
                        : "What it is, where exactly it sits, and who walks past."}
              </small>
              <textarea
                name="description"
                required
                defaultValue={editingListing?.description ?? ""}
                placeholder={listingHints.descriptionPlaceholder}
              />
            </label>
            <label className="field-wide">
              What happens after they book
              <small>The proof or finished work you hand back, like photos of the placement.</small>
              {/* Not required. Onboarding never asks for it - every creator
                  and every physical-only brief publishes with it empty - so a
                  `required` here blocked the FIRST edit of a listing this app
                  created itself, on a field saveListing does not even check. */}
              <textarea
                name="deliverables"
                defaultValue={editingListing?.deliverables ?? ""}
                placeholder={listingHints.deliverablesPlaceholder}
              />
            </label>
            <label className="field-wide">
              Anything else about timing?
              <small>Optional. For example weekday mornings only, or closed in August.</small>
              <input
                name="availability_notes"
                defaultValue={editingListing?.availability_notes ?? ""}
                placeholder="Weekdays after 3 PM, weekends, seasonal, or flexible"
              />
            </label>
            <label className="field-wide">
              If someone cancels
              <small>Optional. For example free cancellation up to 48 hours before.</small>
              <input
                name="cancellation_policy"
                defaultValue={editingListing?.cancellation_policy ?? ""}
                placeholder="Example: Free cancellation up to 48 hours before the start date"
              />
            </label>
            {/* ------------------------------------------------------------
                ROLE-SHAPED SECTION.

                Onboarding asks each role its own questions and writes nine
                structured columns - surface_types, install_by, space_size,
                street_address, brief_scope, target_platforms, sponsor_tier,
                sponsor_slots, price_max. This editor had an input for none of
                them, so everything a member answered in onboarding became
                permanently uneditable the moment they published.

                These are real checkboxes and radios rather than the chip
                component: the form is uncontrolled, and FormData.getAll gives
                us the array for free with no state to seed or keep in sync.
                ------------------------------------------------------------ */}
            {editingListingIsPhysical && (
              <>
                {/* Presence marker. An unchecked checkbox group and an
                    ABSENT one both yield [] from getAll, so without this a
                    creator opening their own listing would save empty arrays
                    over a space owner's answers. */}
                <input type="hidden" name="has_space_section" value="1" />
                <div className="form-subsection field-wide">
                  <span>The space</span>
                  <h4>What can go up, and who puts it up?</h4>
                </div>
                <fieldset className="chip-check-group field-wide">
                  <legend>Everything you&rsquo;d allow</legend>
                  {SURFACE_CHIPS.map((surface) => (
                    <label key={surface} className="chip-check">
                      <input
                        type="checkbox"
                        name="surface_types"
                        value={surface}
                        defaultChecked={editingListing?.surface_types?.includes(
                          surface,
                        )}
                      />
                      <span>{surface}</span>
                    </label>
                  ))}
                </fieldset>
                <fieldset className="chip-check-group field-wide">
                  <legend>Who puts it up</legend>
                  {INSTALL_CHIPS.map((item) => (
                    <label key={item.value} className="chip-check">
                      <input
                        type="radio"
                        name="install_by"
                        value={item.value}
                        defaultChecked={
                          editingListing?.install_by === item.value
                        }
                      />
                      <span>{item.label}</span>
                    </label>
                  ))}
                </fieldset>
                <label>
                  How big is it?
                  <small>Roughly. Width by height is enough.</small>
                  <input
                    name="space_size"
                    maxLength={80}
                    defaultValue={editingListing?.space_size ?? ""}
                    placeholder="6 ft × 3 ft"
                  />
                </label>
                <label>
                  Exact address
                  <small>
                    Optional. Never shown on your card, and visitors to the site
                    cannot read it — though anyone signed in to SideSpace could.
                  </small>
                  <input
                    name="street_address"
                    maxLength={240}
                    defaultValue={editingListing?.street_address ?? ""}
                    placeholder="1398 Solano Ave, Albany, CA 94706"
                  />
                </label>
                {/* A Google Street View frame of that address, added as one
                    more photo. Outdoor frames only: a storefront or a wall
                    on a street usually works, a dorm corridor gets a no. */}
                <div className="street-view">
                  <button
                    type="button"
                    disabled={busy || streetViewLoading}
                    onClick={(event) => void importStreetView(event.currentTarget.form)}
                  >
                    {streetViewLoading
                      ? "Looking up Street View…"
                      : streetView
                        ? "Refresh the Street View photo"
                        : "Add a Google Street View photo of this address"}
                  </button>
                  {streetView && (
                    <figure className="street-view-card">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={streetView.url} alt="Google Street View of the address" />
                      <figcaption>
                        Google Street View{streetView.date ? `, ${streetView.date}` : ""}.
                        Added to your photos; it may be out of date.
                        <button
                          type="button"
                          onClick={(event) => clearStreetView(event.currentTarget.form)}
                        >
                          Remove
                        </button>
                      </figcaption>
                    </figure>
                  )}
                </div>
              </>
            )}

            {editingListingIsSponsorship && (
              <>
                <input type="hidden" name="has_sponsor_section" value="1" />
                <div className="form-subsection field-wide">
                  <span>This tier</span>
                  <h4>Which level is this listing?</h4>
                  <p>
                    Each tier is its own listing. Renaming this one does not
                    touch your other levels.
                  </p>
                </div>
                <label>
                  Tier name
                  <small>Gold, Founding Partner, anything you call it.</small>
                  <input
                    name="sponsor_tier"
                    maxLength={40}
                    defaultValue={editingListing?.sponsor_tier ?? ""}
                    placeholder="Gold"
                  />
                </label>
                <label>
                  Spots at this level
                  <small>Optional. How many sponsors fit.</small>
                  <input
                    name="sponsor_slots"
                    type="number"
                    min="1"
                    max="10000"
                    defaultValue={editingListing?.sponsor_slots ?? ""}
                    placeholder="3"
                  />
                </label>
              </>
            )}

            {editingListingIsBrief && (
              <>
                <input type="hidden" name="has_brief_section" value="1" />
                <div className="form-subsection field-wide">
                  <span>Your brief</span>
                  <h4>What are you looking for?</h4>
                </div>
                <fieldset className="chip-check-group field-wide">
                  <legend>Physical space, social, or both</legend>
                  {BRIEF_SCOPE_CHIPS.map((item) => (
                    <label key={item.value} className="chip-check">
                      <input
                        type="radio"
                        name="brief_scope"
                        value={item.value}
                        defaultChecked={
                          (editingListing?.brief_scope ?? "both") === item.value
                        }
                      />
                      <span>{item.label}</span>
                    </label>
                  ))}
                </fieldset>
                <fieldset className="chip-check-group field-wide">
                  <legend>Platforms to target</legend>
                  {BRIEF_PLATFORM_CHIPS.map((platform) => (
                    <label key={platform} className="chip-check">
                      <input
                        type="checkbox"
                        name="target_platforms"
                        value={platform}
                        defaultChecked={editingListing?.target_platforms?.includes(
                          platform,
                        )}
                      />
                      <span>{platform}</span>
                    </label>
                  ))}
                </fieldset>
              </>
            )}

            <div className="form-subsection field-wide">
              <span>Audience and photos</span>
              <h4>Show them who they reach.</h4>
            </div>
            <label>
              Who will see it?
              {/* `||`, not `??`. demographics is a NOT NULL text column that
                  defaults to the empty string, so `??` never fell through and
                  the profile value it promised to prefill was never used -
                  three live listings sit on an empty string right now. */}
              <input
                name="demographics"
                defaultValue={
                  editingListing?.demographics || profile?.audience_age || ""
                }
                placeholder="68% ages 21–34 · local"
              />
              {/* Only claim the prefill when there is something to prefill
                  with, and only call it "from your profile" when it came from
                  there rather than from this listing's own saved value. */}
              <small>
                {!editingListing?.demographics && profile?.audience_age
                  ? "Prefilled from your profile — edit if this listing reaches a different audience."
                  : "Who actually sees this placement. Leave blank if you’d rather not say."}
              </small>
            </label>
            <label className="field-wide media-upload-field">
              {editingListing ? "Add or replace photos" : "Upload listing photos"}
              <input
                name="listing_photos"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                onChange={(event) => {
                  // Picking again replaces the whole list; keep the Street
                  // View frame in it.
                  const form = event.currentTarget.form;
                  if (streetView && form) addFileToPicker(form, streetView.file);
                }}
              />
              <small>
                {editingListing
                  ? "New photos go first and replace older ones past the 6-photo limit. Leave empty to keep current photos."
                  : "Add up to 6 photos of the land, wall, room, vehicle, storefront, or placement."}
              </small>
            </label>
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
                Cancel
              </button>
              <button className="button button-coral" disabled={busy}>
                {busy
                  ? "Saving listing..."
                  : editingListing
                    ? "Save changes"
                    : "Publish listing"}{" "}
                <span>↗</span>
              </button>
            </div>
          </form>
        </Modal>
      )}

      {selectedListing && (
        <Modal label={selectedListing.title} onClose={closeListing} wide>
          <div className="detail-layout">
            <div className="detail-media">
              <figure>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={listingImages(selectedListing)[selectedPhotoIndex] || selectedListing.image_url}
                  alt={`${selectedListing.title} photo ${selectedPhotoIndex + 1}`}
                />
                <span className="listing-channel">{selectedListing.channel}</span>
              </figure>
              {listingImages(selectedListing).length > 1 && (
                <div className="detail-thumbnails" aria-label="Listing photos">
                  {listingImages(selectedListing).map((url, index) => (
                    <button
                      key={`${url}-${index}`}
                      className={selectedPhotoIndex === index ? "active" : ""}
                      onClick={() => setSelectedPhotoIndex(index)}
                      aria-label={`View photo ${index + 1}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt="" loading="lazy" decoding="async" />
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="detail-copy">
              <div className="owner-line">
                <Avatar profile={selectedListing.owner} />
                <div>
                  <strong>
                    {selectedListing.owner.display_name}
                    {selectedListing.owner.verified && (
                      <span className="verified">✓</span>
                    )}
                  </strong>
                  <small>
                    {rolesLabel(selectedListing.owner)} ·{" "}
                    {selectedListing.owner.city}
                  </small>
                </div>
                <span
                  className={`owner-trust-badge ${
                    selectedListing.owner.verified ? "verified-owner" : ""
                  }`}
                >
                  {selectedListing.owner.is_demo
                    ? "Demo profile"
                    : selectedListing.owner.verified
                      ? "Verified by SideSpace"
                      : "Unverified profile"}
                </span>
              </div>
              {!isListingRequestable(selectedListing) && (
                <div className="listing-provenance-notice is-view-only">
                  <span>
                    This listing is view-only until its owner confirms it is
                    still available.
                  </span>
                </div>
              )}
              <SocialLinks profile={selectedListing.owner} />
              {(selectedCreatorReviews.length > 0 || selectedCreatorPortfolio.length > 0) && (
                <div className="detail-terms">
                  {selectedCreatorReviews.length > 0 && (
                    <div>
                      <small>Verified SideSpace reviews</small>
                      <p>
                        <strong>
                          {(
                            selectedCreatorReviews.reduce(
                              (sum, review) => sum + review.rating,
                              0,
                            ) / selectedCreatorReviews.length
                          ).toFixed(1)}
                          /5
                        </strong>{" "}
                        from {selectedCreatorReviews.length} completed campaign
                        {selectedCreatorReviews.length === 1 ? "" : "s"}
                      </p>
                      <p>“{selectedCreatorReviews[0].review_text}”</p>
                    </div>
                  )}
                  {selectedCreatorPortfolio.length > 0 && (
                    <div>
                      <small>Creator portfolio</small>
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
                              View {item.kind.replaceAll("_", " ")} ↗
                            </a>
                          )}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <h2>{selectedListing.title}</h2>
              <p>{selectedListing.description}</p>
              <div className="detail-facts">
                <div>
                  <small>Format</small>
                  <strong>{selectedListing.format}</strong>
                </div>
                <div>
                  <small>Audience</small>
                  <strong>{selectedListing.demographics || "Not specified"}</strong>
                </div>
                <div>
                  <small>Location / service area</small>
                  <strong>
                    {listingCity(selectedListing)}
                  </strong>
                </div>
                <div>
                  <small>Availability</small>
                  <strong>
                    {selectedListing.availability_notes ||
                      "Ask the owner for open dates"}
                  </strong>
                </div>
                <div>
                  <small>Booking window</small>
                  <strong>
                    {displayDate(selectedListing.available_from)} –{" "}
                    {displayDate(selectedListing.available_to)}
                  </strong>
                </div>
                <div>
                  <small>Lead time</small>
                  <strong>
                    {selectedListing.lead_time_days
                      ? `${selectedListing.lead_time_days} days`
                      : "Flexible"}
                  </strong>
                </div>
                <div>
                  <small>Minimum booking</small>
                  <strong>
                    {selectedListing.minimum_booking || "One placement"}
                  </strong>
                </div>
              </div>
              <div className="detail-terms">
                <div>
                  <small>What you receive</small>
                  <p>{selectedListing.deliverables || selectedListing.format}</p>
                </div>
                <div>
                  <small>Cancellation</small>
                  <p>
                    {selectedListing.cancellation_policy ||
                      "Agree on cancellation terms before accepting the campaign."}
                  </p>
                </div>
              </div>
              <div className="detail-price">
                <div>
                  <small>Starting at</small>
                  <strong>{formatCents(selectedListing.price_cents)}</strong>
                  <span> / {selectedListing.price_unit}</span>
                </div>
                <div className="detail-primary-actions">
                  <button
                    className="button button-coral"
                    disabled={!isListingRequestable(selectedListing)}
                    onClick={() => openCampaignRequest(selectedListing)}
                  >
                    {isListingRequestable(selectedListing)
                      ? isBrief(selectedListing)
                        ? "Offer my space"
                        : "Request this placement"
                      : "View only"}{" "}
                    <span>↗</span>
                  </button>
                  <button
                    className="button button-dark"
                    onClick={() => {
                      const listing = selectedListing;
                      closeListing();
                      openListingChat(listing);
                    }}
                  >
                    Message owner <span>↗</span>
                  </button>
                </div>
              </div>
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
                  Share listing
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
                      Report listing
                    </button>
                    <button
                      onClick={() =>
                        requireAccount(() => {
                          const owner = selectedListing.owner;
                          if (
                            window.confirm(
                              `Block ${owner.display_name}? They will not be able to message you or request your listings, and their listings will be hidden from you. You can undo this in Account settings.`,
                            )
                          ) {
                            void blockProfile(owner);
                          }
                        })
                      }
                    >
                      Block member
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {campaignListing && (
        <Modal
          label={`Request ${campaignListing.title}`}
          onClose={() => setCampaignListing(null)}
          wide
        >
          <div className="modal-heading">
            <p className="eyebrow">Campaign request</p>
            <h2>Request {campaignListing.title}</h2>
            <p>
              Send the owner a clear brief with dates, budget, and the result you
              want. Nothing is charged at this stage.
            </p>
          </div>
          {campaignListing.owner.is_demo && (
            <div className="demo-notice">
              <strong>This is a demo listing.</strong>
              <p>Your request will be saved as a sample and will not contact a real person.</p>
            </div>
          )}
          <form className="field-grid campaign-form" onSubmit={submitCampaignRequest}>
            <label className="field-wide">
              Campaign name
              <input
                name="campaign_name"
                required
                minLength={2}
                placeholder="Fall neighborhood launch"
              />
            </label>
            <label>
              Start date
              <input name="start_date" type="date" required />
            </label>
            <label>
              End date
              <input name="end_date" type="date" required />
            </label>
            <label>
              Proposed budget
              <input
                name="budget"
                type="number"
                max="2000000000"
                min="0"
                required
                defaultValue={centsToInputDollars(campaignListing.price_cents)}
              />
            </label>
            <label>
              Listing rate
              <input
                value={`${formatCents(campaignListing.price_cents)} / ${campaignListing.price_unit}`}
                readOnly
              />
            </label>
            <label className="field-wide">
              Campaign goal
              <textarea
                name="goals"
                required
                minLength={10}
                placeholder="What should this campaign help your business achieve?"
              />
            </label>
            <label className="field-wide">
              Requested deliverables
              <textarea
                name="requested_deliverables"
                required
                placeholder={campaignListing.deliverables || campaignListing.format}
              />
            </label>
            <label className="field-wide">
              Notes for the owner
              <textarea
                name="notes"
                placeholder="Creative requirements, audience details, links, or questions"
              />
            </label>
            <div className="form-submit field-wide">
              <button type="button" onClick={() => setCampaignListing(null)}>
                Cancel
              </button>
              <button className="button button-coral" disabled={busy}>
                {busy ? "Sending request..." : "Send campaign request"}{" "}
                <span>↗</span>
              </button>
            </div>
          </form>
        </Modal>
      )}

      {counteringRequest && (
        <Modal
          label="Suggest different terms"
          onClose={() => setCounteringRequest(null)}
        >
          <div className="modal-heading">
            <p className="eyebrow">Counteroffer</p>
            <h2>Suggest different terms.</h2>
            <p>Explain what you can deliver and what needs to change.</p>
          </div>
          <form className="stack-form" onSubmit={submitCounteroffer}>
            <label>
              Counter budget
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
              Counteroffer details
              <textarea
                name="counter_message"
                required
                minLength={10}
                placeholder="Explain the revised timing, scope, or deliverables."
              />
            </label>
            <button className="button button-coral button-full" disabled={busy}>
              {busy ? "Sending..." : "Send counteroffer"} <span>↗</span>
            </button>
          </form>
        </Modal>
      )}

      {verificationOpen && profile && profile.role !== "consumer" && (
        <Modal
          label="Submit verification evidence"
          onClose={() => setVerificationOpen(false)}
        >
          <div className="modal-heading">
            <p className="eyebrow">SideSpace verification</p>
            <h2>Submit evidence for review.</h2>
            <p>
              A social link is self-reported until SideSpace reviews evidence or
              a supported provider is connected. Approval is never automatic.
            </p>
          </div>
          <form className="stack-form" onSubmit={submitVerificationRequest}>
            <label>
              Public business or portfolio URL
              <input
                name="evidence_url"
                type="url"
                required
                placeholder="https://yourbusiness.com/about"
              />
            </label>
            <label>
              Primary social platform
              <select name="social_platform" defaultValue="instagram">
                <option value="instagram">Instagram</option>
                <option value="tiktok">TikTok</option>
                <option value="youtube">YouTube</option>
                <option value="facebook">Facebook</option>
                <option value="x">X</option>
                <option value="none">No social account</option>
              </select>
            </label>
            <label>
              Social handle or profile URL
              <input name="social_handle" placeholder="@yourhandle" />
            </label>
            <label>
              What should we verify?
              <textarea
                name="verification_message"
                placeholder="Tell us how the website and social profile connect to you or your organization."
              />
            </label>
            <button className="button button-dark button-full" disabled={busy}>
              {busy ? "Submitting..." : "Submit for manual review"}{" "}
              <span>↗</span>
            </button>
          </form>
        </Modal>
      )}

      {reportTarget && (
        <Modal
          label={`Report ${reportTarget.profile.display_name}`}
          onClose={() => setReportTarget(null)}
        >
          <div className="modal-heading">
            <p className="eyebrow">Safety report</p>
            <h2>Report {reportTarget.profile.display_name}</h2>
            <p>Reports are private and reviewed by the SideSpace team.</p>
          </div>
          <form className="stack-form" onSubmit={submitProfileReport}>
            <label>
              Reason
              <select name="reason" defaultValue="misleading">
                <option value="misleading">Misleading listing or metrics</option>
                <option value="spam">Spam or unwanted promotion</option>
                <option value="unsafe">Unsafe or prohibited content</option>
                <option value="impersonation">Impersonation</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label>
              Details
              <textarea
                name="details"
                required
                minLength={10}
                placeholder="Describe what happened and what the team should review."
              />
            </label>
            <button className="button button-dark button-full" disabled={busy}>
              {busy ? "Submitting..." : "Submit private report"}
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
            aria-label="Messages"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <p className="eyebrow">Private conversations</p>
                <h2>Messages</h2>
              </div>
              <button onClick={closeInbox} aria-label="Close messages">
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
                        ? "Loading your conversations..."
                        : "We could not load your conversations."}
                    </h3>
                    <p>
                      {inboxState === "loading"
                        ? "One moment."
                        : "Check your connection and reopen Messages."}
                    </p>
                  </div>
                ) : !visibleThreads.length ? (
                  <div className="inbox-empty">
                    <span>@</span>
                    <h3>Your inbox is ready.</h3>
                    <p>Message a listing owner to start a conversation.</p>
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
                        aria-label="Back to conversations"
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
                          {activeContact.is_demo && " · Automated demo replies"}
                        </small>
                      </div>
                    </div>
                    <div className="message-stream">
                      {!messages.length && (
                        <div className="message-start">
                          <Avatar profile={activeContact} />
                          <h3>Start with something specific.</h3>
                          <p>
                            Mention the listing, your timeline, and what success
                            would look like.
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
                            {TIME_FORMAT.format(new Date(message.created_at))}
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
                        placeholder="Write a message..."
                        rows={2}
                      />
                      <button>Send ↗</button>
                    </form>
                  </>
                ) : (
                  <div className="conversation-placeholder">
                    <span>↗</span>
                    <h3>Choose a conversation</h3>
                    <p>Your private messages will appear here.</p>
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
          <div className={`toast ${toastIsProblem(toast) ? "toast-problem" : ""}`}>
            <span aria-hidden="true">{toastIsProblem(toast) ? "!" : "✓"}</span>
            {toast}
          </div>
        )}
      </div>
    </main>
  );
}
