-- Manual review and the latest manual reprint metadata only; no history table.
alter table public.pos_preparation_print_jobs
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by_email text,
  add column if not exists last_reprint_requested_at timestamptz,
  add column if not exists last_reprint_requested_by_email text,
  add column if not exists last_reprint_station_id uuid,
  add column if not exists last_reprint_result text,
  add column if not exists last_reprint_error text,
  add column if not exists last_reprint_request_id uuid;

create function public.review_pos_preparation_print_job(job_id uuid, reviewer_email text)
returns void language sql security invoker set search_path=public as $$
  update public.pos_preparation_print_jobs set reviewed_at=now(), reviewed_by_email=reviewer_email
  where id=job_id and status in ('review','failed');
$$;

create function public.record_pos_preparation_reprint(job_id uuid, request_id uuid, actor_email text, station_id uuid, result text, failure text default null)
returns void language sql security invoker set search_path=public as $$
  update public.pos_preparation_print_jobs set last_reprint_requested_at=now(),last_reprint_requested_by_email=actor_email,
    last_reprint_station_id=station_id,last_reprint_request_id=request_id,last_reprint_result=result,last_reprint_error=failure
  where id=job_id and status in ('review','failed');
$$;
grant execute on function public.review_pos_preparation_print_job(uuid,text) to authenticated;
grant execute on function public.record_pos_preparation_reprint(uuid,uuid,text,uuid,text,text) to authenticated;
