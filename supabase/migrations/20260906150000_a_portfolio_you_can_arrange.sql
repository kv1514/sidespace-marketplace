-- A portfolio you can arrange.
--
-- The portfolio has been a list since 20260830123000: sort_order said what came
-- first and nothing said anything else. Every piece of work therefore rendered
-- at identical weight, and a creator who wanted to say "look at this one" had
-- no way to say it. What people did instead is visible in the data - somebody
-- filed an introduction as a piece of work, because a bio had no home on that
-- page and a portfolio row was the only box on offer. This migration gives a
-- block a size and a colour, and gives reordering a write that cannot land
-- halfway.
--
-- ORDER STAYS AN INTEGER, AND MOVES GO THROUGH ONE STATEMENT. The obvious
-- worry with integer positions is the renumbering: dropping the first block at
-- the end rewrites every row in between, and a connection lost halfway leaves
-- a board that is neither the old arrangement nor the new one. That is a real
-- failure, but it is a failure of doing it in a loop, not of the integer. One
-- UPDATE ... FROM unnest(...) renumbers the whole board inside one transaction,
-- so the intermediate state does not exist to be interrupted - and sort_order
-- stays a column anybody can read and understand, which a fractional key
-- dressed up as base-62 text would not be.
--
-- WHO CAN WRITE IT. Exactly whoever could already update the row. The function
-- is SECURITY INVOKER, so "Creators update their own portfolio items"
-- (20260903220218) is still the only thing authorising a write, and a board
-- belonging to somebody else is filtered to zero rows rather than refused
-- loudly - which is why the function returns a count and the client checks it.
--
-- No new grants: public.creator_portfolio_items is granted table-wide (see
-- 20260901063503), so these columns are writable by exactly whoever could
-- already write the row, and readable by exactly whoever could already read it.
-- The BEFORE UPDATE trigger creator_portfolio_items_set_updated_at
-- (20260830123000) keeps bumping updated_at for free.

-- ---------------------------------------------------------------------------
-- What a block looks like.
--
-- Each column is added with a constant default that already satisfies its own
-- CHECK, so no existing row can fail validation and PostgreSQL does not
-- rewrite the heap. The constraints are added validating rather than NOT VALID
-- because this table holds a handful of rows per creator; on a large table the
-- pair of statements would be worth the extra step.
-- ---------------------------------------------------------------------------

-- The five shapes, by name rather than by a pair of span numbers. A name is
-- what the creator picks from a list, it is what the CHECK can enforce, and it
-- leaves the spans a rendering decision the stylesheet is allowed to revisit -
-- two smallint columns would freeze a four-column grid into the database.
alter table public.creator_portfolio_items
  add column if not exists block_size text not null default 'medium';

alter table public.creator_portfolio_items
  drop constraint if exists creator_portfolio_block_size_known;
alter table public.creator_portfolio_items
  add constraint creator_portfolio_block_size_known
  check (block_size in ('small', 'medium', 'large', 'wide', 'showcase'));

-- Emphasis, not decoration. Every value resolves to a token the stylesheet
-- already owns, so a creator picks which block stands out and never picks a
-- fill their own text disappears into. '' is the default and means "paper".
alter table public.creator_portfolio_items
  add column if not exists accent text not null default '';

alter table public.creator_portfolio_items
  drop constraint if exists creator_portfolio_accent_known;
alter table public.creator_portfolio_items
  add constraint creator_portfolio_accent_known
  check (accent in ('', 'amber', 'ink', 'mist', 'haze'));

-- Which part of a picture survives the crop. A block two columns wide and one
-- row tall crops hard, and a face is exactly the part that gets cut.
alter table public.creator_portfolio_items
  add column if not exists media_focus text not null default 'center';

alter table public.creator_portfolio_items
  drop constraint if exists creator_portfolio_media_focus_known;
alter table public.creator_portfolio_items
  add constraint creator_portfolio_media_focus_known
  check (media_focus in ('center', 'top', 'bottom'));

comment on column public.creator_portfolio_items.block_size is
  'The shape this block takes on the board: small, medium, large, wide or showcase. Spans are a rendering decision, not stored here.';
comment on column public.creator_portfolio_items.accent is
  'Which of the house accent tokens paints this block. Empty means paper.';
comment on column public.creator_portfolio_items.media_focus is
  'Which edge of media_url to keep when the block crops it.';

-- ---------------------------------------------------------------------------
-- The order, repaired.
-- ---------------------------------------------------------------------------

-- Publishing has always written `sort_order: creatorPortfolio.length`, so any
-- creator who deleted a block and added another has two rows claiming the same
-- position. It never showed, because a tie fell through to created_at and the
-- list looked plausible either way. A board that is dragged cannot afford that:
-- a move writes positions back, and a duplicate makes the arrangement depend on
-- which row the planner happened to read first.
--
-- The window reproduces exactly what both loaders emit today - sort_order
-- ascending, then created_at descending - so no portfolio visibly moves on
-- deploy. id breaks any remaining tie so the result is deterministic.
with ordered as (
  select
    id,
    row_number() over (
      partition by creator_profile_id
      order by sort_order asc, created_at desc, id asc
    ) - 1 as position
  from public.creator_portfolio_items
)
update public.creator_portfolio_items item
set sort_order = ordered.position
from ordered
where ordered.id = item.id
  and item.sort_order is distinct from ordered.position;

-- ---------------------------------------------------------------------------
-- A creator can see their own board, published or not.
-- ---------------------------------------------------------------------------

-- The only SELECT policy is `using (published)`, which was harmless while
-- nothing ever wrote published = false: every row was visible to everybody.
-- A board that is rearranged makes it dangerous. The renumbering below is one
-- statement over the rows the caller can see, so an invisible row would be
-- silently dropped from it, the returned count would come back short, and the
-- app would report a refusal and roll the whole drag back - on a board its
-- owner fully owns. A second permissive policy ORs with the existing one; it
-- is separate rather than folded in because the helper is granted to
-- `authenticated` only, and an OR is not promised to short-circuit for `anon`.
drop policy if exists "Creators read their own portfolio items"
  on public.creator_portfolio_items;
create policy "Creators read their own portfolio items"
on public.creator_portfolio_items for select to authenticated
using (private.creator_profile_owned_by_current_user(creator_profile_id));

-- ---------------------------------------------------------------------------
-- Rewriting the order of a whole board in one statement.
-- ---------------------------------------------------------------------------

/**
 * Renumber a board, atomically.
 *
 * It has to be one statement. A loop of per-row updates leaves already-written
 * rows sorting against unwritten ones halfway through, and an interrupted loop
 * leaves an arrangement nobody chose. unnest gives every row its new position
 * inside a single transaction, so that intermediate state does not exist.
 *
 * SECURITY INVOKER on purpose: row-level security still applies, so this can
 * only ever renumber blocks the caller already owns, and a board belonging to
 * somebody else is filtered out silently rather than refused. It returns how
 * many rows it actually touched so the caller can tell those two apart - a
 * refused write is zero rows, not an error, and a client that only checked for
 * an error would report a refusal as a success.
 *
 * A malformed call returns 0 rather than raising. There is no sentence a
 * member could act on if the app sent mismatched arrays, and an exception
 * there would surface as a database error in front of somebody who had done
 * nothing wrong.
 */
create or replace function public.set_creator_portfolio_layout(
  target_profile_id uuid,
  block_ids uuid[],
  block_orders integer[]
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  id_count integer := pg_catalog.coalesce(pg_catalog.array_length(block_ids, 1), 0);
  order_count integer := pg_catalog.coalesce(pg_catalog.array_length(block_orders, 1), 0);
  touched integer;
begin
  -- 200 is far above what a portfolio holds and far below what would make this
  -- statement worth sending as a denial of service.
  if id_count <> order_count or id_count = 0 or id_count > 200 then
    return 0;
  end if;

  -- Validated up front rather than filtered in the UPDATE. A negative position
  -- violates the table's own sort_order check, and dropping those rows from the
  -- statement would write a partial arrangement and still report a count the
  -- caller reads as partial success. Refusing the whole call is the honest
  -- answer: nothing is written and the caller reloads.
  if exists (
    select 1
    from pg_catalog.unnest(block_orders) as incoming(sort_position)
    where incoming.sort_position is null or incoming.sort_position < 0
  ) then
    return 0;
  end if;

  -- Every named row is written, including the ones already sitting at the
  -- position they are being given. Skipping those would make the returned
  -- count smaller than the number of blocks sent, and the caller cannot tell
  -- "three were already right" from "three were filtered away by row-level
  -- security" - which is the single thing this count exists to distinguish.
  -- unnest over two arrays is parser syntax, not a function: there is no
  -- unnest(anyarray, anyarray) in the catalog, and the rewrite that pairs the
  -- arrays only fires for the bare name. Schema-qualifying it would send the
  -- parser looking for a function that does not exist. Bare is also correct
  -- under an empty search_path - pg_catalog is searched implicitly, which is
  -- why 20260904120200 and 20260906130000 write it the same way.
  update public.creator_portfolio_items item
  set sort_order = incoming.sort_position
  from unnest(block_ids, block_orders) as incoming(id, sort_position)
  where item.id = incoming.id
    and item.creator_profile_id = target_profile_id;

  get diagnostics touched = row_count;
  return touched;
end;
$$;

revoke all on function public.set_creator_portfolio_layout(uuid, uuid[], integer[])
  from public, anon, authenticated, service_role;
grant execute on function public.set_creator_portfolio_layout(uuid, uuid[], integer[])
  to authenticated, service_role;

comment on function public.set_creator_portfolio_layout(uuid, uuid[], integer[]) is
  'Renumber one creator''s portfolio blocks in a single statement. Returns the number of rows actually written, which is how a caller detects a write row-level security filtered away.';
