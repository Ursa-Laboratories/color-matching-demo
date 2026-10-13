-- Run once in the Supabase SQL editor. This only creates demo-owned resources.
-- The browser never accesses these directly: only the Vercel server holds a key.
begin;

create table if not exists public.ursa_live_events (
  id text primary key,
  revision bigint not null default 1 check (revision > 0),
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.ursa_live_events enable row level security;
revoke all on public.ursa_live_events from public, anon, authenticated;
-- Table grants alone do not allow access when the project's default schema
-- permissions are restricted. Only the server's role needs schema access.
grant usage on schema public to service_role;
grant select, insert, update on public.ursa_live_events to service_role;

-- One atomic update per queue action. Concurrent Vercel requests retry from the
-- new revision; competing workers cannot claim different jobs at the same time.
create or replace function public.ursa_live_compare_and_set(
  event_key text, expected_revision bigint, next_state jsonb
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected integer;
begin
  if expected_revision = 0 then
    insert into public.ursa_live_events (id, revision, state)
      values (event_key, 1, next_state)
      on conflict (id) do nothing;
  else
    update public.ursa_live_events
      set state = next_state, revision = revision + 1, updated_at = now()
      where id = event_key and revision = expected_revision;
  end if;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke all on function public.ursa_live_compare_and_set(text, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.ursa_live_compare_and_set(text, bigint, jsonb)
  to service_role;

commit;
