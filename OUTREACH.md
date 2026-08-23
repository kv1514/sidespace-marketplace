# SideSpace outreach playbook

How the daily cold-outreach pipeline works, what it will and will not do on its own, and the
rules every email has to satisfy.

Operational data (prospect lists, suppression, send history) lives in Supabase, **not** in this
repo — `.gitignore` excludes `outreach/` deliberately, and hundreds of small-business contact
addresses are not application source. This file is the documentation; the data is in the
`outreach` schema of the SideSpace Marketplace project.

---

## Architecture

The pipeline runs in two stages, and the split is forced by a platform constraint worth
understanding before you rely on it:

**A cron-fired Claude session in this org gets no MCP connectors.** No Gmail, no Supabase. It
gets Bash, file tools, and web search. So a scheduled job physically cannot send your email.

| Stage | Runs as | When | Can it send? |
|---|---|---|---|
| **Prep** | Scheduled routine (`trig_01HL982CX9wovp3Q7D2yudPc`) | 9:00 AM PT daily | No — stages the batch |
| **Send** | A Claude session with Gmail | You say "send today's SideSpace batch" | Yes |

### Making it fully autonomous

Create the routine from the **claude.ai Routines UI** instead of the API, and attach the **Gmail**
and **Supabase** connectors to it. A UI-created routine keeps its connectors when it fires, so the
one session does research → select → send → verify → repair with no human step. The prompt to
paste is in [Appendix: autonomous routine prompt](#appendix-autonomous-routine-prompt).

---

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
> https://sidespace-marketplace.vercel.app/
> Not useful? Reply "no thanks" and I won't write again.

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
> counter, you can list it and earn from it. Free to list, no fees during early access.
>
> Any interest in being the first {Berkeley / Oakland / SF} listing?
>
> Kausthubh Veldanda
> Cofounder, SideSpace — Brea, CA
> https://sidespace-marketplace.vercel.app/
> Not useful? Reply "no thanks" and I won't write again.

---

## What changed from the earlier draft, and why

The Aug 22 emails were already strong on the hook. Five things were costing replies:

1. **"Hi there"** when the site names a person. Your best thread — Peri at Simply Bhonu, who
   asked for a call — opened with "Hi Peri."
2. **Ten facts in one paragraph.** The draft crammed in: marketplace, four space types, owner sets
   price, owner approves, free to list, free to browse, no fees, no payment processing, settle
   directly, 26 listings. Cut to four. "We don't process payments, you two settle directly" raises
   a question — *so how do I get paid?* — instead of answering one. Save it for the call.
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

## Appendix: autonomous routine prompt

Paste this into a new routine in the claude.ai Routines UI, schedule `0 16 * * *`, and attach the
**Gmail** and **Supabase** connectors.

<details>
<summary>Full prompt</summary>

```
You are running the SideSpace daily outreach job. Fully autonomous, no human watching.

Context: SideSpace is a marketplace for everyday physical ad space (storefront windows, shop
counters, community boards, car windows). Founders Kausthubh Veldanda and Jeff Sun, Brea CA.
Site: https://sidespace-marketplace.vercel.app/
Send from kveldanda987@gmail.com, CC jeffsun1129@gmail.com on every email.
State lives in the `outreach` schema of Supabase project jlomjbixyemqsruycycz.
Read OUTREACH.md in kv1514/sidespace-marketplace for the templates and rules.

1. DEDUP. Query Gmail `in:sent` (paginate, THREAD_VIEW_METADATA_ONLY) for every address ever
   contacted. Union with `select email, domain from outreach.suppression`. Collect domains too.
2. SELECT 25 from `outreach.prospects where status='queued'` whose email AND website domain are
   in neither set. Cap 3 per city. Fewer than 25 qualifying → send what qualifies, report short.
3. WRITE each email individually per OUTREACH.md. DEMAND template for intent='DEMAND', SUPPLY for
   'SUPPLY'. First sentence built from that prospect's hook, rewritten into natural prose, never
   pasted verbatim. Salutation uses owner_first_name when set. Subject specific, lowercase, under
   8 words. Under 150 words. Signature + opt-out line always.
   HARD RULE: cannot write an opening unmistakably about that business → do not send it.
4. SEND via Gmail, CC Jeff, spaced ~40s apart. Insert each into outreach.sent_log.
5. WAIT 5 minutes (Monitor tool or background sleep, never a foreground bash sleep). Then search
   `from:mailer-daemon newer_than:1h` and match against the batch.
6. REPAIR hard bounces (550, address not found, DNS/MX failure): research that business for a
   current published address on their own site. Found → send once to it, log it. Not found →
   insert into outreach.suppression (category 'hard_bounce') and mark the prospect 'bounced'.
   NEVER retry soft bounces (delay, inbox full, 451). A 451 "unauthenticated" is a sender
   reputation warning — call it out prominently.
7. REPLIES. Any reply containing "no thanks"/"unsubscribe"/"remove me"/"stop" → suppression,
   category 'declined'. Surface genuine human replies for Kausthubh to answer personally.
   NEVER auto-reply to a real person.
   Check outreach.suppression for category='warm_hold' rows whose followup_due has passed and
   flag them urgently.
8. TOP UP. If fewer than 50 queued prospects remain, research more. Each needs a REAL published
   email on the business's own site AND a specific verifiable hook. Missing either → do not add.
   SUPPLY: Berkeley, Oakland, SF. DEMAND: Brea, Fullerton, Placentia, Yorba Linda, La Habra,
   Long Beach, Torrance, El Segundo, San Pedro. Exclude chains and 5+ location businesses.
   Record email_source_url and hook_source_url for every row.
9. REPORT: sent count by city, bounces and what you did about each, human replies needing a
   personal answer, remaining queue depth.

NEVER: email anyone in the do-not-send set; send an email not specific to that business;
auto-reply to a human; exceed 25 new sends; invent an email address.
```

</details>
