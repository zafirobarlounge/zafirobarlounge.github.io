import { getSupabaseClient } from '../../integrations/supabase/client';
import type { InventoryData, InventoryMenuAlert } from './inventory.domain';
import type { InventoryImportPayload } from './inventory-import';

export async function loadInventory(): Promise<InventoryData> {
  const { data, error } = await getSupabaseClient().rpc('inventory_read' as never);
  if (error) throw new Error(`No se pudo cargar inventario: ${error.message}. Verifica que las migraciones 005 y 006 estén aplicadas en QA.`);
  return data as unknown as InventoryData;
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
