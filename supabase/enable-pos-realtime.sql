-- Run manually in Supabase SQL Editor. Only publication membership changes.
do $$
declare
  pos_table text;
begin
  foreach pos_table in array array[
    'pos_tables',
    'pos_orders',
    'pos_order_items',
    'pos_payments',
    'pos_sales_sessions',
    'pos_order_status_logs',
    'pos_operational_flow_settings'
  ] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = pos_table
    ) then
      execute format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', pos_table);
    end if;
  end loop;
end;
$$;

select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;
