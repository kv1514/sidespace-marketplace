"use client";

import dynamic from "next/dynamic";
import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AuthChangeEvent, Session, User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { PUBLIC_PROFILE_COLUMNS } from "@/lib/supabase/public";
import {
  localListingSeeds,
  localProfiles,
} from "@/app/localMarketplaceData";

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
type RoleFilter = "all" | "supply" | Exclude<Role, "consumer">;

type Profile = {
  id: string;
  auth_user_id: string | null;
  role: Role;
  extra_roles?: Role[];
  display_name: string;
  handle: string | null;
  bio: string;
  city: string;
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
  price: number;
  price_unit: string;
  description: string;
  demographics: string;
  image_url: string;
  image_urls?: string[];
  location_area?: string;
  /** Upper end of a budget range; `price` stays the lower end. */
  price_max?: number | null;
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
  budget: number;
  start_date: string;
  end_date: string;
  notes: string;
  status:
    | "pending"
    | "accepted"
    | "declined"
    | "countered"
    | "cancelled"
    | "completed";
  counter_budget: number | null;
  counter_message: string;
  created_at: string;
  updated_at: string;
  // Null once the listing is paused or removed: RLS only exposes active
  // listings to the requester, so the embed comes back empty.
  listing: Pick<Listing, "id" | "title" | "channel" | "price" | "price_unit"> | null;
  requester: Pick<Profile, "id" | "display_name" | "avatar_url" | "city">;
  owner: Pick<Profile, "id" | "display_name" | "avatar_url" | "city">;
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
    short: "Run a campaign with creators, spaces, and local teams",
    eyebrow: "I want to advertise",
    icon: "◆",
  },
  creator: {
    label: "Creator",
    short: "Sell posts, stories, and video to local brands",
    eyebrow: "I have an audience",
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
  "space_owner",
  "sponsor_host",
];

/** Roles that can be held alongside a primary one, per profiles_extra_roles_valid. */
const EXTRA_ROLE_OPTIONS: Role[] = [
  "business",
  "creator",
  "space_owner",
  "sponsor_host",
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
    role: "space_owner",
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
    role: "space_owner",
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
    price: 145,
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
    price: 220,
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
    price: 85,
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
    price: 160,
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
    price: 250,
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
  { label: "Not sure", count: null, sentence: "" },
];

/** Space owner availability. One chip, no date pickers. */
const AVAILABILITY_CHIPS = [
  "Available now",
  "From next month",
  "Seasonal",
  "Ask me",
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
const BUDGET_RANGE_CHIPS: Array<{ label: string; min: number; max: number }> = [
  { label: "$50 – $150", min: 50, max: 150 },
  { label: "$150 – $500", min: 150, max: 500 },
  { label: "$500 – $1,500", min: 500, max: 1500 },
  { label: "$1,500 – $5,000", min: 1500, max: 5000 },
  { label: "$5,000+", min: 5000, max: 25000 },
];

/** Business timing. Sets availability_notes plus the available_from/to window. */
const BUSINESS_TIMING_CHIPS: Array<{ label: string; days: number }> = [
  { label: "Next 2 weeks", days: 14 },
  { label: "This month", days: 30 },
  { label: "Next month", days: 60 },
  { label: "Flexible", days: 90 },
];

/** Suggestion chips for a business's `deliverables`, social placements only. */
const DELIVERABLE_EXAMPLES = [
  "Tag @us",
  "Use our hashtag",
  "Link in bio for 48h",
  "Show the product on camera",
];

/** Sponsorship host: what kind of organisation. Seeds categories and the title. */
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
  { label: "Not sure", count: null, unit: "", sentence: "" },
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

/** Sponsorship window. Sets availability_notes and the date pair. */
const SPONSOR_SEASON_CHIPS: Array<{ label: string; days: number }> = [
  { label: "This season", days: 120 },
  { label: "This semester", days: 150 },
  { label: "One event", days: 30 },
  { label: "Year-round", days: 365 },
];

/** Price presets per role. "Custom" reveals a number input. */
const PRICE_CHIPS: Record<string, number[]> = {
  creator: [50, 150, 300, 600],
  space_owner: [25, 75, 150, 400],
  sponsor_host: [250, 500, 1000, 2500],
};

const PRICE_UNIT_CHIPS: Record<string, string[]> = {
  creator: ["post", "video", "story", "campaign"],
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
type OnboardingAnswers = {
  // Step 1 - identity, asked of every role exactly once.
  display_name: string;
  city: string;
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
  traffic: string;
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
  reach: string;
  benefits: string[];
  season: string;
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
function ChipRow({
  options,
  selected,
  onPick,
  multi = false,
  field,
  label,
}: {
  options: string[];
  selected: string[];
  onPick: (value: string) => void;
  multi?: boolean;
  field: string;
  label: string;
}) {
  return (
    <div
      className="filter-row onboarding-chips"
      data-field={field}
      role="group"
      aria-label={label}
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
  );
}

function emptyAnswers(): OnboardingAnswers {
  return {
    display_name: "",
    city: "",
    bio: "",
    handle: "",
    contact_name: "",
    contact_email: "",
    platforms: [],
    socials: {},
    followers: null,
    title: "",
    format: "",
    price: null,
    price_unit: "",
    description: "",
    categories: [],
    spaceKind: "",
    streetAddress: "",
    location_area: "",
    traffic: "",
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
    reach: "",
    benefits: [],
    season: "",
  };
}

/** Seed the answers from a stored profile so re-entry is not a blank form. */
function answersFromProfile(source: Profile | null): OnboardingAnswers {
  const base = emptyAnswers();
  if (!source) return base;
  return {
    ...base,
    display_name: source.display_name ?? "",
    city: source.city ?? "",
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
  };
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
  if (role === "space_owner") {
    const chip = TRAFFIC_CHIPS.find((item) => item.label === answers.traffic);
    if (!chip || chip.count === null) return { avg_views: null, reach_unit: null };
    return { avg_views: chip.count, reach_unit: "people a day" };
  }
  if (role === "sponsor_host") {
    const chip = SPONSOR_REACH_CHIPS.find((item) => item.label === answers.reach);
    if (!chip || chip.count === null) return { avg_views: null, reach_unit: null };
    return { avg_views: chip.count, reach_unit: chip.unit };
  }
  return { avg_views: null, reach_unit: null };
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
  if (role === "creator") {
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
  if (role === "space_owner") {
    const traffic = TRAFFIC_CHIPS.find((item) => item.label === answers.traffic);
    const where = answers.location_area.trim() || city;
    return [
      answers.spaceKind ? `${answers.spaceKind}${where ? ` at ${where}` : ""}.` : "",
      traffic?.sentence ?? "",
      "It suits a poster, a decal, or a printed card, and I can help put it up.",
      answers.availability ? `Availability: ${answers.availability.toLowerCase()}.` : "",
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
      answers.placements.length
        ? `We're looking for ${joinList(answers.placements.map((p) => p.toLowerCase()))}${city ? ` around ${city}` : ""}.`
        : "",
      answers.price ? `Our budget is $${answers.price}.` : "",
      artwork,
      answers.timing ? `Timing: ${answers.timing.toLowerCase()}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (role === "sponsor_host") {
    const reach = SPONSOR_REACH_CHIPS.find((item) => item.label === answers.reach);
    return [
      answers.orgKind ? `${answers.orgKind}${city ? ` in ${city}` : ""}.` : "",
      bio,
      reach?.sentence ?? "",
      answers.benefits.length
        ? `Sponsors get ${joinList(answers.benefits.map((b) => b.toLowerCase()))}.`
        : "",
      answers.season ? `${answers.season}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return bio;
}

/** The suggested `title`, regenerated as the answers that feed it change. */
function composeTitle(role: Role, answers: OnboardingAnswers): string {
  const name = answers.display_name.trim();
  const city = answers.city.trim();
  if (role === "space_owner") {
    if (!answers.spaceKind) return "";
    return city ? `${answers.spaceKind}, ${city}` : answers.spaceKind;
  }
  if (role === "creator") {
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
  if (role === "sponsor_host") {
    return name ? `${name} — season sponsor` : "";
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
) {
  return touched.title ? answers.title.trim() : composeTitle(role, answers);
}

function effectiveDescription(
  role: Role,
  answers: OnboardingAnswers,
  touched: { description: boolean },
) {
  return touched.description
    ? answers.description.trim()
    : composeDescription(role, answers).trim();
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
) {
  const base = {
    title: effectiveTitle(role, answers, touched).slice(0, 120),
    description: effectiveDescription(role, answers, touched),
    price: answers.price ?? 0,
    price_max: null as number | null,
    format: answers.format.trim(),
    demographics: "",
    location_area: "",
    street_address: "",
    brief_scope: null as string | null,
    target_platforms: [] as string[],
    availability_notes: "",
    available_from: null as string | null,
    available_to: null as string | null,
    deliverables: "",
    channel: "Other",
    price_unit: "campaign",
  };

  if (role === "creator") {
    const primary = answers.platforms[0];
    return {
      ...base,
      channel: socialPlatforms.find((p) => p.key === primary)?.label ?? "Other",
      price_unit: answers.price_unit || "post",
    };
  }

  if (role === "space_owner") {
    const kind = SPACE_KIND_CHIPS.find((item) => item.label === answers.spaceKind);
    const traffic = TRAFFIC_CHIPS.find((item) => item.label === answers.traffic);
    return {
      ...base,
      channel: kind?.channel ?? "Other",
      price_unit: answers.price_unit || "week",
      location_area: answers.location_area.trim(),
      street_address: answers.streetAddress.trim(),
      demographics: traffic?.sentence ?? "",
      availability_notes: answers.availability,
      format:
        base.format ||
        `your ${(answers.spaceKind || "space").toLowerCase()} for a ${answers.price_unit || "week"}`,
    };
  }

  if (role === "business") {
    const timing = BUSINESS_TIMING_CHIPS.find(
      (item) => item.label === answers.timing,
    );
    const scope = answers.briefScope || null;
    // What the card reads after "Looking for". A physical-only brief must not
    // advertise platforms it never asked about, and vice versa.
    const wants = [
      ...(scope !== "virtual" ? answers.placements : []),
      ...(scope !== "physical" ? answers.targetPlatforms : []),
    ].map((item) => item.toLowerCase());
    return {
      ...base,
      channel: "Business brief",
      price_unit: "campaign",
      format: joinList(wants),
      deliverables: answers.deliverables.trim(),
      brief_scope: scope,
      target_platforms: scope !== "physical" ? answers.targetPlatforms : [],
      // Where they want the space, which is not necessarily where they are.
      location_area:
        scope !== "virtual"
          ? answers.wantedArea.trim() || answers.city.trim()
          : "",
      price_max: answers.priceMax ?? null,
      availability_notes: answers.timing,
      available_from: timing ? isoDaysFromToday(0) : null,
      available_to: timing ? isoDaysFromToday(timing.days) : null,
    };
  }

  if (role === "sponsor_host") {
    const season = SPONSOR_SEASON_CHIPS.find(
      (item) => item.label === answers.season,
    );
    const reach = SPONSOR_REACH_CHIPS.find((item) => item.label === answers.reach);
    return {
      ...base,
      channel: "Sponsorship",
      price_unit: "partner",
      format: joinList(answers.benefits.slice(0, 2).map((b) => b.toLowerCase())),
      deliverables: answers.benefits.join("\n"),
      demographics: reach?.sentence ?? "",
      availability_notes: answers.season,
      available_from: season ? isoDaysFromToday(0) : null,
      available_to: season ? isoDaysFromToday(season.days) : null,
    };
  }

  return base;
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
  return roleCopy[role].label;
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
 * A business brief now carries a budget RANGE - `price` is the low end and
 * `price_max` the high end - because "what's your budget" is a band, not a
 * number. Every other listing has a single price and renders unchanged.
 */
function priceLabel(listing: Pick<Listing, "price" | "price_max">) {
  const low = listing.price;
  const high = listing.price_max;
  if (typeof high === "number" && high > low) {
    return `$${low}–$${high}`;
  }
  return `$${low}`;
}

function isBrief(listing: Pick<Listing, "channel">) {
  return listing.channel === "Business brief";
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
function listingIsReady(listing: Listing) {
  return (
    listing.description.trim().length >= 60 &&
    listing.format.trim().length >= 10 &&
    listing.title.trim().length >= 8
  );
}

/** Real and complete first, then real but thin, then samples. */
function listingRank(listing: Listing) {
  if (listing.owner.is_demo) return 2;
  return listingIsReady(listing) ? 0 : 1;
}

/** Every role a profile acts as, primary first. */
function profileRoles(profile: Pick<Profile, "role" | "extra_roles">): Role[] {
  const extras = (profile.extra_roles ?? []).filter(
    (role): role is Role => role !== profile.role,
  );
  return [profile.role, ...extras];
}

function profileHasRole(
  profile: Pick<Profile, "role" | "extra_roles">,
  role: Role,
) {
  return profileRoles(profile).includes(role);
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

function displayDate(value?: string | null) {
  if (!value) return "Flexible";
  return DATE_FORMAT.format(new Date(`${value}T00:00:00Z`));
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

export default function MarketplaceApp({
  initialProfiles = null,
  initialListings = null,
}: {
  /** Server-rendered marketplace, so crawlers and link previews see real
   *  members instead of the seeded demo set. Null when Supabase was
   *  unreachable, in which case the demo seed is used exactly as before. */
  initialProfiles?: unknown;
  initialListings?: unknown;
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
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(1);
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
        answers: { ...emptyAnswers(), ...parsed.answers },
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
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  // A returning member already answered this, and their stored role counts as
  // an answer - otherwise "Edit profile" would refuse to advance until they
  // re-tapped a card they chose months ago.
  const [roleTouched, setRoleTouched] = useState(false);
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
  const [answers, setAnswers] = useState<OnboardingAnswers>(() =>
    emptyAnswers(),
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
  const [listingFiles, setListingFiles] = useState<File[]>([]);
  const [galleryFiles, setGalleryFiles] = useState<File[]>([]);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const onboardingFormRef = useRef<HTMLFormElement | null>(null);
  const [listingOpen, setListingOpen] = useState(false);
  const [listingFeedback, setListingFeedback] = useState("");
  const [formatPreview, setFormatPreview] = useState("");
  const [editingListing, setEditingListing] = useState<Listing | null>(null);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
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
  const [sessionResolved, setSessionResolved] = useState(false);
  const [activeStep, setActiveStep] = useState(0);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [channelFilter, setChannelFilter] = useState("All");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleOAuthEnabled, setGoogleOAuthEnabled] = useState(false);

  const loadMarketplace = useCallback(async () => {
    if (!supabase) return;

    const [profilesResult, listingsResult] = await Promise.all([
      supabase
        .from("profiles")
        .select(PUBLIC_PROFILE_COLUMNS)
        .eq("onboarding_complete", true)
        .neq("role", "consumer")
        .order("verified", { ascending: false })
        // Bounded to match the showcase row, which renders a card per profile.
        .limit(60),
      supabase
        .from("listings")
        .select(
          `*, owner:profiles!listings_owner_profile_id_fkey(${PUBLIC_PROFILE_COLUMNS})`,
        )
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);

    if (!profilesResult.error) {
      const loaded = safeProfiles(profilesResult.data);
      setProfiles(loaded.length ? loaded : demoProfiles);
    }
    if (!listingsResult.error) {
      const loaded = safeListings(listingsResult.data);
      setListings(loaded.length ? loaded : demoListings);
    }
  }, [supabase]);

  const loadOwnListings = useCallback(
    async (ownProfile: Profile) => {
      if (!supabase) return;
      setOwnListingsLoading(true);
      const { data, error } = await supabase
        .from("listings")
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
      const [campaignResult, verificationResult, blocksResult] =
        await Promise.all([
          supabase
            .from("campaign_requests")
            .select(
              "*, listing:listings!campaign_requests_listing_id_fkey(id,title,channel,price,price_unit), requester:profiles!campaign_requests_requester_profile_id_fkey(id,display_name,avatar_url,city), owner:profiles!campaign_requests_owner_profile_id_fkey(id,display_name,avatar_url,city)",
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

  const loadOwnProfile = useCallback(
    async (currentUser: User) => {
      if (!supabase) return;
      const { data, error } = await supabase
        .from("profiles")
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
      const own = (data as Profile | null) ?? null;
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
        const stored = (own?.role as Role | undefined) ?? null;
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
      void Promise.all([supabase.auth.getUser(), loadMarketplace()]).then(
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
  }, [loadMarketplace, loadOwnProfile, supabase]);

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
          String(listing.owner.city ?? "")
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
      const text = [
        listing.title,
        listing.channel,
        listing.description,
        listing.demographics,
        listing.format,
        listing.location_area ?? "",
        listing.owner.display_name,
        listing.owner.city,
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Matches the widget animation cycle so each story finishes before the
    // section moves on.
    const timer = window.setInterval(() => {
      setActiveStep((current) => (current + 1) % 3);
    }, 4600);
    return () => window.clearInterval(timer);
  }, []);

  // The callback route exchanges the recovery code server-side, so the client
  // never sees a PASSWORD_RECOVERY event. The ?recovery=1 marker it redirects
  // back with is what opens the new-password form.
  useEffect(() => {
    if (typeof window === "undefined" || !user) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("recovery") !== "1") return;
    setAccountOpen(true);
    setToast("Choose a new password below.");
    url.searchParams.delete("recovery");
    window.history.replaceState({}, "", url.toString());
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
    setToast(
      "We could not finish signing you in. That link may have expired or been opened in a different browser. Try again below.",
    );
    setAuthMode("signin");
    setAuthOpen(true);
    url.searchParams.delete("authError");
    window.history.replaceState({}, "", url.toString());
  }, []);

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
          .select(
          `*, owner:profiles!listings_owner_profile_id_fkey(${PUBLIC_PROFILE_COLUMNS})`,
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

  /**
   * Seed BOTH role pickers from the stored profile. Openers used to seed only
   * the primary role, so extra roles toggled during an edit the member then
   * abandoned - or left behind by the previous account on a shared device -
   * were still in state and got written on the next save.
   */
  function seedRolePickers(source: Profile | null) {
    const stored = (source?.role as Role | undefined) ?? null;
    // A retired `consumer` row has no card to highlight, so treat it as
    // unanswered and make them choose rather than pre-selecting something they
    // never picked.
    const pickable = stored && PICKABLE_ROLES.includes(stored) ? stored : null;
    setSelectedRole(pickable);
    setRoleTouched(Boolean(pickable));
    setExtraRoles(
      ((source?.extra_roles as Role[] | undefined) ?? []).filter((role) =>
        EXTRA_ROLE_OPTIONS.includes(role),
      ),
    );
    setAnswers(answersFromProfile(source));
    setOnboardingError("");
    // Otherwise a second open keeps treating the generated title and
    // description as hand-written, and stops regenerating them.
    setTitleTouched(false);
    setDescriptionTouched(false);
    setAvatarFile(null);
    setListingFiles([]);
    setGalleryFiles([]);
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
      if (draft.role && PICKABLE_ROLES.includes(draft.role)) {
        setSelectedRole(draft.role);
        setRoleTouched(true);
      }
      setAnswers(draft.answers);
      setTitleTouched(Boolean(draft.answers.title));
      setDescriptionTouched(Boolean(draft.answers.description));
    }
    setOnboardingMode("setup");
    setOnboardingStep(2);
    setOnboardingOpen(true);
  }

  /** Open the modal as the profile editor rather than first-run setup. */
  function openProfileEditor(step: 1 | 2 = 1) {
    seedRolePickers(profile);
    setOnboardingMode("edit");
    setOnboardingStep(step);
    setOnboardingOpen(true);
  }

  function requireAccount(action: () => void) {
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
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { display_name: String(values.get("name") ?? "").trim() },
          emailRedirectTo: `${window.location.origin}/auth/callback`,
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
    setToast("Welcome back.");
  }

  /**
   * Which controls a role must answer before it can publish.
   *
   * Returned as [message, fieldName] so the caller can both explain the problem
   * and put the cursor on it. The old flow toasted and moved on; a toast is
   * gone in four seconds and never says where to look.
   */
  function firstMissingAnswer(): [string, string] | null {
    const role = selectedRole;
    if (onboardingStep === 1) {
      if (!roleTouched || !role) {
        return ["Pick how you’ll use SideSpace first.", "role"];
      }
      if (!answers.display_name.trim()) {
        return ["Add your display name before continuing.", "display_name"];
      }
      if (!answers.city.trim()) {
        return ["Add your city or market before continuing.", "city"];
      }
      if (answers.bio.trim().length < 10) {
        return ["Add one line about you — at least a few words.", "bio"];
      }
      if (role === "business" && !answers.contact_name.trim()) {
        return ["Add your name, so people know who they're writing to.", "contact_name"];
      }
      if (
        role !== "business" &&
        answers.contact_email.trim() &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(answers.contact_email.trim())
      ) {
        return ["That email doesn't look right.", "contact_email"];
      }
      return null;
    }

    // Step 2 in edit mode only ever touches profile fields, all optional.
    if (onboardingMode === "edit" || !role) return null;

    if (role === "creator") {
      if (!answers.platforms.length) {
        return ["Pick at least one place you post.", "platforms"];
      }
      if (answers.format.trim().length < 10) {
        return ["Say what a brand actually gets.", "format"];
      }
    }
    if (role === "space_owner") {
      if (!answers.spaceKind) return ["Pick what kind of space this is.", "spaceKind"];
      if (!answers.streetAddress.trim()) {
        return ["Add the address so people can find it.", "streetAddress"];
      }
      if (!answers.location_area.trim()) {
        return ["Add the area buyers will see on the card.", "location_area"];
      }
      if (!answers.traffic) return ["Pick roughly how busy it is.", "traffic"];
    }
    if (role === "business") {
      // Same order the questions are rendered in, so the error scrolls forward
      // through the pane rather than jumping back past something answered.
      if (!answers.promoting.trim()) {
        return ["Say what you're promoting — a few words is enough.", "promoting"];
      }
      if (!answers.categories.length) {
        return ["Pick what kind of business you are.", "categories"];
      }
      if (!answers.goal) return ["Pick what the campaign should do.", "goal"];
      if (!answers.briefScope) {
        return ["Pick whether you want physical space, social, or both.", "briefScope"];
      }
      if (answers.briefScope !== "virtual") {
        if (!answers.placements.length) {
          return ["Pick the kind of space you want.", "placements"];
        }
        if (!answers.wantedArea.trim()) {
          return ["Say where you want the space.", "wantedArea"];
        }
      }
      if (answers.briefScope !== "physical" && !answers.targetPlatforms.length) {
        return ["Pick at least one platform to target.", "targetPlatforms"];
      }
      if (!answers.timing) return ["Pick when you want it to run.", "timing"];
    }
    if (role === "sponsor_host") {
      if (!answers.orgKind) return ["Pick what kind of organization you are.", "orgKind"];
      if (!answers.reach) return ["Pick roughly how many people will see it.", "reach"];
      if (!answers.benefits.length) {
        return ["Pick what a sponsor gets.", "benefits"];
      }
      if (!answers.season) return ["Pick when the sponsorship runs.", "season"];
    }
    // Validate exactly what the member can see, via the same helpers publish
    // uses - so an emptied field fails here instead of silently republishing
    // the draft they deleted.
    const touched = { title: titleTouched, description: descriptionTouched };
    const shownTitle = effectiveTitle(role, answers, touched);
    const shownDescription = effectiveDescription(role, answers, touched);
    if (!shownTitle.trim()) return ["Give this a title.", "title"];
    if (!answers.price || answers.price < 1) {
      return ["Set a price of at least $1.", "price"];
    }
    if (shownDescription.trim().length < 60) {
      return [
        "Add a bit more detail — a sentence or two is what makes a card worth opening.",
        "description",
      ];
    }
    return null;
  }

  /**
   * Surface a validation failure where the member is actually looking.
   *
   * The primary action is sticky on mobile, so someone can press Publish from
   * below the field that is missing. Scrolling the control into view is what
   * makes a sticky footer safe.
   */
  function reportMissing(problem: [string, string]) {
    const [message, field] = problem;
    setOnboardingError(message);
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

  function advanceOnboarding() {
    const problem = firstMissingAnswer();
    if (problem) {
      reportMissing(problem);
      return;
    }
    setOnboardingError("");
    setOnboardingStep(2);
  }

  async function signInWithGoogle() {
    if (!supabase) return;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
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
    if (!supabase || !user) return;

    const problem = firstMissingAnswer();
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

    setBusy(true);
    let savedProfile: Profile | null = null;
    try {
      // Re-read the stored row before building the payload, every time. It
      // decides insert-vs-update, whether the Google identity photo may be used
      // as a fallback, and gallery_urls merges out of it - so a stale in-memory
      // copy silently overwrites fresher data from another tab.
      const { data: fresh, error: freshError } = await supabase
        .from("profiles")
        .select("*")
        .eq("auth_user_id", user.id)
        .maybeSingle();
      if (freshError) {
        throw new Error(
          "We could not reach your profile just now. Check your connection and try again, nothing was lost.",
        );
      }
      const existing = (fresh as Profile | null) ?? null;
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

      const reach = deriveReach(role, answers);
      // Onboarding no longer asks for a handle - a business gives its business
      // name and everyone else an email - but an existing handle is preserved
      // rather than blanked out from under a legacy member.
      const handle = (answers.handle || existing?.handle || "")
        .trim()
        .replace(/^@/, "");

      const payload = {
        auth_user_id: user.id,
        role,
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
        bio: answers.bio.trim(),
        categories: answers.categories,
        // A null follower count means "not answered", and must not overwrite a
        // number they gave earlier with 0.
        //
        // Clamped here rather than trusting the input: the field that enforces
        // min={0} is only mounted in the creator branch, and a role switch
        // carries `followers` across. A negative number typed as a creator and
        // then switched to Space owner otherwise reaches profiles_followers_check
        // and fails the ENTIRE profile write, with an error naming a field that
        // is no longer on screen.
        followers: Math.max(0, answers.followers ?? existing?.followers ?? 0),
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

      const result = existing
        ? await supabase
            .from("profiles")
            .update(payload)
            .eq("id", existing.id)
            .select()
            .single()
        : await supabase.from("profiles").insert(payload).select().single();
      if (result.error) throw result.error;

      savedProfile = result.data as Profile;
      setProfile(savedProfile);

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
        const draft = buildListingDraft(role, answers, {
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
        const inserted = await supabase
          .from("listings")
          .insert({
            ...draft,
            owner_profile_id: savedProfile.id,
            image_url: cover,
            image_urls: listingUploads.length ? listingUploads : [cover],
            status: "active",
          })
          .select("*")
          .single();
        if (inserted.error) throw inserted.error;

        window.localStorage.removeItem(`sidespace.onboarding.${user.id}`);
        setOnboardingDraft(null);
        setOnboardingOpen(false);
        setOnboardingStep(1);
        resetIgAvatarSync();
        await Promise.all([loadMarketplace(), loadOwnListings(savedProfile)]);
        setToast(
          role === "business"
            ? "Your brief is live. We’ll tell you the moment someone answers."
            : `You’re live. “${draft.title}” is on the marketplace.`,
        );
        return;
      }

      setOnboardingOpen(false);
      setOnboardingStep(1);
      resetIgAvatarSync();
      await Promise.all([loadMarketplace(), loadOwnListings(savedProfile)]);
      setToast("Saved. Your profile is up to date.");
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
        await Promise.all([loadMarketplace(), loadOwnListings(savedProfile)]);
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
        price: Number(values.get("price") ?? 0),
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
      if (!Number.isFinite(fields.price) || fields.price < 0) {
        throw new Error("Enter a price of 0 or more.");
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
            .select("*")
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
            .select("*")
            .single();
      if (saved.error) throw saved.error;

      let savedListing = {
        ...(saved.data as Omit<Listing, "owner">),
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
              .select("*")
              .single();
            if (updated.error) throw updated.error;
            savedListing = {
              ...(updated.data as Omit<Listing, "owner">),
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
        budget,
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
        // Until 0013 there was no UPDATE policy on campaign_requests, so this
        // matched zero rows and still reported success - every request opened
        // alongside a new thread kept conversation_id null forever. Check the
        // outcome now rather than discarding it, and confirm the write landed:
        // RLS makes "denied" and "no such row" both look like an empty result.
        const linked = await supabase
          .from("campaign_requests")
          .update({ conversation_id: conversation.id })
          .eq("id", (inserted.data as { id: string }).id)
          .is("conversation_id", null)
          .select("id");
        if (linked.error || !linked.data?.length) {
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
      proposed_budget: null,
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
        ? "Campaign accepted. Continue the details in Messages."
        : status === "declined"
          ? "Campaign request declined."
          : "Campaign request cancelled.",
    );
    await loadAccountMarketplaceState(profile);
  }

  async function submitCounteroffer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !profile || !counteringRequest) return;
    const values = new FormData(event.currentTarget);
    setBusy(true);
    const { error } = await supabase.rpc("respond_campaign_request", {
      request_id: counteringRequest.id,
      next_status: "countered",
      proposed_budget: Number(values.get("counter_budget") ?? 0),
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

  function clearSessionState() {
    setProfile(null);
    setProfileChecked(false);
    setOwnListings([]);
    setCampaignRequests([]);
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
        .select()
        .single();
      if (error) throw error;
      const updatedProfile = data as Profile;
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
          "Switch your profile to Business, Creator, or Space owner to publish a listing.",
        );
        return;
      }
      setListingFeedback("");
      setFormatPreview("");
      setEditingListing(null);
      setListingOpen(true);
    });
  }

  function openListingEdit(listing: Listing) {
    setListingFeedback("");
    setFormatPreview(listing.format ?? "");
    setEditingListing(listing);
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

  return (
    <main>
      <header className="topbar" id="top">
        <a className="brand" href="#top" aria-label="SideSpace home">
          <span className="brand-mark">S</span>
          <span>SideSpace</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#how">How it works</a>
          <a href="#market">Marketplace</a>
          <a href="#spaces">Physical spaces</a>
          <a href="#creators">Creators &amp; businesses</a>
        </nav>
        <div className="header-actions">
          <button className="text-button" onClick={openInbox}>
            Messages
            {unreadCount > 0 && <b>{unreadCount > 99 ? "99+" : unreadCount}</b>}
          </button>
          {loading ? (
            <span className="account-skeleton" />
          ) : user && profile ? (
            <>
              <button
                className="profile-pill"
                onClick={() => {
                  setAccountOpen(true);
                  void loadOwnListings(profile);
                }}
                aria-label="Open account and settings"
              >
                <Avatar profile={profile} size="small" />
                <span>{profile.display_name}</span>
                <span className="profile-pill-settings">Account</span>
              </button>
              <button
                className="icon-button"
                onClick={() => {
                  setAccountOpen(true);
                  void loadOwnListings(profile);
                }}
                title="Settings"
                aria-label="Account settings"
              >
                ⚙
              </button>
              <button className="button button-ghost button-small" onClick={signOut}>
                Log out
              </button>
            </>
          ) : (
            <>
              <button
                className="text-button desktop-action"
                onClick={() => {
                  setAuthMode("signin");
                  setAuthOpen(true);
                }}
              >
                Sign in
              </button>
              <button
                className="button button-dark button-small"
                onClick={() => {
                  setAuthMode("signup");
                  setAuthOpen(true);
                }}
              >
                Join SideSpace <span>↗</span>
              </button>
            </>
          )}
        </div>
      </header>

      {user && !profile && !profileChecked ? (
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
                onClick={() => {
                  setAccountOpen(true);
                  void loadOwnListings(profile);
                }}
              >
                Settings <span>⚙</span>
              </button>
            </div>
          </div>

          <div className="dashboard-paths" data-reveal>
            <a
              className="dashboard-path"
              href="#market"
              onClick={() => {
                setRoleFilter("business");
                setChannelFilter("All");
              }}
            >
              <span>I&rsquo;m a creator or host</span>
              <strong>See businesses looking for reach</strong>
              <p>
                Browse briefs from businesses that want creators and local
                spaces, then message them directly.
              </p>
              <b>Browse business briefs →</b>
            </a>
            <a
              className="dashboard-path"
              href="#market"
              onClick={() => {
                setRoleFilter("supply");
                setChannelFilter("All");
              }}
            >
              <span>I&rsquo;m a business</span>
              <strong>Pick creators and spaces to book</strong>
              <p>
                Every creator, window, vehicle, and board currently listed —
                choose who fits your campaign and send a request.
              </p>
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
                <a className="button button-ghost button-small" href="#market">
                  Browse
                </a>
              </li>
            )}
          </ol>
        </section>
      ) : (
      <section className="hero">
        <div className="hero-field" aria-hidden="true">
          <HeroCanvas />
        </div>
        <div className="hero-copy">
          <h1 className="hero-headline">
            Get seen
            <br />
            <em>where it matters.</em>
            <span className="type-cursor" aria-hidden="true" />
          </h1>
          <p className="hero-lede">
            SideSpace turns everyday attention into bookable ad space: local
            creators, storefront windows, vehicles, land, and more. Browse
            what is available and message the owner directly.
          </p>
          <div className="hero-actions">
            <a className="button button-dark" href="#market">
              Browse creators and spaces <span>↓</span>
            </a>
            <button
              className="button button-ghost"
              onClick={openListingEditor}
            >
              List what you have <span>＋</span>
            </button>
          </div>
          <div className="hero-trust" aria-label="SideSpace benefits">
            <span>Free to join</span>
            <span>Direct messages</span>
            <span>Digital and physical reach</span>
          </div>
        </div>
        {/* The strongest proof this is real is the real inventory, so the hero
            shows the actual marketplace rather than stock photography. */}
        <div className="hero-stage" aria-label="A preview of live listings">
          <div className="hero-app">
            <div className="hero-app-bar" aria-hidden="true">
              <i />
              <i />
              <i />
              <span>SideSpace</span>
            </div>
            <div className="hero-app-body">
              <aside className="hero-app-side" aria-hidden="true">
                <small>Type of space</small>
                <ul>
                  <li className="on">Storefront</li>
                  <li>Vehicle</li>
                  <li>Community board</li>
                  <li>Social post</li>
                </ul>
                <small>Near</small>
                <p>Orange County</p>
              </aside>
              <div className="hero-app-grid">
                {heroListings.map((listing) => (
                  <article className="hero-app-card" key={listing.id}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={listing.image_url || DEFAULT_LISTING_IMAGE}
                      alt=""
                      width={92}
                      height={69}
                      // The first paint renders demo placeholders that are
                      // thrown away as soon as the real listings load. Claiming
                      // high priority for those made the browser fetch a set it
                      // was about to discard, ahead of the real one.
                      fetchPriority={listing.owner.is_demo ? "low" : "high"}
                      loading={listing.owner.is_demo ? "lazy" : "eager"}
                      decoding="async"
                    />
                    <div>
                      <strong>{listing.title}</strong>
                      <small>
                        {listing.owner.display_name}
                        {listing.owner.city ? ` · ${listing.owner.city}` : ""}
                      </small>
                      <b>
                        {priceLabel(listing)}
                        <span> / {listing.price_unit}</span>
                      </b>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
      )}

      {/* Was five hard-coded labels, three of which named channels nobody
          had actually listed. It now scrolls the real channel list off the
          marketplace, so it can never advertise something that is not for
          sale. Two identical tracks translating -50% make the loop seamless;
          aria-hidden because it is decoration and the same information is
          in the filter chips below, which are reachable and announced. */}
      <section
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
      </section>

      {/* Sits directly above the marketplace, so every figure is derived
          from the same listings the grid renders. Hidden entirely while
          blocks are still loading rather than announcing counts that are
          about to change under the reader. */}
      {!blocksPending && marketplaceStats.listings > 0 && (
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

      <section className="how-section" id="how">
        <div className="how-intro">
          <h2>Find it. Message. <em>Make it happen.</em></h2>
        </div>
        <div className="steps">
          {[
            {
              icon: "⌕",
              title: "Discover",
              copy: "Filter creators, businesses, and spaces by the reach you need.",
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
              title: "Message privately",
              copy: "Talk through the idea, timeline, price, and creative details.",
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
              title: "Make it happen",
              copy: "Agree on the work and build a local campaign people remember.",
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
              onMouseEnter={() => setActiveStep(index)}
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
      </section>

      <section className="market-section" id="market">
        <div className="section-top">
          <div>
            <p className="section-label">Marketplace</p>
            <h2>Find the right audience or <em>spot.</em></h2>
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
            <strong>I have space to offer</strong>
            <small>Find businesses looking to work with you</small>
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
                ["supply", "Space available"],
                ["creator", "Creators"],
                ["space_owner", "Physical spaces"],
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
              : `${visibleListings.length} open listing${visibleListings.length === 1 ? "" : "s"}`}
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
                      {rolesLabel(listing.owner)} · {listing.owner.city}
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
                  <button onClick={() => openCampaignRequest(listing)}>
                    {isBrief(listing) ? "Offer my space" : "Request"}{" "}
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
      </section>

      <section className="spaces-section" id="spaces">
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
      </section>

      <section className="people-section" id="creators">
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
      </section>

      {/* Sits immediately before pricing, because the honest argument for
          the price is the comparison, not the number. A real table rather
          than a grid of divs: it is tabular data, screen readers announce
          the row and column headers, and it stays readable if the CSS never
          loads. */}
      <section className="compare-section" aria-labelledby="compare-heading">
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
                ["Who you deal with", "An agency or an ad platform", "The person who owns the space"],
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
      </section>
      <section className="pricing-section" id="pricing">
        <div className="pricing-intro">
          <div>
            <p className="eyebrow">Pricing</p>
            <h2>Start free. Grow when you are ready.</h2>
            {/* Nothing is charged today and SideSpace does not process
                payments, so these rates have to read as future pricing.
                The Terms say the same thing; the two must not disagree. */}
            <p className="pricing-note">
              SideSpace is free while we are in early access. Nothing below is
              charged yet, and members arrange payment between themselves.
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
              <li><b>No fees</b> during early access</li>
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
            <span className="popular-badge">Best for frequent campaigns</span>
            <div>
              <span className="plan-label">SideSpace Pro</span>
              <h3>Pro</h3>
              <p className="plan-price">
                <strong>$49</strong><span>/month, later</span>
              </p>
              <p>Lower campaign fees and stronger tools for growing brands.</p>
            </div>
            <ul>
              <li>Lower campaign fee when pricing starts</li>
              <li>Priority marketplace placement <i>(planned)</i></li>
              <li>Advanced campaign analytics <i>(planned)</i></li>
              <li>Smart partner recommendations <i>(planned)</i></li>
            </ul>
            <button
              className="pricing-button pricing-button-lime"
              onClick={() => {
                setAuthMode("signup");
                setAuthOpen(true);
              }}
            >
              Start with free early access <span>↗</span>
            </button>
          </article>

          <article className="pricing-card">
            <div>
              <span className="plan-label">Larger advertisers</span>
              <h3>Enterprise</h3>
              <p className="plan-price plan-price-custom">
                <strong>Custom</strong>
              </p>
              <p>Flexible support and pricing for multi-market campaigns.</p>
            </div>
            <ul>
              <li>Custom volume pricing</li>
              <li>Multi-user campaign support</li>
              <li>Priority onboarding</li>
              <li>Additional reporting and service</li>
            </ul>
            <a className="pricing-button" href={`mailto:${SUPPORT_EMAIL}`}>
              Talk with the SideSpace team <span>↗</span>
            </a>
          </article>
        </div>

      </section>

      <section className="final-cta">
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
      </section>

      <footer className="site-footer">
        <a className="brand footer-brand" href="#top">
          <span className="brand-mark">S</span>
          <span>SideSpace</span>
        </a>
        <p>Local reach, made bookable.</p>
        <nav>
          <a href="#how">How it works</a>
          <a href="#market">Marketplace</a>
          <a href="#spaces">Physical spaces</a>
          <a href="#creators">Creators &amp; businesses</a>
          <a href="#pricing">Pricing</a>
          <a href="/terms">Terms</a>
          <a href="/privacy">Privacy</a>
          <button onClick={openInbox}>Messages</button>
        </nav>
        <small>© {new Date().getFullYear()} SideSpace</small>
      </footer>

      {authOpen && (
        <Modal
          elevated
          label={authMode === "signup" ? "Join SideSpace" : "Sign in to SideSpace"}
          onClose={() => setAuthOpen(false)}
        >
          <div className="modal-heading">
            <p className="eyebrow">Your SideSpace account</p>
            <h2>
              {authMode === "signup" ? "Join the network." : "Welcome back."}
            </h2>
            <p>
              {authMode === "signup"
                ? "Browse publicly. Create an account when you’re ready to list or message."
                : "Sign in to manage your profile, listings, and conversations."}
            </p>
          </div>
          {!configured && (
            <div className="setup-notice">
              <strong>Backend connection needed</strong>
              <p>
                This preview is using seeded marketplace data. Add the two
                Supabase environment variables to activate accounts.
              </p>
            </div>
          )}
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
              setAuthMode((mode) => (mode === "signup" ? "signin" : "signup"))
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
                          <span className={`request-status status-${request.status}`}>
                            {request.status}
                          </span>
                        </header>
                        <div className="campaign-request-facts">
                          <span>
                            <small>Dates</small>
                            <b>{displayDate(request.start_date)} – {displayDate(request.end_date)}</b>
                          </span>
                          <span>
                            <small>Budget</small>
                            <b>${request.budget}</b>
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
                        {request.counter_budget != null && (
                          <div className="counter-summary">
                            <strong>
                              {request.status === "accepted"
                                ? `Agreed at $${request.counter_budget}`
                                : `Counteroffer: $${request.counter_budget}`}
                            </strong>
                            {request.counter_message && (
                              <p>{request.counter_message}</p>
                            )}
                          </div>
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
                            <button
                              className="button button-coral button-small"
                              onClick={() => {
                                setAccountOpen(false);
                                openInbox();
                              }}
                            >
                              Continue in Messages
                            </button>
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

      {onboardingOpen && user && (
        <Modal
          elevated
          label={
            onboardingMode === "edit"
              ? "Edit your SideSpace profile"
              : "Set up your SideSpace account"
          }
          onClose={() => {
            setOnboardingOpen(false);
            setOnboardingStep(1);
            setOnboardingError("");
            resetIgAvatarSync();
          }}
          wide
        >
          <div className="onboarding-top">
            <div>
              <p className="eyebrow">
                {onboardingMode === "edit"
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
              <span className={onboardingStep >= 1 ? "active" : ""} />
              <span className={onboardingStep >= 2 ? "active" : ""} />
              <small>Step {onboardingStep} of 2</small>
            </div>
          </div>

          {onboardingMode === "setup" && (
            <div className="setup-notice">
              <strong>Nobody can see you yet.</strong>
              <p>
                Your profile appears in search once you finish this. It is two
                screens.
              </p>
            </div>
          )}

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
                STEP 1 - identity. Identical for all four roles.
                --------------------------------------------------------------- */}
            {onboardingStep === 1 && (
              <div className="form-step active">
                <h3>Which of these is you?</h3>
                <p>This changes what we ask next. You can add more later.</p>
                <div className="role-choice-grid" data-field="role">
                  {PICKABLE_ROLES.map((role) => (
                    <button
                      key={role}
                      type="button"
                      aria-pressed={selectedRole === role}
                      className={selectedRole === role ? "active" : ""}
                      onClick={() => {
                        const switching =
                          selectedRole !== null && selectedRole !== role;
                        setSelectedRole(role);
                        setRoleTouched(true);
                        setOnboardingError("");
                        setExtraRoles((current) =>
                          current.filter((extra) => extra !== role),
                        );
                        // Changing role changes what step 2 asks, and the four
                        // shapes are not interchangeable. Keep the identity
                        // answers - they are role-independent - and drop the
                        // role-shaped ones, or a creator inherits the space
                        // owner's "per week" price unit and a half-built space.
                        if (switching) {
                          setTitleTouched(false);
                          setDescriptionTouched(false);
                          setAnswers((current) => ({
                            ...emptyAnswers(),
                            display_name: current.display_name,
                            city: current.city,
                            bio: current.bio,
                            handle: current.handle,
                            categories: current.categories,
                            platforms: current.platforms,
                            socials: current.socials,
                            followers: current.followers,
                          }));
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

                <div className="field-grid">
                  <label>
                    {selectedRole === "business"
                      ? "Business name"
                      : selectedRole === "sponsor_host"
                        ? "Team or organization name"
                        : selectedRole === "space_owner"
                          ? "Your name or business"
                          : "Your name"}
                    <input
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
                          : selectedRole === "sponsor_host"
                            ? "Brea Robotics 4414"
                            : selectedRole === "space_owner"
                              ? "Maya’s Barbershop"
                              : "Maya Alvarez"
                      }
                    />
                  </label>
                  <label>
                    Where are you based?
                    <small>City and state. This is how buyers filter.</small>
                    <input
                      name="city"
                      data-field="city"
                      maxLength={80}
                      list="onboarding-market-list"
                      value={answers.city}
                      onChange={(event) =>
                        setAnswers((current) => ({
                          ...current,
                          city: event.target.value,
                        }))
                      }
                      placeholder="Brea, CA"
                    />
                  </label>
                  <datalist id="onboarding-market-list">
                    {knownMarkets.map((market) => (
                      <option key={market} value={market} />
                    ))}
                  </datalist>
                  <label className="field-wide">
                    {selectedRole === "business"
                      ? "One line about your business"
                      : selectedRole === "sponsor_host"
                        ? "One line about your team"
                        : selectedRole === "space_owner"
                          ? "One line about you or your business"
                          : "One line about you"}
                    <small>
                      {selectedRole === "business"
                        ? "What you do, in a sentence. This sits under your name on the brief."
                        : selectedRole === "sponsor_host"
                          ? "Who you are and what you do. Sponsors read this first."
                          : "One sentence. It sits under your name on every card."}
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
                          : selectedRole === "sponsor_host"
                            ? "High school robotics team, 28 students, competes statewide."
                            : selectedRole === "space_owner"
                              ? "Corner barbershop with a 6-foot street-facing window."
                              : "Analog fashion and honest city guides for East LA."
                      }
                    />
                  </label>
                  <label className="field-wide media-upload-field">
                    {selectedRole === "business" || selectedRole === "sponsor_host"
                      ? "Add your logo"
                      : "Add a profile photo"}
                    <input
                      ref={avatarInputRef}
                      name="avatar_file"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={(event) =>
                        setAvatarFile(event.target.files?.[0] ?? null)
                      }
                    />
                    <small>
                      Profiles with a face or a logo get far more replies.
                      {profile?.avatar_url
                        ? " Leave empty to keep your current photo."
                        : ""}
                    </small>
                  </label>
                  {/* A business gives the person behind the name; everyone
                      else gives an email. Nobody is asked for an @handle any
                      more - it was a unique-indexed field that meant nothing
                      to the person filling it in. */}
                  {selectedRole === "business" ? (
                    <label>
                      Your name
                      <small>Who a booker is actually writing to.</small>
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
                        placeholder="Kausthubh Veldanda"
                      />
                    </label>
                  ) : (
                    <label>
                      Email
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
                </div>

                <div className="onboarding-actions">
                  <span />
                  <button
                    type="button"
                    className="button button-dark"
                    onClick={advanceOnboarding}
                  >
                    {onboardingMode === "edit"
                      ? "Next: your details"
                      : selectedRole === "business"
                        ? "Next: your campaign"
                        : selectedRole === "creator"
                          ? "Next: what you sell"
                          : selectedRole === "space_owner"
                            ? "Next: your space"
                            : selectedRole === "sponsor_host"
                              ? "Next: your sponsorship"
                              : "Next"}{" "}
                    <span>→</span>
                  </button>
                </div>
              </div>
            )}

            {/* ---------------------------------------------------------------
                STEP 2 - the thing they came to publish.
                Conditionally RENDERED, not display:none, so an unchosen role's
                controls are genuinely absent from the DOM.
                --------------------------------------------------------------- */}
            {onboardingStep === 2 && (
              <div className="form-step active">
                {onboardingMode === "edit" ? (
                  <>
                    <h3>Your details</h3>
                    <p>This is what people see on your profile card.</p>
                    <div className="form-subsection field-wide">
                      <span>Your audience</span>
                      <h4>Where do people follow you?</h4>
                      <p>Only the ones you pick get a field.</p>
                    </div>
                    <ChipRow
                      field="platforms"
                      label="Platforms you post on"
                      multi
                      options={CREATOR_PLATFORMS.map(
                        (key) =>
                          socialPlatforms.find((p) => p.key === key)?.label ?? key,
                      )}
                      selected={answers.platforms.map(
                        (key) =>
                          socialPlatforms.find((p) => p.key === key)?.label ?? key,
                      )}
                      onPick={(label) => {
                        const key =
                          socialPlatforms.find((p) => p.label === label)?.key ?? "";
                        if (!key) return;
                        setAnswers((current) => ({
                          ...current,
                          platforms: current.platforms.includes(key)
                            ? current.platforms.filter((item) => item !== key)
                            : [...current.platforms, key],
                        }));
                      }}
                    />
                    <div className="field-grid">
                      {answers.platforms.map((key) => {
                        const platform = socialPlatforms.find(
                          (item) => item.key === key,
                        );
                        if (!platform) return null;
                        return (
                          <label key={key}>
                            {platform.label}
                            <input
                              value={answers.socials[key] ?? ""}
                              onChange={(event) =>
                                setAnswers((current) => ({
                                  ...current,
                                  socials: {
                                    ...current.socials,
                                    [key]: event.target.value,
                                  },
                                }))
                              }
                              placeholder="@yourhandle"
                            />
                          </label>
                        );
                      })}
                      <label>
                        Your following on your biggest platform
                        <small>Roughly is fine.</small>
                        <input
                          type="number"
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
                          placeholder="18400"
                        />
                      </label>
                      <label className="field-wide media-upload-field">
                        Profile photos
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
                      label="Categories"
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
                      {selectedRole === "creator"
                        ? "What can a brand book from you?"
                        : selectedRole === "space_owner"
                          ? "What space can someone rent?"
                          : selectedRole === "business"
                            ? "What do you want to run?"
                            : "What can a sponsor get?"}
                    </h3>
                    <p>
                      {selectedRole === "creator"
                        ? "One offer is enough to start. You can add more in a minute."
                        : selectedRole === "space_owner"
                          ? "Start with one. A photo and a clear price are what make it bookable."
                          : selectedRole === "business"
                            ? "We’ll post this as a brief. Creators, spaces and local teams answer it — you pick who."
                            : "Sponsors want to know who they’d be backing and what their logo goes on."}
                    </p>

                    {/* ---------------- CREATOR ---------------- */}
                    {selectedRole === "creator" && (
                      <>
                        <div className="form-subsection field-wide">
                          <span>Your audience</span>
                          <h4>Where do people follow you?</h4>
                          <p>Pick your platforms. Only those get a field.</p>
                        </div>
                        <ChipRow
                          field="platforms"
                          label="Platforms you post on"
                          multi
                          options={CREATOR_PLATFORMS.map(
                            (key) =>
                              socialPlatforms.find((p) => p.key === key)?.label ??
                              key,
                          )}
                          selected={answers.platforms.map(
                            (key) =>
                              socialPlatforms.find((p) => p.key === key)?.label ??
                              key,
                          )}
                          onPick={(label) => {
                            const key =
                              socialPlatforms.find((p) => p.label === label)?.key ??
                              "";
                            if (!key) return;
                            setAnswers((current) => ({
                              ...current,
                              platforms: current.platforms.includes(key)
                                ? current.platforms.filter((item) => item !== key)
                                : [...current.platforms, key],
                            }));
                          }}
                        />
                        <div className="field-grid">
                          {answers.platforms.map((key) => {
                            const platform = socialPlatforms.find(
                              (item) => item.key === key,
                            );
                            if (!platform) return null;
                            return (
                              <label key={key}>
                                {platform.label}
                                <input
                                  value={answers.socials[key] ?? ""}
                                  onChange={(event) =>
                                    setAnswers((current) => ({
                                      ...current,
                                      socials: {
                                        ...current.socials,
                                        [key]: event.target.value,
                                      },
                                    }))
                                  }
                                  placeholder="@yourhandle"
                                />
                                {key === "instagram" && (
                                  <button
                                    type="button"
                                    className="button button-small button-ghost"
                                    disabled={igAvatarBusy}
                                    onClick={() =>
                                      void syncInstagramAvatar(
                                        answers.socials.instagram ?? "",
                                      )
                                    }
                                  >
                                    {igAvatarBusy ? "Checking…" : "Check"}
                                  </button>
                                )}
                                {key === "instagram" && igAvatar && (
                                  <span className="ig-avatar-preview">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={igAvatar} alt="" />
                                    <small>
                                      Synced from Instagram — upload your own photo
                                      in step 1 to use a different one.
                                    </small>
                                  </span>
                                )}
                                {key === "instagram" && igStats && (
                                  <small className="ig-sync-note" role="status">
                                    {igStats.throttled
                                      ? "Instagram is rate-limiting us right now. Enter your following below and carry on."
                                      : igStats.error
                                        ? "We couldn’t read that profile. Enter your following below and carry on."
                                        : `Found @${igStats.username} — ${compactNumber(igStats.followers ?? 0)} followers.`}
                                  </small>
                                )}
                              </label>
                            );
                          })}
                          <label>
                            Your following on your biggest platform
                            <small>Roughly is fine. Optional.</small>
                            <input
                              type="number"
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
                              placeholder="18400"
                            />
                          </label>
                        </div>

                        <div className="form-subsection field-wide">
                          <span>Your first offer</span>
                          <h4>What does a brand actually get?</h4>
                        </div>
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
                        <div className="field-grid">
                          <label className="field-wide">
                            What they get
                            <input
                              data-field="format"
                              maxLength={60}
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
                          label="Categories"
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
                            Photos of your work
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              multiple
                              onChange={(event) =>
                                setListingFiles(
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

                    {/* ---------------- SPACE OWNER ---------------- */}
                    {selectedRole === "space_owner" && (
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
                            Exact address
                            <small>
                              Where the space actually is. Bookers need this to
                              judge the spot and to turn up.
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
                          <label className="field-wide">
                            What buyers see on the card
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
                          <label className="field-wide media-upload-field">
                            Photos of the space
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              multiple
                              onChange={(event) =>
                                setListingFiles(
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

                        <div className="form-subsection field-wide">
                          <span>How busy is it?</span>
                          <h4>People who walk past on a normal day.</h4>
                        </div>
                        <ChipRow
                          field="traffic"
                          label="Foot traffic"
                          options={TRAFFIC_CHIPS.map((item) => item.label)}
                          selected={answers.traffic ? [answers.traffic] : []}
                          onPick={(value) =>
                            setAnswers((current) => ({ ...current, traffic: value }))
                          }
                        />

                        <div className="form-subsection field-wide">
                          <span>Price and availability</span>
                          <h4>What does it cost to book?</h4>
                        </div>
                        <ChipRow
                          field="availability"
                          label="Availability"
                          options={AVAILABILITY_CHIPS}
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
                      </>
                    )}

                    {/* ---------------- BUSINESS ---------------- */}
                    {selectedRole === "business" && (
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
                          label="Campaign goal"
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
                                  Where do you want it?
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
                              <div className="offer-examples">
                                {DELIVERABLE_EXAMPLES.map((example) => (
                                  <button
                                    key={example}
                                    type="button"
                                    onClick={() =>
                                      setAnswers((current) => ({
                                        ...current,
                                        deliverables: current.deliverables
                                          ? `${current.deliverables}, ${example}`
                                          : example,
                                      }))
                                    }
                                  >
                                    {example}
                                  </button>
                                ))}
                              </div>
                              <div className="field-grid">
                                <label className="field-wide">
                                  Anything a creator must include?
                                  <input
                                    value={answers.deliverables}
                                    onChange={(event) =>
                                      setAnswers((current) => ({
                                        ...current,
                                        deliverables: event.target.value,
                                      }))
                                    }
                                    placeholder="Tag @us, link in bio for 48h"
                                  />
                                </label>
                              </div>
                            </>
                          )}

                        {/* The artwork they need carried. Uploaded here so a
                            creator or space owner can see exactly what they'd
                            be posting before they answer. */}
                        <div className="form-subsection field-wide">
                          <span>Your artwork</span>
                          <h4>What do you need posted?</h4>
                        </div>
                        <div className="field-grid">
                          <label className="field-wide media-upload-field">
                            Flyer, story, or clip
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              multiple
                              onChange={(event) =>
                                setListingFiles(
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
                          label="Artwork"
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
                            setAnswers((current) => ({
                              ...current,
                              artwork:
                                value === "I’ll supply the artwork"
                                  ? "supply"
                                  : "help",
                            }))
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
                            up to
                            <small>Optional. Leave blank for a flat budget.</small>
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
                          label="Timing"
                          options={BUSINESS_TIMING_CHIPS.map((item) => item.label)}
                          selected={answers.timing ? [answers.timing] : []}
                          onPick={(value) =>
                            setAnswers((current) => ({ ...current, timing: value }))
                          }
                        />
                      </>
                    )}

                    {/* ---------------- SPONSORSHIP HOST ---------------- */}
                    {selectedRole === "sponsor_host" && (
                      <>
                        <div className="form-subsection field-wide">
                          <span>Your organization</span>
                          <h4>What are you?</h4>
                        </div>
                        <ChipRow
                          field="orgKind"
                          label="Organization type"
                          options={SPONSOR_ORG_CHIPS}
                          selected={answers.orgKind ? [answers.orgKind] : []}
                          onPick={(value) =>
                            setAnswers((current) => ({ ...current, orgKind: value }))
                          }
                        />
                        <div className="form-subsection field-wide">
                          <span>Your reach</span>
                          <h4>How many people will see it?</h4>
                        </div>
                        <ChipRow
                          field="reach"
                          label="Reach"
                          options={SPONSOR_REACH_CHIPS.map((item) => item.label)}
                          selected={answers.reach ? [answers.reach] : []}
                          onPick={(value) =>
                            setAnswers((current) => ({ ...current, reach: value }))
                          }
                        />
                        <ChipRow
                          field="season"
                          label="When it runs"
                          options={SPONSOR_SEASON_CHIPS.map((item) => item.label)}
                          selected={answers.season ? [answers.season] : []}
                          onPick={(value) =>
                            setAnswers((current) => ({ ...current, season: value }))
                          }
                        />

                        <div className="form-subsection field-wide">
                          <span>The sponsorship</span>
                          <h4>What does a sponsor get?</h4>
                        </div>
                        <ChipRow
                          field="benefits"
                          label="Sponsor benefits"
                          multi
                          options={SPONSOR_BENEFIT_CHIPS}
                          selected={answers.benefits}
                          onPick={(value) =>
                            setAnswers((current) => ({
                              ...current,
                              benefits: current.benefits.includes(value)
                                ? current.benefits.filter((item) => item !== value)
                                : [...current.benefits, value],
                            }))
                          }
                        />
                        <div className="field-grid">
                          <label className="field-wide media-upload-field">
                            Photos
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              multiple
                              onChange={(event) =>
                                setListingFiles(
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

                    {/* ---------------- shared: title, price, description ------- */}
                    <div className="form-subsection field-wide">
                      <span>
                        {selectedRole === "business"
                          ? "Your brief"
                          : selectedRole === "creator"
                            ? "Your offer"
                            : selectedRole === "space_owner"
                              ? "Your space"
                              : "Your sponsorship"}
                      </span>
                      <h4>
                        {selectedRole === "business"
                          ? "Name the brief and set the budget."
                          : selectedRole === "creator"
                            ? "Name the offer and set your rate."
                            : selectedRole === "space_owner"
                              ? "Name the space and set the rent."
                              : "Name the package and set the tier."}
                      </h4>
                    </div>
                    <div className="field-grid">
                      <label className="field-wide">
                        {selectedRole === "business"
                          ? "Name this brief"
                          : selectedRole === "creator"
                            ? "Name this offer"
                            : selectedRole === "space_owner"
                              ? "Name this space"
                              : "Name this package"}
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
                            }));
                          }}
                          placeholder={
                            selectedRole === "business"
                              ? "Brea Coffee Bar — our new cold brew"
                              : selectedRole === "creator"
                                ? "Instagram Reel — Maya Alvarez"
                                : selectedRole === "space_owner"
                                  ? "Cafe window, Brea"
                                  : "Brea Robotics 4414 — season sponsor"
                          }
                        />
                      </label>
                      {/* A business already gave a budget range above; asking
                          again here would duplicate both the question and the
                          data-field the validator scrolls to. */}
                      {selectedRole !== "business" && (
                      <label>
                        {selectedRole === "sponsor_host"
                          ? "What does one sponsor pay?"
                          : "Price"}
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
                      {selectedRole === "sponsor_host" ? (
                        <p className="offer-preview">per sponsor</p>
                      ) : selectedRole === "business" ? (
                        <p className="offer-preview">Budget is per campaign</p>
                      ) : (
                        <label>
                          Per
                          <select
                            value={
                              answers.price_unit ||
                              (selectedRole === "space_owner" ? "week" : "post")
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
                    {Boolean(PRICE_CHIPS[selectedRole ?? ""]) && (
                      <ChipRow
                        field="price_presets"
                        label="Suggested prices"
                        options={(PRICE_CHIPS[selectedRole ?? ""] ?? []).map(
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
                          : selectedRole === "creator"
                            ? "What does a brand get, in your words?"
                            : selectedRole === "space_owner"
                              ? "What is the space actually like?"
                              : "Why should someone sponsor you?"}
                        <small>
                          {selectedRole === "business"
                            ? "We drafted this from your answers. Say what the artwork is and anything a creator or space owner must know."
                            : selectedRole === "creator"
                              ? "We drafted this from your answers. Add turnaround, what you will not do, anything a brand should know."
                              : selectedRole === "space_owner"
                                ? "We drafted this from your answers. Add the size, what sticks to it, and who walks past."
                                : "We drafted this from your answers. Add what the season looks like and who turns up."}
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
                            }));
                          }}
                        />
                      </label>
                    </div>

                    {/* What they are about to publish, rendered from the live
                        answers. A business sees the Wanted variant because it
                        passes the same isBrief check the real card does, so
                        the preview cannot drift from the marketplace. */}
                    <div className="onboarding-preview field-wide">
                      <span>This is what people will see</span>
                      <div className="preview-card">
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
                              );
                              const offer = draft.format.trim();
                              if (!offer) return "Add what people get above.";
                              return selectedRole === "business"
                                ? `Looking for ${offer}`
                                : `You get ${formatOffer(offer)}`;
                            })()}
                          </span>
                          <div className="preview-card-foot">
                            {selectedRole === "business" && (
                              <span className="preview-lead">Budget</span>
                            )}
                            <b>
                              {priceLabel({
                                price: answers.price ?? 0,
                                price_max: answers.priceMax,
                              })}
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
                                ).price_unit
                              }
                            </small>
                          </div>
                        </div>
                      </div>
                    </div>

                  </>
                )}

                {/* Outside the setup/edit ternary on purpose. Secondary roles
                    drive the role badge and the marketplace filter, and if this
                    only rendered during setup an established member could never
                    add or drop one - the old flow offered it in both modes. */}
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

                <div className="onboarding-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setOnboardingError("");
                      setOnboardingStep(1);
                    }}
                  >
                    ← Back
                  </button>
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
                      : onboardingMode === "edit"
                        ? "Save changes"
                        : selectedRole === "business"
                          ? "Post my brief"
                          : "Publish and finish"}{" "}
                    <span>✓</span>
                  </button>
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
            <div className="form-subsection field-wide">
              <span>The basics</span>
              <h4>What are you offering?</h4>
            </div>
            <label className="field-wide">
              Listing title
              <small>A short name people will see first, like &quot;Cafe window, Main Street&quot;.</small>
              <input
                name="title"
                required
                maxLength={120}
                defaultValue={editingListing?.title ?? ""}
                placeholder="Three-story launch package"
              />
            </label>
            <label>
              Where does it appear?
              <small>The kind of space or platform this runs on.</small>
              <select
                name="channel"
                required
                defaultValue={editingListing?.channel ?? "Instagram"}
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
              What the buyer gets
              <small>
                Finish the sentence <b>&ldquo;You get&hellip;&rdquo;</b> exactly
                as it should read on your card.
              </small>
              <input
                name="format"
                required
                maxLength={60}
                defaultValue={editingListing?.format ?? ""}
                placeholder="three Instagram stories over 48 hours"
                onChange={(event) => setFormatPreview(event.target.value)}
              />
              <span className="offer-preview" aria-live="polite">
                Your card will read:{" "}
                <b>
                  You get{" "}
                  {formatOffer(formatPreview || editingListing?.format || "") ||
                    "…"}
                </b>
              </span>
              <span className="offer-examples">
                {[
                  "three Instagram stories over 48 hours",
                  "one 18 by 24 inch poster, displayed for a week",
                  "a card on the counter for 30 days",
                ].map((example) => (
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
                defaultValue={editingListing?.price ?? ""}
                placeholder="2"
              />
              <small>Start at $2, or set any higher price that fits your placement.</small>
            </label>
            <label>
              Priced per
              <small>What one unit of your price covers.</small>
              <select
                name="price_unit"
                defaultValue={editingListing?.price_unit ?? "campaign"}
              >
                <option value="campaign">campaign</option>
                <option value="day">day</option>
                <option value="week">week</option>
                <option value="post">post</option>
                <option value="video">video</option>
                <option value="mention">mention</option>
                <option value="month">month</option>
                <option value="partner">partner</option>
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
                required
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
                placeholder="1 story, 3 days, or one run"
              />
            </label>
            <div className="form-subsection field-wide">
              <span>Details</span>
              <h4>What buyers will read.</h4>
            </div>
            <label className="field-wide">
              Describe it
              <small>What it is, where exactly it sits, and who walks past.</small>
              <textarea
                name="description"
                required
                defaultValue={editingListing?.description ?? ""}
                placeholder="What’s included, where it appears, and what makes the audience valuable?"
              />
            </label>
            <label className="field-wide">
              What happens after they book
              <small>The proof or finished work you hand back, like photos of the placement.</small>
              <textarea
                name="deliverables"
                required
                defaultValue={editingListing?.deliverables ?? ""}
                placeholder="Describe the post, placement, proof photos, links, or other finished deliverables."
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
            <div className="form-subsection field-wide">
              <span>Audience and photos</span>
              <h4>Show them who they reach.</h4>
            </div>
            <label>
              Who will see it?
              <input
                name="demographics"
                defaultValue={
                  editingListing?.demographics ??
                  profile?.audience_age ??
                  ""
                }
                placeholder="68% ages 21–34 · local"
              />
              <small>Prefilled from your profile — edit if this listing reaches a different audience.</small>
            </label>
            <label className="field-wide media-upload-field">
              {editingListing ? "Add or replace photos" : "Upload listing photos"}
              <input
                name="listing_photos"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
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
              <SocialLinks profile={selectedListing.owner} />
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
                    {selectedListing.location_area || selectedListing.owner.city}
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
                  <strong>${selectedListing.price}</strong>
                  <span> / {selectedListing.price_unit}</span>
                </div>
                <div className="detail-primary-actions">
                  <button
                    className="button button-coral"
                    onClick={() => openCampaignRequest(selectedListing)}
                  >
                    {isBrief(selectedListing)
                      ? "Offer my space"
                      : "Request this placement"}{" "}
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
                defaultValue={campaignListing.price}
              />
            </label>
            <label>
              Listing rate
              <input
                value={`$${campaignListing.price} / ${campaignListing.price_unit}`}
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
                  counteringRequest.counter_budget ?? counteringRequest.budget
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
