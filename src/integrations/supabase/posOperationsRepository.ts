import type { RealtimeChannel, RealtimePostgresChangesPayload, REALTIME_SUBSCRIBE_STATES } from '@supabase/supabase-js';
import type {
  AddCustomOrderItemInput,
  AddOrderItemInput,
  CreatePosTableInput,
  OrderFinancialStatus,
  OrderOperationalStatus,
  PaymentAllocationMode,
  PaymentMethod,
  PaymentStatus,
  PosOrder,
  PosOrderComputedSummary,
  PosOrderItem,
  PosOrderStatusLog,
  PosOrderWithRelations,
  PosPayment,
  PosProductOption,
  PosOperationalFlowSettings,
  PosSalesSessionHistoryEntry,
  PosSalesSession,
  PosSalesSessionSummary,
  PosState,
  PosTable,
  PosTableWithOrder,
  PreparationArea,
  RecordPaymentInput,
  StaffProfile,
  StaffRole,
  UpdateOrderItemInput,
} from '../../shared/operations/operations.types';
import { getSupabaseClient } from './client';
import type { Database } from './database.types';

export const POS_SYNC_DEBUG = false;

function logPosSync(message: string) {
  if (POS_SYNC_DEBUG) {
    console.debug(`[POS SYNC] ${message} ts=${Date.now()}`);
  }
}

type MenuItemPublicRow = Database['public']['Views']['menu_items_public']['Row'];
type PosTableRow = Database['public']['Tables']['pos_tables']['Row'];
type PosOrderRow = Database['public']['Tables']['pos_orders']['Row'];
type PosOrderItemRow = Database['public']['Tables']['pos_order_items']['Row'];
type PosPaymentRow = Database['public']['Tables']['pos_payments']['Row'];
type PosSalesSessionRow = Database['public']['Tables']['pos_sales_sessions']['Row'];
type PosLogRow = Database['public']['Tables']['pos_order_status_logs']['Row'];
type StaffProfileRow = Database['public']['Tables']['staff_profiles']['Row'];
type PosOperationalFlowSettingsRow = {
  area: string;
  use_direct_delivery: boolean | null;
  use_in_process: boolean | null;
  use_picking_up: boolean | null;
};

export const defaultPosOperationalFlowSettings: PosOperationalFlowSettings = {
  bar: {
    useDirectDelivery: false,
    useInProcess: false,
    usePickingUp: false,
  },
  kitchen: {
    useDirectDelivery: false,
    useInProcess: false,
    usePickingUp: false,
  },
};

export interface PosActorContext {
  email: string;
  roles: StaffRole[];
}

export interface ReplaceOrderItemInput extends AddOrderItemInput {
  reason: string;
}

export interface UpdatePaymentStatusInput {
  notes?: string;
  rejectionReason?: string;
  status: Extract<PaymentStatus, 'confirmed' | 'rejected'>;
}

export interface MovePosActiveOrderResult {
  destinationTable: PosTable;
  order: PosOrder;
  sourceTable: PosTable;
}

export interface DeletePosTableResult {
  removed: boolean;
  table: PosTable;
}

export interface ManualSalesSessionWindowInput {
  businessDate: string;
  closedAt: string;
  notes?: string;
  openedAt: string;
  sessionLabel?: string;
}

export interface UpdatePosOperationalFlowSettingsInput {
  area: PreparationArea;
  useDirectDelivery: boolean;
  useInProcess: boolean;
  usePickingUp: boolean;
}

export interface LoadPosStateOptions {
  includeHistoricalRows?: boolean;
  includeLogs?: boolean;
}

const TERMINAL_ITEM_STATUSES = new Set<OrderOperationalStatus>(['delivered', 'cancelled']);
const DRAFT_EDITABLE_STATUSES = new Set<OrderOperationalStatus>(['draft']);
const CONTROLLED_CANCEL_STATUSES = new Set<OrderOperationalStatus>(['draft', 'sent', 'pending_preparation']);
const KITCHEN_PRODUCT_TYPES = new Set(['comida']);
const BAR_PRODUCT_TYPES = new Set(['cocteles', 'micheladas', 'jugos-y-limonadas', 'bebidas']);
const SALES_SESSION_CUTOFF_HOUR = 18;

type PosRealtimeTable =
  | 'pos_tables'
  | 'pos_orders'
  | 'pos_order_items'
  | 'pos_payments'
  | 'pos_sales_sessions'
  | 'pos_order_status_logs'
  | 'pos_operational_flow_settings';

export interface PosRealtimeEvent {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  newRecord: Record<string, unknown> | null;
  oldRecord: Record<string, unknown> | null;
  table: PosRealtimeTable;
}

export async function loadPosStateFromSupabase(options: LoadPosStateOptions = {}): Promise<PosState> {
  const supabase = getSupabaseClient();
  const shouldIncludeLogs = options.includeLogs ?? true;
  const [tables, logs, salesSessions, operationalFlowSettings] = await Promise.all([
    supabase.from('pos_tables').select('*').order('code', { ascending: true }),
    shouldIncludeLogs
      ? supabase.from('pos_order_status_logs').select('*').order('created_at', { ascending: false }).limit(options.includeHistoricalRows ? 120 : 15)
      : Promise.resolve({ data: [] as PosLogRow[], error: null }),
    supabase.from('pos_sales_sessions').select('*').order('opened_at', { ascending: false }).limit(10),
    loadPosOperationalFlowSettingsRows(),
  ]);

  throwIfError(tables.error, 'No fue posible leer las mesas POS');
  throwIfError(logs.error, 'No fue posible leer la trazabilidad POS');
  throwIfError(salesSessions.error, 'No fue posible leer las jornadas POS');
  const mappedOperationalFlowSettings = mapPosOperationalFlowSettingsRows(operationalFlowSettings);
  const activeSalesSessionRow = (salesSessions.data ?? []).find((session) => session.status === 'open') ?? null;
  const orders = options.includeHistoricalRows ? await loadAllPosOrdersRows() : await loadOperationalPosOrdersRows(activeSalesSessionRow?.id ?? null);
  const orderIds = orders.map((order) => order.id);
  const [items, payments] = options.includeHistoricalRows
    ? await Promise.all([loadAllPosOrderItemRows(), loadAllPosPaymentRows()])
    : await Promise.all([loadPosOrderItemRowsByOrderIds(orderIds), loadOperationalPosPaymentRows(orderIds, activeSalesSessionRow?.id ?? null)]);

  const ordersWithRelations = buildOrdersWithRelations(orders, items, payments);
  const tablesWithOrders = buildTablesWithOrders(tables.data ?? [], ordersWithRelations);
  const tablesById = new Map((tables.data ?? []).map((table) => [table.id, table]));
  const pendingPreparationItems = ordersWithRelations
    .flatMap((order) =>
      order.items.map((item) => {
        const table = order.tableId ? tablesById.get(order.tableId) : null;
        return {
          ...item,
          orderAssignedStaffEmail: order.assignedStaffEmail,
          orderOpenedByEmail: order.openedByEmail,
          tableCode: table?.code ?? order.tableCodeSnapshot ?? null,
          tableId: order.tableId,
          tableName: table?.name ?? order.tableNameSnapshot ?? null,
        };
      }),
    )
    .filter((item) => !TERMINAL_ITEM_STATUSES.has(item.operationalStatus) && item.operationalStatus !== 'draft')
    .sort((left, right) => resolvePreparationQueueTimestamp(left).localeCompare(resolvePreparationQueueTimestamp(right)));

  const mappedPayments = payments.map(mapPosPaymentRow);
  const mappedSalesSessions = (salesSessions.data ?? []).map((row) => {
    const mappedSession = mapPosSalesSessionRow(row);
    const sessionOrders = ordersWithRelations.filter((order) => order.salesSessionId === mappedSession.id);
    const sessionPayments = mappedPayments.filter((payment) => payment.salesSessionId === mappedSession.id);
    const liveSummary = buildSalesSessionSummary(sessionOrders, sessionPayments);

    return {
      ...mappedSession,
      summary: sessionOrders.length || sessionPayments.length ? liveSummary : mappedSession.summary,
    };
  });
  const activeSalesSession = mappedSalesSessions.find((session) => session.status === 'open') ?? null;

  return {
    generatedAt: new Date().toISOString(),
    roles: [],
    staffProfile: null,
    activeSalesSession,
    recentSalesSessions: mappedSalesSessions,
    tables: tablesWithOrders,
    openOrders: ordersWithRelations.filter((order) => order.closedAt == null),
    closedSales: ordersWithRelations
      .filter((order) => order.closedAt != null)
      .sort((left, right) => (right.closedAt ?? right.updatedAt).localeCompare(left.closedAt ?? left.updatedAt)),
    pendingPreparationKitchen: pendingPreparationItems.filter((item) => item.prepArea === 'kitchen'),
    pendingPreparationBar: pendingPreparationItems.filter((item) => item.prepArea === 'bar'),
    operationalFlowSettings: mappedOperationalFlowSettings,
    pendingPayments: mappedPayments.filter((payment) => payment.status === 'pending'),
    logs: (logs.data ?? []).map(mapPosLogRow),
  };
}

export async function openSalesSessionInSupabase(actor: PosActorContext, notes?: string) {
  const currentOpenSession = await getOpenSalesSession();
  if (currentOpenSession) {
    return currentOpenSession;
  }

  const openedAt = new Date().toISOString();
  const businessDate = deriveSalesBusinessDate(openedAt, SALES_SESSION_CUTOFF_HOUR);
  const sessionLabel = `Jornada ${businessDate}`;
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('pos_sales_sessions')
    .insert({
      business_date: businessDate,
      cutoff_hour: SALES_SESSION_CUTOFF_HOUR,
      notes: notes?.trim() ?? '',
      opened_at: openedAt,
      opened_by_email: actor.email,
      session_label: sessionLabel,
      status: 'open',
      summary: {} as never,
    } as never)
    .select('*')
    .single();

  throwIfError(error, 'No fue posible abrir una jornada de ventas');
  await insertPosLog({
    actor,
    afterData: data,
    eventType: 'sales_session_opened',
    notes: `Jornada abierta: ${sessionLabel}`,
  });
  return mapPosSalesSessionRow(data);
}

export async function loadPosProductOptionsFromSupabase() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('menu_items_public')
    .select('*')
    .eq('visible', true)
    .eq('disponible', true)
    .order('tipo', { ascending: true })
    .order('subgrupo', { ascending: true })
    .order('orden', { ascending: true })
    .order('name', { ascending: true });

  throwIfError(error, 'No fue posible cargar el catalogo operativo para POS');

  return (data ?? []).map(mapMenuItemPublicRow);
}

export async function updatePosOperationalFlowSettingsInSupabase(input: UpdatePosOperationalFlowSettingsInput, actor: PosActorContext) {
  if (!actor.email) {
    throw new Error('No hay una sesion operativa valida para cambiar la configuracion del POS.');
  }

  ensureCanManageSalesSessions(actor.roles);

  const supabase = getSupabaseClient();
  const row = {
    area: input.area,
    use_direct_delivery: input.useDirectDelivery,
    use_in_process: input.useInProcess,
    use_picking_up: input.usePickingUp,
    updated_at: new Date().toISOString(),
    updated_by_email: actor.email,
  };
  const { error } = await supabase.from('pos_operational_flow_settings' as never).upsert(row as never, { onConflict: 'area' } as never);
  throwIfError(error, 'No fue posible guardar la configuracion operativa.');

  await insertPosLog({
    actor,
    afterData: row,
    eventType: 'pos_operational_flow_settings_updated',
    notes: `Configuracion operativa actualizada para ${input.area === 'bar' ? 'bar' : 'cocina'}`,
  });

  return mapPosOperationalFlowSettingsRows(await loadPosOperationalFlowSettingsRows());
}

export async function loadPosOperationalFlowSettingsFromSupabase(): Promise<PosOperationalFlowSettings> {
  return mapPosOperationalFlowSettingsRows(await loadPosOperationalFlowSettingsRows());
}

async function loadPosOperationalFlowSettingsRows() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('pos_operational_flow_settings' as never)
    .select('*' as never);

  throwIfError(error, 'No fue posible leer la configuracion operativa POS');
  return (data ?? []) as unknown as PosOperationalFlowSettingsRow[];
}

async function loadAllPosOrdersRows() {
  const rows: PosOrderRow[] = [];
  const pageSize = 1000;
  const supabase = getSupabaseClient();

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('pos_orders')
      .select('*')
      .order('opened_at', { ascending: false })
      .range(from, from + pageSize - 1);

    throwIfError(error, 'No fue posible leer las ordenes POS');
    rows.push(...(data ?? []));

    if (!data || data.length < pageSize) {
      return rows;
    }
  }
}

async function loadOperationalPosOrdersRows(activeSalesSessionId: string | null) {
  const rows: PosOrderRow[] = [];
  const pageSize = 1000;
  const supabase = getSupabaseClient();

  for (let from = 0; ; from += pageSize) {
    let query = supabase
      .from('pos_orders')
      .select('*')
      .order('opened_at', { ascending: false })
      .range(from, from + pageSize - 1);

    query = activeSalesSessionId
      ? query.or(`closed_at.is.null,sales_session_id.eq.${activeSalesSessionId}`)
      : query.is('closed_at', null);

    const { data, error } = await query;

    throwIfError(error, 'No fue posible leer las ordenes POS');
    rows.push(...(data ?? []));

    if (!data || data.length < pageSize) {
      return rows;
    }
  }
}

async function loadAllPosOrderItemRows() {
  const rows: PosOrderItemRow[] = [];
  const pageSize = 1000;
  const supabase = getSupabaseClient();

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('pos_order_items')
      .select('*')
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);

    throwIfError(error, 'No fue posible leer las lineas POS');
    rows.push(...(data ?? []));

    if (!data || data.length < pageSize) {
      return rows;
    }
  }
}

async function loadPosOrderItemRowsByOrderIds(orderIds: string[]) {
  if (!orderIds.length) {
    return [] as PosOrderItemRow[];
  }

  const rows: PosOrderItemRow[] = [];
  const chunkSize = 200;
  const pageSize = 1000;
  const supabase = getSupabaseClient();

  for (let index = 0; index < orderIds.length; index += chunkSize) {
    const chunk = orderIds.slice(index, index + chunkSize);

    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('pos_order_items')
        .select('*')
        .in('order_id', chunk)
        .order('created_at', { ascending: true })
        .range(from, from + pageSize - 1);

      throwIfError(error, 'No fue posible leer las lineas POS');
      rows.push(...(data ?? []));

      if (!data || data.length < pageSize) {
        break;
      }
    }
  }

  return rows.sort((left, right) => left.created_at.localeCompare(right.created_at));
}

async function loadAllPosPaymentRows() {
  const rows: PosPaymentRow[] = [];
  const pageSize = 1000;
  const supabase = getSupabaseClient();

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('pos_payments')
      .select('*')
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);

    throwIfError(error, 'No fue posible leer los pagos POS');
    rows.push(...(data ?? []));

    if (!data || data.length < pageSize) {
      return rows;
    }
  }
}

async function loadOperationalPosPaymentRows(orderIds: string[], activeSalesSessionId: string | null) {
  const byId = new Map<string, PosPaymentRow>();
  const rowsByOrder = await loadPosPaymentRowsByOrderIds(orderIds);

  for (const row of rowsByOrder) {
    byId.set(row.id, row);
  }

  const supabase = getSupabaseClient();
  const pageSize = 1000;
  const filters = ['status.eq.pending'];

  if (activeSalesSessionId) {
    filters.push(`sales_session_id.eq.${activeSalesSessionId}`);
  }

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('pos_payments')
      .select('*')
      .or(filters.join(','))
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);

    throwIfError(error, 'No fue posible leer los pagos POS');

    for (const row of data ?? []) {
      byId.set(row.id, row);
    }

    if (!data || data.length < pageSize) {
      break;
    }
  }

  return Array.from(byId.values()).sort((left, right) => left.created_at.localeCompare(right.created_at));
}

async function loadPosPaymentRowsByOrderIds(orderIds: string[]) {
  if (!orderIds.length) {
    return [] as PosPaymentRow[];
  }

  const rows: PosPaymentRow[] = [];
  const chunkSize = 200;
  const pageSize = 1000;
  const supabase = getSupabaseClient();

  for (let index = 0; index < orderIds.length; index += chunkSize) {
    const chunk = orderIds.slice(index, index + chunkSize);

    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('pos_payments')
        .select('*')
        .in('order_id', chunk)
        .order('created_at', { ascending: true })
        .range(from, from + pageSize - 1);

      throwIfError(error, 'No fue posible leer los pagos POS');
      rows.push(...(data ?? []));

      if (!data || data.length < pageSize) {
        break;
      }
    }
  }

  return rows.sort((left, right) => left.created_at.localeCompare(right.created_at));
}

async function loadAllPosSalesSessionRows() {
  const rows: PosSalesSessionRow[] = [];
  const pageSize = 1000;
  const supabase = getSupabaseClient();

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('pos_sales_sessions')
      .select('*')
      .order('opened_at', { ascending: false })
      .range(from, from + pageSize - 1);

    throwIfError(error, 'No fue posible leer el historial de jornadas');
    rows.push(...(data ?? []));

    if (!data || data.length < pageSize) {
      return rows;
    }
  }
}

export async function createPosTableInSupabase(input: CreatePosTableInput, actor: PosActorContext) {
  const normalizedCode = input.code.trim().toUpperCase();
  const normalizedName = input.name.trim();

  if (!normalizedCode) {
    throw new Error('La mesa debe tener un codigo antes de crearse.');
  }

  if (!normalizedName) {
    throw new Error('La mesa debe tener un nombre antes de crearse.');
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('pos_tables')
    .insert({
      code: normalizedCode,
      name: normalizedName,
      type: input.type,
      zone: input.zone,
      capacity: input.capacity ?? null,
      notes: input.notes?.trim() ?? '',
      status: 'available',
      assigned_staff_email: actor.email,
    } as never)
    .select('*')
    .single();

  throwIfError(error, 'No fue posible crear la mesa');
  await insertPosLog({
    actor,
    afterData: data,
    eventType: 'table_created',
    notes: `Mesa ${normalizedCode} creada`,
    tableId: data.id,
  });
  return mapPosTableRow(data);
}

export async function deletePosTableInSupabase(tableId: string, actor: PosActorContext): Promise<DeletePosTableResult> {
  const supabase = getSupabaseClient();
  const table = await getTableById(tableId);

  if (table.activeOrderId) {
    throw new Error('No puedes eliminar una mesa con una cuenta activa.');
  }

  if (table.status === 'occupied') {
    throw new Error('No puedes eliminar una mesa que sigue marcada como ocupada.');
  }

  const { error } = await supabase.from('pos_tables').delete().eq('id', tableId);
  throwIfError(error, 'No fue posible eliminar la mesa');

  await insertPosLog({
    actor,
    afterData: {
      deleted: true,
      tableCode: table.code,
      tableName: table.name,
    },
    beforeData: table,
    eventType: 'table_deleted',
    notes: `Mesa ${table.code} eliminada`,
  });

  return {
    removed: true,
    table,
  };
}

export async function moveActiveOrderToTableInSupabase(sourceTableId: string, destinationTableId: string, actor: PosActorContext) {
  ensureCanMoveActiveOrder(actor.roles);

  if (sourceTableId === destinationTableId) {
    throw new Error('Selecciona una mesa destino diferente a la mesa origen.');
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.rpc('move_pos_active_order_to_table', {
    destination_table_id: destinationTableId,
    source_table_id: sourceTableId,
  });

  throwIfError(error, 'No fue posible trasladar la cuenta');

  const payload = data as {
    destinationTable?: PosTableRow;
    order?: PosOrderRow;
    sourceTable?: PosTableRow;
  } | null;

  if (!payload?.sourceTable || !payload.destinationTable || !payload.order) {
    throw new Error('El traslado se completo, pero la respuesta de Supabase vino incompleta. Actualiza el POS para sincronizar.');
  }

  return {
    destinationTable: mapPosTableRow(payload.destinationTable),
    order: mapPosOrderRow(payload.order),
    sourceTable: mapPosTableRow(payload.sourceTable),
  };
}

export async function addItemsToTableInSupabase(tableId: string, items: AddOrderItemInput[], actor: PosActorContext) {
  if (!items.length) {
    throw new Error('No hay productos para agregar a la mesa.');
  }

  const supabase = getSupabaseClient();
  const table = await getTableById(tableId);
  const order = await ensureOpenOrderForTable(table, actor);
  const currentItems = await loadOrderItems(order.id);
  const returnedItems: PosOrderItem[] = [];

  for (const item of items) {
    const draftFields = {
      menuItemSourceKey: item.menuItemSourceKey,
      notes: item.notes?.trim() ?? '',
      prepArea: derivePreparationAreaFromProductType(item.productType),
      productName: item.productName.trim(),
      productSlug: item.productSlug.trim(),
      unitPrice: normalizeMoney(item.unitPrice),
    };
    const existingDraft = currentItems.find((entry) => isMergeableDraftOrderItem(entry, draftFields));

    if (existingDraft) {
      const quantity = existingDraft.quantity + item.quantity;
      const { data, error } = await supabase
        .from('pos_order_items')
        .update({
          quantity,
          total_price: existingDraft.unitPrice * quantity,
          updated_by_email: actor.email,
        } as never)
        .eq('id', existingDraft.id)
        .eq('operational_status', 'draft')
        .select('*')
        .single();

      throwIfError(error, 'No fue posible agrupar el producto en borrador');
      const mergedItem = mapPosOrderItemRow(data);
      returnedItems.push(mergedItem);
      const itemIndex = currentItems.findIndex((entry) => entry.id === mergedItem.id);
      if (itemIndex >= 0) {
        currentItems[itemIndex] = mergedItem;
      }
      continue;
    }

    const nextRound = Math.max(0, ...currentItems.map((entry) => entry.serviceRound)) + 1;
    const { data, error } = await supabase
      .from('pos_order_items')
      .insert({
        order_id: order.id,
        menu_item_source_key: draftFields.menuItemSourceKey,
        product_name: draftFields.productName,
        product_slug: draftFields.productSlug,
        prep_area: draftFields.prepArea,
        quantity: item.quantity,
        unit_price: draftFields.unitPrice,
        total_price: draftFields.unitPrice * item.quantity,
        service_round: nextRound,
        operational_status: 'draft',
        financial_status: 'pending_payment',
        notes: draftFields.notes,
        created_by_email: actor.email,
        updated_by_email: actor.email,
      } as never)
      .select('*')
      .single();

    throwIfError(error, 'No fue posible agregar productos a la mesa');
    const createdItem = mapPosOrderItemRow(data);
    returnedItems.push(createdItem);
    currentItems.push(createdItem);
  }

  await touchTableOccupation(table.id, order.id, actor.email);
  await insertPosLog({
    actor,
    afterData: returnedItems,
    eventType: 'items_added',
    notes: `${items.length} linea(s) agregadas a ${table.code}`,
    orderId: order.id,
    tableId: table.id,
  });

  return returnedItems;
}

export async function addCustomItemToTableInSupabase(tableId: string, item: AddCustomOrderItemInput, actor: PosActorContext) {
  const productName = item.productName.trim();
  const quantity = Math.max(Math.floor(item.quantity), 0);
  const unitPrice = normalizeMoney(item.unitPrice);

  if (!productName) {
    throw new Error('El extra debe tener un nombre.');
  }

  if (quantity <= 0) {
    throw new Error('La cantidad del extra debe ser mayor que cero.');
  }

  if (unitPrice <= 0) {
    throw new Error('El precio unitario del extra debe ser mayor que cero.');
  }

  const supabase = getSupabaseClient();
  const table = await getTableById(tableId);
  const order = await ensureOpenOrderForTable(table, actor);
  const existingItems = await loadOrderItems(order.id);
  const productSlug = `extra-${slugifyForPos(productName)}`;
  const notes = item.notes?.trim() ?? '';
  const existingDraft = existingItems.find((entry) =>
    isMergeableDraftOrderItem(entry, {
      menuItemSourceKey: null,
      notes,
      prepArea: item.prepArea,
      productName,
      productSlug,
      unitPrice,
    }),
  );

  if (existingDraft) {
    const nextQuantity = existingDraft.quantity + quantity;
    const { data, error } = await supabase
      .from('pos_order_items')
      .update({
        quantity: nextQuantity,
        total_price: existingDraft.unitPrice * nextQuantity,
        updated_by_email: actor.email,
      } as never)
      .eq('id', existingDraft.id)
      .eq('operational_status', 'draft')
      .select('*')
      .single();

    throwIfError(error, 'No fue posible agrupar el extra en borrador');
    await touchTableOccupation(table.id, order.id, actor.email);
    await insertPosLog({
      actor,
      afterData: data,
      eventType: 'custom_item_added',
      notes: `${quantity} extra(s): ${productName}`,
      orderId: order.id,
      tableId: table.id,
    });

    return mapPosOrderItemRow(data);
  }

  const nextRound = Math.max(0, ...existingItems.map((entry) => entry.serviceRound)) + 1;
  const { data, error } = await supabase
    .from('pos_order_items')
    .insert({
      order_id: order.id,
      menu_item_source_key: null,
      product_name: productName,
      product_slug: productSlug,
      prep_area: item.prepArea,
      quantity,
      unit_price: unitPrice,
      total_price: unitPrice * quantity,
      service_round: nextRound,
      operational_status: 'draft',
      financial_status: 'pending_payment',
      notes,
      created_by_email: actor.email,
      updated_by_email: actor.email,
    } as never)
    .select('*')
    .single();

  throwIfError(error, 'No fue posible agregar el extra a la mesa');

  await touchTableOccupation(table.id, order.id, actor.email);
  await insertPosLog({
    actor,
    afterData: data,
    eventType: 'custom_item_added',
    notes: `${quantity} extra(s): ${productName}`,
    orderId: order.id,
    tableId: table.id,
  });

  return mapPosOrderItemRow(data);
}

export async function updateOrderItemInSupabase(itemId: string, patch: UpdateOrderItemInput, actor: PosActorContext, currentItemOverride?: PosOrderItem) {
  const currentItem = currentItemOverride ?? (await getOrderItemById(itemId));

  if (!DRAFT_EDITABLE_STATUSES.has(currentItem.operationalStatus)) {
    throw new Error('Solo puedes editar libremente lineas en borrador.');
  }

  const quantity = patch.quantity ?? currentItem.quantity;
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('La cantidad debe ser mayor que cero.');
  }

  const supabase = getSupabaseClient();
  const updates = {
    notes: patch.notes?.trim() ?? currentItem.notes ?? '',
    quantity,
    total_price: currentItem.unitPrice * quantity,
    updated_by_email: actor.email,
  };

  const { data, error } = await supabase
    .from('pos_order_items')
    .update(updates as never)
    .eq('id', itemId)
    .eq('operational_status', 'draft')
    .select('*')
    .single();

  throwIfError(error, 'No fue posible actualizar la linea del pedido');

  await insertPosLog({
    actor,
    afterData: data,
    beforeData: currentItem,
    eventType: 'item_updated',
    orderId: currentItem.orderId,
    orderItemId: currentItem.id,
  });

  return mapPosOrderItemRow(data);
}

export async function replaceOrderItemInSupabase(
  itemId: string,
  replacement: ReplaceOrderItemInput,
  actor: PosActorContext,
  currentItemOverride?: PosOrderItem,
) {
  const originalItem = currentItemOverride ?? (await getOrderItemById(itemId));

  if (!CONTROLLED_CANCEL_STATUSES.has(originalItem.operationalStatus)) {
    throw new Error('Este producto ya esta demasiado avanzado para reemplazarlo silenciosamente.');
  }

  const supabase = getSupabaseClient();
  const now = new Date().toISOString();
  const replacementOperationalStatus = originalItem.operationalStatus === 'draft' ? 'draft' : originalItem.operationalStatus;

  const { data: cancelledOriginal, error: cancelError } = await supabase
    .from('pos_order_items')
    .update({
      cancellation_reason: replacement.reason.trim(),
      cancelled_at: now,
      cancelled_by_email: actor.email,
      financial_status: 'cancelled',
      operational_status: 'cancelled',
      updated_by_email: actor.email,
    } as never)
    .eq('id', itemId)
    .in('operational_status', ['draft', 'sent', 'pending_preparation'])
    .select('*')
    .single();

  throwIfError(cancelError, 'No fue posible preparar la linea original para reemplazo');

  const { data, error } = await supabase
    .from('pos_order_items')
    .insert({
      order_id: originalItem.orderId,
      menu_item_source_key: replacement.menuItemSourceKey,
      product_name: replacement.productName.trim(),
      product_slug: replacement.productSlug.trim(),
      prep_area: derivePreparationAreaFromProductType(replacement.productType),
      quantity: replacement.quantity,
      unit_price: replacement.unitPrice,
      total_price: replacement.unitPrice * replacement.quantity,
      service_round: originalItem.serviceRound,
      operational_status: replacementOperationalStatus,
      financial_status: 'pending_payment',
      notes: replacement.notes?.trim() ?? '',
      replacement_for_item_id: originalItem.id,
      sent_at: replacementOperationalStatus === 'draft' ? null : originalItem.sentAt,
      created_by_email: actor.email,
      updated_by_email: actor.email,
    } as never)
    .select('*')
    .single();

  throwIfError(error, 'No fue posible crear la linea de reemplazo');
  await reconcileOrderState(originalItem.orderId, actor.email);

  await insertPosLog({
    actor,
    afterData: {
      original: cancelledOriginal,
      replacement: data,
    },
    beforeData: originalItem,
    eventType: 'item_replaced',
    notes: replacement.reason,
    orderId: originalItem.orderId,
    orderItemId: data.id,
  });

  return mapPosOrderItemRow(data);
}

export async function cancelOrderItemInSupabase(itemId: string, reason: string, actor: PosActorContext, currentItemOverride?: PosOrderItem) {
  const currentItem = currentItemOverride ?? (await getOrderItemById(itemId));

  if (!CONTROLLED_CANCEL_STATUSES.has(currentItem.operationalStatus)) {
    throw new Error('Esta linea ya no puede cancelarse desde este punto del flujo.');
  }

  const supabase = getSupabaseClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('pos_order_items')
    .update({
      cancellation_reason: reason.trim(),
      cancelled_at: now,
      cancelled_by_email: actor.email,
      financial_status: 'cancelled',
      operational_status: 'cancelled',
      updated_by_email: actor.email,
    } as never)
    .eq('id', itemId)
    .in('operational_status', ['draft', 'sent', 'pending_preparation'])
    .select('*')
    .single();

  throwIfError(error, 'No fue posible cancelar la linea');

  await reconcileOrderState(currentItem.orderId, actor.email);
  await insertPosLog({
    actor,
    afterData: data,
    beforeData: currentItem,
    eventType: 'item_cancelled',
    notes: reason.trim(),
    orderId: currentItem.orderId,
    orderItemId: currentItem.id,
  });

  return mapPosOrderItemRow(data);
}

export async function cancelClosedPaidOrderInSupabase(orderId: string, reason: string, actor: PosActorContext, currentOrderOverride?: PosOrderWithRelations) {
  ensureCanCancelClosedPaidOrder(actor.roles);

  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    throw new Error('Debes escribir un motivo claro para anular la venta cerrada.');
  }

  const currentOrder = currentOrderOverride ?? await loadOrderWithRelationsById(orderId);

  if (!currentOrder.closedAt) {
    throw new Error('Esta cuenta aun no esta cerrada. Usa el flujo normal de caja o productos.');
  }

  if (currentOrder.financialStatus === 'cancelled') {
    throw new Error('Esta venta ya esta anulada.');
  }

  const pendingPayments = currentOrder.payments.filter((payment) => payment.status === 'pending');
  if (pendingPayments.length) {
    throw new Error('Esta venta tiene pagos pendientes por validar. Resuelvelos antes de anularla.');
  }

  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  const { error: itemsError } = await supabase
    .from('pos_order_items')
    .update({
      cancellation_reason: normalizedReason,
      cancelled_at: now,
      cancelled_by_email: actor.email,
      financial_status: 'cancelled',
      operational_status: 'cancelled',
      updated_by_email: actor.email,
    } as never)
    .eq('order_id', orderId)
    .not('operational_status', 'eq', 'cancelled');

  throwIfError(itemsError, 'No fue posible anular los productos de la venta');

  const { error: paymentsError } = await supabase
    .from('pos_payments')
    .update({
      notes: normalizedReason,
      rejected_at: now,
      rejected_by_email: actor.email,
      rejection_reason: normalizedReason,
      status: 'rejected',
    } as never)
    .eq('order_id', orderId)
    .eq('status', 'confirmed');

  throwIfError(paymentsError, 'No fue posible reversar los pagos de la venta');

  const { data: orderRow, error: orderError } = await supabase
    .from('pos_orders')
    .update({
      cancellation_reason: normalizedReason,
      financial_status: 'cancelled',
      updated_at: now,
    } as never)
    .eq('id', orderId)
    .select('*')
    .single();

  throwIfError(orderError, 'No fue posible marcar la venta como anulada');

  await insertPosLog({
    actor,
    afterData: {
      cancellationReason: normalizedReason,
      orderId,
      status: 'cancelled',
    },
    beforeData: currentOrder,
    eventType: 'closed_sale_cancelled',
    notes: normalizedReason,
    orderId,
    tableId: currentOrder.tableId,
  });

  const [items, payments] = await Promise.all([loadOrderItems(orderId), loadOrderPayments(orderId)]);

  return {
    ...mapPosOrderRow(orderRow),
    items,
    payments,
    summary: buildOrderSummary(items, payments),
  };
}

export async function voidProcessedOrderItemInSupabase(
  itemId: string,
  reason: string,
  actor: PosActorContext,
  currentItemOverride?: PosOrderItem,
  voidQuantity = 1,
) {
  ensureCanVoidProcessedItem(actor.roles);

  const normalizedReason = reason.trim();
  if (!normalizedReason) {
    throw new Error('Debes escribir un motivo claro para la anulacion extraordinaria.');
  }

  const currentItem = currentItemOverride ?? (await getOrderItemById(itemId));
  if (currentItem.operationalStatus === 'cancelled') {
    throw new Error('Esta linea ya esta cancelada.');
  }

  if (CONTROLLED_CANCEL_STATUSES.has(currentItem.operationalStatus)) {
    throw new Error('Esta linea aun puede manejarse con la cancelacion operativa normal.');
  }

  const normalizedVoidQuantity = Math.max(Math.floor(voidQuantity), 1);
  if (normalizedVoidQuantity > currentItem.quantity) {
    throw new Error('No puedes anular mas unidades de las que tiene esta linea.');
  }

  const orderBundle = await loadOrderBundle(currentItem.orderId);
  const pendingPayments = orderBundle.payments.filter((payment) => payment.status === 'pending');
  if (pendingPayments.length > 0) {
    throw new Error('Esta cuenta tiene pagos pendientes por validar. Confirma o rechaza esos pagos antes de anular productos por excepcion.');
  }

  const confirmedPayments = orderBundle.payments.filter((payment) => payment.status === 'confirmed');
  const voidedAmount = currentItem.unitPrice * normalizedVoidQuantity;
  const outstandingByItem = allocateConfirmedPayments(orderBundle.items, confirmedPayments);
  const currentItemOutstanding = outstandingByItem.get(currentItem.id) ?? currentItem.totalPrice;
  if (currentItemOutstanding < voidedAmount) {
    throw new Error('Esta unidad ya esta cubierta por pagos confirmados. Anula una unidad sin pago o resuelve el pago antes.');
  }

  const nextBillableTotal = orderBundle.items
    .filter((item) => item.operationalStatus !== 'cancelled' && item.financialStatus !== 'cancelled')
    .reduce((sum, item) => sum + item.totalPrice, 0) - voidedAmount;
  const confirmedTotal = confirmedPayments.reduce((sum, payment) => sum + payment.amountApplied, 0);
  if (confirmedTotal > nextBillableTotal) {
    throw new Error('Anular este producto dejaria la cuenta sobrepagada. Hace falta resolver una devolucion o ajuste de pago antes.');
  }

  const supabase = getSupabaseClient();
  const now = new Date().toISOString();
  let updatedRows: PosOrderItemRow[];

  if (normalizedVoidQuantity === currentItem.quantity) {
    const { data, error } = await supabase
      .from('pos_order_items')
      .update({
        cancellation_reason: normalizedReason,
        cancelled_at: now,
        cancelled_by_email: actor.email,
        financial_status: 'cancelled',
        operational_status: 'cancelled',
        updated_by_email: actor.email,
      } as never)
      .eq('id', itemId)
      .not('operational_status', 'eq', 'cancelled')
      .select('*')
      .single();

    throwIfError(error, 'No fue posible anular el producto por excepcion');
    updatedRows = [data];
  } else {
    const remainingQuantity = currentItem.quantity - normalizedVoidQuantity;
    const { data: activeLine, error: activeLineError } = await supabase
      .from('pos_order_items')
      .update({
        quantity: remainingQuantity,
        total_price: currentItem.unitPrice * remainingQuantity,
        updated_by_email: actor.email,
      } as never)
      .eq('id', itemId)
      .not('operational_status', 'eq', 'cancelled')
      .select('*')
      .single();

    throwIfError(activeLineError, 'No fue posible ajustar la cantidad activa del producto');

    const { data: cancelledUnit, error: cancelledUnitError } = await supabase
      .from('pos_order_items')
      .insert({
        cancelled_at: now,
        cancelled_by_email: actor.email,
        cancellation_reason: normalizedReason,
        created_by_email: actor.email,
        delivered_at: currentItem.deliveredAt,
        delivered_by_email: currentItem.deliveredByEmail,
        financial_status: 'cancelled',
        menu_item_source_key: currentItem.menuItemSourceKey,
        notes: currentItem.notes ?? '',
        operational_status: 'cancelled',
        order_id: currentItem.orderId,
        picking_up_at: currentItem.pickingUpAt,
        picking_up_by_email: currentItem.pickingUpByEmail,
        prep_area: currentItem.prepArea,
        preparation_started_at: currentItem.preparationStartedAt,
        product_name: currentItem.productName,
        product_slug: currentItem.productSlug,
        quantity: normalizedVoidQuantity,
        ready_at: currentItem.readyAt,
        replacement_for_item_id: currentItem.id,
        sent_at: currentItem.sentAt,
        service_round: currentItem.serviceRound,
        total_price: voidedAmount,
        unit_price: currentItem.unitPrice,
        updated_by_email: actor.email,
      } as never)
      .select('*')
      .single();

    throwIfError(cancelledUnitError, 'No fue posible registrar la unidad anulada');
    updatedRows = [activeLine, cancelledUnit];
  }

  await reconcileOrderState(currentItem.orderId, actor.email);
  await insertPosLog({
    actor,
    afterData: {
      rows: updatedRows,
      voidedQuantity: normalizedVoidQuantity,
    },
    beforeData: currentItem,
    eventType: 'item_voided_after_process',
    notes: normalizedReason,
    orderId: currentItem.orderId,
    orderItemId: currentItem.id,
  });

  return updatedRows.map(mapPosOrderItemRow);
}

export async function sendDraftItemsToPreparationInSupabase(orderId: string, actor: PosActorContext) {
  const supabase = getSupabaseClient();
  const draftItems = await loadOrderItems(orderId);
  const pendingDrafts = draftItems.filter((item) => item.operationalStatus === 'draft');

  if (!pendingDrafts.length) {
    throw new Error('No hay lineas en borrador para enviar a preparacion.');
  }

  const now = new Date().toISOString();
  const ids = pendingDrafts.map((item) => item.id);
  const { data, error } = await supabase
    .from('pos_order_items')
    .update({
      operational_status: 'pending_preparation',
      sent_at: now,
      updated_by_email: actor.email,
    } as never)
    .in('id', ids)
    .select('*');

  throwIfError(error, 'No fue posible enviar el pedido a preparacion');

  await insertPosLog({
    actor,
    afterData: data,
    beforeData: pendingDrafts,
    eventType: 'order_sent_to_preparation',
    notes: `${pendingDrafts.length} linea(s) enviadas`,
    orderId,
    tableId: (await getOrderById(orderId)).tableId,
  });

  return data?.map(mapPosOrderItemRow) ?? [];
}

export async function transitionPreparationItemInSupabase(
  itemId: string,
  nextStatus: Extract<OrderOperationalStatus, 'in_process' | 'ready'>,
  actor: PosActorContext,
  currentItemOverride?: PosOrderItem,
) {
  const item = currentItemOverride ?? (await getOrderItemById(itemId));
  ensurePreparationPermission(item, actor.roles);

  const isDirectDispatch = await isRegisteredBeverageItem(item);
  const allowedCurrent = nextStatus === 'in_process'
    ? ['pending_preparation', 'sent']
    : ['pending_preparation', 'sent', 'in_process'];
  if (!allowedCurrent.includes(item.operationalStatus)) {
    throw new Error('La linea no esta en un estado valido para ese movimiento operativo.');
  }

  const supabase = getSupabaseClient();
  const now = new Date().toISOString();
  const updatePayload =
    nextStatus === 'in_process'
      ? {
          operational_status: 'in_process',
          preparation_started_at: now,
          updated_by_email: actor.email,
        }
      : {
          operational_status: 'ready',
          ready_at: now,
          updated_by_email: actor.email,
        };

  const { data, error } = await supabase
    .from('pos_order_items')
    .update(updatePayload as never)
    .eq('id', itemId)
    .in('operational_status', allowedCurrent)
    .select('*')
    .single();

  throwIfError(error, 'No fue posible actualizar el estado de preparacion');

  await insertPosLog({
    actor,
    afterData: data,
    beforeData: item,
    eventType: `item_${nextStatus}`,
    orderId: item.orderId,
    orderItemId: item.id,
  });

  return mapPosOrderItemRow(data);
}

export async function markOrderItemPickingUpInSupabase(itemId: string, actor: PosActorContext, currentItemOverride?: PosOrderItem) {
  const item = currentItemOverride ?? (await getOrderItemById(itemId));
  if (item.operationalStatus !== 'ready') {
    throw new Error('Solo puedes ir a recoger una linea que ya esta lista.');
  }

  const supabase = getSupabaseClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('pos_order_items')
    .update({
      operational_status: 'picking_up',
      picking_up_at: now,
      picking_up_by_email: actor.email,
      updated_by_email: actor.email,
    } as never)
    .eq('id', itemId)
    .eq('operational_status', 'ready')
    .select('*')
    .single();

  throwIfError(error, 'No fue posible marcar la linea como recogiendo');
  await insertPosLog({
    actor,
    afterData: data,
    beforeData: item,
    eventType: 'item_picking_up',
    orderId: item.orderId,
    orderItemId: item.id,
  });

  return mapPosOrderItemRow(data);
}

export async function markOrderItemDeliveredInSupabase(itemId: string, actor: PosActorContext, currentItemOverride?: PosOrderItem) {
  const item = currentItemOverride ?? (await getOrderItemById(itemId));
  if (!['ready', 'picking_up'].includes(item.operationalStatus)) {
    throw new Error('Solo puedes marcar como entregado un producto que ya este listo para salir.');
  }

  const supabase = getSupabaseClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('pos_order_items')
    .update({
      delivered_at: now,
      delivered_by_email: actor.email,
      operational_status: 'delivered',
      updated_by_email: actor.email,
    } as never)
    .eq('id', itemId)
    .in('operational_status', ['ready', 'picking_up'])
    .select('*')
    .single();

  throwIfError(error, 'No fue posible marcar la linea como entregada');
  await reconcileOrderState(item.orderId, actor.email);
  await insertPosLog({
    actor,
    afterData: data,
    beforeData: item,
    eventType: 'item_delivered',
    orderId: item.orderId,
    orderItemId: item.id,
  });

  return mapPosOrderItemRow(data);
}

export async function markOrderItemDirectDeliveredInSupabase(itemId: string, actor: PosActorContext, currentItemOverride?: PosOrderItem) {
  const item = currentItemOverride ?? (await getOrderItemById(itemId));
  ensureDirectDeliveryPermission(item, actor.roles);
  const operationalFlowSettings = mapPosOperationalFlowSettingsRows(await loadPosOperationalFlowSettingsRows());
  if (!operationalFlowSettings[item.prepArea].useDirectDelivery) {
    throw new Error(`La entrega directa no esta activa para ${item.prepArea === 'bar' ? 'bar' : 'cocina'}.`);
  }

  const allowedCurrent: OrderOperationalStatus[] = ['pending_preparation', 'sent', 'in_process', 'ready', 'picking_up'];
  if (!allowedCurrent.includes(item.operationalStatus)) {
    throw new Error('Solo puedes entregar directo un producto activo de preparacion o despacho.');
  }

  const supabase = getSupabaseClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('pos_order_items')
    .update({
      delivered_at: now,
      delivered_by_email: actor.email,
      operational_status: 'delivered',
      ready_at: item.readyAt ?? now,
      updated_by_email: actor.email,
    } as never)
    .eq('id', itemId)
    .in('operational_status', allowedCurrent)
    .select('*')
    .single();

  throwIfError(error, 'No fue posible entregar directo la linea');
  await reconcileOrderState(item.orderId, actor.email);
  await insertPosLog({
    actor,
    afterData: data,
    beforeData: item,
    eventType: 'item_direct_delivered',
    orderId: item.orderId,
    orderItemId: item.id,
  });

  return mapPosOrderItemRow(data);
}

export async function recordPosPaymentInSupabase(orderId: string, input: RecordPaymentInput, actor: PosActorContext) {
  const orderBundle = await loadOrderBundle(orderId);
  const summary = buildOrderSummary(orderBundle.items, orderBundle.payments);
  const amountApplied = resolvePaymentAmount(input, orderBundle.items, summary.remainingBalance);
  const salesSession = orderBundle.order.salesSessionId
    ? await getSalesSessionById(orderBundle.order.salesSessionId)
    : await ensureOpenSalesSession(actor);

  if (amountApplied <= 0) {
    throw new Error('El pago debe aplicar un valor mayor que cero.');
  }

  if (amountApplied > summary.remainingBalance + 0.001) {
    throw new Error('Ese pago supera el saldo restante de la cuenta.');
  }

  if (input.method === 'cash' && input.amountReceived != null && input.amountReceived < amountApplied) {
    throw new Error('El monto recibido en efectivo no cubre el valor aplicado.');
  }

  const status = requiresManualPaymentConfirmation(input.method) ? 'pending' : 'confirmed';
  const now = new Date().toISOString();
  const supabase = getSupabaseClient();

  if (status === 'pending' && orderBundle.payments.some((payment) => payment.status === 'pending')) {
    throw new Error('Esta cuenta ya tiene un pago pendiente por validar. Confirma o rechaza ese movimiento antes de registrar otro.');
  }

  if (orderBundle.order.salesSessionId !== salesSession.id) {
    const { error: attachSessionError } = await supabase
      .from('pos_orders')
      .update({
        sales_session_id: salesSession.id,
      } as never)
      .eq('id', orderId);

    throwIfError(attachSessionError, 'No fue posible asociar esta cuenta a la jornada activa');
  }

  const { data, error } = await supabase
    .from('pos_payments')
    .insert({
      allocation_mode: resolveAllocationMode(input),
      amount_applied: amountApplied,
      amount_received: input.amountReceived ?? null,
      change_due: input.method === 'cash' && input.amountReceived != null ? Math.max(input.amountReceived - amountApplied, 0) : null,
      confirmed_at: status === 'confirmed' ? now : null,
      confirmed_by_email: status === 'confirmed' ? actor.email : null,
      created_by_email: actor.email,
      method: input.method,
      notes: input.notes?.trim() ?? null,
      order_id: orderId,
      percentage_applied: input.percentage ?? null,
      reference: input.reference?.trim() ?? null,
      sales_session_id: salesSession.id,
      status,
      target_item_ids: (input.targetItemIds ?? []) as never,
    } as never)
    .select('*')
    .single();

  throwIfError(error, 'No fue posible registrar el pago');

  await reconcileOrderState(orderId, actor.email);
  await insertPosLog({
    actor,
    afterData: data,
    eventType: `payment_${status}`,
    notes: input.notes?.trim() ?? null,
    orderId,
  });

  return mapPosPaymentRow(data);
}

export async function closeActiveSalesSessionInSupabase(actor: PosActorContext, notes?: string) {
  const supabase = getSupabaseClient();
  const session = await getOpenSalesSession();

  if (!session) {
    throw new Error('No hay una jornada activa para cerrar en este momento.');
  }

  const sessionPayments = await loadPaymentsBySalesSessionId(session.id);
  const directSessionOrders = await loadOrdersForSalesSession(session.id);
  const paymentLinkedOrderIds = Array.from(new Set(sessionPayments.map((payment) => payment.orderId)));
  const missingOrderIds = paymentLinkedOrderIds.filter((orderId) => !directSessionOrders.some((order) => order.id === orderId));
  const inferredOrders = missingOrderIds.length ? await loadOrdersByIds(missingOrderIds) : [];
  const sessionOrders = dedupeOrdersById([...directSessionOrders, ...inferredOrders]).sort((left, right) => left.openedAt.localeCompare(right.openedAt));
  const sessionOrderIds = sessionOrders.map((order) => order.id);
  const sessionItems = sessionOrderIds.length ? await loadOrderItemsByOrderIds(sessionOrderIds) : [];
  const itemsByOrderId = new Map<string, PosOrderItem[]>();
  const paymentsByOrderId = new Map<string, PosPayment[]>();

  for (const item of sessionItems) {
    const bucket = itemsByOrderId.get(item.orderId) ?? [];
    bucket.push(item);
    itemsByOrderId.set(item.orderId, bucket);
  }

  for (const payment of sessionPayments) {
    const bucket = paymentsByOrderId.get(payment.orderId) ?? [];
    bucket.push(payment);
    paymentsByOrderId.set(payment.orderId, bucket);
  }

  const ordersWithRelations = sessionOrders.map((order) => {
    const orderItems = itemsByOrderId.get(order.id) ?? [];
    const orderPayments = paymentsByOrderId.get(order.id) ?? [];
    return {
      ...order,
      items: orderItems,
      payments: orderPayments,
      summary: buildOrderSummary(orderItems, orderPayments),
    };
  });

  const ordersWithBalance = ordersWithRelations.filter(
    (order) => order.summary.remainingBalance > 0 || order.summary.pendingPayments > 0,
  );

  if (ordersWithBalance.length) {
    throw new Error('No puedes cerrar la jornada mientras sigan cuentas abiertas, saldos pendientes o pagos por confirmar.');
  }

  const orderIdsMissingSession = sessionOrders.filter((order) => order.salesSessionId !== session.id).map((order) => order.id);
  if (orderIdsMissingSession.length) {
    const { error: attachOrdersError } = await supabase
      .from('pos_orders')
      .update({
        sales_session_id: session.id,
      } as never)
      .in('id', orderIdsMissingSession);

    throwIfError(attachOrdersError, 'No fue posible terminar de vincular las cuentas a la jornada antes del cierre');
  }

  const summary = buildSalesSessionSummary(ordersWithRelations, sessionPayments);
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('pos_sales_sessions')
    .update({
      closed_at: now,
      closed_by_email: actor.email,
      notes: notes?.trim() ?? session.notes,
      status: 'closed',
      summary: summary as never,
    } as never)
    .eq('id', session.id)
    .eq('status', 'open')
    .select('*')
    .single();

  throwIfError(error, 'No fue posible cerrar la jornada de ventas');

  await insertPosLog({
    actor,
    afterData: data,
    beforeData: session,
    eventType: 'sales_session_closed',
    notes: `Jornada cerrada: ${session.sessionLabel}`,
  });

  return mapPosSalesSessionRow(data);
}

export async function loadSalesSessionHistoryFromSupabase(): Promise<PosSalesSessionHistoryEntry[]> {
  const [sessions, allOrders, allPayments, allItems] = await Promise.all([
    loadAllPosSalesSessionRows(),
    loadAllPosOrdersRows(),
    loadAllPosPaymentRows(),
    loadAllPosOrderItemRows(),
  ]);
  return buildSalesSessionHistory(sessions, allOrders, allPayments, allItems);
}

export async function loadSalesSessionHistoryViewFromSupabase() {
  const supabase = getSupabaseClient();
  const [sessions, allOrders, allPayments, allItems, tables] = await Promise.all([
    loadAllPosSalesSessionRows(),
    loadAllPosOrdersRows(),
    loadAllPosPaymentRows(),
    loadAllPosOrderItemRows(),
    supabase.from('pos_tables').select('*').order('code', { ascending: true }),
  ]);
  throwIfError(tables.error, 'No fue posible leer las mesas POS');
  const ordersWithRelations = buildOrdersWithRelations(allOrders, allItems, allPayments);

  return {
    history: buildSalesSessionHistory(sessions, allOrders, allPayments, allItems),
    closedSales: ordersWithRelations
      .filter((order) => order.closedAt != null)
      .sort((left, right) => (right.closedAt ?? right.updatedAt).localeCompare(left.closedAt ?? left.updatedAt)),
    tables: buildTablesWithOrders(tables.data ?? [], ordersWithRelations),
  };
}

function buildSalesSessionHistory(
  sessions: PosSalesSessionRow[],
  allOrders: PosOrderRow[],
  allPayments: PosPaymentRow[],
  allItems: PosOrderItemRow[],
): PosSalesSessionHistoryEntry[] {
  const orders = allOrders.filter((order) => order.sales_session_id != null);
  const payments = allPayments.filter((payment) => payment.sales_session_id != null);
  const orderIds = new Set(orders.map((order) => order.id));
  const items = allItems.filter((item) => orderIds.has(item.order_id));

  const ordersWithRelations = buildOrdersWithRelations(orders, items, payments);
  const ordersBySessionId = new Map<string, PosOrderWithRelations[]>();
  const paymentsBySessionId = new Map<string, PosPayment[]>();

  for (const order of ordersWithRelations) {
    if (!order.salesSessionId) {
      continue;
    }

    ordersBySessionId.set(order.salesSessionId, [...(ordersBySessionId.get(order.salesSessionId) ?? []), order]);
  }

  for (const payment of payments.map(mapPosPaymentRow)) {
    if (!payment.salesSessionId) {
      continue;
    }

    paymentsBySessionId.set(payment.salesSessionId, [...(paymentsBySessionId.get(payment.salesSessionId) ?? []), payment]);
  }

  return sessions.map((row) => {
    const session = mapPosSalesSessionRow(row);
    const sessionOrders = ordersBySessionId.get(session.id) ?? [];
    const sessionPayments = paymentsBySessionId.get(session.id) ?? [];
    const liveSummary = sessionOrders.length || sessionPayments.length
      ? buildSalesSessionSummary(sessionOrders, sessionPayments)
      : session.summary;

    return {
      ...session,
      summary: liveSummary,
      orderCount: liveSummary?.orderCount ?? 0,
      paymentCount: liveSummary?.confirmedPayments ?? 0,
      totalCollected: liveSummary?.totalCollected ?? 0,
      totalSold: liveSummary?.grossSales ?? 0,
    };
  });
}

export async function deleteSalesSessionFromSupabase(sessionId: string, actor: PosActorContext) {
  ensureCanManageSalesSessions(actor.roles);
  const supabase = getSupabaseClient();
  const session = await getSalesSessionById(sessionId);

  if (session.status === 'open') {
    throw new Error('No puedes eliminar una jornada abierta. Cierrala primero.');
  }

  const { error } = await supabase.rpc('delete_pos_sales_session' as never, { sales_session_id: sessionId } as never);
  throwIfError(error, 'No fue posible eliminar la jornada');

  return session;
}

export async function reassignOrderSalesSessionInSupabase(orderId: string, destinationSalesSessionId: string, actor: PosActorContext) {
  ensureCanManageSalesSessions(actor.roles);

  if (!destinationSalesSessionId) {
    throw new Error('Selecciona la jornada destino antes de mover la cuenta.');
  }

  const supabase = getSupabaseClient();
  const { error } = await supabase.rpc('reassign_pos_order_sales_session' as never, {
    destination_sales_session_id: destinationSalesSessionId,
    target_order_id: orderId,
  } as never);

  throwIfError(error, 'No fue posible mover la cuenta a otra jornada');
}

export async function createManualSalesSessionInSupabase(input: ManualSalesSessionWindowInput, actor: PosActorContext) {
  ensureCanManageSalesSessions(actor.roles);
  validateManualSalesSessionWindow(input);

  const supabase = getSupabaseClient();
  const { error } = await supabase.rpc('create_pos_sales_session_manual' as never, {
    manual_business_date: input.businessDate,
    manual_closed_at: input.closedAt,
    manual_notes: input.notes?.trim() ?? '',
    manual_opened_at: input.openedAt,
    manual_session_label: input.sessionLabel?.trim() || null,
  } as never);

  throwIfError(error, 'No fue posible crear la jornada manual');
}

export async function updateSalesSessionWindowInSupabase(sessionId: string, input: ManualSalesSessionWindowInput, actor: PosActorContext) {
  ensureCanManageSalesSessions(actor.roles);
  validateManualSalesSessionWindow(input);

  const supabase = getSupabaseClient();
  const { error } = await supabase.rpc('update_pos_sales_session_window' as never, {
    manual_business_date: input.businessDate,
    manual_closed_at: input.closedAt,
    manual_notes: input.notes?.trim() ?? null,
    manual_opened_at: input.openedAt,
    manual_session_label: input.sessionLabel?.trim() || null,
    sales_session_id: sessionId,
  } as never);

  throwIfError(error, 'No fue posible ajustar la jornada');
}

export async function updatePosPaymentStatusInSupabase(
  paymentId: string,
  input: UpdatePaymentStatusInput,
  actor: PosActorContext,
  currentPaymentOverride?: PosPayment,
) {
  const payment = currentPaymentOverride ?? (await getPaymentById(paymentId));

  if (payment.status !== 'pending') {
    throw new Error('Solo puedes confirmar o rechazar pagos que siguen pendientes.');
  }

  const now = new Date().toISOString();
  const supabase = getSupabaseClient();
  const updatePayload =
    input.status === 'confirmed'
      ? {
          confirmed_at: now,
          confirmed_by_email: actor.email,
          notes: input.notes?.trim() ?? payment.notes ?? null,
          status: 'confirmed',
        }
      : {
          notes: input.notes?.trim() ?? payment.notes ?? null,
          rejected_at: now,
          rejected_by_email: actor.email,
          rejection_reason: input.rejectionReason?.trim() ?? 'Pago rechazado',
          status: 'rejected',
        };

  const { data, error } = await supabase
    .from('pos_payments')
    .update(updatePayload as never)
    .eq('id', paymentId)
    .eq('status', 'pending')
    .select('*')
    .single();

  throwIfError(error, 'No fue posible actualizar el estado del pago');

  await reconcileOrderState(payment.orderId, actor.email);
  await insertPosLog({
    actor,
    afterData: data,
    beforeData: payment,
    eventType: `payment_${input.status}`,
    notes: input.rejectionReason?.trim() ?? input.notes?.trim() ?? null,
    orderId: payment.orderId,
  });

  return mapPosPaymentRow(data);
}

export function subscribeToPosRealtime(
  onChange: () => void,
  onEvent?: (event: PosRealtimeEvent) => boolean | void,
  onStatusChange?: (status: REALTIME_SUBSCRIBE_STATES) => void,
) {
  const supabase = getSupabaseClient();
  const channel: RealtimeChannel = supabase.channel('zafiro-pos-live');
  let isActive = true;
  const buildHandler =
    (table: PosRealtimeTable) =>
    (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => {
      const eventId = (payload.new as Record<string, unknown>)?.id ?? (payload.old as Record<string, unknown>)?.id ?? '-';
      logPosSync(`realtime received table=${table} event=${payload.eventType} id=${eventId}`);
      if (!isActive) {
        logPosSync(`realtime ignored reason=inactive table=${table} event=${payload.eventType} id=${eventId}`);
        return;
      }
      const shouldReload = onEvent?.({
        eventType: payload.eventType,
        newRecord: payload.new ?? null,
        oldRecord: payload.old ?? null,
        table,
      });

      logPosSync(`realtime table=${table} event=${payload.eventType} id=${eventId} reload=${shouldReload ?? 'default'}`);
      if (shouldReload !== false) {
        logPosSync(`onChange reason=realtime:${table}:${payload.eventType} id=${eventId}`);
        onChange();
      }
    };

  channel
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pos_tables' }, buildHandler('pos_tables'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pos_orders' }, buildHandler('pos_orders'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pos_order_items' }, buildHandler('pos_order_items'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pos_payments' }, buildHandler('pos_payments'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pos_sales_sessions' }, buildHandler('pos_sales_sessions'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pos_order_status_logs' }, buildHandler('pos_order_status_logs'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pos_operational_flow_settings' }, buildHandler('pos_operational_flow_settings'))
    .subscribe((status) => {
      if (isActive) {
        onStatusChange?.(status);
      }
    });

  return () => {
    if (!isActive) {
      return;
    }
    isActive = false;
    void supabase.removeChannel(channel);
  };
}

export function subscribeToPosOperationalSettingsRealtime(onChange: () => void) {
  const supabase = getSupabaseClient();
  const channel = supabase.channel('zafiro-pos-operational-settings-live');
  let isActive = true;
  channel
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pos_operational_flow_settings' }, () => {
      if (isActive) {
        onChange();
      }
    })
    .subscribe();

  return () => {
    if (!isActive) {
      return;
    }
    isActive = false;
    void supabase.removeChannel(channel);
  };
}

async function loadCurrentStaffProfile() {
  const supabase = getSupabaseClient();
  const userEmail = await getCurrentUserEmail();

  if (!userEmail) {
    return null;
  }

  const { data, error } = await supabase.from('staff_profiles').select('*').eq('email', userEmail).maybeSingle();
  throwIfError(error, 'No fue posible leer tu perfil operativo');
  return data;
}

async function loadCurrentStaffRoles() {
  const supabase = getSupabaseClient();
  const userEmail = await getCurrentUserEmail();

  if (!userEmail) {
    return [] as StaffRole[];
  }

  const { data, error } = await supabase.from('staff_role_assignments').select('*').eq('email', userEmail);
  throwIfError(error, 'No fue posible leer tus roles operativos');
  return (data ?? []).map((entry) => entry.role as StaffRole);
}

async function ensureOpenOrderForTable(table: PosTable, actor: PosActorContext) {
  if (table.activeOrderId) {
    const existingOrder = await getOrderById(table.activeOrderId);
    if (existingOrder.salesSessionId) {
      return existingOrder;
    }

    const salesSession = await ensureOpenSalesSession(actor);
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('pos_orders')
      .update({
        sales_session_id: salesSession.id,
      } as never)
      .eq('id', table.activeOrderId)
      .select('*')
      .single();

    throwIfError(error, 'No fue posible vincular la cuenta existente a la jornada activa');
    return mapPosOrderRow(data);
  }

  const supabase = getSupabaseClient();
  const salesSession = await ensureOpenSalesSession(actor);
  const { data, error } = await supabase
    .from('pos_orders')
    .insert({
      assigned_staff_email: actor.email,
      financial_status: 'pending_payment',
      notes: '',
      opened_by_email: actor.email,
      sales_session_id: salesSession.id,
      table_code_snapshot: table.code,
      table_id: table.id,
      table_name_snapshot: table.name,
    } as never)
    .select('*')
    .single();

  throwIfError(error, 'No fue posible abrir la cuenta de la mesa');
  await touchTableOccupation(table.id, data.id, actor.email);
  await insertPosLog({
    actor,
    afterData: data,
    eventType: 'order_opened',
    notes: `Cuenta abierta para ${table.code}`,
    orderId: data.id,
    tableId: table.id,
  });
  return mapPosOrderRow(data);
}

async function touchTableOccupation(tableId: string, activeOrderId: string, staffEmail: string) {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from('pos_tables')
    .update({
      active_order_id: activeOrderId,
      assigned_staff_email: staffEmail,
      status: 'occupied',
    } as never)
    .eq('id', tableId);

  throwIfError(error, 'No fue posible actualizar el estado de la mesa');
}

async function reconcileOrderState(orderId: string, actorEmail: string) {
  const supabase = getSupabaseClient();
  const bundle = await loadOrderBundle(orderId);
  const allocation = allocateConfirmedPayments(bundle.items, bundle.payments);
  const updatedStatuses = bundle.items
    .map((item) => {
      if (item.operationalStatus === 'cancelled') {
        return { id: item.id, financialStatus: 'cancelled' as OrderFinancialStatus };
      }

      const remaining = allocation.get(item.id) ?? item.totalPrice;
      const nextStatus: OrderFinancialStatus = remaining <= 0 ? 'paid_total' : remaining < item.totalPrice ? 'partially_paid' : 'pending_payment';
      return { id: item.id, financialStatus: nextStatus };
    })
    .filter((entry) => {
      const current = bundle.items.find((item) => item.id === entry.id);
      return current?.financialStatus !== entry.financialStatus;
    });

  for (const entry of updatedStatuses) {
    const { error } = await supabase
      .from('pos_order_items')
      .update({
        financial_status: entry.financialStatus,
        updated_by_email: actorEmail,
      } as never)
      .eq('id', entry.id);
    throwIfError(error, 'No fue posible reconciliar el estado financiero de una linea');
  }

  const refreshedBundle = updatedStatuses.length ? await loadOrderBundle(orderId) : bundle;
  const summary = buildOrderSummary(refreshedBundle.items, refreshedBundle.payments);
  const nextOrderStatus = deriveOrderFinancialStatus(refreshedBundle.items, summary);
  const orderUpdates: Record<string, unknown> = {
    financial_status: nextOrderStatus,
  };

  const shouldCloseOrder =
    (nextOrderStatus === 'paid_total' || nextOrderStatus === 'cancelled') &&
    refreshedBundle.items.length > 0 &&
    refreshedBundle.items.every((item) => TERMINAL_ITEM_STATUSES.has(item.operationalStatus));

  if (shouldCloseOrder) {
    orderUpdates.closed_at = new Date().toISOString();
  }

  const { error: orderError } = await supabase.from('pos_orders').update(orderUpdates as never).eq('id', orderId);
  throwIfError(orderError, 'No fue posible reconciliar la orden');

  const tableUpdates = shouldCloseOrder
    ? {
        active_order_id: null,
        assigned_staff_email: null,
        status: 'available',
      }
    : {
        active_order_id: orderId,
        status: 'occupied',
      };

  const { error: tableError } = await supabase
    .from('pos_tables')
    .update(tableUpdates as never)
    .eq('id', refreshedBundle.order.tableId ?? '');
  throwIfError(tableError, 'No fue posible reconciliar la mesa');
}

async function loadOrderBundle(orderId: string) {
  const [order, items, payments] = await Promise.all([getOrderById(orderId), loadOrderItems(orderId), loadOrderPayments(orderId)]);
  return { order, items, payments };
}

async function loadOrderWithRelationsById(orderId: string): Promise<PosOrderWithRelations> {
  const bundle = await loadOrderBundle(orderId);

  return {
    ...bundle.order,
    items: bundle.items,
    payments: bundle.payments,
    summary: buildOrderSummary(bundle.items, bundle.payments),
  };
}

function buildOrdersWithRelations(
  orders: PosOrderRow[],
  items: PosOrderItemRow[],
  payments: PosPaymentRow[],
): PosOrderWithRelations[] {
  const itemsByOrderId = new Map<string, PosOrderItem[]>();
  const paymentsByOrderId = new Map<string, PosPayment[]>();

  for (const row of items) {
    const mapped = mapPosOrderItemRow(row);
    const bucket = itemsByOrderId.get(mapped.orderId) ?? [];
    bucket.push(mapped);
    itemsByOrderId.set(mapped.orderId, bucket);
  }

  for (const row of payments) {
    const mapped = mapPosPaymentRow(row);
    const bucket = paymentsByOrderId.get(mapped.orderId) ?? [];
    bucket.push(mapped);
    paymentsByOrderId.set(mapped.orderId, bucket);
  }

  return orders.map((row) => {
    const order = mapPosOrderRow(row);
    const orderItems = itemsByOrderId.get(order.id) ?? [];
    const orderPayments = paymentsByOrderId.get(order.id) ?? [];

    return {
      ...order,
      salesSessionId: order.salesSessionId ?? inferOrderSalesSessionId(orderPayments),
      items: orderItems,
      payments: orderPayments,
      summary: buildOrderSummary(orderItems, orderPayments),
    };
  });
}

function inferOrderSalesSessionId(payments: PosPayment[]) {
  const grouped = new Map<string, number>();

  for (const payment of payments) {
    if (!payment.salesSessionId) {
      continue;
    }

    grouped.set(payment.salesSessionId, (grouped.get(payment.salesSessionId) ?? 0) + 1);
  }

  return Array.from(grouped.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function dedupeOrdersById(orders: PosOrder[]) {
  return Array.from(new Map(orders.map((order) => [order.id, order])).values());
}

function buildTablesWithOrders(tables: PosTableRow[], orders: PosOrderWithRelations[]): PosTableWithOrder[] {
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  return tables.map((row) => ({
    ...mapPosTableRow(row),
    activeOrder: row.active_order_id ? ordersById.get(row.active_order_id) ?? null : null,
  }));
}

function buildOrderSummary(items: PosOrderItem[], payments: PosPayment[]): PosOrderComputedSummary {
  const billableItems = items.filter((item) => item.operationalStatus !== 'cancelled' && item.financialStatus !== 'cancelled');
  const subtotal = billableItems.reduce((sum, item) => sum + item.totalPrice, 0);
  const confirmedPayments = payments.filter((payment) => payment.status === 'confirmed');
  const pendingPayments = payments.filter((payment) => payment.status === 'pending');
  const totalPaid = confirmedPayments.reduce((sum, payment) => sum + payment.amountApplied, 0);
  const remainingBalance = Math.max(subtotal - totalPaid, 0);

  return {
    subtotal,
    totalDue: subtotal,
    totalPaid,
    remainingBalance,
    pendingPayments: pendingPayments.length,
    confirmedPayments: confirmedPayments.length,
  };
}

function allocateConfirmedPayments(items: PosOrderItem[], payments: PosPayment[]) {
  const outstanding = new Map<string, number>();
  const activeItems = items.filter((item) => item.operationalStatus !== 'cancelled');
  const activeItemsById = new Map(activeItems.map((item) => [item.id, item]));
  for (const item of activeItems) {
    outstanding.set(item.id, item.totalPrice);
  }

  const confirmedPayments = payments
    .filter((payment) => payment.status === 'confirmed')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const payment of confirmedPayments) {
    let remaining = payment.amountApplied;
    const targetIds =
      payment.allocationMode === 'items' && payment.targetItemIds?.length
        ? payment.targetItemIds
        : activeItems.map((item) => item.id);

    for (const targetEntry of targetIds) {
      if (remaining <= 0) {
        break;
      }

      const itemId = parsePaymentTargetItemId(targetEntry);
      const item = activeItemsById.get(itemId);
      if (!item) {
        continue;
      }

      const currentOutstanding = outstanding.get(itemId);
      if (!currentOutstanding || currentOutstanding <= 0) {
        continue;
      }

      const maxChunk = isPaymentUnitKey(targetEntry) ? item.unitPrice : item.totalPrice;
      const applied = Math.min(currentOutstanding, remaining, maxChunk);
      outstanding.set(itemId, Math.max(currentOutstanding - applied, 0));
      remaining -= applied;
    }
  }

  return outstanding;
}

function deriveOrderFinancialStatus(items: PosOrderItem[], summary: PosOrderComputedSummary): OrderFinancialStatus {
  const activeItems = items.filter((item) => item.operationalStatus !== 'cancelled');
  if (!activeItems.length) {
    return 'cancelled';
  }

  if (summary.remainingBalance <= 0 && summary.totalDue > 0) {
    return 'paid_total';
  }

  if (summary.totalPaid > 0) {
    return 'partially_paid';
  }

  return 'pending_payment';
}

function resolvePaymentAmount(input: RecordPaymentInput, items: PosOrderItem[], remainingBalance: number) {
  const mode = resolveAllocationMode(input);
  if (mode === 'total') {
    return remainingBalance;
  }

  if (mode === 'amount') {
    return normalizeMoney(input.amount);
  }

  if (mode === 'percentage') {
    const percentage = input.percentage ?? 0;
    return normalizeMoney((remainingBalance * percentage) / 100);
  }

  const itemMap = new Map(items.filter((item) => item.operationalStatus !== 'cancelled').map((item) => [item.id, item]));
  return normalizeMoney(
    (input.targetItemIds ?? []).reduce((sum, targetEntry) => {
      const itemId = parsePaymentTargetItemId(targetEntry);
      const item = itemMap.get(itemId);
      if (!item) {
        return sum;
      }

      return sum + (isPaymentUnitKey(targetEntry) ? item.unitPrice : item.totalPrice);
    }, 0),
  );
}

function resolveAllocationMode(input: RecordPaymentInput): PaymentAllocationMode {
  if (input.targetItemIds?.length) {
    return 'items';
  }

  if (input.percentage != null) {
    return 'percentage';
  }

  if (input.amount != null) {
    return 'amount';
  }

  return 'total';
}

function requiresManualPaymentConfirmation(method: PaymentMethod) {
  return method === 'nequi' || method === 'bank_transfer';
}

function isPaymentUnitKey(value: string) {
  return value.includes('::');
}

function parsePaymentTargetItemId(value: string) {
  return isPaymentUnitKey(value) ? value.split('::')[0] ?? value : value;
}

function ensurePreparationPermission(item: PosOrderItem, roles: StaffRole[]) {
  if (roles.includes('superadmin')) {
    return;
  }

  if (item.prepArea === 'kitchen' && roles.includes('kitchen')) {
    return;
  }

  if (item.prepArea === 'bar' && roles.includes('bar')) {
    return;
  }

  throw new Error('Tu rol actual no puede operar esta cola de preparacion.');
}

function ensureDirectDeliveryPermission(item: PosOrderItem, roles: StaffRole[]) {
  if (roles.includes('superadmin') || roles.includes('waiter')) {
    return;
  }

  if (item.prepArea === 'kitchen' && roles.includes('kitchen')) {
    return;
  }

  if (item.prepArea === 'bar' && roles.includes('bar')) {
    return;
  }

  throw new Error('Tu rol actual no puede entregar directo este producto.');
}

function ensureCanMoveActiveOrder(roles: StaffRole[]) {
  if (roles.includes('superadmin') || roles.includes('waiter')) {
    return;
  }

  throw new Error('Tu rol actual no puede mover cuentas entre mesas.');
}

function ensureCanVoidProcessedItem(roles: StaffRole[]) {
  if (roles.includes('superadmin') || roles.includes('cashier')) {
    return;
  }

  throw new Error('Tu rol actual no puede anular productos por excepcion.');
}

function ensureCanCancelClosedPaidOrder(roles: StaffRole[]) {
  if (roles.includes('superadmin')) {
    return;
  }

  throw new Error('Solo superadmin puede anular ventas cerradas.');
}

function ensureCanManageSalesSessions(roles: StaffRole[]) {
  if (roles.includes('superadmin')) {
    return;
  }

  throw new Error('Solo superadmin puede administrar el historial de jornadas.');
}

function validateManualSalesSessionWindow(input: ManualSalesSessionWindowInput) {
  if (!input.businessDate) {
    throw new Error('La jornada debe tener fecha contable.');
  }

  if (!input.openedAt || !input.closedAt) {
    throw new Error('La jornada debe tener fecha de apertura y cierre.');
  }

  if (new Date(input.closedAt).getTime() <= new Date(input.openedAt).getTime()) {
    throw new Error('La fecha de cierre debe ser posterior a la apertura.');
  }
}

export function derivePreparationAreaFromProductType(productType: string): PreparationArea {
  const normalized = productType.trim().toLowerCase();
  if (BAR_PRODUCT_TYPES.has(normalized)) {
    return 'bar';
  }
  if (KITCHEN_PRODUCT_TYPES.has(normalized)) {
    return 'kitchen';
  }
  return 'bar';
}

function isMergeableDraftOrderItem(
  item: PosOrderItem,
  fields: {
    menuItemSourceKey?: string | null;
    notes: string;
    prepArea: PreparationArea;
    productName: string;
    productSlug: string;
    unitPrice: number;
  },
) {
  return (
    item.operationalStatus === 'draft' &&
    item.financialStatus === 'pending_payment' &&
    !item.replacementForItemId &&
    (item.menuItemSourceKey ?? null) === (fields.menuItemSourceKey ?? null) &&
    item.prepArea === fields.prepArea &&
    item.productName.trim().toLowerCase() === fields.productName.trim().toLowerCase() &&
    item.productSlug.trim().toLowerCase() === fields.productSlug.trim().toLowerCase() &&
    item.unitPrice === fields.unitPrice &&
    (item.notes ?? '').trim() === fields.notes
  );
}

async function isRegisteredBeverageItem(item: PosOrderItem) {
  if (!item.menuItemSourceKey) {
    return false;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('menu_items_public')
    .select('tipo')
    .eq('source_key', item.menuItemSourceKey)
    .maybeSingle();

  throwIfError(error, 'No fue posible validar el flujo operativo del producto');
  return data?.tipo?.trim().toLowerCase() === 'bebidas';
}

function resolvePreparationQueueTimestamp(item: PosOrderItem) {
  return item.sentAt ?? item.createdAt;
}

async function getTableById(tableId: string) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('pos_tables').select('*').eq('id', tableId).single();
  throwIfError(error, 'No fue posible leer la mesa seleccionada');
  return mapPosTableRow(data);
}

async function getOrderById(orderId: string) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('pos_orders').select('*').eq('id', orderId).single();
  throwIfError(error, 'No fue posible leer la orden seleccionada');
  return mapPosOrderRow(data);
}

async function getOrderItemById(itemId: string) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('pos_order_items').select('*').eq('id', itemId).single();
  throwIfError(error, 'No fue posible leer la linea seleccionada');
  return mapPosOrderItemRow(data);
}

async function getPaymentById(paymentId: string) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('pos_payments').select('*').eq('id', paymentId).single();
  throwIfError(error, 'No fue posible leer el pago seleccionado');
  return mapPosPaymentRow(data);
}

async function loadOrderItems(orderId: string) {
  const supabase = getSupabaseClient();
  const pageSize = 1000;
  const rows: PosOrderItemRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('pos_order_items')
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);
    throwIfError(error, 'No fue posible leer las lineas de la orden');
    rows.push(...(data ?? []));

    if ((data?.length ?? 0) < pageSize) {
      break;
    }
  }

  return rows.map(mapPosOrderItemRow);
}

async function loadOrderPayments(orderId: string) {
  const supabase = getSupabaseClient();
  const pageSize = 1000;
  const rows: PosPaymentRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('pos_payments')
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);
    throwIfError(error, 'No fue posible leer los pagos de la orden');
    rows.push(...(data ?? []));

    if ((data?.length ?? 0) < pageSize) {
      break;
    }
  }

  return rows.map(mapPosPaymentRow);
}

async function loadOrderItemsByOrderIds(orderIds: string[]) {
  if (!orderIds.length) {
    return [] as PosOrderItem[];
  }

  const supabase = getSupabaseClient();
  const chunkSize = 200;
  const pageSize = 1000;
  const rows: PosOrderItemRow[] = [];

  for (let index = 0; index < orderIds.length; index += chunkSize) {
    const chunk = orderIds.slice(index, index + chunkSize);

    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('pos_order_items')
        .select('*')
        .in('order_id', chunk)
        .order('created_at', { ascending: true })
        .range(from, from + pageSize - 1);
      throwIfError(error, 'No fue posible leer los productos de la jornada');
      rows.push(...(data ?? []));

      if ((data?.length ?? 0) < pageSize) {
        break;
      }
    }
  }

  return rows.map(mapPosOrderItemRow).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function loadPaymentsBySalesSessionId(salesSessionId: string) {
  const supabase = getSupabaseClient();
  const pageSize = 1000;
  const rows: PosPaymentRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('pos_payments')
      .select('*')
      .eq('sales_session_id', salesSessionId)
      .order('created_at', { ascending: true })
      .range(from, from + pageSize - 1);
    throwIfError(error, 'No fue posible leer los pagos de la jornada');
    rows.push(...(data ?? []));

    if ((data?.length ?? 0) < pageSize) {
      break;
    }
  }

  return rows.map(mapPosPaymentRow);
}

async function loadOrdersForSalesSession(salesSessionId: string) {
  const supabase = getSupabaseClient();
  const pageSize = 1000;
  const rows: PosOrderRow[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('pos_orders')
      .select('*')
      .eq('sales_session_id', salesSessionId)
      .order('opened_at', { ascending: true })
      .range(from, from + pageSize - 1);
    throwIfError(error, 'No fue posible leer las ordenes de la jornada');
    rows.push(...(data ?? []));

    if ((data?.length ?? 0) < pageSize) {
      break;
    }
  }

  return rows.map(mapPosOrderRow);
}

async function loadOrdersByIds(orderIds: string[]) {
  if (!orderIds.length) {
    return [] as PosOrder[];
  }

  const supabase = getSupabaseClient();
  const chunkSize = 200;
  const pageSize = 1000;
  const rows: PosOrderRow[] = [];

  for (let index = 0; index < orderIds.length; index += chunkSize) {
    const chunk = orderIds.slice(index, index + chunkSize);

    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('pos_orders')
        .select('*')
        .in('id', chunk)
        .order('opened_at', { ascending: true })
        .range(from, from + pageSize - 1);
      throwIfError(error, 'No fue posible completar las cuentas asociadas a la jornada');
      rows.push(...(data ?? []));

      if ((data?.length ?? 0) < pageSize) {
        break;
      }
    }
  }

  return rows.map(mapPosOrderRow).sort((left, right) => left.openedAt.localeCompare(right.openedAt));
}

async function getSalesSessionById(salesSessionId: string) {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from('pos_sales_sessions').select('*').eq('id', salesSessionId).single();
  throwIfError(error, 'No fue posible leer la jornada de ventas');
  return mapPosSalesSessionRow(data);
}

async function getOpenSalesSession() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('pos_sales_sessions')
    .select('*')
    .eq('status', 'open')
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  throwIfError(error, 'No fue posible leer la jornada activa');
  return data ? mapPosSalesSessionRow(data) : null;
}

async function ensureOpenSalesSession(actor: PosActorContext) {
  const currentOpenSession = await getOpenSalesSession();
  if (currentOpenSession) {
    return currentOpenSession;
  }
  return openSalesSessionInSupabase(actor);
}

async function insertPosLog(input: {
  actor: PosActorContext;
  afterData?: unknown;
  beforeData?: unknown;
  eventType: string;
  notes?: string | null;
  orderId?: string | null;
  orderItemId?: string | null;
  tableId?: string | null;
}) {
  const supabase = getSupabaseClient();
  const actorRole = input.actor.roles.includes('superadmin') ? 'superadmin' : input.actor.roles[0] ?? null;
  const { error } = await supabase.from('pos_order_status_logs').insert({
    actor_email: input.actor.email,
    actor_role: actorRole,
    after_data: (input.afterData ?? null) as never,
    before_data: (input.beforeData ?? null) as never,
    event_type: input.eventType,
    notes: input.notes ?? null,
    order_id: input.orderId ?? null,
    order_item_id: input.orderItemId ?? null,
    table_id: input.tableId ?? null,
  } as never);

  throwIfError(error, 'No fue posible registrar la trazabilidad POS');
}

async function getCurrentUserEmail() {
  const supabase = getSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.email?.trim().toLowerCase() ?? null;
}

function normalizeEffectiveRoles(roles: StaffRole[], profile: StaffProfileRow | null, userEmail: string | null) {
  const deduped = new Set<StaffRole>(roles);
  if (!profile && roles.length === 0 && !userEmail) {
    return [] as StaffRole[];
  }
  return Array.from(deduped);
}

function buildStaffProfile(profile: StaffProfileRow | null, roles: StaffRole[], userEmail: string | null): StaffProfile | null {
  if (!profile && !userEmail) {
    return null;
  }

  return {
    email: profile?.email ?? userEmail ?? '',
    fullName: profile?.full_name ?? userEmail ?? 'Operador',
    isActive: profile?.is_active ?? true,
    roles,
  };
}

function mapMenuItemPublicRow(row: MenuItemPublicRow): PosProductOption {
  return {
    available: row.disponible,
    id: row.id,
    name: row.name,
    price: row.precio_venta ?? 0,
    slug: row.slug,
    sourceKey: row.source_key,
    subgrupo: row.subgrupo ?? '',
    type: row.tipo,
  };
}

function mapPosTableRow(row: PosTableRow): PosTable {
  return {
    activeOrderId: row.active_order_id,
    assignedStaffEmail: row.assigned_staff_email,
    capacity: row.capacity,
    code: row.code,
    createdAt: row.created_at,
    id: row.id,
    name: row.name,
    notes: row.notes,
    status: row.status as PosTable['status'],
    type: row.type as PosTable['type'],
    updatedAt: row.updated_at,
    zone: row.zone as PosTable['zone'],
  };
}

function mapPosOrderRow(row: PosOrderRow): PosOrder {
  return {
    assignedStaffEmail: row.assigned_staff_email,
    cancellationReason: row.cancellation_reason,
    cashierEmail: row.cashier_email,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    financialStatus: row.financial_status as PosOrder['financialStatus'],
    id: row.id,
    notes: row.notes,
    openedAt: row.opened_at,
    openedByEmail: row.opened_by_email,
    salesSessionId: row.sales_session_id,
    tableCodeSnapshot: row.table_code_snapshot,
    tableId: row.table_id,
    tableNameSnapshot: row.table_name_snapshot,
    updatedAt: row.updated_at,
  };
}

function buildSalesSessionSummary(orders: PosOrderWithRelations[], payments: PosPayment[]): PosSalesSessionSummary {
  const activeOrders = orders.filter((order) => order.financialStatus !== 'cancelled' || order.items.some((item) => item.operationalStatus !== 'cancelled'));
  const productsByName = new Map<string, PosSalesSessionSummary['products'][number]>();

  for (const order of orders) {
    for (const item of order.items) {
      if (item.operationalStatus === 'cancelled' || item.financialStatus === 'cancelled') {
        continue;
      }

      const key = `${item.productName}::${item.prepArea}::${item.menuItemSourceKey ?? ''}`;
      const existing = productsByName.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.totalAmount += item.totalPrice;
      } else {
        productsByName.set(key, {
          menuItemSourceKey: item.menuItemSourceKey,
          prepArea: item.prepArea,
          productName: item.productName,
          quantity: item.quantity,
          totalAmount: item.totalPrice,
        });
      }
    }
  }

  const confirmedPayments = payments.filter((payment) => payment.status === 'confirmed');
  const paymentMethodMap = new Map<string, PosSalesSessionSummary['paymentMethods'][number]>();
  for (const payment of confirmedPayments) {
    const existing = paymentMethodMap.get(payment.method);
    if (existing) {
      existing.paymentCount += 1;
      existing.totalAmount += payment.amountApplied;
    } else {
      paymentMethodMap.set(payment.method, {
        method: payment.method,
        paymentCount: 1,
        totalAmount: payment.amountApplied,
      });
    }
  }

  const grossSales = orders.reduce((sum, order) => sum + order.summary.totalDue, 0);
  const totalCollected = confirmedPayments.reduce((sum, payment) => sum + payment.amountApplied, 0);
  const pendingBalance = orders.reduce((sum, order) => sum + order.summary.remainingBalance, 0);
  const pendingPayments = payments.filter((payment) => payment.status === 'pending').length;
  const deliveredProducts = orders.reduce(
    (sum, order) => sum + order.items.filter((item) => item.operationalStatus === 'delivered').reduce((itemSum, item) => itemSum + item.quantity, 0),
    0,
  );

  return {
    confirmedPayments: confirmedPayments.length,
    deliveredProducts,
    grossSales,
    openOrders: orders.filter((order) => order.closedAt == null).length,
    orderCount: activeOrders.length,
    paymentMethods: Array.from(paymentMethodMap.values()).sort((left, right) => right.totalAmount - left.totalAmount),
    pendingBalance,
    pendingPayments,
    products: Array.from(productsByName.values()).sort((left, right) => right.quantity - left.quantity || right.totalAmount - left.totalAmount),
    totalCollected,
  };
}

export function mapPosRealtimeOrderItem(record: Record<string, unknown> | null): PosOrderItem | null {
  if (!record) {
    return null;
  }
  const requiredStrings = ['id', 'order_id', 'product_name', 'product_slug', 'created_by_email'];
  const nullableStrings = [
    'menu_item_source_key', 'replacement_for_item_id', 'updated_by_email', 'picking_up_by_email',
    'delivered_by_email', 'cancelled_by_email', 'cancellation_reason',
  ];
  const nullableDates = ['sent_at', 'preparation_started_at', 'ready_at', 'picking_up_at', 'delivered_at', 'cancelled_at'];
  const isDate = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const isMoney = (value: unknown) =>
    (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
    Number.isFinite(Number(value)) && Number(value) >= 0;

  if (
    !requiredStrings.every((key) => typeof record[key] === 'string' && (record[key] as string).trim() !== '') ||
    !nullableStrings.every((key) => record[key] === null || typeof record[key] === 'string') ||
    !nullableDates.every((key) => record[key] === null || isDate(record[key])) ||
    !isDate(record.created_at) || !isDate(record.updated_at) || typeof record.notes !== 'string' ||
    typeof record.quantity !== 'number' || !Number.isInteger(record.quantity) || record.quantity <= 0 ||
    typeof record.service_round !== 'number' || !Number.isInteger(record.service_round) || record.service_round <= 0 ||
    !isMoney(record.unit_price) || !isMoney(record.total_price) ||
    !['kitchen', 'bar'].includes(record.prep_area as string) ||
    !['draft', 'sent', 'pending_preparation', 'in_process', 'ready', 'picking_up', 'delivered', 'cancelled'].includes(record.operational_status as string) ||
    !['pending_payment', 'partially_paid', 'paid_total', 'cancelled'].includes(record.financial_status as string)
  ) {
    return null;
  }
  return mapPosOrderItemRow(record as unknown as PosOrderItemRow);
}

export function mapPosRealtimeLog(record: Record<string, unknown> | null): PosOrderStatusLog | null {
  if (!record ||
    !['id', 'event_type', 'actor_email'].every((key) => typeof record[key] === 'string' && (record[key] as string).trim() !== '') ||
    typeof record.created_at !== 'string' || !Number.isFinite(Date.parse(record.created_at)) ||
    !['order_id', 'order_item_id', 'table_id', 'actor_role', 'notes'].every((key) => record[key] === null || typeof record[key] === 'string') ||
    !['before_data', 'after_data'].every((key) => record[key] === null || (typeof record[key] === 'object' && record[key] != null))
  ) {
    return null;
  }
  return mapPosLogRow(record as unknown as PosLogRow);
}

function mapPosOrderItemRow(row: PosOrderItemRow): PosOrderItem {
  return {
    cancellationReason: row.cancellation_reason,
    cancelledAt: row.cancelled_at,
    cancelledByEmail: row.cancelled_by_email,
    createdAt: row.created_at,
    createdByEmail: row.created_by_email,
    deliveredAt: row.delivered_at,
    deliveredByEmail: row.delivered_by_email,
    financialStatus: row.financial_status as PosOrderItem['financialStatus'],
    id: row.id,
    menuItemSourceKey: row.menu_item_source_key,
    notes: row.notes,
    operationalStatus: row.operational_status as PosOrderItem['operationalStatus'],
    orderId: row.order_id,
    pickingUpAt: row.picking_up_at,
    pickingUpByEmail: row.picking_up_by_email,
    prepArea: row.prep_area as PreparationArea,
    preparationStartedAt: row.preparation_started_at,
    productName: row.product_name,
    productSlug: row.product_slug,
    quantity: row.quantity,
    readyAt: row.ready_at,
    replacementForItemId: row.replacement_for_item_id,
    sentAt: row.sent_at,
    serviceRound: row.service_round,
    totalPrice: Number(row.total_price),
    unitPrice: Number(row.unit_price),
    updatedAt: row.updated_at,
    updatedByEmail: row.updated_by_email,
  };
}

function mapPosPaymentRow(row: PosPaymentRow): PosPayment {
  return {
    allocationMode: row.allocation_mode as PaymentAllocationMode,
    amountApplied: Number(row.amount_applied),
    amountReceived: row.amount_received == null ? null : Number(row.amount_received),
    changeDue: row.change_due == null ? null : Number(row.change_due),
    confirmedAt: row.confirmed_at,
    confirmedByEmail: row.confirmed_by_email,
    createdAt: row.created_at,
    createdByEmail: row.created_by_email,
    id: row.id,
    method: row.method as PaymentMethod,
    notes: row.notes,
    orderId: row.order_id,
    percentageApplied: row.percentage_applied == null ? null : Number(row.percentage_applied),
    reference: row.reference,
    rejectedAt: row.rejected_at,
    rejectedByEmail: row.rejected_by_email,
    rejectionReason: row.rejection_reason,
    salesSessionId: row.sales_session_id,
    status: row.status as PaymentStatus,
    targetItemIds: Array.isArray(row.target_item_ids) ? row.target_item_ids.filter((entry): entry is string => typeof entry === 'string') : [],
  };
}

function mapPosSalesSessionRow(row: PosSalesSessionRow): PosSalesSession {
  return {
    businessDate: row.business_date,
    closedAt: row.closed_at,
    closedByEmail: row.closed_by_email,
    createdAt: row.created_at,
    cutoffHour: row.cutoff_hour,
    id: row.id,
    notes: row.notes,
    openedAt: row.opened_at,
    openedByEmail: row.opened_by_email,
    sessionLabel: row.session_label,
    status: row.status as PosSalesSession['status'],
    summary: parseSalesSessionSummary(row.summary),
    updatedAt: row.updated_at,
  };
}

function mapPosLogRow(row: PosLogRow): PosOrderStatusLog {
  return {
    actorEmail: row.actor_email,
    actorRole: row.actor_role as StaffRole | null,
    afterData: row.after_data,
    beforeData: row.before_data,
    createdAt: row.created_at,
    eventType: row.event_type,
    id: row.id,
    notes: row.notes,
    orderId: row.order_id,
    orderItemId: row.order_item_id,
    tableId: row.table_id,
  };
}

function mapPosOperationalFlowSettingsRows(rows: PosOperationalFlowSettingsRow[]): PosOperationalFlowSettings {
  return rows.reduce<PosOperationalFlowSettings>(
    (settings, row) => {
      if (row.area !== 'bar' && row.area !== 'kitchen') {
        return settings;
      }

      return {
        ...settings,
        [row.area]: {
          useDirectDelivery: Boolean(row.use_direct_delivery),
          useInProcess: Boolean(row.use_in_process),
          usePickingUp: Boolean(row.use_picking_up),
        },
      };
    },
    {
      bar: { ...defaultPosOperationalFlowSettings.bar },
      kitchen: { ...defaultPosOperationalFlowSettings.kitchen },
    },
  );
}

function normalizeMoney(value: number | undefined) {
  if (value == null || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(Math.round(value), 0);
}

function slugifyForPos(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'producto-extra';
}

function parseSalesSessionSummary(value: Record<string, unknown> | null): PosSalesSessionSummary | null {
  if (!value || Object.keys(value).length === 0) {
    return null;
  }

  return value as unknown as PosSalesSessionSummary;
}

function deriveSalesBusinessDate(isoDateTime: string, cutoffHour: number) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    month: '2-digit',
    timeZone: 'America/Bogota',
    year: 'numeric',
  });
  const parts = formatter.formatToParts(new Date(isoDateTime));
  const pick = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '00';
  const year = Number(pick('year'));
  const month = Number(pick('month'));
  const day = Number(pick('day'));
  const hour = Number(pick('hour'));

  const localDate = new Date(Date.UTC(year, month - 1, day));
  if (hour < cutoffHour) {
    localDate.setUTCDate(localDate.getUTCDate() - 1);
  }

  return localDate.toISOString().slice(0, 10);
}

function throwIfError(error: { message: string } | null, fallbackMessage: string): asserts error is null {
  if (error) {
    throw new Error(`${fallbackMessage}: ${error.message}`);
  }
}
