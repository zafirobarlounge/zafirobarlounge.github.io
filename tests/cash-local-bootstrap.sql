-- ONLY a fresh isolated local test database. Never production.
create role anon;
create role authenticated;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb;
$$;
grant usage on schema auth to authenticated, anon;
grant execute on function auth.jwt() to authenticated, anon;
