-- Incremental upgrade AFTER 202609280009_inventory_receipt_request_application.sql. Manual review/application in QA.
-- Moves unbounded inventory histories out of inventory_read() and exposes deterministic cursor pagination.
begin;

create index if not exists inventory_receipts_cursor_idx on public.inventory_receipts(received_at desc,id desc);
create index if not exists inventory_submissions_cursor_idx on public.inventory_submissions(created_at desc,id desc);
create index if not exists inventory_submissions_area_cursor_idx on public.inventory_submissions(area,created_at desc,id desc);
create index if not exists inventory_movements_cursor_idx on public.inventory_movements(occurred_at desc,id desc);

-- Current inventory state and configuration only. Empty history keys remain for older clients.
create or replace function public.inventory_read() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare costs boolean:=public.inventory_can_manage(); result jsonb;
begin
  if not public.inventory_is_active_staff() or not (costs or public.has_staff_role('bar') or public.has_staff_role('kitchen')) then raise exception 'Acceso denegado a inventario'; end if;
  select jsonb_build_object(
    'can_manage',costs,'can_configure',public.inventory_can_configure(),
    'pending_review_count',(select count(*) from public.inventory_submissions s where s.status in ('sent','partially_approved') and (costs or lower(s.created_by)=public.inventory_actor_email() or exists(select 1 from public.staff_role_assignments r where lower(r.email)=public.inventory_actor_email() and r.role=s.area))),
    'items',coalesce((select jsonb_agg(x order by x->>'name') from (
      select jsonb_build_object('id',i.id,'name',i.name,'active',i.active,'base_unit',i.base_unit,'precision_scale',i.precision_scale,
        'minimum_quantity',i.minimum_quantity,'target_quantity',i.target_quantity,'tracking_started_at',i.tracking_started_at,
        'balance',case when i.tracking_started_at is null then null else coalesce(v.current_quantity,0) end,
        'pending_incoming',coalesce((select sum(greatest(coalesce(l.approved_quantity,0)-l.received_quantity,0)) from public.inventory_submission_lines l join public.inventory_submissions s on s.id=l.submission_id where l.item_id=i.id and s.kind='replenishment' and s.status in ('approved','partially_approved','partially_received')),0),
        'last_unit_cost',case when costs then v.last_unit_cost else null end,'average_unit_cost',case when costs then v.average_unit_cost else null end,
        'inventory_value',case when costs then v.inventory_value else null end,
        'areas',coalesce((select jsonb_agg(a.area order by a.area) from public.inventory_item_areas a where a.item_id=i.id),'[]'::jsonb)) x
      from public.inventory_items i left join public.inventory_item_valuations v on v.item_id=i.id where public.inventory_item_visible(i.id)
    ) q),'[]'::jsonb),
    'presentations',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'item_id',p.item_id,'name',p.name,'content_per_package',p.content_per_package,'content_unit',p.content_unit,'active',p.active,'suggested_package_cost',case when costs then p.suggested_package_cost else null end) order by p.name) from public.inventory_purchase_presentations p where public.inventory_item_visible(p.item_id)),'[]'::jsonb),
    'recipes',case when public.inventory_can_configure() then coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'menu_item_source_key',r.menu_item_source_key,'item_id',r.item_id,'quantity_base',r.quantity_base,'active',r.active,'control_mode',t.control_mode,'menu_name',mi.name,'tracked_component_cost',case when v.last_unit_cost is null then null else round(r.quantity_base*v.last_unit_cost,6) end) order by mi.name) from public.inventory_menu_recipe_components r join public.menu_items mi on mi.source_key=r.menu_item_source_key left join public.inventory_menu_tracking t on t.menu_item_source_key=r.menu_item_source_key left join public.inventory_item_valuations v on v.item_id=r.item_id),'[]'::jsonb) else '[]'::jsonb end,
    'menu_items',case when public.inventory_can_configure() then coalesce((select jsonb_agg(jsonb_build_object('source_key',source_key,'name',name) order by name) from public.menu_items),'[]'::jsonb) else '[]'::jsonb end,
    'submissions','[]'::jsonb,'receipts','[]'::jsonb,'movements','[]'::jsonb
  ) into result;
  return result;
end;
$$;

create function public.inventory_recent_submissions(requested_area text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.inventory_is_active_staff() or requested_area not in ('bar','kitchen') or not (public.inventory_can_manage() or public.has_staff_role(requested_area)) then raise exception 'Area no autorizada'; end if;
  select coalesce(jsonb_agg(row_data order by created_at desc,id desc),'[]'::jsonb) into result from (
    select s.created_at,s.id,jsonb_build_object('id',s.id,'kind',s.kind,'area',s.area,'status',s.status,'sales_session_id',s.sales_session_id,'notes',s.notes,'created_at',s.created_at,'created_by',s.created_by,'reviewed_at',s.reviewed_at,'reviewed_by',s.reviewed_by,'review_notes',s.review_notes,
      'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'item_id',l.item_id,'item_name',i.name,'requested_quantity',l.requested_quantity,'observed_quantity',l.observed_quantity,'approved_quantity',l.approved_quantity,'received_quantity',l.received_quantity,'reference_balance',l.reference_balance,'reference_at',l.reference_at,'notes',l.notes) order by l.id),'[]'::jsonb) from public.inventory_submission_lines l join public.inventory_items i on i.id=l.item_id where l.submission_id=s.id)) row_data
    from public.inventory_submissions s where s.area=requested_area order by s.created_at desc,s.id desc limit 8
  ) q;
  return result;
end;
$$;

create function public.inventory_pending_replenishments() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.inventory_is_active_staff() or not public.inventory_can_manage() then raise exception 'Acceso denegado a recepciones'; end if;
  select coalesce(jsonb_agg(row_data order by created_at desc,id desc),'[]'::jsonb) into result from (
    select s.created_at,s.id,jsonb_build_object('id',s.id,'kind',s.kind,'area',s.area,'status',s.status,'sales_session_id',s.sales_session_id,'notes',s.notes,'created_at',s.created_at,'created_by',s.created_by,'reviewed_at',s.reviewed_at,'reviewed_by',s.reviewed_by,'review_notes',s.review_notes,
      'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'item_id',l.item_id,'item_name',i.name,'requested_quantity',l.requested_quantity,'observed_quantity',l.observed_quantity,'approved_quantity',l.approved_quantity,'received_quantity',l.received_quantity,'reference_balance',l.reference_balance,'reference_at',l.reference_at,'notes',l.notes) order by l.id),'[]'::jsonb) from public.inventory_submission_lines l join public.inventory_items i on i.id=l.item_id where l.submission_id=s.id and coalesce(l.approved_quantity,0)>l.received_quantity)) row_data
    from public.inventory_submissions s where s.kind='replenishment' and s.status in ('approved','partially_approved','partially_received') and exists(select 1 from public.inventory_submission_lines l where l.submission_id=s.id and coalesce(l.approved_quantity,0)>l.received_quantity)
    order by s.created_at desc,s.id desc
  ) q;
  return result;
end;
$$;

create function public.inventory_receipts_page(before_received_at timestamptz default null,before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare result jsonb;
begin
  if not public.inventory_is_active_staff() or not public.inventory_can_manage() then raise exception 'Acceso denegado a entradas'; end if;
  if (before_received_at is null)<>(before_id is null) then raise exception 'Cursor de entradas invalido'; end if;
  with candidates as (
    select r.received_at,r.id,jsonb_build_object('id',r.id,'supplier',r.supplier,'document_reference',r.document_reference,'expense_movement_id',r.expense_movement_id,'total_cost',r.total_cost,'received_at',r.received_at,'received_by',r.received_by,'notes',r.notes,
      'lines',(select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]'::jsonb) from public.inventory_receipt_lines l where l.receipt_id=r.id)) row_data
    from public.inventory_receipts r where before_received_at is null or (r.received_at,r.id)<(before_received_at,before_id)
    order by r.received_at desc,r.id desc limit 21
  ), numbered as (select *,row_number() over(order by received_at desc,id desc) rn from candidates)
  select jsonb_build_object('rows',coalesce(jsonb_agg(row_data order by received_at desc,id desc) filter(where rn<=20),'[]'::jsonb),'has_more',count(*)>20) into result from numbered;
  return result;
end;
$$;

create function public.inventory_submissions_page(requested_kind text default null,requested_status text default null,before_created_at timestamptz default null,before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare costs boolean:=public.inventory_can_manage(); result jsonb;
begin
  if not public.inventory_is_active_staff() or not (costs or public.has_staff_role('bar') or public.has_staff_role('kitchen')) then raise exception 'Acceso denegado a solicitudes'; end if;
  if requested_kind is not null and requested_kind not in ('replenishment','count','damage') then raise exception 'Tipo de solicitud invalido'; end if;
  if requested_status is not null and requested_status not in ('draft','sent','partially_approved','approved','partially_received','received','rejected') then raise exception 'Estado de solicitud invalido'; end if;
  if (before_created_at is null)<>(before_id is null) then raise exception 'Cursor de solicitudes invalido'; end if;
  with candidates as (
    select s.created_at,s.id,jsonb_build_object('id',s.id,'kind',s.kind,'area',s.area,'status',s.status,'sales_session_id',s.sales_session_id,'notes',s.notes,'created_at',s.created_at,'created_by',s.created_by,'reviewed_at',s.reviewed_at,'reviewed_by',s.reviewed_by,'review_notes',s.review_notes,
      'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'item_id',l.item_id,'item_name',i.name,'requested_quantity',l.requested_quantity,'observed_quantity',l.observed_quantity,'approved_quantity',l.approved_quantity,'received_quantity',l.received_quantity,'reference_balance',l.reference_balance,'reference_at',l.reference_at,'notes',l.notes) order by l.id),'[]'::jsonb) from public.inventory_submission_lines l join public.inventory_items i on i.id=l.item_id where l.submission_id=s.id)) row_data
    from public.inventory_submissions s
    where (requested_kind is null or s.kind=requested_kind) and (requested_status is null or s.status=requested_status)
      and (costs or lower(s.created_by)=public.inventory_actor_email() or exists(select 1 from public.staff_role_assignments r where lower(r.email)=public.inventory_actor_email() and r.role=s.area))
      and (before_created_at is null or (s.created_at,s.id)<(before_created_at,before_id))
    order by s.created_at desc,s.id desc limit 21
  ), numbered as (select *,row_number() over(order by created_at desc,id desc) rn from candidates)
  select jsonb_build_object('rows',coalesce(jsonb_agg(row_data order by created_at desc,id desc) filter(where rn<=20),'[]'::jsonb),'has_more',count(*)>20) into result from numbered;
  return result;
end;
$$;

create function public.inventory_movements_page(requested_month date,before_occurred_at timestamptz default null,before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare costs boolean:=public.inventory_can_manage(); result jsonb; month_start date; range_start timestamptz; range_end timestamptz;
begin
  if not public.inventory_is_active_staff() or not (costs or public.has_staff_role('bar') or public.has_staff_role('kitchen')) then raise exception 'Acceso denegado al historial'; end if;
  if requested_month is null then raise exception 'Mes requerido'; end if;
  if (before_occurred_at is null)<>(before_id is null) then raise exception 'Cursor de movimientos invalido'; end if;
  month_start:=date_trunc('month',requested_month)::date; range_start:=month_start::timestamp at time zone 'America/Bogota'; range_end:=(month_start+interval '1 month')::timestamp at time zone 'America/Bogota';
  with candidates as (
    select m.occurred_at,m.id,jsonb_build_object('id',m.id,'item_id',m.item_id,'item_name',i.name,'movement_type',m.movement_type,'quantity_delta',m.quantity_delta,'base_unit_snapshot',m.base_unit_snapshot,'reason',m.reason,'actor',m.actor,'occurred_at',m.occurred_at,'sales_session_id',m.sales_session_id,'order_id',m.order_id,'order_item_id',m.order_item_id,
      'unit_cost_snapshot',case when costs then m.unit_cost_snapshot else null end,'tracked_value_delta',case when costs then m.tracked_value_delta else null end,'quantity_balance_after',m.quantity_balance_after,'average_unit_cost_after',case when costs then m.average_unit_cost_after else null end,'inventory_value_after',case when costs then m.inventory_value_after else null end,'metadata',case when costs then m.metadata else m.metadata-'cost'-'supplier'-'unit_cost'-'base_unit_cost'-'line_total_cost'-'actual_package_cost'-'original_consumption_cost'-'cost_known' end) row_data
    from public.inventory_movements m join public.inventory_items i on i.id=m.item_id
    where public.inventory_item_visible(m.item_id) and m.occurred_at>=range_start and m.occurred_at<range_end and (before_occurred_at is null or (m.occurred_at,m.id)<(before_occurred_at,before_id))
    order by m.occurred_at desc,m.id desc limit 51
  ), numbered as (select *,row_number() over(order by occurred_at desc,id desc) rn from candidates)
  select jsonb_build_object('rows',coalesce(jsonb_agg(row_data order by occurred_at desc,id desc) filter(where rn<=50),'[]'::jsonb),'has_more',count(*)>50) into result from numbered;
  return result;
end;
$$;

create function public.inventory_movements_export(requested_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare costs boolean:=public.inventory_can_manage(); result jsonb; month_start date; range_start timestamptz; range_end timestamptz;
begin
  if not public.inventory_is_active_staff() or not (costs or public.has_staff_role('bar') or public.has_staff_role('kitchen')) then raise exception 'Acceso denegado al historial'; end if;
  if requested_month is null then raise exception 'Mes requerido'; end if;
  month_start:=date_trunc('month',requested_month)::date; range_start:=month_start::timestamp at time zone 'America/Bogota'; range_end:=(month_start+interval '1 month')::timestamp at time zone 'America/Bogota';
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'item_id',m.item_id,'item_name',i.name,'movement_type',m.movement_type,'quantity_delta',m.quantity_delta,'base_unit_snapshot',m.base_unit_snapshot,'reason',m.reason,'actor',m.actor,'occurred_at',m.occurred_at,'sales_session_id',m.sales_session_id,'order_id',m.order_id,'order_item_id',m.order_item_id,
    'unit_cost_snapshot',case when costs then m.unit_cost_snapshot else null end,'tracked_value_delta',case when costs then m.tracked_value_delta else null end,'quantity_balance_after',m.quantity_balance_after,'average_unit_cost_after',case when costs then m.average_unit_cost_after else null end,'inventory_value_after',case when costs then m.inventory_value_after else null end,'metadata',case when costs then m.metadata else m.metadata-'cost'-'supplier'-'unit_cost'-'base_unit_cost'-'line_total_cost'-'actual_package_cost'-'original_consumption_cost'-'cost_known' end) order by m.occurred_at desc,m.id desc),'[]'::jsonb) into result
  from public.inventory_movements m join public.inventory_items i on i.id=m.item_id where public.inventory_item_visible(m.item_id) and m.occurred_at>=range_start and m.occurred_at<range_end;
  return result;
end;
$$;

revoke all on function public.inventory_recent_submissions(text),public.inventory_pending_replenishments(),public.inventory_receipts_page(timestamptz,uuid),public.inventory_submissions_page(text,text,timestamptz,uuid),public.inventory_movements_page(date,timestamptz,uuid),public.inventory_movements_export(date) from public,anon;
grant execute on function public.inventory_recent_submissions(text),public.inventory_pending_replenishments(),public.inventory_receipts_page(timestamptz,uuid),public.inventory_submissions_page(text,text,timestamptz,uuid),public.inventory_movements_page(date,timestamptz,uuid),public.inventory_movements_export(date) to authenticated;

commit;
