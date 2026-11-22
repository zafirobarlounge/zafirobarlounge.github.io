-- Incremental closure operation. It deliberately reuses the session link added
-- by 002 and changes no existing columns, indexes, policies, or functions.
create function public.purge_all_pos_preparation_print_jobs_for_closed_session(session_id uuid)
returns void language sql security invoker set search_path = public as $$
  delete from public.pos_preparation_print_jobs
  where sales_session_id = session_id;
$$;

grant execute on function public.purge_all_pos_preparation_print_jobs_for_closed_session(uuid) to authenticated;
