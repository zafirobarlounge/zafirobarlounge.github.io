import { getSupabaseClient } from '../../integrations/supabase/client';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import type { InventoryArea, InventoryCursor, InventoryCursorPage, InventoryData, InventoryMenuAlert, InventoryMovement, InventoryReceipt, InventorySubmission, InventorySubmissionKind, InventoryUsageType, PosInventoryArea } from './inventory.domain';
import type { InventoryImportPayload } from './inventory-import';

export type InventoryRealtimeEventKind = 'movement' | 'submission' | 'receipt' | 'configuration';
let inventoryRealtimeChannelSequence = 0;

export function subscribeToInventoryRealtime(
  onChange: (eventKinds: InventoryRealtimeEventKind[]) => void,
  debounceMs = 80,
) {
  const supabase = getSupabaseClient();
  const channel: RealtimeChannel = supabase.channel(`zafiro-inventory-live-${++inventoryRealtimeChannelSequence}`);
  const pendingKinds = new Set<InventoryRealtimeEventKind>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active = true;

  const flush = () => {
    timer = null;
    if (!active || pendingKinds.size === 0) return;
    const kinds = Array.from(pendingKinds);
    pendingKinds.clear();
    onChange(kinds);
  };

  channel
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'inventory_realtime_events' },
      (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
        if (!active) return;
        const kind = (payload.new as Record<string, unknown>)?.event_kind;
        if (kind === 'movement' || kind === 'submission' || kind === 'receipt' || kind === 'configuration') {
          pendingKinds.add(kind);
        }
        if (timer != null) clearTimeout(timer);
        timer = setTimeout(flush, debounceMs);
      })
    .subscribe();

  return () => {
    if (!active) return;
    active = false;
    if (timer != null) clearTimeout(timer);
    pendingKinds.clear();
    void supabase.removeChannel(channel);
  };
}

export async function loadInventory(usageType: InventoryUsageType | null = null, area: InventoryArea | null = null): Promise<InventoryData> {
  const { data, error } = await getSupabaseClient().rpc('inventory_read' as never, { requested_usage_type: usageType, requested_area: area } as never);
  if (error) throw new Error(`No se pudo cargar inventario: ${error.message}. Verifica que la migración 015 esté aplicada en QA.`);
  return data as unknown as InventoryData;
}

export async function loadInventoryRecentSubmissions(area: PosInventoryArea): Promise<InventorySubmission[]> {
  const { data, error } = await getSupabaseClient().rpc('inventory_recent_submissions' as never, { requested_area: area } as never);
  if (error) throw new Error(`No se pudieron cargar los reportes recientes: ${error.message}`);
  return data as unknown as InventorySubmission[];
}

export async function loadInventoryPendingReplenishments(): Promise<InventorySubmission[]> {
  const { data, error } = await getSupabaseClient().rpc('inventory_pending_replenishments' as never);
  if (error) throw new Error(`No se pudieron cargar las solicitudes aprobadas: ${error.message}`);
  return data as unknown as InventorySubmission[];
}

export async function loadInventoryReceiptsPage(cursor: InventoryCursor | null): Promise<InventoryCursorPage<InventoryReceipt>> {
  const { data, error } = await getSupabaseClient().rpc('inventory_receipts_page' as never, { before_received_at: cursor?.timestamp ?? null, before_id: cursor?.id ?? null } as never);
  if (error) throw new Error(`No se pudieron cargar las entradas: ${error.message}`);
  return data as unknown as InventoryCursorPage<InventoryReceipt>;
}

export async function loadInventorySubmissionsPage(kind: InventorySubmissionKind | null, status: string | null, area: InventoryArea | null, cursor: InventoryCursor | null): Promise<InventoryCursorPage<InventorySubmission>> {
  const { data, error } = await getSupabaseClient().rpc('inventory_submissions_page' as never, { requested_kind: kind, requested_status: status, before_created_at: cursor?.timestamp ?? null, before_id: cursor?.id ?? null, requested_area: area } as never);
  if (error) throw new Error(`No se pudieron cargar las solicitudes: ${error.message}`);
  return data as unknown as InventoryCursorPage<InventorySubmission>;
}

export async function loadInventoryMovementsPage(month: string, cursor: InventoryCursor | null): Promise<InventoryCursorPage<InventoryMovement>> {
  const { data, error } = await getSupabaseClient().rpc('inventory_movements_page' as never, { requested_month: `${month}-01`, before_occurred_at: cursor?.timestamp ?? null, before_id: cursor?.id ?? null } as never);
  if (error) throw new Error(`No se pudo cargar el historial: ${error.message}`);
  return data as unknown as InventoryCursorPage<InventoryMovement>;
}

export async function loadInventoryMovementExport(month: string): Promise<InventoryMovement[]> {
  const { data, error } = await getSupabaseClient().rpc('inventory_movements_export' as never, { requested_month: `${month}-01` } as never);
  if (error) throw new Error(`No se pudo exportar el historial: ${error.message}`);
  return data as unknown as InventoryMovement[];
}

export async function loadInventoryMenuAlerts(): Promise<InventoryMenuAlert[]> {
  const { data, error } = await getSupabaseClient().rpc('inventory_menu_alerts' as never);
  if (error) throw new Error(error.message);
  return data as unknown as InventoryMenuAlert[];
}

export async function saveInventoryCommand(requestId: string, payload: Record<string, unknown>) {
  const { data, error } = await getSupabaseClient().rpc('inventory_command' as never, { request_id: requestId, payload } as never);
  if (error) throw Object.assign(new Error(error.message), { confirmedRejection: Boolean(error.code) });
  return data;
}

export async function saveInventoryPurchase(requestId: string, payload: Record<string, unknown>) {
  const { data, error } = await getSupabaseClient().rpc('inventory_purchase_command' as never, { request_id: requestId, payload } as never);
  if (error) throw Object.assign(new Error(error.message), { confirmedRejection: Boolean(error.code) });
  return data as unknown as { purchase_id: string; receipt_id: string; expense_movement_id: string | null; payment_status: 'paid' | 'pending' };
}

export async function deleteInventoryConfiguration(requestId: string, payload: Record<string, unknown>) {
  const { data, error } = await getSupabaseClient().rpc('inventory_delete_configuration' as never, { request_id: requestId, payload } as never);
  if (error) throw new Error(error.message);
  return data;
}

export interface InventoryImportServerPreview {
  new_articles: string[];
  existing_articles: string[];
  new_presentations: string[];
  existing_presentations: string[];
  new_menu_products: string[];
  existing_menu_products: string[];
  menu_association_count: number;
  initial_count_count: number;
  warnings: string[];
  errors: string[];
}

export async function previewInventoryImport(payload: InventoryImportPayload) {
  const { data, error } = await getSupabaseClient().rpc('inventory_import_preview' as never, { payload } as never);
  if (error) throw new Error(`No se pudo validar la importación: ${error.message}. Verifica que la migración 007 esté aplicada en QA.`);
  return data as unknown as InventoryImportServerPreview;
}

export async function commitInventoryImport(requestId: string, fingerprint: string, payload: InventoryImportPayload) {
  const { data, error } = await getSupabaseClient().rpc('inventory_import_commit' as never, { request_id: requestId, fingerprint, payload } as never);
  if (error) throw new Error(`No se pudo importar el inventario: ${error.message}`);
  return data as unknown as { created_articles: number; created_presentations: number; created_menu_associations: number; created_initial_counts: number };
}

export interface PosConsumptionResolutionLine {
  consumption_line_id: string;
  item_id: string;
  item_name: string;
  base_unit: 'unit' | 'gram' | 'milliliter';
  quantity: number;
  already_resolved: number;
}

export async function loadPosConsumptionResolution(itemId: string, voidQuantity = 1) {
  const { data, error } = await getSupabaseClient().rpc('inventory_get_pos_consumption' as never, { item_id: itemId, void_quantity: voidQuantity } as never);
  if (error) throw new Error(error.message);
  return data as unknown as { item_id: string; product_name?: string; void_quantity?: number; lines: PosConsumptionResolutionLine[] };
}

export async function voidProcessedItemWithInventory(requestId: string, payload: Record<string, unknown>) {
  const { data, error } = await getSupabaseClient().rpc('inventory_void_processed_item' as never, { request_id: requestId, payload } as never);
  if (error) throw Object.assign(new Error(error.message), { confirmedRejection: Boolean(error.code) });
  return data;
}

export function downloadInventoryCsv(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
