# How the marketplace orders listings

The grid on `/marketplace` is personal. Two people with different browsing
histories see different orders, and the page never says so. This is the model
behind it, where each number lives, and how to check a change against the
live catalogue before shipping it.

## What a visitor sees

- **A first visit** shows the members' listings in a stable mixed order
  (samples last, briefs after them), so one fresh post cannot own the top and
  the page does not look sorted by anything in particular.
- **After a little browsing**, the channel the visitor keeps opening comes
  first, their own town keeps meaning something, and likes, reach and
  freshness decide the order inside a channel. Someone who opened three
  Instagram listings sees every Instagram listing before a wall; someone who
  opened two walls and a car window sees the walls, then the car.
- **There is no second row.** A "Picked for you" row used to sit above the
  grid, showing listings that resembled what the visitor had opened, spread
  across channels, one per owner. It was removed: a model built not to be
  noticed does not get a heading naming it, and "Picked for you" said the
  quiet part out loud. Its one signal the grid lacked - co-visits - moved
  into `personalScore`, so the ranking got stronger as the announcement went
  away. A test still fails if copy like "based on what you have been looking
  at" comes back (`tests/i18n.test.ts`).
- **Co-visits** are the one thing that can surprise a visitor usefully: not
  "you like Instagram, here is more Instagram", but "the people who opened
  what you opened went on to open this". `cooccurrenceAffinity` weighs each
  listing they interacted with by its share of their interest, asks
  `private.listing_cooccurrence()` how often each candidate was seen
  alongside it, and is worth up to `COOCCURRENCE_WEIGHT` (0.6) of a perfect
  categorical fit - enough to speak for a listing whose channel and city say
  nothing, never enough to outrank one they have plainly been choosing. It is
  0 with no index, which is a young catalogue's normal state, and each pair
  is damped by `pairs / COOCCURRENCE_CONFIDENCE` so a single shared visitor
  is a whisper rather than a verdict.
- **A sort the visitor chose by hand** ("Location") is left alone.
  Personalisation applies only to the default "Recommended" order.

  There used to be a second hand sort, "Popular now", with a header link of
  its own. It ranked by likes, reach and freshness - all three of which the
  personal ranking already folds in as its quality prior - so it amounted to
  a second, worse copy of the marketplace. It was removed, and the default
  order was renamed from "Latest" to "Recommended", which is what it had
  always been: with no history it falls through to the stable shuffle, never
  to newest-first. A bookmarked `?sort=popular` still opens the marketplace
  in the default order.

## Where the signal comes from

Everything personal is computed in the browser from a short private log in
`localStorage` (`sidespace.affinity`, written by `lib/listings/track.ts`).
Nothing in it is sent anywhere. The server receives impressions and clicks as
counts for the owner's dashboard, deduplicated per listing, kind, visitor key
and UTC day; likes and offers it already has in their own tables.

| Interaction | Weight | Notes |
| --- | --- | --- |
| impression | 1 | the card scrolled into view |
| click | 4 | opened the listing |
| like | 10 | |
| offer | 20 | sent a request |

Weights decay with a half-life of about 14 days (`DECAY_DAYS`), the log keeps
at most 200 events and 60 days, and a listing that has left the catalogue is
ignored because it cannot say what channel it was.

## The taste profile

`buildTasteProfile` in `lib/listings/recommend.ts` folds the per-listing
weights up into a **share per channel and a share per city**. Shares, not
totals: three Instagram clicks and one YouTube click is 75/25 whatever the
absolute numbers, so the lean follows how lopsided the interest is rather than
how much browsing there has been.

`tasteConfidence` ramps from 0 to 1 over two clicks' worth of decayed interest
(`TASTE_CONFIDENCE = 8`), so one glance is not a taste.

## The grid score

For each listing and visitor, `personalScore` is

```
confidence × fit × (1 + prior)

fit   = min(1, tasteFit + 0.6 × cooccurrenceAffinity)
tasteFit = 0.7 × channel share + 0.3 × city share
prior = min(1, popularityScore / 45)                   (PRIOR_CEILING)
```

Popularity **multiplies** fit rather than adding to it. That is the one
decision worth remembering: it lets reach order the Instagram listings for an
Instagram person, but it cannot lift a wall above them however many people
scrolled past that wall this week. An additive blend was tried first and
failed on the live catalogue, where one well-read Instagram post in the
visitor's own town outscored the walls they had actually been opening.

Consequences that are tested in `tests/listing-recommend.test.ts`:

- A stranger scores every listing 0, so the grid keeps its old order.
- A listing on a channel and in a place the visitor never opened also scores
  0. Nothing known, nothing moved.
- Where interest is split evenly, fit ties and likes and reach decide.

The comparator sits in the grid's sort chain in `app/MarketplaceApp.tsx`
after the hand-picked sorts and the members/samples/briefs bands, and before
the stable shuffle that breaks the remaining ties.

## The popularity prior

`popularityScore` in `lib/listings/popularity.ts` is shared by the grid and
the row:

| Term | Formula | Ceiling |
| --- | --- | --- |
| freshness | `18 / (1 + age in days / 14)` | 18 |
| likes | `ln(1 + likes) × 12` | none, log-dampened |
| completeness | 1.5 each for a real title, format and description | 4.5 |
| trust | 2 for a verified owner | 2 |
| reach | `ln(1 + clicks_7d) × 5 + ln(1 + impressions_7d) × 1.5` | none, log-dampened |

One like (about 8.3) still outweighs one click (about 3.5) or ten
impressions (about 3.6): people say more with a heart than with a scroll.
Reach is a seven-day window on purpose, so a listing has to keep earning its
place.

## The "Picked for you" row

`recommendListings` blends four terms, then diversifies:

| Term | Weight | What it is |
| --- | --- | --- |
| content | 62 | resemblance to what they opened: channel, city, IDF-weighted words, price on a log scale |
| co-visits | 40 | "people who looked at that looked at this", from `listing_cooccurrence()`; scaled down until a pair has five co-visits |
| quality | 18 | the popularity prior |
| taste | 25 | channel and city shares, so the row leans the same way the grid does |

Something already opened is kept but multiplied by 0.55. Picks are then made
greedily with a resemblance penalty (`DIVERSITY_LAMBDA = 0.35`) and one
listing per owner, so the row spreads out instead of repeating the grid's
first row. The row is hidden below three items.

## The database side

Ranking needs numbers per listing and never a row about a person. Three
`SECURITY DEFINER` functions and one view provide exactly that, each
repeating the public visibility rules (active, not internal, not suspended,
not demo):

- `listing_reach()` — seven-day distinct impressions and clicks
  (`supabase/migrations/20260905173350_listing_reach.sql`).
- `listing_cooccurrence(seed_ids)` — co-visit counts for the row.
- `listing_like_counts` — like counts.

`listing_events` itself is readable by no client role, and
`supabase/tests/listing_reach.test.sql` asserts both halves: anonymous and
signed-in clients can call the function and cannot read the table. The
Supabase security advisor flags these functions as "public can execute a
SECURITY DEFINER function". That is intentional and the same for all three.

All three loads are best-effort. If one fails, the grid still renders and the
ranking simply has one signal fewer (`mergeListingReach`,
`mergeListingLikeCounts`).

## Changing the weights

Every constant named above lives at the top of its file with a comment
saying what it trades off. Before shipping a change:

1. Run `pnpm test`. The recommend, popularity and reach suites pin the
   guarantees listed here, and each was mutation-tested: break the behaviour
   and a test fails.
2. Check it against the live catalogue. The reliable way is a temporary
   vitest file seeded with the real listings' ranking fields and their
   seven-day reach (`select ... from listings join listing_reach() ...`),
   plus a few imagined visitors: an Instagram person, a physical-space
   person, a stranger. Print the orders and read them. That is how the
   additive blend was caught.
3. Do not add copy that tells the visitor they are being watched.
