// The choices the listing and onboarding forms offer: channels, category and
// surface chips, sponsorship tiers and seasons. Lifted out of MarketplaceApp
// unchanged - same names, same values, same comments - so the component is
// about behaviour and this file is about the catalogue it draws from.
/** Channels offered in the listing editor. A listing may legitimately carry a
 *  channel outside this list (seeded rows, or one set directly in the
 *  database), so the editor also always offers whatever the listing already
 *  has - otherwise editing it would rewrite the channel. */
export const LISTING_CHANNELS = [
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
export const CATEGORY_CHIPS = [
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
export const CREATOR_PLATFORMS = [
  "instagram",
  "tiktok",
  "youtube",
  "x",
  "facebook",
  "newsletter",
  "podcast",
  "twitch",
] as const;

/** The three kinds of offer a creator can publish. The chips below are the
 *  catalogue for exactly these values. */
export type CreatorOfferType = "social" | "physical" | "sponsorship";

/** Every kind of advertising inventory a Creator can bring to SideSpace. */
export const CREATOR_OFFER_TYPES: Array<{
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

export type ListingFormKind = "brief" | CreatorOfferType;


/** Space owner: chip -> the LISTING_CHANNELS value it stores. */
export const SPACE_KIND_CHIPS: Array<{ label: string; channel: string }> = [
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
export const SURFACE_OTHER = "Something else";

export const SURFACE_CHIPS = [
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
export const INSTALL_CHIPS: Array<{
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

export const TRAFFIC_CHIPS: Array<{
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
export const AVAILABILITY_CHIPS: Array<{
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
export const BUSINESS_GOAL_CHIPS: Array<{ label: string; sentence: string }> = [
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
export const BRIEF_SCOPE_CHIPS: Array<{
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
export const BRIEF_PHYSICAL_CHIPS = [
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
export const BRIEF_PLATFORM_CHIPS = [
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


/** Business timing. Sets availability_notes plus the available_from/to window. */
export const BUSINESS_TIMING_CHIPS: Array<{
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
export const DELIVERABLE_EXAMPLES = [
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
export const SPONSOR_ORG_OTHER = "Something else";

export const SPONSOR_ORG_CHIPS = [
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
export const SPONSOR_REACH_CHIPS: Array<{
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




/** Sponsorship window. Sets availability_notes and the date pair. */
export const SPONSOR_SEASON_CHIPS: Array<{
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
