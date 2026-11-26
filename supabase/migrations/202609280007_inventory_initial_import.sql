-- Importación inicial incremental para Inventario. Aplicación manual en QA después de 006.
-- No importa automáticamente ningún archivo, no reconstruye historia y no crea recepciones ni gastos.
begin;

alter table public.inventory_items add column import_code text;
alter table public.inventory_items add column import_notes text not null default '';
create unique index inventory_items_import_code_key on public.inventory_items(import_code) where import_code is not null;

alter table public.inventory_purchase_presentations add column import_notes text not null default '';

create table public.inventory_import_batches (
  request_id uuid primary key,
  fingerprint text not null unique check (fingerprint ~ '^[0-9a-f]{64}$'),
  actor text not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
create trigger inventory_import_batches_immutable before update or delete on public.inventory_import_batches
for each row execute function public.inventory_prevent_history_change();

create function public.inventory_import_preview(payload jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  article jsonb; presentation jsonb; recipe jsonb; menu_key text; existing public.inventory_items;
  item_unit text; v_item_id uuid; existing_presentation public.inventory_purchase_presentations;
  new_articles jsonb := '[]'; existing_articles jsonb := '[]'; new_presentations jsonb := '[]'; existing_presentations jsonb := '[]';
  new_recipes jsonb := '[]'; existing_recipes jsonb := '[]'; errors jsonb := '[]'; warnings jsonb := '[]';
  area_count integer; expected_count integer; actual_count integer; costs_without_count integer:=0; valid_associations integer:=0;
begin
  if payload is null or not public.inventory_can_configure() then raise exception 'Solo administración puede previsualizar importaciones de inventario'; end if;
  if jsonb_typeof(payload->'articles') <> 'array' or jsonb_typeof(payload->'presentations') <> 'array' or jsonb_typeof(payload->'menu_consumption') <> 'array' then
    raise exception 'Formato de importación inválido';
  end if;

  if exists(select 1 from jsonb_array_elements(payload->'articles') a group by upper(trim(a->>'code')) having count(*) > 1) then
    errors := errors || jsonb_build_array('Hay códigos de artículo duplicados en el archivo.');
  end if;
  if exists(select 1 from jsonb_array_elements(payload->'presentations') p group by upper(trim(p->>'item_code')), lower(trim(p->>'name')) having count(*) > 1) then
    errors := errors || jsonb_build_array('Hay presentaciones duplicadas en el archivo.');
  end if;
  if exists(select 1 from jsonb_array_elements(payload->'menu_consumption') r group by r->>'menu_item_source_key', upper(trim(r->>'item_code')) having count(*) > 1) then
    errors := errors || jsonb_build_array('Hay asociaciones de menú duplicadas en el archivo.');
  end if;

  for article in select value from jsonb_array_elements(payload->'articles') loop
    if nullif(trim(article->>'code'),'') is null or article->>'code' !~ '^[A-Z0-9_]+$' or nullif(trim(article->>'name'),'') is null then
      errors := errors || jsonb_build_array('Artículo inválido: código y nombre son obligatorios; el código admite A-Z, 0-9 y _.'); continue;
    end if;
    if article->>'base_unit' not in ('unit','gram','milliliter') or article->>'area' not in ('bar','kitchen','both') then
      errors := errors || jsonb_build_array('Artículo '||(article->>'code')||': unidad o área inválida.'); continue;
    end if;
    if (article->>'initial_quantity')::numeric < 0 or (article->>'initial_unit_cost')::numeric < 0
      or (article->>'minimum_quantity')::numeric < 0 or (article->>'target_quantity')::numeric < 0
      or (article->>'target_quantity')::numeric < (article->>'minimum_quantity')::numeric then
      errors := errors || jsonb_build_array('Artículo '||(article->>'code')||': cantidades o costos inválidos.'); continue;
    end if;
    if (article->>'initial_quantity') is null and (article->>'initial_unit_cost') is not null then
      costs_without_count:=costs_without_count+1;
    end if;
    select * into existing from public.inventory_items where import_code=article->>'code';
    if found then
      select count(*) into area_count from public.inventory_item_areas a where a.item_id=existing.id;
      if not existing.active or existing.name is distinct from trim(article->>'name') or existing.base_unit is distinct from article->>'base_unit'
        or existing.minimum_quantity is distinct from (article->>'minimum_quantity')::numeric
        or existing.target_quantity is distinct from (article->>'target_quantity')::numeric
        or existing.import_notes is distinct from coalesce(article->>'notes','')
        or area_count <> (case when article->>'area'='both' then 2 else 1 end)
        or (article->>'area'<>'both' and not exists(select 1 from public.inventory_item_areas a where a.item_id=existing.id and a.area=article->>'area')) then
        errors := errors || jsonb_build_array('Conflicto en artículo '||(article->>'code')||': ya existe con otra configuración; no se sobrescribirá.');
      elsif (article->>'initial_quantity') is not null and existing.tracking_started_at is not null then
        errors := errors || jsonb_build_array('Conflicto en artículo '||(article->>'code')||': ya tiene conteo inicial.');
      else existing_articles := existing_articles || jsonb_build_array(article->>'code'); end if;
    elsif exists(select 1 from public.inventory_items i where lower(trim(i.name))=lower(trim(article->>'name'))) then
      errors := errors || jsonb_build_array('Conflicto en artículo '||(article->>'code')||': el nombre ya existe sin ese código de importación.');
    else new_articles := new_articles || jsonb_build_array(article->>'code'); end if;
  end loop;
  if costs_without_count>0 then warnings:=warnings||jsonb_build_array(costs_without_count||' artículo(s) tienen costo de referencia sin existencia; no se generará conteo para ellos.'); end if;

  for presentation in select value from jsonb_array_elements(payload->'presentations') loop
    select i.id,i.base_unit into v_item_id,item_unit from public.inventory_items i where i.import_code=presentation->>'item_code';
    if v_item_id is null then
      select nullif(a->>'base_unit','') into item_unit from jsonb_array_elements(payload->'articles') a where a->>'code'=presentation->>'item_code' limit 1;
    end if;
    if item_unit is null then errors := errors || jsonb_build_array('Presentación '||(presentation->>'name')||': artículo '||(presentation->>'item_code')||' inexistente.'); continue; end if;
    if presentation->>'content_unit' is distinct from item_unit then
      errors := errors || jsonb_build_array('Presentación '||(presentation->>'name')||': la unidad no coincide con la base; no se aplican conversiones automáticas.'); continue;
    end if;
    if (presentation->>'content_per_package')::numeric <= 0 or (presentation->>'suggested_package_cost')::numeric < 0 then
      errors := errors || jsonb_build_array('Presentación '||(presentation->>'name')||': contenido o costo inválido.'); continue;
    end if;
    if v_item_id is not null then
      select * into existing_presentation from public.inventory_purchase_presentations p where p.item_id=v_item_id and lower(trim(p.name))=lower(trim(presentation->>'name'));
    else existing_presentation.id := null; end if;
    if existing_presentation.id is not null then
      if existing_presentation.content_per_package is distinct from (presentation->>'content_per_package')::numeric
        or existing_presentation.content_unit is distinct from presentation->>'content_unit'
        or existing_presentation.suggested_package_cost is distinct from (presentation->>'suggested_package_cost')::numeric
        or existing_presentation.import_notes is distinct from coalesce(presentation->>'notes','') or not existing_presentation.active then
        errors := errors || jsonb_build_array('Conflicto en presentación '||(presentation->>'item_code')||' / '||(presentation->>'name')||'.');
      else existing_presentations := existing_presentations || jsonb_build_array((presentation->>'item_code')||' / '||(presentation->>'name')); end if;
    else new_presentations := new_presentations || jsonb_build_array((presentation->>'item_code')||' / '||(presentation->>'name')); end if;
  end loop;

  for recipe in select value from jsonb_array_elements(payload->'menu_consumption') loop
    select i.id,i.base_unit into v_item_id,item_unit from public.inventory_items i where i.import_code=recipe->>'item_code';
    if v_item_id is null then select nullif(a->>'base_unit','') into item_unit from jsonb_array_elements(payload->'articles') a where a->>'code'=recipe->>'item_code' limit 1; end if;
    if not exists(select 1 from public.menu_items m where m.source_key=recipe->>'menu_item_source_key') then
      errors := errors || jsonb_build_array('Producto de menú no resuelto por clave estable: '||(recipe->>'menu_item_source_key')||'.');
    elsif item_unit is null then errors := errors || jsonb_build_array('Asociación de menú: artículo '||(recipe->>'item_code')||' inexistente.');
    elsif recipe->>'unit' is distinct from item_unit then errors := errors || jsonb_build_array('Asociación '||(recipe->>'item_code')||': unidad incompatible; no se convierten tajadas, tiras, hojas o rodajas.');
    elsif recipe->>'control_mode' <> 'partial' or (recipe->>'quantity_base')::numeric <= 0 then errors := errors || jsonb_build_array('Asociación de menú inválida para '||(recipe->>'item_code')||'.');
    else valid_associations:=valid_associations+1;
    end if;
  end loop;

  for menu_key in select distinct value->>'menu_item_source_key' from jsonb_array_elements(payload->'menu_consumption') loop
    if exists(select 1 from public.inventory_menu_tracking t where t.menu_item_source_key=menu_key) then
      select count(*) into expected_count from jsonb_array_elements(payload->'menu_consumption') r where r->>'menu_item_source_key'=menu_key;
      select count(*) into actual_count from public.inventory_menu_recipe_components c where c.menu_item_source_key=menu_key and c.active;
      if expected_count<>actual_count or exists(
        select 1 from jsonb_array_elements(payload->'menu_consumption') r
        left join public.inventory_items i on i.import_code=r->>'item_code'
        left join public.inventory_menu_recipe_components c on c.menu_item_source_key=menu_key and c.item_id=i.id and c.active
        where r->>'menu_item_source_key'=menu_key and (c.id is null or c.quantity_base is distinct from (r->>'quantity_base')::numeric)
      ) or exists(select 1 from public.inventory_menu_tracking t where t.menu_item_source_key=menu_key and t.control_mode<>'partial') then
        errors := errors || jsonb_build_array('Conflicto en receta '||menu_key||': ya existe con otra configuración; no se sobrescribirá.');
      else existing_recipes := existing_recipes || jsonb_build_array(menu_key); end if;
    else new_recipes := new_recipes || jsonb_build_array(menu_key); end if;
  end loop;

  return jsonb_build_object(
    'new_articles',new_articles,'existing_articles',existing_articles,
    'new_presentations',new_presentations,'existing_presentations',existing_presentations,
    'new_menu_products',new_recipes,'existing_menu_products',existing_recipes,
    'menu_association_count',valid_associations,
    'initial_count_count',(select count(*) from jsonb_array_elements(payload->'articles') a where (a->>'initial_quantity') is not null),
    'warnings',warnings,'errors',errors
  );
end;
$$;

create function public.inventory_import_commit(request_id uuid, fingerprint text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  actor text:=public.inventory_actor_email(); previous public.inventory_import_batches; preview jsonb; article jsonb; presentation jsonb; recipe jsonb;
  imported_item public.inventory_items; v_item_id uuid; valuation jsonb; result jsonb;
  created_articles integer:=0; created_presentations integer:=0; created_associations integer:=0; created_counts integer:=0;
begin
  if request_id is null or fingerprint !~ '^[0-9a-f]{64}$' or not public.inventory_can_configure() then raise exception 'Solo administración puede importar inventario'; end if;
  perform pg_advisory_xact_lock(9272026,7);
  select * into previous from public.inventory_import_batches b where b.request_id=inventory_import_commit.request_id or b.fingerprint=inventory_import_commit.fingerprint order by (b.request_id=inventory_import_commit.request_id) desc limit 1;
  if found then
    if previous.actor<>actor or previous.payload<>payload or previous.fingerprint<>fingerprint then raise exception 'La importación ya existe con otros datos'; end if;
    return previous.result;
  end if;
  preview:=public.inventory_import_preview(payload);
  if jsonb_array_length(preview->'errors')>0 then raise exception 'La importación tiene conflictos: %',preview->'errors'; end if;

  for article in select value from jsonb_array_elements(payload->'articles') loop
    select * into imported_item from public.inventory_items where import_code=article->>'code';
    if not found then
      insert into public.inventory_items(import_code,name,active,base_unit,precision_scale,minimum_quantity,target_quantity,import_notes,created_by,updated_by)
      values(article->>'code',trim(article->>'name'),true,article->>'base_unit',case when article->>'base_unit'='unit' then 0 else 3 end,
        (article->>'minimum_quantity')::numeric,(article->>'target_quantity')::numeric,coalesce(article->>'notes',''),actor,actor) returning * into imported_item;
      insert into public.inventory_item_areas(item_id,area)
        select imported_item.id,value from jsonb_array_elements_text(case article->>'area' when 'both' then '["bar","kitchen"]'::jsonb else jsonb_build_array(article->>'area') end);
      created_articles:=created_articles+1;
    end if;
    if (article->>'initial_quantity') is not null then
      update public.inventory_items set tracking_started_at=now(),updated_at=now(),updated_by=actor where id=imported_item.id;
      valuation:=public.inventory_apply_valuation(imported_item.id,(article->>'initial_quantity')::numeric,(article->>'initial_unit_cost')::numeric,'initial');
      insert into public.inventory_movements(operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,metadata,unit_cost_snapshot,tracked_value_delta,quantity_balance_after,average_unit_cost_after,inventory_value_after)
      values('import-initial:'||fingerprint||':'||(article->>'code'),imported_item.id,'initial_count',(article->>'initial_quantity')::numeric,imported_item.base_unit,'Conteo inicial importado',actor,
        jsonb_build_object('import_request_id',request_id,'counted_quantity',(article->>'initial_quantity')::numeric,'cost_known',(article->>'initial_unit_cost') is not null),
        (article->>'initial_unit_cost')::numeric,(valuation->>'tracked_value_delta')::numeric,(valuation->>'quantity_balance_after')::numeric,(valuation->>'average_unit_cost_after')::numeric,(valuation->>'inventory_value_after')::numeric);
      created_counts:=created_counts+1;
    end if;
  end loop;

  for presentation in select value from jsonb_array_elements(payload->'presentations') loop
    select id into v_item_id from public.inventory_items where import_code=presentation->>'item_code';
    if not exists(select 1 from public.inventory_purchase_presentations p where p.item_id=v_item_id and lower(trim(p.name))=lower(trim(presentation->>'name'))) then
      insert into public.inventory_purchase_presentations(item_id,name,content_per_package,content_unit,suggested_package_cost,import_notes,created_by,updated_by)
      values(v_item_id,trim(presentation->>'name'),(presentation->>'content_per_package')::numeric,presentation->>'content_unit',(presentation->>'suggested_package_cost')::numeric,coalesce(presentation->>'notes',''),actor,actor);
      created_presentations:=created_presentations+1;
    end if;
  end loop;

  for recipe in select value from jsonb_array_elements(payload->'menu_consumption') loop
    insert into public.inventory_menu_tracking(menu_item_source_key,control_mode,updated_by) values(recipe->>'menu_item_source_key','partial',actor) on conflict do nothing;
    select id into v_item_id from public.inventory_items where import_code=recipe->>'item_code';
    if not exists(select 1 from public.inventory_menu_recipe_components c where c.menu_item_source_key=recipe->>'menu_item_source_key' and c.item_id=v_item_id and c.active) then
      insert into public.inventory_menu_recipe_components(menu_item_source_key,item_id,quantity_base,active,created_by,updated_by)
      values(recipe->>'menu_item_source_key',v_item_id,(recipe->>'quantity_base')::numeric,true,actor,actor);
      created_associations:=created_associations+1;
    end if;
  end loop;

  result:=jsonb_build_object('created_articles',created_articles,'created_presentations',created_presentations,'created_menu_associations',created_associations,'created_initial_counts',created_counts,'preview',preview);
  insert into public.inventory_import_batches(request_id,fingerprint,actor,payload,result) values(request_id,fingerprint,actor,payload,result);
  return result;
end;
$$;

revoke all on table public.inventory_import_batches from public,anon,authenticated;
revoke all on function public.inventory_import_preview(jsonb),public.inventory_import_commit(uuid,text,jsonb) from public,anon;
grant execute on function public.inventory_import_preview(jsonb),public.inventory_import_commit(uuid,text,jsonb) to authenticated;

commit;
