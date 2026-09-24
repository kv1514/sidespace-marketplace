# How the marketplace orders listings

The grid on `/marketplace` is personal. Two people with different browsing
histories see different orders, and the page never says so. This is the model
behind it, where each number lives, and how to check a change against the
live catalogue before shipping it.

## What a visitor sees

- **A first visit** leads with the three permanent picks, then orders the rest
  by what they have earned — stars first, then a week of traffic, then how
  finished the listing is — with the stable shuffle breaking what is left.
  It used to fall straight through to the shuffle, so a stranger, which is
  every business arriving for the first time, saw the catalogue in an order
  that was fair and completely uninformative. `comparePopularListings` now sits
  behind `comparePersonal` in the chain, which is a no-op for anyone with
  history and the whole order for anyone without.
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
  `public.listing_cooccurrence()` how often each candidate was **opened**
  alongside it, and is worth up to `COOCCURRENCE_WEIGHT` (0.6) of a perfect
  categorical fit - enough to speak for a listing whose channel and city say
  nothing, never enough to outrank one they have plainly been choosing. It is
  0 with no index, which is a young catalogue's normal state, and each pair
  is damped by `pairs / COOCCURRENCE_CONFIDENCE` so a single shared visitor
  is a whisper rather than a verdict.

  Openings, not impressions, and that distinction is the whole signal. The
  marketplace puts every active listing on one page, so a visitor who scrolls
  to the bottom sees all of them: count impressions and every pair co-occurs
  with every other pair, which is not a weak signal but a flat one. It shipped
  that way. On production the pair counts ran 12 to 36 for every pair in the
  catalogue, which pinned the confidence floor at 1 so it never damped
  anything, and left `cooccurrenceAffinity` between 0.51 and 0.77 for every
  listing while `tasteFit` ranged 0.03 to 0.35 - so the flat term swamped the
  one the visitor had actually fed, and the quality prior broke the tie.
  Scored for someone who had opened two walls and a car window, it ranked an
  Instagram listing they had never opened above both walls.
  `20260908190000` narrowed both sides of the join and the denominator to
  `kind = 'click'`; the same visitor's walls now come first and second.

## What sorts ahead of all of this

Three things outrank the personal score, and all three are deliberate:

1. **The three permanent picks.** `listings.featured_rank` is a number the
   founders set, and `featuredRank` sorts before everything else in the grid.
   Ten listings carried a rank until `20260924093000`, which is most of the
   first screen: the grid's first ten cards were a hand-written list and the
   ranking only decided the tail. Three is a storefront rather than a
   substitute for the model, and the check constraint is now `between 1 and 3`,
   so "the top three are permanent" is an invariant and not a convention.

   The pins used to switch off the moment anyone typed, on the reasoning that a
   pin ignoring a search is not a highlight. That is true of a pin which does
   not match the search and false of one that does — and the filter runs before
   the comparator, so a pin is only still in the list when it answers what was
   typed. They are unconditional now. Search "wall" and the picks that are not
   walls are simply gone.
2. **What the visitor typed.** `searchRelevance` in `lib/listings/search.ts`.
   See below.
3. **Members, then samples, then briefs.** `listingRank` puts complete member
   listings first, thin ones next, demo accounts after those, and business
   briefs last.
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

## What they typed

A search used to be a filter and nothing else. Every field a listing has was
glued into one string, `text.includes(query)` decided who survived, and the
survivors came back equal — to be ordered by whatever the browsing model
thought of them. So typing "wall" put a listing that mentions a wall in its
*description* above the listing actually called "Room 114 — wall or mural",
because the second happened to be less fresh.

`searchRelevance` is a ladder of kinds of match, highest rung only, and a
listing scores its best rung rather than accumulating them — three passing
mentions must not outrank one title:

| Match | Score |
| --- | --- |
| the title is exactly what they typed | 100 |
| the title starts with it | 70 |
| the title contains it | 55 |
| it is a channel name | 45 |
| every word of it is in the title | 40 |
| the format contains it | 25 |
| the seller's name contains it | 18 |
| the city or area contains it | 14 |
| the description or categories contain it | 8 |
| some of its words are in the title | 6 each |

It is 0 when nothing was typed, so browsing is untouched, and it sits directly
under the picks in the sort chain: a typed search is the one time somebody
states outright what they want, and it outranks everything inferred from what
they have been scrolling past.

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

`popularityScore` in `lib/listings/popularity.ts`:

| Term | Formula | Range |
| --- | --- | --- |
| freshness | `18 / (1 + age in days / 14)` | 0 … 18 |
| **rating** | `(bayesianRating − 3.6) × 12` | **−31 … +17** |
| completeness | 1.5 each for a real title, format and description | 0 … 4.5 |
| trust | 2 for a verified owner | 0 … 2 |
| reach | `ln(1 + clicks_7d) × 5 + ln(1 + impressions_7d) × 1.5` | log-dampened |
| **no real cover** | −9 unless the listing is a business brief | **−9 … 0** |

Two of these are new and both can go **negative**, which is the change worth
remembering: every term used to be additive, so the score answered "how much
has happened to this listing", and a thin listing with a stock photo and a
little traffic could sit above a good one. A rating and a missing photo are the
two signals allowed to say a listing is worse than one nobody knows anything
about. `popularityScore` is therefore signed, and `personalScore` clamps the
prior at `PRIOR_FLOOR` (−0.6) so a demotion stays a demotion instead of
multiplying fit by a negative number and inverting the order.

Reach is a seven-day window on purpose, so a listing has to keep earning its
place, and a week of real traffic still outweighs a small rating edge
(`tests/listing-popularity.test.ts`).

### The rating

`lib/listings/ratings.ts`. Stars replaced the heart in `20260924090000`. A
heart asked whether anybody liked a listing at all — every listing with one
loyal friend won it, and it could only go up. A star asks how good the
placement was, and can go down.

The number that ranks is not the average. A raw mean lets one five-star rating
from the owner's roommate beat forty ratings averaging 4.8, which is how star
ranking usually fails, so the mean is shrunk toward a prior:

```
bayesianRating = (average × count + 3.6 × 6) / (count + 6)
```

- **3.6, not 3.0**, because people rate a marketplace generously — the same
  reason a 4.7 driver is unremarkable and a 4.2 is a warning. A prior at the
  arithmetic middle would flatter every badly-rated listing.
- **An unrated listing returns the prior, not 0.** It is an open question, not
  a bad review. Scoring it zero would rank it below every one-star listing on
  the site, so nothing new would ever collect a first rating.
- Shrinkage is the volume term. At one rating a listing sits most of the way
  back at 3.6; by about twenty it says what its raters said.

The label and the ranking read the same function, and the view returns a count
and a sum rather than an average so the two cannot drift apart through
rounding.

### The cover

`lib/listings/cover.ts`. A listing is penalised when it has no photo of what it
is selling — either no image at all, or **the owner's own profile picture as
the cover**. Three live listings did the second; one of them was a 96-pixel
Google account avatar, a letter on a coloured circle, stretched across a
marketplace card. Nothing was broken and nothing was missing, so no
completeness check caught it: the row has an `image_url`, it is just a picture
of the seller rather than of the wall.

Comparing the cover against `owner.avatar_url` catches that exactly, with no
guessing from dimensions or hosts and no network request. Business briefs are
exempt — a brief is a wanted ad written before there is anything to
photograph.

Nothing is deleted from anybody's listing. The column keeps whatever is in it;
this is only what the interface agrees to show and what the ranking makes of
it. An owner who genuinely wants their face on the card can upload it as a
listing photo.

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
- `listing_rating_stats` — a count and a sum of stars per listing, never an
  average and never a rater.
- `listing_like_counts` — like counts. Still loaded and still shown on the
  owner's dashboard; nothing ranks on it any more.

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
