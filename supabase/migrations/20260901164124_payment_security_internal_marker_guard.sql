-- Internal QA/support status is an administrative trust field. Keep it
-- server-controlled alongside auth identity, verification, and demo status.
create or replace function public.protect_profile_trust_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.verified = false;
      new.verification_status = 'unverified';
      new.social_verification = '{}'::jsonb;
      new.is_demo = false;
      new.is_internal = false;
    else
      new.auth_user_id = old.auth_user_id;
      new.verified = old.verified;
      new.verification_status = old.verification_status;
      new.social_verification = old.social_verification;
      new.is_demo = old.is_demo;
      new.is_internal = old.is_internal;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.protect_profile_trust_fields()
  from public, anon, authenticated, service_role;
