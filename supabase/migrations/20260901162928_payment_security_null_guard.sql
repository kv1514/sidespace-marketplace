-- Keep the database guard fail-closed even if a caller omits the release
-- reason. The normal release RPC always supplies one, but direct writes must
-- not turn a refunded payout into a transferable state.
create or replace function private.prevent_unreconciled_refund_payout_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.payout_status = 'releasing'
     and coalesce(new.refunded_cents, 0) > 0
     and coalesce(new.payout_release_reason, '') <> 'partial_refund_resolution' then
    raise exception 'A refunded payout requires staff resolution before release.';
  end if;
  return new;
end;
$$;

revoke all on function private.prevent_unreconciled_refund_payout_release()
  from public, anon, authenticated;
