-- Incremental upgrade AFTER 202610120023_inventory_receipt_multi_request_allocations.sql. Manual review/application in QA.
-- Administrative read model for a request's own receipt allocations. A single
-- physical receipt line may be represented once per request line, but only with
-- that request's applied quantity (never the physical line total).
begin;

create function public.inventory_submission_receipt_history(requested_submission_line_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if not public.inventory_is_active_staff() or not public.inventory_can_manage() then raise exception 'Acceso denegado a historial de recepciones'; end if;
  if coalesce(cardinality(requested_submission_line_ids),0)=0 then return '{}'::jsonb; end if;
  select coalesce(jsonb_object_agg(line_id::text,entries),'{}'::jsonb) into result from (
    select a.submission_line_id as line_id,
      jsonb_agg(jsonb_build_object(
        'receipt_id',r.id,'receipt_line_id',rl.id,'received_at',r.received_at,
        'document_reference',r.document_reference,'purchase_id',p.id,
        'presentation_name_snapshot',rl.presentation_name_snapshot,
        'content_per_package_snapshot',rl.content_per_package_snapshot,
        'content_unit_snapshot',rl.content_unit_snapshot,'package_quantity',rl.package_quantity,
        'applied_quantity',a.applied_quantity
      ) order by r.received_at,r.id,rl.id) as entries
    from public.inventory_receipt_line_submission_applications a
    join public.inventory_receipt_lines rl on rl.id=a.receipt_line_id
    join public.inventory_receipts r on r.id=rl.receipt_id
    left join public.inventory_purchases p on p.receipt_id=r.id
    where a.submission_line_id=any(requested_submission_line_ids)
    group by a.submission_line_id
  ) grouped;
  return result;
end;
$$;

revoke all on function public.inventory_submission_receipt_history(uuid[]) from public,anon;
grant execute on function public.inventory_submission_receipt_history(uuid[]) to authenticated;

commit;
