-- Incremental upgrade AFTER 202609290020_inventory_realtime_signal.sql. Manual review/application in QA.
-- Links one financial movement and one inventory receipt through one atomic, idempotent purchase command.
begin;

create table public.inventory_purchases (
  id uuid primary key,
  request_id uuid not null unique,
  receipt_id uuid not null unique references public.inventory_receipts(id) on delete restrict,
  expense_movement_id uuid unique references public.pos_cash_movements(id) on delete restrict,
  payment_status text not null check (payment_status in ('paid','pending','legacy_unlinked')),
  payment_origin text check (payment_origin in ('register','business','owner')),
  total_amount numeric(14,2) check (total_amount is null or (total_amount > 0 and total_amount < 1000000000000)),
  purchase_date date not null,
  created_at timestamptz not null default now(),
  created_by text not null,
  notes text not null default '',
  request_payload jsonb not null,
  result jsonb not null,
  check (
    (payment_status in ('pending','legacy_unlinked') and payment_origin is null and expense_movement_id is null)
    or (payment_status='paid' and payment_origin is not null and expense_movement_id is not null and total_amount is not null)
  )
);

create index inventory_purchases_date_idx on public.inventory_purchases(purchase_date desc,id desc);
alter table public.inventory_purchases enable row level security;
revoke all on table public.inventory_purchases from public,anon,authenticated;
grant select on table public.inventory_purchases to authenticated;
create function public.inventory_can_read_purchases() returns boolean
language sql stable security definer set search_path=public as $$ select public.inventory_can_manage(); $$;
revoke all on function public.inventory_can_read_purchases() from public,anon;
grant execute on function public.inventory_can_read_purchases() to authenticated;
create policy inventory_purchases_read on public.inventory_purchases
for select to authenticated using (public.inventory_can_read_purchases());

-- Existing receipts become traceable purchases without changing their receipt, stock or cost history.
insert into public.inventory_purchases(id,request_id,receipt_id,expense_movement_id,payment_status,payment_origin,total_amount,purchase_date,created_at,created_by,notes,request_payload,result)
select r.request_id,r.request_id,r.id,r.expense_movement_id,
  case when r.expense_movement_id is null then 'legacy_unlinked' else 'paid' end,
  m.origin,r.total_cost,(r.received_at at time zone 'America/Bogota')::date,r.received_at,r.received_by,r.notes,
  jsonb_build_object('legacy',true),
  jsonb_build_object('purchase_id',r.request_id,'receipt_id',r.id,'expense_movement_id',r.expense_movement_id,'payment_status',case when r.expense_movement_id is null then 'legacy_unlinked' else 'paid' end)
from public.inventory_receipts r
left join public.pos_cash_movements m on m.id=r.expense_movement_id
on conflict do nothing;

create function public.inventory_purchase_command(request_id uuid,payload jsonb) returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  actor text:=public.inventory_actor_email(); previous public.inventory_purchases;
  payment_source text:=payload->>'payment_origin'; expense_result jsonb; receipt_result jsonb; result_payload jsonb;
  cash_payload jsonb; receipt_payload jsonb; total numeric:=(payload->>'total_cost')::numeric;
begin
  if request_id is null or payload is null or not public.inventory_can_manage() then raise exception 'Compra invalida o no autorizada'; end if;
  if payload->>'action'<>'purchase' then raise exception 'Operacion de compra requerida'; end if;
  if payload->>'source' not in ('cash','inventory') then raise exception 'Origen del registro de compra invalido'; end if;
  if payment_source not in ('register','business','owner','unpaid') then raise exception 'Origen de pago invalido'; end if;
  perform pg_advisory_xact_lock(9272026,1);
  perform pg_advisory_xact_lock(9272026,5);
  select * into previous from public.inventory_purchases p where p.request_id=inventory_purchase_command.request_id;
  if found then
    if previous.created_by<>actor or previous.request_payload<>payload then raise exception 'La solicitud ya existe con otros datos'; end if;
    return previous.result;
  end if;
  if coalesce(jsonb_array_length(payload->'lines'),0)=0 then raise exception 'La compra requiere productos'; end if;
  if payment_source<>'unpaid' and (total is null or total<=0) then raise exception 'Una compra pagada requiere un total valido'; end if;
  if payment_source='register' and payload->>'session' is null then raise exception 'Selecciona una jornada abierta con caja registrada'; end if;

  if payment_source<>'unpaid' then
    cash_payload:=jsonb_build_object(
      'action','movement','session',case when payment_source='register' then payload->'session' else coalesce(payload->'session','null'::jsonb) end,
      'kind','expense','concept',coalesce(nullif(trim(payload->>'concept'),''),'Compra de insumos'),
      'category','supplies','amount',total,'date',(payload->>'date')::date,
      'method',case when payment_source='register' then 'cash' else coalesce(nullif(payload->>'method',''),'other') end,
      'origin',payment_source,'notes',coalesce(payload->>'notes','')
    );
    expense_result:=public.pos_cash_command(request_id,cash_payload);
  end if;

  receipt_payload:=jsonb_build_object(
    'action','receive','supplier',payload->>'supplier','document_reference',payload->>'document_reference',
    'expense_movement_id',case when expense_result is null then null else expense_result->>'id' end,
    'total_cost',total,'received_at',payload->>'received_at','notes',coalesce(payload->>'notes',''),'lines',payload->'lines'
  );
  receipt_result:=public.inventory_command(request_id,receipt_payload);
  result_payload:=jsonb_build_object(
    'purchase_id',request_id,'receipt_id',receipt_result->>'id',
    'expense_movement_id',case when expense_result is null then null else expense_result->>'id' end,
    'payment_status',case when payment_source='unpaid' then 'pending' else 'paid' end,
    'payment_origin',case when payment_source='unpaid' then null else payment_source end,
    'total_amount',total
  );
  insert into public.inventory_purchases(id,request_id,receipt_id,expense_movement_id,payment_status,payment_origin,total_amount,purchase_date,created_by,notes,request_payload,result)
  values(request_id,request_id,(receipt_result->>'id')::uuid,(expense_result->>'id')::uuid,
    case when payment_source='unpaid' then 'pending' else 'paid' end,
    case when payment_source='unpaid' then null else payment_source end,total,
    coalesce((payload->>'date')::date,(coalesce((payload->>'received_at')::timestamptz,now()) at time zone 'America/Bogota')::date),actor,coalesce(payload->>'notes',''),payload,result_payload);
  return result_payload;
end;
$$;

revoke all on function public.inventory_purchase_command(uuid,jsonb) from public,anon;
grant execute on function public.inventory_purchase_command(uuid,jsonb) to authenticated;

create or replace function public.pos_cash_read() returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if not public.pos_cash_allowed() then raise exception 'Acceso denegado a caja'; end if;
  return jsonb_build_object(
    'sessions',(select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('components',public.pos_cash_components(s.id)) order by s.opened_at desc),'[]') from public.pos_sales_sessions s),
    'registers',(select coalesce(jsonb_agg(c order by opened_at desc),'[]') from public.pos_cash_registers c),
    'movements',(select coalesce(jsonb_agg(to_jsonb(m)||jsonb_build_object('purchase_id',p.id,'inventory_receipt_id',p.receipt_id) order by m.created_at desc),'[]') from public.pos_cash_movements m left join public.inventory_purchases p on p.expense_movement_id=m.id)
  );
end;
$$;

create or replace function public.inventory_receipts_page(before_received_at timestamptz default null,before_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if not public.inventory_is_active_staff() or not public.inventory_can_manage() then raise exception 'Acceso denegado a entradas'; end if;
  if (before_received_at is null)<>(before_id is null) then raise exception 'Cursor de entradas invalido'; end if;
  with candidates as (
    select r.received_at,r.id,jsonb_build_object('id',r.id,'supplier',r.supplier,'document_reference',r.document_reference,'expense_movement_id',r.expense_movement_id,'total_cost',r.total_cost,'received_at',r.received_at,'received_by',r.received_by,'notes',r.notes,
      'purchase',case when p.id is null then null else jsonb_build_object('id',p.id,'payment_status',p.payment_status,'payment_origin',p.payment_origin,'total_amount',p.total_amount,'purchase_date',p.purchase_date) end,
      'lines',(select coalesce(jsonb_agg(to_jsonb(l) order by l.id),'[]'::jsonb) from public.inventory_receipt_lines l where l.receipt_id=r.id)) row_data
    from public.inventory_receipts r left join public.inventory_purchases p on p.receipt_id=r.id
    where before_received_at is null or (r.received_at,r.id)<(before_received_at,before_id)
    order by r.received_at desc,r.id desc limit 21
  ), numbered as (select *,row_number() over(order by received_at desc,id desc) rn from candidates)
  select jsonb_build_object('rows',coalesce(jsonb_agg(row_data order by received_at desc,id desc) filter(where rn<=20),'[]'::jsonb),'has_more',count(*)>20) into result from numbered;
  return result;
end;
$$;

commit;
