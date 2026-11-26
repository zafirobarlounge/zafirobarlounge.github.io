export type TableStatus = 'available' | 'occupied' | 'reserved' | 'inactive';

export type TableType = 'fixed' | 'temporary';

export type TableZone = 'salon' | 'bar' | 'terrace' | 'vip' | 'other';

export type StaffRole = 'superadmin' | 'waiter' | 'kitchen' | 'bar' | 'cashier';

export type PreparationArea = 'kitchen' | 'bar';

export type OrderFinancialStatus = 'pending_payment' | 'partially_paid' | 'paid_total' | 'cancelled';

export type OrderOperationalStatus =
  | 'draft'
  | 'sent'
  | 'pending_preparation'
  | 'in_process'
  | 'ready'
  | 'picking_up'
  | 'delivered'
  | 'cancelled';

export type PaymentMethod = 'cash' | 'nequi' | 'bank_transfer' | 'card' | 'other';

export type PaymentStatus = 'pending' | 'confirmed' | 'rejected';

export type PaymentAllocationMode = 'total' | 'amount' | 'percentage' | 'items';

export type PosSalesSessionStatus = 'open' | 'closed';

export interface StaffProfile {
  email: string;
  fullName: string;
  isActive: boolean;
  roles: StaffRole[];
}

export interface PosTable {
  id: string;
  code: string;
  name: string;
  type: TableType;
  zone: TableZone;
  capacity?: number | null;
  status: TableStatus;
  assignedStaffEmail?: string | null;
  activeOrderId?: string | null;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PosOrderItem {
  id: string;
  orderId: string;
  tableId?: string | null;
  tableCode?: string | null;
  tableName?: string | null;
  menuItemSourceKey?: string | null;
  productName: string;
  productSlug: string;
  prepArea: PreparationArea;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  serviceRound: number;
  orderOpenedByEmail?: string | null;
  orderAssignedStaffEmail?: string | null;
  operationalStatus: OrderOperationalStatus;
  financialStatus: OrderFinancialStatus;
  notes?: string;
  replacementForItemId?: string | null;
  createdAt: string;
  createdByEmail: string;
  updatedAt: string;
  updatedByEmail?: string | null;
  sentAt?: string | null;
  preparationStartedAt?: string | null;
  readyAt?: string | null;
  pickingUpAt?: string | null;
  pickingUpByEmail?: string | null;
  deliveredAt?: string | null;
  deliveredByEmail?: string | null;
  cancelledAt?: string | null;
  cancelledByEmail?: string | null;
  cancellationReason?: string | null;
}

export interface PosPayment {
  id: string;
  orderId: string;
  salesSessionId?: string | null;
  method: PaymentMethod;
  status: PaymentStatus;
  allocationMode: PaymentAllocationMode;
  amountApplied: number;
  amountReceived?: number | null;
  changeDue?: number | null;
  percentageApplied?: number | null;
  targetItemIds?: string[];
  reference?: string | null;
  notes?: string | null;
  createdAt: string;
  createdByEmail: string;
  confirmedAt?: string | null;
  confirmedByEmail?: string | null;
  rejectedAt?: string | null;
  rejectedByEmail?: string | null;
  rejectionReason?: string | null;
}

export interface PosOrder {
  id: string;
  tableId?: string | null;
  tableCodeSnapshot?: string | null;
  tableNameSnapshot?: string | null;
  salesSessionId?: string | null;
  financialStatus: OrderFinancialStatus;
  openedAt: string;
  closedAt?: string | null;
  openedByEmail: string;
  assignedStaffEmail?: string | null;
  cashierEmail?: string | null;
  notes?: string | null;
  cancellationReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PosOrderComputedSummary {
  subtotal: number;
  totalDue: number;
  totalPaid: number;
  remainingBalance: number;
  pendingPayments: number;
  confirmedPayments: number;
}

export interface PosSalesSessionPaymentMethodSummary {
  method: PaymentMethod;
  paymentCount: number;
  totalAmount: number;
}

export interface PosSalesSessionProductSummary {
  menuItemSourceKey?: string | null;
  prepArea: PreparationArea;
  productName: string;
  quantity: number;
  totalAmount: number;
}

export interface PosSalesSessionSummary {
  confirmedPayments: number;
  deliveredProducts: number;
  grossSales: number;
  openOrders: number;
  orderCount: number;
  paymentMethods: PosSalesSessionPaymentMethodSummary[];
  pendingBalance: number;
  pendingPayments: number;
  products: PosSalesSessionProductSummary[];
  totalCollected: number;
}

export interface PosSalesSession {
  id: string;
  sessionLabel: string;
  businessDate: string;
  status: PosSalesSessionStatus;
  openedAt: string;
  openedByEmail: string;
  closedAt?: string | null;
  closedByEmail?: string | null;
  cutoffHour: number;
  notes: string;
  summary: PosSalesSessionSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface PosSalesSessionHistoryEntry extends PosSalesSession {
  adjustments?: SessionAdjustment[];
  originalSummary?: PosSalesSessionSummary | null;
  orderCount: number;
  paymentCount: number;
  totalCollected: number;
  totalSold: number;
}

export interface SessionAdjustment {
  sequence: number;
  request_id: string;
  actor: string;
  created_at: string;
  reason: string;
  action: 'move' | 'cancel' | 'window';
  session_id: string;
  destination_id: string | null;
  order_id: string | null;
  payload: Record<string, string>;
}

export interface PosOrderStatusLog {
  id: string;
  orderId?: string | null;
  orderItemId?: string | null;
  tableId?: string | null;
  eventType: string;
  actorEmail: string;
  actorRole?: StaffRole | null;
  createdAt: string;
  beforeData?: Record<string, unknown> | null;
  afterData?: Record<string, unknown> | null;
  notes?: string | null;
}

export interface PosOperationalFlowAreaSettings {
  useDirectDelivery: boolean;
  useInProcess: boolean;
  usePickingUp: boolean;
}

export type PosOperationalFlowSettings = Record<PreparationArea, PosOperationalFlowAreaSettings>;

export interface PosOrderWithRelations extends PosOrder {
  items: PosOrderItem[];
  payments: PosPayment[];
  summary: PosOrderComputedSummary;
}

export interface PosTableWithOrder extends PosTable {
  activeOrder: PosOrderWithRelations | null;
}

export interface PosState {
  generatedAt: string;
  roles: StaffRole[];
  staffProfile: StaffProfile | null;
  activeSalesSession: PosSalesSession | null;
  recentSalesSessions: PosSalesSession[];
  tables: PosTableWithOrder[];
  openOrders: PosOrderWithRelations[];
  closedSales: PosOrderWithRelations[];
  pendingPreparationKitchen: PosOrderItem[];
  pendingPreparationBar: PosOrderItem[];
  operationalFlowSettings: PosOperationalFlowSettings;
  pendingPayments: PosPayment[];
  logs: PosOrderStatusLog[];
}

export interface PosProductOption {
  id: string;
  slug: string;
  sourceKey: string;
  type: string;
  subgrupo: string;
  name: string;
  price: number;
  available: boolean;
}

export interface CreatePosTableInput {
  capacity?: number | null;
  code: string;
  name: string;
  notes?: string;
  type: TableType;
  zone: TableZone;
}

export interface AddOrderItemInput {
  menuItemSourceKey: string;
  notes?: string;
  productName: string;
  productSlug: string;
  productType: string;
  quantity: number;
  unitPrice: number;
}

export interface AddCustomOrderItemInput {
  notes?: string;
  prepArea: PreparationArea;
  productName: string;
  quantity: number;
  unitPrice: number;
}

export interface UpdateOrderItemInput {
  notes?: string;
  quantity?: number;
}

export interface RecordPaymentInput {
  amount?: number;
  amountReceived?: number;
  method: PaymentMethod;
  notes?: string;
  percentage?: number;
  reference?: string;
  targetItemIds?: string[];
}
