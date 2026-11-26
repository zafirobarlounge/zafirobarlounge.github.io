-- Local incremental migration. Do not run automatically from the client.
-- Persistent jobs are deliberately limited to Kitchen/Bar preparation tickets.

create table if not exists public.pos_preparation_print_jobs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.pos_orders(id) on delete restrict,
  preparation_area text not null check (preparation_area in ('kitchen', 'bar')),
  dedupe_key text not null unique,
  ticket_snapshot jsonb not null,
  status text not null check (status in ('pending', 'claimed', 'printed', 'failed')) default 'pending',
  claimed_by_station_id uuid,
  claimed_at timestamptz,
  printed_at timestamptz,
  error_message text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists pos_preparation_print_jobs_pending_idx
  on public.pos_preparation_print_jobs(status, created_at);
create index if not exists pos_preparation_print_jobs_order_idx
  on public.pos_preparation_print_jobs(order_id, created_at);

drop trigger if exists trg_pos_preparation_print_jobs_set_updated_at on public.pos_preparation_print_jobs;
create trigger trg_pos_preparation_print_jobs_set_updated_at
before update on public.pos_preparation_print_jobs
for each row execute function public.set_updated_at();

alter table public.pos_preparation_print_jobs enable row level security;
drop policy if exists "pos_preparation_print_jobs_staff_access" on public.pos_preparation_print_jobs;
create policy "pos_preparation_print_jobs_staff_access"
on public.pos_preparation_print_jobs for all
using (public.is_pos_staff()) with check (public.is_pos_staff());
grant select, insert, update on public.pos_preparation_print_jobs to authenticated;

-- Atomically claims one job. A claim older than five minutes is recoverable after
-- browser/printer disconnection; two stations cannot receive the same row.
create or replace function public.claim_pos_preparation_print_job(station_id uuid)
returns setof public.pos_preparation_print_jobs
language plpgsql security invoker set search_path = public as $$
declare job public.pos_preparation_print_jobs;
begin
  select * into job from public.pos_preparation_print_jobs
  where status='pending' or (status='claimed' and claimed_at < now()-interval '5 minutes')
  order by created_at
  for update skip locked limit 1;
  if not found then return; end if;
  update public.pos_preparation_print_jobs
  set status='claimed', claimed_by_station_id=station_id, claimed_at=now(), error_message=null
  where id=job.id returning * into job;
  return next job;
end;
$$;

create or replace function public.complete_pos_preparation_print_job(job_id uuid, station_id uuid, succeeded boolean, failure text default null)
returns void language plpgsql security invoker set search_path = public as $$
begin
  update public.pos_preparation_print_jobs
  set status=case when succeeded then 'printed' else 'failed' end,
      printed_at=case when succeeded then now() else null end,
      error_message=case when succeeded then null else left(coalesce(failure,'Error de impresión'),500) end
  where id=job_id and claimed_by_station_id=station_id and status='claimed';
  if not found then raise exception 'El trabajo no pertenece a esta estación.'; end if;
end;
$$;

grant execute on function public.claim_pos_preparation_print_job(uuid) to authenticated;
grant execute on function public.complete_pos_preparation_print_job(uuid,uuid,boolean,text) to authenticated;

do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='pos_preparation_print_jobs') then
    alter publication supabase_realtime add table public.pos_preparation_print_jobs;
  end if;
end $$;
