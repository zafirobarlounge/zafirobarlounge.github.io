-- A browser can disappear after window.print() begins. Keep such jobs out of
-- automatic recovery so a second station cannot physically duplicate them.
alter table public.pos_preparation_print_jobs drop constraint if exists pos_preparation_print_jobs_status_check;
alter table public.pos_preparation_print_jobs add constraint pos_preparation_print_jobs_status_check
  check (status in ('pending','claimed','printing','printed','failed','review'));

create function public.begin_pos_preparation_print_job(job_id uuid, station_id uuid)
returns void language plpgsql security invoker set search_path=public as $$
begin
  update public.pos_preparation_print_jobs set status='printing', claimed_at=now()
  where id=job_id and claimed_by_station_id=station_id and status='claimed';
  if not found then raise exception 'El trabajo no pertenece a esta estación.'; end if;
end;
$$;

create function public.finish_pos_preparation_print_job(job_id uuid, station_id uuid, succeeded boolean, failure text default null)
returns void language plpgsql security invoker set search_path=public as $$
begin
  update public.pos_preparation_print_jobs
  set status=case when succeeded then 'printed' else 'review' end,
      printed_at=case when succeeded then now() else null end,
      error_message=case when succeeded then null else left(coalesce(failure,'Resultado de impresión incierto'),500) end
  where id=job_id and claimed_by_station_id=station_id and status='printing';
  if not found then raise exception 'El trabajo no está en impresión para esta estación.'; end if;
end;
$$;
grant execute on function public.begin_pos_preparation_print_job(uuid,uuid) to authenticated;
grant execute on function public.finish_pos_preparation_print_job(uuid,uuid,boolean,text) to authenticated;
