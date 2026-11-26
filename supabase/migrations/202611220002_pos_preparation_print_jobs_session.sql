-- Required complement to 001: a preparation job belongs to the sales session
-- that created it, so closing a session can invalidate only its own queue.
alter table public.pos_preparation_print_jobs
  add column if not exists sales_session_id uuid references public.pos_sales_sessions(id) on delete restrict;

create index if not exists pos_preparation_print_jobs_session_idx
  on public.pos_preparation_print_jobs(sales_session_id, status, created_at);

-- Existing QA rows predate this column and remain intact. They are never picked
-- by the session-scoped client until an operator resolves them manually.

create or replace function public.release_pos_preparation_print_job(job_id uuid, station_id uuid)
returns void language sql security invoker set search_path = public as $$
  update public.pos_preparation_print_jobs
  set status='pending', claimed_by_station_id=null, claimed_at=null
  where id=job_id and claimed_by_station_id=station_id and status='claimed';
$$;

create or replace function public.discard_pos_preparation_print_jobs_for_session(session_id uuid)
returns void language sql security invoker set search_path = public as $$
  delete from public.pos_preparation_print_jobs
  where sales_session_id=session_id and status in ('pending','claimed','failed');
$$;

grant execute on function public.release_pos_preparation_print_job(uuid,uuid) to authenticated;
grant execute on function public.discard_pos_preparation_print_jobs_for_session(uuid) to authenticated;
