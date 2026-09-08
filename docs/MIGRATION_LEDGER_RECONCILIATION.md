# Migration ledger reconciliation

`PAYMENTS_RUNBOOK.md` step 1 says: if the hosted project has migration versions
that are not present in this checkout, stop and reconcile the history with a
reviewed plan, and never run `migration repair` blindly. That condition is
true today. This is the reviewed plan.

Audited 2026-09-07 against project `jlomjbixyemqsruycycz` (SideSpace
Marketplace, Postgres 17.6). Every query in the audit was read-only.

## Do not run `supabase db push` before doing this

`db push` applies, in version order, every repo migration whose version is
absent from `supabase_migrations.schema_migrations`. Ten pre-existing
migrations qualify. The first of them,
`20260901073500_fix_anon_listings_select_policy.sql`, would:

1. drop `"Active listings are public"` and re-create it as
   `using (status = 'active')`. Production currently holds the hardened
   version from `20260904055617`, which also excludes internal and suspended
   owners. `20260904055617` is already recorded as applied, so it would not
   re-run to repair the damage.
2. create `"Members read their own listings"`, a policy that `20260901151530`
   and `20260901163842` deliberately dropped and which production does not
   have. It has no `drop policy if exists` in front of it.

The net effect of a push today is a silent weakening of row-level security on
`public.listings`. Nothing else in the backlog is destructive; the rest is
bookkeeping.

## What is actually wrong, and what is not

The schemas agree. The migration directory, applied in order to an empty
database, reproduces production's `public` and `private` schemas exactly:

| Section    | Production        | Repo applied from empty |
| ---------- | ----------------- | ----------------------- |
| columns    | 505, `56b9078e…`  | 505, `56b9078e…`        |
| policies   | 37, `0970ec9e…`   | 37, `0970ec9e…`         |
| functions  | 91, `9138304473…` | 91, `9138304473…`       |

Fingerprints are `md5` over the sorted signatures: for columns, schema, table,
column, type, nullability and default; for policies, the table, name, roles,
command and the deparsed `USING` / `WITH CHECK`; for functions, the identity
signature, `prosecdef` and `proconfig`. Extension-owned functions are
excluded, since `pgcrypto` lives in `extensions` on Supabase.

Only the **ledger** disagrees. That distinction is the whole basis of this
plan: `migration repair --status applied` records that something already
happened, so it is only honest when the effects are genuinely present. The
table above is the evidence that they are. Re-run it before doing anything, and
abort if it does not still match.

## How the drift happened

Several migrations were applied through the Supabase MCP `apply_migration`
tool, which stamps a fresh timestamp version, rather than through
`supabase db push`, which uses the filename's version. The same migration then
exists twice: once in the repo under its filename version, once in the ledger
under the timestamp of the moment it was applied. Three of them were applied
twice outright.

This is also what caused the bug fixed in
`20260907100000_my_listings_carries_the_booking_terms.sql`:
`20260903073844` reached the database after `20260903080000` and
`20260903100000` despite sorting before them.

## The backlog, item by item

### A. Repo versions with a renumbered twin already in the ledger (8)

The recorded SQL was compared against the repo file, normalised by stripping
whitespace and statement separators.

| Repo version and file                                      | Ledger twin      | Evidence                                    |
| ---------------------------------------------------------- | ---------------- | ------------------------------------------- |
| `20260902011500_delete_own_listing`                         | `20260902011535` | identical, `md5 f4840f47…`                  |
| `20260904090000_like_counts_follow_the_listings_policy`     | `20260904084515` | identical, `md5 06f3ef56…`                  |
| `20260904090100_notifications_stop_muting_after_a_dead_row` | `20260904084540` | identical, `md5 319050a1…`                  |
| `20260907090000_moderation_fields_are_not_self_service`     | `20260907090829` | identical, `md5 537166a9…`                  |
| `20260904120000_listing_events_spine`                       | `20260904192107` | same statements, prose comments stripped    |
| `20260904120100_owner_listing_analytics`                    | `20260904192122` | same statements, prose comments stripped    |
| `20260904120200_listing_cooccurrence`                       | `20260904192138` | same statements, prose comments stripped    |
| `20260906150000_a_portfolio_you_can_arrange`                | `20260907091225` | abbreviated variant citing the repo file    |

**Action:** mark the repo version applied, and the twin reverted.

### B. Repo versions with no twin, whose effect is present or superseded (2)

| Repo version and file                          | Status on production                                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `20260901073500_fix_anon_listings_select_policy` | Superseded. `20260901080846` and then `20260904055617` own this policy now. **Must never be executed** - see above. |
| `20260902030000_profile_location_pins`           | Applied out of band. `profiles.location_latitude` and `location_longitude` exist and match the repo.               |

**Action:** mark applied. Do not execute.

### C. Ledger rows that are literal duplicates (3)

`20260903071250`, `20260903073340` and `20260903073530` have byte-identical
normalised SQL to `20260903073000`, `20260903080000` and `20260903100000`
respectively, which all remain in the ledger. They are the first, single-blob
recording of the same three migrations.

**Action:** mark reverted. Nothing is lost; the canonical rows stay.

### D. Ledger rows with no repo file at all (2)

`20260903055010_outreach_overlap_locks` and
`20260903055020_outreach_claimed_view` create and extend the `outreach` schema
(`prospects`, `sent_log`, `suppression`, and the `claimed` view). No migration
in this repository describes them, so a rebuild from empty produces a database
without the outreach tooling.

**Action:** bring them into the repo rather than dropping them. Keep their
existing version numbers so the ledger stays correct.

### E. Name-only drift (1)

Version `20260901080846` is in both, but the repo calls it
`remote_listing_read_reconciliation` and the ledger calls it
`split_listings_select_policy_off_profiles_subquery`. `db push` compares
versions only, so nothing will re-run.

**Action:** none required. Note it when reading the ledger.

### F. Migrations that should genuinely apply (4)

These are ordinary unapplied work, not drift. They carry their own version
numbers, they are missing from the ledger only because nobody has pushed them
yet, and `db push` should run them once the bookkeeping in A to C is done.

`20260907100000_my_listings_carries_the_booking_terms.sql` is the projection
repair. Production's `public.my_listings` already has the 44 columns it writes,
in the same order, so it is a `create or replace` with an identical select
list: a no-op except for the ledger row.

`20260907120000_offer_and_counteroffer_floors.sql`,
`20260908080000_a_kpi_event_outlives_what_it_counted.sql` and
`20260908090000_the_outbox_sends_itself.sql` landed on `main` after this
document was first written, and are genuinely new behaviour rather than
bookkeeping. The outbox one needs `pg_cron`; production has it at 1.6.4.

## The path

Run every step with `--linked` against the production project, from a
checkout of the merged branch. Stop at the first surprise.

**1. Re-confirm the schemas still agree.** Run the three fingerprint queries
against production and against a scratch database built from
`supabase/migrations`. If any fingerprint differs, stop: something changed
since 2026-09-07 and the rest of this plan is no longer justified.

**2. Capture a rollback point.**

```bash
supabase db dump --linked -f pre-reconciliation-schema.sql
```

Also snapshot the ledger itself, which `db dump` does not include:

```sql
select version, name from supabase_migrations.schema_migrations order by version;
```

**3. Confirm the backlog is exactly what this document describes.**

```bash
supabase migration list --linked
supabase db push --linked --dry-run
```

The dry run must list precisely the fourteen versions in sections A, B and F
and nothing else. If it lists anything more, stop: something has landed on
`main` since this was written, and it needs the same triage the rest of the
table got before you go any further.

**4. Record the ten pre-existing repo versions as applied.** This writes ledger
rows; it does not execute any SQL.

```bash
supabase migration repair --linked --status applied \
  20260901073500 20260902011500 20260902030000 \
  20260904090000 20260904090100 \
  20260904120000 20260904120100 20260904120200 \
  20260906150000 20260907090000
```

**5. Retire the eleven superseded ledger rows.** Eight renumbered twins from
section A and three duplicates from section C.

```bash
supabase migration repair --linked --status reverted \
  20260902011535 20260903071250 20260903073340 20260903073530 \
  20260904084515 20260904084540 \
  20260904192107 20260904192122 20260904192138 \
  20260907090829 20260907091225
```

**6. Verify the backlog is now only the section F migrations.**

```bash
supabase db push --linked --dry-run
```

It must list only the four section F versions. If it lists anything else, stop
and re-read steps 4 and 5 before pushing.

**7. Apply them.**

```bash
supabase db push --linked
```

**8. Verify the projection survived.** `20260907100000` is a no-op, but the
other three section F migrations are real schema changes, so the column and
function fingerprints from step 1 are expected to move. What must not move is
the owner projection this whole exercise exists to protect:

```sql
select count(*) from information_schema.columns
where table_schema = 'public' and table_name = 'my_listings';   -- 44
```

**9. Close the outreach gap.** In a separate, reviewed pull request, add
`supabase/migrations/20260903055010_outreach_overlap_locks.sql` and
`20260903055020_outreach_claimed_view.sql`, with bodies taken from the
recorded `statements` for those versions. Their versions are already in the
ledger, so `db push` will skip them, and a rebuild from empty will finally
produce the outreach schema. Verify by rebuilding from empty and checking the
`outreach` schema appears with `prospects`, `sent_log`, `suppression` and
`claimed`.

## Two things that would prevent a repeat

**Apply migrations one way.** `supabase db push` uses the filename's version;
the Supabase MCP `apply_migration` tool invents a new one. Mixing them is what
produced every row in sections A and C. Use `db push` for anything that lives
in `supabase/migrations`, and reserve `apply_migration` for work that will
never be in the repo.

**Never edit a migration to match a database.** When `20260903073844` landed
after the two migrations that sort after it, its select list was amended so the
`create or replace view` would not drop columns. That made it apply cleanly to
production and impossible to apply to an empty database, and the divergence
went unnoticed until a from-scratch rebuild was attempted. A rebuild from empty
is the only check that catches this class of bug; run it before merging
anything that touches `supabase/migrations`.
