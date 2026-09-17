import type { ReactNode } from 'react';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, LayoutGrid, List } from 'lucide-react';
import { AdminLayout } from './AdminLayout';
import { useSupabaseAuth } from '../auth/SupabaseAuthProvider';
import type {
  AddCustomOrderItemInput,
  AddOrderItemInput,
  CreatePosTableInput,
  PaymentAllocationMode,
  PaymentMethod,
  PosOrderItem,
  PosOrderWithRelations,
  PosOperationalFlowSettings,
  PosPayment,
  PosProductOption,
  PosSalesSession,
  PosSalesSessionSummary,
  PosState,
  PosTable,
  PosTableWithOrder,
  StaffRole,
  UpdateOrderItemInput,
} from '../shared/operations/operations.types';
import {
  addItemsToTableInSupabase,
  addCustomItemToTableInSupabase,
  cancelOrderItemInSupabase,
  closeActiveSalesSessionInSupabase,
  createPosTableInSupabase,
  defaultPosOperationalFlowSettings,
  deletePosTableInSupabase,
  loadPosProductOptionsFromSupabase,
  loadPosStateFromSupabase,
  markOrderItemDirectDeliveredInSupabase,
  markOrderItemDeliveredInSupabase,
  markOrderItemPickingUpInSupabase,
  moveActiveOrderToTableInSupabase,
  openSalesSessionInSupabase,
  recordPosPaymentInSupabase,
  replaceOrderItemInSupabase,
  sendDraftItemsToPreparationInSupabase,
  subscribeToPosRealtime,
  type MovePosActiveOrderResult,
  transitionPreparationItemInSupabase,
  updateOrderItemInSupabase,
  updatePosPaymentStatusInSupabase,
  updatePosOperationalFlowSettingsInSupabase,
  voidProcessedOrderItemInSupabase,
  derivePreparationAreaFromProductType,
  type PosRealtimeEvent,
  POS_SYNC_DEBUG,
  mapPosRealtimeOrderItem,
  mapPosRealtimeLog,
  loadPosTableContextFromSupabase,
  loadClosedSalesForSessionFromSupabase,
  applyRealtimeEventToTableContext,
  isPosTableContextValid,
  type PosTableContext,
} from '../integrations/supabase/posOperationsRepository';

function logPosSync(message: string) {
  if (typeof POS_SYNC_DEBUG !== 'undefined' && POS_SYNC_DEBUG) {
    console.debug(`[POS SYNC] ${message} ts=${Date.now()}`);
  }
}

function nextPosSyncLoadId() {
  const counter = nextPosSyncLoadId as typeof nextPosSyncLoadId & { current?: number };
  counter.current = (counter.current ?? 0) + 1;
  return counter.current;
}

type WorkspaceTab = 'floor' | 'kitchen' | 'bar' | 'cashier';
type CashierRightPanel = 'summary' | 'previous_sessions' | 'validations' | 'movements';
type AddItemMode = 'menu' | 'extra';

const roleLabels: Record<StaffRole, string> = {
  superadmin: 'Superadmin',
  waiter: 'Mesero',
  kitchen: 'Cocina',
  bar: 'Bar',
  cashier: 'Caja',
};

const workspaceLabels: Record<WorkspaceTab, string> = {
  floor: 'Mesas',
  kitchen: 'Cocina',
  bar: 'Bar',
  cashier: 'Caja',
};

const tableStatusLabels: Record<PosTableWithOrder['status'], string> = {
  available: 'Disponible',
  occupied: 'Ocupada',
  reserved: 'Reservada',
  inactive: 'Inactiva',
};

const itemStatusLabels: Record<PosOrderItem['operationalStatus'], string> = {
  draft: 'Borrador',
  sent: 'Enviado',
  pending_preparation: 'Pendiente',
  in_process: 'En proceso',
  ready: 'Listo',
  picking_up: 'Recogiendo',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
};

const financialStatusLabels: Record<PosOrderWithRelations['financialStatus'], string> = {
  pending_payment: 'Pendiente de pago',
  partially_paid: 'Abono parcial',
  paid_total: 'Pagado total',
  cancelled: 'Cancelada',
};

const paymentMethodLabels: Record<PaymentMethod, string> = {
  cash: 'Efectivo',
  nequi: 'Nequi',
  bank_transfer: 'Transferencia',
  card: 'Tarjeta',
  other: 'Otro',
};

const zoneOptions: CreatePosTableInput['zone'][] = ['salon', 'bar', 'terrace', 'vip', 'other'];
const typeOptions: CreatePosTableInput['type'][] = ['fixed', 'temporary'];

const emptyCreateTableForm: CreatePosTableInput = {
  capacity: 4,
  code: '',
  name: '',
  notes: '',
  type: 'fixed',
  zone: 'salon',
};

export function AdminPosView() {
  const { hasRole, isCatalogAdmin, staffProfile, staffRoles, user } = useSupabaseAuth();
  const actor = useMemo(
    () => ({
      email: user?.email?.trim().toLowerCase() ?? staffProfile?.email ?? '',
      roles: Array.from(new Set<StaffRole>([(isCatalogAdmin ? 'superadmin' : null), ...staffRoles].filter(Boolean) as StaffRole[])),
    }),
    [isCatalogAdmin, staffProfile?.email, staffRoles, user?.email],
  );
  const canOperateFloor = actor.roles.includes('superadmin') || hasRole('waiter');
  const canOperateKitchen = actor.roles.includes('superadmin') || hasRole('kitchen');
  const canOperateBar = actor.roles.includes('superadmin') || hasRole('bar');
  const canOperateCashier = actor.roles.includes('superadmin') || hasRole('cashier');
  const shouldShowTableSummary = actor.roles.includes('superadmin') || canOperateCashier;
  const shouldShowFloorSidebar = actor.roles.includes('superadmin') || canOperateCashier;
  const showFinancialBadgeInProducts = actor.roles.includes('superadmin') || canOperateCashier;
  const showMetricsOverview = actor.roles.includes('superadmin') || canOperateCashier;
  const showPreparationMetrics = actor.roles.includes('superadmin') || canOperateKitchen || canOperateBar;
  const showFloorMetrics = actor.roles.includes('superadmin') || canOperateFloor;

  const workspaceTabs = useMemo<WorkspaceTab[]>(
    () =>
      [
        canOperateFloor ? 'floor' : null,
        canOperateKitchen ? 'kitchen' : null,
        canOperateBar ? 'bar' : null,
        canOperateCashier ? 'cashier' : null,
      ].filter((tab): tab is WorkspaceTab => tab != null),
    [canOperateBar, canOperateCashier, canOperateFloor, canOperateKitchen],
  );

  const [activeTab, setActiveTab] = useState<WorkspaceTab>(() => workspaceTabs[0] ?? 'floor');
  const [floorTableLayout, setFloorTableLayout] = useState<'list' | 'grid'>(() => {
    try {
      return window.localStorage.getItem('zafiro.pos.table-layout') === 'grid' ? 'grid' : 'list';
    } catch {
      return 'list';
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('zafiro.pos.table-layout', floorTableLayout);
    } catch {
      // The layout remains usable when browser storage is unavailable.
    }
  }, [floorTableLayout]);
  const [posState, setPosState] = useState<PosState | null>(null);
  const [salesSessionAlertTime, setSalesSessionAlertTime] = useState(() => Date.now());
  useEffect(() => {
    const refreshAlertTime = () => setSalesSessionAlertTime(Date.now());
    const alertTimer = window.setInterval(refreshAlertTime, 60000);
    window.addEventListener('focus', refreshAlertTime);
    return () => {
      window.clearInterval(alertTimer);
      window.removeEventListener('focus', refreshAlertTime);
    };
  }, []);
  const overdueSalesSession = posState?.activeSalesSession && isSalesSessionPastClosingCutoff(posState.activeSalesSession, salesSessionAlertTime)
    ? posState.activeSalesSession
    : null;
  const [products, setProducts] = useState<PosProductOption[]>([]);
  const [selectedTableId, setSelectedTableIdState] = useState<string | null>(null);
  const selectedTableIdRef = useRef<string | null>(null);
  const [isTableSheetOpen, setIsTableSheetOpen] = useState(false);
  const [isCloseDraftWarningOpen, setIsCloseDraftWarningOpen] = useState(false);
  const [isMoveTableModalOpen, setIsMoveTableModalOpen] = useState(false);
  const [isMetricsCompactOpen, setIsMetricsCompactOpen] = useState(false);
  const [moveDestinationTableId, setMoveDestinationTableId] = useState('');
  const [addItemMode, setAddItemMode] = useState<AddItemMode>('menu');
  const [productSearch, setProductSearch] = useState('');
  const [selectedProductSourceKey, setSelectedProductSourceKey] = useState('');
  const [lineQuantity, setLineQuantity] = useState('1');
  const [lineNotes, setLineNotes] = useState('');
  const [customItemName, setCustomItemName] = useState('');
  const [customItemPrepArea, setCustomItemPrepArea] = useState<AddCustomOrderItemInput['prepArea']>('bar');
  const [customItemUnitPrice, setCustomItemUnitPrice] = useState('');
  const [replaceTargetItemId, setReplaceTargetItemId] = useState<string | null>(null);
  const [replaceReason, setReplaceReason] = useState('');
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editingQuantity, setEditingQuantity] = useState('1');
  const [editingNotes, setEditingNotes] = useState('');
  const [createTableForm, setCreateTableForm] = useState<CreatePosTableInput>(emptyCreateTableForm);
  const [paymentMode, setPaymentMode] = useState<PaymentAllocationMode>('total');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentPercentage, setPaymentPercentage] = useState('');
  const [paymentReceived, setPaymentReceived] = useState('');
  const [activePaymentField, setActivePaymentField] = useState<'amount' | 'percentage' | 'received' | null>(null);
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [salesSessionClosingNotes, setSalesSessionClosingNotes] = useState('');
  const [salesSessionOpeningNotes, setSalesSessionOpeningNotes] = useState('');
  const [selectedPaymentItemIds, setSelectedPaymentItemIds] = useState<string[]>([]);
  const [cashierRightPanel, setCashierRightPanel] = useState<CashierRightPanel>('summary');
  const [selectedDetachedCashierOrderId, setSelectedDetachedCashierOrderId] = useState<string | null>(null);
  const [selectedHistoricalSessionId, setSelectedHistoricalSessionId] = useState<string | null>(null);
  const [historicalSessionDetail, setHistoricalSessionDetail] = useState<{
    sessionId: string | null; orders: PosOrderWithRelations[]; loading: boolean; error: string | null;
  }>({ sessionId: null, orders: [], loading: false, error: null });
  const [historicalSessionRetry, setHistoricalSessionRetry] = useState(0);
  const [expandedTraceLogIds, setExpandedTraceLogIds] = useState<string[]>([]);
  const [highlightedPendingPaymentId, setHighlightedPendingPaymentId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [notificationRevision, setNotificationRevision] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [floatingActionToast, setFloatingActionToast] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const currentBusyActionIdRef = useRef(0);
  const [savingOperationalFlowArea, setSavingOperationalFlowArea] = useState<PosOrderItem['prepArea'] | null>(null);
  const [highlightedOrderItemId, setHighlightedOrderItemId] = useState<string | null>(null);
  const realtimeTimerRef = useRef<number | null>(null);
  const trailingSyncTimerRef = useRef<number | null>(null);
  const suppressAutoSyncUntilRef = useRef(0);
  const loadStateRef = useRef<(initial?: boolean, reason?: string) => Promise<void>>(async () => {});
  const historicalSessionHeaderRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const cashierPaymentPanelRef = useRef<HTMLDivElement | null>(null);
  const floorWorkspacePanelRef = useRef<HTMLDivElement | null>(null);
  const mobileTableSheetHeaderRef = useRef<HTMLDivElement | null>(null);
  const tableButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const closeTableSheetFocusRef = useRef(false);
  const addItemFormRef = useRef<HTMLDivElement | null>(null);
  const pendingPaymentCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const orderItemCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const pendingOrderItemFocusRef = useRef<string | null>(null);
  const shouldFocusReplacementFormRef = useRef(false);
  const shouldFocusCashierPaymentPanelRef = useRef(false);
  const shouldFocusFloorWorkspacePanelRef = useRef(false);
  const posStateRef = useRef<PosState | null>(null);
  const [tableContext, setTableContext] = useState<PosTableContext | null>(null);
  const tableContextRef = useRef<PosTableContext | null>(null);
  const tableContextRequestRef = useRef(0);
  const [tableContextRevision, setTableContextRevision] = useState(0);
  const [isSavingLineItem, setIsSavingLineItem] = useState(false);
  const savingLineItemRef = useRef(false);
  const tableContextEventsRef = useRef<PosRealtimeEvent[]>([]);
  const activeTabRef = useRef<WorkspaceTab>('floor');
  const actorRef = useRef(actor);
  const workspaceAccessRef = useRef({
    canOperateBar,
    canOperateCashier,
    canOperateFloor,
    canOperateKitchen,
  });
  const audioContextRef = useRef<AudioContext | null>(null);
  const recentRealtimeNotificationKeysRef = useRef<Map<string, number>>(new Map());
  const deferredProductSearch = useDeferredValue(productSearch);

  const shouldSuppressBackgroundSync = () => Date.now() < suppressAutoSyncUntilRef.current;

  const invalidateTableContext = () => {
    tableContextRequestRef.current += 1;
    tableContextRef.current = null;
    setTableContext(null);
    setTableContextRevision((revision) => revision + 1);
  };

  const setSelectedTableId = (value: string | null | ((current: string | null) => string | null)) => {
    const nextId = typeof value === 'function' ? value(selectedTableIdRef.current) : value;
    if (nextId !== selectedTableIdRef.current) {
      selectedTableIdRef.current = nextId;
      invalidateTableContext();
    }
    setSelectedTableIdState(nextId);
  };

  const updateTableContextFromRealtime = (event: PosRealtimeEvent) => {
    if (savingLineItemRef.current) {
      tableContextEventsRef.current.push(event);
      return;
    }
    const current = tableContextRef.current;
    if (current && current.tableId !== selectedTableIdRef.current) {
      invalidateTableContext();
      return;
    }
    if (!current) {
      if (event.table !== 'pos_order_status_logs') invalidateTableContext();
      return;
    }
    const next = applyRealtimeEventToTableContext(current, event);
    if (!next) {
      invalidateTableContext();
    } else if (next !== current) {
      tableContextRef.current = next;
      setTableContext(next);
    }
  };

  const scheduleTrailingSync = (delay = 960) => {
    logPosSync(`trailing schedule reason=trailing-sync delay=${delay}ms replace=${trailingSyncTimerRef.current != null}`);
    if (trailingSyncTimerRef.current != null) {
      window.clearTimeout(trailingSyncTimerRef.current);
    }

    trailingSyncTimerRef.current = window.setTimeout(() => {
      logPosSync('trailing fire reason=trailing-sync');
      suppressAutoSyncUntilRef.current = 0;
      void loadStateRef.current(false, 'trailing-sync');
    }, delay);
  };

  const markLocalMutationCommitted = () => {
    suppressAutoSyncUntilRef.current = Date.now() + 220;
    logPosSync('local mutation committed reason=local-mutation suppression=220ms trailing=320ms');
    scheduleTrailingSync(320);
  };

  const resetReplacementMode = () => {
    shouldFocusReplacementFormRef.current = false;
    setReplaceTargetItemId(null);
    setReplaceReason('');
  };

  useEffect(() => {
    posStateRef.current = posState;
  }, [posState]);

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    actorRef.current = actor;
  }, [actor]);

  useEffect(() => {
    workspaceAccessRef.current = {
      canOperateBar,
      canOperateCashier,
      canOperateFloor,
      canOperateKitchen,
    };
  }, [canOperateBar, canOperateCashier, canOperateFloor, canOperateKitchen]);

  useEffect(() => {
    const shouldLockPageScroll = isTableSheetOpen || isMoveTableModalOpen;

    if (!shouldLockPageScroll || typeof window === 'undefined') {
      return;
    }

    const isIos = /iP(ad|hone|od)/.test(window.navigator.platform) ||
      (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
    const scrollY = window.scrollY;
    const previousBodyStyles = {
      height: document.body.style.height,
      overflow: document.body.style.overflow,
      paddingRight: document.body.style.paddingRight,
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
    };
    const previousDocumentStyles = {
      height: document.documentElement.style.height,
      overflow: document.documentElement.style.overflow,
      overscrollBehavior: document.documentElement.style.overscrollBehavior,
    };
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    document.documentElement.style.height = '100%';
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.overscrollBehavior = 'none';
    document.body.style.height = '100%';
    document.body.style.overflow = 'hidden';

    if (!isIos) {
      document.body.style.position = 'fixed';
      document.body.style.top = `-${scrollY}px`;
      document.body.style.width = '100%';
    }

    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    return () => {
      document.documentElement.style.height = previousDocumentStyles.height;
      document.documentElement.style.overflow = previousDocumentStyles.overflow;
      document.documentElement.style.overscrollBehavior = previousDocumentStyles.overscrollBehavior;
      document.body.style.height = previousBodyStyles.height;
      document.body.style.overflow = previousBodyStyles.overflow;
      document.body.style.paddingRight = previousBodyStyles.paddingRight;
      document.body.style.position = previousBodyStyles.position;
      document.body.style.top = previousBodyStyles.top;
      document.body.style.width = previousBodyStyles.width;
      if (!isIos) {
        window.scrollTo(0, scrollY);
      }
    };
  }, [isMoveTableModalOpen, isTableSheetOpen]);

  useEffect(() => {
    const unlockAudioAndNotifications = () => {
      if (typeof window !== 'undefined' && 'AudioContext' in window) {
        const AudioContextCtor = window.AudioContext;
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContextCtor();
        }

        if (audioContextRef.current.state === 'suspended') {
          void audioContextRef.current.resume().catch(() => {});
        }
      }

      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission().catch(() => {});
      }
    };

    window.addEventListener('pointerdown', unlockAudioAndNotifications, { once: true });
    return () => window.removeEventListener('pointerdown', unlockAudioAndNotifications);
  }, []);

  useEffect(() => {
    if (!workspaceTabs.length) {
      return;
    }

    if (!workspaceTabs.includes(activeTab)) {
      setActiveTab(workspaceTabs[0]);
    }
  }, [activeTab, workspaceTabs]);

  useEffect(() => {
    let isMounted = true;

    const loadProducts = async () => {
      if (!canOperateFloor) {
        if (isMounted) {
          setProducts([]);
          setSelectedProductSourceKey('');
        }
        return;
      }

      const nextProducts = await loadPosProductOptionsFromSupabase();
      if (isMounted) {
        setProducts(nextProducts);
        if (!selectedProductSourceKey && nextProducts[0]) {
          setSelectedProductSourceKey(nextProducts[0].sourceKey);
        }
      }
    };

    void loadProducts().catch((error: unknown) => {
      if (isMounted) {
        setErrorMessage(error instanceof Error ? error.message : 'No fue posible cargar los productos operativos.');
      }
    });

    return () => {
      isMounted = false;
    };
  }, [canOperateFloor, selectedProductSourceKey]);

  useEffect(() => {
    let isMounted = true;
    let pendingLoad: Promise<void> | null = null;
    let reloadRequested = false;
    let eventsDuringLoad: PosRealtimeEvent[] = [];
    let activeLoadId: number | null = null;
    let latestRealtimeReason = 'realtime';
    let scheduledReason: string | null = null;
    const pendingReasons = new Set<string>();
    let pendingReloadEvents: PosRealtimeEvent[] = [];
    let reloadEventsDuringLoad: PosRealtimeEvent[] = [];
    let nonRealtimeReloadRequested = false;
    let latestRealtimeEvent: PosRealtimeEvent | undefined;
    logPosSync('effect mount reason=initial');

    const handleRealtimeEvent = (event: PosRealtimeEvent) => {
      const eventId = event.newRecord?.id ?? event.oldRecord?.id ?? '-';
      logPosSync(`handleRealtimeEvent table=${event.table} event=${event.eventType} id=${eventId} loadId=${activeLoadId ?? '-'} pending=${pendingLoad != null}`);
      if (!isMounted) {
        logPosSync(`handleRealtimeEvent ignored reason=unmounted table=${event.table} event=${event.eventType} id=${eventId}`);
        return false;
      }
      updateTableContextFromRealtime(event);
      if (pendingLoad) {
        eventsDuringLoad.push(event);
        logPosSync(`eventsDuringLoad buffered loadId=${activeLoadId} table=${event.table} event=${event.eventType} id=${eventId} count=${eventsDuringLoad.length}`);
      }
      const currentState = posStateRef.current;
      setPosState((current) => (current ? applyRealtimeEventToPosState(current, event) : current));

      const realtimeSignal = resolveRealtimeSignal(event, currentState, actorRef.current.email);

      if (realtimeSignal) {
        const access = workspaceAccessRef.current;
        const shouldNotify =
          (realtimeSignal.target === 'kitchen' && access.canOperateKitchen) ||
          (realtimeSignal.target === 'bar' && access.canOperateBar) ||
          (realtimeSignal.target === 'floor' && access.canOperateFloor) ||
          (realtimeSignal.target === 'cashier' && access.canOperateCashier);

        if (shouldNotify) {
          triggerRealtimeAttention(
            realtimeSignal,
            audioContextRef.current,
            recentRealtimeNotificationKeysRef.current,
          );
        }
      }

      const shouldReload = shouldReloadAfterRealtimeEvent(event, currentState);
      if (pendingLoad && shouldReload) {
        reloadEventsDuringLoad.push(event);
      }
      latestRealtimeReason = `realtime:${event.table}:${event.eventType}`;
      latestRealtimeEvent = event;
      logPosSync(`shouldReloadAfterRealtimeEvent table=${event.table} event=${event.eventType} id=${eventId} reload=${shouldReload} loadId=${activeLoadId ?? '-'}`);
      return shouldReload;
    };

    const loadState = (initial = false, reason = initial ? 'initial' : 'unspecified', event?: PosRealtimeEvent): Promise<void> => {
      logPosSync(`loadState called reason=${reason} loadId=${activeLoadId ?? '-'} pending=${pendingLoad != null} reloadRequested=${reloadRequested}`);
      if (!isMounted) {
        logPosSync(`loadState ignored reason=${reason} unmounted=true`);
        return Promise.resolve();
      }
      if (pendingLoad) {
        pendingReasons.add(reason);
        if (event) {
          pendingReloadEvents.push(event);
        } else {
          nonRealtimeReloadRequested = true;
        }
        reloadRequested = true;
        logPosSync(`load already pending loadId=${activeLoadId} reason=${reason} -> reloadRequested=true`);
        return pendingLoad;
      }

      pendingLoad = (async () => {
        let pass = 0;
        if (initial) {
          setIsLoading(true);
        }

        do {
          const loadId = nextPosSyncLoadId();
          activeLoadId = loadId;
          const passReason = pass++ === 0 ? reason : 'pending-reload';
          const triggers = Array.from(pendingReasons).join(',') || reason;
          pendingReasons.clear();
          const startedAt = Date.now();
          let outcome = 'success';
          logPosSync(`load #${loadId} start reason=${passReason} triggers=${triggers} pass=${pass} reloadRequested=${reloadRequested}`);
          reloadRequested = false;
          pendingReloadEvents = [];
          reloadEventsDuringLoad = [];
          nonRealtimeReloadRequested = false;
          eventsDuringLoad = [];
          logPosSync(`load #${loadId} reset reloadRequested=false eventsDuringLoad=0`);
          try {
            logPosSync(`load #${loadId} loadPosStateFromSupabase reason=${passReason}`);
            const nextState = await loadPosStateFromSupabase({
              includeLogs: actorRef.current.roles.includes('superadmin') || workspaceAccessRef.current.canOperateCashier,
            });
            if (!isMounted) {
              outcome = 'ignored-unmounted';
              return;
            }

            // Keep changes received after the snapshot request started.
            logPosSync(`load #${loadId} eventsDuringLoad replay count=${eventsDuringLoad.length}`);
            const syncedState = eventsDuringLoad.reduce(applyRealtimeEventToPosState, nextState);
            // Only cancel event-driven retries proven covered by the snapshot and replay.
            if (reloadRequested && !nonRealtimeReloadRequested && !eventsDuringLoad.some((event) => event.eventType === 'DELETE')) {
              const reloadEvents = [...pendingReloadEvents, ...reloadEventsDuringLoad];
              reloadRequested = reloadEvents.some((event) => stillRequiresPendingRealtimeReload(event, syncedState));
              logPosSync(`load #${loadId} pending-reload reevaluated events=${reloadEvents.length} reloadRequested=${reloadRequested}`);
              if (!reloadRequested) {
                pendingReasons.clear();
              }
            }
            eventsDuringLoad = [];
            setPosState(syncedState);
            const currentContext = tableContextRef.current;
            if (!savingLineItemRef.current && currentContext) {
              const table = syncedState.tables.find((entry) => entry.id === currentContext.table.id);
              const nextContext = table ? {
                tableId: table.id, table, order: table.activeOrder, items: table.activeOrder?.items ?? [], salesSession: syncedState.activeSalesSession,
              } : null;
              if (nextContext && nextContext.tableId === selectedTableIdRef.current && isPosTableContextValid(nextContext, currentContext.tableId) &&
                nextContext.order?.id === currentContext.order?.id) {
                tableContextRef.current = nextContext;
                setTableContext(nextContext);
              } else {
                invalidateTableContext();
              }
            }
            setSelectedTableId((current) => {
              if (current && nextState.tables.some((table) => table.id === current)) {
                return current;
              }

              return nextState.tables[0]?.id ?? null;
            });
          } catch (error) {
            outcome = 'error';
            if (isMounted) {
              setErrorMessage(error instanceof Error ? error.message : 'No fue posible cargar el estado POS.');
            }
          } finally {
            logPosSync(`load #${loadId} end reason=${passReason} outcome=${outcome} duration=${Date.now() - startedAt}ms reloadRequested=${reloadRequested} nextPass=${isMounted && reloadRequested}`);
          }
        } while (isMounted && reloadRequested);
      })().finally(() => {
        pendingLoad = null;
        logPosSync(`pendingLoad cleared loadId=${activeLoadId ?? '-'} reloadRequested=${reloadRequested}`);
        activeLoadId = null;
        if (isMounted && initial) {
          setIsLoading(false);
        }
      });
      return pendingLoad;
    };

    loadStateRef.current = (initial = false, reason = 'loadStateRef') => {
      logPosSync(`loadStateRef.current reason=${reason} loadId=${activeLoadId ?? '-'} pending=${pendingLoad != null}`);
      return loadState(initial, reason);
    };

    void loadState(true, 'initial');

    const scheduleBackgroundSync = (reason = latestRealtimeReason, event?: PosRealtimeEvent) => {
      if (!isMounted || shouldSuppressBackgroundSync()) {
        logPosSync(`scheduleBackgroundSync skipped reason=${reason} blocked=${!isMounted ? 'unmounted' : 'suppressed'} loadId=${activeLoadId ?? '-'}`);
        return;
      }

      if (realtimeTimerRef.current != null) {
        logPosSync(`scheduleBackgroundSync replace reason=${reason} previousReason=${scheduledReason ?? '-'} loadId=${activeLoadId ?? '-'}`);
        window.clearTimeout(realtimeTimerRef.current);
      }

      scheduledReason = reason;
      logPosSync(`scheduleBackgroundSync scheduled reason=${reason} delay=12ms loadId=${activeLoadId ?? '-'} pending=${pendingLoad != null}`);
      realtimeTimerRef.current = window.setTimeout(() => {
        realtimeTimerRef.current = null;
        scheduledReason = null;
        logPosSync(`scheduleBackgroundSync fire reason=${reason} loadId=${activeLoadId ?? '-'}`);
        void loadState(false, reason, event);
      }, 12);
    };

    const unsubscribe = subscribeToPosRealtime(() => scheduleBackgroundSync(latestRealtimeReason, latestRealtimeEvent), handleRealtimeEvent);

    const handleVisibilitySync = () => {
      logPosSync(`visibilitychange reason=visibility state=${document.visibilityState}`);
      if (document.visibilityState === 'visible' && !shouldSuppressBackgroundSync()) {
        invalidateTableContext();
        scheduleBackgroundSync('visibility');
      } else {
        logPosSync('visibilitychange skipped reason=visibility blocked=hidden-or-suppressed');
      }
    };

    const handleWindowFocus = () => {
      logPosSync(`focus reason=focus state=${document.visibilityState}`);
      if (document.visibilityState !== 'visible' || shouldSuppressBackgroundSync()) {
        logPosSync('focus skipped reason=focus blocked=hidden-or-suppressed');
        return;
      }

      scheduleBackgroundSync('focus');
      invalidateTableContext();
    };

    document.addEventListener('visibilitychange', handleVisibilitySync);
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      logPosSync(`effect cleanup reason=unmount loadId=${activeLoadId ?? '-'} pending=${pendingLoad != null}`);
      isMounted = false;
      loadStateRef.current = async () => {};
      if (realtimeTimerRef.current != null) {
        window.clearTimeout(realtimeTimerRef.current);
        realtimeTimerRef.current = null;
      }
      if (trailingSyncTimerRef.current != null) {
        window.clearTimeout(trailingSyncTimerRef.current);
        trailingSyncTimerRef.current = null;
      }
      document.removeEventListener('visibilitychange', handleVisibilitySync);
      window.removeEventListener('focus', handleWindowFocus);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!workspaceTabs.includes(activeTab)) {
      return;
    }

    const intervalMs = getPosFallbackSyncInterval(activeTab);
    if (intervalMs <= 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      logPosSync(`polling tick reason=polling:${activeTab} interval=${intervalMs}ms state=${document.visibilityState}`);
      if (shouldSuppressBackgroundSync()) {
        logPosSync(`polling skipped reason=polling:${activeTab} blocked=suppressed`);
        return;
      }

      if (document.visibilityState !== 'visible') {
        logPosSync(`polling skipped reason=polling:${activeTab} blocked=hidden`);
        return;
      }

      void loadStateRef.current(false, `polling:${activeTab}`);
    }, intervalMs);

    return () => window.clearInterval(intervalId);
  }, [activeTab, workspaceTabs]);

  const selectedTable = useMemo(
    () => posState?.tables.find((table) => table.id === selectedTableId) ?? posState?.tables[0] ?? null,
    [posState?.tables, selectedTableId],
  );
  const selectedOrder = selectedTable?.activeOrder ?? null;
  useEffect(() => {
    const requestId = ++tableContextRequestRef.current;
    tableContextRef.current = null;
    setTableContext(null);
    const tableId = selectedTableId;
    if (!tableId || selectedTable?.id !== tableId || activeTab !== 'floor' || savingLineItemRef.current) return;
    void loadPosTableContextFromSupabase(tableId).then((context) => {
      if (tableContextRequestRef.current !== requestId || selectedTableIdRef.current !== tableId ||
        !isPosTableContextValid(context, tableId)) return;
      tableContextRef.current = context;
      setTableContext(context);
    }).catch((error: unknown) => {
      if (tableContextRequestRef.current === requestId) {
        setErrorMessage(error instanceof Error ? error.message : 'No fue posible cargar la mesa.');
      }
    });
    return () => { tableContextRequestRef.current += 1; };
  }, [selectedTableId, selectedTable?.id, activeTab, isTableSheetOpen, tableContextRevision]);
  const filteredProducts = useMemo(() => {
    const term = deferredProductSearch.trim().toLowerCase();
    return products.filter((product) => {
      if (!term) {
        return true;
      }

      return [product.name, product.subgrupo, product.type, product.slug].some((value) => value.toLowerCase().includes(term));
    });
  }, [deferredProductSearch, products]);

  useEffect(() => {
    if (!filteredProducts.length) {
      return;
    }

    const currentStillVisible = filteredProducts.some((product) => product.sourceKey === selectedProductSourceKey);
    if (!currentStillVisible) {
      setSelectedProductSourceKey(filteredProducts[0].sourceKey);
    }
  }, [filteredProducts, selectedProductSourceKey]);

  const selectedProduct = useMemo(
    () => filteredProducts.find((product) => product.sourceKey === selectedProductSourceKey) ?? products.find((product) => product.sourceKey === selectedProductSourceKey) ?? null,
    [filteredProducts, products, selectedProductSourceKey],
  );
  const selectedOrderDraftItems = selectedOrder?.items.filter((item) => item.operationalStatus === 'draft') ?? [];
  const parsedLineQuantity = parseOptionalNumber(lineQuantity);
  const isLineQuantityValid = parsedLineQuantity != null && parsedLineQuantity > 0;
  const parsedCustomItemUnitPrice = parseOptionalNumber(customItemUnitPrice);
  const customItemNameValue = customItemName.trim();
  const isCustomItemUnitPriceValid = parsedCustomItemUnitPrice != null && parsedCustomItemUnitPrice > 0;
  const canSubmitLineItem =
    replaceTargetItemId
      ? Boolean(selectedProduct && isLineQuantityValid)
      : addItemMode === 'extra'
      ? Boolean(selectedTable && customItemNameValue && isLineQuantityValid && isCustomItemUnitPriceValid && !replaceTargetItemId)
      : Boolean(selectedProduct && isLineQuantityValid);
  const parsedEditingQuantity = parseOptionalNumber(editingQuantity);
  const isEditingQuantityValid = parsedEditingQuantity != null && parsedEditingQuantity > 0;
  const parsedCapacity = createTableForm.capacity ?? null;
  const isCapacityValid = parsedCapacity == null || parsedCapacity > 0;
  const closedSales = posState?.closedSales ?? [];
  const cashierTables = useMemo(
    () =>
      (posState?.tables ?? []).filter(
        (table) => table.activeOrder && (table.activeOrder.summary.remainingBalance > 0 || table.activeOrder.summary.pendingPayments > 0),
      ),
    [posState?.tables],
  );
  const activeTableOrderIds = useMemo(
    () => new Set((posState?.tables ?? []).flatMap((table) => (table.activeOrder ? [table.activeOrder.id] : []))),
    [posState?.tables],
  );
  const detachedCashierOrders = useMemo(
    () =>
      (posState?.openOrders ?? []).filter(
        (order) =>
          !activeTableOrderIds.has(order.id) &&
          (order.summary.remainingBalance > 0 || order.summary.pendingPayments > 0),
      ),
    [activeTableOrderIds, posState?.openOrders],
  );
  const selectedCashierTable = useMemo(
    () => (selectedDetachedCashierOrderId ? null : cashierTables.find((table) => table.id === selectedTableId) ?? cashierTables[0] ?? null),
    [cashierTables, selectedDetachedCashierOrderId, selectedTableId],
  );
  const floorTables = useMemo(() => {
    const tables = posState?.tables ?? [];

    return tables
      .map((table, index) => ({
        hasReadyItems: (table.activeOrder?.items.some((item) => item.operationalStatus === 'ready') ?? false),
        index,
        table,
      }))
      .sort((left, right) => {
        if (left.hasReadyItems !== right.hasReadyItems) {
          return left.hasReadyItems ? -1 : 1;
        }

        return left.index - right.index;
      })
      .map((entry) => entry.table);
  }, [posState?.tables]);
  const availableMoveDestinationTables = useMemo(
    () =>
      (posState?.tables ?? []).filter(
        (table) =>
          table.id !== selectedTable?.id &&
          table.status === 'available' &&
          !table.activeOrder &&
          !table.activeOrderId,
      ),
    [posState?.tables, selectedTable?.id],
  );
  const selectedDetachedCashierOrder = useMemo(
    () => (selectedDetachedCashierOrderId ? detachedCashierOrders.find((order) => order.id === selectedDetachedCashierOrderId) ?? null : null),
    [detachedCashierOrders, selectedDetachedCashierOrderId],
  );
  const selectedCashierOrder = selectedDetachedCashierOrder ?? selectedCashierTable?.activeOrder ?? null;
  const selectedCashierOrderTable = useMemo(
    () => (selectedCashierOrder ? (posState?.tables ?? []).find((table) => table.id === selectedCashierOrder.tableId) ?? null : null),
    [posState?.tables, selectedCashierOrder],
  );
  const selectedCashierTitle = selectedCashierOrder
    ? selectedDetachedCashierOrder
      ? `Cobro pendiente de ${selectedCashierOrderTable?.name ?? 'mesa sin vinculo'} · ${selectedCashierOrderTable?.code ?? 'sin codigo'}`
      : `Cobro de ${selectedCashierTable?.name ?? selectedCashierOrderTable?.name ?? 'mesa'} · ${selectedCashierTable?.code ?? selectedCashierOrderTable?.code ?? 'sin codigo'}`
    : 'Cobro de mesa';
  const outstandingByItem = useMemo(() => buildOutstandingByItem(selectedCashierOrder), [selectedCashierOrder]);
  const selectablePaymentUnits = useMemo(
    () => buildSelectablePaymentUnits(selectedCashierOrder, outstandingByItem),
    [outstandingByItem, selectedCashierOrder],
  );
  const cashierProductGroups = useMemo(() => buildCashierProductGroups(selectedCashierOrder), [selectedCashierOrder]);
  const canDeleteSelectedTable = Boolean(selectedTable && !selectedTable.activeOrder && !selectedTable.activeOrderId && selectedTable.status !== 'occupied');
  const canMoveSelectedOrder = Boolean(selectedTable?.activeOrder && (actor.roles.includes('superadmin') || actor.roles.includes('waiter')));
  const canVoidProcessedItems = actor.roles.includes('superadmin') || actor.roles.includes('cashier');
  const createTableName = createTableForm.name.trim();
  const createTableCode = createTableForm.code.trim().toUpperCase();
  const hasCreateTableText = Boolean(createTableForm.code || createTableForm.name);
  const canCreateTable = Boolean(createTableName && createTableCode && isCapacityValid && !busyAction);
  const paymentPreview = useMemo(() => {
    if (!selectedCashierOrder) {
      return { amountApplied: 0, changeDue: 0, overage: 0, selectedRawAmount: 0 };
    }

    const remaining = selectedCashierOrder.summary.remainingBalance;
    let amountApplied = remaining;
    let selectedRawAmount = remaining;
    if (paymentMode === 'amount') {
      amountApplied = parseNumber(paymentAmount);
      selectedRawAmount = amountApplied;
    } else if (paymentMode === 'percentage') {
      amountApplied = Math.max(Math.round((remaining * parseNumber(paymentPercentage)) / 100), 0);
      selectedRawAmount = amountApplied;
    } else if (paymentMode === 'items') {
      selectedRawAmount = selectablePaymentUnits
        .filter((unit) => selectedPaymentItemIds.includes(unit.unitKey))
        .reduce((sum, unit) => sum + unit.amount, 0);
      amountApplied = selectedRawAmount;
    }

    const overage = Math.max(selectedRawAmount - remaining, 0);
    amountApplied = Math.min(amountApplied, remaining);
    const amountReceived = parseNumber(paymentReceived);
    return {
      amountApplied,
      overage,
      selectedRawAmount,
      changeDue: paymentMethod === 'cash' ? Math.max(amountReceived - amountApplied, 0) : 0,
    };
  }, [paymentAmount, paymentMethod, paymentMode, paymentPercentage, paymentReceived, selectablePaymentUnits, selectedCashierOrder, selectedPaymentItemIds]);
  const parsedPaymentAmount = parseOptionalNumber(paymentAmount);
  const isPaymentAmountValid = paymentMode !== 'amount' || (parsedPaymentAmount != null && parsedPaymentAmount > 0);
  const parsedPaymentPercentage = parseOptionalNumber(paymentPercentage);
  const isPaymentPercentageValid = paymentMode !== 'percentage' || (parsedPaymentPercentage != null && parsedPaymentPercentage > 0 && parsedPaymentPercentage <= 100);
  const parsedPaymentReceived = parseOptionalNumber(paymentReceived);
  const requiresCashReceived = paymentMethod === 'cash';
  const isPaymentReceivedValid =
    !requiresCashReceived ||
    (parsedPaymentReceived != null && parsedPaymentReceived > 0 && parsedPaymentReceived >= paymentPreview.amountApplied);
  const isItemsPaymentSelectionValid = paymentMode !== 'items' || (selectedPaymentItemIds.length > 0 && paymentPreview.amountApplied > 0 && paymentPreview.overage <= 0);
  const selectedOrderHasPendingPayment = selectedCashierOrder?.payments.some((payment) => payment.status === 'pending') ?? false;
  const canSubmitPayment =
    Boolean(selectedCashierOrder) &&
    !busyAction &&
    !selectedOrderHasPendingPayment &&
    paymentPreview.amountApplied > 0 &&
    paymentPreview.overage <= 0 &&
    isPaymentAmountValid &&
    isPaymentPercentageValid &&
    isPaymentReceivedValid &&
    isItemsPaymentSelectionValid;

  const kitchenQueue = posState?.pendingPreparationKitchen ?? [];
  const barQueue = posState?.pendingPreparationBar ?? [];
  const operationalFlowSettings = posState?.operationalFlowSettings ?? defaultPosOperationalFlowSettings;
  const sortedKitchenQueue = useMemo(
    () => sortPreparationQueueForUi(kitchenQueue, operationalFlowSettings),
    [kitchenQueue, operationalFlowSettings],
  );
  const sortedBarQueue = useMemo(
    () => sortPreparationQueueForUi(barQueue, operationalFlowSettings),
    [barQueue, operationalFlowSettings],
  );
  const allCashierOrders = useMemo(() => [...(posState?.openOrders ?? []), ...closedSales], [closedSales, posState?.openOrders]);
  const selectedReadyCount = selectedOrder?.items.filter((item) => item.operationalStatus === 'ready').length ?? 0;
  const selectedPickingUpCount = selectedOrder?.items.filter((item) => item.operationalStatus === 'picking_up').length ?? 0;
  const selectedPendingDeliveryCount = selectedReadyCount + selectedPickingUpCount;
  const selectedPreparationCount =
    selectedOrder?.items.filter((item) => ['sent', 'pending_preparation', 'in_process'].includes(item.operationalStatus)).length ?? 0;
  const selectedReplacementTarget = useMemo(
    () => (replaceTargetItemId ? selectedOrder?.items.find((item) => item.id === replaceTargetItemId) ?? null : null),
    [replaceTargetItemId, selectedOrder?.items],
  );
  const selectedOrderVisibleItems = useMemo(() => {
    if (!selectedOrder) {
      return [] as PosOrderItem[];
    }

    const visibleItems = selectedOrder.items.filter((item) => item.operationalStatus !== 'cancelled');
    const itemsById = new Map(selectedOrder.items.map((item) => [item.id, item]));
    const priority: Record<PosOrderItem['operationalStatus'], number> = {
      draft: 0,
      ready: 1,
      picking_up: 2,
      in_process: 3,
      pending_preparation: 4,
      sent: 5,
      delivered: 6,
      cancelled: 7,
    };

    return [...visibleItems].sort((left, right) => {
      const byStatus = priority[left.operationalStatus] - priority[right.operationalStatus];
      if (byStatus !== 0) {
        return byStatus;
      }

      const byAnchor = resolveReplacementAnchorTimestamp(left, itemsById).localeCompare(resolveReplacementAnchorTimestamp(right, itemsById));
      if (byAnchor !== 0) {
        return -byAnchor;
      }

      return right.createdAt.localeCompare(left.createdAt);
    });
  }, [selectedOrder]);
  const activeSalesSessionSummary = useMemo(
    () => buildLiveSalesSessionSummary(posState?.activeSalesSession ?? null, allCashierOrders),
    [allCashierOrders, posState?.activeSalesSession],
  );
  const activeSalesSessionCashTotal = useMemo(
    () => activeSalesSessionSummary.paymentMethods.find((entry) => entry.method === 'cash')?.totalAmount ?? 0,
    [activeSalesSessionSummary.paymentMethods],
  );
  const activeSalesSessionTransferTotal = useMemo(
    () => activeSalesSessionSummary.paymentMethods
      .filter((entry) => entry.method !== 'cash')
      .reduce((sum, entry) => sum + entry.totalAmount, 0),
    [activeSalesSessionSummary.paymentMethods],
  );
  const ordersById = useMemo(() => new Map(allCashierOrders.map((order) => [order.id, order])), [allCashierOrders]);
  const tablesById = useMemo(() => new Map((posState?.tables ?? []).map((table) => [table.id, table])), [posState?.tables]);
  const activeSalesSessionOrders = useMemo(() => {
    if (!posState?.activeSalesSession) {
      return [] as PosOrderWithRelations[];
    }

    return allCashierOrders.filter((order) => order.salesSessionId === posState.activeSalesSession?.id);
  }, [allCashierOrders, posState?.activeSalesSession]);
  const previousClosedSessions = useMemo(
    () => (posState?.recentSalesSessions ?? []).filter((session) => session.status === 'closed').slice(0, 7),
    [posState?.recentSalesSessions],
  );
  const activeSalesSessionClosedSales = useMemo(
    () => activeSalesSessionOrders.filter((order) => order.closedAt != null).sort((left, right) => (right.closedAt ?? '').localeCompare(left.closedAt ?? '')),
    [activeSalesSessionOrders],
  );
  const activeSalesSessionPaidClosedSales = useMemo(
    () => activeSalesSessionClosedSales.filter(isPaidClosedSale),
    [activeSalesSessionClosedSales],
  );
  const selectedHistoricalSession = selectedHistoricalSessionId
    ? previousClosedSessions.find((session) => session.id === selectedHistoricalSessionId) ?? null
    : null;
  const selectedHistoricalSessionCashTotal = useMemo(
    () => selectedHistoricalSession?.summary?.paymentMethods.find((entry) => entry.method === 'cash')?.totalAmount ?? 0,
    [selectedHistoricalSession?.summary?.paymentMethods],
  );
  const selectedHistoricalSessionNonCashTotal = useMemo(
    () =>
      selectedHistoricalSession?.summary?.paymentMethods
        .filter((entry) => entry.method !== 'cash')
        .reduce((sum, entry) => sum + entry.totalAmount, 0) ?? 0,
    [selectedHistoricalSession?.summary?.paymentMethods],
  );
  const selectedHistoricalSessionSales = useMemo(
    () =>
      selectedHistoricalSession && historicalSessionDetail.sessionId === selectedHistoricalSession.id
        ? historicalSessionDetail.orders
            .filter(isPaidClosedSale)
            .sort((left, right) => (right.closedAt ?? right.updatedAt).localeCompare(left.closedAt ?? left.updatedAt))
        : [],
    [historicalSessionDetail, selectedHistoricalSession],
  );
  const isHistoricalSessionLoading = Boolean(selectedHistoricalSession &&
    (historicalSessionDetail.sessionId !== selectedHistoricalSession.id || historicalSessionDetail.loading));
  useEffect(() => {
    const historicalSessionId = selectedHistoricalSession?.id;
    if (activeTab !== 'cashier' || cashierRightPanel !== 'previous_sessions' || !historicalSessionId) return;
    let isCurrent = true;
    setHistoricalSessionDetail({ sessionId: historicalSessionId, orders: [], loading: true, error: null });
    void loadClosedSalesForSessionFromSupabase(historicalSessionId).then((orders) => {
      if (isCurrent) setHistoricalSessionDetail({ sessionId: historicalSessionId, orders, loading: false, error: null });
    }).catch((error: unknown) => {
      if (isCurrent) setHistoricalSessionDetail({
        sessionId: historicalSessionId, orders: [], loading: false,
        error: error instanceof Error ? error.message : 'No fue posible cargar las mesas de esta jornada.',
      });
    });
    return () => { isCurrent = false; };
  }, [activeTab, cashierRightPanel, selectedHistoricalSession?.id, historicalSessionRetry]);
  const sessionOpenTableCount = activeSalesSessionOrders.filter((order) => order.closedAt == null).length;
  const sessionClosedTableCount = activeSalesSessionClosedSales.length;

  useEffect(() => {
    if (!previousClosedSessions.length) {
      if (selectedHistoricalSessionId) {
        setSelectedHistoricalSessionId(null);
      }
      return;
    }

    if (selectedHistoricalSessionId && !previousClosedSessions.some((session) => session.id === selectedHistoricalSessionId)) {
      setSelectedHistoricalSessionId(previousClosedSessions[0].id);
    }
  }, [previousClosedSessions, selectedHistoricalSessionId]);

  useEffect(() => {
    if (cashierRightPanel !== 'previous_sessions' || !selectedHistoricalSessionId) {
      return;
    }

    const header = historicalSessionHeaderRefs.current[selectedHistoricalSessionId];
    if (!header) {
      return;
    }

    const focusAndReveal = window.requestAnimationFrame(() => {
      header.focus({ preventScroll: true });
      header.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    return () => window.cancelAnimationFrame(focusAndReveal);
  }, [cashierRightPanel, selectedHistoricalSessionId]);

  useEffect(() => {
    if (!shouldFocusCashierPaymentPanelRef.current || activeTab !== 'cashier' || !selectedTableId) {
      return;
    }

    shouldFocusCashierPaymentPanelRef.current = false;

    if (!window.matchMedia('(max-width: 1279px)').matches) {
      return;
    }

    const paymentPanel = cashierPaymentPanelRef.current;
    if (!paymentPanel) {
      return;
    }

    const focusAndReveal = window.requestAnimationFrame(() => {
      paymentPanel.focus({ preventScroll: true });
      paymentPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    return () => window.cancelAnimationFrame(focusAndReveal);
  }, [activeTab, selectedTableId]);

  useEffect(() => {
    if (!shouldFocusFloorWorkspacePanelRef.current || activeTab !== 'floor' || !selectedTableId) {
      return;
    }

    shouldFocusFloorWorkspacePanelRef.current = false;

    if (window.matchMedia('(max-width: 1279px)').matches) {
      return;
    }

    const workspacePanel = floorWorkspacePanelRef.current;
    if (!workspacePanel) {
      return;
    }

    const focusAndReveal = window.requestAnimationFrame(() => {
      workspacePanel.focus({ preventScroll: true });
      workspacePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    return () => window.cancelAnimationFrame(focusAndReveal);
  }, [activeTab, selectedTableId]);

  useEffect(() => {
    if (!shouldFocusFloorWorkspacePanelRef.current || activeTab !== 'floor' || !selectedTableId || !isTableSheetOpen) {
      return;
    }

    shouldFocusFloorWorkspacePanelRef.current = false;

    const mobileHeader = mobileTableSheetHeaderRef.current;
    if (!mobileHeader || !window.matchMedia('(max-width: 1279px)').matches) {
      return;
    }

    const focusAndReveal = window.requestAnimationFrame(() => {
      mobileHeader.focus({ preventScroll: true });
      mobileHeader.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    return () => window.cancelAnimationFrame(focusAndReveal);
  }, [activeTab, selectedTableId, isTableSheetOpen]);

  useEffect(() => {
    if (!closeTableSheetFocusRef.current || activeTab !== 'floor' || !selectedTableId || isTableSheetOpen) {
      return;
    }

    closeTableSheetFocusRef.current = false;

    const tableButton = tableButtonRefs.current[selectedTableId];
    if (!tableButton) {
      return;
    }

    const focusAndReveal = window.requestAnimationFrame(() => {
      tableButton.focus({ preventScroll: true });
      tableButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    return () => window.cancelAnimationFrame(focusAndReveal);
  }, [activeTab, selectedTableId, isTableSheetOpen]);

  useEffect(() => {
    if (cashierRightPanel !== 'validations' || !highlightedPendingPaymentId) {
      return;
    }

    const pendingCard = pendingPaymentCardRefs.current[highlightedPendingPaymentId];
    if (!pendingCard) {
      return;
    }

    const focusAndReveal = window.requestAnimationFrame(() => {
      pendingCard.focus({ preventScroll: true });
      pendingCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    return () => window.cancelAnimationFrame(focusAndReveal);
  }, [cashierRightPanel, highlightedPendingPaymentId]);

  useEffect(() => {
    const itemId = pendingOrderItemFocusRef.current;

    if (!itemId || activeTab !== 'floor') {
      return;
    }

    const itemCard = orderItemCardRefs.current[itemId];
    if (!itemCard) {
      return;
    }

    pendingOrderItemFocusRef.current = null;
    setHighlightedOrderItemId(itemId);

    const clearHighlight = window.setTimeout(() => {
      setHighlightedOrderItemId((current) => (current === itemId ? null : current));
    }, 5000);

    return () => {
      window.clearTimeout(clearHighlight);
    };
  }, [activeTab, selectedOrderVisibleItems]);

  useEffect(() => {
    if (!floatingActionToast) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setFloatingActionToast(null);
    }, 3000);

    return () => window.clearTimeout(timer);
  }, [floatingActionToast]);
  useEffect(() => {
    const hasNotification = Boolean(actionMessage || errorMessage);
    if (!hasNotification) return;
    const timer = window.setTimeout(() => {
      setActionMessage(null);
      setErrorMessage(null);
    }, errorMessage ? 8000 : 5000);
    return () => window.clearTimeout(timer);
  }, [actionMessage, errorMessage, notificationRevision]);
  useEffect(() => {
    if (!shouldFocusReplacementFormRef.current || !replaceTargetItemId || activeTab !== 'floor') {
      return;
    }

    const formPanel = addItemFormRef.current;
    if (!formPanel) {
      return;
    }

    shouldFocusReplacementFormRef.current = false;

    const focusAndReveal = window.requestAnimationFrame(() => {
      formPanel.focus({ preventScroll: true });
      formPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    return () => window.cancelAnimationFrame(focusAndReveal);
  }, [activeTab, replaceTargetItemId]);

  useEffect(() => {
    resetReplacementMode();
    setEditingItemId(null);
    setAddItemMode('menu');
    setIsCloseDraftWarningOpen(false);
  }, [selectedTableId]);

  useEffect(() => {
    if (!replaceTargetItemId) {
      return;
    }

    if (!selectedOrder?.items.some((item) => item.id === replaceTargetItemId)) {
      resetReplacementMode();
    }
  }, [replaceTargetItemId, selectedOrder?.items]);

  useEffect(() => {
    if (activeTab !== 'cashier') {
      return;
    }

    if (!cashierTables.length) {
      return;
    }

    const currentStillVisible = cashierTables.some((table) => table.id === selectedTableId);
    if (!currentStillVisible) {
      setSelectedTableId(cashierTables[0].id);
    }
  }, [activeTab, cashierTables, selectedTableId]);

  useEffect(() => {
    if (!selectedDetachedCashierOrderId) {
      return;
    }

    if (!detachedCashierOrders.some((order) => order.id === selectedDetachedCashierOrderId)) {
      setSelectedDetachedCashierOrderId(null);
    }
  }, [detachedCashierOrders, selectedDetachedCashierOrderId]);

  useEffect(() => {
    setSelectedPaymentItemIds((current) => current.filter((entry) => selectablePaymentUnits.some((unit) => unit.unitKey === entry)));
  }, [selectablePaymentUnits]);

  useEffect(() => {
    const shouldResetPaymentForm =
      !selectedCashierOrder ||
      (selectedCashierOrder.summary.remainingBalance <= 0 && selectedCashierOrder.summary.pendingPayments <= 0);

    if (!shouldResetPaymentForm) {
      return;
    }

    setPaymentMode('total');
    setPaymentMethod('cash');
    setPaymentAmount('');
    setPaymentPercentage('');
    setPaymentReceived('');
    setPaymentReference('');
    setPaymentNotes('');
    setSelectedPaymentItemIds([]);
    setHighlightedPendingPaymentId(null);
  }, [
    selectedCashierOrder?.id,
    selectedCashierOrder?.summary.pendingPayments,
    selectedCashierOrder?.summary.remainingBalance,
  ]);

  useEffect(() => {
    setErrorMessage(null);
  }, [paymentAmount, paymentMethod, paymentMode, paymentNotes, paymentPercentage, paymentReceived, paymentReference, selectedPaymentItemIds, selectedTableId]);

  useEffect(() => {
    if (!isMoveTableModalOpen) {
      return;
    }

    const currentDestinationStillAvailable = availableMoveDestinationTables.some((table) => table.id === moveDestinationTableId);
    if (!currentDestinationStillAvailable) {
      setMoveDestinationTableId(availableMoveDestinationTables[0]?.id ?? '');
    }
  }, [availableMoveDestinationTables, isMoveTableModalOpen, moveDestinationTableId]);

  const executeAction = async <T,>(
    label: string,
    action: () => Promise<T>,
    options?: {
      skipBusy?: boolean;
      showToast?: boolean;
      onSuccess?: (result: T) => void;
      onError?: (error: Error) => string | void;
    },
  ) => {
    if (!actor.email) {
      setErrorMessage('No hay una sesion operativa valida para ejecutar esta accion.');
      return;
    }

    const actionId = currentBusyActionIdRef.current + 1;
    if (!options?.skipBusy) {
      currentBusyActionIdRef.current = actionId;
      setBusyAction(label);
    }

    setErrorMessage(null);
    setActionMessage(null);

    try {
      const result = await action();
      options?.onSuccess?.(result);
      if (!savingLineItemRef.current) invalidateTableContext();
      setActionMessage(label);
      setNotificationRevision((revision) => revision + 1);
      if (options?.showToast) {
        setFloatingActionToast(label);
      }
      markLocalMutationCommitted();
    } catch (error) {
      if (savingLineItemRef.current) invalidateTableContext();
      const normalizedError = error instanceof Error ? error : new Error(`No fue posible completar: ${label}`);
      const customMessage = options?.onError?.(normalizedError);
      setActionMessage(null);
      setErrorMessage(customMessage ?? normalizedError.message);
      setNotificationRevision((revision) => revision + 1);
    } finally {
      if (!options?.skipBusy && currentBusyActionIdRef.current === actionId) {
        setBusyAction(null);
      }
    }
  };

  const handleToggleOperationalFlowSetting = async (
    area: PosOrderItem['prepArea'],
    field: keyof PosOperationalFlowSettings[PosOrderItem['prepArea']],
    value: boolean,
  ) => {
    const currentAreaSettings = operationalFlowSettings[area];
    const nextAreaSettings = {
      ...currentAreaSettings,
      [field]: value,
    };

    setSavingOperationalFlowArea(area);
    try {
      await executeAction(
        'Configuracion operativa actualizada',
        async () =>
          updatePosOperationalFlowSettingsInSupabase(
            {
              area,
              useInProcess: nextAreaSettings.useInProcess,
              usePickingUp: nextAreaSettings.usePickingUp,
              useDirectDelivery: nextAreaSettings.useDirectDelivery,
            },
            actor,
          ),
        {
          onSuccess: () => {
            setPosState((current) =>
              current
                ? {
                    ...current,
                    operationalFlowSettings: {
                      ...current.operationalFlowSettings,
                      [area]: nextAreaSettings,
                    },
                  }
                : current,
            );
          },
        },
      );
    } finally {
      setSavingOperationalFlowArea(null);
    }
  };

  const toggleTraceLogDetails = (logId: string) => {
    setExpandedTraceLogIds((current) => (current.includes(logId) ? current.filter((id) => id !== logId) : [...current, logId]));
  };

  const handleCreateTable = async () => {
    if (!createTableCode) {
      setErrorMessage('La mesa debe tener un codigo antes de crearse.');
      return;
    }

    if (!createTableName) {
      setErrorMessage('La mesa debe tener un nombre antes de crearse.');
      return;
    }

    await executeAction(
      `Mesa ${createTableForm.code.toUpperCase()} creada`,
      async () =>
        createPosTableInSupabase(
        {
          ...createTableForm,
          code: createTableCode,
          name: createTableName,
        },
        actor,
        ),
      {
        onSuccess: (createdTable) => {
          setPosState((current) => (current ? insertTableIntoPosState(current, createdTable) : current));
          setCreateTableForm(emptyCreateTableForm);
          setSelectedTableId(createdTable.id);
        },
      },
    );
  };

  const handleCancelOrDeleteTable = async () => {
    if (busyAction) return;
    if (hasCreateTableText) {
      setCreateTableForm((current) => ({ ...current, code: '', name: '' }));
      return;
    }
    await handleDeleteSelectedTable();
  };

  const handleDeleteSelectedTable = async () => {
    if (!selectedTable) {
      return;
    }

    if (!canDeleteSelectedTable) {
      setErrorMessage('Solo puedes eliminar mesas que no tengan una cuenta activa.');
      return;
    }

    const confirmed = window.confirm(
      `Se eliminara ${selectedTable.name} (${selectedTable.code}). Las ventas, productos y pagos historicos se conservaran.`,
    );
    if (!confirmed) {
      return;
    }

    await executeAction(`Mesa ${selectedTable.code} eliminada`, async () => deletePosTableInSupabase(selectedTable.id, actor), {
      onSuccess: (result) => {
        setPosState((current) =>
          current ? (result.removed ? removeTableFromPosState(current, selectedTable.id) : updateTableInPosState(current, result.table)) : current,
        );
        if (result.removed) {
          setSelectedTableId((current) => (current === selectedTable.id ? null : current));
          setIsTableSheetOpen(false);
        }
      },
    });
  };

  const handleOpenMoveTableModal = () => {
    if (!selectedTable?.activeOrder) {
      setErrorMessage('Selecciona una mesa con cuenta activa para trasladarla.');
      return;
    }

    if (!canMoveSelectedOrder) {
      setErrorMessage('Tu rol actual no puede mover cuentas entre mesas.');
      return;
    }

    const firstDestination = availableMoveDestinationTables[0];
    if (!firstDestination) {
      setErrorMessage('No hay mesas disponibles para recibir esta cuenta.');
      return;
    }

    setMoveDestinationTableId(firstDestination.id);
    setIsMoveTableModalOpen(true);
  };

  const handleMoveSelectedOrder = async () => {
    if (!selectedTable?.activeOrder || !moveDestinationTableId) {
      setErrorMessage('Selecciona una cuenta origen y una mesa destino disponible.');
      return;
    }

    const destinationTable = availableMoveDestinationTables.find((table) => table.id === moveDestinationTableId);
    if (!destinationTable) {
      setErrorMessage('La mesa destino ya no esta disponible. Actualiza la seleccion.');
      return;
    }

    await executeAction(
      `Cuenta movida de ${selectedTable.code} a ${destinationTable.code}`,
      async () => moveActiveOrderToTableInSupabase(selectedTable.id, destinationTable.id, actor),
      {
        onSuccess: (result) => {
          setPosState((current) => (current ? mergeMovedOrderIntoPosState(current, result) : current));
          setSelectedTableId(result.destinationTable.id);
          setIsMoveTableModalOpen(false);
          setMoveDestinationTableId('');
          setIsTableSheetOpen(false);
        },
      },
    );
  };

  const handleAddOrReplaceItem = async () => {
    const context = tableContextRef.current;
    if (savingLineItemRef.current) return;
    const tableId = selectedTableIdRef.current;
    if (!tableId || selectedTable?.id !== tableId || !context || !isPosTableContextValid(context, tableId)) {
      invalidateTableContext();
      return;
    }
    savingLineItemRef.current = true;
    setIsSavingLineItem(true);
    tableContextEventsRef.current = [];
    try {
      if (!selectedTable) {
        setErrorMessage('Selecciona una mesa antes de continuar.');
        return;
      }

      if (!isLineQuantityValid || parsedLineQuantity == null) {
        setErrorMessage('La cantidad debe ser mayor que cero.');
        return;
      }

      if (addItemMode === 'extra') {
        if (replaceTargetItemId) {
          setErrorMessage('Sal del modo reemplazo antes de agregar un extra.');
          return;
        }

        if (!customItemNameValue) {
          setErrorMessage('El extra debe tener un nombre.');
          return;
        }

        if (!isCustomItemUnitPriceValid || parsedCustomItemUnitPrice == null) {
          setErrorMessage('El precio unitario del extra debe ser mayor que cero.');
          return;
        }

        await executeAction(
          `Extra agregado a ${selectedTable.code}`,
          async () =>
            addCustomItemToTableInSupabase(
              selectedTable.id,
              {
                notes: lineNotes,
                prepArea: customItemPrepArea,
                productName: customItemNameValue,
                quantity: parsedLineQuantity,
                unitPrice: parsedCustomItemUnitPrice,
              },
              actor,
          ),
          {
            skipBusy: true,
            showToast: true,
            onSuccess: (createdItem) => {
              pendingOrderItemFocusRef.current = createdItem.id;
              setPosState((current) =>
                current ? mergeAddedItemsIntoPosState(current, selectedTable, [createdItem], actor.email) : current,
              );
              setCustomItemName('');
              setCustomItemUnitPrice('');
              setLineNotes('');
              setLineQuantity('1');
            },
            onError: (error) => `No se pudo agregar el extra al borrador: ${error.message}`,
          },
        );
        return;
      }

      if (!selectedProduct) {
        setErrorMessage('Selecciona un producto antes de continuar.');
        return;
      }

      const payload: AddOrderItemInput = {
        menuItemSourceKey: selectedProduct.sourceKey,
        notes: lineNotes,
        productName: selectedProduct.name,
        productSlug: selectedProduct.slug,
        productType: selectedProduct.type,
        quantity: parsedLineQuantity,
        unitPrice: selectedProduct.price,
      };

      if (replaceTargetItemId) {
        const targetItem = selectedOrder?.items.find((item) => item.id === replaceTargetItemId);
        await executeAction(
          `Producto reemplazado en ${selectedTable.code}`,
          async () =>
            replaceOrderItemInSupabase(
              replaceTargetItemId,
              { ...payload, reason: replaceReason.trim() || `Reemplazo de ${targetItem?.productName ?? 'producto'}` },
              actor,
              targetItem,
            ),
          {
            skipBusy: true,
            onSuccess: (replacementItem) => {
              pendingOrderItemFocusRef.current = replacementItem.id;
              const now = new Date().toISOString();
              const cancelledOriginal = targetItem
                ? {
                    ...targetItem,
                    cancellationReason: replaceReason.trim() || `Reemplazo de ${targetItem.productName}`,
                    cancelledAt: now,
                    cancelledByEmail: actor.email,
                    financialStatus: 'cancelled' as const,
                    operationalStatus: 'cancelled' as const,
                    updatedAt: now,
                    updatedByEmail: actor.email,
                  }
                : null;

              setPosState((current) =>
                current
                  ? mergeUpdatedItemsIntoPosState(current, cancelledOriginal ? [cancelledOriginal, replacementItem] : [replacementItem])
                  : current,
              );
              resetReplacementMode();
              setLineNotes('');
              setLineQuantity('1');
            },
            onError: (error) => `No se pudo reemplazar el producto: ${error.message}`,
          },
        );
        return;
      }

      await executeAction(
        `Producto agregado a ${selectedTable.code}`,
        async () => addItemsToTableInSupabase(selectedTable.id, [payload], actor, context),
        {
          skipBusy: true,
          showToast: true,
          onSuccess: (createdItems) => {
            if (tableContextRef.current === context) setTableContext({ ...context });
            pendingOrderItemFocusRef.current = createdItems[0]?.id ?? null;
            setPosState((current) =>
              current
                ? mergeAddedItemsIntoPosState(current, selectedTable, createdItems, actor.email)
                : current,
            );
            setLineNotes('');
            setLineQuantity('1');
          },
          onError: (error) => `No se pudo agregar el producto al borrador: ${error.message}`,
        },
      );
    } finally {
      savingLineItemRef.current = false;
      setIsSavingLineItem(false);
      const events = tableContextEventsRef.current;
      tableContextEventsRef.current = [];
      for (const event of events) updateTableContextFromRealtime(event);
      if (addItemMode === 'extra' || replaceTargetItemId || !tableContextRef.current) invalidateTableContext();
    }
  };

  const handleStartEditing = (item: PosOrderItem) => {
    setEditingItemId(item.id);
    setEditingNotes(item.notes ?? '');
    setEditingQuantity(String(item.quantity));
  };

  const handleStartReplacing = (item: PosOrderItem) => {
    shouldFocusReplacementFormRef.current = true;
    setAddItemMode('menu');
    setReplaceTargetItemId(item.id);
    setReplaceReason('');
  };

  const handleSaveEditing = async () => {
    if (!editingItemId) {
      return;
    }

    if (!isEditingQuantityValid || parsedEditingQuantity == null) {
      setErrorMessage('La cantidad debe ser mayor que cero.');
      return;
    }

    const currentEditingItem = selectedOrder?.items.find((item) => item.id === editingItemId);
    const patch: UpdateOrderItemInput = {
      notes: editingNotes,
      quantity: parsedEditingQuantity,
    };

    await executeAction('Producto actualizado', async () => updateOrderItemInSupabase(editingItemId, patch, actor, currentEditingItem), {
      onSuccess: (updatedItem) => {
        setPosState((current) => (current ? mergeUpdatedItemsIntoPosState(current, [updatedItem]) : current));
        setEditingItemId(null);
        setEditingNotes('');
        setEditingQuantity('1');
      },
    });
  };

  const handleCancelItem = async (item: PosOrderItem) => {
    const reason = window.prompt(
      item.operationalStatus === 'draft' ? `Motivo para quitar 1 unidad del borrador ${item.productName}:` : `Motivo para cancelar 1 unidad de ${item.productName}:`,
      item.notes || (item.operationalStatus === 'draft' ? 'Borrador descartado' : 'Cancelacion operativa'),
    );
    if (!reason) {
      return;
    }

    await executeAction(`1 unidad de ${item.productName} cancelada`, async () => cancelOrderItemInSupabase(item.id, reason, actor, item), {
      onSuccess: (updatedItems) => {
        setPosState((current) => (current ? mergeUpdatedItemsIntoPosState(current, updatedItems) : current));
      },
    });
  };

  const handleMovePrepStatus = async (item: PosOrderItem, nextStatus: 'in_process' | 'ready') => {
    await executeAction(`Producto marcado como ${itemStatusLabels[nextStatus].toLowerCase()}`, async () => transitionPreparationItemInSupabase(item.id, nextStatus, actor, item), {
      onSuccess: (updatedItem) => {
        setPosState((current) => (current ? mergeUpdatedItemsIntoPosState(current, [updatedItem]) : current));
      },
    });
  };

  const handleDelivered = async (item: PosOrderItem) => {
    await executeAction(`${item.productName} entregado`, async () => markOrderItemDeliveredInSupabase(item.id, actor, item), {
      onSuccess: (updatedItem) => {
        setPosState((current) => (current ? mergeUpdatedItemsIntoPosState(current, [updatedItem]) : current));
      },
    });
  };

  const handleDirectDelivered = async (item: PosOrderItem) => {
    await executeAction(`${item.productName} entregado directo`, async () => markOrderItemDirectDeliveredInSupabase(item.id, actor, item), {
      onSuccess: (updatedItem) => {
        setPosState((current) => (current ? mergeUpdatedItemsIntoPosState(current, [updatedItem]) : current));
      },
    });
  };

  const handlePickingUp = async (item: PosOrderItem) => {
    await executeAction(`Recogiendo ${item.productName}`, async () => markOrderItemPickingUpInSupabase(item.id, actor, item), {
      onSuccess: (updatedItem) => {
        setPosState((current) => (current ? mergeUpdatedItemsIntoPosState(current, [updatedItem]) : current));
      },
    });
  };

  const handleVoidProcessedItem = async (item: PosOrderItem) => {
    if (!canVoidProcessedItems) {
      setErrorMessage('Tu rol actual no puede anular productos por excepcion.');
      return;
    }

    const reason = window.prompt(
      `Motivo obligatorio para anular 1 unidad de "${item.productName}":`,
      'Producto registrado por error; no corresponde a la cuenta real',
    );
    if (!reason?.trim()) {
      return;
    }

    const confirmed = window.confirm(
      `Se anulara 1 unidad de "${item.productName}" sin borrarla del historial. Esta accion recalcula la cuenta y queda registrada en trazabilidad. ¿Continuar?`,
    );
    if (!confirmed) {
      return;
    }

    await executeAction(`Unidad anulada por excepcion: ${item.productName}`, async () => voidProcessedOrderItemInSupabase(item.id, reason, actor, item, 1), {
      onSuccess: (updatedItems) => {
        setPosState((current) => (current ? mergeUpdatedItemsIntoPosState(current, updatedItems) : current));
      },
    });
  };

  const handleRecordPayment = async () => {
    if (!selectedCashierOrder) {
      return;
    }

    await executeAction(
      'Pago registrado',
      async () =>
        recordPosPaymentInSupabase(
          selectedCashierOrder.id,
          {
            amount: paymentMode === 'amount' ? parseNumber(paymentAmount) : undefined,
            amountReceived: paymentMethod === 'cash' ? parseNumber(paymentReceived) : undefined,
            method: paymentMethod,
            notes: paymentNotes,
            percentage: paymentMode === 'percentage' ? parseNumber(paymentPercentage) : undefined,
            reference: paymentReference,
            targetItemIds: paymentMode === 'items' ? selectedPaymentItemIds : undefined,
          },
          actor,
        ),
      {
        onSuccess: (payment) => {
          setPosState((current) => (current ? mergePaymentIntoPosState(current, payment) : current));
          setPaymentAmount('');
          setPaymentPercentage('');
          setPaymentReceived('');
          setPaymentReference('');
          setPaymentNotes('');
          setSelectedPaymentItemIds([]);
          if (payment.status === 'pending') {
            setCashierRightPanel('validations');
            setHighlightedPendingPaymentId(payment.id);
          } else {
            setHighlightedPendingPaymentId(null);
          }
        },
      },
    );
  };

  const handleConfirmPendingPayment = async (paymentId: string) => {
    const payment = posState?.pendingPayments.find((entry) => entry.id === paymentId);
    await executeAction('Pago confirmado', async () => updatePosPaymentStatusInSupabase(paymentId, { status: 'confirmed' }, actor, payment), {
      onSuccess: (updatedPayment) => {
        setPosState((current) => (current ? mergePaymentIntoPosState(current, updatedPayment) : current));
        setHighlightedPendingPaymentId((current) => (current === paymentId ? null : current));
      },
    });
  };

  const handleRejectPendingPayment = async (paymentId: string) => {
    const reason = window.prompt('Motivo del rechazo:', 'Transferencia no visible');
    if (!reason) {
      return;
    }

    const payment = posState?.pendingPayments.find((entry) => entry.id === paymentId);
    await executeAction('Pago rechazado', async () => updatePosPaymentStatusInSupabase(paymentId, { rejectionReason: reason, status: 'rejected' }, actor, payment), {
      onSuccess: (updatedPayment) => {
        setPosState((current) => (current ? mergePaymentIntoPosState(current, updatedPayment) : current));
        setHighlightedPendingPaymentId((current) => (current === paymentId ? null : current));
      },
    });
  };

  const handleCloseActiveSalesSession = async () => {
    await executeAction('Jornada cerrada', async () => closeActiveSalesSessionInSupabase(actor, salesSessionClosingNotes), {
      onSuccess: (closedSession) => {
        setPosState((current) => {
          if (!current) {
            return current;
          }

          const nextRecentSessions = [
            closedSession,
            ...current.recentSalesSessions.filter((session) => session.id !== closedSession.id),
          ].slice(0, 10);

          return {
            ...current,
            activeSalesSession: null,
            recentSalesSessions: nextRecentSessions,
          };
        });
        setCashierRightPanel('previous_sessions');
        setSelectedHistoricalSessionId(closedSession.id);
        setSalesSessionClosingNotes('');
      },
    });
  };

  const handleOpenSalesSession = async () => {
    await executeAction('Jornada abierta', async () => openSalesSessionInSupabase(actor, salesSessionOpeningNotes), {
      onSuccess: (openedSession) => {
        setPosState((current) => {
          if (!current) {
            return current;
          }

          return {
            ...current,
            activeSalesSession: openedSession,
            recentSalesSessions: [openedSession, ...current.recentSalesSessions.filter((session) => session.id !== openedSession.id)].slice(0, 10),
          };
        });
        setCashierRightPanel('summary');
        setSalesSessionOpeningNotes('');
      },
    });
  };

  const closeTableSheet = ({ force = false }: { force?: boolean } = {}) => {
    if (!force && selectedOrderDraftItems.length > 0) {
      setIsCloseDraftWarningOpen(true);
      return;
    }

    resetReplacementMode();
    setIsCloseDraftWarningOpen(false);
    closeTableSheetFocusRef.current = true;
    setIsTableSheetOpen(false);
  };

  const handleSendDraftItems = async () => {
    if (!selectedOrder) {
      return;
    }

    await executeAction('Pedido enviado a preparacion', async () => sendDraftItemsToPreparationInSupabase(selectedOrder.id, actor), {
      onSuccess: (updatedItems) => {
        setPosState((current) => (current ? mergeUpdatedItemsIntoPosState(current, updatedItems) : current));
      },
    });
  };

  const renderSelectedTableWorkspace = () => (
    <Panel
      title={selectedTable ? `${selectedTable.name} · ${selectedTable.code}` : 'Selecciona una mesa'}
      subtitle={selectedOrder ? financialStatusLabels[selectedOrder.financialStatus] : 'La cuenta se abre automaticamente al agregar el primer producto'}
    >
      {selectedTable ? (
        <>
          {selectedPendingDeliveryCount > 0 ? (
            <div className="mb-4 rounded-[1rem] border border-rose-300/25 bg-rose-300/10 px-3 py-2 text-sm font-medium text-rose-100">
              {selectedPendingDeliveryCount} pendiente(s) por entregar
            </div>
          ) : selectedPreparationCount > 0 ? (
            <div className="mb-4 rounded-[1rem] border border-amberGlow/20 bg-amberGlow/10 px-3 py-2 text-sm text-amber-100">
              {selectedPreparationCount} en preparacion
            </div>
          ) : null}
          {shouldShowTableSummary ? (
            <div className="grid gap-3 md:grid-cols-3">
              <SummaryPill label="Estado" value={tableStatusLabels[selectedTable.status]} />
              <SummaryPill label="Cuenta" value={selectedOrder ? formatCurrency(selectedOrder.summary.totalDue) : formatCurrency(0)} />
              <SummaryPill label="Saldo" value={selectedOrder ? formatCurrency(selectedOrder.summary.remainingBalance) : formatCurrency(0)} />
            </div>
          ) : null}

          {selectedOrder ? (
            <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-mist">
              <p><span className="text-cyanGlow/75">Apertura de cuenta:</span> {formatDateTime(selectedOrder.openedAt)}</p>
              <p><span className="text-cyanGlow/75">Cierre:</span> {selectedOrder.closedAt ? formatDateTime(selectedOrder.closedAt) : 'En curso'}</p>
            </div>
          ) : null}

          {selectedOrder ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" onClick={handleOpenMoveTableModal} disabled={!canMoveSelectedOrder || Boolean(busyAction)} className={ghostButtonClassName}>
                Mover mesa
              </button>
              <p className="text-sm text-mist">Traslada la cuenta completa a una mesa disponible.</p>
            </div>
          ) : null}

          {selectedOrder?.openedByEmail || selectedTable.assignedStaffEmail ? (
            <div className="mt-4 rounded-[1rem] border border-white/8 bg-white/[0.02] px-3 py-3 text-sm text-mist">
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {selectedOrder?.openedByEmail ? (
                  <p>
                    <span className="text-cyanGlow/75">Creada por:</span>{' '}
                    <span className="text-ivory">{formatOperatorIdentity(selectedOrder.openedByEmail)}</span>
                  </p>
                ) : null}
                {selectedTable.assignedStaffEmail ? (
                  <p>
                    <span className="text-cyanGlow/75">Responsable actual:</span>{' '}
                    <span className="text-ivory">{formatOperatorIdentity(selectedTable.assignedStaffEmail)}</span>
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <div
            ref={addItemFormRef}
            tabIndex={-1}
            className={`mt-5 rounded-[1.2rem] border p-4 transition duration-500 focus:outline-none ${
              replaceTargetItemId ? 'border-amberGlow/45 bg-amberGlow/[0.08] shadow-[0_0_0_4px_rgba(245,158,11,0.08)]' : 'border-white/8 bg-black/15'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">
                  {replaceTargetItemId ? 'Modo reemplazo' : 'Agregar productos'}
                </p>
                <p className="mt-2 text-sm text-mist">
                  {replaceTargetItemId
                    ? 'El nuevo producto se crea en borrador y el anterior queda cancelado con trazabilidad.'
                    : 'Puedes sumar nuevas tandas a la misma mesa sin cerrar la cuenta.'}
                </p>
              </div>
              {replaceTargetItemId ? (
                <button type="button" onClick={resetReplacementMode} className={ghostButtonClassName}>
                  Salir de reemplazo
                </button>
              ) : null}
            </div>

            {selectedReplacementTarget ? (
              <div className="mt-4 rounded-[1rem] border border-amberGlow/30 bg-black/20 px-3 py-3 text-sm text-amber-100">
                <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-amberGlow">Reemplazando</p>
                <p className="mt-2 font-semibold text-ivory">
                  {selectedReplacementTarget.quantity} × {selectedReplacementTarget.productName}
                </p>
                <p className="mt-1 text-mist">
                  Estado actual: {itemStatusLabels[selectedReplacementTarget.operationalStatus]} · {formatCurrency(selectedReplacementTarget.totalPrice)}
                </p>
              </div>
            ) : null}

            <div className="mt-4 grid gap-3">
              {!replaceTargetItemId ? (
                <div className="flex w-fit rounded-full border border-white/10 bg-black/20 p-1">
                  {(['menu', 'extra'] as AddItemMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setAddItemMode(mode)}
                      className={`rounded-full px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] transition ${
                        addItemMode === mode ? 'bg-cyanGlow/14 text-cyanGlow' : 'text-mist hover:text-ivory'
                      }`}
                    >
                      {mode === 'menu' ? 'Menu' : 'Extra'}
                    </button>
                  ))}
                </div>
              ) : null}
              {addItemMode === 'menu' || replaceTargetItemId ? (
                <>
                  <Field label="Buscar producto">
                    <input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} className={inputClassName} placeholder="Corona, Poker, jugo..." />
                  </Field>
                  <Field label="Producto">
                    <select value={selectedProductSourceKey} onChange={(event) => setSelectedProductSourceKey(event.target.value)} className={inputClassName}>
                      {filteredProducts.slice(0, 60).map((product) => (
                        <option key={product.sourceKey} value={product.sourceKey}>
                          {product.name} · {formatCurrency(product.price)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Nombre del extra">
                    <input value={customItemName} onChange={(event) => setCustomItemName(event.target.value)} className={inputClassName} placeholder="Shot de tequila" />
                  </Field>
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Area">
                      <select value={customItemPrepArea} onChange={(event) => setCustomItemPrepArea(event.target.value as AddCustomOrderItemInput['prepArea'])} className={inputClassName}>
                        <option value="bar">Bar</option>
                        <option value="kitchen">Cocina</option>
                      </select>
                    </Field>
                    <Field label="Precio unitario">
                      <input
                        value={formatCurrencyInputValue(customItemUnitPrice)}
                        onChange={(event) => setCustomItemUnitPrice(sanitizeDigitsInput(event.target.value))}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        className={getQuantityInputClassName(isCustomItemUnitPriceValid)}
                        placeholder="$ 10.000"
                      />
                    </Field>
                  </div>
                </>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Cantidad">
                  <input
                    value={lineQuantity}
                    onChange={(event) => setLineQuantity(sanitizeDigitsInput(event.target.value))}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    className={getQuantityInputClassName(isLineQuantityValid)}
                  />
                </Field>
                {replaceTargetItemId ? (
                  <Field label="Motivo de reemplazo">
                    <input value={replaceReason} onChange={(event) => setReplaceReason(event.target.value)} className={inputClassName} placeholder="Cliente cambia Corona por Poker" />
                  </Field>
                ) : null}
              </div>
              <Field label="Observaciones del producto">
                <input value={lineNotes} onChange={(event) => setLineNotes(event.target.value)} className={inputClassName} placeholder="Sin hielo, poco limon, sin azucar..." />
              </Field>
            </div>

            <button
                type="button"
                onClick={() => void handleAddOrReplaceItem()}
                disabled={!canSubmitLineItem || !selectedTableId || !tableContext || !isPosTableContextValid(tableContext, selectedTableId) || isSavingLineItem}
                aria-busy={isSavingLineItem}
                className={`${addToTableButtonClassName} mt-4`}
              >
                {isSavingLineItem ? <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" /> : null}
                <span>{isSavingLineItem ? 'Guardando...' : !selectedTableId || !tableContext || !isPosTableContextValid(tableContext, selectedTableId) ? 'Mesa no lista' : replaceTargetItemId ? 'Aplicar reemplazo' : addItemMode === 'extra' ? 'Agregar extra' : 'Agregar a la mesa'}</span>
            </button>
          </div>

          <div className="mt-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Productos del pedido</p>
                <p className="mt-2 text-sm text-mist">Cada producto conserva su estado, observaciones y trazabilidad.</p>
              </div>
            </div>

            {selectedOrderVisibleItems.length ? (
              selectedOrderVisibleItems.map((item) => {
                const isDirectDispatch = shouldUseDirectDeliveryStep(item, operationalFlowSettings);

                return (
                <article
                  key={item.id}
                  ref={(element) => {
                    orderItemCardRefs.current[item.id] = element;
                  }}
                  tabIndex={-1}
                  className={`rounded-[1.2rem] border p-4 transition duration-500 focus:outline-none ${
                    replaceTargetItemId === item.id
                      ? 'border-amberGlow/70 bg-amberGlow/[0.12] shadow-[0_0_0_4px_rgba(245,158,11,0.1)]'
                      : highlightedOrderItemId === item.id
                      ? 'border-cyanGlow/70 bg-cyanGlow/[0.14] shadow-[0_0_0_4px_rgba(56,189,248,0.12)]'
                      : item.operationalStatus === 'draft'
                      ? 'border-amberGlow/28 bg-amberGlow/[0.06]'
                      : 'border-white/8 bg-white/[0.02]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ivory">
                        {item.quantity} × {item.productName}
                      </p>
                      <p className="mt-2 text-sm text-mist">{formatCurrency(item.totalPrice)}</p>
                      {item.notes ? <p className="mt-2 text-sm text-amberGlow">{item.notes}</p> : null}
                      {item.operationalStatus === 'picking_up' && item.pickingUpByEmail ? (
                        <p className="mt-2 text-sm text-cyanGlow/80">Recogiendo: {formatOperatorIdentity(item.pickingUpByEmail)}</p>
                      ) : null}
                      {item.operationalStatus === 'draft' ? (
                        <p className="mt-2 text-sm text-amberGlow">Producto temporal. Aun no se ha enviado a preparacion.</p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <span className="rounded-full border border-cyanGlow/15 bg-cyanGlow/10 px-3 py-1 text-[0.65rem] uppercase tracking-[0.22em] text-cyanGlow">
                        {itemStatusLabels[item.operationalStatus]}
                      </span>
                      {showFinancialBadgeInProducts && item.operationalStatus !== 'draft' ? (
                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[0.65rem] uppercase tracking-[0.22em] text-mist">
                          {financialStatusLabels[item.financialStatus]}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  {editingItemId === item.id ? (
                    <div className="mt-4 grid gap-3 md:grid-cols-[7rem_minmax(0,1fr)_auto]">
                      <input
                        value={editingQuantity}
                        onChange={(event) => setEditingQuantity(sanitizeDigitsInput(event.target.value))}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        className={getQuantityInputClassName(isEditingQuantityValid)}
                      />
                      <input value={editingNotes} onChange={(event) => setEditingNotes(event.target.value)} className={inputClassName} placeholder="Observacion del producto" />
                      <div className="flex gap-2">
                        <button type="button" onClick={() => void handleSaveEditing()} disabled={!isEditingQuantityValid || Boolean(busyAction)} className={primaryButtonClassName}>
                          Guardar
                        </button>
                        <button type="button" onClick={() => setEditingItemId(null)} className={ghostButtonClassName}>
                          Cancelar
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-4 flex flex-wrap gap-2">
                    {!editingItemId && item.operationalStatus === 'draft' ? (
                      <>
                        <button type="button" onClick={() => handleStartEditing(item)} className={ghostButtonClassName}>
                          Editar
                        </button>
                        <button type="button" onClick={() => void handleCancelItem(item)} className={dangerButtonClassName}>
                          Quitar 1 unidad
                        </button>
                      </>
                    ) : null}
                    {!editingItemId && ['sent', 'pending_preparation'].includes(item.operationalStatus) ? (
                      <>
                        <button type="button" onClick={() => handleStartReplacing(item)} className={ghostButtonClassName}>
                          Reemplazar
                        </button>
                        <button type="button" onClick={() => void handleCancelItem(item)} className={dangerButtonClassName}>
                          Cancelar 1 unidad
                        </button>
                      </>
                    ) : null}
                    {!editingItemId && isDirectDispatch && isDirectDeliveryCandidate(item) ? (
                      <button type="button" onClick={() => void handleDirectDelivered(item)} className={primaryButtonClassName}>
                        Entregar directo
                      </button>
                    ) : null}
                    {!editingItemId && item.operationalStatus === 'ready' ? (
                      shouldUsePickingUpStep(item, operationalFlowSettings) ? (
                        <button type="button" onClick={() => void handlePickingUp(item)} className={ghostButtonClassName}>
                          Ir a recoger
                        </button>
                      ) : (
                        <button type="button" onClick={() => void handleDelivered(item)} className={primaryButtonClassName}>
                          Marcar entregado
                        </button>
                      )
                    ) : null}
                    {!editingItemId && item.operationalStatus === 'picking_up' ? (
                      <button type="button" onClick={() => void handleDelivered(item)} className={primaryButtonClassName}>
                        Marcar entregado
                      </button>
                    ) : null}
                  </div>
                </article>
                );
              })
            ) : (
              <EmptyState message="Esta mesa todavia no tiene productos activos. Agrega la primera tanda desde el panel superior." />
            )}
          </div>
        </>
      ) : (
        <EmptyState message="No hay mesas cargadas todavia." />
      )}
    </Panel>
  );

  if (isLoading) {
    return (
      <AdminLayout>
        <section className="rounded-[1.8rem] border border-white/10 bg-white/[0.03] p-8 text-mist">Cargando operacion POS...</section>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <section className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <h1 className="text-[0.72rem] font-normal uppercase tracking-[0.28em] text-cyanGlow/80">POS operativo</h1>
          <p hidden>
            Opera cuentas por mesa, controla preparacion y registra cobros con trazabilidad del turno.
          </p>
        </div>

      </section>

      <nav aria-label="Areas del POS" className="sticky top-[var(--admin-header-height,0px)] z-30 mt-1 flex flex-wrap gap-2 border-b border-white/10 bg-obsidian px-1 py-2 shadow-[0_8px_18px_rgba(0,0,0,0.18)]">
          {workspaceTabs.map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={activeTab === tab}
              onClick={() => {
                setActiveTab(tab);
                window.scrollTo({ top: 0, left: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
              }}
              className={`rounded-full px-3 py-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.18em] sm:px-4 sm:py-2 sm:text-xs sm:tracking-[0.22em] ${
                activeTab === tab
                  ? 'border border-cyanGlow/25 bg-cyanGlow/10 text-cyanGlow'
                  : 'border border-white/10 bg-white/[0.04] text-mist'
              }`}
            >
              {workspaceLabels[tab]}
            </button>
          ))}
      </nav>

      {showMetricsOverview || showPreparationMetrics || showFloorMetrics ? (
        <section hidden className="mt-5">
          <div className="flex items-center justify-between gap-3 rounded-[1.4rem] border border-white/10 bg-white/[0.04] px-4 py-3">
            <div>
              <p className="text-[0.65rem] uppercase tracking-[0.2em] text-mist">KPI</p>
              <p className="mt-1 text-sm text-ivory/80">Toca para ver el tablero</p>
            </div>
            <button
              type="button"
              onClick={() => setIsMetricsCompactOpen((current) => !current)}
              className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-ivory transition hover:border-cyanGlow/35 hover:bg-white/[0.08]"
            >
              {isMetricsCompactOpen ? 'Ocultar' : 'Ver'}
            </button>
          </div>

          {isMetricsCompactOpen ? (
            <section
              className={`mt-4 grid gap-3 ${
                showMetricsOverview && showPreparationMetrics && showFloorMetrics ? 'md:grid-cols-2 xl:grid-cols-4' : 'md:grid-cols-2 xl:grid-cols-3'
              }`}
            >
              {showFloorMetrics ? (
                <MetricCard label="Mesas activas" value={String(posState?.tables.filter((table) => table.activeOrder != null).length ?? 0)} />
              ) : null}
              {showPreparationMetrics ? <MetricCard label="Preparacion cocina" value={String(kitchenQueue.length)} accent="amber" /> : null}
              {showPreparationMetrics ? <MetricCard label="Preparacion bar" value={String(barQueue.length)} accent="cyan" /> : null}
              {showMetricsOverview ? (
                <MetricCard
                  label="Pendiente por cobrar"
                  value={formatCurrency(posState?.openOrders.reduce((sum, order) => sum + order.summary.remainingBalance, 0) ?? 0)}
                  accent="emerald"
                />
              ) : null}
            </section>
          ) : null}
        </section>
      ) : null}

      {errorMessage ? (
        <section className="mt-5 rounded-[1.2rem] border border-rose-200/20 bg-rose-200/10 px-3 py-2 text-sm text-rose-100 sm:mt-6 sm:rounded-[1.4rem] sm:px-4 sm:py-3">{errorMessage}</section>
      ) : null}
      {actionMessage ? (
        <section className="mt-5 rounded-[1.2rem] border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-sm text-emerald-100 sm:mt-6 sm:rounded-[1.4rem] sm:px-4 sm:py-3">
          {actionMessage}
        </section>
      ) : null}
      {overdueSalesSession ? (
        <section role="alert" className="mt-5 rounded-[1.2rem] border border-amberGlow/35 bg-amberGlow/10 px-3 py-3 text-sm leading-6 text-amber-100 sm:mt-6 sm:rounded-[1.4rem] sm:px-4">
          <p className="font-semibold">La jornada {overdueSalesSession.sessionLabel} sigue abierta.</p>
          <p>Ya paso el corte de las 6:00 a. m. de Colombia. Revisa los pendientes y realiza el cierre.</p>
        </section>
      ) : null}
      {floatingActionToast ? (
        <div className="pointer-events-none fixed inset-x-2 top-4 z-[9999] flex items-center gap-2 rounded-[1.2rem] border border-emerald-300/40 bg-emerald-500/20 px-4 py-3 text-sm text-emerald-100 backdrop-blur-sm shadow-lg sm:top-auto sm:bottom-6 sm:right-6 sm:inset-x-auto sm:w-fit sm:border-emerald-300/50 sm:bg-emerald-500/25">
          <span aria-hidden="true" className="text-xl">&#10003;</span>
          <span className="font-medium">{floatingActionToast}</span>
        </div>
      ) : null}

      {activeTab === 'floor' && canOperateFloor ? (
        <section className="mt-8 grid gap-6 xl:grid-cols-[minmax(18rem,0.95fr)_minmax(0,1.35fr)_minmax(21rem,0.95fr)]">
          <div className="space-y-5">
            <Panel title="Mesas vivas" subtitle="Selecciona una mesa para operar la cuenta" actions={
              <div role="group" aria-label="Vista de mesas" className="flex shrink-0 rounded-lg border border-white/10 bg-black/20 p-1">
                {(['list', 'grid'] as const).map((layout) => (
                  <button key={layout} type="button" aria-label={layout === 'list' ? 'Ver mesas en lista' : 'Ver mesas en cuadricula'} aria-pressed={floorTableLayout === layout} onClick={() => setFloorTableLayout(layout)} title={layout === 'list' ? 'Ver mesas en lista' : 'Ver mesas en cuadricula'} className={`flex h-10 w-10 items-center justify-center rounded-md transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyanGlow ${floorTableLayout === layout ? 'bg-cyanGlow/15 text-cyanGlow' : 'text-mist hover:bg-white/5 hover:text-ivory'}`}>
                    {layout === 'list' ? <List size={18} aria-hidden="true" /> : <LayoutGrid size={18} aria-hidden="true" />}
                  </button>
                ))}
              </div>
            }>
              <div className={floorTableLayout === 'grid' ? 'grid grid-cols-2 items-stretch gap-3' : 'space-y-3'}>
                {floorTables.map((table) => {
                  const readyCount = table.activeOrder?.items.filter((item) => item.operationalStatus === 'ready').length ?? 0;
                  const pickingUpCount = table.activeOrder?.items.filter((item) => item.operationalStatus === 'picking_up').length ?? 0;
                  const inPreparationCount =
                    table.activeOrder?.items.filter((item) => ['sent', 'pending_preparation', 'in_process'].includes(item.operationalStatus)).length ?? 0;
                  const indicatorClassName =
                    readyCount > 0
                      ? 'bg-rose-400 shadow-[0_0_0_4px_rgba(251,113,133,0.14)]'
                      : pickingUpCount > 0
                        ? 'bg-cyanGlow shadow-[0_0_0_4px_rgba(36,107,255,0.14)]'
                        : inPreparationCount > 0
                          ? 'bg-amber-300 shadow-[0_0_0_4px_rgba(252,211,77,0.12)]'
                          : null;

                  return (
                    <button
                      key={table.id}
                      ref={(element) => {
                        tableButtonRefs.current[table.id] = element;
                      }}
                      type="button"
                      onClick={() => {
                        shouldFocusFloorWorkspacePanelRef.current = true;
                        setSelectedTableId(table.id);
                        if (window.innerWidth < 1280) {
                          setIsTableSheetOpen(true);
                        }
                      }}
                      className={`flex w-full flex-col items-stretch justify-start rounded-[1.2rem] border p-4 text-left transition ${
                        selectedTable?.id === table.id
                          ? 'border-cyanGlow/28 bg-cyanGlow/10'
                          : readyCount > 0
                            ? 'border-emerald-300/35 bg-emerald-300/[0.06]'
                            : pickingUpCount > 0
                              ? 'border-cyanGlow/24 bg-cyanGlow/[0.05]'
                            : 'border-white/8 bg-white/[0.02]'
                      }`}
                    >
                      <div className={floorTableLayout === 'grid' ? 'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2' : 'flex items-start justify-between gap-3'}>
                        <div className={floorTableLayout === 'grid' ? 'contents' : 'min-w-0'}>
                          <p className={`break-words text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75 ${floorTableLayout === 'grid' ? 'col-start-1 row-start-1' : ''}`}>{table.code}</p>
                          <div className={`mt-2 flex items-center gap-2 ${floorTableLayout === 'grid' ? 'col-span-2 row-start-2' : ''}`}>
                            <p className="break-words font-semibold text-ivory">{table.name}</p>
                            {indicatorClassName ? <span className={`inline-block h-2.5 w-2.5 rounded-full ${indicatorClassName}`} /> : null}
                          </div>
                        </div>
                        <span className={`shrink-0 rounded-full border px-2 py-1 text-[0.65rem] uppercase tracking-normal ${floorTableLayout === 'grid' ? 'col-start-2 row-start-1 justify-self-end' : ''} ${table.status === 'occupied' ? 'border-amberGlow/35 bg-amberGlow/10 text-amberGlow' : table.status === 'available' ? 'border-emerald-300/25 bg-emerald-300/10 text-emerald-200' : 'border-white/10 bg-white/[0.04] text-mist'}`}>
                          {tableStatusLabels[table.status]}
                        </span>
                      </div>
                      {table.activeOrder ? (
                        <div className="mt-3 text-sm text-mist">
                          <p>{table.activeOrder.items.length} producto(s)</p>
                          <p>{formatCurrency(table.activeOrder.summary.remainingBalance)} pendiente</p>
                          {table.assignedStaffEmail ? <p className="mt-2 break-words text-xs text-cyanGlow/75">Responsable actual: <span className={floorTableLayout === 'grid' ? 'mt-1 block text-ivory' : ''}>{formatOperatorIdentity(table.assignedStaffEmail)}</span></p> : null}
                          {readyCount > 0 ? <p className="mt-2 font-medium text-rose-200">{readyCount} listo(s) por recoger</p> : null}
                          {pickingUpCount > 0 ? <p className="mt-2 text-cyanGlow/90">{pickingUpCount} en recogida</p> : null}
                          {!readyCount && !pickingUpCount && inPreparationCount > 0 ? <p className="mt-2 text-amberGlow">{inPreparationCount} en preparacion</p> : null}
                        </div>
                      ) : (
                        <div className="mt-3 text-sm text-mist">
                          <p>Sin cuenta activa</p>
                          {table.assignedStaffEmail ? <p className="mt-2 break-words text-xs text-cyanGlow/75">Responsable actual: <span className={floorTableLayout === 'grid' ? 'mt-1 block text-ivory' : ''}>{formatOperatorIdentity(table.assignedStaffEmail)}</span></p> : null}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
              {selectedTable ? (
                <button type="button" onClick={() => setIsTableSheetOpen(true)} className={`mt-4 w-full xl:hidden ${primaryButtonClassName}`}>
                  Abrir detalle de {selectedTable.name}
                </button>
              ) : null}
            </Panel>

            <details className="rounded-[1.3rem] border border-white/10 bg-white/[0.03] p-4 shadow-[0_18px_40px_rgba(0,0,0,0.2)] sm:rounded-[1.7rem] sm:p-5">
              <summary className="cursor-pointer marker:text-cyanGlow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyanGlow/24">
                <span className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Crear mesa</span>
                <p className="mt-2 text-sm leading-6 text-mist sm:mt-3 sm:leading-7">Mesas fijas o adicionales para alta ocupacion</p>
              </summary>
              <div className="mt-3 sm:mt-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Codigo">
                  <input value={createTableForm.code} onChange={(event) => setCreateTableForm((current) => ({ ...current, code: event.target.value }))} className={inputClassName} placeholder="M-07" />
                </Field>
                <Field label="Nombre">
                  <input value={createTableForm.name} onChange={(event) => setCreateTableForm((current) => ({ ...current, name: event.target.value }))} className={inputClassName} placeholder="Mesa 07" />
                </Field>
                <Field label="Tipo">
                  <select value={createTableForm.type} onChange={(event) => setCreateTableForm((current) => ({ ...current, type: event.target.value as CreatePosTableInput['type'] }))} className={inputClassName}>
                    {typeOptions.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Zona">
                  <select value={createTableForm.zone} onChange={(event) => setCreateTableForm((current) => ({ ...current, zone: event.target.value as CreatePosTableInput['zone'] }))} className={inputClassName}>
                    {zoneOptions.map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Capacidad">
                  <input
                    value={String(createTableForm.capacity ?? '')}
                    onChange={(event) =>
                      setCreateTableForm((current) => ({ ...current, capacity: parseOptionalNumber(sanitizeDigitsInput(event.target.value)) }))
                    }
                    inputMode="numeric"
                    pattern="[0-9]*"
                    className={getQuantityInputClassName(isCapacityValid)}
                    placeholder="4"
                  />
                </Field>
                <Field label="Notas">
                  <input value={createTableForm.notes ?? ''} onChange={(event) => setCreateTableForm((current) => ({ ...current, notes: event.target.value }))} className={inputClassName} placeholder="Mesa adicional por evento" />
                </Field>
              </div>
              <div className="mt-4 flex flex-wrap gap-3">
                <button type="button" onClick={() => void handleCreateTable()} disabled={!canCreateTable} className={primaryButtonClassName}>
                {busyAction ?? 'Crear mesa'}
                </button>
                {selectedTable || hasCreateTableText ? (
                  <button
                    type="button"
                    onClick={() => void handleCancelOrDeleteTable()}
                    disabled={Boolean(busyAction) || (!hasCreateTableText && !canDeleteSelectedTable)}
                    className={hasCreateTableText ? ghostButtonClassName : dangerButtonClassName}
                  >
                    {hasCreateTableText ? 'Cancelar' : `Eliminar mesa ${selectedTable?.code ?? ''}`}
                  </button>
                ) : null}
              </div>
              {selectedTable && !hasCreateTableText && !canDeleteSelectedTable ? (
                <p className="mt-3 text-sm text-mist">Solo puedes eliminar una mesa cuando no tenga cuenta activa ni este ocupada.</p>
              ) : null}
              </div>
            </details>
          </div>

          <div ref={floorWorkspacePanelRef} tabIndex={-1} className="hidden space-y-5 focus:outline-none xl:block">
            <Panel
              title={selectedTable ? `${selectedTable.name} · ${selectedTable.code}` : 'Selecciona una mesa'}
              subtitle={selectedOrder ? financialStatusLabels[selectedOrder.financialStatus] : 'La cuenta se abre automaticamente al agregar el primer producto'}
            >
              {selectedTable ? (
                <>
                  <div className="grid gap-3 md:grid-cols-3">
                    <SummaryPill label="Estado" value={tableStatusLabels[selectedTable.status]} />
                    <SummaryPill label="Cuenta" value={selectedOrder ? formatCurrency(selectedOrder.summary.totalDue) : formatCurrency(0)} />
                    <SummaryPill label="Saldo" value={selectedOrder ? formatCurrency(selectedOrder.summary.remainingBalance) : formatCurrency(0)} />
                  </div>

                  {selectedOrder ? (
                    <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-sm text-mist">
                      <p><span className="text-cyanGlow/75">Apertura de cuenta:</span> {formatDateTime(selectedOrder.openedAt)}</p>
                      <p><span className="text-cyanGlow/75">Cierre:</span> {selectedOrder.closedAt ? formatDateTime(selectedOrder.closedAt) : 'En curso'}</p>
                    </div>
                  ) : null}

                  {selectedOrder ? (
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <button type="button" onClick={handleOpenMoveTableModal} disabled={!canMoveSelectedOrder || Boolean(busyAction)} className={ghostButtonClassName}>
                        Mover mesa
                      </button>
                      <p className="text-sm text-mist">Traslada la cuenta completa a una mesa disponible.</p>
                    </div>
                  ) : null}

                  <div
                    ref={addItemFormRef}
                    tabIndex={-1}
                    className={`mt-5 rounded-[1.2rem] border p-4 transition duration-500 focus:outline-none ${
                      replaceTargetItemId ? 'border-amberGlow/45 bg-amberGlow/[0.08] shadow-[0_0_0_4px_rgba(245,158,11,0.08)]' : 'border-white/8 bg-black/15'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">
                          {replaceTargetItemId ? 'Modo reemplazo' : 'Agregar productos'}
                        </p>
                        <p className="mt-2 text-sm text-mist">
                          {replaceTargetItemId
                            ? 'El nuevo producto se crea en borrador y el anterior queda cancelado con trazabilidad.'
                            : 'Puedes sumar nuevas tandas a la misma mesa sin cerrar la cuenta.'}
                        </p>
                      </div>
                      {replaceTargetItemId ? (
                        <button type="button" onClick={resetReplacementMode} className={ghostButtonClassName}>
                          Salir de reemplazo
                        </button>
                      ) : null}
                    </div>

                    {selectedReplacementTarget ? (
                      <div className="mt-4 rounded-[1rem] border border-amberGlow/30 bg-black/20 px-3 py-3 text-sm text-amber-100">
                        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-amberGlow">Reemplazando</p>
                        <p className="mt-2 font-semibold text-ivory">
                          {selectedReplacementTarget.quantity} × {selectedReplacementTarget.productName}
                        </p>
                        <p className="mt-1 text-mist">
                          Estado actual: {itemStatusLabels[selectedReplacementTarget.operationalStatus]} · {formatCurrency(selectedReplacementTarget.totalPrice)}
                        </p>
                      </div>
                    ) : null}

                    <div className="mt-4 grid gap-3">
                      {!replaceTargetItemId ? (
                        <div className="flex w-fit rounded-full border border-white/10 bg-black/20 p-1">
                          {(['menu', 'extra'] as AddItemMode[]).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              onClick={() => setAddItemMode(mode)}
                              className={`rounded-full px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.18em] transition ${
                                addItemMode === mode ? 'bg-cyanGlow/14 text-cyanGlow' : 'text-mist hover:text-ivory'
                              }`}
                            >
                              {mode === 'menu' ? 'Menu' : 'Extra'}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {addItemMode === 'menu' || replaceTargetItemId ? (
                        <>
                          <Field label="Buscar producto">
                            <input value={productSearch} onChange={(event) => setProductSearch(event.target.value)} className={inputClassName} placeholder="Corona, Poker, jugo..." />
                          </Field>
                          <Field label="Producto">
                            <select value={selectedProductSourceKey} onChange={(event) => setSelectedProductSourceKey(event.target.value)} className={inputClassName}>
                              {filteredProducts.slice(0, 60).map((product) => (
                                <option key={product.sourceKey} value={product.sourceKey}>
                                  {product.name} · {formatCurrency(product.price)}
                                </option>
                              ))}
                            </select>
                          </Field>
                        </>
                      ) : (
                        <>
                          <Field label="Nombre del extra">
                            <input value={customItemName} onChange={(event) => setCustomItemName(event.target.value)} className={inputClassName} placeholder="Shot de tequila" />
                          </Field>
                          <div className="grid gap-3 md:grid-cols-2">
                            <Field label="Area">
                              <select value={customItemPrepArea} onChange={(event) => setCustomItemPrepArea(event.target.value as AddCustomOrderItemInput['prepArea'])} className={inputClassName}>
                                <option value="bar">Bar</option>
                                <option value="kitchen">Cocina</option>
                              </select>
                            </Field>
                            <Field label="Precio unitario">
                              <input
                                value={formatCurrencyInputValue(customItemUnitPrice)}
                                onChange={(event) => setCustomItemUnitPrice(sanitizeDigitsInput(event.target.value))}
                                inputMode="numeric"
                                pattern="[0-9]*"
                                className={getQuantityInputClassName(isCustomItemUnitPriceValid)}
                                placeholder="$ 10.000"
                              />
                            </Field>
                          </div>
                        </>
                      )}
                      <div className="grid gap-3 md:grid-cols-2">
                        <Field label="Cantidad">
                          <input
                            value={lineQuantity}
                            onChange={(event) => setLineQuantity(sanitizeDigitsInput(event.target.value))}
                            inputMode="numeric"
                            pattern="[0-9]*"
                            className={getQuantityInputClassName(isLineQuantityValid)}
                          />
                        </Field>
                        {replaceTargetItemId ? (
                          <Field label="Motivo de reemplazo">
                            <input value={replaceReason} onChange={(event) => setReplaceReason(event.target.value)} className={inputClassName} placeholder="Cliente cambia Corona por Poker" />
                          </Field>
                        ) : null}
                      </div>
                      <Field label="Observaciones del producto">
                        <input value={lineNotes} onChange={(event) => setLineNotes(event.target.value)} className={inputClassName} placeholder="Sin hielo, poco limon, sin azucar..." />
                      </Field>
                    </div>

                    <button
                      type="button"
                      onClick={() => void handleAddOrReplaceItem()}
                      disabled={!canSubmitLineItem || !selectedTableId || !tableContext || !isPosTableContextValid(tableContext, selectedTableId) || isSavingLineItem}
                      aria-busy={isSavingLineItem}
                      className={`${addToTableButtonClassName} mt-4`}
                    >
                      {isSavingLineItem ? <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" /> : null}
                      <span>{isSavingLineItem ? 'Guardando...' : !selectedTableId || !tableContext || !isPosTableContextValid(tableContext, selectedTableId) ? 'Mesa no lista' : replaceTargetItemId ? 'Aplicar reemplazo' : addItemMode === 'extra' ? 'Agregar extra' : 'Agregar a la mesa'}</span>
                    </button>
                  </div>

                  {selectedOrderDraftItems.length ? (
                    <div className="sticky bottom-3 z-10 mt-4 grid gap-3 rounded-[1.1rem] border border-amberGlow/35 bg-[#18130d]/95 px-3 py-3 shadow-[0_14px_34px_rgba(0,0,0,0.32)] backdrop-blur sm:flex sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold leading-5 text-ivory">
                          {selectedOrderDraftItems.length} borrador{selectedOrderDraftItems.length === 1 ? '' : 'es'} sin enviar
                        </p>
                        <p className="mt-1 text-xs leading-5 text-amber-100/80">Envia la tanda para que cocina/bar la vea.</p>
                      </div>
                      <button type="button" onClick={() => void handleSendDraftItems()} disabled={Boolean(busyAction)} className={`${primaryButtonClassName} w-full justify-center sm:w-auto`}>
                        Enviar a preparacion
                      </button>
                    </div>
                  ) : null}

                  <div className="mt-5 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Productos del pedido</p>
                        <p className="mt-2 text-sm text-mist">Cada producto conserva su estado, observaciones y trazabilidad.</p>
                      </div>
                    </div>

                    {selectedOrder?.items.length ? (
                      selectedOrder.items.map((item) => {
                        const isDirectDispatch = shouldUseDirectDeliveryStep(item, operationalFlowSettings);

                        return (
                        <article
                          key={item.id}
                          ref={(element) => {
                            orderItemCardRefs.current[item.id] = element;
                          }}
                          tabIndex={-1}
                          className={`rounded-[1.2rem] border p-4 transition duration-500 focus:outline-none ${
                            replaceTargetItemId === item.id
                              ? 'border-amberGlow/70 bg-amberGlow/[0.12] shadow-[0_0_0_4px_rgba(245,158,11,0.1)]'
                              : highlightedOrderItemId === item.id
                              ? 'border-cyanGlow/70 bg-cyanGlow/[0.14] shadow-[0_0_0_4px_rgba(56,189,248,0.12)]'
                              : item.operationalStatus === 'draft'
                              ? 'border-amberGlow/28 bg-amberGlow/[0.06]'
                              : 'border-white/8 bg-white/[0.02]'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="font-medium text-ivory">
                                {item.quantity} × {item.productName}
                              </p>
                              <p className="mt-2 text-sm text-mist">{formatCurrency(item.totalPrice)}</p>
                              {item.notes ? <p className="mt-2 text-sm text-amberGlow">{item.notes}</p> : null}
                              {item.operationalStatus === 'picking_up' && item.pickingUpByEmail ? (
                                <p className="mt-2 text-sm text-cyanGlow/80">Recogiendo: {formatOperatorIdentity(item.pickingUpByEmail)}</p>
                              ) : null}
                              {item.operationalStatus === 'draft' ? (
                                <p className="mt-2 text-sm text-amberGlow">Producto temporal. Aun no se ha enviado a preparacion.</p>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 flex-wrap gap-2">
                              <span className="rounded-full border border-cyanGlow/15 bg-cyanGlow/10 px-3 py-1 text-[0.65rem] uppercase tracking-[0.22em] text-cyanGlow">
                                {itemStatusLabels[item.operationalStatus]}
                              </span>
                              {showFinancialBadgeInProducts && item.operationalStatus !== 'draft' ? (
                                <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[0.65rem] uppercase tracking-[0.22em] text-mist">
                                  {financialStatusLabels[item.financialStatus]}
                                </span>
                              ) : null}
                            </div>
                          </div>

                          {editingItemId === item.id ? (
                            <div className="mt-4 grid gap-3 md:grid-cols-[7rem_minmax(0,1fr)_auto]">
                             <input
                               value={editingQuantity}
                               onChange={(event) => setEditingQuantity(sanitizeDigitsInput(event.target.value))}
                               inputMode="numeric"
                               pattern="[0-9]*"
                               className={getQuantityInputClassName(isEditingQuantityValid)}
                             />
                              <input value={editingNotes} onChange={(event) => setEditingNotes(event.target.value)} className={inputClassName} placeholder="Observacion del producto" />
                              <div className="flex gap-2">
                               <button type="button" onClick={() => void handleSaveEditing()} disabled={!isEditingQuantityValid || Boolean(busyAction)} className={primaryButtonClassName}>
                                 Guardar
                               </button>
                                <button type="button" onClick={() => setEditingItemId(null)} className={ghostButtonClassName}>
                                  Cancelar
                                </button>
                              </div>
                            </div>
                          ) : null}

                          <div className="mt-4 flex flex-wrap gap-2">
                            {!editingItemId && item.operationalStatus === 'draft' ? (
                              <>
                                <button type="button" onClick={() => handleStartEditing(item)} className={ghostButtonClassName}>
                                  Editar
                                </button>
                                <button type="button" onClick={() => void handleCancelItem(item)} className={dangerButtonClassName}>
                                  Quitar 1 unidad
                                </button>
                              </>
                            ) : null}
                            {!editingItemId && ['sent', 'pending_preparation'].includes(item.operationalStatus) ? (
                              <>
                                <button type="button" onClick={() => handleStartReplacing(item)} className={ghostButtonClassName}>
                                  Reemplazar
                                </button>
                                <button type="button" onClick={() => void handleCancelItem(item)} className={dangerButtonClassName}>
                                  Cancelar 1 unidad
                                </button>
                              </>
                            ) : null}
                            {!editingItemId && isDirectDispatch && isDirectDeliveryCandidate(item) ? (
                              <button type="button" onClick={() => void handleDirectDelivered(item)} className={primaryButtonClassName}>
                                Entregar directo
                              </button>
                            ) : null}
                            {!editingItemId && item.operationalStatus === 'ready' ? (
                              shouldUsePickingUpStep(item, operationalFlowSettings) ? (
                                <button type="button" onClick={() => void handlePickingUp(item)} className={ghostButtonClassName}>
                                  Ir a recoger
                                </button>
                              ) : (
                                <button type="button" onClick={() => void handleDelivered(item)} className={primaryButtonClassName}>
                                  Marcar entregado
                                </button>
                              )
                            ) : null}
                            {!editingItemId && item.operationalStatus === 'picking_up' ? (
                              <button type="button" onClick={() => void handleDelivered(item)} className={primaryButtonClassName}>
                                Marcar entregado
                              </button>
                            ) : null}
                          </div>
                        </article>
                        );
                      })
                    ) : (
                      <EmptyState message="Esta mesa todavia no tiene productos activos. Agrega la primera tanda desde el panel superior." />
                    )}
                  </div>
                </>
              ) : (
                <EmptyState message="No hay mesas cargadas todavia." />
              )}
            </Panel>
          </div>

          {isTableSheetOpen && selectedTable ? (
            <div className="fixed inset-0 z-50 overflow-hidden overscroll-none bg-[#0b0b0f] xl:hidden">
              <div
                className="absolute inset-0 overflow-y-auto overscroll-contain border border-white/10 bg-[#0b0b0f] px-4 pb-[max(7.5rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] shadow-[0_-18px_40px_rgba(0,0,0,0.38)]"
                style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}
              >
                <div
                  ref={mobileTableSheetHeaderRef}
                  tabIndex={-1}
                  className="sticky top-0 left-3 right-3 z-30 mb-4 rounded-[1.7rem] border border-white/10 bg-[#0b0b0f]/95 px-4 py-4 shadow-[0_18px_50px_rgba(0,0,0,0.35)] backdrop-blur-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[0.7rem] uppercase tracking-[0.24em] text-cyanGlow/80">Mesa activa</p>
                      <p className="mt-1 truncate text-base font-semibold leading-none text-ivory">{selectedTable.name} · {selectedTable.code}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => closeTableSheet()}
                      className={`${ghostButtonClassName} rounded-full px-4 py-2 text-sm`}
                    >
                      Cerrar
                    </button>
                  </div>
                </div>
                {renderSelectedTableWorkspace()}
              </div>
              {selectedOrderDraftItems.length ? (
                <div className="absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-20 grid gap-2 rounded-[1.1rem] border border-amberGlow/35 bg-[#18130d]/95 px-3 py-3 shadow-[0_14px_34px_rgba(0,0,0,0.38)] backdrop-blur">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold leading-5 text-ivory">
                      {selectedOrderDraftItems.length} borrador{selectedOrderDraftItems.length === 1 ? '' : 'es'} sin enviar
                    </p>
                    <p className="mt-1 text-xs leading-5 text-amber-100/80">Envia la tanda para que cocina/bar la vea.</p>
                  </div>
                  <button type="button" onClick={() => void handleSendDraftItems()} disabled={Boolean(busyAction)} className={`${primaryButtonClassName} w-full justify-center`}>
                    Enviar a preparacion
                  </button>
                </div>
              ) : null}
              {isCloseDraftWarningOpen ? (
                <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/90 px-4 py-6">
                  <div className="w-full max-w-sm rounded-[1.6rem] border border-amberGlow/40 bg-[#0d0d11]/95 p-5 shadow-[0_22px_60px_rgba(0,0,0,0.55)] ring-1 ring-amberGlow/15">
                    <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-amberGlow/10 px-3 py-1 text-[0.68rem] font-semibold uppercase tracking-[0.24em] text-amberGlow">
                      Alerta
                    </div>
                    <p className="text-[0.7rem] font-semibold uppercase tracking-[0.22em] text-amberGlow">Borradores pendientes</p>
                    <p className="mt-3 text-sm leading-6 text-mist">
                      Hay {selectedOrderDraftItems.length} borrador{selectedOrderDraftItems.length === 1 ? '' : 'es'} sin enviar. No se pierde{selectedOrderDraftItems.length === 1 ? '' : 'n'} al cerrar.
                    </p>
                    <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:justify-end">
                      <button type="button" onClick={() => setIsCloseDraftWarningOpen(false)} className={primaryButtonClassName}>
                        Seguir editando
                      </button>
                      <button type="button" onClick={() => closeTableSheet({ force: true })} className={`${ghostButtonClassName} w-full sm:w-auto`}>
                        Cerrar sin enviar
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {isMoveTableModalOpen && selectedTable?.activeOrder ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden overscroll-contain bg-black/72 px-4">
              <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto overscroll-contain rounded-[1.4rem] border border-white/10 bg-[#0b0b0f] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.45)]">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/80">Trasladar cuenta</p>
                    <h2 className="mt-2 font-display text-2xl text-ivory">
                      {selectedTable.name} · {selectedTable.code}
                    </h2>
                    <p className="mt-2 text-sm text-mist">
                      Se mueve la orden activa completa con productos, pagos, saldo, observaciones y jornada.
                    </p>
                  </div>
                  <button type="button" onClick={() => setIsMoveTableModalOpen(false)} className={ghostButtonClassName}>
                    Cerrar
                  </button>
                </div>

                <div className="mt-5 grid gap-3">
                  <SummaryPill label="Cuenta actual" value={formatCurrency(selectedTable.activeOrder.summary.totalDue)} />
                  <SummaryPill label="Saldo pendiente" value={formatCurrency(selectedTable.activeOrder.summary.remainingBalance)} />
                  <Field label="Mesa destino">
                    <select value={moveDestinationTableId} onChange={(event) => setMoveDestinationTableId(event.target.value)} className={inputClassName}>
                      {availableMoveDestinationTables.map((table) => (
                        <option key={table.id} value={table.id}>
                          {table.name} · {table.code}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                {!availableMoveDestinationTables.length ? (
                  <p className="mt-4 text-sm text-rose-100">No hay mesas libres para recibir esta cuenta.</p>
                ) : null}

                <div className="mt-5 flex flex-wrap justify-end gap-3">
                  <button type="button" onClick={() => setIsMoveTableModalOpen(false)} className={ghostButtonClassName}>
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleMoveSelectedOrder()}
                    disabled={!moveDestinationTableId || Boolean(busyAction)}
                    className={primaryButtonClassName}
                  >
                    Confirmar traslado
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {shouldShowFloorSidebar ? (
            <div className="space-y-5">
              <details className="rounded-[1.3rem] border border-white/10 bg-white/[0.03] p-4 shadow-[0_18px_40px_rgba(0,0,0,0.2)] sm:rounded-[1.7rem] sm:p-5">
                <summary className="cursor-pointer marker:text-cyanGlow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyanGlow/24">
                  <span className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Trazabilidad reciente</span>
                  <p className="mt-2 text-sm leading-6 text-mist sm:mt-3 sm:leading-7">Ultimos eventos operativos y financieros</p>
                </summary>
                <div className="mt-3 space-y-3 sm:mt-4">
                  {(posState?.logs ?? []).slice(0, 8).map((log) => {
                    const contextLabel = resolveLogContextLabel(log, ordersById, tablesById);
                    const productLabel = resolveLogProductLabel(log);
                    const lineItems = resolveLogLineItems(log);
                    const isExpanded = expandedTraceLogIds.includes(log.id);

                    return (
                      <article key={log.id} className="rounded-[1.1rem] border border-white/8 bg-white/[0.02] p-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-ivory">{formatPosEventLabel(log.eventType)}</p>
                            <p className="mt-1 text-xs uppercase tracking-[0.16em] text-cyanGlow/75">{formatDateTime(log.createdAt)}</p>
                          </div>
                          <span className="rounded-full border border-white/8 bg-black/20 px-2.5 py-1 text-[0.62rem] uppercase tracking-[0.18em] text-mist">
                            {formatOperatorIdentity(log.actorEmail)}
                          </span>
                        </div>
                        {contextLabel ? <p className="mt-3 text-sm text-mist">{contextLabel}</p> : null}
                        {productLabel ? <p className="mt-1 text-sm text-ivory">{productLabel}</p> : null}
                        {log.notes ? <p className="mt-2 text-sm text-cyanGlow">{log.notes}</p> : null}
                        {lineItems.length ? (
                          <div className="mt-3">
                            <button
                              type="button"
                              onClick={() => toggleTraceLogDetails(log.id)}
                              className="interactive-button rounded-full border border-cyanGlow/30 bg-cyanGlow/10 px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-cyanGlow transition hover:border-cyanGlow/55 hover:bg-cyanGlow/16"
                            >
                              {isExpanded ? 'Ocultar lineas' : `Ver lineas (${lineItems.length})`}
                            </button>
                            {isExpanded ? (
                              <div className="mt-3 space-y-2">
                                {lineItems.map((line, index) => (
                                  <div key={`${log.id}-${line.id ?? index}`} className="rounded-[0.9rem] border border-white/8 bg-black/20 px-3 py-2">
                                    <div className="flex items-start justify-between gap-3">
                                      <p className="text-sm font-medium text-ivory">{line.productName}</p>
                                      <span className="shrink-0 text-xs uppercase tracking-[0.16em] text-cyanGlow">{line.quantity} und.</span>
                                    </div>
                                    <p className="mt-1 text-xs uppercase tracking-[0.16em] text-mist">{line.prepArea === 'kitchen' ? 'Cocina' : 'Bar'}</p>
                                    {line.notes ? <p className="mt-1 text-sm text-amberGlow">{line.notes}</p> : null}
                                  </div>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                  {!(posState?.logs ?? []).length ? <EmptyState message="Todavia no hay movimientos recientes en la trazabilidad POS." /> : null}
                </div>
              </details>
            </div>
          ) : null}
        </section>
      ) : null}

      {activeTab === 'kitchen' && canOperateKitchen ? (
        <PreparationQueuePanel
          areaLabel="Cocina"
          busyAction={busyAction}
          items={sortedKitchenQueue}
          onDirectDelivered={handleDirectDelivered}
          onMoveStatus={handleMovePrepStatus}
          operationalFlowSettings={operationalFlowSettings}
          title="Cola de cocina"
        />
      ) : null}

      {activeTab === 'bar' && canOperateBar ? (
        <PreparationQueuePanel
          areaLabel="Bar"
          busyAction={busyAction}
          items={sortedBarQueue}
          onDirectDelivered={handleDirectDelivered}
          onMoveStatus={handleMovePrepStatus}
          operationalFlowSettings={operationalFlowSettings}
          title="Cola de bebidas"
        />
      ) : null}


      {activeTab === 'cashier' && canOperateCashier ? (
        <section className="mt-8 grid gap-6 xl:grid-cols-[minmax(18rem,0.82fr)_minmax(0,1.15fr)_minmax(0,0.95fr)]">
          <div className="space-y-5">
            <Panel title="Cuentas activas para caja" subtitle="La caja puede cambiar de mesa desde aquí, sin depender de otra pestaña.">
              <div className="space-y-3">
                {cashierTables.map((table) => (
                  <button
                    key={table.id}
                    type="button"
                    onClick={() => {
                      shouldFocusCashierPaymentPanelRef.current = true;
                      setSelectedDetachedCashierOrderId(null);
                      setSelectedTableId(table.id);
                    }}
                    className={`w-full rounded-[1.2rem] border p-4 text-left transition ${
                      selectedCashierTable?.id === table.id ? 'border-cyanGlow/28 bg-cyanGlow/10' : 'border-white/8 bg-white/[0.02]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">{table.code}</p>
                        <p className="mt-2 font-semibold text-ivory">{table.name}</p>
                      </div>
                      <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[0.65rem] uppercase tracking-[0.22em] text-mist">
                        {table.activeOrder ? financialStatusLabels[table.activeOrder.financialStatus] : tableStatusLabels[table.status]}
                      </span>
                    </div>
                    {table.activeOrder ? (
                      <div className="mt-3 grid gap-2 text-sm text-mist sm:grid-cols-2">
                        <p>Total: {formatCurrency(table.activeOrder.summary.totalDue)}</p>
                        <p>Saldo: {formatCurrency(table.activeOrder.summary.remainingBalance)}</p>
                      </div>
                    ) : null}
                  </button>
                ))}
                {detachedCashierOrders.map((order) => {
                  const table = order.tableId ? tablesById.get(order.tableId) : null;
                  const tableCode = table?.code ?? order.tableCodeSnapshot ?? 'MESA ELIMINADA';
                  const tableName = table?.name ?? formatDetachedTableLabel(order.tableNameSnapshot, order.tableCodeSnapshot);

                  return (
                    <button
                      key={order.id}
                      type="button"
                      onClick={() => {
                        shouldFocusCashierPaymentPanelRef.current = true;
                        setSelectedDetachedCashierOrderId(order.id);
                      }}
                      className={`w-full rounded-[1.2rem] border p-4 text-left transition ${
                        selectedDetachedCashierOrder?.id === order.id ? 'border-amberGlow/35 bg-amberGlow/10' : 'border-amberGlow/18 bg-amberGlow/[0.04]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-[0.68rem] uppercase tracking-[0.22em] text-amberGlow">
                            {tableCode}
                          </p>
                          <p className="mt-2 font-semibold text-ivory">{tableName}</p>
                        </div>
                        <span className="rounded-full border border-amberGlow/20 bg-amberGlow/10 px-3 py-1 text-[0.65rem] uppercase tracking-[0.22em] text-amberGlow">
                          Revisar
                        </span>
                      </div>
                      <div className="mt-3 grid gap-2 text-sm text-mist sm:grid-cols-2">
                        <p>Total: {formatCurrency(order.summary.totalDue)}</p>
                        <p>Saldo: {formatCurrency(order.summary.remainingBalance)}</p>
                        <p>Abierta: {formatDateTime(order.openedAt)}</p>
                        <p>Por: {formatOperatorIdentity(order.openedByEmail)}</p>
                      </div>
                      <p className="mt-3 text-sm text-amberGlow">
                        Esta cuenta esta abierta en la jornada, pero la mesa no la tiene como cuenta activa.
                      </p>
                    </button>
                  );
                })}
                {!cashierTables.length && !detachedCashierOrders.length ? <EmptyState message="No hay mesas con saldo o pagos pendientes por confirmar en este momento." /> : null}
              </div>
            </Panel>
          </div>

          <div ref={cashierPaymentPanelRef} tabIndex={-1} className="focus:outline-none">
            <Panel
              title={selectedCashierTitle}
              subtitle="Abonos parciales, total, por porcentaje o por productos"
            >
              {selectedCashierOrder ? (
                <>
                {selectedDetachedCashierOrder ? (
                  <div className="mb-4 rounded-[1.1rem] border border-amberGlow/20 bg-amberGlow/10 px-4 py-3 text-sm leading-6 text-amberGlow">
                    Esta cuenta quedo abierta sin estar vinculada como cuenta activa de la mesa. Fue abierta por {formatOperatorIdentity(selectedCashierOrder.openedByEmail)} el {formatDateTime(selectedCashierOrder.openedAt)}.
                  </div>
                ) : null}
                <div className="grid gap-3 md:grid-cols-3">
                  <SummaryPill label="Total cuenta" value={formatCurrency(selectedCashierOrder.summary.totalDue)} />
                  <SummaryPill label="Pagado" value={formatCurrency(selectedCashierOrder.summary.totalPaid)} />
                  <SummaryPill label="Saldo" value={formatCurrency(selectedCashierOrder.summary.remainingBalance)} />
                </div>

                <details className="mt-5 rounded-[1.2rem] border border-white/8 bg-white/[0.02] p-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                    <div>
                      <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Productos en cuenta</p>
                      <p className="mt-2 text-sm text-mist">
                        {cashierProductGroups.reduce((sum, group) => sum + group.quantity, 0)} unidad(es) en {cashierProductGroups.length} producto(s)
                      </p>
                    </div>
                    <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-[0.65rem] uppercase tracking-[0.22em] text-mist">
                      Ver
                    </span>
                  </summary>
                  <div className="mt-4 space-y-2">
                    {cashierProductGroups.map((group) => {
                        const voidTarget = findVoidableProcessedItemForGroup(selectedCashierOrder, group, outstandingByItem);
                        const cancelTarget = group.items.find((item) => ['draft', 'sent', 'pending_preparation'].includes(item.operationalStatus)) ?? null;
                        const canVoidItem =
                          canVoidProcessedItems &&
                          voidTarget != null &&
                          !selectedOrderHasPendingPayment;

                        return (
                          <article key={group.key} className="rounded-[1rem] border border-white/8 bg-black/15 px-3 py-3">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <p className="font-medium text-ivory">
                                  {group.quantity} × {group.productName}
                                </p>
                                <p className="mt-1 text-sm text-mist">
                                  {formatCurrency(group.totalPrice)} · {itemStatusLabels[group.operationalStatus]}
                                </p>
                                <p className="mt-1 text-xs uppercase tracking-[0.16em] text-cyanGlow/70">
                                  Creado {formatDateTime(group.items[0]?.createdAt ?? selectedCashierOrder.openedAt)} · {formatOperatorIdentity(group.items[0]?.createdByEmail)}
                                </p>
                                {group.notes ? <p className="mt-1 text-sm text-amberGlow">{group.notes}</p> : null}
                                {group.items.length > 1 ? <p className="mt-1 text-xs text-cyanGlow/70">Agrupa {group.items.length} tanda(s)</p> : null}
                              </div>
                              <div className="flex flex-wrap gap-2">
                              {cancelTarget ? (
                                <button
                                  type="button"
                                  onClick={() => void handleCancelItem(cancelTarget)}
                                  disabled={Boolean(busyAction)}
                                  className="rounded-full border border-rose-300/18 bg-transparent px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-rose-100/75 transition hover:border-rose-300/35 hover:bg-rose-300/8 hover:text-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  {cancelTarget.operationalStatus === 'draft' ? 'Quitar 1 unidad' : 'Cancelar 1 unidad'}
                                </button>
                              ) : null}
                              {voidTarget ? (
                                <button
                                  type="button"
                                  onClick={() => void handleVoidProcessedItem(voidTarget)}
                                  disabled={!canVoidItem || Boolean(busyAction)}
                                  className="rounded-full border border-rose-300/18 bg-transparent px-3 py-1.5 text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-rose-100/75 transition hover:border-rose-300/35 hover:bg-rose-300/8 hover:text-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  Anular 1
                                </button>
                              ) : null}
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    {!cashierProductGroups.length ? (
                      <EmptyState message="Esta cuenta no tiene productos activos para mostrar." />
                    ) : null}
                  </div>
                </details>

                <div className="mt-5 grid gap-3 md:grid-cols-2">
                  <Field label="Modo">
                    <select value={paymentMode} onChange={(event) => setPaymentMode(event.target.value as PaymentAllocationMode)} className={inputClassName}>
                      <option value="total">Total</option>
                      <option value="amount">Monto</option>
                      <option value="percentage">Porcentaje</option>
                      <option value="items">Por productos</option>
                    </select>
                  </Field>
                  <Field label="Metodo">
                    <select value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value as PaymentMethod)} className={inputClassName}>
                      {Object.entries(paymentMethodLabels).map(([method, label]) => (
                        <option key={method} value={method}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                {paymentMode === 'amount' ? (
                  <Field label="Monto a aplicar">
                    <input
                      value={activePaymentField === 'amount' ? formatGroupedDigitsInputValue(paymentAmount) : formatCurrencyInputValue(paymentAmount)}
                      onChange={(event) => setPaymentAmount(sanitizeDigitsInput(event.target.value))}
                      onFocus={() => setActivePaymentField('amount')}
                      onBlur={() => setActivePaymentField((current) => (current === 'amount' ? null : current))}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      className={getQuantityInputClassName(isPaymentAmountValid)}
                      placeholder="$ 87.000"
                    />
                  </Field>
                ) : null}

                {paymentMode === 'percentage' ? (
                  <Field label="Porcentaje">
                    <input
                      value={activePaymentField === 'percentage' ? paymentPercentage : formatPercentageInputValue(paymentPercentage)}
                      onChange={(event) => setPaymentPercentage(sanitizePercentageInput(event.target.value))}
                      onFocus={() => setActivePaymentField('percentage')}
                      onBlur={() => setActivePaymentField((current) => (current === 'percentage' ? null : current))}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      className={getQuantityInputClassName(isPaymentPercentageValid)}
                      placeholder="50 %"
                    />
                  </Field>
                ) : null}

                {paymentMode === 'items' ? (
                  <div className="mt-4 rounded-[1.2rem] border border-white/8 bg-white/[0.02] p-4">
                    <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Productos o unidades a cobrar</p>
                    <div className="mt-3 space-y-2">
                      {selectablePaymentUnits.map((unit) => (
                        <label key={unit.unitKey} className="flex items-center justify-between gap-3 rounded-[1rem] border border-white/8 bg-black/15 px-3 py-2 text-sm text-mist">
                          <span>
                            {unit.label}
                          </span>
                          <span className="flex items-center gap-3">
                            <span>{formatCurrency(unit.amount)}</span>
                            <input
                              type="checkbox"
                              checked={selectedPaymentItemIds.includes(unit.unitKey)}
                              onChange={(event) =>
                                setSelectedPaymentItemIds((current) =>
                                  event.target.checked ? [...current, unit.unitKey] : current.filter((entry) => entry !== unit.unitKey),
                                )
                              }
                            />
                          </span>
                        </label>
                      ))}
                      {!selectablePaymentUnits.length ? <EmptyState message="Ya no hay unidades pendientes por cobrar en esta mesa." /> : null}
                    </div>
                  </div>
                ) : null}

                {paymentMethod === 'cash' ? (
                  <Field label="Recibido">
                    <input
                      value={activePaymentField === 'received' ? formatGroupedDigitsInputValue(paymentReceived) : formatCurrencyInputValue(paymentReceived)}
                      onChange={(event) => setPaymentReceived(sanitizeDigitsInput(event.target.value))}
                      onFocus={() => setActivePaymentField('received')}
                      onBlur={() => setActivePaymentField((current) => (current === 'received' ? null : current))}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      className={getQuantityInputClassName(isPaymentReceivedValid)}
                      placeholder="$ 100.000"
                    />
                  </Field>
                ) : null}

                {(paymentMethod === 'nequi' || paymentMethod === 'bank_transfer' || paymentMethod === 'card') ? (
                  <Field label="Referencia">
                    <input value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} className={inputClassName} placeholder="Ref. transferencia o ultimos 4 digitos" />
                  </Field>
                ) : null}

                <Field label="Notas">
                  <input value={paymentNotes} onChange={(event) => setPaymentNotes(event.target.value)} className={inputClassName} placeholder="Pago dividido, transferencia de Juan..." />
                </Field>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <SummaryPill label="Aplicar" value={formatCurrency(paymentPreview.amountApplied)} />
                  <SummaryPill label="Cambio / devuelta" value={formatCurrency(paymentPreview.changeDue)} />
                </div>
                {paymentMethod === 'cash' && paymentPreview.changeDue > 0 ? (
                  <div className="mt-3 rounded-[1rem] border border-emerald-300/20 bg-emerald-300/10 px-4 py-3 text-sm font-medium text-emerald-100">
                    Devuelta estimada: {formatCurrency(paymentPreview.changeDue)}
                  </div>
                ) : null}
                {paymentMode === 'items' ? (
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <SummaryPill label="Seleccionado" value={formatCurrency(paymentPreview.selectedRawAmount)} />
                    <SummaryPill label="Exceso" value={formatCurrency(paymentPreview.overage)} />
                  </div>
                ) : null}
                {paymentMode === 'items' && paymentPreview.overage > 0 ? (
                  <p className="mt-3 text-sm text-amberGlow">
                    Seleccionaste mas unidades de las que siguen pendientes. Quita algunas antes de registrar el pago.
                  </p>
                ) : null}
                {selectedOrderHasPendingPayment ? (
                  <p className="mt-3 text-sm text-amberGlow">
                    Esta cuenta ya tiene un pago pendiente por validar. Confirma o rechaza ese movimiento antes de registrar uno nuevo.
                  </p>
                ) : null}

                <button type="button" onClick={() => void handleRecordPayment()} disabled={!canSubmitPayment} className={`${primaryButtonClassName} mt-4`}>
                  Registrar pago
                </button>
                </>
              ) : (
                <EmptyState message="Selecciona una mesa con cuenta activa desde la columna izquierda para operar la caja." />
              )}
            </Panel>
          </div>

          <Panel
            title={
              cashierRightPanel === 'summary'
                ? 'Jornada y resumen del dia'
                : cashierRightPanel === 'previous_sessions'
                  ? 'Jornadas previas'
                  : cashierRightPanel === 'validations'
                    ? 'Validaciones'
                    : 'Movimientos recientes'
            }
            subtitle={
              cashierRightPanel === 'summary'
                ? 'Desde aqui controlas la jornada y ves el pulso real de caja sin perder el contexto del turno.'
                : cashierRightPanel === 'previous_sessions'
                  ? 'Cada jornada cerrada agrupa sus mesas, productos, pagos y cierre en un solo lugar.'
                  : cashierRightPanel === 'validations'
                    ? 'Transferencias y Nequi solo cuando haga falta revisarlas manualmente.'
                    : 'Ultimos eventos operativos y de caja para seguirle la pista al turno.'
            }
          >
            <div className="mb-5 flex flex-wrap gap-2">
              {([
                ['summary', 'Jornada'],
                ['previous_sessions', `Jornadas previas${previousClosedSessions.length ? ` (${previousClosedSessions.length})` : ''}`],
                ['validations', `Validaciones${(posState?.pendingPayments.length ?? 0) ? ` (${posState?.pendingPayments.length ?? 0})` : ''}`],
                ['movements', 'Movimientos'],
              ] as const).map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setCashierRightPanel(tab)}
                  className={`rounded-full border px-4 py-2 text-[0.68rem] uppercase tracking-[0.22em] transition ${
                    cashierRightPanel === tab ? 'border-cyanGlow/35 bg-cyanGlow/12 text-cyanGlow' : 'border-white/8 bg-white/[0.02] text-mist'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {cashierRightPanel === 'summary' ? (
              <div className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2">
                  <SummaryPill
                    label={posState?.activeSalesSession ? 'Jornada activa' : 'Estado de jornada'}
                    value={posState?.activeSalesSession?.sessionLabel ?? 'Sin jornada abierta'}
                  />
                  {posState?.activeSalesSession ? (
                    <>
                      <SummaryPill label="Apertura" value={formatDateTime(posState.activeSalesSession.openedAt)} />
                      <SummaryPill label="Cierre" value={posState.activeSalesSession.closedAt ? formatDateTime(posState.activeSalesSession.closedAt) : 'En curso'} />
                    </>
                  ) : null}
                  <SummaryPill
                    label="Fecha contable"
                    value={posState?.activeSalesSession?.businessDate ?? posState?.recentSalesSessions.find((session) => session.status === 'closed')?.businessDate ?? 'Sin cierre'}
                  />
                  <SummaryPill label="Vendido" value={formatCurrency(activeSalesSessionSummary.grossSales)} />
                  <SummaryPill label="Cobrado" value={formatCurrency(activeSalesSessionSummary.totalCollected)} />
                  <SummaryPill label="Efectivo" value={formatCurrency(activeSalesSessionCashTotal)} />
                  <SummaryPill label="Transferencias" value={formatCurrency(activeSalesSessionTransferTotal)} />
                  <SummaryPill label="Pendiente" value={formatCurrency(activeSalesSessionSummary.pendingBalance)} />
                  <SummaryPill label="Pagos por validar" value={String(posState?.pendingPayments.length ?? 0)} />
                  <SummaryPill label="Mesas abiertas" value={String(sessionOpenTableCount)} />
                  <SummaryPill label="Mesas cerradas" value={String(sessionClosedTableCount)} />
                </div>

                <div className="rounded-[1.2rem] border border-white/8 bg-white/[0.02] p-4">
                  <details className="group">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                      <div>
                        <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Productos vendidos en la jornada actual</p>
                        <p className="mt-2 text-sm text-mist">
                          {activeSalesSessionSummary.products.length
                            ? `${activeSalesSessionSummary.products.length} producto(s) agrupado(s) en esta jornada`
                            : 'Todavia no hay productos vendidos resumidos en esta jornada activa.'}
                        </p>
                      </div>
                      <span className="text-[0.68rem] uppercase tracking-[0.18em] text-mist transition group-open:text-cyanGlow">Ver detalle</span>
                    </summary>
                    <SalesSessionProductsSummary
                      products={activeSalesSessionSummary.products ?? []}
                      emptyMessage="Todavia no hay productos vendidos resumidos en esta jornada activa."
                    />
                  </details>
                </div>

                <details className="group/paid-sales rounded-[1.2rem] border border-white/8 bg-white/[0.02] p-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyanGlow/24 [&::-webkit-details-marker]:hidden">
                    <div>
                      <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Ventas pagadas de la jornada actual ({activeSalesSessionPaidClosedSales.length})</p>
                      <p className="mt-2 text-sm text-mist">{activeSalesSessionPaidClosedSales.length} cuenta(s) pagada(s) y cerrada(s)</p>
                    </div>
                    <ChevronDown size={18} aria-hidden="true" className="shrink-0 text-cyanGlow/75 transition-transform group-open/paid-sales:rotate-180" />
                  </summary>
                  <div className="mt-3 space-y-3">
                    {activeSalesSessionPaidClosedSales.map((order) => (
                      <details key={`active-${order.id}`} className="rounded-[1.2rem] border border-white/8 bg-black/15 p-4">
                        <summary className="list-none cursor-pointer">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <p className="font-medium text-ivory">{resolveOrderTableLabel(order, tablesById)}</p>
                              <p className="mt-1 text-xs uppercase tracking-[0.18em] text-cyanGlow/75">
                                <span className="block">Apertura: {formatDateTime(order.openedAt)}</span>
                                <span className="mt-1 block">Cierre: {order.closedAt ? formatDateTime(order.closedAt) : 'Sin hora registrada'}</span>
                              </p>
                            </div>
                            <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-[0.65rem] uppercase tracking-[0.22em] text-emerald-200">
                              Pagada
                            </span>
                          </div>
                          <div className="mt-3 grid gap-2 text-sm text-mist">
                            <p>Total: {formatCurrency(order.summary.totalDue)}</p>
                            <p>Pagado: {formatCurrency(order.summary.totalPaid)}</p>
                            <p>Metodos: {formatPaymentMethodsSummary(order.payments.filter((payment) => payment.status === 'confirmed'))}</p>
                          </div>
                        </summary>

                        <div className="mt-4 space-y-4 border-t border-white/8 pt-4">
                          <div>
                            <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Productos</p>
                            <div className="mt-3 space-y-2">
                              {order.items
                                .filter((item) => item.operationalStatus !== 'cancelled')
                                .map((item) => (
                                  <div key={item.id} className="rounded-[1rem] border border-white/8 bg-black/15 px-3 py-3 text-sm text-mist">
                                    <div className="flex items-start justify-between gap-3">
                                      <p className="font-medium text-ivory">
                                        {item.quantity} × {item.productName}
                                      </p>
                                      <p>{formatCurrency(item.totalPrice)}</p>
                                    </div>
                                    {item.notes ? <p className="mt-2 text-sm text-cyanGlow">{item.notes}</p> : null}
                                  </div>
                                ))}
                            </div>
                          </div>

                          <div>
                            <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Pagos registrados</p>
                            <div className="mt-3 space-y-2">
                              {order.payments.map((payment) => (
                                <div key={payment.id} className="rounded-[1rem] border border-white/8 bg-black/15 px-3 py-3 text-sm text-mist">
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                      <p className="font-medium text-ivory">{paymentMethodLabels[payment.method]}</p>
                                      <p className="mt-1 text-xs uppercase tracking-[0.18em] text-mist">{formatDateTime(payment.confirmedAt ?? payment.createdAt)}</p>
                                    </div>
                                    <div className="text-right">
                                      <p className="font-medium text-ivory">{formatCurrency(payment.amountApplied)}</p>
                                      <p className="mt-1 text-xs uppercase tracking-[0.18em] text-mist">
                                        {payment.status === 'confirmed' ? 'Confirmado' : payment.status === 'rejected' ? 'Rechazado' : 'Pendiente'}
                                      </p>
                                    </div>
                                  </div>
                                  {payment.reference ? <p className="mt-2 text-sm text-amberGlow">{payment.reference}</p> : null}
                                  {payment.notes ? <p className="mt-2 text-sm text-cyanGlow">{payment.notes}</p> : null}
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </details>
                    ))}
                    {!activeSalesSessionPaidClosedSales.length ? <EmptyState message="Todavia no hay ventas pagadas cerradas dentro de la jornada vigente." /> : null}
                  </div>
                </details>

                <div className="rounded-[1.2rem] border border-white/8 bg-white/[0.02] p-4">
                  <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Control de jornada</p>
                  {posState?.activeSalesSession ? (
                    <div className="mt-4 space-y-4">
                      <Field label="Nota de cierre">
                        <input
                          value={salesSessionClosingNotes}
                          onChange={(event) => setSalesSessionClosingNotes(event.target.value)}
                          className={inputClassName}
                          placeholder="Cierre madrugada, caja principal, observaciones..."
                        />
                      </Field>

                      <button
                        type="button"
                        onClick={() => void handleCloseActiveSalesSession()}
                        disabled={Boolean(busyAction) || activeSalesSessionSummary.pendingBalance > 0 || activeSalesSessionSummary.pendingPayments > 0}
                        className={primaryButtonClassName}
                      >
                        Cerrar jornada
                      </button>

                      {activeSalesSessionSummary.pendingBalance > 0 || activeSalesSessionSummary.pendingPayments > 0 ? (
                        <p className="text-sm text-amberGlow">
                          Antes de cerrar debes dejar esta jornada sin saldo pendiente ni pagos por confirmar.
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-4 space-y-4">
                      <Field label="Nota de apertura">
                        <input
                          value={salesSessionOpeningNotes}
                          onChange={(event) => setSalesSessionOpeningNotes(event.target.value)}
                          className={inputClassName}
                          placeholder="Prueba turno noche, caja principal, observaciones..."
                        />
                      </Field>
                      <button type="button" onClick={() => void handleOpenSalesSession()} disabled={Boolean(busyAction)} className={primaryButtonClassName}>
                        Abrir jornada ahora
                      </button>
                      <p className="text-sm text-mist">Tambien puede abrirse sola cuando se mueve la operacion, pero aqui tienes control explicito para pruebas y turnos reales.</p>
                    </div>
                  )}
                </div>

                <div className="rounded-[1.2rem] border border-white/8 bg-white/[0.02] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Acceso rapido a jornadas previas</p>
                      <p className="mt-2 text-sm text-mist">Cuando cierres una jornada te llevamos directo a su resumen organizado.</p>
                    </div>
                    <button type="button" onClick={() => setCashierRightPanel('previous_sessions')} className={ghostButtonClassName}>
                      Ver jornadas previas
                    </button>
                  </div>
                  {previousClosedSessions.length ? (
                    <div className="mt-4 rounded-[1rem] border border-white/8 bg-black/15 px-3 py-3 text-sm text-mist">
                      Ultima cerrada: <span className="text-ivory">{previousClosedSessions[0].sessionLabel}</span>
                      <p className="mt-2 text-xs leading-5">
                        <span className="block">Apertura: {formatDateTime(previousClosedSessions[0].openedAt)}</span>
                        <span className="block">Cierre: {previousClosedSessions[0].closedAt ? formatDateTime(previousClosedSessions[0].closedAt) : 'Sin hora registrada'}</span>
                      </p>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-[1rem] border border-white/8 bg-black/15 px-3 py-3 text-sm text-mist">
                      Todavia no hay jornadas cerradas guardadas.
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {cashierRightPanel === 'previous_sessions' ? (
              <div className="space-y-4">
                <div className="space-y-3">
                  {previousClosedSessions.map((session) => (
                    <div key={session.id} className="space-y-3">
                      <button
                        ref={(node) => {
                          historicalSessionHeaderRefs.current[session.id] = node;
                        }}
                        type="button"
                        onClick={() => setSelectedHistoricalSessionId((current) => (current === session.id ? null : session.id))}
                        className={`w-full rounded-[1.1rem] border p-4 text-left transition ${
                          selectedHistoricalSession?.id === session.id ? 'border-cyanGlow/28 bg-cyanGlow/10' : 'border-white/8 bg-white/[0.02]'
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="font-medium text-ivory">{session.sessionLabel}</p>
                            <p className="mt-1 text-xs uppercase tracking-[0.18em] text-cyanGlow/75">
                              <span className="block">{session.businessDate} · cerrada</span>
                              <span className="mt-1 block">Apertura: {formatDateTime(session.openedAt)}</span>
                              <span className="mt-1 block">Cierre: {session.closedAt ? formatDateTime(session.closedAt) : 'Sin hora registrada'}</span>
                            </p>
                          </div>
                          <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-[0.65rem] uppercase tracking-[0.22em] text-emerald-200">
                            Cerrada
                          </span>
                        </div>
                        <div className="mt-3 grid gap-2 text-sm text-mist sm:grid-cols-2">
                          <p>Vendido: {formatCurrency(session.summary?.grossSales ?? 0)}</p>
                          <p>Cobrado: {formatCurrency(session.summary?.totalCollected ?? 0)}</p>
                          <p>
                            Mesas:{' '}
                            {selectedHistoricalSession?.id === session.id
                              ? isHistoricalSessionLoading || historicalSessionDetail.error ? '-' : selectedHistoricalSessionSales.length
                              : '-'}
                          </p>
                          <p>Productos: {session.summary?.products.reduce((sum, item) => sum + item.quantity, 0) ?? 0}</p>
                        </div>
                      </button>

                      {selectedHistoricalSession?.id === session.id ? (
                        <div className="space-y-4 rounded-[1.2rem] border border-white/8 bg-white/[0.02] p-4">
                          <div className="grid gap-3 sm:grid-cols-2">
                            <SummaryPill label="Jornada" value={selectedHistoricalSession.sessionLabel} />
                            <SummaryPill label="Fecha contable" value={selectedHistoricalSession.businessDate} />
                            <SummaryPill label="Apertura" value={formatDateTime(selectedHistoricalSession.openedAt)} />
                            <SummaryPill label="Cierre" value={selectedHistoricalSession.closedAt ? formatDateTime(selectedHistoricalSession.closedAt) : 'Sin hora registrada'} />
                            <SummaryPill label="Vendido" value={formatCurrency(selectedHistoricalSession.summary?.grossSales ?? 0)} />
                            <SummaryPill label="Cobrado" value={formatCurrency(selectedHistoricalSession.summary?.totalCollected ?? 0)} />
                            <SummaryPill label="Efectivo" value={formatCurrency(selectedHistoricalSessionCashTotal)} />
                            <SummaryPill label="Transferencias" value={formatCurrency(selectedHistoricalSessionNonCashTotal)} />
                            <SummaryPill label="Pendiente" value={formatCurrency(selectedHistoricalSession.summary?.pendingBalance ?? 0)} />
                            <SummaryPill label="Mesas cerradas" value={isHistoricalSessionLoading || historicalSessionDetail.error ? '-' : String(selectedHistoricalSessionSales.length)} />
                          </div>

                          <details className="rounded-[1rem] border border-white/8 bg-black/15 p-4">
                            <summary className="cursor-pointer text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyanGlow/24">
                              Productos vendidos ({selectedHistoricalSession.summary?.products.length ?? 0})
                            </summary>
                            <div className="mt-3">
                            <SalesSessionProductsSummary
                              products={selectedHistoricalSession.summary?.products ?? []}
                              emptyMessage="No hay productos resumidos en esta jornada."
                            />
                            </div>
                          </details>

                          <div className="space-y-3">
                            {isHistoricalSessionLoading ? <p role="status" className="text-sm text-mist">Cargando mesas de la jornada...</p> : null}
                            {!isHistoricalSessionLoading && historicalSessionDetail.error ? (
                              <div role="alert" className="space-y-3 text-sm text-rose-100">
                                <p>{historicalSessionDetail.error}</p>
                                <button type="button" onClick={() => setHistoricalSessionRetry((retry) => retry + 1)} className={ghostButtonClassName}>Reintentar</button>
                              </div>
                            ) : null}
                            {selectedHistoricalSessionSales.map((order) => (
                              <details key={order.id} className="rounded-[1.2rem] border border-white/8 bg-white/[0.02] p-4">
                                <summary className="list-none cursor-pointer">
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                      <p className="font-medium text-ivory">{resolveOrderTableLabel(order, tablesById)}</p>
                                      <p className="mt-1 text-xs uppercase tracking-[0.18em] text-cyanGlow/75">
                                        <span className="block">Apertura: {formatDateTime(order.openedAt)}</span>
                                        <span className="mt-1 block">Cierre: {order.closedAt ? formatDateTime(order.closedAt) : 'Sin hora registrada'}</span>
                                      </p>
                                    </div>
                                    <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-3 py-1 text-[0.65rem] uppercase tracking-[0.22em] text-emerald-200">
                                      Pagada
                                    </span>
                                  </div>
                                  <div className="mt-3 grid gap-2 text-sm text-mist">
                                    <p>Total: {formatCurrency(order.summary.totalDue)}</p>
                                    <p>Pagado: {formatCurrency(order.summary.totalPaid)}</p>
                                    <p>Metodos: {formatPaymentMethodsSummary(order.payments.filter((payment) => payment.status === 'confirmed'))}</p>
                                  </div>
                                </summary>

                                <div className="mt-4 space-y-4 border-t border-white/8 pt-4">
                                  <div>
                                    <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Productos</p>
                                    <div className="mt-3 space-y-2">
                                      {order.items
                                        .filter((item) => item.operationalStatus !== 'cancelled')
                                        .map((item) => (
                                          <div key={item.id} className="rounded-[1rem] border border-white/8 bg-black/15 px-3 py-3 text-sm text-mist">
                                            <div className="flex items-start justify-between gap-3">
                                              <p className="font-medium text-ivory">
                                                {item.quantity} × {item.productName}
                                              </p>
                                              <p>{formatCurrency(item.totalPrice)}</p>
                                            </div>
                                            {item.notes ? <p className="mt-2 text-sm text-cyanGlow">{item.notes}</p> : null}
                                          </div>
                                        ))}
                                    </div>
                                  </div>

                                  <div>
                                    <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Pagos registrados</p>
                                    <div className="mt-3 space-y-2">
                                      {order.payments.map((payment) => (
                                        <div key={payment.id} className="rounded-[1rem] border border-white/8 bg-black/15 px-3 py-3 text-sm text-mist">
                                          <div className="flex flex-wrap items-start justify-between gap-3">
                                            <div>
                                              <p className="font-medium text-ivory">{paymentMethodLabels[payment.method]}</p>
                                              <p className="mt-1 text-xs uppercase tracking-[0.18em] text-mist">{formatDateTime(payment.confirmedAt ?? payment.createdAt)}</p>
                                            </div>
                                            <div className="text-right">
                                              <p className="font-medium text-ivory">{formatCurrency(payment.amountApplied)}</p>
                                              <p className="mt-1 text-xs uppercase tracking-[0.18em] text-mist">
                                                {payment.status === 'confirmed' ? 'Confirmado' : payment.status === 'rejected' ? 'Rechazado' : 'Pendiente'}
                                              </p>
                                            </div>
                                          </div>
                                          {payment.reference ? <p className="mt-2 text-sm text-amberGlow">{payment.reference}</p> : null}
                                          {payment.notes ? <p className="mt-2 text-sm text-cyanGlow">{payment.notes}</p> : null}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                </div>
                              </details>
                            ))}
                            {!isHistoricalSessionLoading && !historicalSessionDetail.error && !selectedHistoricalSessionSales.length ? <EmptyState message="Esta jornada todavia no tiene mesas cerradas asociadas." /> : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ))}
                  {!previousClosedSessions.length ? <EmptyState message="Todavia no hay jornadas cerradas guardadas." /> : null}
                </div>
              </div>
            ) : null}

            {cashierRightPanel === 'validations' ? (
              (posState?.pendingPayments ?? []).length ? (
                <div className="space-y-3">
                  {(posState?.pendingPayments ?? []).map((payment) => {
                    const paymentOrder = ordersById.get(payment.orderId);
                    return (
                      <article
                        key={payment.id}
                        ref={(node) => {
                          pendingPaymentCardRefs.current[payment.id] = node;
                        }}
                        tabIndex={-1}
                        className={`rounded-[1.2rem] border p-4 ${
                          highlightedPendingPaymentId === payment.id ? 'border-cyanGlow/35 bg-cyanGlow/10' : 'border-white/8 bg-black/15'
                        }`}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <p className="font-medium text-ivory">{paymentMethodLabels[payment.method]}</p>
                            <p className="mt-1 text-xs uppercase tracking-[0.18em] text-cyanGlow/75">
                              {paymentOrder ? resolveOrderTableLabel(paymentOrder, tablesById) : 'Mesa sin contexto'}
                            </p>
                            <p className="mt-2 text-sm text-mist">{formatCurrency(payment.amountApplied)}</p>
                            {payment.reference ? <p className="mt-2 text-sm text-amberGlow">{payment.reference}</p> : null}
                            {highlightedPendingPaymentId === payment.id ? (
                              <p className="mt-2 text-sm text-cyanGlow">Pago recien registrado. Confirma o rechaza este movimiento ahora.</p>
                            ) : null}
                          </div>
                          <div className="flex gap-2">
                            <button type="button" onClick={() => void handleConfirmPendingPayment(payment.id)} className={primaryButtonClassName}>
                              Confirmar
                            </button>
                            <button type="button" onClick={() => void handleRejectPendingPayment(payment.id)} className={dangerButtonClassName}>
                              Rechazar
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <EmptyState message="No hay transferencias ni pagos manuales pendientes por revisar." />
              )
            ) : null}

            {cashierRightPanel === 'movements' ? (
              <div className="space-y-3">
                {(posState?.logs ?? []).slice(0, 12).map((log) => {
                  const contextLabel = resolveLogContextLabel(log, ordersById, tablesById);
                  const productLabel = resolveLogProductLabel(log);
                  const lineItems = resolveLogLineItems(log);
                  const isExpanded = expandedTraceLogIds.includes(log.id);

                  return (
                    <article key={log.id} className="rounded-[1.2rem] border border-white/8 bg-white/[0.02] p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-ivory">{formatPosEventLabel(log.eventType)}</p>
                          <p className="mt-1 text-xs uppercase tracking-[0.18em] text-cyanGlow/75">{formatDateTime(log.createdAt)}</p>
                        </div>
                        <span className="rounded-full border border-white/8 bg-black/20 px-3 py-1 text-[0.65rem] uppercase tracking-[0.22em] text-mist">
                          {formatOperatorIdentity(log.actorEmail)}
                        </span>
                      </div>
                      {contextLabel ? <p className="mt-3 text-sm text-mist">{contextLabel}</p> : null}
                      {productLabel ? <p className="mt-1 text-sm text-ivory">{productLabel}</p> : null}
                      {log.notes ? <p className="mt-2 text-sm text-cyanGlow">{log.notes}</p> : null}
                      {lineItems.length ? (
                        <div className="mt-3">
                          <button
                            type="button"
                            onClick={() => toggleTraceLogDetails(log.id)}
                            className="interactive-button rounded-full border border-cyanGlow/30 bg-cyanGlow/10 px-3 py-1.5 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-cyanGlow transition hover:border-cyanGlow/55 hover:bg-cyanGlow/16"
                          >
                            {isExpanded ? 'Ocultar lineas' : `Ver lineas (${lineItems.length})`}
                          </button>
                          {isExpanded ? (
                            <div className="mt-3 space-y-2">
                              {lineItems.map((line, index) => (
                                <div key={`${log.id}-${line.id ?? index}`} className="rounded-[0.9rem] border border-white/8 bg-black/20 px-3 py-2">
                                  <div className="flex items-start justify-between gap-3">
                                    <p className="text-sm font-medium text-ivory">{line.productName}</p>
                                    <span className="shrink-0 text-xs uppercase tracking-[0.16em] text-cyanGlow">{line.quantity} und.</span>
                                  </div>
                                  {line.prepArea ? <p className="mt-1 text-xs uppercase tracking-[0.16em] text-mist">{line.prepArea === 'kitchen' ? 'Cocina' : 'Bar'}</p> : null}
                                  {line.notes ? <p className="mt-1 text-sm text-amberGlow">{line.notes}</p> : null}
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
                {!(posState?.logs ?? []).length ? <EmptyState message="Todavia no hay movimientos recientes en la trazabilidad POS." /> : null}
              </div>
            ) : null}
          </Panel>
        </section>
      ) : null}
    </AdminLayout>
  );
}

type RealtimeSignalTarget = 'bar' | 'cashier' | 'floor' | 'kitchen';
type RealtimeSignalTone = 'cashier' | 'prep' | 'ready';

interface RealtimeSignal {
  body: string;
  dedupeKey: string;
  target: RealtimeSignalTarget;
  title: string;
  tone: RealtimeSignalTone;
}

function getRealtimeItemInsert(state: PosState, event: PosRealtimeEvent) {
  const item = mapPosRealtimeOrderItem(event.newRecord);
  if (!item) {
    return null;
  }
  const order = state.openOrders.find((order) => order.id === item.orderId);
  const table = state.tables.find((table) => table.id === order?.tableId && table.activeOrder?.id === order?.id);
  const existingItem = findRealtimeOrderItem(state, item.id);
  if (!order || !table || (existingItem && existingItem.orderId !== item.orderId)) {
    return null;
  }
  return { item, order, table };
}

function mergeRealtimeItemInsert(state: PosState, event: PosRealtimeEvent) {
  const insert = getRealtimeItemInsert(state, event);
  if (!insert || findRealtimeOrderItem(state, insert.item.id)) {
    return state;
  }
  const { item, order, table } = insert;
  const items = [...order.items, item];
  const summary = buildOrderSummaryForUi(items, order.payments);
  const updatedOrder = { ...order, items, summary, financialStatus: deriveOrderFinancialStatusForUi(items, summary) };
  const updatedTable = { ...table, activeOrder: updatedOrder };
  const queues = buildPendingPreparationListsFromTables([updatedTable]);
  const mergeQueue = (current: PosOrderItem[], incoming: PosOrderItem[]) =>
    [...current.filter((item) => item.orderId !== order.id), ...incoming]
      .sort((left, right) => resolvePreparationQueueTimestampForUi(left).localeCompare(resolvePreparationQueueTimestampForUi(right)));
  return {
    ...state,
    generatedAt: new Date().toISOString(),
    tables: state.tables.map((entry) => entry.id === table.id ? updatedTable : entry),
    openOrders: state.openOrders.map((entry) => entry.id === order.id ? updatedOrder : entry),
    pendingPreparationKitchen: mergeQueue(state.pendingPreparationKitchen, queues.pendingPreparationKitchen),
    pendingPreparationBar: mergeQueue(state.pendingPreparationBar, queues.pendingPreparationBar),
  };
}

function stillRequiresPendingRealtimeReload(event: PosRealtimeEvent, state: PosState) {
  if (event.eventType === 'DELETE') {
    return true;
  }
  if (event.table === 'pos_order_items') {
    const item = mapPosRealtimeOrderItem(event.newRecord);
    const existingItem = item ? findRealtimeOrderItem(state, item.id) : null;
    return !item || !existingItem || existingItem.orderId !== item.orderId || !getRealtimeItemInsert(state, event);
  }
  if (event.table === 'pos_orders' && event.newRecord) {
    const record = event.newRecord;
    const order = state.openOrders.find((order) => order.id === record.id);
    const table = state.tables.find((table) => table.id === record.table_id);
    const sessionExists = state.recentSalesSessions.some((session) => session.id === record.sales_session_id);
    return !order || !table || table.activeOrder?.id !== order.id || order.tableId !== table.id ||
      !sessionExists || order.salesSessionId !== record.sales_session_id;
  }
  return true;
}

function applyRealtimeEventToPosState(state: PosState, event: PosRealtimeEvent) {
  if (event.table === 'pos_order_status_logs' && event.eventType === 'INSERT') {
    const log = mapPosRealtimeLog(event.newRecord);
    if (!log || state.logs.some((entry) => entry.id === log.id)) {
      return state;
    }
    return { ...state, logs: [...state.logs, log].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, 15) };
  }
  if (event.table === 'pos_order_items' && event.eventType === 'INSERT') {
    return mergeRealtimeItemInsert(state, event);
  }
  if (event.table === 'pos_tables' && event.newRecord) {
    const record = event.newRecord;
    const tableId = asString(record.id);
    if (!tableId) {
      return state;
    }

    const activeOrderId = asNullableString(record.active_order_id);
    const tables = state.tables.map((table) => {
      if (table.id !== tableId) {
        return table;
      }

      const activeOrder =
        activeOrderId && table.activeOrder?.id !== activeOrderId
          ? state.openOrders.find((order) => order.id === activeOrderId) ?? null
          : activeOrderId
            ? table.activeOrder
            : null;

      return {
        ...table,
        activeOrder,
        activeOrderId,
        assignedStaffEmail: asNullableString(record.assigned_staff_email),
        capacity: asNumber(record.capacity) ?? table.capacity ?? null,
        code: asString(record.code) || table.code,
        name: asString(record.name) || table.name,
        notes: asString(record.notes) || table.notes,
        status: (asString(record.status) as PosTable['status']) || table.status,
        type: (asString(record.type) as PosTable['type']) || table.type,
        updatedAt: asString(record.updated_at) || table.updatedAt,
        zone: (asString(record.zone) as PosTable['zone']) || table.zone,
      };
    });

    return rebuildDerivedStateFromTables(state, tables);
  }

  if (event.table === 'pos_orders' && event.newRecord) {
    const orderId = asString(event.newRecord.id);
    const destinationTableId = asString(event.newRecord.table_id);
    if (!orderId || !destinationTableId) {
      return state;
    }

    const existingOrder = state.openOrders.find((order) => order.id === orderId) ?? state.closedSales.find((order) => order.id === orderId);
    if (!existingOrder) {
      return state;
    }

    const updatedOrder = {
      ...existingOrder,
      assignedStaffEmail: asNullableString(event.newRecord.assigned_staff_email) ?? existingOrder.assignedStaffEmail ?? null,
      cancellationReason: asNullableString(event.newRecord.cancellation_reason) ?? existingOrder.cancellationReason ?? null,
      cashierEmail: asNullableString(event.newRecord.cashier_email) ?? existingOrder.cashierEmail ?? null,
      closedAt: asNullableString(event.newRecord.closed_at),
      financialStatus: (asString(event.newRecord.financial_status) as PosOrderWithRelations['financialStatus']) || existingOrder.financialStatus,
      notes: asNullableString(event.newRecord.notes) ?? existingOrder.notes ?? '',
      salesSessionId: asNullableString(event.newRecord.sales_session_id) ?? existingOrder.salesSessionId ?? null,
      tableId: destinationTableId,
      updatedAt: asString(event.newRecord.updated_at) || existingOrder.updatedAt,
    };

    const tables = state.tables.map((table) => {
      if (table.id === destinationTableId) {
        return {
          ...table,
          activeOrder: updatedOrder,
          activeOrderId: orderId,
          assignedStaffEmail: updatedOrder.assignedStaffEmail ?? table.assignedStaffEmail,
          status: 'occupied' as const,
        };
      }

      if (table.activeOrder?.id === orderId || table.activeOrderId === orderId) {
        return {
          ...table,
          activeOrder: null,
          activeOrderId: null,
          assignedStaffEmail: null,
          status: 'available' as const,
        };
      }

      return table;
    });

    return rebuildDerivedStateFromTables(state, tables);
  }

  if (event.table === 'pos_order_items' && event.newRecord) {
    const itemId = asString(event.newRecord.id);
    if (!itemId) {
      return state;
    }

    const existingItem = findRealtimeOrderItem(state, itemId);
    if (!existingItem) {
      return state;
    }

    return mergeUpdatedItemsIntoPosState(state, [
      {
        ...existingItem,
        cancelledAt: asNullableString(event.newRecord.cancelled_at) ?? existingItem.cancelledAt ?? null,
        cancelledByEmail: asNullableString(event.newRecord.cancelled_by_email) ?? existingItem.cancelledByEmail ?? null,
        cancellationReason: asNullableString(event.newRecord.cancellation_reason) ?? existingItem.cancellationReason ?? null,
        deliveredAt: asNullableString(event.newRecord.delivered_at) ?? existingItem.deliveredAt ?? null,
        deliveredByEmail: asNullableString(event.newRecord.delivered_by_email) ?? existingItem.deliveredByEmail ?? null,
        financialStatus: (asString(event.newRecord.financial_status) as PosOrderItem['financialStatus']) || existingItem.financialStatus,
        notes: asNullableString(event.newRecord.notes) ?? existingItem.notes ?? '',
        operationalStatus: (asString(event.newRecord.operational_status) as PosOrderItem['operationalStatus']) || existingItem.operationalStatus,
        pickingUpAt: asNullableString(event.newRecord.picking_up_at) ?? existingItem.pickingUpAt ?? null,
        pickingUpByEmail: asNullableString(event.newRecord.picking_up_by_email) ?? existingItem.pickingUpByEmail ?? null,
        preparationStartedAt: asNullableString(event.newRecord.preparation_started_at) ?? existingItem.preparationStartedAt ?? null,
        quantity: asNumber(event.newRecord.quantity) ?? existingItem.quantity,
        readyAt: asNullableString(event.newRecord.ready_at) ?? existingItem.readyAt ?? null,
        sentAt: asNullableString(event.newRecord.sent_at) ?? existingItem.sentAt ?? null,
        totalPrice: asNumber(event.newRecord.total_price) ?? existingItem.totalPrice,
        unitPrice: asNumber(event.newRecord.unit_price) ?? existingItem.unitPrice,
        updatedAt: asString(event.newRecord.updated_at) || existingItem.updatedAt,
        updatedByEmail: asNullableString(event.newRecord.updated_by_email) ?? existingItem.updatedByEmail ?? null,
      },
    ]);
  }

  if (event.table === 'pos_payments' && event.newRecord) {
    const paymentId = asString(event.newRecord.id);
    const orderId = asString(event.newRecord.order_id);
    if (!paymentId || !orderId) {
      return state;
    }

    const existingPayment = findRealtimePayment(state, paymentId);
    const basePayment = existingPayment ?? {
      allocationMode: (asString(event.newRecord.allocation_mode) as PaymentAllocationMode) || 'total',
      amountApplied: asNumber(event.newRecord.amount_applied) ?? 0,
      amountReceived: asNumber(event.newRecord.amount_received),
      changeDue: asNumber(event.newRecord.change_due),
      confirmedAt: asNullableString(event.newRecord.confirmed_at),
      confirmedByEmail: asNullableString(event.newRecord.confirmed_by_email),
      createdAt: asString(event.newRecord.created_at) || new Date().toISOString(),
      createdByEmail: asString(event.newRecord.created_by_email) || '',
      id: paymentId,
      method: (asString(event.newRecord.method) as PaymentMethod) || 'other',
      notes: asNullableString(event.newRecord.notes),
      orderId,
      percentageApplied: asNumber(event.newRecord.percentage_applied),
      reference: asNullableString(event.newRecord.reference),
      rejectedAt: asNullableString(event.newRecord.rejected_at),
      rejectedByEmail: asNullableString(event.newRecord.rejected_by_email),
      rejectionReason: asNullableString(event.newRecord.rejection_reason),
      salesSessionId: asNullableString(event.newRecord.sales_session_id),
      status: (asString(event.newRecord.status) as PosPayment['status']) || 'pending',
      targetItemIds: Array.isArray(event.newRecord.target_item_ids) ? (event.newRecord.target_item_ids as string[]) : [],
    };

    return mergePaymentIntoPosState(state, {
      ...basePayment,
      allocationMode: (asString(event.newRecord.allocation_mode) as PaymentAllocationMode) || basePayment.allocationMode,
      amountApplied: asNumber(event.newRecord.amount_applied) ?? basePayment.amountApplied,
      amountReceived: asNumber(event.newRecord.amount_received) ?? basePayment.amountReceived ?? null,
      changeDue: asNumber(event.newRecord.change_due) ?? basePayment.changeDue ?? null,
      confirmedAt: asNullableString(event.newRecord.confirmed_at) ?? basePayment.confirmedAt ?? null,
      confirmedByEmail: asNullableString(event.newRecord.confirmed_by_email) ?? basePayment.confirmedByEmail ?? null,
      createdAt: asString(event.newRecord.created_at) || basePayment.createdAt,
      createdByEmail: asString(event.newRecord.created_by_email) || basePayment.createdByEmail,
      method: (asString(event.newRecord.method) as PaymentMethod) || basePayment.method,
      notes: asNullableString(event.newRecord.notes) ?? basePayment.notes ?? null,
      percentageApplied: asNumber(event.newRecord.percentage_applied) ?? basePayment.percentageApplied ?? null,
      reference: asNullableString(event.newRecord.reference) ?? basePayment.reference ?? null,
      rejectedAt: asNullableString(event.newRecord.rejected_at) ?? basePayment.rejectedAt ?? null,
      rejectedByEmail: asNullableString(event.newRecord.rejected_by_email) ?? basePayment.rejectedByEmail ?? null,
      rejectionReason: asNullableString(event.newRecord.rejection_reason) ?? basePayment.rejectionReason ?? null,
      salesSessionId: asNullableString(event.newRecord.sales_session_id) ?? basePayment.salesSessionId ?? null,
      status: (asString(event.newRecord.status) as PosPayment['status']) || basePayment.status,
      targetItemIds: Array.isArray(event.newRecord.target_item_ids) ? (event.newRecord.target_item_ids as string[]) : basePayment.targetItemIds,
    });
  }

  return state;
}

function shouldReloadAfterRealtimeEvent(event: PosRealtimeEvent, state: PosState | null) {
  if (!state) {
    return true;
  }

  if (event.table === 'pos_order_status_logs') {
    return false;
  }

  if (event.table === 'pos_tables') {
    const tableId = asString(event.newRecord?.id ?? event.oldRecord?.id);
    return !tableId || !state.tables.some((table) => table.id === tableId);
  }

  if (event.table === 'pos_order_items') {
    if (event.eventType === 'INSERT') {
      return !getRealtimeItemInsert(state, event);
    }
    const itemId = asString(event.newRecord?.id ?? event.oldRecord?.id);
    return !itemId || !findRealtimeOrderItem(state, itemId);
  }

  if (event.table === 'pos_payments') {
    const orderId = asString(event.newRecord?.order_id ?? event.oldRecord?.order_id);
    const paymentId = asString(event.newRecord?.id ?? event.oldRecord?.id);
    const orderExists = Boolean(
      orderId && [...state.openOrders, ...state.closedSales].some((order) => order.id === orderId),
    );

    return !paymentId || !orderExists;
  }

  if (event.table === 'pos_orders') {
    const orderId = asString(event.newRecord?.id ?? event.oldRecord?.id);
    const existingOrder = orderId
      ? state.openOrders.find((order) => order.id === orderId) ?? state.closedSales.find((order) => order.id === orderId)
      : null;

    return !existingOrder;
  }

  return true;
}

function resolveRealtimeSignal(event: PosRealtimeEvent, state: PosState | null, currentActorEmail: string): RealtimeSignal | null {
  if (event.table === 'pos_order_items' && event.eventType === 'UPDATE' && event.newRecord) {
    const newStatus = String(event.newRecord.operational_status ?? '');
    const oldStatus = String(event.oldRecord?.operational_status ?? '');
    const updatedByEmail = String(event.newRecord.updated_by_email ?? event.newRecord.created_by_email ?? '').trim().toLowerCase();

    if (!newStatus || newStatus === oldStatus || updatedByEmail === currentActorEmail) {
      return null;
    }

    const itemId = String(event.newRecord.id ?? '');
    const prepArea = String(event.newRecord.prep_area ?? '');
    const quantity = Number(event.newRecord.quantity ?? 0);
    const productName = String(event.newRecord.product_name ?? 'Producto');
    const tableLabel = resolveRealtimeItemTableLabel(state, itemId);
    const itemSummary = `${quantity > 0 ? `${quantity} x ` : ''}${productName}`;
    const suffix = tableLabel ? ` · ${tableLabel}` : '';

    if (newStatus === 'pending_preparation') {
      return {
        body: `${itemSummary}${suffix}`,
        dedupeKey: `item:${itemId}:pending_preparation`,
        target: prepArea === 'kitchen' ? 'kitchen' : 'bar',
        title: prepArea === 'kitchen' ? 'Nuevo pedido en cocina' : 'Nuevo pedido en bar',
        tone: 'prep',
      };
    }

    if (newStatus === 'ready') {
      return {
        body: `${itemSummary}${suffix}`,
        dedupeKey: `item:${itemId}:ready`,
        target: 'floor',
        title: 'Producto listo para recoger',
        tone: 'ready',
      };
    }

    if (newStatus === 'picking_up') {
      return {
        body: `${itemSummary}${suffix}`,
        dedupeKey: `item:${itemId}:picking_up`,
        target: 'floor',
        title: 'Producto en recogida',
        tone: 'ready',
      };
    }

    return null;
  }

  if (event.table === 'pos_payments' && event.eventType === 'INSERT' && event.newRecord) {
    const status = String(event.newRecord.status ?? '');
    const createdByEmail = String(event.newRecord.created_by_email ?? '').trim().toLowerCase();
    if (status !== 'pending' || createdByEmail === currentActorEmail) {
      return null;
    }

    const paymentId = String(event.newRecord.id ?? '');
    const orderId = String(event.newRecord.order_id ?? '');
    const amountApplied = Number(event.newRecord.amount_applied ?? 0);
    const method = String(event.newRecord.method ?? 'pago');
    const order = state?.openOrders.find((entry) => entry.id === orderId) ?? state?.closedSales.find((entry) => entry.id === orderId) ?? null;
    const tableLabel = order ? resolveOrderTableLabel(order, new Map((state?.tables ?? []).map((table) => [table.id, table]))) : '';

    return {
      body: `${paymentMethodLabels[method as PaymentMethod] ?? method} · ${formatCurrency(amountApplied)}${tableLabel ? ` · ${tableLabel}` : ''}`,
      dedupeKey: `payment:${paymentId}:pending`,
      target: 'cashier',
      title: 'Pago pendiente por validar',
      tone: 'cashier',
    };
  }

  return null;
}

function findRealtimeOrderItem(state: PosState, itemId: string) {
  for (const order of [...state.openOrders, ...state.closedSales]) {
    const item = order.items.find((entry) => entry.id === itemId);
    if (item) {
      return item;
    }
  }

  return null;
}

function findRealtimePayment(state: PosState, paymentId: string) {
  for (const order of [...state.openOrders, ...state.closedSales]) {
    const payment = order.payments.find((entry) => entry.id === paymentId);
    if (payment) {
      return payment;
    }
  }

  return null;
}

function asString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function asNullableString(value: unknown) {
  return typeof value === 'string' ? value : value == null ? null : String(value);
}

function asNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function resolveRealtimeItemTableLabel(state: PosState | null, itemId: string) {
  if (!state || !itemId) {
    return '';
  }

  for (const order of [...state.openOrders, ...state.closedSales]) {
    const item = order.items.find((entry) => entry.id === itemId);
    if (!item) {
      continue;
    }

    const table = state.tables.find((entry) => entry.id === order.tableId);
    if (table) {
      return `${table.name} · ${table.code}`;
    }

    if (item.tableName || item.tableCode) {
      return `${item.tableName ?? 'Mesa'}${item.tableCode ? ` · ${item.tableCode}` : ''}`;
    }
  }

  return '';
}

function triggerRealtimeAttention(
  signal: RealtimeSignal,
  audioContext: AudioContext | null,
  recentKeys: Map<string, number>,
) {
  const now = Date.now();
  const recentTs = recentKeys.get(signal.dedupeKey);
  if (recentTs && now - recentTs < 1400) {
    return;
  }

  recentKeys.set(signal.dedupeKey, now);
  for (const [key, timestamp] of recentKeys.entries()) {
    if (now - timestamp > 8000) {
      recentKeys.delete(key);
    }
  }

  playRealtimeTone(audioContext, signal.tone);

  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(signal.tone === 'ready' ? [160, 80, 160] : [220, 110, 220]);
  }

  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const notification = new Notification(signal.title, {
        body: signal.body,
        tag: signal.dedupeKey,
      });
      window.setTimeout(() => notification.close(), 4200);
    } catch {
      // noop
    }
  }
}

function playRealtimeTone(audioContext: AudioContext | null, tone: RealtimeSignalTone) {
  if (!audioContext) {
    return;
  }

  if (audioContext.state === 'suspended') {
    void audioContext.resume().catch(() => {});
  }

  const startAt = audioContext.currentTime;
  const frequencies =
    tone === 'ready'
      ? [880, 1174]
      : tone === 'cashier'
        ? [784, 988]
        : [659, 880];

  frequencies.forEach((frequency, index) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = tone === 'prep' ? 'square' : 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, startAt + index * 0.16);
    gain.gain.exponentialRampToValueAtTime(0.06, startAt + index * 0.16 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + index * 0.16 + 0.18);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(startAt + index * 0.16);
    oscillator.stop(startAt + index * 0.16 + 0.2);
  });
}

function PreparationQueuePanel({
  areaLabel,
  busyAction,
  items,
  onDirectDelivered,
  onMoveStatus,
  operationalFlowSettings,
  title,
}: {
  areaLabel: string;
  busyAction: string | null;
  items: PosOrderItem[];
  onDirectDelivered: (item: PosOrderItem) => Promise<void>;
  onMoveStatus: (item: PosOrderItem, nextStatus: 'in_process' | 'ready') => Promise<void>;
  operationalFlowSettings: PosOperationalFlowSettings;
  title: string;
}) {
  return (
    <section className="mt-8">
      <Panel title={title} subtitle={`Solo ves la cola operativa que corresponde a ${areaLabel.toLowerCase()}. Cada producto muestra su mesa y origen para facilitar el pickup.`}>
        <div className="space-y-3">
          {items.map((item) => {
            const isDirectDispatch = shouldUseDirectDeliveryStep(item, operationalFlowSettings);
            const shouldUseInProcess = shouldUseInProcessStep(item, operationalFlowSettings, isDirectDispatch);

            return (
            <article key={item.id} className="rounded-[1.2rem] border border-white/8 bg-white/[0.02] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium text-ivory">
                    {item.quantity} × {item.productName}
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {item.tableName ? (
                      <span className="rounded-full border border-cyanGlow/25 bg-cyanGlow/12 px-3 py-1 text-sm font-semibold uppercase tracking-[0.18em] text-cyanGlow">
                        {item.tableName}
                      </span>
                    ) : null}
                    {item.tableCode ? (
                      <span className="text-xs uppercase tracking-[0.18em] text-cyanGlow/75">Mesa {item.tableCode}</span>
                    ) : null}
                    <span className="text-xs uppercase tracking-[0.18em] text-cyanGlow/75">Tanda {item.serviceRound}</span>
                  </div>
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-mist">
                    <span>Estado: {itemStatusLabels[item.operationalStatus]}</span>
                    {isDirectDispatch ? (
                      <span className="rounded-full border border-emerald-300/30 bg-emerald-300/10 px-2.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-emerald-100">
                        Despacho directo
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-2 text-sm text-mist">
                    Pedido por {item.orderOpenedByEmail ?? item.createdByEmail}
                    {item.orderAssignedStaffEmail ? ` · asignado a ${item.orderAssignedStaffEmail}` : ''}
                  </p>
                  {item.notes ? <p className="mt-2 text-sm text-amberGlow">{item.notes}</p> : null}
                </div>
                  <div className="flex flex-wrap gap-2">
                  {isDirectDispatch && isDirectDeliveryCandidate(item) ? (
                    <button type="button" onClick={() => void onDirectDelivered(item)} disabled={Boolean(busyAction)} className={primaryButtonClassName}>
                      Entregar directo
                    </button>
                  ) : null}
                  {!isDirectDispatch && ['pending_preparation', 'sent'].includes(item.operationalStatus) ? (
                    <button
                      type="button"
                      onClick={() => void onMoveStatus(item, shouldUseInProcess ? 'in_process' : 'ready')}
                      disabled={Boolean(busyAction)}
                      className={shouldUseInProcess ? ghostButtonClassName : primaryButtonClassName}
                    >
                      {shouldUseInProcess ? 'En proceso' : 'Marcar listo'}
                    </button>
                  ) : null}
                  {!isDirectDispatch && item.operationalStatus === 'in_process' ? (
                    <button type="button" onClick={() => void onMoveStatus(item, 'ready')} disabled={Boolean(busyAction)} className={primaryButtonClassName}>
                      Marcar listo
                    </button>
                  ) : null}
                </div>
              </div>
            </article>
            );
          })}
          {!items.length ? <EmptyState message="No hay productos pendientes en esta cola por ahora." /> : null}
        </div>
      </Panel>
    </section>
  );
}

function OperationalFlowSettingsPanel({
  busyAction,
  onToggle,
  savingArea,
  settings,
}: {
  busyAction: string | null;
  onToggle: (area: PosOrderItem['prepArea'], field: keyof PosOperationalFlowSettings[PosOrderItem['prepArea']], value: boolean) => Promise<void>;
  savingArea: PosOrderItem['prepArea'] | null;
  settings: PosOperationalFlowSettings;
}) {
  const areas: Array<{ area: PosOrderItem['prepArea']; label: string }> = [
    { area: 'kitchen', label: 'Cocina' },
    { area: 'bar', label: 'Bar' },
  ];

  return (
    <section>
      <Panel title="Flujo operativo" subtitle="Elige que pasos ve cada area. Cada cambio afecta los botones disponibles y conserva la trazabilidad.">
        <div className="grid gap-3 md:grid-cols-2">
          {areas.map(({ area, label }) => (
            <article key={area} className="rounded-[1.1rem] border border-white/8 bg-white/[0.02] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-ivory">{label}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.18em] text-cyanGlow/75">{savingArea === area ? 'Guardando' : 'Configurado'}</p>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <FlowSwitch
                  checked={settings[area].useDirectDelivery}
                  description="Activo: muestra Entregar directo y salta Listo. Apagado: primero se marca Listo."
                  disabled={Boolean(busyAction) || savingArea === area}
                  flowOff="Pedido -> Listo -> Entregado"
                  flowOn="Pedido -> Entregado"
                  label="Entrega directa"
                  onChange={(value) => void onToggle(area, 'useDirectDelivery', value)}
                />
                <FlowSwitch
                  checked={settings[area].useInProcess}
                  description="Activo: agrega En proceso antes de Listo. Apagado: el producto pasa directo a Listo."
                  disabled={Boolean(busyAction) || savingArea === area}
                  flowOff="Pedido -> Listo"
                  flowOn="Pedido -> En proceso -> Listo"
                  label="En proceso"
                  onChange={(value) => void onToggle(area, 'useInProcess', value)}
                />
                <FlowSwitch
                  checked={settings[area].usePickingUp}
                  description="Activo: agrega Ir a recoger antes de Entregado. Apagado: Listo se entrega con un toque."
                  disabled={Boolean(busyAction) || savingArea === area}
                  flowOff="Listo -> Entregado"
                  flowOn="Listo -> Recogiendo -> Entregado"
                  label="Recogiendo"
                  onChange={(value) => void onToggle(area, 'usePickingUp', value)}
                />
              </div>
            </article>
          ))}
        </div>
      </Panel>
    </section>
  );
}

function FlowSwitch({
  checked,
  description,
  disabled,
  flowOff,
  flowOn,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled: boolean;
  flowOff: string;
  flowOn: string;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`block rounded-[1rem] border border-white/8 bg-black/15 px-3 py-3 ${disabled ? 'opacity-60' : ''}`}>
      <span className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ivory">{label}</span>
          <span className={`mt-1 block text-[0.62rem] font-semibold uppercase tracking-[0.16em] ${checked ? 'text-emerald-200' : 'text-mist'}`}>
            {checked ? 'Activo' : 'Apagado'}
          </span>
        </span>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 h-5 w-10 shrink-0 cursor-pointer accent-cyanGlow disabled:cursor-not-allowed"
        />
      </span>
      <span className="mt-3 block text-xs leading-5 text-mist">{description}</span>
      <span className="mt-3 block rounded-[0.75rem] border border-white/8 bg-white/[0.03] px-2.5 py-2 text-xs leading-5 text-cyanGlow">
        {checked ? flowOn : flowOff}
      </span>
    </label>
  );
}

function Panel({ actions, children, subtitle, title }: { actions?: ReactNode; children: ReactNode; subtitle: string; title: string }) {
  return (
    <section className="rounded-[1.3rem] border border-white/10 bg-white/[0.03] p-4 shadow-[0_18px_40px_rgba(0,0,0,0.2)] sm:rounded-[1.7rem] sm:p-5">
      <div className={actions ? 'flex flex-wrap items-start justify-between gap-3' : undefined}>
        <div className="min-w-0 flex-1">
          <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">{title}</p>
          <p className="mt-2 text-sm leading-6 text-mist sm:mt-3 sm:leading-7">{subtitle}</p>
        </div>
        {actions}
      </div>
      <div className="mt-3 sm:mt-4">{children}</div>
    </section>
  );
}

function MetricCard({ accent = 'ivory', label, value }: { accent?: 'amber' | 'cyan' | 'emerald' | 'ivory'; label: string; value: string }) {
  const accentClassName =
    accent === 'amber' ? 'text-amberGlow' : accent === 'cyan' ? 'text-cyanGlow' : accent === 'emerald' ? 'text-emerald-200' : 'text-ivory';

  return (
    <article className="rounded-[1.15rem] border border-white/10 bg-white/[0.03] px-4 py-3 sm:rounded-[1.5rem] sm:p-5">
      <div className="flex items-center justify-between gap-3 sm:block">
        <p className="text-[0.62rem] uppercase tracking-[0.22em] text-mist sm:text-[0.68rem] sm:tracking-[0.24em]">{label}</p>
        <p className={`font-display text-[1.35rem] leading-none sm:mt-4 sm:text-[2.2rem] ${accentClassName}`}>{value}</p>
      </div>
    </article>
  );
}

function SummaryPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[1rem] border border-white/8 bg-white/[0.02] px-3 py-2.5 sm:rounded-[1.15rem] sm:px-4 sm:py-3">
      <p className="text-[0.68rem] uppercase tracking-[0.22em] text-mist">{label}</p>
      <p className="mt-2 text-sm font-medium text-ivory">{value}</p>
    </div>
  );
}

function SalesSessionProductsSummary({
  emptyMessage,
  products,
}: {
  emptyMessage: string;
  products: PosSalesSessionSummary['products'];
}) {
  const groupedProducts = groupSalesSessionProductsByPrepArea(products);

  if (!groupedProducts.length) {
    return <EmptyState message={emptyMessage} />;
  }

  return (
    <div className="mt-3 space-y-4">
      {groupedProducts.map((group) => (
        <div key={group.prepArea} className="space-y-2">
          <p className="text-[0.68rem] uppercase tracking-[0.18em] text-mist">{group.label}</p>
          <div className="space-y-2">
            {group.products.map((product) => (
              <div
                key={`${group.prepArea}-${product.productName}-${product.menuItemSourceKey ?? 'sin-clave'}`}
                className="flex items-center justify-between gap-3 rounded-[0.9rem] border border-white/8 bg-white/[0.02] px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium text-ivory">{product.productName}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.18em] text-mist">{product.quantity} unidad(es)</p>
                </div>
                <p className="text-mist">{formatCurrency(product.totalAmount)}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="block">
      <span className="text-[0.68rem] uppercase tracking-[0.24em] text-mist">{label}</span>
      <div className="mt-2">{children}</div>
    </label>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="rounded-[1rem] border border-dashed border-white/10 bg-white/[0.02] px-3 py-4 text-sm leading-6 text-mist sm:rounded-[1.2rem] sm:px-4 sm:py-5 sm:leading-7">{message}</div>;
}

function mergeUpdatedItemsIntoPosState(state: PosState, updatedItems: PosOrderItem[]) {
  if (!updatedItems.length) {
    return state;
  }

  const updatesById = new Map(updatedItems.map((item) => [item.id, item]));
  const tables = state.tables.map((table) => {
    if (!table.activeOrder) {
      return table;
    }

    const orderUpdates = updatedItems.filter((item) => item.orderId === table.activeOrder?.id);
    if (!orderUpdates.length) {
      return table;
    }

    const existingItemsById = new Map(table.activeOrder.items.map((item) => [item.id, item]));
    const mergedItems = table.activeOrder.items.map((item) => {
      const updated = updatesById.get(item.id);
      return updated ? { ...item, ...updated } : item;
    });

    for (const updatedItem of orderUpdates) {
      if (!existingItemsById.has(updatedItem.id)) {
        mergedItems.push(updatedItem);
      }
    }

    const summary = buildOrderSummaryForUi(mergedItems, table.activeOrder.payments);

    return {
      ...table,
      activeOrder: {
        ...table.activeOrder,
        financialStatus: deriveOrderFinancialStatusForUi(mergedItems, summary),
        items: mergedItems,
        summary,
      },
    };
  });

  return rebuildDerivedStateFromTables(state, tables);
}

function mergeAddedItemsIntoPosState(state: PosState, selectedTable: PosTableWithOrder, createdItems: PosOrderItem[], actorEmail: string) {
  if (!createdItems.length) {
    return state;
  }

  const now = new Date().toISOString();
  const tables = state.tables.map((table) => {
    if (table.id !== selectedTable.id) {
      return table;
    }

    const existingOrder = table.activeOrder;
    const incomingItemsById = new Map(createdItems.map((item) => [item.id, item]));
    const existingItems = existingOrder?.items ?? [];
    const existingItemIds = new Set(existingItems.map((item) => item.id));
    const items = existingOrder
      ? [
          ...existingItems.map((item) => {
            const incomingItem = incomingItemsById.get(item.id);
            return incomingItem ? { ...item, ...incomingItem } : item;
          }),
          ...createdItems.filter((item) => !existingItemIds.has(item.id)),
        ]
      : [...createdItems];
    const payments = existingOrder?.payments ?? [];
    const summary = buildOrderSummaryForUi(items, payments);
    const nextOrder =
      existingOrder != null
        ? {
            ...existingOrder,
            financialStatus: deriveOrderFinancialStatusForUi(items, summary),
            items,
            summary,
          }
        : {
            assignedStaffEmail: actorEmail,
            cancellationReason: null,
            cashierEmail: null,
            closedAt: null,
            createdAt: now,
            financialStatus: 'pending_payment' as const,
            id: createdItems[0].orderId,
            items,
            notes: '',
            openedAt: now,
            openedByEmail: actorEmail,
            payments: [] as typeof payments,
            summary,
            tableId: table.id,
            updatedAt: now,
          };

    return {
      ...table,
      activeOrder: nextOrder,
      activeOrderId: nextOrder.id,
      assignedStaffEmail: table.assignedStaffEmail ?? actorEmail,
      status: 'occupied' as const,
    };
  });

  return rebuildDerivedStateFromTables(state, tables);
}

function mergePaymentIntoPosState(state: PosState, updatedPayment: PosPayment) {
  const tables = state.tables.map((table) => {
    if (!table.activeOrder || table.activeOrder.id !== updatedPayment.orderId) {
      return table;
    }

    const existingIndex = table.activeOrder.payments.findIndex((payment) => payment.id === updatedPayment.id);
    const payments =
      existingIndex >= 0
        ? table.activeOrder.payments.map((payment) => (payment.id === updatedPayment.id ? { ...payment, ...updatedPayment } : payment))
        : [...table.activeOrder.payments, updatedPayment];
    const summary = buildOrderSummaryForUi(table.activeOrder.items, payments);

    return {
      ...table,
      activeOrder: {
        ...table.activeOrder,
        financialStatus: deriveOrderFinancialStatusForUi(table.activeOrder.items, summary),
        payments,
        summary,
      },
    };
  });

  return rebuildDerivedStateFromTables(state, tables);
}

function insertTableIntoPosState(state: PosState, createdTable: PosTable) {
  const tables = [...state.tables, { ...createdTable, activeOrder: null }].sort((left, right) => left.code.localeCompare(right.code));
  return rebuildDerivedStateFromTables(state, tables);
}

function removeTableFromPosState(state: PosState, tableId: string) {
  const tables = state.tables.filter((table) => table.id !== tableId);
  return rebuildDerivedStateFromTables(state, tables);
}

function updateTableInPosState(state: PosState, updatedTable: PosTable) {
  const tables = state.tables
    .map((table) => (table.id === updatedTable.id ? { ...table, ...updatedTable, activeOrder: table.activeOrder ?? null } : table))
    .sort((left, right) => left.code.localeCompare(right.code));
  return rebuildDerivedStateFromTables(state, tables);
}

function mergeMovedOrderIntoPosState(state: PosState, result: MovePosActiveOrderResult) {
  const existingOrder =
    state.openOrders.find((order) => order.id === result.order.id) ??
    state.closedSales.find((order) => order.id === result.order.id) ??
    state.tables.flatMap((table) => (table.activeOrder ? [table.activeOrder] : [])).find((order) => order.id === result.order.id) ??
    null;

  const movedOrder = existingOrder
    ? {
        ...existingOrder,
        ...result.order,
        items: existingOrder.items,
        payments: existingOrder.payments,
        summary: existingOrder.summary,
        tableId: result.destinationTable.id,
      }
    : null;

  const tables = state.tables.map((table) => {
    if (table.id === result.sourceTable.id) {
      return {
        ...table,
        ...result.sourceTable,
        activeOrder: null,
      };
    }

    if (table.id === result.destinationTable.id) {
      return {
        ...table,
        ...result.destinationTable,
        activeOrder: movedOrder,
      };
    }

    if (table.activeOrder?.id === result.order.id || table.activeOrderId === result.order.id) {
      return {
        ...table,
        activeOrder: null,
        activeOrderId: null,
        assignedStaffEmail: null,
        status: 'available' as const,
      };
    }

    return table;
  });

  return rebuildDerivedStateFromTables(state, tables);
}

function rebuildDerivedStateFromTables(state: PosState, tables: PosTableWithOrder[]) {
  const openOrders = tables
    .flatMap((table) => (table.activeOrder ? [table.activeOrder] : []))
    .sort((left, right) => right.openedAt.localeCompare(left.openedAt));
  const pendingPayments = openOrders.flatMap((order) => order.payments.filter((payment) => payment.status === 'pending'));
  const { pendingPreparationBar, pendingPreparationKitchen } = buildPendingPreparationListsFromTables(tables);

  return {
    ...state,
    generatedAt: new Date().toISOString(),
    closedSales: state.closedSales,
    openOrders,
    pendingPreparationBar,
    pendingPreparationKitchen,
    pendingPayments,
    tables,
  };
}

function buildOrderSummaryForUi(items: PosOrderItem[], payments: PosPayment[]) {
  const billableItems = items.filter((item) => item.operationalStatus !== 'cancelled' && item.financialStatus !== 'cancelled');
  const subtotal = billableItems.reduce((sum, item) => sum + item.totalPrice, 0);
  const confirmedPayments = payments.filter((payment) => payment.status === 'confirmed');
  const pendingPayments = payments.filter((payment) => payment.status === 'pending');
  const totalPaid = confirmedPayments.reduce((sum, payment) => sum + payment.amountApplied, 0);
  const remainingBalance = Math.max(subtotal - totalPaid, 0);

  return {
    confirmedPayments: confirmedPayments.length,
    pendingPayments: pendingPayments.length,
    remainingBalance,
    subtotal,
    totalDue: subtotal,
    totalPaid,
  };
}

function deriveOrderFinancialStatusForUi(items: PosOrderItem[], summary: ReturnType<typeof buildOrderSummaryForUi>) {
  const activeItems = items.filter((item) => item.operationalStatus !== 'cancelled');
  if (!activeItems.length) {
    return 'cancelled' as const;
  }

  if (summary.remainingBalance <= 0 && summary.totalDue > 0) {
    return 'paid_total' as const;
  }

  if (summary.totalPaid > 0) {
    return 'partially_paid' as const;
  }

  return 'pending_payment' as const;
}

interface SelectablePaymentUnit {
  amount: number;
  itemId: string;
  label: string;
  unitKey: string;
}

interface CashierProductGroup {
  items: PosOrderItem[];
  key: string;
  notes: string;
  operationalStatus: PosOrderItem['operationalStatus'];
  productName: string;
  quantity: number;
  totalPrice: number;
}

function isPaymentUnitKey(value: string) {
  return value.includes('::');
}

function parsePaymentTargetItemId(value: string) {
  return isPaymentUnitKey(value) ? value.split('::')[0] ?? value : value;
}

function findVoidableProcessedItemForGroup(
  order: PosOrderWithRelations | null,
  group: CashierProductGroup,
  outstandingByItem: Map<string, number>,
) {
  if (!order) {
    return null;
  }

  const processedItems = group.items.filter((item) => ['in_process', 'ready', 'picking_up', 'delivered'].includes(item.operationalStatus));
  return (
    processedItems.find((item) => {
      const outstanding = outstandingByItem.get(item.id) ?? item.totalPrice;
      return outstanding >= item.unitPrice;
    }) ?? null
  );
}

function buildOutstandingByItem(order: PosOrderWithRelations | null) {
  const outstanding = new Map<string, number>();

  if (!order) {
    return outstanding;
  }

  const activeItems = order.items.filter((item) => item.operationalStatus !== 'cancelled');
  for (const item of activeItems) {
    outstanding.set(item.id, item.totalPrice);
  }

  const confirmedPayments = order.payments
    .filter((payment) => payment.status === 'confirmed')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const activeItemsById = new Map(activeItems.map((item) => [item.id, item]));

  for (const payment of confirmedPayments) {
    let remaining = payment.amountApplied;
    const targetIds =
      payment.allocationMode === 'items' && payment.targetItemIds?.length ? payment.targetItemIds : activeItems.map((item) => item.id);

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

function buildSelectablePaymentUnits(order: PosOrderWithRelations | null, outstandingByItem: Map<string, number>) {
  if (!order) {
    return [] as SelectablePaymentUnit[];
  }

  const units: SelectablePaymentUnit[] = [];
  for (const item of order.items) {
    if (item.operationalStatus === 'cancelled') {
      continue;
    }

    const outstandingAmount = outstandingByItem.get(item.id) ?? item.totalPrice;
    if (outstandingAmount <= 0 || item.unitPrice <= 0) {
      continue;
    }

    const remainingUnits = Math.max(Math.round(outstandingAmount / item.unitPrice), 0);
    for (let index = 0; index < remainingUnits; index += 1) {
      units.push({
        amount: item.unitPrice,
        itemId: item.id,
        label: `1 × ${item.productName} · unidad ${index + 1}`,
        unitKey: `${item.id}::${index + 1}`,
      });
    }
  }

  return units;
}

function buildCashierProductGroups(order: PosOrderWithRelations | null) {
  if (!order) {
    return [] as CashierProductGroup[];
  }

  const groups = new Map<string, CashierProductGroup>();

  for (const item of order.items) {
    if (item.operationalStatus === 'cancelled') {
      continue;
    }

    const normalizedNotes = item.notes?.trim() ?? '';
    const key = [
      item.menuItemSourceKey ?? item.productSlug,
      item.productName,
      item.unitPrice,
      item.operationalStatus,
      normalizedNotes,
    ].join('::');
    const existing = groups.get(key);

    if (existing) {
      existing.items.push(item);
      existing.quantity += item.quantity;
      existing.totalPrice += item.totalPrice;
    } else {
      groups.set(key, {
        items: [item],
        key,
        notes: normalizedNotes,
        operationalStatus: item.operationalStatus,
        productName: item.productName,
        quantity: item.quantity,
        totalPrice: item.totalPrice,
      });
    }
  }

  return Array.from(groups.values()).sort((left, right) => {
    const leftCreatedAt = left.items[0]?.createdAt ?? '';
    const rightCreatedAt = right.items[0]?.createdAt ?? '';
    return leftCreatedAt.localeCompare(rightCreatedAt);
  });
}

function buildPendingPreparationListsFromTables(tables: PosTableWithOrder[]) {
  const items = tables
    .flatMap((table) => {
      if (!table.activeOrder) {
        return [] as PosOrderItem[];
      }

      return table.activeOrder.items.map((item) => ({
        ...item,
        orderAssignedStaffEmail: table.activeOrder?.assignedStaffEmail,
        orderOpenedByEmail: table.activeOrder?.openedByEmail,
        tableCode: table.code,
        tableId: table.id,
        tableName: table.name,
      }));
    })
    .filter((item) => !['delivered', 'cancelled', 'draft'].includes(item.operationalStatus))
    .sort((left, right) => resolvePreparationQueueTimestampForUi(left).localeCompare(resolvePreparationQueueTimestampForUi(right)));

  return {
    pendingPreparationBar: items.filter((item) => item.prepArea === 'bar'),
    pendingPreparationKitchen: items.filter((item) => item.prepArea === 'kitchen'),
  };
}

function buildLiveSalesSessionSummary(activeSession: PosSalesSession | null, orders: PosOrderWithRelations[]): PosSalesSessionSummary {
  if (!activeSession) {
    return {
      confirmedPayments: 0,
      deliveredProducts: 0,
      grossSales: 0,
      openOrders: 0,
      orderCount: 0,
      paymentMethods: [],
      pendingBalance: 0,
      pendingPayments: 0,
      products: [],
      totalCollected: 0,
    };
  }

  const sessionOrders = orders.filter((order) => order.salesSessionId === activeSession.id);
  const productsMap = new Map<string, PosSalesSessionSummary['products'][number]>();
  const paymentMethodsMap = new Map<string, PosSalesSessionSummary['paymentMethods'][number]>();

  for (const order of sessionOrders) {
    for (const item of order.items) {
      if (item.operationalStatus === 'cancelled' || item.financialStatus === 'cancelled') {
        continue;
      }

      const key = `${item.productName}::${item.prepArea}::${item.menuItemSourceKey ?? ''}`;
      const existing = productsMap.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        existing.totalAmount += item.totalPrice;
      } else {
        productsMap.set(key, {
          menuItemSourceKey: item.menuItemSourceKey,
          prepArea: item.prepArea,
          productName: item.productName,
          quantity: item.quantity,
          totalAmount: item.totalPrice,
        });
      }
    }

    for (const payment of order.payments.filter((entry) => entry.status === 'confirmed')) {
      const existing = paymentMethodsMap.get(payment.method);
      if (existing) {
        existing.paymentCount += 1;
        existing.totalAmount += payment.amountApplied;
      } else {
        paymentMethodsMap.set(payment.method, {
          method: payment.method,
          paymentCount: 1,
          totalAmount: payment.amountApplied,
        });
      }
    }
  }

  return {
    confirmedPayments: sessionOrders.reduce((sum, order) => sum + order.payments.filter((payment) => payment.status === 'confirmed').length, 0),
    deliveredProducts: sessionOrders.reduce(
      (sum, order) => sum + order.items.filter((item) => item.operationalStatus === 'delivered').reduce((acc, item) => acc + item.quantity, 0),
      0,
    ),
    grossSales: sessionOrders.reduce((sum, order) => sum + order.summary.totalDue, 0),
    openOrders: sessionOrders.filter((order) => order.closedAt == null).length,
    orderCount: sessionOrders.length,
    paymentMethods: Array.from(paymentMethodsMap.values()).sort((left, right) => right.totalAmount - left.totalAmount),
    pendingBalance: sessionOrders.reduce((sum, order) => sum + order.summary.remainingBalance, 0),
    pendingPayments: sessionOrders.reduce((sum, order) => sum + order.summary.pendingPayments, 0),
    products: Array.from(productsMap.values()).sort((left, right) => right.quantity - left.quantity || right.totalAmount - left.totalAmount),
    totalCollected: sessionOrders.reduce(
      (sum, order) => sum + order.payments.filter((payment) => payment.status === 'confirmed').reduce((acc, payment) => acc + payment.amountApplied, 0),
      0,
    ),
  };
}

function groupSalesSessionProductsByPrepArea(products: PosSalesSessionSummary['products']) {
  const prepAreaLabels: Record<string, string> = {
    bar: 'Bar',
    kitchen: 'Cocina',
  };
  const grouped = new Map<string, PosSalesSessionSummary['products']>();

  for (const product of products) {
    const key = product.prepArea || 'other';
    grouped.set(key, [...(grouped.get(key) ?? []), product]);
  }

  return Array.from(grouped.entries()).map(([prepArea, entries]) => ({
    label: prepAreaLabels[prepArea] ?? 'Otros',
    prepArea,
    products: entries,
  }));
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('es-CO', {
    currency: 'COP',
    maximumFractionDigits: 0,
    style: 'currency',
  }).format(value);
}

function formatOperatorIdentity(email: string | null | undefined) {
  if (!email) {
    return 'Sin asignar';
  }

  const localPart = email.split('@')[0] ?? email;
  return localPart
    .replace(/[._-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(' ');
}

function resolveOrderTableLabel(order: PosOrderWithRelations, tablesById: Map<string, PosTableWithOrder>) {
  const table = order.tableId ? tablesById.get(order.tableId) : null;
  if (table) {
    return `${table.name} - ${table.code}`;
  }

  return formatDetachedTableLabel(order.tableNameSnapshot, order.tableCodeSnapshot);
}

function formatDetachedTableLabel(tableName?: string | null, tableCode?: string | null) {
  if (tableName && tableCode) {
    return `${tableName} - ${tableCode}`;
  }

  if (tableName) {
    return tableName;
  }

  if (tableCode) {
    return `Mesa eliminada - ${tableCode}`;
  }

  return 'Mesa eliminada';
}

function isSalesSessionPastClosingCutoff(session: Pick<PosSalesSession, 'openedAt' | 'closedAt' | 'status'>, now: number) {
  if (session.status !== 'open' || session.closedAt) return false;
  const openedAt = Date.parse(session.openedAt);
  if (!Number.isFinite(openedAt)) return false;
  // Colombia stays at UTC-5; 06:00 local is 11:00 UTC.
  const colombianOpeningDate = new Date(openedAt - 5 * 60 * 60 * 1000);
  let cutoff = Date.UTC(colombianOpeningDate.getUTCFullYear(), colombianOpeningDate.getUTCMonth(), colombianOpeningDate.getUTCDate(), 11);
  if (openedAt >= cutoff) cutoff += 24 * 60 * 60 * 1000;
  return now >= cutoff;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    month: '2-digit',
  }).format(new Date(value));
}

function formatPaymentMethodsSummary(entries: PosPayment[] | PosSalesSessionSummary['paymentMethods']) {
  if (!entries.length) {
    return 'Sin pagos confirmados';
  }

  if (isPosPaymentArray(entries)) {
    const grouped = new Map<PaymentMethod, number>();
    for (const payment of entries) {
      if (payment.status !== 'confirmed') {
        continue;
      }
      grouped.set(payment.method, (grouped.get(payment.method) ?? 0) + payment.amountApplied);
    }

    return Array.from(grouped.entries())
      .sort((left, right) => right[1] - left[1])
      .map(([method, total]) => `${paymentMethodLabels[method]} ${formatCurrency(total)}`)
      .join(' · ');
  }

  return entries.map((entry) => `${paymentMethodLabels[entry.method]} ${formatCurrency(entry.totalAmount)}`).join(' · ');
}

function isPosPaymentArray(entries: PosPayment[] | PosSalesSessionSummary['paymentMethods']): entries is PosPayment[] {
  return entries.length > 0 && 'status' in entries[0];
}

function isPaidClosedSale(order: PosOrderWithRelations) {
  return order.closedAt != null && order.financialStatus === 'paid_total' && order.summary.totalDue > 0;
}

function formatPosEventLabel(eventType: string) {
  const labels: Record<string, string> = {
    items_added: 'Productos agregados',
    custom_item_added: 'Extra agregado',
    item_cancelled: 'Producto cancelado',
    item_direct_delivered: 'Producto entregado directo',
    item_delivered: 'Producto entregado',
    item_in_process: 'Producto en proceso',
    item_picking_up: 'Producto en recogida',
    item_ready: 'Producto listo',
    item_marked_in_process: 'Producto en proceso',
    item_marked_picking_up: 'Producto en recogida',
    item_marked_ready: 'Producto listo',
    item_payment_status_updated: 'Estado de pago actualizado',
    item_replaced: 'Producto reemplazado',
    item_updated: 'Producto actualizado',
    item_voided_after_process: 'Producto anulado por excepcion',
    order_reconciled: 'Cuenta reconciliada',
    order_sent_to_preparation: 'Tanda enviada a preparacion',
    payment_confirmed: 'Pago confirmado',
    payment_recorded: 'Pago registrado',
    payment_rejected: 'Pago rechazado',
    sales_session_closed: 'Jornada cerrada',
    sales_session_opened: 'Jornada abierta',
    table_created: 'Mesa creada',
    table_deactivated: 'Mesa inactivada',
    table_deleted: 'Mesa eliminada',
  };

  return labels[eventType] ?? eventType.replace(/_/g, ' ');
}

function resolveLogContextLabel(
  log: PosState['logs'][number],
  ordersById: Map<string, PosOrderWithRelations>,
  tablesById: Map<string, PosTableWithOrder>,
) {
  if (log.orderId) {
    const order = ordersById.get(log.orderId);
    if (order) {
      return resolveOrderTableLabel(order, tablesById);
    }
  }

  if (log.tableId) {
    const table = tablesById.get(log.tableId);
    if (table) {
      return `${table.name} · ${table.code}`;
    }
  }

  return null;
}

function resolveLogProductLabel(log: PosState['logs'][number]) {
  const record = log.afterData ?? log.beforeData;
  if (!record) {
    return null;
  }

  const productName = getRecordString(record, 'productName') ?? getRecordString(record, 'product_name');
  if (!productName) {
    return null;
  }

  const quantity = getRecordNumber(record, 'quantity');
  return quantity && quantity > 1 ? `${quantity} x ${productName}` : productName;
}

interface TraceLogLineItem {
  id: string | null;
  notes: string | null;
  prepArea: PosOrderItem['prepArea'] | null;
  productName: string;
  quantity: number;
}

function resolveLogLineItems(log: PosState['logs'][number]): TraceLogLineItem[] {
  const source = Array.isArray(log.afterData) ? log.afterData : Array.isArray(log.beforeData) ? log.beforeData : [];

  return source
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => {
      const productName = getRecordString(entry, 'productName') ?? getRecordString(entry, 'product_name');
      if (!productName) {
        return null;
      }

      return {
        id: getRecordString(entry, 'id'),
        notes: getRecordString(entry, 'notes'),
        prepArea: parseTraceLogPrepArea(getRecordString(entry, 'prepArea') ?? getRecordString(entry, 'prep_area')),
        productName,
        quantity: getRecordNumber(entry, 'quantity') ?? 1,
      };
    })
    .filter((entry): entry is TraceLogLineItem => Boolean(entry));
}

function parseTraceLogPrepArea(value: string | null): PosOrderItem['prepArea'] | null {
  return value === 'bar' || value === 'kitchen' ? value : null;
}

function getRecordString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function getRecordNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveReplacementAnchorTimestamp(item: PosOrderItem, itemsById: Map<string, PosOrderItem>) {
  let anchor = item;
  const visited = new Set<string>();

  while (anchor.replacementForItemId && !visited.has(anchor.replacementForItemId)) {
    visited.add(anchor.replacementForItemId);
    const previous = itemsById.get(anchor.replacementForItemId);
    if (!previous) {
      break;
    }
    anchor = previous;
  }

  return anchor.sentAt ?? anchor.createdAt;
}

function resolvePreparationQueueTimestampForUi(item: PosOrderItem) {
  return item.sentAt ?? item.createdAt;
}

function sortPreparationQueueForUi(items: PosOrderItem[], operationalFlowSettings: PosOperationalFlowSettings) {
  return [...items].sort((left, right) => {
    const priorityDifference =
      getPreparationQueuePriorityForUi(left, operationalFlowSettings) -
      getPreparationQueuePriorityForUi(right, operationalFlowSettings);

    if (priorityDifference !== 0) {
      return priorityDifference;
    }

    return resolvePreparationQueueTimestampForUi(left).localeCompare(resolvePreparationQueueTimestampForUi(right));
  });
}

function getPreparationQueuePriorityForUi(item: PosOrderItem, operationalFlowSettings: PosOperationalFlowSettings) {
  const isDirectDispatch = shouldUseDirectDeliveryStep(item, operationalFlowSettings);
  const shouldUseInProcess = shouldUseInProcessStep(item, operationalFlowSettings, isDirectDispatch);

  if (item.operationalStatus === 'in_process' && shouldUseInProcess) {
    return 0;
  }

  if (['pending_preparation', 'sent'].includes(item.operationalStatus) && isDirectDispatch) {
    return 1;
  }

  if (['pending_preparation', 'sent'].includes(item.operationalStatus)) {
    return 2;
  }

  if (item.operationalStatus === 'in_process') {
    return 3;
  }

  if (item.operationalStatus === 'picking_up') {
    return 4;
  }

  if (item.operationalStatus === 'ready') {
    return 5;
  }

  return 6;
}

function shouldUseInProcessStep(item: PosOrderItem, operationalFlowSettings: PosOperationalFlowSettings, isDirectDispatch = false) {
  return !isDirectDispatch && operationalFlowSettings[item.prepArea].useInProcess;
}

function shouldUsePickingUpStep(item: PosOrderItem, operationalFlowSettings: PosOperationalFlowSettings) {
  return operationalFlowSettings[item.prepArea].usePickingUp;
}

function shouldUseDirectDeliveryStep(item: PosOrderItem, operationalFlowSettings: PosOperationalFlowSettings) {
  return operationalFlowSettings[item.prepArea].useDirectDelivery;
}

function isDirectDeliveryCandidate(item: PosOrderItem) {
  return ['pending_preparation', 'sent', 'in_process'].includes(item.operationalStatus);
}

function getPosFallbackSyncInterval(tab: WorkspaceTab) {
  switch (tab) {
    case 'kitchen':
    case 'bar':
    case 'cashier':
    case 'floor':
      return 300000;
    default:
      return 0;
  }
}

function parseOptionalNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sanitizeDigitsInput(value: string) {
  return value.replace(/[^\d]/g, '');
}

function formatGroupedDigitsInputValue(value: string) {
  if (!value) {
    return '';
  }

  const digits = sanitizeDigitsInput(value);
  if (!digits) {
    return '';
  }

  return new Intl.NumberFormat('es-CO', {
    maximumFractionDigits: 0,
  }).format(Number(digits));
}

function formatCurrencyInputValue(value: string) {
  if (!value) {
    return '';
  }

  const groupedDigits = formatGroupedDigitsInputValue(value);
  return groupedDigits ? `$ ${groupedDigits}` : '';
}

function formatPercentageInputValue(value: string) {
  if (!value) {
    return '';
  }

  const digits = sanitizeDigitsInput(value);
  if (!digits) {
    return '';
  }

  return `${digits} %`;
}

function sanitizePercentageInput(value: string) {
  const digits = sanitizeDigitsInput(value);
  if (!digits) {
    return '';
  }

  return String(Math.min(Number(digits), 100));
}

const inputClassName =
  'w-full rounded-[1rem] border border-white/10 bg-obsidian/50 px-4 py-3 text-base text-ivory outline-none transition focus:border-cyanGlow/40';
const invalidInputClassName =
  'w-full rounded-[1rem] border border-rose-300/45 bg-obsidian/50 px-4 py-3 text-base text-ivory outline-none transition focus:border-rose-300/65';
const primaryButtonClassName =
  'rounded-full border border-cyanGlow/28 bg-cyanGlow/12 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.22em] text-cyanGlow transition hover:border-cyanGlow/42 hover:bg-cyanGlow/18 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyanGlow/24 disabled:cursor-not-allowed disabled:opacity-60';
const addToTableButtonClassName = `${primaryButtonClassName} inline-flex min-h-[44px] w-64 max-w-full items-center justify-center gap-2 disabled:!border-white/20 disabled:!bg-white/[0.04] disabled:!text-white/40 disabled:!opacity-100 disabled:shadow-none`;
const ghostButtonClassName =
  'rounded-full border border-white/14 bg-white/[0.06] px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.22em] text-ivory transition hover:border-cyanGlow/24 hover:bg-white/[0.1] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyanGlow/20';
const dangerButtonClassName =
  'rounded-full border border-rose-300/24 bg-rose-300/12 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.22em] text-rose-100 transition hover:border-rose-300/38 hover:bg-rose-300/16 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/20';

function getQuantityInputClassName(isValid: boolean) {
  return isValid ? inputClassName : invalidInputClassName;
}

