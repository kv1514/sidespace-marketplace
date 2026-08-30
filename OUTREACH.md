# SideSpace outreach playbook

How the daily cold-outreach pipeline works, what it will and will not do on its own, and the
rules every email has to satisfy.

Operational data (prospect lists, suppression, send history) lives in Supabase, **not** in this
repo — `.gitignore` excludes `outreach/` deliberately, and hundreds of small-business contact
addresses are not application source. This file is the documentation; the data is in the
`outreach` schema of the SideSpace Marketplace project.

---

## Status: not yet automated

The daily routine exists but is **disabled**, because of a platform constraint worth
understanding before relying on it.

**A cron-fired Claude session in this org gets no MCP connectors.** No Gmail, no Supabase. It
gets Bash, file tools, and web search. So a scheduled job can neither send the email nor read
the prospect queue out of Supabase. Attaching connectors via the API is rejected outright
(`the connectors parameter is not available for this organization`).

Routine `trig_01HL982CX9wovp3Q7D2yudPc` is therefore disabled rather than left firing daily
into a no-op. Its prompt is already correct and will work the moment it has connectors.

### To make it run

Recreate it from the **claude.ai Routines UI**, schedule `0 16 * * *`, and attach the **Gmail**
and **Supabase** connectors. A UI-created routine keeps its connectors when it fires, so one
session does select → write → send → verify → repair with no human step. The prompt to paste is
in [Appendix](#appendix-routine-prompt).

### Until then

Say **"send today's SideSpace batch"** in a Claude session that has Gmail and Supabase. It runs
the same nine steps interactively — roughly a minute of your attention, and everything else is
identical.

## The rule that matters most

**Every email opens on one specific, verifiable detail about that business.** Not a category
observation — a detail that proves someone read their site. No hook, no send: the prospect stays
queued rather than receiving something generic. A skipped prospect costs nothing; a generic
email costs the address and the reputation.

| Good hook | Why it works |
|---|---|
| "Your site still says *Formerly Known As Suzanne's Dance Factory*" | Only true of them |
| "Using actual geosmin so the Petrichor candle smells like real rain" | Specific and checkable |
| "Roughly 280 hand-decorated cakes every weekend, family-run since 1984" | Concrete number |
| "Space rental sits in your top nav, not buried on a contact page" | Shows real reading |
| "Read a book, pet a cat, save the world" | Quotes their own line back |

| Bad hook | Why it fails |
|---|---|
| "You're a family-owned bakery" | True of ten thousand businesses |
| "I love what you're doing" | Says nothing |
| "Your reviews are great" | Writable without ever visiting the site |

---

## Two tracks, because inventory is not evenly distributed

- **DEMAND** — Brea, Fullerton, OC, Long Beach, Torrance, South Bay. 26 live listings nearby.
  Pitch: *book* ad space.
- **SUPPLY** — Berkeley, Oakland, SF. Zero listings. Pitch: *list* your own space and earn.

Sending the DEMAND email to a Berkeley cafe advertises inventory 400 miles away. The "26 listings
around Southern California" line reads as irrelevant, and it is.

### Email structure (both tracks)

1. **Hook** — the specific detail. First sentence. No "I hope this finds you well."
2. **Consequence** — one sentence connecting that detail to a local-attention problem they
   actually have. This is the whole argument.
3. **What SideSpace is** — four facts maximum. Owner sets price, owner approves, free during
   early access, and the one number that matters.
4. **One ask** — specific, tied to their situation. Not two asks.
5. **Signature** — name, role, company, city, opt-out.

Under 150 words.

### DEMAND template (SoCal)

> **Subject:** since you're pickup and markets only
>
> Hi {FirstName},
>
> I was looking through {Business} and the thing that stuck with me is {HOOK}. That's a real
> choice, and it means everything rides on people a few miles away knowing you exist.
>
> That's the problem my cofounder Jeff and I built SideSpace for. It's a marketplace for everyday
> ad space — the window of the shop down the street, a counter by someone's register, a community
> board. The owner sets the price and approves you before anything goes up. 26 spaces are live
> around Southern California, and it's free during early access.
>
> Worth ten minutes to see if any of them are near {their pickup spot / storefront / market}?
>
> Kausthubh Veldanda
> Cofounder, SideSpace — Brea, CA
> sidespace-marketplace.vercel.app/?p={PROSPECT_ID}
> Not useful? Reply "no thanks" and I won't write again.

### The link carries their prospect id

`?p={PROSPECT_ID}` is the `outreach.prospects.id` uuid for the row you are
sending to. It is not tracking — it is what makes the site know who arrived.

Opening it prefills onboarding with their business name and town, and puts them
in the right flow (SUPPLY lands on Creator, DEMAND on Business), so a
salon owner who got a personal email is not then asked to type her own salon's
name into a blank form. Everything is editable and the pane says where it came
from.

Resolved server-side by `public.invite_prospect(uuid)`, which returns only the
six fields already public on their website. Their email address, the hook we
wrote, and the URLs we researched are NOT returned — the link gets forwarded,
and none of our notes should travel with it.

Send without the `?p=` and nothing breaks; they just get the ordinary blank
flow, which is what every email before today did.

### SUPPLY template (Bay Area)

Leads with honesty about being early there, and turns that into the ask.

> **Subject:** the Sc'affle problem
>
> Hi {FirstName},
>
> {HOOK}. That's a nice thing to have and an awkward thing to tell anyone, because the only way
> most people find out is by already being in the room.
>
> That's roughly why my cofounder Jeff and I built SideSpace — a marketplace for everyday ad
> space. Storefront windows, counters by the register, community boards. Owners list what they've
> got, set their own price, and approve each request before anything goes up.
>
> We're live around Southern California and only just starting in the East Bay, which is why
> you're getting a real email instead of a launch announcement. If you've got a window or a bit of
> counter, you can list it and earn from it. It is free to list; SideSpace deducts a clear 5% creator fee only when a paid campaign happens.
>
> Any interest in being the first {Berkeley / Oakland / SF} listing?
>
> Kausthubh Veldanda
> Cofounder, SideSpace — Brea, CA
> sidespace-marketplace.vercel.app/?p={PROSPECT_ID}
> Not useful? Reply "no thanks" and I won't write again.

---

## What changed from the earlier draft, and why

The Aug 22 emails were already strong on the hook. Five things were costing replies:

1. **"Hi there"** when the site names a person. Your best thread — Peri at Simply Bhonu, who
   asked for a call — opened with "Hi Peri."
2. **Ten facts in one paragraph.** The draft crammed in: marketplace, four space types, owner sets
   price, owner approves, free to list, free to browse, fees, Stripe processing, payouts, and 26
   listings. Cut to four. If payment comes up, say it plainly: businesses pay 5%, creators pay 5%,
   and Stripe handles the secure checkout and payout.
3. **Doubled ask.** "Any chance you're up for a 10 minute call? Email works if that's easier."
   Two options is a decision; one is a yes/no. And "any chance you're up for" pre-apologizes.
4. **No signature block.** Commercial email needs a real identity and an opt-out — CAN-SPAM, and
   also just what a real company's email looks like. A bare "Kausthubh" reads like a side project.
5. **Generic ask.** "A 10 minute call" → "worth ten minutes to see if any of them are near your
   pickup spot?" ties the ask back to the hook.

---

## Guardrails

- **One business, one email, ever.** Dedup is by address *and* by website domain, so a business
  already emailed at `info@` is never re-emailed at `hello@`. Enforced by a unique index on the
  normalized domain. This is what would have prevented Pup & Pop getting two different emails two
  hours apart on Aug 22.
- Never emails anyone in `outreach.suppression`.
- No verified hook → no send.
- Every email carries an opt-out line; replies containing "no thanks", "unsubscribe", "remove",
  or "stop" are suppressed on the next run.
- Hard cap 25 per batch. Bounce-repair sends count against the next day's 25.
- Hard bounces get one re-research and one retry at a new address. Soft bounces (delay, inbox
  full, 451) are never retried.

## Data model

`outreach` schema, isolated from `public` so PostgREST never exposes it:

- **`prospects`** — the queue. `email_source_url` and `hook_source_url` record where each was
  found, so a bad entry is traceable rather than mysterious.
- **`suppression`** — never-send list, categorized `hard_bounce` / `soft_bounce` / `declined` /
  `warm_hold` / `other_project`.
- **`sent_log`** — every send with its body, template, and delivery outcome.

## Schedule and daylight saving

Cron is UTC and has no DST awareness. Set to `0 16 * * *` = **9:00 AM PDT**.

**On 2026-11-01 California returns to PST and this starts firing at 8:00 AM.** Change to
`0 17 * * *` that week to hold it at 9:00.

## Open risks

1. **No sending domain.** Every email links `sidespace-marketplace.vercel.app`. To a shop owner
   deciding whether to hand you their window, that reads as unfinished. A real domain is ~$12/yr
   and is the cheapest credibility gain available.
2. **Personal Gmail, no SPF/DKIM/DMARC.** There is already a `451 mail received as unauthenticated`
   rejection from Aug 18 in the inbox — that is a receiving server questioning your sending
   authentication, not a bad address. Gmail's free ceiling is 500 recipients/day so 25 is well
   under the hard limit, but cold-send *patterns* trigger rate limiting, not just volume. If
   bounces spike or replies stop, this is why.
3. **Bounce rate.** 12 hard/soft bounces out of ~200 sends is roughly 6%. Above ~2% is where
   reputation starts to degrade. The verify-before-queue step exists to pull this down.

---

## Appendix: routine prompt

The authoritative prompt lives on routine `trig_01HL982CX9wovp3Q7D2yudPc` — read it with
`list_triggers` rather than copying a duplicate that drifts out of sync. It covers, in order:

1. Build the do-not-send set from Gmail `in:sent` unioned with `outreach.suppression`.
2. Select 25 queued prospects, deduped by address *and* domain, capped at 3 per city.
3. Write each email individually from the templates above, gated on a verified hook.
4. Send spaced ~40s apart, CC Jeff, logging to `outreach.sent_log`.
5. Wait 5 minutes, then match `from:mailer-daemon newer_than:1h` against the batch.
6. Repair hard bounces with one re-researched address; never retry soft bounces.
7. Suppress opt-outs; surface human replies for a personal answer; flag `warm_hold` rows due.
8. Top up the queue when it drops below 50, with source URLs on every row.
9. Report sends by city, bounces, replies needing attention, remaining depth.

It opens with a precondition that halts the run if the Gmail and Supabase tools are absent,
so a misconfigured routine reports the misconfiguration instead of half-running.
