export type InventoryUnit = 'unit' | 'gram' | 'milliliter';
export type InventoryArea = 'bar' | 'kitchen';
export type InventorySubmissionKind = 'replenishment' | 'count' | 'damage';
export type InventoryStockAreaFilter = 'all' | InventoryArea;
export type InventoryStockStatusFilter = 'all' | 'uncounted' | 'low' | 'depleted' | 'in_stock';
export type InventoryStockOrder = 'name_asc' | 'name_desc';

export interface InventoryItem {
  id: string;
  import_code?: string | null;
  name: string;
  active: boolean;
  base_unit: InventoryUnit;
  precision_scale: number;
  minimum_quantity: number | null;
  target_quantity: number | null;
  tracking_started_at: string | null;
  balance: number | null;
  pending_incoming: number;
  last_unit_cost: number | null;
  average_unit_cost: number | null;
  inventory_value: number | null;
  areas: InventoryArea[];
}

export interface InventoryPresentation {
  id: string;
  item_id: string;
  name: string;
  content_per_package: number;
  content_unit: InventoryUnit;
  active: boolean;
  suggested_package_cost: number | null;
}

export interface InventorySubmissionLine {
  id: string;
  item_id: string;
  item_name: string;
  requested_quantity: number | null;
  observed_quantity: number | null;
  approved_quantity: number | null;
  received_quantity: number;
  reference_balance: number | null;
  reference_at: string | null;
  notes: string;
}

export interface InventoryReplenishmentPresentationSnapshot {
  presentation_id: string;
  presentation_name: string;
  content_per_package: number;
  content_unit: InventoryUnit;
  package_quantity: number;
}

export interface InventorySubmission {
  id: string;
  kind: InventorySubmissionKind;
  area: InventoryArea;
  status: string;
  sales_session_id: string | null;
  notes: string;
  created_at: string;
  created_by: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_notes: string | null;
  lines: InventorySubmissionLine[];
}

export interface InventoryMovement {
  id: string;
  item_id: string;
  item_name: string;
  movement_type: string;
  quantity_delta: number;
  base_unit_snapshot: InventoryUnit;
  reason: string;
  actor: string;
  occurred_at: string;
  sales_session_id: string | null;
  order_id: string | null;
  order_item_id: string | null;
  unit_cost_snapshot: number | null;
  tracked_value_delta: number | null;
  quantity_balance_after: number | null;
  average_unit_cost_after: number | null;
  inventory_value_after: number | null;
  metadata: Record<string, unknown>;
}

export interface InventoryRecipe {
  id: string;
  menu_item_source_key: string;
  menu_name: string;
  item_id: string;
  quantity_base: number;
  active: boolean;
  control_mode: 'partial' | 'complete';
  tracked_component_cost: number | null;
}

export interface InventoryReceipt {
  id: string;
  supplier: string | null;
  document_reference: string | null;
  expense_movement_id: string | null;
  total_cost: number | null;
  received_at: string;
  received_by: string;
  notes: string;
  lines: InventoryReceiptLine[];
}

export interface InventoryReceiptLine {
  id: string;
  item_id: string;
  presentation_name_snapshot: string | null;
  content_per_package_snapshot: number | null;
  content_unit_snapshot: InventoryUnit | null;
  package_quantity: number | null;
  base_quantity: number;
  submission_line_id: string | null;
  applied_submission_quantity: number | null;
  actual_package_cost: number | null;
  line_total_cost: number | null;
  base_unit_cost: number | null;
}

export interface InventoryData {
  can_manage: boolean;
  can_configure: boolean;
  items: InventoryItem[];
  presentations: InventoryPresentation[];
  recipes: InventoryRecipe[];
  menu_items: Array<{ source_key: string; name: string }>;
  submissions: InventorySubmission[];
  receipts: InventoryReceipt[];
  movements: InventoryMovement[];
}

export interface InventoryMenuAlert {
  menu_item_source_key: string;
  control_mode: 'partial' | 'complete';
  has_uncounted: boolean;
  cannot_make_one: boolean;
  controlled_units_available: number | null;
}

export const inventoryUnitLabels: Record<InventoryUnit, string> = {
  unit: 'unidad(es)',
  gram: 'g',
  milliliter: 'ml',
};

export const movementLabels: Record<string, string> = {
  initial_count: 'Conteo inicial', purchase_receipt: 'Recepción de compra', pos_consumption: 'Consumo POS',
  recoverable_return: 'Devolución recuperable', waste: 'Merma', internal_consumption: 'Consumo interno/cortesía',
  count_adjustment: 'Ajuste por conteo', correction: 'Corrección compensatoria',
};

export const submissionKindLabels: Record<InventorySubmissionKind, string> = {
  replenishment: 'Solicitud de reposición', count: 'Conteo físico', damage: 'Daño o pérdida',
};

export function getInventoryMessageDuration(hasError: boolean) {
  return hasError ? 8000 : 5000;
}

const submissionPresentationSnapshotPrefix = 'zafiro-presentation-v1:';

export function encodeInventorySubmissionLineNotes(notes: string, presentation?: InventoryReplenishmentPresentationSnapshot | null) {
  if (!presentation) return notes.trim();
  return `${submissionPresentationSnapshotPrefix}${JSON.stringify({ presentation, notes: notes.trim() })}`;
}

export function parseInventorySubmissionLineNotes(value: string | null | undefined): { notes: string; presentation: InventoryReplenishmentPresentationSnapshot | null } {
  const raw = value ?? '';
  if (!raw.startsWith(submissionPresentationSnapshotPrefix)) return { notes: raw, presentation: null };
  try {
    const parsed = JSON.parse(raw.slice(submissionPresentationSnapshotPrefix.length)) as { notes?: unknown; presentation?: Partial<InventoryReplenishmentPresentationSnapshot> };
    const presentation = parsed.presentation;
    if (!presentation || typeof presentation.presentation_id !== 'string' || typeof presentation.presentation_name !== 'string'
      || !['unit', 'gram', 'milliliter'].includes(String(presentation.content_unit))
      || !Number.isFinite(Number(presentation.content_per_package)) || Number(presentation.content_per_package) <= 0
      || !Number.isFinite(Number(presentation.package_quantity)) || Number(presentation.package_quantity) <= 0) {
      return { notes: raw, presentation: null };
    }
    return {
      notes: typeof parsed.notes === 'string' ? parsed.notes : '',
      presentation: {
        presentation_id: presentation.presentation_id,
        presentation_name: presentation.presentation_name,
        content_per_package: Number(presentation.content_per_package),
        content_unit: presentation.content_unit as InventoryUnit,
        package_quantity: Number(presentation.package_quantity),
      },
    };
  } catch {
    return { notes: raw, presentation: null };
  }
}

export function formatInventoryQuantity(value: number | null, unit: InventoryUnit, precision = 3) {
  if (value == null) return 'Sin conteo inicial';
  return `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: precision }).format(Number(value))} ${inventoryUnitLabels[unit]}`;
}

export function formatConfiguredInventoryQuantity(value: number | null, unit: InventoryUnit, precision = 3) {
  return value == null ? 'No configurado' : formatInventoryQuantity(value, unit, precision);
}

export function inventoryItemMatchesSearch(item: InventoryItem, search: string) {
  const needle = search.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-CO');
  if (!needle) return true;
  return [item.name, item.import_code ?? ''].some((value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-CO').includes(needle));
}

export function getInventoryItemSearchSelection(items: InventoryItem[], currentItemId: string, search: string) {
  const options = items.filter((item) => inventoryItemMatchesSearch(item, search));
  return {
    options,
    selectedItemId: options.some((item) => item.id === currentItemId) ? currentItemId : options[0]?.id ?? '',
  };
}

export function filterInventoryItemsByArea(items: InventoryItem[], area: InventoryArea) {
  return items.filter((item) => item.areas.includes(area));
}

export function filterInventoryStockItems(items: InventoryItem[], search: string, area: InventoryStockAreaFilter, status: InventoryStockStatusFilter, order: InventoryStockOrder) {
  const filtered = items.filter((item) => {
    if (!inventoryItemMatchesSearch(item, search) || (area !== 'all' && !item.areas.includes(area))) return false;
    if (status === 'uncounted') return item.balance == null;
    if (status === 'low') return item.balance != null && item.minimum_quantity != null && item.balance < item.minimum_quantity;
    if (status === 'depleted') return item.balance != null && item.balance <= 0;
    if (status === 'in_stock') return item.balance != null && item.balance > 0;
    return true;
  });
  return filtered.sort((a, b) => (order === 'name_desc' ? -1 : 1) * a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
}

export function inventoryMoneyInput(raw: string): { display: string; value: number | null } {
  const cleaned = raw.replace(/[^\d,]/g, '');
  const [wholeRaw, decimalRaw = ''] = cleaned.split(',', 2);
  const whole = wholeRaw.replace(/^0+(?=\d)/, '') || (cleaned ? '0' : '');
  if (!whole) return { display: '', value: null };
  const decimals = decimalRaw.slice(0, 2);
  const value = Number(`${whole}.${decimals || '0'}`);
  const formattedWhole = new Intl.NumberFormat('es-CO').format(Number(whole));
  return { display: cleaned.includes(',') ? `${formattedWhole},${decimals}` : formattedWhole, value };
}

export function formatInventoryMoneyInput(value: number | null | undefined) {
  return value == null ? '' : new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 }).format(Number(value));
}

export function receiptCostPreview(quantity: number, contentPerPackage: number, cost: number, mode: 'package' | 'line_total' | 'base_unit') {
  const baseQuantity = quantity * contentPerPackage;
  const lineTotal = mode === 'package' ? quantity * cost : mode === 'line_total' ? cost : baseQuantity * cost;
  return { baseQuantity, lineTotal, baseUnitCost: baseQuantity > 0 ? lineTotal / baseQuantity : 0 };
}

export function receiptRequestApplicationPreview(approvedQuantity: number, receivedQuantity: number, receiptBaseQuantity: number) {
  const pending = Math.max(approvedQuantity - receivedQuantity, 0);
  const received = Math.max(receiptBaseQuantity, 0);
  const applied = Math.min(pending, received);
  return {
    pending,
    received,
    applied,
    excess: Math.max(received - applied, 0),
    pendingAfter: Math.max(pending - applied, 0),
  };
}

export function csvCell(value: unknown) {
  let text = value == null ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function inventoryMovementCsv(rows: InventoryMovement[]) {
  const values: unknown[][] = [['Fecha Bogotá','Artículo','Tipo','Cantidad base','Unidad','Costo unitario snapshot','Valor rastreado del movimiento','Saldo posterior','Costo promedio contable posterior','Valor contable posterior','Motivo','Responsable','Jornada','Pedido','Línea POS']];
  rows.forEach((row) => values.push([
    new Date(row.occurred_at).toLocaleString('es-CO', { timeZone: 'America/Bogota' }), row.item_name,
    movementLabels[row.movement_type] ?? row.movement_type, row.quantity_delta, inventoryUnitLabels[row.base_unit_snapshot],
    row.unit_cost_snapshot, row.tracked_value_delta, row.quantity_balance_after, row.average_unit_cost_after, row.inventory_value_after,
    row.reason, row.actor, row.sales_session_id, row.order_id, row.order_item_id,
  ]));
  return '\uFEFF' + values.map((row) => row.map(csvCell).join(';')).join('\r\n');
}
