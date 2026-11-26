-- Incremental upgrade AFTER 202609290019_inventory_void_courtesy.sql. Manual review/application in QA.
-- Publishes a cost-free inventory change signal without exposing inventory history rows.
begin;

create table public.inventory_realtime_events (
  id bigint generated always as identity primary key,
  event_kind text not null check (event_kind in ('movement','submission','receipt','configuration')),
  occurred_at timestamptz not null default now()
);

create index inventory_realtime_events_time_idx on public.inventory_realtime_events(occurred_at desc,id desc);

alter table public.inventory_realtime_events enable row level security;
revoke all on table public.inventory_realtime_events from public,anon,authenticated;
grant select on table public.inventory_realtime_events to authenticated;

create function public.inventory_can_receive_realtime() returns boolean
language sql stable security definer set search_path=public as $$
  select public.inventory_can_manage()
    or (public.inventory_is_active_staff() and (public.has_staff_role('bar') or public.has_staff_role('kitchen')));
$$;

revoke all on function public.inventory_can_receive_realtime() from public,anon;
grant execute on function public.inventory_can_receive_realtime() to authenticated;

create policy inventory_realtime_events_read on public.inventory_realtime_events
for select to authenticated using (public.inventory_can_receive_realtime());

create function public.inventory_emit_realtime_event() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  delete from public.inventory_realtime_events where occurred_at < now()-interval '7 days';
  insert into public.inventory_realtime_events(event_kind) values(tg_argv[0]);
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.inventory_emit_realtime_event() from public,anon,authenticated;

create trigger inventory_movements_realtime after insert on public.inventory_movements
for each row execute function public.inventory_emit_realtime_event('movement');
create trigger inventory_submissions_realtime after insert or update on public.inventory_submissions
for each row execute function public.inventory_emit_realtime_event('submission');
create trigger inventory_receipts_realtime after insert on public.inventory_receipts
for each row execute function public.inventory_emit_realtime_event('receipt');
create trigger inventory_items_realtime after insert or update or delete on public.inventory_items
for each row execute function public.inventory_emit_realtime_event('configuration');
create trigger inventory_item_areas_realtime after insert or update or delete on public.inventory_item_areas
for each row execute function public.inventory_emit_realtime_event('configuration');
create trigger inventory_presentations_realtime after insert or update or delete on public.inventory_purchase_presentations
for each row execute function public.inventory_emit_realtime_event('configuration');
create trigger inventory_areas_realtime after insert or update or delete on public.inventory_areas
for each row execute function public.inventory_emit_realtime_event('configuration');
create trigger inventory_menu_tracking_realtime after insert or update or delete on public.inventory_menu_tracking
for each row execute function public.inventory_emit_realtime_event('configuration');
create trigger inventory_recipe_components_realtime after insert or update or delete on public.inventory_menu_recipe_components
for each row execute function public.inventory_emit_realtime_event('configuration');

do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='inventory_realtime_events') then
    alter publication supabase_realtime add table public.inventory_realtime_events;
  end if;
end;
$$;

commit;
