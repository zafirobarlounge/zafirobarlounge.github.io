-- Incremental upgrade AFTER 202609290021_inventory_linked_purchases.sql. Manual review/application in QA.
-- Keeps approved counts and damages out of the operational pending queue.
begin;

create or replace function public.inventory_submissions_page(requested_kind text default null,requested_status text default null,before_created_at timestamptz default null,before_id uuid default null,requested_area text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare costs boolean:=public.inventory_can_manage(); result jsonb;
begin
  if not public.inventory_is_active_staff() or not (costs or public.has_staff_role('bar') or public.has_staff_role('kitchen')) then raise exception 'Acceso denegado a solicitudes'; end if;
  if requested_kind is not null and requested_kind not in ('replenishment','count','damage') then raise exception 'Tipo de solicitud invalido'; end if;
  if requested_status is not null and requested_status not in ('pending','pending_sent','pending_partially_approved','pending_approved','pending_partially_received','draft','sent','partially_approved','approved','partially_received','received','rejected') then raise exception 'Estado de solicitud invalido'; end if;
  if requested_area is not null and not exists(select 1 from public.inventory_areas a where a.code=requested_area) then raise exception 'Area de solicitud invalida'; end if;
  if (before_created_at is null)<>(before_id is null) then raise exception 'Cursor de solicitudes invalido'; end if;
  with candidates as (
    select s.created_at,s.id,jsonb_build_object('id',s.id,'kind',s.kind,'area',s.area,'status',s.status,'sales_session_id',s.sales_session_id,'notes',s.notes,'created_at',s.created_at,'created_by',s.created_by,'reviewed_at',s.reviewed_at,'reviewed_by',s.reviewed_by,'review_notes',s.review_notes,
      'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'item_id',l.item_id,'item_name',i.name,'requested_quantity',l.requested_quantity,'observed_quantity',l.observed_quantity,'approved_quantity',l.approved_quantity,'received_quantity',l.received_quantity,'reference_balance',l.reference_balance,'reference_at',l.reference_at,'notes',l.notes) order by l.id),'[]'::jsonb) from public.inventory_submission_lines l join public.inventory_items i on i.id=l.item_id where l.submission_id=s.id)) row_data
    from public.inventory_submissions s
    where (requested_kind is null or s.kind=requested_kind)
      and (
        requested_status is null
        or (requested_status='pending' and (s.status in ('sent','partially_approved') or (s.kind='replenishment' and s.status in ('approved','partially_received'))))
        or (requested_status='pending_sent' and s.status='sent')
        or (requested_status='pending_partially_approved' and s.status='partially_approved')
        or (requested_status='pending_approved' and s.kind='replenishment' and s.status='approved')
        or (requested_status='pending_partially_received' and s.kind='replenishment' and s.status='partially_received')
        or (requested_status not like 'pending%' and s.status=requested_status)
      )
      and (requested_area is null or s.area=requested_area)
      and (costs or lower(s.created_by)=public.inventory_actor_email() or exists(select 1 from public.staff_role_assignments r where lower(r.email)=public.inventory_actor_email() and r.role=s.area))
      and (before_created_at is null or (s.created_at,s.id)<(before_created_at,before_id))
    order by s.created_at desc,s.id desc limit 21
  ), numbered as (select *,row_number() over(order by created_at desc,id desc) rn from candidates)
  select jsonb_build_object('rows',coalesce(jsonb_agg(row_data order by created_at desc,id desc) filter(where rn<=20),'[]'::jsonb),'has_more',count(*)>20) into result from numbered;
  return result;
end;
$$;

revoke all on function public.inventory_submissions_page(text,text,timestamptz,uuid,text) from public,anon;
grant execute on function public.inventory_submissions_page(text,text,timestamptz,uuid,text) to authenticated;

commit;
