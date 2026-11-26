-- READ ONLY. For manual review before applying the migration; not executed on production by Codex.
-- Several active sessions require investigation; do not close, merge or reassign them automatically.
select id, session_label, business_date, opened_at
from public.pos_sales_sessions where status='open' order by opened_at;

-- The new close operation will stop on these inconsistent associations.
-- Review affected IDs and determine the correct historical ownership separately.
select p.id as payment_id, p.order_id, p.sales_session_id as payment_session,
       o.sales_session_id as order_session, p.status
from public.pos_payments p join public.pos_orders o on o.id=p.order_id
where p.sales_session_id is distinct from o.sales_session_id;

-- Check the deployed schema against the repository without changing data.
select table_name, column_name, data_type
from information_schema.columns
where table_schema='public' and table_name in (
  'pos_sales_sessions','pos_orders','pos_order_items','pos_payments','staff_profiles','staff_role_assignments'
) order by table_name, ordinal_position;
