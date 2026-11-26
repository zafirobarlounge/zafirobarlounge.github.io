-- Incremental upgrade AFTER 202610010022_inventory_pending_submissions_by_kind.sql. Manual review/application in QA.
-- A physical receipt line can cover several replenishment request lines without duplicating stock, cost or cash movements.
begin;

create table public.inventory_receipt_line_submission_applications (
  receipt_line_id uuid not null references public.inventory_receipt_lines(id) on delete restrict,
  submission_line_id uuid not null references public.inventory_submission_lines(id) on delete restrict,
  applied_quantity numeric not null check (applied_quantity > 0),
  created_at timestamptz not null default now(),
  primary key (receipt_line_id,submission_line_id)
);
create index inventory_receipt_line_submission_applications_submission_idx on public.inventory_receipt_line_submission_applications(submission_line_id);
alter table public.inventory_receipt_line_submission_applications enable row level security;
revoke all on table public.inventory_receipt_line_submission_applications from public,anon,authenticated;

-- Historical one-to-one links remain valid and become readable through the same relation.
insert into public.inventory_receipt_line_submission_applications(receipt_line_id,submission_line_id,applied_quantity)
select id,submission_line_id,applied_submission_quantity
from public.inventory_receipt_lines
where submission_line_id is not null and applied_submission_quantity is not null
on conflict do nothing;

do $$
declare definition text;
begin
  select pg_get_functiondef('public.inventory_command(uuid,jsonb)'::regprocedure) into definition;
  definition:=replace(definition,'FUNCTION public.inventory_command(request_id uuid, payload jsonb)','FUNCTION public.inventory_command_single_submission_application(request_id uuid, payload jsonb)');
  definition:=replace(definition,'inventory_command.request_id','inventory_command_single_submission_application.request_id');
  execute definition;
end;
$$;

create or replace function public.inventory_command(request_id uuid,payload jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  actor text:=public.inventory_actor_email(); previous public.inventory_command_audit;
  item public.inventory_items; pres public.inventory_purchase_presentations; receipt public.inventory_receipts;
  subline public.inventory_submission_lines; allocation jsonb; line jsonb; receipt_line_id uuid;
  qty numeric; actual_package_cost numeric; line_total numeric; base_cost numeric; derived_total numeric:=0;
  all_costs_known boolean:=true; allocation_total numeric; allocation_metadata jsonb; valuation jsonb; expense public.pos_cash_movements;
begin
  -- Existing actions and the legacy one-request-line payload preserve their exact behavior.
  if payload->>'action'<>'receive' or not exists(select 1 from jsonb_array_elements(coalesce(payload->'lines','[]'::jsonb)) value where value ? 'submission_allocations') then
    return public.inventory_command_single_submission_application(request_id,payload);
  end if;
  if request_id is null or payload is null or not public.inventory_is_active_staff() or not public.inventory_can_manage() then raise exception 'Solicitud de inventario invalida o no autorizada'; end if;
  perform pg_advisory_xact_lock(9272026,5);
  select * into previous from public.inventory_command_audit a where a.request_id=inventory_command.request_id;
  if found then
    if previous.actor<>actor or previous.payload<>payload then raise exception 'La solicitud ya existe con otros datos'; end if;
    return previous.result;
  end if;
  if coalesce(jsonb_array_length(payload->'lines'),0)=0 then raise exception 'La recepcion requiere lineas'; end if;

  -- Lock all target request lines in a deterministic order before checking their current pending balance.
  perform 1 from public.inventory_submission_lines l
  where l.id in (
    select (alloc_row.value->>'submission_line_id')::uuid
    from jsonb_array_elements(payload->'lines') source_line,
         jsonb_array_elements(coalesce(source_line.value->'submission_allocations','[]'::jsonb)) alloc_row
  ) order by l.id for update;

  for line in select value from jsonb_array_elements(payload->'lines') loop
    select * into item from public.inventory_items where id=(line->>'item_id')::uuid;
    if not found then raise exception 'Articulo inexistente'; end if;
    pres:=null; actual_package_cost:=null; line_total:=null;
    if line->>'presentation_id' is not null then
      select * into pres from public.inventory_purchase_presentations where id=(line->>'presentation_id')::uuid and item_id=item.id and active;
      if not found then raise exception 'Presentacion inexistente o inactiva'; end if;
      qty:=pres.content_per_package*(line->>'package_quantity')::numeric;
      actual_package_cost:=(line->>'actual_package_cost')::numeric;
      if actual_package_cost is not null then line_total:=round((line->>'package_quantity')::numeric*actual_package_cost,2); end if;
    else
      qty:=(line->>'base_quantity')::numeric;
      line_total:=(line->>'line_total_cost')::numeric;
      if line_total is null and line->>'base_unit_cost' is not null then line_total:=round(qty*(line->>'base_unit_cost')::numeric,2); end if;
      if line_total is not null and line->>'base_unit_cost' is not null and round(qty*(line->>'base_unit_cost')::numeric,2)<>line_total then raise exception 'El costo total y el costo unitario de la linea no coinciden'; end if;
    end if;
    if qty is null or qty<=0 then raise exception 'Cantidad recibida invalida'; end if;
    if line_total is null then all_costs_known:=false; else derived_total:=derived_total+line_total; end if;
  end loop;
  derived_total:=case when all_costs_known then round(derived_total,2) else null end;
  if payload->>'total_cost' is not null and (derived_total is null or (payload->>'total_cost')::numeric<>derived_total) then raise exception 'El costo total de la recepcion no coincide con la suma de sus lineas'; end if;
  if payload->>'expense_movement_id' is not null then
    select * into expense from public.pos_cash_movements where id=(payload->>'expense_movement_id')::uuid;
    if not found or expense.kind<>'expense' or expense.voided_at is not null or derived_total is null or expense.amount<>derived_total then raise exception 'El gasto vinculado no es valido o no coincide con la recepcion'; end if;
  end if;
  insert into public.inventory_receipts(request_id,supplier,document_reference,expense_movement_id,total_cost,received_at,received_by,notes)
  values(request_id,nullif(trim(payload->>'supplier'),''),nullif(trim(payload->>'document_reference'),''),(payload->>'expense_movement_id')::uuid,derived_total,coalesce((payload->>'received_at')::timestamptz,now()),actor,coalesce(payload->>'notes','')) returning * into receipt;

  for line in select value from jsonb_array_elements(payload->'lines') loop
    select * into item from public.inventory_items where id=(line->>'item_id')::uuid for update;
    if item.tracking_started_at is null then raise exception 'Registra primero el conteo inicial de %',item.name; end if;
    pres:=null; actual_package_cost:=null; line_total:=null; base_cost:=null;
    if line->>'presentation_id' is not null then
      select * into pres from public.inventory_purchase_presentations where id=(line->>'presentation_id')::uuid and item_id=item.id and active;
      qty:=pres.content_per_package*(line->>'package_quantity')::numeric;
      actual_package_cost:=(line->>'actual_package_cost')::numeric;
      if actual_package_cost is not null then line_total:=round((line->>'package_quantity')::numeric*actual_package_cost,2); end if;
    else
      qty:=(line->>'base_quantity')::numeric;
      line_total:=(line->>'line_total_cost')::numeric;
      if line_total is null and line->>'base_unit_cost' is not null then line_total:=round(qty*(line->>'base_unit_cost')::numeric,2); end if;
    end if;
    if line_total is not null then base_cost:=round(line_total/qty,10); end if;
    allocation_total:=0; allocation_metadata:='[]'::jsonb;
    insert into public.inventory_receipt_lines(receipt_id,item_id,presentation_id,presentation_name_snapshot,content_per_package_snapshot,content_unit_snapshot,package_quantity,base_quantity,unit_cost,submission_line_id,applied_submission_quantity,actual_package_cost,line_total_cost,base_unit_cost)
    values(receipt.id,item.id,pres.id,pres.name,pres.content_per_package,pres.content_unit,(line->>'package_quantity')::numeric,qty,case when base_cost is null then null else round(base_cost,4) end,null,null,actual_package_cost,line_total,base_cost) returning id into receipt_line_id;
    for allocation in select value from jsonb_array_elements(coalesce(line->'submission_allocations','[]'::jsonb)) loop
      if (allocation->>'quantity')::numeric is null or (allocation->>'quantity')::numeric<=0 then raise exception 'Cantidad de asignacion invalida'; end if;
      allocation_total:=allocation_total+(allocation->>'quantity')::numeric;
      if allocation_total>qty then raise exception 'Las asignaciones superan la cantidad realmente recibida'; end if;
      select l.* into subline from public.inventory_submission_lines l join public.inventory_submissions s on s.id=l.submission_id
      where l.id=(allocation->>'submission_line_id')::uuid and l.item_id=item.id and s.kind='replenishment' and s.status in ('approved','partially_approved','partially_received');
      if not found or subline.approved_quantity is null or (allocation->>'quantity')::numeric>greatest(subline.approved_quantity-subline.received_quantity,0) then raise exception 'La asignacion supera la cantidad pendiente o no corresponde a una solicitud aprobada'; end if;
      insert into public.inventory_receipt_line_submission_applications(receipt_line_id,submission_line_id,applied_quantity) values(receipt_line_id,subline.id,(allocation->>'quantity')::numeric);
      update public.inventory_submission_lines set received_quantity=received_quantity+(allocation->>'quantity')::numeric where id=subline.id;
      update public.inventory_submissions s set status=case when not exists(select 1 from public.inventory_submission_lines l where l.submission_id=s.id and coalesce(l.approved_quantity,0)>l.received_quantity) then 'received' else 'partially_received' end where s.id=subline.submission_id;
      allocation_metadata:=allocation_metadata||jsonb_build_array(jsonb_build_object('submission_line_id',subline.id,'applied_quantity',(allocation->>'quantity')::numeric));
    end loop;
    valuation:=public.inventory_apply_valuation(item.id,qty,base_cost,'receipt');
    insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,receipt_id,metadata,unit_cost_snapshot,tracked_value_delta,quantity_balance_after,average_unit_cost_after,inventory_value_after)
    values('receipt-line:'||receipt_line_id,item.id,'purchase_receipt',qty,item.base_unit,'Recepcion de compra',actor,receipt.id,jsonb_build_object('presentation_name',pres.name,'content_per_package',pres.content_per_package,'package_quantity',line->>'package_quantity','actual_package_cost',actual_package_cost,'line_total_cost',line_total,'base_unit_cost',base_cost,'submission_allocations',allocation_metadata,'excess_quantity',qty-allocation_total),base_cost,(valuation->>'tracked_value_delta')::numeric,(valuation->>'quantity_balance_after')::numeric,(valuation->>'average_unit_cost_after')::numeric,(valuation->>'inventory_value_after')::numeric);
  end loop;
  insert into public.inventory_command_audit(request_id,actor,payload,result) values(request_id,actor,payload,to_jsonb(receipt));
  return to_jsonb(receipt);
end;
$$;

revoke all on function public.inventory_command_single_submission_application(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.inventory_command(uuid,jsonb) from public,anon;
grant execute on function public.inventory_command(uuid,jsonb) to authenticated;

create or replace function public.inventory_receipts_page(before_received_at timestamptz default null,before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if not public.inventory_is_active_staff() or not public.inventory_can_manage() then raise exception 'Acceso denegado a entradas'; end if;
  if (before_received_at is null)<>(before_id is null) then raise exception 'Cursor de entradas invalido'; end if;
  with candidates as (
    select r.received_at,r.id,jsonb_build_object('id',r.id,'supplier',r.supplier,'document_reference',r.document_reference,'expense_movement_id',r.expense_movement_id,'total_cost',r.total_cost,'received_at',r.received_at,'received_by',r.received_by,'notes',r.notes,
      'purchase',case when p.id is null then null else jsonb_build_object('id',p.id,'payment_status',p.payment_status,'payment_origin',p.payment_origin,'total_amount',p.total_amount,'purchase_date',p.purchase_date) end,
      'lines',(select coalesce(jsonb_agg(to_jsonb(l)||jsonb_build_object('submission_allocations',(select coalesce(jsonb_agg(jsonb_build_object('submission_line_id',a.submission_line_id,'applied_quantity',a.applied_quantity) order by a.submission_line_id),'[]'::jsonb) from public.inventory_receipt_line_submission_applications a where a.receipt_line_id=l.id)) order by l.id),'[]'::jsonb) from public.inventory_receipt_lines l where l.receipt_id=r.id)) row_data
    from public.inventory_receipts r left join public.inventory_purchases p on p.receipt_id=r.id
    where (before_received_at is null or (r.received_at,r.id)<(before_received_at,before_id)) order by r.received_at desc,r.id desc limit 21
  ), page as (select * from candidates limit 20)
  select jsonb_build_object('rows',coalesce(jsonb_agg(row_data order by received_at desc,id desc),'[]'::jsonb),'has_more',(select count(*)>20 from candidates)) into result from page;
  return result;
end;
$$;

commit;
