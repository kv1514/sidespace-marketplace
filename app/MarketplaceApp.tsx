"use client";

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
import {
  localListingSeeds,
  localProfiles,
} from "@/app/localMarketplaceData";

type Role = "consumer" | "business" | "creator" | "space_owner";
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
  audience_age: string;
  website: string;
  avatar_url: string;
  social_links?: Record<string, string>;
  social_verification?: Record<string, string>;
  gallery_urls?: string[];
  verified: boolean;
  verification_status?: "unverified" | "pending" | "verified" | "rejected";
  is_demo: boolean;
  onboarding_complete: boolean;
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

const socialPlatforms = [
  { key: "instagram", label: "Instagram", short: "IG", base: "https://instagram.com/" },
  { key: "tiktok", label: "TikTok", short: "TT", base: "https://tiktok.com/@" },
  { key: "youtube", label: "YouTube", short: "YT", base: "https://youtube.com/@" },
  { key: "facebook", label: "Facebook", short: "FB", base: "https://facebook.com/" },
  { key: "x", label: "X", short: "X", base: "https://x.com/" },
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
  verification_type: "business" | "creator" | "space_owner";
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
  consumer: {
    label: "Campaign shopper",
    short: "Find and book local reach",
    eyebrow: "I’m looking to discover",
    icon: "↗",
  },
  business: {
    label: "Business",
    short: "Find creators and neighborhood spaces",
    eyebrow: "I represent a brand",
    icon: "B",
  },
  creator: {
    label: "Creator",
    short: "List your social audience",
    eyebrow: "I have an online audience",
    icon: "@",
  },
  space_owner: {
    label: "Space owner",
    short: "List a wall, window, car, or room",
    eyebrow: "I have physical reach",
    icon: "⌂",
  },
};

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
function isBrief(listing: Pick<Listing, "channel">) {
  return listing.channel === "Business brief";
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

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
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
  return `${platform.base}${trimmed.replace(/^@/, "")}`;
}

function listingImages(listing: Listing) {
  return listing.image_urls?.length
    ? listing.image_urls
    : [listing.image_url].filter(Boolean);
}

function displayDate(value?: string | null) {
  if (!value) return "Flexible";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function safeProfiles(value: unknown): Profile[] {
  return Array.isArray(value) ? (value as Profile[]) : [];
}

function safeListings(value: unknown): Listing[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Omit<Listing, "owner"> & { owner: Profile | Profile[] }>).map(
    (listing) => ({
      ...listing,
      owner: Array.isArray(listing.owner) ? listing.owner[0] : listing.owner,
    }),
  );
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

function Modal({
  children,
  onClose,
  wide = false,
}: {
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const cardRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
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
      if (!card.contains(document.activeElement)) {
        card.focus({ preventScroll: true });
      }
      if (attempts >= 6) window.clearInterval(focusTimer);
    }, 80);

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(
        card!.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => element.offsetParent !== null);
      if (!items.length) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
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
      // Send focus back where it came from so the page does not lose place.
      if (opener && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [onClose]);

  return (
    <div className="modal-layer" role="presentation" onMouseDown={onClose}>
      <section
        ref={cardRef}
        className={`modal-card ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
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

export default function MarketplaceApp() {
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
  const [profiles, setProfiles] = useState<Profile[]>(demoProfiles);
  const [listings, setListings] = useState<Listing[]>(demoListings);
  const [ownListings, setOwnListings] = useState<Listing[]>([]);
  const [ownListingsLoading, setOwnListingsLoading] = useState(false);
  const [loading, setLoading] = useState(configured);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signup");
  const [accountOpen, setAccountOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(1);
  const [selectedRole, setSelectedRole] = useState<Role>("business");
  const [extraRoles, setExtraRoles] = useState<Role[]>([]);
  const [listingOpen, setListingOpen] = useState(false);
  const [listingFeedback, setListingFeedback] = useState("");
  const [formatPreview, setFormatPreview] = useState("");
  const [editingListing, setEditingListing] = useState<Listing | null>(null);
  const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
  const [deleteAccountError, setDeleteAccountError] = useState("");
  const [igAvatar, setIgAvatar] = useState("");
  const [igAvatarBusy, setIgAvatarBusy] = useState(false);
  const igAvatarSeqRef = useRef(0);
  const igAvatarPromiseRef = useRef<Promise<string> | null>(null);
  const [selectedListing, setSelectedListing] = useState<Listing | null>(null);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState(0);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [threads, setThreads] = useState<
    Array<Conversation & { other: Profile; preview?: string }>
  >([]);
  const [activeThread, setActiveThread] = useState<Conversation | null>(null);
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
  const [blockedProfiles, setBlockedProfiles] = useState<
    Array<{ id: string; display_name: string }>
  >([]);
  const [unreadCount, setUnreadCount] = useState(0);
  // Distinguishes "still loading the profile" from "checked, and there is
  // none" — otherwise a signed-in user without a profile row sits on the
  // loading screen forever.
  const [profileChecked, setProfileChecked] = useState(false);
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
        .select("*")
        .eq("onboarding_complete", true)
        .neq("role", "consumer")
        .order("verified", { ascending: false }),
      supabase
        .from("listings")
        .select("*, owner:profiles!listings_owner_profile_id_fkey(*)")
        .eq("status", "active")
        .order("created_at", { ascending: false }),
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

  const loadAccountMarketplaceState = useCallback(
    async (ownProfile: Profile) => {
      if (!supabase) return;
      const [campaignResult, verificationResult, blocksResult, unreadResult] =
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
          supabase
            .from("messages")
            .select("id", { count: "exact", head: true })
            .neq("sender_profile_id", ownProfile.id)
            .is("read_at", null),
        ]);

      if (!unreadResult.error) {
        setUnreadCount(unreadResult.count ?? 0);
      }

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
      if (!blocksResult.error) {
        const rows = (blocksResult.data ?? []) as unknown as Array<{
          blocked_profile_id: string;
          blocked: { id: string; display_name: string } | null;
        }>;
        setBlockedProfileIds(rows.map((item) => item.blocked_profile_id));
        setBlockedProfiles(
          rows.map((item) => ({
            id: item.blocked_profile_id,
            display_name: item.blocked?.display_name ?? "Member",
          })),
        );
      }
    },
    [supabase],
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
        setProfileChecked(true);
        setToast("We could not load your saved profile. Please refresh and try again.");
        return;
      }
      const own = (data as Profile | null) ?? null;
      setProfileChecked(true);
      if (own) {
        await Promise.all([
          loadOwnListings(own),
          loadAccountMarketplaceState(own),
        ]);
      } else {
        setOwnListings([]);
      }
      setProfile(own);
      // Always seed the picker from the stored profile so no opener can
      // submit a stale role.
      setSelectedRole((own?.role as Role | undefined) ?? "business");
      setExtraRoles((own?.extra_roles as Role[] | undefined) ?? []);
      if (!own?.onboarding_complete) {
        setOnboardingStep(1);
        setOnboardingOpen(true);
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
          if (currentUser) void loadOwnProfile(currentUser);
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
      if (currentUser) {
        window.setTimeout(() => void loadOwnProfile(currentUser), 0);
        if (event === "PASSWORD_RECOVERY") {
          setAccountOpen(true);
          setToast("Choose a new password in Account settings.");
        }
      } else {
        setProfile(null);
        setOwnListings([]);
        setCampaignRequests([]);
        setVerificationRequest(null);
        setBlockedProfileIds([]);
        setAccountOpen(false);
        setThreads([]);
        setActiveThread(null);
        setActiveContact(null);
        setMessages([]);
        setInboxOpen(false);
        igAvatarSeqRef.current += 1;
        igAvatarPromiseRef.current = null;
        setIgAvatar("");
        setIgAvatarBusy(false);
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
    if (!supabase || !profile) return;
    const channel = supabase
      .channel(`inbound-messages:${profile.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload: { new: Record<string, unknown> }) => {
          const incoming = payload.new as unknown as Message;
          if (incoming.sender_profile_id === profile.id) return;
          if (activeThread && incoming.conversation_id === activeThread.id) {
            return;
          }
          setUnreadCount((current) => current + 1);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [activeThread, profile, supabase]);

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
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [activeThread, supabase]);

  /** Real listings lead the hero preview; samples only pad it out. */
  const heroListings = useMemo(
    () =>
      listings
        .slice()
        .sort((a, b) => Number(a.owner.is_demo) - Number(b.owner.is_demo))
        .slice(0, 4),
    [listings],
  );

  const ownerIdsWithListings = useMemo(
    () => new Set(listings.map((listing) => listing.owner.id)),
    [listings],
  );

  /** 0 = real member with listings, 1 = sample, 2 = signed up but empty. */
  function rankPerson(person: Profile) {
    if (!person.is_demo && ownerIdsWithListings.has(person.id)) return 0;
    if (person.is_demo) return 1;
    return 2;
  }

  const channels = useMemo(
    () => ["All", ...Array.from(new Set(listings.map((item) => item.channel)))],
    [listings],
  );

  const visibleListings = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return listings.filter((listing) => {
      if (blockedProfileIds.includes(listing.owner.id)) return false;
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
        channelFilter === "All" || listing.channel === channelFilter;
      const text = `${listing.title} ${listing.channel} ${listing.description} ${listing.demographics} ${listing.owner.display_name} ${listing.owner.city}`.toLowerCase();
      return roleMatches && channelMatches && (!normalized || text.includes(normalized));
    });
  }, [blockedProfileIds, channelFilter, listings, query, roleFilter]);

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

  useEffect(() => {
    if (selectedListing || typeof window === "undefined") return;
    const listingId = new URL(window.location.href).searchParams.get("listing");
    if (!listingId) return;
    const linkedListing = listings.find((listing) => listing.id === listingId);
    if (linkedListing) {
      const timer = window.setTimeout(() => {
        setSelectedPhotoIndex(0);
        setSelectedListing(linkedListing);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    // The link points at a listing that is paused, removed, or hidden by a
    // block. Say so instead of silently showing the home page.
    if (loading || !listings.length) return;
    const timer = window.setTimeout(() => {
      setToast("That listing is no longer available.");
      const url = new URL(window.location.href);
      url.searchParams.delete("listing");
      window.history.replaceState({}, "", url.toString());
    }, 0);
    return () => window.clearTimeout(timer);
  }, [listings, loading, selectedListing]);

  function requireAccount(action: () => void) {
    if (!configured) {
      setToast("Connect Supabase to enable public accounts and messaging.");
      return;
    }
    if (!user) {
      setAuthMode("signup");
      setAuthOpen(true);
      return;
    }
    if (!profile?.onboarding_complete) {
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

    const uploaded: string[] = [];
    for (const file of files) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        throw new Error(`${file.name} must be a JPG, PNG, or WebP image.`);
      }
      if (file.size > 8 * 1024 * 1024) {
        throw new Error(`${file.name} is larger than 8 MB.`);
      }

      const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
      const path = `${user.id}/${folder}/${crypto.randomUUID()}.${extension}`;
      const { error } = await supabase.storage
        .from("marketplace-media")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (error) throw error;

      const { data } = supabase.storage
        .from("marketplace-media")
        .getPublicUrl(path);
      uploaded.push(data.publicUrl);
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
      if (error) return setToast(error.message);
      setAuthOpen(false);
      if (data.session) {
        setUser(data.user);
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
    if (error) return setToast(error.message);
    setUser(data.user);
    setAuthOpen(false);
    setToast("Welcome back.");
  }

  function continueOnboardingDetails(form: HTMLFormElement | null) {
    if (!form) return;

    const requiredFields = [
      { name: "display_name", label: "display name" },
      { name: "city", label: "city or market" },
      { name: "bio", label: "short introduction" },
    ]
      .map(({ name, label }) => ({
        field: form.elements.namedItem(name),
        label,
      }))
      .filter(
        (
          item,
        ): item is {
          field: HTMLInputElement | HTMLTextAreaElement;
          label: string;
        } =>
          item.field instanceof HTMLInputElement ||
          item.field instanceof HTMLTextAreaElement,
      );
    const missingField = requiredFields.find(
      ({ field }) => !field.value.trim(),
    );

    if (missingField) {
      setToast(`Add your ${missingField.label} before continuing.`);
      missingField.field.focus();
      return;
    }

    if (selectedRole === "consumer") {
      form.requestSubmit();
      return;
    }

    setOnboardingStep(3);
  }

  async function signInWithGoogle() {
    if (!supabase) return;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
    if (error) setToast(error.message);
  }

  async function saveOnboarding(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !user) return;
    const values = new FormData(event.currentTarget);
    const categories = String(values.get("categories") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    setBusy(true);
    try {
      const avatarFiles = values
        .getAll("avatar_file")
        .filter((value): value is File => value instanceof File && value.size > 0);
      const galleryFiles = values
        .getAll("gallery_files")
        .filter((value): value is File => value instanceof File && value.size > 0);
      const [avatarUploads, galleryUploads] = await Promise.all([
        uploadImages(avatarFiles.slice(0, 1), "profiles"),
        uploadImages(galleryFiles, "profiles"),
      ]);
      const socialLinks = Object.fromEntries(
        socialPlatforms
          .map((platform) => [
            platform.key,
            normalizeSocialUrl(
              platform,
              String(values.get(`social_${platform.key}`) ?? ""),
            ),
          ])
          .filter(([, url]) => Boolean(url)),
      );
      const syncedIgAvatar = igAvatarPromiseRef.current
        ? await igAvatarPromiseRef.current
        : igAvatar;
      // Every opener seeds selectedRole from the stored profile, so the
      // picker is authoritative and members can genuinely change role.
      const primaryRole = selectedRole;
      const payload = {
        auth_user_id: user.id,
        role: primaryRole,
        extra_roles: Array.from(
          new Set(
            extraRoles.filter(
              (role) => role !== primaryRole && role !== "consumer",
            ),
          ),
        ),
        display_name: String(values.get("display_name") ?? "").trim(),
        handle: String(values.get("handle") ?? "").trim() || null,
        city: String(values.get("city") ?? "").trim(),
        bio: String(values.get("bio") ?? "").trim(),
        categories: values.has("categories")
          ? categories
          : profile?.categories ?? [],
        followers: values.has("followers")
          ? Number(values.get("followers") ?? 0) || 0
          : profile?.followers ?? 0,
        avg_views: values.has("avg_views")
          ? Number(values.get("avg_views") ?? 0) || 0
          : profile?.avg_views ?? 0,
        audience_age: values.has("audience_age")
          ? String(values.get("audience_age") ?? "").trim()
          : profile?.audience_age ?? "",
        website: values.has("website")
          ? String(values.get("website") ?? "").trim()
          : profile?.website ?? "",
        avatar_url:
          avatarUploads[0] ||
          String(values.get("avatar_url") ?? "").trim() ||
          profile?.avatar_url ||
          syncedIgAvatar ||
          String(
            user.user_metadata.avatar_url ?? user.user_metadata.picture ?? "",
          ) ||
          "",
        social_links: values.has("social_instagram")
          ? socialLinks
          : profile?.social_links ?? {},
        // New uploads win the 6-photo cap; otherwise a full gallery would
        // silently swallow (and still bill for) every later upload.
        gallery_urls: Array.from(
          new Set([...galleryUploads, ...(profile?.gallery_urls ?? [])]),
        ).slice(0, 6),
        onboarding_complete: true,
        is_demo: false,
      };

      const result = profile
        ? await supabase
            .from("profiles")
            .update(payload)
            .eq("id", profile.id)
            .select()
            .single()
        : await supabase.from("profiles").insert(payload).select().single();
      if (result.error) throw result.error;

      const savedProfile = result.data as Profile;
      const isFirstSetup = !profile?.onboarding_complete;
      setProfile(savedProfile);
      setOnboardingOpen(false);
      setOnboardingStep(1);
      resetIgAvatarSync();
      await Promise.all([loadMarketplace(), loadOwnListings(savedProfile)]);

      // Straight from signup into the thing they actually came to do, rather
      // than dropping them on a page and asking them to find "New listing".
      const canList = savedProfile.role !== "consumer";
      const hasNoListings = ownListings.length === 0;
      if (isFirstSetup && canList && hasNoListings) {
        setListingFeedback("");
        setEditingListing(null);
        setListingOpen(true);
        setToast("Profile saved. Now put your first space or audience up.");
      } else {
        setToast("Your profile, links, and photos are live.");
      }
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not save your profile.");
    } finally {
      setBusy(false);
    }
  }

  async function saveListing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !profile) return;
    const values = new FormData(event.currentTarget);
    const listingFiles = values
      .getAll("listing_photos")
      .filter((value): value is File => value instanceof File && value.size > 0);
    const fallbackImage =
      editingListing?.image_url ||
      profile.gallery_urls?.[0] ||
      profile.avatar_url ||
      "/photos/market-creator.jpg";
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
        } catch {
          photoWarning =
            " The listing is saved, but the photos could not upload. You can try uploading them again from Edit listing.";
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
        error instanceof Error
          ? error.message
          : "Could not save your listing. Please try again.";
      setListingFeedback(message);
      setToast(message);
    } finally {
      setBusy(false);
    }
  }

  async function loadMessages(conversation: Conversation, contact: Profile) {
    if (!supabase) return;
    setActiveThread(conversation);
    setActiveContact(contact);
    const { data } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversation.id)
      .order("created_at");
    setMessages((data as Message[] | null) ?? []);
    if (profile) {
      const unreadHere = ((data as Message[] | null) ?? []).filter(
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
        setUnreadCount((current) =>
          Math.max(0, current - unreadHere.length),
        );
      }
    }
  }


  async function loadInbox() {
    if (!supabase || !profile) return;
    const { data: conversationData, error } = await supabase
      .from("conversations")
      .select("*")
      .or(
        `participant_a.eq.${profile.id},participant_b.eq.${profile.id}`,
      )
      .order("updated_at", { ascending: false });
    if (error) return setToast(error.message);
    const conversations = (conversationData as Conversation[] | null) ?? [];
    const otherIds = conversations.map((item) =>
      item.participant_a === profile.id
        ? item.participant_b
        : item.participant_a,
    );
    const { data: peopleData } = otherIds.length
      ? await supabase.from("profiles").select("*").in("id", otherIds)
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
      if (inserted.error) return setToast(inserted.error.message);
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
    if (!supabase || !profile || !campaignListing) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const startDate = String(values.get("start_date") ?? "");
    const endDate = String(values.get("end_date") ?? "");
    if (endDate < startDate) {
      setToast("Choose an end date on or after the start date.");
      return;
    }

    setBusy(true);
    const conversation = await ensureConversation(campaignListing.owner);
    if (!conversation) {
      setBusy(false);
      return;
    }

    const campaignName = String(values.get("campaign_name") ?? "").trim();
    const budget = Number(values.get("budget") ?? 0);
    const deliverables = String(
      values.get("requested_deliverables") ?? "",
    ).trim();
    const inserted = await supabase
      .from("campaign_requests")
      .insert({
        listing_id: campaignListing.id,
        requester_profile_id: profile.id,
        owner_profile_id: campaignListing.owner.id,
        conversation_id: conversation.id,
        campaign_name: campaignName,
        goals: String(values.get("goals") ?? "").trim(),
        requested_deliverables: deliverables,
        budget,
        start_date: startDate,
        end_date: endDate,
        notes: String(values.get("notes") ?? "").trim(),
        status: "pending",
      })
      .select()
      .single();

    if (inserted.error) {
      setBusy(false);
      setToast(inserted.error.message);
      return;
    }

    await supabase.from("messages").insert({
      conversation_id: conversation.id,
      sender_profile_id: profile.id,
      body: `Campaign request: ${campaignName}\n${displayDate(startDate)} to ${displayDate(endDate)} · Budget $${budget}\nRequested: ${deliverables}`,
    });

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
      setToast(error.message);
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
      setToast(error.message);
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
      setToast(error.message);
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
      setToast(error.message);
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
      setToast(error.message);
      return;
    }
    setBlockedProfileIds((current) =>
      current.includes(target.id) ? current : [...current, target.id],
    );
    setBlockedProfiles((current) =>
      current.some((item) => item.id === target.id)
        ? current
        : [...current, { id: target.id, display_name: target.display_name }],
    );
    // closeListing() also drops ?listing= from the URL; leaving it would let
    // the deep-link effect immediately reopen the listing just blocked.
    closeListing();
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
      setToast(error.message);
      return;
    }
    setBlockedProfileIds((current) => current.filter((id) => id !== blockedId));
    setBlockedProfiles((current) =>
      current.filter((item) => item.id !== blockedId),
    );
    setToast(`${name} is visible again.`);
    await loadMarketplace();
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !profile || !activeThread) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    const body = String(values.get("body") ?? "").trim();
    if (!body) return;
    const { error } = await supabase.from("messages").insert({
      conversation_id: activeThread.id,
      sender_profile_id: profile.id,
      body,
    });
    if (error) return setToast(error.message);
    form.reset();
  }

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !user) return;
    const form = event.currentTarget;
    const values = new FormData(form);
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

    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) {
      setToast(error.message);
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
      setToast(error.message);
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
      setToast(error.message);
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
    setThreads([]);
    setActiveThread(null);
    setActiveContact(null);
    setMessages([]);
    setInboxOpen(false);
    setAccountOpen(false);
    setOnboardingOpen(false);
    setUnreadCount(0);
    resetIgAvatarSync();
  }

  async function signOut() {
    await supabase?.auth.signOut();
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
      setProfile(data as Profile);

      // Remove the underlying file so it stops being publicly reachable.
      // Only files we uploaded live under this bucket; external URLs are
      // simply dropped from the profile.
      const path = storagePathFromUrl(url);
      if (path) {
        await supabase.storage.from("marketplace-media").remove([path]);
      }
      setToast(
        kind === "avatar" ? "Profile photo removed." : "Photo removed.",
      );
      await loadMarketplace();
    } catch (error) {
      setToast(
        error instanceof Error ? error.message : "Could not remove that photo.",
      );
    } finally {
      setBusy(false);
    }
  }

  function resetIgAvatarSync() {
    igAvatarSeqRef.current += 1;
    igAvatarPromiseRef.current = null;
    setIgAvatar("");
    setIgAvatarBusy(false);
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
      setIgAvatar("");
      return;
    }
    // An uploaded or existing photo always wins; the sync only fills a gap.
    if (profile?.avatar_url) return;
    const fileInput = form?.elements.namedItem("avatar_file");
    if (
      fileInput instanceof HTMLInputElement &&
      (fileInput.files?.length ?? 0) > 0
    ) {
      return;
    }
    setIgAvatarBusy(true);
    const client = supabase;
    const lookup = (async () => {
      try {
        const { data, error } = await client.functions.invoke("ig-avatar", {
          body: { handle },
        });
        if (error) throw error;
        return data && typeof data === "object" && "url" in data
          ? String(data.url ?? "")
          : "";
      } catch {
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
    const incoming = campaignRequests.filter(
      (request) =>
        request.owner_profile_id === profile.id && request.status === "pending",
    ).length;
    const parts: string[] = [];
    if (incoming) {
      parts.push(
        `${incoming} campaign request${incoming === 1 ? "" : "s"} waiting on you`,
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
          <a href="#creators">Creators</a>
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
                  request.status === "pending",
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
                  onClick={() => setOnboardingOpen(true)}
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
                  onClick={() => {
                    setSelectedRole(profile.role);
                    setOnboardingStep(2);
                    setOnboardingOpen(true);
                  }}
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
                  <p>Your space or audience cannot be booked until it is listed.</p>
                </div>
                {!ownListings.length && (
                  <button
                    className="button button-coral button-small"
                    onClick={openListingEditor}
                  >
                    Create listing
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
        <div className="hero-orbit orbit-one" />
        <div className="hero-orbit orbit-two" />
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
                      src={listing.image_url || "/photos/market-creator.jpg"}
                      alt=""
                      fetchPriority="high"
                      decoding="async"
                    />
                    <div>
                      <strong>{listing.title}</strong>
                      <small>
                        {listing.owner.display_name}
                        {listing.owner.city ? ` · ${listing.owner.city}` : ""}
                      </small>
                      <b>
                        ${listing.price}
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

      <section className="signal-strip" aria-label="Marketplace highlights">
        <span>Instagram Stories</span>
        <i>✦</i>
        <span>TikTok features</span>
        <i>✦</i>
        <span>Newsletter mentions</span>
        <i>✦</i>
        <span>Storefront windows</span>
        <i>✦</i>
        <span>Local boards</span>
      </section>

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
          <div className="role-tabs" role="tablist" aria-label="Listing owner type">
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
                className={roleFilter === value ? "active" : ""}
                onClick={() => setRoleFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-row">
          {channels.map((channel) => (
            <button
              key={channel}
              className={channelFilter === channel ? "active" : ""}
              onClick={() => setChannelFilter(channel)}
            >
              {channel}
            </button>
          ))}
          <span className="result-count">{visibleListings.length} open listings</span>
        </div>

        <div className="listing-grid">
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
                <span className="save-button">♡</span>
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
                    <strong>${listing.price}</strong>
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
        {!visibleListings.length && (
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
              onClick={() => {
                if (user) {
                  setSelectedRole(profile?.role ?? "business");
                  setOnboardingStep(1);
                  setOnboardingOpen(true);
                } else {
                  setAuthMode("signup");
                  setAuthOpen(true);
                }
              }}
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
              <span>Dinuba, CA · from $2/day</span>
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
            <p className="section-label">Creators and hosts</p>
            <h2>Small town. <em>Real influence.</em></h2>
          </div>
          <p>
            Rent a creator’s Instagram Story, TikTok reach, or newsletter—or
            book a shopkeeper’s window, counter, vehicle, or land.
          </p>
        </div>
        <div className="people-row">
          {profiles
            .filter((person) => !blockedProfileIds.includes(person.id))
            // Lead with members who actually have something listed, then
            // samples, then anyone who signed up but has not listed yet. The
            // showcase was otherwise entirely sample profiles.
            .slice()
            .sort((a, b) => rankPerson(a) - rankPerson(b))
            .slice(0, 8)
            .map((person) => (
            <article key={person.id} className="person-card">
              <Avatar profile={person} size="large" />
              <span className="person-role">{rolesLabel(person)}</span>
              {person.is_demo && <span className="person-demo">Demo profile</span>}
              {!person.is_demo && person.verified && (
                <span className="person-verified">Verified by SideSpace</span>
              )}
              <h3>{person.display_name}</h3>
              <p>{person.handle || person.city}</p>
              <SocialLinks profile={person} compact />
              {Boolean(person.gallery_urls?.length) && (
                <div className="profile-gallery-preview" aria-label={`${person.display_name} photos`}>
                  {person.gallery_urls?.slice(0, 3).map((url, index) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={`${url}-${index}`} src={url} alt="" loading="lazy" decoding="async" />
                  ))}
                </div>
              )}
              <div className="person-stats">
                <span>
                  <b>{compactNumber(person.followers || person.avg_views)}</b>
                  {person.followers ? " followers" : " weekly looks"}
                </span>
                <span>{person.audience_age}</span>
              </div>
              <button onClick={() => requireAccount(() => void startConversation(person))}>
                Say hello ↗
              </button>
            </article>
            ))}
        </div>
      </section>

      <section className="pricing-section" id="pricing">
        <div className="pricing-intro">
          <div>
            <p className="eyebrow">Pricing</p>
            <h2>Start free. Grow when you are ready.</h2>
          </div>
          <div>
            <span className="pricing-kicker">Planned launch pricing</span>
            <p>
              Early access is free while payments are being built. When paid
              campaigns launch, occasional advertisers can pay per campaign and
              frequent advertisers can lower their fees with Pro.
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
              <li><b>8%</b> per completed campaign</li>
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
                <strong>$49</strong><span>/month</span>
              </p>
              <p>Lower campaign fees and stronger tools for growing brands.</p>
            </div>
            <ul>
              <li><b>3%</b> per completed campaign</li>
              <li>Priority marketplace placement</li>
              <li>Advanced campaign analytics</li>
              <li>Smart partner recommendations</li>
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
            <a className="pricing-button" href="mailto:sidespacesupport@gmail.com">
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
          <a href="#creators">Creators</a>
          <a href="#pricing">Pricing</a>
          <button onClick={openInbox}>Messages</button>
        </nav>
        <small>© {new Date().getFullYear()} SideSpace</small>
      </footer>

      {authOpen && (
        <Modal onClose={() => setAuthOpen(false)}>
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
        <Modal onClose={() => setAccountOpen(false)} wide>
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
                  setSelectedRole(profile.role);
                  setOnboardingStep(1);
                  setOnboardingOpen(true);
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
                              {request.listing?.title ?? "Listing no longer available"}
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
                          {incoming && request.status === "pending" && (
                            <>
                              <button
                                className="button button-dark button-small"
                                disabled={busy}
                                onClick={() =>
                                  void respondToCampaignRequest(request, "accepted")
                                }
                              >
                                Accept
                              </button>
                              <button onClick={() => setCounteringRequest(request)}>
                                Counteroffer
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
                          {listing.channel} • ${listing.price}/{listing.price_unit}
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
              {profile.role !== "consumer" && !profile.verified && !verificationRequest && (
                <button
                  className="button button-dark button-small"
                  onClick={() => setVerificationOpen(true)}
                >
                  Request verification <span>↗</span>
                </button>
              )}
              {verificationRequest?.status === "rejected" && (
                <p className="trust-help">
                  More information is needed. Contact sidespacesupport@gmail.com before resubmitting.
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
          onClose={() => {
            setOnboardingOpen(false);
            resetIgAvatarSync();
          }}
          wide
        >
          <div className="onboarding-top">
            <div>
              <p className="eyebrow">Set up your profile</p>
              <h2>Let’s make the right introductions.</h2>
            </div>
            <div className="step-count">
              <span className={onboardingStep >= 1 ? "active" : ""} />
              <span className={onboardingStep >= 2 ? "active" : ""} />
              {selectedRole !== "consumer" && (
                <span className={onboardingStep >= 3 ? "active" : ""} />
              )}
              <small>
                Step {onboardingStep} of {selectedRole === "consumer" ? 2 : 3}
              </small>
            </div>
          </div>
          <form className="onboarding-form" onSubmit={saveOnboarding}>
            <div className={onboardingStep === 1 ? "form-step active" : "form-step"}>
              <h3>How will you use SideSpace?</h3>
              <p>Choose your main role. You can still browse and message everyone.</p>
              <div className="role-choice-grid">
                {(Object.keys(roleCopy) as Role[]).map((role) => (
                  <button
                    key={role}
                    type="button"
                    className={selectedRole === role ? "active" : ""}
                    onClick={() => {
                      setSelectedRole(role);
                      setExtraRoles((current) =>
                        current.filter((extra) => extra !== role),
                      );
                    }}
                  >
                    <span>{roleCopy[role].icon}</span>
                    <small>{roleCopy[role].eyebrow}</small>
                    <strong>{roleCopy[role].label}</strong>
                    <p>{roleCopy[role].short}</p>
                  </button>
                ))}
              </div>

              {selectedRole !== "consumer" && (
                <div className="role-extra">
                  <p className="role-extra-title">
                    Do you do anything else on SideSpace?
                  </p>
                  <p className="role-extra-help">
                    Pick as many as apply. You will show up in each of these
                    searches, and you can list and book with one account.
                  </p>
                  <div className="role-extra-options">
                    {(["business", "creator", "space_owner"] as Role[])
                      .filter((role) => role !== selectedRole)
                      .map((role) => {
                        const active = extraRoles.includes(role);
                        return (
                          <button
                            key={role}
                            type="button"
                            className={active ? "active" : ""}
                            aria-pressed={active}
                            onClick={() =>
                              setExtraRoles((current) =>
                                active
                                  ? current.filter((extra) => extra !== role)
                                  : [...current, role],
                              )
                            }
                          >
                            <span>{active ? "✓" : roleCopy[role].icon}</span>
                            <strong>{roleCopy[role].label}</strong>
                            <small>{roleCopy[role].short}</small>
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}

              <div className="onboarding-actions">
                <span />
                <button
                  type="button"
                  className="button button-dark"
                  onClick={() => setOnboardingStep(2)}
                >
                  Continue <span>→</span>
                </button>
              </div>
            </div>
            <div className={onboardingStep === 2 ? "form-step active" : "form-step"}>
              <h3>Give your profile a human face.</h3>
              <p>These details help other members know who they’re talking to.</p>
              <div className="field-grid">
                <label>
                  Display name
                  <input
                    name="display_name"
                    required
                    defaultValue={
                      profile?.display_name ||
                      String(user.user_metadata.display_name ?? "")
                    }
                    placeholder="Maya Alvarez"
                  />
                </label>
                <label>
                  Handle or organization
                  <input
                    name="handle"
                    defaultValue={profile?.handle ?? ""}
                    placeholder="@yourhandle"
                  />
                </label>
                <label>
                  City / market
                  <input
                    name="city"
                    required
                    defaultValue={profile?.city ?? ""}
                    placeholder="Oakland, CA"
                  />
                </label>
                <label>
                  Profile photo
                  <input
                    name="avatar_file"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                  />
                  <small>
                    JPG, PNG, or WebP up to 8 MB.
                    {profile?.avatar_url ? " Leave empty to keep your current photo." : ""}
                  </small>
                </label>
                <label className="field-wide">
                  Short introduction
                  <textarea
                    name="bio"
                    required
                    defaultValue={profile?.bio ?? ""}
                    placeholder="Tell people about your audience, business, or space."
                  />
                </label>
                {selectedRole !== "consumer" && (
                  <label className="field-wide media-upload-field">
                    Space, land, storefront, or portfolio photos
                    <input
                      name="gallery_files"
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      multiple
                    />
                    <small>Upload up to 6 clear photos. You can add listing-specific photos later.</small>
                  </label>
                )}
                {Boolean(profile?.gallery_urls?.length) && (
                  <div className="saved-media-grid field-wide">
                    {profile?.gallery_urls?.map((url, index) => (
                      <figure className="saved-media" key={url}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={url}
                          alt={`Saved profile photo ${index + 1}`}
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
                )}
              </div>
              <div className="onboarding-actions">
                <button type="button" onClick={() => setOnboardingStep(1)}>
                  ← Back
                </button>
                <button
                  type="button"
                  className="button button-dark"
                  disabled={busy}
                  onClick={(event) =>
                    continueOnboardingDetails(event.currentTarget.form)
                  }
                >
                  {selectedRole === "consumer"
                    ? busy
                      ? "Saving..."
                      : "Finish my profile"
                    : "Continue"}{" "}
                  <span>{selectedRole === "consumer" ? "✓" : "→"}</span>
                </button>
              </div>
            </div>
            <div
              className={
                selectedRole !== "consumer" && onboardingStep === 3
                  ? "form-step active"
                  : "form-step"
              }
            >
              <h3>
                {selectedRole === "business"
                  ? "What kind of partners fit your brand?"
                  : selectedRole === "creator"
                    ? "Help brands understand your audience."
                    : "Help people picture your reach."}
              </h3>
              <p>Useful details make better matches and fewer awkward messages.</p>
              <div className="field-grid">
                <div className="form-subsection field-wide">
                  <span>Social accounts</span>
                  <h4>Let people verify your real audience.</h4>
                  <p>Paste a full profile link or just your @handle.</p>
                </div>
                {socialPlatforms.map((platform) => (
                  <label key={platform.key}>
                    {platform.label}
                    <input
                      name={`social_${platform.key}`}
                      defaultValue={profile?.social_links?.[platform.key] ?? ""}
                      placeholder={
                        platform.key === "tiktok"
                          ? "@yourtiktok"
                          : `@your${platform.key}`
                      }
                      onBlur={
                        platform.key === "instagram"
                          ? (event) =>
                              void syncInstagramAvatar(
                                event.currentTarget.value,
                                event.currentTarget.form,
                              )
                          : undefined
                      }
                    />
                    {platform.key === "instagram" && igAvatarBusy && (
                      <small>Looking up your Instagram photo...</small>
                    )}
                    {platform.key === "instagram" &&
                      !igAvatarBusy &&
                      Boolean(igAvatar) && (
                        <span className="ig-avatar-preview">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={igAvatar} alt="Instagram profile preview" loading="lazy" decoding="async" />
                          <small>
                            Synced from Instagram — upload a photo in step 2 to
                            use a different one.
                          </small>
                        </span>
                      )}
                  </label>
                ))}
                <label className="field-wide">
                  Categories
                  <input
                    name="categories"
                    defaultValue={profile?.categories.join(", ") ?? ""}
                    placeholder="Food, Local, Lifestyle"
                  />
                  <small>Separate with commas</small>
                </label>
                <label>
                  Followers
                  <input
                    name="followers"
                    type="number"
                    min="0"
                    defaultValue={profile?.followers ?? 0}
                  />
                </label>
                <label>
                  Average views / weekly looks
                  <input
                    name="avg_views"
                    type="number"
                    min="0"
                    defaultValue={profile?.avg_views ?? 0}
                  />
                </label>
                <label>
                  Audience / demographics
                  <input
                    name="audience_age"
                    defaultValue={profile?.audience_age ?? ""}
                    placeholder="Mostly ages 21–34"
                  />
                </label>
                <label>
                  Website
                  <input
                    name="website"
                    defaultValue={profile?.website ?? ""}
                    placeholder="yourwebsite.com"
                  />
                </label>
              </div>
              <div className="onboarding-actions">
                <button type="button" onClick={() => setOnboardingStep(2)}>
                  ← Back
                </button>
                <button
                  className="button button-coral"
                  disabled={busy || igAvatarBusy}
                >
                  {busy
                    ? "Saving..."
                    : igAvatarBusy
                      ? "Syncing photo..."
                      : "Finish my profile"}{" "}
                  <span>✓</span>
                </button>
              </div>
            </div>
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
                <option>Instagram</option>
                <option>TikTok</option>
                <option>YouTube</option>
                <option>Newsletter</option>
                <option>Storefront</option>
                <option>Vehicle</option>
                <option>Wall / mural</option>
                <option>Room / interior</option>
                <option>Business brief</option>
                <option>Other</option>
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
        <Modal onClose={closeListing} wide>
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
                  <strong>{selectedListing.demographics}</strong>
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
                    void navigator.clipboard.writeText(window.location.href);
                    setToast("Listing link copied.");
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
        <Modal onClose={() => setCampaignListing(null)} wide>
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
        <Modal onClose={() => setCounteringRequest(null)}>
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
                min="0"
                required
                defaultValue={counteringRequest.budget}
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
        <Modal onClose={() => setVerificationOpen(false)}>
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
        <Modal onClose={() => setReportTarget(null)}>
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
        <div className="drawer-layer" onMouseDown={() => setInboxOpen(false)}>
          <aside className="inbox-drawer" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <p className="eyebrow">Private conversations</p>
                <h2>Messages</h2>
              </div>
              <button onClick={() => setInboxOpen(false)}>×</button>
            </header>
            <div className="inbox-layout">
              <div className={`thread-list ${activeContact ? "mobile-hide" : ""}`}>
                {!threads.length ? (
                  <div className="inbox-empty">
                    <span>@</span>
                    <h3>Your inbox is ready.</h3>
                    <p>Message a listing owner to start a conversation.</p>
                  </div>
                ) : (
                  threads.map((thread) => (
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
                      {messages.map((message) => (
                        <div
                          key={message.id}
                          className={`message ${
                            message.sender_profile_id === profile?.id ? "mine" : ""
                          }`}
                        >
                          <p>{message.body}</p>
                          <small>
                            {new Intl.DateTimeFormat("en", {
                              hour: "numeric",
                              minute: "2-digit",
                            }).format(new Date(message.created_at))}
                          </small>
                        </div>
                      ))}
                    </div>
                    <form className="message-form" onSubmit={sendMessage}>
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
          <div className="toast">
            <span aria-hidden="true">✓</span>
            {toast}
          </div>
        )}
      </div>
    </main>
  );
}
