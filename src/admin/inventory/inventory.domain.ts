export type InventoryUnit = 'unit' | 'gram' | 'milliliter';
export type InventoryArea = 'bar' | 'kitchen';
export type InventorySubmissionKind = 'replenishment' | 'count' | 'damage';

export interface InventoryItem {
  id: string;
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
  areas: InventoryArea[];
}

export interface InventoryPresentation {
  id: string;
  item_id: string;
  name: string;
  content_per_package: number;
  content_unit: InventoryUnit;
  active: boolean;
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
  lines: Array<Record<string, unknown>>;
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

export function formatInventoryQuantity(value: number | null, unit: InventoryUnit, precision = 3) {
  if (value == null) return 'Sin conteo inicial';
  return `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: precision }).format(Number(value))} ${inventoryUnitLabels[unit]}`;
}

export function csvCell(value: unknown) {
  let text = value == null ? '' : String(value);
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function inventoryMovementCsv(rows: InventoryMovement[]) {
  const values: unknown[][] = [['Fecha Bogotá','Artículo','Tipo','Cantidad base','Unidad','Motivo','Responsable','Jornada','Pedido','Línea POS']];
  rows.forEach((row) => values.push([
    new Date(row.occurred_at).toLocaleString('es-CO', { timeZone: 'America/Bogota' }), row.item_name,
    movementLabels[row.movement_type] ?? row.movement_type, row.quantity_delta, inventoryUnitLabels[row.base_unit_snapshot],
    row.reason, row.actor, row.sales_session_id, row.order_id, row.order_item_id,
  ]));
  return '\uFEFF' + values.map((row) => row.map(csvCell).join(';')).join('\r\n');
}
