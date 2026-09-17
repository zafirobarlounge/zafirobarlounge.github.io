import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminLayout } from './AdminLayout';
import { useSupabaseAuth } from '../auth/SupabaseAuthProvider';
import {
  cancelClosedPaidOrderInSupabase,
  createManualSalesSessionInSupabase,
  deleteSalesSessionFromSupabase,
  loadSalesSessionHistoryViewFromSupabase,
  reassignOrderSalesSessionInSupabase,
  updateSalesSessionWindowInSupabase,
  type PosActorContext,
} from '../integrations/supabase/posOperationsRepository';
import type {
  PaymentMethod,
  PosOrderWithRelations,
  PosPayment,
  PosSalesSessionHistoryEntry,
  PosSalesSessionSummary,
  PosTableWithOrder,
  StaffRole,
} from '../shared/operations/operations.types';

const primaryButtonClassName =
  'interactive-button inline-flex items-center rounded-full border border-cyanGlow/35 bg-cyanGlow/12 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyanGlow transition hover:border-cyanGlow/60 hover:bg-cyanGlow/18 disabled:cursor-not-allowed disabled:opacity-45';
const ghostButtonClassName =
  'interactive-button inline-flex items-center rounded-full border border-white/12 bg-white/[0.04] px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-ivory transition hover:border-cyanGlow/35 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-45';
const dangerButtonClassName =
  'interactive-button inline-flex items-center rounded-full border border-rose-300/35 bg-rose-300/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-rose-100 transition hover:border-rose-300/60 hover:bg-rose-300/16 disabled:cursor-not-allowed disabled:opacity-45';

const paymentMethodLabels: Record<PaymentMethod, string> = {
  bank_transfer: 'Transferencia',
  card: 'Tarjeta',
  cash: 'Efectivo',
  nequi: 'Nequi',
  other: 'Otro',
};

export function AdminSalesSessionsView() {
  const { isCatalogAdmin, staffProfile, staffRoles, user } = useSupabaseAuth();
  const actor = useMemo<PosActorContext>(
    () => ({
      email: user?.email?.trim().toLowerCase() ?? staffProfile?.email ?? '',
      roles: Array.from(new Set<StaffRole>([(isCatalogAdmin ? 'superadmin' : null), ...staffRoles].filter(Boolean) as StaffRole[])),
    }),
    [isCatalogAdmin, staffProfile?.email, staffRoles, user?.email],
  );
  const [sessions, setSessions] = useState<PosSalesSessionHistoryEntry[]>([]);
  const [closedSales, setClosedSales] = useState<PosOrderWithRelations[]>([]);
  const [tables, setTables] = useState<PosTableWithOrder[]>([]);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [sessionPendingDelete, setSessionPendingDelete] = useState<PosSalesSessionHistoryEntry | null>(null);
  const [sessionPendingEdit, setSessionPendingEdit] = useState<PosSalesSessionHistoryEntry | null>(null);
  const [isCreateSessionModalOpen, setIsCreateSessionModalOpen] = useState(false);
  const [orderPendingMove, setOrderPendingMove] = useState<{
    order: PosOrderWithRelations;
    sourceSession: PosSalesSessionHistoryEntry;
  } | null>(null);
  const [sessionWindowForm, setSessionWindowForm] = useState({
    businessDate: '2026-05-28',
    closedAt: '2026-05-29T02:00',
    notes: '',
    openedAt: '2026-05-28T19:00',
    sessionLabel: 'Jornada 2026-05-28',
  });
  const [selectedMonthKey, setSelectedMonthKey] = useState(getCurrentMonthKey());
  const [customDateRange, setCustomDateRange] = useState(() => getMonthDateRange(getCurrentMonthKey()));
  const [moveDestinationSessionId, setMoveDestinationSessionId] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);
  const [isSessionWindowBusy, setIsSessionWindowBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [deleteErrorMessage, setDeleteErrorMessage] = useState<string | null>(null);
  const [moveErrorMessage, setMoveErrorMessage] = useState<string | null>(null);
  const [sessionWindowErrorMessage, setSessionWindowErrorMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const sessionHeaderRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const isMountedRef = useRef(false);
  const loadRequestIdRef = useRef(0);

  const closedSessions = useMemo(() => sessions.filter((session) => session.status === 'closed'), [sessions]);
  const openSessions = useMemo(() => sessions.filter((session) => session.status === 'open'), [sessions]);
  const tablesById = useMemo(() => new Map(tables.map((table) => [table.id, table])), [tables]);
  const monthOptions = useMemo(() => {
    const currentMonthKey = getCurrentMonthKey();
    const historyMonthKeys = Array.from(new Set(sessions.map((session) => getSessionMonthKey(session)).filter(Boolean))).sort((left, right) =>
      right.localeCompare(left),
    );

    return historyMonthKeys.includes(currentMonthKey) ? historyMonthKeys : [currentMonthKey, ...historyMonthKeys];
  }, [sessions]);
  const visibleSessions = useMemo(
    () => filterSessionsByPeriod(sessions, selectedMonthKey, customDateRange),
    [customDateRange, selectedMonthKey, sessions],
  );
  const visibleClosedSessions = useMemo(() => visibleSessions.filter((session) => session.status === 'closed'), [visibleSessions]);
  const visibleSessionIds = useMemo(() => new Set(visibleSessions.map((session) => session.id)), [visibleSessions]);
  const visibleClosedSales = useMemo(
    () => closedSales.filter((order) => order.salesSessionId && visibleSessionIds.has(order.salesSessionId) && isPaidClosedSale(order)),
    [closedSales, visibleSessionIds],
  );
  const visibleSummary = useMemo(() => buildSalesSessionsScopeSummary(visibleSessions, visibleClosedSales), [visibleClosedSales, visibleSessions]);
  const comparisonPeriod = useMemo(() => getComparisonPeriod(selectedMonthKey, customDateRange), [customDateRange, selectedMonthKey]);
  const comparisonSessions = useMemo(
    () => (comparisonPeriod ? sessions.filter((session) => isDateInRange(session.businessDate, comparisonPeriod.startDate, comparisonPeriod.endDate)) : []),
    [comparisonPeriod, sessions],
  );
  const comparisonSessionIds = useMemo(() => new Set(comparisonSessions.map((session) => session.id)), [comparisonSessions]);
  const comparisonClosedSales = useMemo(
    () => closedSales.filter((order) => order.salesSessionId && comparisonSessionIds.has(order.salesSessionId) && isPaidClosedSale(order)),
    [closedSales, comparisonSessionIds],
  );
  const comparisonSummary = useMemo(
    () => buildSalesSessionsScopeSummary(comparisonSessions, comparisonClosedSales),
    [comparisonClosedSales, comparisonSessions],
  );
  const periodLabel = useMemo(() => formatPeriodLabel(selectedMonthKey, customDateRange), [customDateRange, selectedMonthKey]);
  const comparisonLabel = useMemo(() => (comparisonPeriod ? formatDateRangeLabel(comparisonPeriod.startDate, comparisonPeriod.endDate) : null), [comparisonPeriod]);

  const loadSessions = async () => {
    if (!isMountedRef.current) {
      return;
    }
    const requestId = ++loadRequestIdRef.current;
    setErrorMessage(null);
    setIsLoading(true);
    try {
      const { history, closedSales, tables } = await loadSalesSessionHistoryViewFromSupabase();
      if (!isMountedRef.current || requestId !== loadRequestIdRef.current) {
        return;
      }
      setSessions(history);
      setClosedSales(closedSales);
      setTables(tables);
      setExpandedSessionId((current) => {
        if (current && history.some((session) => session.id === current)) {
          return current;
        }

        return history.find((session) => session.status === 'closed')?.id ?? history[0]?.id ?? null;
      });
    } catch (error) {
      if (isMountedRef.current && requestId === loadRequestIdRef.current) {
        setErrorMessage(error instanceof Error ? error.message : 'No fue posible cargar las jornadas.');
      }
    } finally {
      if (isMountedRef.current && requestId === loadRequestIdRef.current) {
        setIsLoading(false);
      }
    }
  };

  useEffect(() => {
    isMountedRef.current = true;
    if (!isCatalogAdmin) {
      setIsLoading(false);
    } else {
      void loadSessions();
    }

    return () => {
      isMountedRef.current = false;
      loadRequestIdRef.current++;
    };
  }, [isCatalogAdmin]);

  useEffect(() => {
    if (!expandedSessionId) {
      return;
    }

    const header = sessionHeaderRefs.current[expandedSessionId];
    if (!header) {
      return;
    }

    window.setTimeout(() => {
      header.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 80);
  }, [expandedSessionId]);

  useEffect(() => {
    if (!visibleSessions.length) {
      setExpandedSessionId(null);
      return;
    }

    if (expandedSessionId && !visibleSessions.some((session) => session.id === expandedSessionId)) {
      setExpandedSessionId(visibleSessions[0].id);
    }
  }, [expandedSessionId, visibleSessions]);

  const handleDeleteSession = async () => {
    if (!sessionPendingDelete) {
      return;
    }

    const sessionToDelete = sessionPendingDelete;
    setBusySessionId(sessionToDelete.id);
    setErrorMessage(null);
    setDeleteErrorMessage(null);
    setActionMessage(null);

    try {
      const deleted = await deleteSalesSessionFromSupabase(sessionToDelete.id, actor);
      const nextSessions = sessions.filter((session) => session.id !== deleted.id);
      setSessions(nextSessions);
      setExpandedSessionId((current) => (current === deleted.id ? nextSessions[0]?.id ?? null : current));
      setSessionPendingDelete(null);
      setActionMessage(`Jornada eliminada: ${deleted.sessionLabel}`);
      window.setTimeout(() => window.scrollTo({ behavior: 'smooth', top: 0 }), 40);
      void loadSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No fue posible eliminar la jornada.';
      setDeleteErrorMessage(message);
      setErrorMessage(message);
    } finally {
      setBusySessionId(null);
    }
  };

  const openMoveOrderModal = (sourceSession: PosSalesSessionHistoryEntry, order: PosOrderWithRelations) => {
    const defaultDestination = closedSessions.find((session) => session.id !== sourceSession.id)?.id ?? '';
    setMoveErrorMessage(null);
    setMoveDestinationSessionId(defaultDestination);
    setOrderPendingMove({ order, sourceSession });
  };

  const handleMoveOrderSession = async () => {
    if (!orderPendingMove) {
      return;
    }

    setBusyOrderId(orderPendingMove.order.id);
    setErrorMessage(null);
    setMoveErrorMessage(null);
    setActionMessage(null);

    try {
      await reassignOrderSalesSessionInSupabase(orderPendingMove.order.id, moveDestinationSessionId, actor);
      const destination = sessions.find((session) => session.id === moveDestinationSessionId);
      setExpandedSessionId(moveDestinationSessionId);
      setOrderPendingMove(null);
      setActionMessage(
        `${resolveOrderTableLabel(orderPendingMove.order, tablesById)} movida a ${destination?.sessionLabel ?? 'la jornada destino'}.`,
      );
      await loadSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No fue posible mover la cuenta a otra jornada.';
      setMoveErrorMessage(message);
      setErrorMessage(message);
    } finally {
      setBusyOrderId(null);
    }
  };

  const handleCancelClosedPaidOrder = async (session: PosSalesSessionHistoryEntry, order: PosOrderWithRelations) => {
    const tableLabel = resolveOrderTableLabel(order, tablesById);
    const reason = window.prompt(
      `Motivo para anular la venta cerrada de ${tableLabel}:`,
      'Venta registrada por error',
    );
    if (!reason) {
      return;
    }

    const confirmed = window.confirm(
      `Esto anulara ${tableLabel} por ${formatCurrency(order.summary.totalDue)} dentro de ${session.sessionLabel}. La venta saldra de vendido/cobrado y quedara trazabilidad. ¿Continuar?`,
    );
    if (!confirmed) {
      return;
    }

    setBusyOrderId(order.id);
    setErrorMessage(null);
    setActionMessage(null);

    try {
      await cancelClosedPaidOrderInSupabase(order.id, reason, actor, order);
      setActionMessage(`Venta anulada: ${tableLabel}.`);
      await loadSessions();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'No fue posible anular la venta cerrada.');
    } finally {
      setBusyOrderId(null);
    }
  };

  const openCreateSessionModal = () => {
    setSessionPendingEdit(null);
    setSessionWindowErrorMessage(null);
    setSessionWindowForm({
      businessDate: '2026-05-28',
      closedAt: '2026-05-29T02:00',
      notes: 'Jornada manual creada para corregir ventas del 2026-05-28.',
      openedAt: '2026-05-28T19:00',
      sessionLabel: 'Jornada 2026-05-28',
    });
    setIsCreateSessionModalOpen(true);
  };

  const openEditSessionModal = (session: PosSalesSessionHistoryEntry) => {
    setIsCreateSessionModalOpen(false);
    setSessionWindowErrorMessage(null);
    setSessionPendingEdit(session);
    setSessionWindowForm({
      businessDate: session.businessDate,
      closedAt: toDateTimeLocalValue(session.closedAt ?? session.updatedAt),
      notes: session.notes,
      openedAt: toDateTimeLocalValue(session.openedAt),
      sessionLabel: session.sessionLabel,
    });
  };

  const handleSaveSessionWindow = async () => {
    const payload = {
      businessDate: sessionWindowForm.businessDate,
      closedAt: toIsoFromDateTimeLocal(sessionWindowForm.closedAt),
      notes: sessionWindowForm.notes,
      openedAt: toIsoFromDateTimeLocal(sessionWindowForm.openedAt),
      sessionLabel: sessionWindowForm.sessionLabel,
    };

    setIsSessionWindowBusy(true);
    setErrorMessage(null);
    setSessionWindowErrorMessage(null);
    setActionMessage(null);

    try {
      if (sessionPendingEdit) {
        await updateSalesSessionWindowInSupabase(sessionPendingEdit.id, payload, actor);
        setActionMessage(`Jornada ajustada: ${payload.sessionLabel || sessionPendingEdit.sessionLabel}`);
        setSessionPendingEdit(null);
      } else {
        await createManualSalesSessionInSupabase(payload, actor);
        setActionMessage(`Jornada creada: ${payload.sessionLabel || payload.businessDate}`);
        setIsCreateSessionModalOpen(false);
      }

      await loadSessions();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No fue posible guardar la jornada.';
      setSessionWindowErrorMessage(message);
      setErrorMessage(message);
    } finally {
      setIsSessionWindowBusy(false);
    }
  };

  const handleExportSummaryCsv = () => {
    const rows = visibleSessions.map((session) => {
      const sessionSales = visibleClosedSales.filter((order) => order.salesSessionId === session.id);
      const cashTotal = getSalesSessionCashTotal(session);
      const transferTotal = getSalesSessionTransferTotal(session);
      const productsCount = getSalesSessionProductsCount(session);

      return {
        abierta: formatDateTime(session.openedAt),
        cerrada: session.closedAt ? formatDateTime(session.closedAt) : '',
        cobrado: session.summary?.totalCollected ?? session.totalCollected,
        efectivo: cashTotal,
        estado: session.status === 'open' ? 'Abierta' : 'Cerrada',
        fecha_contable: session.businessDate,
        jornada: session.sessionLabel,
        jornada_id: session.id,
        mesas_cerradas: sessionSales.length,
        notas: session.notes,
        pagos_registrados: session.paymentCount,
        pendiente: session.summary?.pendingBalance ?? 0,
        productos_vendidos: productsCount,
        transferencias: transferTotal,
        vendido: session.summary?.grossSales ?? session.totalSold,
      };
    });

    downloadCsv(`zafiro-jornadas-resumen-${selectedMonthKey}.csv`, rows);
    setActionMessage('Se descargo el resumen del periodo seleccionado.');
  };

  const handleExportDetailCsv = () => {
    const rows = visibleSessions.flatMap((session) => {
      const sessionSales = visibleClosedSales.filter((order) => order.salesSessionId === session.id);

      return sessionSales.flatMap((order) => {
        const table = order.tableId ? tablesById.get(order.tableId) : null;
        const orderBase = {
          codigo_mesa: table?.code ?? order.tableCodeSnapshot ?? '',
          fecha_cierre: order.closedAt ? formatDateTime(order.closedAt) : '',
          fecha_contable: session.businessDate,
          jornada: session.sessionLabel,
          jornada_id: session.id,
          mesa: table?.name ?? formatDetachedTableLabel(order.tableNameSnapshot, order.tableCodeSnapshot),
          orden_id: order.id,
        };
        const productRows = order.items
          .filter((item) => item.operationalStatus !== 'cancelled')
          .map((item) => ({
            ...orderBase,
            area: item.prepArea === 'bar' ? 'Bar' : 'Cocina',
            cantidad: item.quantity,
            estado_item: item.operationalStatus,
            estado_pago: '',
            metodo_pago: '',
            notas: item.notes ?? '',
            precio_unitario: item.unitPrice,
            producto: item.productName,
            referencia_pago: '',
            tipo_registro: 'Producto',
            total_producto: item.totalPrice,
            valor_pago: '',
          }));
        const paymentRows = order.payments.map((payment) => ({
          ...orderBase,
          area: '',
          cantidad: '',
          estado_item: '',
          estado_pago: payment.status === 'confirmed' ? 'Confirmado' : payment.status === 'rejected' ? 'Rechazado' : 'Pendiente',
          metodo_pago: paymentMethodLabels[payment.method],
          notas: payment.notes ?? '',
          precio_unitario: '',
          producto: '',
          referencia_pago: payment.reference ?? '',
          tipo_registro: 'Pago',
          total_producto: '',
          valor_pago: payment.amountApplied,
        }));

        return [...productRows, ...paymentRows];
      });
    });

    if (!rows.length) {
      setActionMessage('No hay mesas cerradas con detalle para exportar.');
      return;
    }

    downloadCsv(`zafiro-jornadas-detalle-${selectedMonthKey}.csv`, rows);
    setActionMessage('Se descargo el detalle del periodo seleccionado.');
  };

  if (!isCatalogAdmin) {
    return (
      <AdminLayout>
        <section className="rounded-[1.6rem] border border-rose-300/20 bg-rose-300/10 p-6 text-rose-100">
          Solo superadmin puede administrar el historial de jornadas.
        </section>
      </AdminLayout>
    );
  }

  return (
    <AdminLayout>
      <section className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-3xl">
          <p className="text-[0.72rem] uppercase tracking-[0.28em] text-cyanGlow/80">Historial POS</p>
          <h1 className="mt-3 font-display text-[2.35rem] leading-none text-ivory sm:text-[3.6rem]">Jornadas previas</h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-mist sm:text-base">
            Revisa cada jornada con sus ventas, productos y pagos. Las jornadas de prueba se pueden eliminar desde su detalle.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={openCreateSessionModal} disabled={isLoading} className={primaryButtonClassName}>
            Crear jornada manual
          </button>
          <button type="button" onClick={handleExportSummaryCsv} disabled={isLoading || !visibleSessions.length} className={primaryButtonClassName}>
            Exportar resumen
          </button>
          <button type="button" onClick={handleExportDetailCsv} disabled={isLoading || !visibleSessions.length} className={ghostButtonClassName}>
            Exportar detalle
          </button>
          <button type="button" onClick={() => void loadSessions()} disabled={isLoading} className={primaryButtonClassName}>
            Actualizar
          </button>
          <Link to="/admin" className={ghostButtonClassName}>
            Volver al panel
          </Link>
        </div>
      </section>

      {errorMessage ? (
        <section className="mt-5 rounded-[1.2rem] border border-rose-200/20 bg-rose-200/10 px-4 py-3 text-sm text-rose-100">{errorMessage}</section>
      ) : null}
      {actionMessage ? (
        <section role="status" className="mt-5 rounded-[1.2rem] border border-emerald-300/20 bg-emerald-300/10 px-4 py-3 text-sm text-emerald-100">
          {actionMessage}
        </section>
      ) : null}

      <section className="mt-7 rounded-[1.35rem] border border-white/10 bg-white/[0.03] p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Periodo de analisis</p>
            <p className="mt-2 text-sm leading-6 text-mist">
              {selectedMonthKey === 'all'
                ? 'Viendo todo el historial operativo.'
                : `Viendo ${periodLabel}. Puedes cambiar a cualquier mes, rango o ver todo.`}
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3 lg:min-w-[42rem]">
            <select
              value={selectedMonthKey}
              onChange={(event) => {
                const nextPeriodKey = event.target.value;
                setSelectedMonthKey(nextPeriodKey);
                if (nextPeriodKey !== 'all' && nextPeriodKey !== 'range') {
                  setCustomDateRange(getMonthDateRange(nextPeriodKey));
                }
              }}
              className={inputClassName}
            >
              <option value="all">Todo el historial</option>
              <option value="range">Rango personalizado</option>
              {monthOptions.map((monthKey) => (
                <option key={monthKey} value={monthKey}>
                  {formatMonthLabel(monthKey)}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={customDateRange.startDate}
              onChange={(event) => {
                setSelectedMonthKey('range');
                setCustomDateRange((current) => ({ ...current, startDate: event.target.value }));
              }}
              className={inputClassName}
            />
            <input
              type="date"
              value={customDateRange.endDate}
              onChange={(event) => {
                setSelectedMonthKey('range');
                setCustomDateRange((current) => ({ ...current, endDate: event.target.value }));
              }}
              className={inputClassName}
            />
          </div>
        </div>
      </section>

      <section className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Jornadas" value={`${visibleSessions.length}/${sessions.length}`} />
        <MetricCard label="Cerradas" value={`${visibleClosedSessions.length}/${closedSessions.length}`} />
        <MetricCard label="Cobrado" value={formatCurrency(visibleSummary.collectedTotal)} insight={formatComparisonInsight(visibleSummary.collectedTotal, comparisonSummary.collectedTotal, comparisonLabel)} />
        <MetricCard label="Vendido" value={formatCurrency(visibleSummary.soldTotal)} insight={formatComparisonInsight(visibleSummary.soldTotal, comparisonSummary.soldTotal, comparisonLabel)} />
        <MetricCard label="Efectivo" value={formatCurrency(visibleSummary.cashTotal)} />
        <MetricCard label="Transferencias" value={formatCurrency(visibleSummary.transferTotal)} />
        <MetricCard label="Ticket prom." value={formatCurrency(visibleSummary.averageTicket)} insight={formatComparisonInsight(visibleSummary.averageTicket, comparisonSummary.averageTicket, comparisonLabel)} />
        <MetricCard label="Producto top" value={visibleSummary.topProductLabel} />
      </section>

      {isLoading ? (
        <section className="mt-6 rounded-[1.5rem] border border-white/10 bg-white/[0.03] p-6 text-mist">Cargando jornadas...</section>
      ) : (
        <section className="mt-6 space-y-4">
          {openSessions.length ? (
            <div className="rounded-[1.3rem] border border-amberGlow/25 bg-amberGlow/10 px-4 py-3 text-sm text-amber-100">
              Hay {openSessions.length} jornada{openSessions.length === 1 ? '' : 's'} abierta{openSessions.length === 1 ? '' : 's'}. Las jornadas abiertas no se pueden eliminar.
            </div>
          ) : null}

          <ProductRanking products={visibleSummary.topProducts} />

          <section className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Jornadas del periodo</p>
                <h2 className="mt-2 font-display text-2xl text-ivory">
                  {periodLabel}
                </h2>
              </div>
              <p className="text-sm text-mist">
                {visibleSummary.salesCount} mesa{visibleSummary.salesCount === 1 ? '' : 's'} cerrada{visibleSummary.salesCount === 1 ? '' : 's'}.
              </p>
            </div>

            {!visibleSessions.length ? <EmptyState message="No hay jornadas en este periodo." /> : null}

            {visibleSessions.map((session) => {
              const isExpanded = expandedSessionId === session.id;
              const sessionSales = visibleClosedSales.filter((order) => order.salesSessionId === session.id);
              const cashTotal = getSalesSessionCashTotal(session);
              const transferTotal = getSalesSessionTransferTotal(session);
              const productsCount = getSalesSessionProductsCount(session);
              const collected = session.summary?.totalCollected ?? session.totalCollected;
              const sold = session.summary?.grossSales ?? session.totalSold;
              const tableCount = sessionSales.length || session.orderCount;

              return (
                <article key={session.id} className="space-y-3">
                  <button
                    ref={(node) => {
                      sessionHeaderRefs.current[session.id] = node;
                    }}
                    type="button"
                    onClick={() => setExpandedSessionId((current) => (current === session.id ? null : session.id))}
                    className={`w-full overflow-hidden rounded-[1.35rem] border text-left transition ${
                      isExpanded ? 'border-cyanGlow/45 bg-cyanGlow/10 shadow-[0_0_0_1px_rgba(86,211,255,0.10)]' : 'border-white/10 bg-white/[0.035] hover:border-cyanGlow/25'
                    }`}
                  >
                    <div className="border-l-4 border-cyanGlow/60 px-4 py-3.5 sm:px-5">
                      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="font-display text-[1.55rem] leading-none text-ivory">{session.sessionLabel}</h2>
                            <span
                              className={`rounded-full border px-2.5 py-0.5 text-[0.58rem] font-semibold uppercase tracking-[0.18em] ${
                                session.status === 'open'
                                  ? 'border-amberGlow/35 bg-amberGlow/10 text-amberGlow'
                                  : 'border-emerald-300/25 bg-emerald-300/10 text-emerald-200'
                              }`}
                            >
                              {session.status === 'open' ? 'Abierta' : 'Cerrada'}
                            </span>
                          </div>
                          <p className="mt-1.5 text-[0.68rem] uppercase tracking-[0.16em] text-cyanGlow/75">
                            {session.businessDate} - abierta {formatDateTime(session.openedAt)}
                            {session.closedAt ? ` - cerrada ${formatDateTime(session.closedAt)}` : ''}
                          </p>

                          <div className="mt-4 grid gap-x-5 gap-y-3 md:grid-cols-[1.05fr_1.2fr]">
                            <div className="min-w-0">
                              <p className="text-[0.6rem] uppercase tracking-[0.18em] text-mist">Cobrado</p>
                              <p className="mt-1 font-display text-[1.85rem] leading-none text-ivory">{formatCurrency(collected)}</p>
                              <p className="mt-1 text-xs text-mist">Vendido: {formatCurrency(sold)}</p>
                            </div>
                            <PaymentSplit cashTotal={cashTotal} transferTotal={transferTotal} />
                          </div>
                        </div>

                        <div className="grid gap-x-4 gap-y-2 border-t border-white/8 pt-3 sm:grid-cols-4 xl:w-[31rem] xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
                          <InlineMetric label="Mesas" value={String(tableCount)} />
                          <InlineMetric label="Productos" value={String(productsCount)} />
                          <InlineMetric label="Ticket" value={formatCurrency(tableCount ? collected / tableCount : 0)} />
                          <InlineMetric label="Top" value={getSalesSessionTopProductLabel(session)} />
                          <span className="inline-flex justify-center rounded-full border border-white/18 bg-white/[0.03] px-3 py-1.5 text-[0.6rem] uppercase tracking-[0.2em] text-mist sm:col-span-4">
                            {isExpanded ? 'Ocultar detalle' : 'Ver detalle'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>

                  {isExpanded ? (
                    <div className="space-y-4 rounded-[1.2rem] border border-white/8 bg-white/[0.02] p-4">
                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <SummaryPill label="Jornada" value={session.sessionLabel} />
                        <SummaryPill label="Fecha contable" value={session.businessDate} />
                        <SummaryPill label="Vendido" value={formatCurrency(session.summary?.grossSales ?? session.totalSold)} />
                        <SummaryPill label="Cobrado" value={formatCurrency(session.summary?.totalCollected ?? session.totalCollected)} />
                        <SummaryPill label="Efectivo" value={formatCurrency(cashTotal)} />
                        <SummaryPill label="Transferencias" value={formatCurrency(transferTotal)} />
                        <SummaryPill label="Pendiente" value={formatCurrency(session.summary?.pendingBalance ?? 0)} />
                        <SummaryPill label="Mesas cerradas" value={String(sessionSales.length)} />
                      </div>

                      {session.notes ? (
                        <div className="rounded-[1rem] border border-amberGlow/20 bg-amberGlow/10 px-4 py-3 text-sm leading-6 text-amber-100">{session.notes}</div>
                      ) : null}

                      <div className="rounded-[1rem] border border-white/8 bg-black/15 p-4">
                        <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Productos vendidos</p>
                        <SalesSessionProductsSummary products={session.summary?.products ?? []} emptyMessage="No hay productos resumidos en esta jornada." />
                      </div>

                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Mesas cerradas</p>
                          <div className="flex flex-wrap gap-2">
                            <button type="button" onClick={() => openEditSessionModal(session)} disabled={isSessionWindowBusy} className={ghostButtonClassName}>
                              Ajustar fechas
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDeleteErrorMessage(null);
                                setSessionPendingDelete(session);
                              }}
                              disabled={session.status === 'open' || busySessionId === session.id}
                              className={dangerButtonClassName}
                            >
                              {busySessionId === session.id ? 'Eliminando...' : 'Eliminar jornada'}
                            </button>
                          </div>
                        </div>

                        {sessionSales.map((order) => (
                          <details key={order.id} className="rounded-[1.2rem] border border-white/8 bg-white/[0.02] p-4">
                            <summary className="list-none cursor-pointer">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <p className="font-medium text-ivory">{resolveOrderTableLabel(order, tablesById)}</p>
                                  <p className="mt-1 text-xs uppercase tracking-[0.18em] text-cyanGlow/75">
                                    Cerrada {formatDateTime(order.closedAt ?? order.updatedAt)}
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
                              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1rem] border border-cyanGlow/15 bg-cyanGlow/8 px-3 py-3">
                                <p className="text-sm leading-6 text-mist">Si esta mesa quedo en la jornada equivocada, muevela completa con sus pagos.</p>
                                <button
                                  type="button"
                                  onClick={() => openMoveOrderModal(session, order)}
                                  disabled={Boolean(busyOrderId)}
                                  className={ghostButtonClassName}
                                >
                                  Mover de jornada
                                </button>
                              </div>

                              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1rem] border border-rose-300/18 bg-rose-300/8 px-3 py-3">
                                <p className="text-sm leading-6 text-rose-100/85">
                                  Anula esta venta solo si fue registrada por error. La accion queda en trazabilidad y ajusta vendido/cobrado.
                                </p>
                                <button
                                  type="button"
                                  onClick={() => void handleCancelClosedPaidOrder(session, order)}
                                  disabled={busyOrderId === order.id}
                                  className={dangerButtonClassName}
                                >
                                  {busyOrderId === order.id ? 'Anulando...' : 'Anular venta'}
                                </button>
                              </div>

                              <div>
                                <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/75">Productos</p>
                                <div className="mt-3 space-y-2">
                                  {order.items
                                    .filter((item) => item.operationalStatus !== 'cancelled')
                                    .map((item) => (
                                      <div key={item.id} className="rounded-[1rem] border border-white/8 bg-black/15 px-3 py-3 text-sm text-mist">
                                        <div className="flex items-start justify-between gap-3">
                                          <p className="font-medium text-ivory">
                                            {item.quantity} x {item.productName}
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
                        {!sessionSales.length ? <EmptyState message="Esta jornada todavia no tiene mesas cerradas asociadas." /> : null}
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
            {!sessions.length ? <EmptyState message="No hay jornadas registradas todavia." /> : null}
          </section>
        </section>
      )}

      {sessionPendingDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 px-4">
          <div className="w-full max-w-lg rounded-[1.4rem] border border-white/10 bg-[#0b0b0f] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.45)]">
            <p className="text-[0.68rem] uppercase tracking-[0.22em] text-rose-200">Eliminar jornada</p>
            <h2 className="mt-2 font-display text-2xl text-ivory">{sessionPendingDelete.sessionLabel}</h2>
            <p className="mt-3 text-sm leading-6 text-mist">
              Esta accion elimina la jornada del historial. No elimina cuentas, productos ni pagos asociados.
            </p>
            {deleteErrorMessage ? (
              <div className="mt-4 rounded-[1rem] border border-rose-200/20 bg-rose-200/10 px-4 py-3 text-sm leading-6 text-rose-100">
                {deleteErrorMessage}
              </div>
            ) : null}
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              <SummaryPill label="Cuentas" value={String(sessionPendingDelete.orderCount)} />
              <SummaryPill label="Cobrado" value={formatCurrency(sessionPendingDelete.totalCollected)} />
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <button type="button" onClick={() => void handleDeleteSession()} disabled={Boolean(busySessionId)} className={dangerButtonClassName}>
                {busySessionId === sessionPendingDelete.id ? 'Eliminando...' : 'Confirmar eliminar'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDeleteErrorMessage(null);
                  setSessionPendingDelete(null);
                }}
                disabled={Boolean(busySessionId)}
                className={ghostButtonClassName}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {orderPendingMove ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 px-4">
          <div className="w-full max-w-xl rounded-[1.4rem] border border-white/10 bg-[#0b0b0f] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.45)]">
            <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/80">Mover cuenta de jornada</p>
            <h2 className="mt-2 font-display text-2xl text-ivory">{resolveOrderTableLabel(orderPendingMove.order, tablesById)}</h2>
            <p className="mt-3 text-sm leading-6 text-mist">
              Origen: {orderPendingMove.sourceSession.sessionLabel}. Se movera la orden completa y sus pagos a la jornada destino.
            </p>

            {moveErrorMessage ? (
              <div className="mt-4 rounded-[1rem] border border-rose-200/20 bg-rose-200/10 px-4 py-3 text-sm leading-6 text-rose-100">
                {moveErrorMessage}
              </div>
            ) : null}

            <label className="mt-5 block">
              <span className="text-[0.68rem] uppercase tracking-[0.22em] text-mist">Jornada destino</span>
              <select
                value={moveDestinationSessionId}
                onChange={(event) => setMoveDestinationSessionId(event.target.value)}
                className="mt-2 w-full rounded-[1rem] border border-white/10 bg-obsidian/70 px-4 py-3 text-sm text-ivory outline-none transition focus:border-cyanGlow/40"
              >
                <option value="">Selecciona una jornada</option>
                {closedSessions
                  .filter((session) => session.id !== orderPendingMove.sourceSession.id)
                  .map((session) => (
                    <option key={session.id} value={session.id}>
                      {session.sessionLabel} - {session.businessDate}
                    </option>
                  ))}
              </select>
            </label>

            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              <SummaryPill label="Total" value={formatCurrency(orderPendingMove.order.summary.totalDue)} />
              <SummaryPill label="Pagado" value={formatCurrency(orderPendingMove.order.summary.totalPaid)} />
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleMoveOrderSession()}
                disabled={Boolean(busyOrderId) || !moveDestinationSessionId}
                className={primaryButtonClassName}
              >
                {busyOrderId === orderPendingMove.order.id ? 'Moviendo...' : 'Confirmar movimiento'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMoveErrorMessage(null);
                  setOrderPendingMove(null);
                }}
                disabled={Boolean(busyOrderId)}
                className={ghostButtonClassName}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isCreateSessionModalOpen || sessionPendingEdit ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/72 px-4">
          <div className="w-full max-w-xl rounded-[1.4rem] border border-white/10 bg-[#0b0b0f] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.45)]">
            <p className="text-[0.68rem] uppercase tracking-[0.22em] text-cyanGlow/80">
              {sessionPendingEdit ? 'Ajustar jornada' : 'Crear jornada manual'}
            </p>
            <h2 className="mt-2 font-display text-2xl text-ivory">
              {sessionPendingEdit ? sessionPendingEdit.sessionLabel : 'Jornada 2026-05-28'}
            </h2>
            <p className="mt-3 text-sm leading-6 text-mist">
              Usa horarios locales de Colombia. Para tu caso: apertura 2026-05-28 7:00 p. m. y cierre 2026-05-29 2:00 a. m.
            </p>

            {sessionWindowErrorMessage ? (
              <div className="mt-4 rounded-[1rem] border border-rose-200/20 bg-rose-200/10 px-4 py-3 text-sm leading-6 text-rose-100">
                {sessionWindowErrorMessage}
              </div>
            ) : null}

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <Field label="Nombre">
                <input
                  value={sessionWindowForm.sessionLabel}
                  onChange={(event) => setSessionWindowForm((current) => ({ ...current, sessionLabel: event.target.value }))}
                  className={inputClassName}
                />
              </Field>
              <Field label="Fecha contable">
                <input
                  type="date"
                  value={sessionWindowForm.businessDate}
                  onChange={(event) => setSessionWindowForm((current) => ({ ...current, businessDate: event.target.value }))}
                  className={inputClassName}
                />
              </Field>
              <Field label="Apertura">
                <input
                  type="datetime-local"
                  value={sessionWindowForm.openedAt}
                  onChange={(event) => setSessionWindowForm((current) => ({ ...current, openedAt: event.target.value }))}
                  className={inputClassName}
                />
              </Field>
              <Field label="Cierre">
                <input
                  type="datetime-local"
                  value={sessionWindowForm.closedAt}
                  onChange={(event) => setSessionWindowForm((current) => ({ ...current, closedAt: event.target.value }))}
                  className={inputClassName}
                />
              </Field>
            </div>

            <Field label="Notas">
              <input
                value={sessionWindowForm.notes}
                onChange={(event) => setSessionWindowForm((current) => ({ ...current, notes: event.target.value }))}
                className={inputClassName}
                placeholder="Correccion de jornada, prueba, cierre real..."
              />
            </Field>

            <div className="mt-5 flex flex-wrap gap-2">
              <button type="button" onClick={() => void handleSaveSessionWindow()} disabled={isSessionWindowBusy} className={primaryButtonClassName}>
                {isSessionWindowBusy ? 'Guardando...' : sessionPendingEdit ? 'Guardar ajuste' : 'Crear jornada'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSessionWindowErrorMessage(null);
                  setIsCreateSessionModalOpen(false);
                  setSessionPendingEdit(null);
                }}
                disabled={isSessionWindowBusy}
                className={ghostButtonClassName}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AdminLayout>
  );
}

function MetricCard({ insight, label, value }: { insight?: string | null; label: string; value: string }) {
  return (
    <article className="rounded-[1.15rem] border border-white/10 bg-white/[0.03] px-4 py-3 sm:rounded-[1.5rem] sm:p-5">
      <p className="text-[0.68rem] uppercase tracking-[0.24em] text-mist">{label}</p>
      <p className="mt-3 font-display text-[2rem] leading-none text-ivory">{value}</p>
      {insight ? <p className="mt-3 text-xs leading-5 text-cyanGlow/75">{insight}</p> : null}
    </article>
  );
}

function ProductRanking({ products }: { products: Array<{ productName: string; quantity: number; totalAmount: number }> }) {
  if (!products.length) {
    return null;
  }

  const maxQuantity = Math.max(...products.map((product) => product.quantity), 1);

  return (
    <section className="rounded-[1.25rem] border border-white/10 bg-white/[0.03] p-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">Productos destacados</p>
          <h2 className="mt-2 font-display text-2xl text-ivory">Top 5 del periodo</h2>
        </div>
        <p className="text-sm text-mist">Cantidad y valor vendido.</p>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-5">
        {products.slice(0, 5).map((product, index) => (
          <article key={product.productName} className="min-w-0 border-l border-white/10 pl-3 first:border-l-cyanGlow/60">
            <p className="text-[0.6rem] uppercase tracking-[0.2em] text-cyanGlow/70">#{index + 1}</p>
            <p className="mt-1 truncate font-semibold text-ivory">{product.productName}</p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-cyanGlow/75" style={{ width: `${Math.max((product.quantity / maxQuantity) * 100, 8)}%` }} />
            </div>
            <div className="mt-2 flex items-center justify-between gap-3 text-sm">
              <span className="text-mist">{product.quantity} und.</span>
              <span className="font-medium text-ivory">{formatCurrency(product.totalAmount)}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function InlineMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="min-w-0 border-b border-white/8 pb-2 sm:border-b-0 sm:border-r sm:pr-4 last:border-r-0">
      <span className="block text-[0.56rem] uppercase tracking-[0.18em] text-cyanGlow/70">{label}</span>
      <span className="mt-1 block truncate text-sm font-semibold text-ivory">{value}</span>
    </span>
  );
}

function PaymentSplit({ cashTotal, transferTotal }: { cashTotal: number; transferTotal: number }) {
  const total = cashTotal + transferTotal;
  const cashPercent = total ? Math.round((cashTotal / total) * 100) : 0;
  const transferPercent = total ? 100 - cashPercent : 0;

  return (
    <div className="min-w-0 border-t border-white/8 pt-3 md:border-l md:border-t-0 md:pl-5 md:pt-0">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[0.6rem] uppercase tracking-[0.18em] text-mist">Pagos</p>
        <p className="text-[0.68rem] text-mist">{total ? `${cashPercent}% efectivo / ${transferPercent}% transf.` : 'Sin pagos'}</p>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-cyanGlow/80" style={{ width: `${cashPercent}%` }} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-[0.56rem] uppercase tracking-[0.18em] text-cyanGlow/70">Efectivo</p>
          <p className="mt-1 font-semibold text-ivory">{formatCurrency(cashTotal)}</p>
        </div>
        <div>
          <p className="text-[0.56rem] uppercase tracking-[0.18em] text-cyanGlow/70">Transferencias</p>
          <p className="mt-1 font-semibold text-ivory">{formatCurrency(transferTotal)}</p>
        </div>
      </div>
    </div>
  );
}

function SummaryPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[1rem] border border-white/8 bg-white/[0.02] px-3 py-2.5">
      <p className="text-[0.62rem] uppercase tracking-[0.2em] text-mist">{label}</p>
      <p className="mt-2 text-sm font-medium text-ivory">{value}</p>
    </div>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <label className="block">
      <span className="text-[0.68rem] uppercase tracking-[0.22em] text-mist">{label}</span>
      <div className="mt-2">{children}</div>
    </label>
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

function EmptyState({ message }: { message: string }) {
  return <div className="rounded-[1rem] border border-dashed border-white/10 bg-white/[0.02] px-3 py-4 text-sm leading-6 text-mist">{message}</div>;
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

function buildSalesSessionsScopeSummary(sessions: PosSalesSessionHistoryEntry[], closedSales: PosOrderWithRelations[]) {
  const productTotals = new Map<string, { quantity: number; totalAmount: number }>();
  let productsCount = 0;

  if (closedSales.length) {
    for (const order of closedSales) {
      for (const item of order.items) {
        if (item.operationalStatus === 'cancelled' || item.financialStatus === 'cancelled') {
          continue;
        }

        const current = productTotals.get(item.productName) ?? { quantity: 0, totalAmount: 0 };
        current.quantity += item.quantity;
        current.totalAmount += item.totalPrice;
        productTotals.set(item.productName, current);
        productsCount += item.quantity;
      }
    }
  } else {
    for (const session of sessions) {
      for (const product of session.summary?.products ?? []) {
        const current = productTotals.get(product.productName) ?? { quantity: 0, totalAmount: 0 };
        current.quantity += product.quantity;
        current.totalAmount += product.totalAmount;
        productTotals.set(product.productName, current);
        productsCount += product.quantity;
      }
    }
  }

  const topProducts = Array.from(productTotals.entries())
    .map(([productName, totals]) => ({ productName, ...totals }))
    .sort((left, right) => {
      if (right.quantity !== left.quantity) {
        return right.quantity - left.quantity;
      }

      return left.productName.localeCompare(right.productName);
    });
  const topProduct = topProducts[0];
  const collectedTotal = sessions.reduce((sum, session) => sum + (session.summary?.totalCollected ?? session.totalCollected), 0);
  const salesCount = closedSales.length || sessions.reduce((sum, session) => sum + session.orderCount, 0);

  return {
    averageTicket: salesCount ? collectedTotal / salesCount : 0,
    cashTotal: sessions.reduce((sum, session) => sum + getSalesSessionCashTotal(session), 0),
    collectedTotal,
    productsCount,
    salesCount,
    soldTotal: sessions.reduce((sum, session) => sum + (session.summary?.grossSales ?? session.totalSold), 0),
    topProductLabel: topProduct ? `${topProduct.productName} (${topProduct.quantity})` : 'Sin ventas',
    topProducts,
    transferTotal: sessions.reduce((sum, session) => sum + getSalesSessionTransferTotal(session), 0),
  };
}

function getSalesSessionCashTotal(session: PosSalesSessionHistoryEntry) {
  return session.summary?.paymentMethods.find((entry) => entry.method === 'cash')?.totalAmount ?? 0;
}

function getSalesSessionTransferTotal(session: PosSalesSessionHistoryEntry) {
  return session.summary?.paymentMethods.filter((entry) => entry.method !== 'cash').reduce((sum, entry) => sum + entry.totalAmount, 0) ?? 0;
}

function getSalesSessionProductsCount(session: PosSalesSessionHistoryEntry) {
  return session.summary?.products.reduce((sum, product) => sum + product.quantity, 0) ?? 0;
}

function getSalesSessionTopProductLabel(session: PosSalesSessionHistoryEntry) {
  const productTotals = new Map<string, { quantity: number; totalAmount: number }>();

  for (const product of session.summary?.products ?? []) {
    const current = productTotals.get(product.productName) ?? { quantity: 0, totalAmount: 0 };
    current.quantity += product.quantity;
    current.totalAmount += product.totalAmount;
    productTotals.set(product.productName, current);
  }

  const topProduct = Array.from(productTotals.entries())
    .map(([productName, totals]) => ({ productName, ...totals }))
    .sort((left, right) => {
      if (right.quantity !== left.quantity) {
        return right.quantity - left.quantity;
      }

      return left.productName.localeCompare(right.productName);
    })[0];

  return topProduct ? `${topProduct.productName} (${topProduct.quantity})` : 'Sin ventas';
}

function getCurrentMonthKey() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    month: '2-digit',
    timeZone: 'America/Bogota',
    year: 'numeric',
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === 'year')?.value ?? String(new Date().getFullYear());
  const month = parts.find((part) => part.type === 'month')?.value ?? String(new Date().getMonth() + 1).padStart(2, '0');

  return `${year}-${month}`;
}

function getSessionMonthKey(session: PosSalesSessionHistoryEntry) {
  return session.businessDate.slice(0, 7);
}

function filterSessionsByPeriod(
  sessions: PosSalesSessionHistoryEntry[],
  periodKey: string,
  customDateRange: { endDate: string; startDate: string },
) {
  if (periodKey === 'all') {
    return sessions;
  }

  if (periodKey === 'range') {
    return sessions.filter((session) => isDateInRange(session.businessDate, customDateRange.startDate, customDateRange.endDate));
  }

  return sessions.filter((session) => getSessionMonthKey(session) === periodKey);
}

function getMonthDateRange(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number);
  const startDate = formatDateKey(new Date(Date.UTC(year, month - 1, 1)));
  const endDate = formatDateKey(new Date(Date.UTC(year, month, 0)));

  return { endDate, startDate };
}

function getComparisonPeriod(periodKey: string, customDateRange: { endDate: string; startDate: string }) {
  if (periodKey === 'all') {
    return null;
  }

  if (periodKey === 'range') {
    const start = parseDateKey(customDateRange.startDate);
    const end = parseDateKey(customDateRange.endDate);
    if (!start || !end || end < start) {
      return null;
    }

    const days = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    const previousEnd = addDays(start, -1);
    const previousStart = addDays(previousEnd, -(days - 1));

    return {
      endDate: formatDateKey(previousEnd),
      startDate: formatDateKey(previousStart),
    };
  }

  const [year, month] = periodKey.split('-').map(Number);
  const previousMonth = new Date(Date.UTC(year, month - 2, 1));

  return getMonthDateRange(formatMonthKey(previousMonth));
}

function isDateInRange(dateKey: string, startDate: string, endDate: string) {
  if (!startDate || !endDate) {
    return false;
  }

  const normalizedStart = startDate <= endDate ? startDate : endDate;
  const normalizedEnd = startDate <= endDate ? endDate : startDate;

  return dateKey >= normalizedStart && dateKey <= normalizedEnd;
}

function formatPeriodLabel(periodKey: string, customDateRange: { endDate: string; startDate: string }) {
  if (periodKey === 'all') {
    return 'Todo el historial';
  }

  if (periodKey === 'range') {
    return formatDateRangeLabel(customDateRange.startDate, customDateRange.endDate);
  }

  return formatMonthLabel(periodKey);
}

function formatDateRangeLabel(startDate: string, endDate: string) {
  if (!startDate || !endDate) {
    return 'Rango personalizado';
  }

  const normalizedStart = startDate <= endDate ? startDate : endDate;
  const normalizedEnd = startDate <= endDate ? endDate : startDate;

  if (normalizedStart === normalizedEnd) {
    return normalizedStart;
  }

  return `${normalizedStart} a ${normalizedEnd}`;
}

function formatComparisonInsight(currentValue: number, previousValue: number, comparisonLabel: string | null) {
  if (!comparisonLabel) {
    return null;
  }

  if (previousValue === 0 && currentValue === 0) {
    return `Sin cambio vs ${comparisonLabel}`;
  }

  if (previousValue === 0) {
    return `Nuevo valor vs ${comparisonLabel}`;
  }

  const delta = currentValue - previousValue;
  const percent = Math.round((delta / previousValue) * 100);
  const sign = percent > 0 ? '+' : '';

  return `${sign}${percent}% vs ${comparisonLabel}`;
}

function parseDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 86400000);
}

function formatDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatMonthKey(date: Date) {
  return date.toISOString().slice(0, 7);
}

function formatMonthLabel(monthKey: string) {
  const [year, month] = monthKey.split('-').map(Number);
  if (!year || !month) {
    return monthKey;
  }

  const label = new Intl.DateTimeFormat('es-CO', {
    month: 'long',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, 1)));

  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('es-CO', {
    currency: 'COP',
    maximumFractionDigits: 0,
    style: 'currency',
  }).format(value);
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('es-CO', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
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
      .join(' - ');
  }

  return entries.map((entry) => `${paymentMethodLabels[entry.method]} ${formatCurrency(entry.totalAmount)}`).join(' - ');
}

function isPosPaymentArray(entries: PosPayment[] | PosSalesSessionSummary['paymentMethods']): entries is PosPayment[] {
  return entries.length > 0 && 'status' in entries[0];
}

function isPaidClosedSale(order: PosOrderWithRelations) {
  return order.closedAt != null && order.financialStatus === 'paid_total' && order.summary.totalDue > 0;
}

type CsvValue = number | string | null | undefined;
type CsvRow = Record<string, CsvValue>;

function downloadCsv(fileName: string, rows: CsvRow[]) {
  if (!rows.length) {
    return;
  }

  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(';'),
    ...rows.map((row) => headers.map((header) => escapeCsvCell(row[header])).join(';')),
  ].join('\n');
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function escapeCsvCell(value: CsvValue) {
  if (value == null) {
    return '';
  }

  const normalized = typeof value === 'number' ? String(value) : value;
  const escaped = normalized.replace(/"/g, '""');
  return /[;\n\r"]/.test(escaped) ? `"${escaped}"` : escaped;
}

function toDateTimeLocalValue(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function toIsoFromDateTimeLocal(value: string) {
  return new Date(value).toISOString();
}

const inputClassName =
  'w-full rounded-[1rem] border border-white/10 bg-obsidian/70 px-4 py-3 text-sm text-ivory outline-none transition focus:border-cyanGlow/40';
