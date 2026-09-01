-- Keep notification links on the canonical purchased domain. The original
-- notification migration is already applied in hosted projects, so replace
-- the trigger functions in a forward migration instead of editing history.
do $$
declare
  function_name text;
  definition text;
begin
  foreach function_name in array array[
    'on_message_notify',
    'on_request_notify',
    'on_request_answered_notify'
  ] loop
    select pg_get_functiondef(p.oid)
      into definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = function_name
      and p.pronargs = 0;

    if definition is not null
       and position('https://sidespace-marketplace.vercel.app/' in definition) > 0 then
      execute replace(
        definition,
        'https://sidespace-marketplace.vercel.app/',
        'https://sidespace.ad/'
      );
    end if;
  end loop;
end;
$$;
