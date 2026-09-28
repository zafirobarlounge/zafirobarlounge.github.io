import { useCallback, useDeferredValue, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  formatConfiguredInventoryQuantity,
  formatInventoryQuantity,
  encodeInventorySubmissionLineNotes,
  inventoryItemMatchesSearch,
  inventoryUnitLabels,
  submissionKindLabels,
  type InventoryArea,
  type InventoryData,
  type InventoryItem,
  type InventoryPresentation,
  type InventoryReplenishmentPresentationSnapshot,
  type InventorySubmission,
  type InventorySubmissionKind,
} from './inventory.domain';
import { loadInventory, saveInventoryCommand } from './inventory.repository';

export type AreaInventoryStatusFilter = 'all' | 'low' | 'depleted' | 'uncounted';
export type AreaInventoryItemState = Exclude<AreaInventoryStatusFilter, 'all'> | 'available';
export type AreaInventoryToggleAction = 'close' | 'open' | 'open-and-load';

const statusLabels: Record<string, string> = {
  approved: 'Aprobada',
  draft: 'Borrador',
  partially_approved: 'Aprobación parcial',
  partially_received: 'Recibida parcialmente',
  received: 'Recibida',
  rejected: 'Rechazada',
  sent: 'Enviada',
};

const emptyData: InventoryData = {
  can_manage: false,
  can_configure: false,
  items: [],
  presentations: [],
  recipes: [],
  menu_items: [],
  submissions: [],
  receipts: [],
  movements: [],
};

export function getAreaInventoryItemState(item: Pick<InventoryItem, 'balance' | 'minimum_quantity'>): AreaInventoryItemState {
  if (item.balance == null) return 'uncounted';
  if (item.balance <= 0) return 'depleted';
  if (item.minimum_quantity != null && item.balance < item.minimum_quantity) return 'low';
  return 'available';
}

export function filterAreaInventoryItems(
  items: InventoryItem[],
  area: InventoryArea,
  search: string,
  status: AreaInventoryStatusFilter,
) {
  return items
    .filter((item) => item.active && item.areas.includes(area))
    .filter((item) => inventoryItemMatchesSearch(item, search))
    .filter((item) => status === 'all' || getAreaInventoryItemState(item) === status)
    .sort((left, right) => left.name.localeCompare(right.name, 'es', { sensitivity: 'base' }));
}

export function summarizeAreaInventory(items: InventoryItem[], area: InventoryArea) {
  const areaItems = items.filter((item) => item.active && item.areas.includes(area));
  return areaItems.reduce((summary, item) => {
    const state = getAreaInventoryItemState(item);
    summary.total += 1;
    if (state === 'low') summary.low += 1;
    if (state === 'depleted') summary.depleted += 1;
    if (state === 'uncounted') summary.uncounted += 1;
    return summary;
  }, { total: 0, low: 0, depleted: 0, uncounted: 0 });
}

export function getAreaInventoryToggleAction(expanded: boolean, hasLoaded: boolean, loading: boolean): AreaInventoryToggleAction {
  if (expanded) return 'close';
  if (!hasLoaded && !loading) return 'open-and-load';
  return 'open';
}

export function buildAreaInventorySubmissionPayload(
  area: InventoryArea,
  itemId: string,
  kind: InventorySubmissionKind,
  quantity: number,
  notes: string,
  presentation?: InventoryReplenishmentPresentationSnapshot | null,
): Record<string, unknown> {
  return {
    action: 'submit',
    kind,
    area,
    status: 'sent',
    notes: notes.trim(),
    lines: [{
      item_id: itemId,
      [kind === 'count' ? 'observed_quantity' : 'requested_quantity']: quantity,
      notes: encodeInventorySubmissionLineNotes(notes, kind === 'replenishment' ? presentation : null),
    }],
  };
}

export function calculateInventoryRequestedBaseQuantity(packageQuantity: number, contentPerPackage: number) {
  if (!Number.isInteger(packageQuantity) || packageQuantity <= 0 || !Number.isFinite(contentPerPackage) || contentPerPackage <= 0) return null;
  return Number((packageQuantity * contentPerPackage).toFixed(3));
}

function getSubmissionQuantity(submission: InventorySubmission) {
  const line = submission.lines[0];
  if (!line) return null;
  return submission.kind === 'count' ? line.observed_quantity : line.requested_quantity;
}

export function AreaInventoryPanel({ area }: { area: InventoryArea }) {
  const [expanded, setExpanded] = useState(false);
  const [recentReportsExpanded, setRecentReportsExpanded] = useState(false);
  const [data, setData] = useState<InventoryData>(emptyData);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<AreaInventoryStatusFilter>('all');
  const [report, setReport] = useState<{ item: InventoryItem; kind: InventorySubmissionKind } | null>(null);
  const [quantity, setQuantity] = useState('');
  const [notes, setNotes] = useState('');
  const [selectedPresentationId, setSelectedPresentationId] = useState('');
  const [saving, setSaving] = useState(false);
  const loadingRef = useRef(false);
  const deferredSearch = useDeferredValue(search);
  const areaLabel = area === 'bar' ? 'Bar' : 'Cocina';

  const refresh = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      setData(await loadInventory());
      setHasLoaded(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo cargar el inventario del área.');
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  const summary = useMemo(() => summarizeAreaInventory(data.items, area), [area, data.items]);
  const items = useMemo(
    () => filterAreaInventoryItems(data.items, area, deferredSearch, status),
    [area, data.items, deferredSearch, status],
  );
  const recentSubmissions = useMemo(
    () => data.submissions
      .filter((submission) => submission.area === area)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, 8),
    [area, data.submissions],
  );

  const toggleInventory = () => {
    const action = getAreaInventoryToggleAction(expanded, hasLoaded, loadingRef.current);
    if (action === 'close') {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (action === 'open-and-load') void refresh();
  };

  const openReport = (item: InventoryItem, kind: InventorySubmissionKind) => {
    const firstActivePresentation = data.presentations.find((presentation) => presentation.active && presentation.item_id === item.id);
    setReport({ item, kind });
    setQuantity('');
    setNotes('');
    setSelectedPresentationId(kind === 'replenishment' ? firstActivePresentation?.id ?? '' : '');
    setError(null);
    setNotice(null);
  };

  const submitReport = async () => {
    if (!report) return;
    const numericQuantity = Number(quantity);
    const activePresentations = data.presentations.filter((presentation) => presentation.active && presentation.item_id === report.item.id);
    const selectedPresentation = report.kind === 'replenishment'
      ? activePresentations.find((presentation) => presentation.id === selectedPresentationId) ?? null
      : null;
    const packageRequest = report.kind === 'replenishment' && activePresentations.length > 0;
    const quantityIsValid = report.kind === 'count'
      ? numericQuantity >= 0
      : packageRequest
        ? Number.isInteger(numericQuantity) && numericQuantity > 0
        : numericQuantity > 0;
    if (!Number.isFinite(numericQuantity) || !quantityIsValid) {
      setError(report.kind === 'count' ? 'Indica una cantidad observada válida.' : 'Indica una cantidad mayor que cero.');
      return;
    }
    if (packageRequest && !selectedPresentation) {
      setError('Selecciona una presentación activa.');
      return;
    }
    if (selectedPresentation && selectedPresentation.content_unit !== report.item.base_unit) {
      setError('La presentación no coincide con la unidad base del artículo.');
      return;
    }
    if (report.kind === 'damage' && !notes.trim()) {
      setError('Describe el daño o la pérdida antes de enviar el reporte.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const baseQuantity = selectedPresentation
        ? calculateInventoryRequestedBaseQuantity(numericQuantity, Number(selectedPresentation.content_per_package))
        : numericQuantity;
      if (baseQuantity == null) {
        setError('No se pudo calcular la equivalencia de la presentación.');
        return;
      }
      const presentationSnapshot: InventoryReplenishmentPresentationSnapshot | null = selectedPresentation ? {
        presentation_id: selectedPresentation.id,
        presentation_name: selectedPresentation.name,
        content_per_package: Number(selectedPresentation.content_per_package),
        content_unit: selectedPresentation.content_unit,
        package_quantity: numericQuantity,
      } : null;
      await saveInventoryCommand(
        crypto.randomUUID(),
        buildAreaInventorySubmissionPayload(area, report.item.id, report.kind, baseQuantity, notes, presentationSnapshot),
      );
      setNotice('Reporte enviado. Las existencias no cambian hasta la revisión correspondiente.');
      setReport(null);
      setQuantity('');
      setNotes('');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo enviar el reporte.');
    } finally {
      setSaving(false);
    }
  };

  const summaryText = hasLoaded
    ? `${summary.total} artículos · ${summary.low} bajos · ${summary.depleted} agotados · ${summary.uncounted} sin conteo`
    : 'Consulta existencias, solicitudes, conteos y daños del área.';

  return (
    <section data-area-inventory={area} className="rounded-[1.35rem] border border-white/10 bg-white/[0.025] p-4 shadow-[0_20px_60px_rgba(0,0,0,0.12)] sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyanGlow/80">Inventario del área</p>
          <p className="mt-2 text-sm text-mist">{summaryText}</p>
        </div>
        <button type="button" aria-expanded={expanded} className={ghostButton} onClick={toggleInventory}>
          {expanded ? 'Ocultar inventario' : 'Ver inventario'}
        </button>
      </div>

      {expanded ? (
        <div className="mt-5 border-t border-white/10 pt-5">
          {error ? (
            <div role="alert" className="mb-5 rounded-[1rem] border border-rose-300/30 bg-rose-300/10 p-4 text-sm text-rose-100">
              {error} <button type="button" className="ml-2 underline" disabled={loading} onClick={() => void refresh()}>Reintentar</button>
            </div>
          ) : null}
          {notice ? <div className="mb-5 rounded-[1rem] border border-emerald-300/25 bg-emerald-300/10 p-4 text-sm text-emerald-100">{notice}</div> : null}
          {loading && !hasLoaded ? <EmptyState message="Cargando inventario…" /> : null}

          {hasLoaded ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1rem] border border-cyanGlow/15 bg-cyanGlow/[0.05] px-4 py-3">
                <p className="text-sm font-medium text-ivory">{summaryText}</p>
                <button type="button" className={ghostButton} disabled={loading} onClick={() => void refresh()}>{loading ? 'Actualizando…' : 'Actualizar'}</button>
              </div>

              <div className="mt-4 grid gap-3 rounded-[1.1rem] border border-white/10 bg-black/15 p-4 sm:grid-cols-2">
                <Field label="Buscar artículo">
                  <input aria-label={`Buscar inventario de ${areaLabel}`} className={inputClass} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nombre" />
                </Field>
                <Field label="Estado">
                  <select aria-label={`Filtrar inventario de ${areaLabel} por estado`} className={inputClass} value={status} onChange={(event) => setStatus(event.target.value as AreaInventoryStatusFilter)}>
                    <option value="all">Todos</option>
                    <option value="low">Bajo mínimo</option>
                    <option value="depleted">Agotados</option>
                    <option value="uncounted">Sin conteo inicial</option>
                  </select>
                </Field>
                <p className="text-xs text-mist sm:col-span-2">Mostrando {items.length} de {summary.total} artículos asignados a {areaLabel.toLowerCase()}.</p>
              </div>

              <div className="mt-5 rounded-[1.1rem] border border-white/10 bg-white/[0.02] p-4">
                <button type="button" aria-expanded={recentReportsExpanded} aria-controls={`area-recent-reports-${area}`} className="flex w-full items-center justify-between gap-4 text-left" onClick={() => setRecentReportsExpanded((current) => !current)}>
                  <span><span className="block font-display text-2xl text-ivory">Reportes recientes del área</span><span className="mt-1 block text-xs text-mist">{recentSubmissions.length} reporte(s) reciente(s)</span></span>
                  <span className="shrink-0 text-xs font-semibold uppercase tracking-[0.16em] text-cyanGlow">{recentReportsExpanded ? 'Ocultar' : 'Ver reportes'}</span>
                </button>
                {recentReportsExpanded ? <div id={`area-recent-reports-${area}`} className="mt-3 grid gap-2 border-t border-white/10 pt-3 lg:grid-cols-2">
                    {recentSubmissions.map((submission) => {
                      const quantityValue = getSubmissionQuantity(submission);
                      const firstLine = submission.lines[0];
                      const item = data.items.find((candidate) => candidate.id === firstLine?.item_id);
                      return (
                        <article key={submission.id} className="rounded-[0.9rem] border border-white/8 bg-black/20 p-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <p className="text-sm font-semibold text-ivory">{submissionKindLabels[submission.kind]} · {firstLine?.item_name ?? 'Artículo no disponible'}</p>
                              <p className="mt-1 text-xs text-mist">
                                {quantityValue == null ? 'Cantidad sin registrar' : item ? formatInventoryQuantity(quantityValue, item.base_unit, item.precision_scale) : String(quantityValue)} · {formatDateTime(submission.created_at)}
                              </p>
                            </div>
                            <span className="rounded-full border border-white/10 px-2.5 py-1 text-[0.65rem] text-cyanGlow">{statusLabels[submission.status] ?? submission.status}</span>
                          </div>
                        </article>
                      );
                    })}
                    {!recentSubmissions.length ? <EmptyState message="Todavía no hay reportes enviados desde esta área." /> : null}
                  </div> : null}
              </div>

              {!items.length ? <div className="mt-5"><EmptyState message="No hay artículos que coincidan con la búsqueda y el filtro seleccionados." /></div> : null}
              {items.length ? (
                <div className="mt-5 grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                  {items.map((item) => <AreaInventoryItemCard key={item.id} item={item} onReport={(kind) => openReport(item, kind)} />)}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {report ? (
        <InventoryReportDialog
          areaLabel={areaLabel}
          busy={saving}
          error={error}
          item={report.item}
          kind={report.kind}
          notes={notes}
          presentations={data.presentations.filter((presentation) => presentation.active && presentation.item_id === report.item.id)}
          quantity={quantity}
          selectedPresentationId={selectedPresentationId}
          onClose={() => setReport(null)}
          onNotesChange={setNotes}
          onQuantityChange={setQuantity}
          onSelectedPresentationChange={setSelectedPresentationId}
          onSubmit={submitReport}
        />
      ) : null}
    </section>
  );
}

function AreaInventoryItemCard({ item, onReport }: { item: InventoryItem; onReport: (kind: InventorySubmissionKind) => void }) {
  const state = getAreaInventoryItemState(item);
  const stateLabel = state === 'uncounted' ? 'Sin conteo inicial' : state === 'depleted' ? 'Agotado' : state === 'low' ? 'Bajo mínimo' : 'Disponible';
  const stateClass = state === 'depleted'
    ? 'border-rose-300/35 bg-rose-300/[0.08] text-rose-100'
    : state === 'low' || state === 'uncounted'
      ? 'border-amberGlow/30 bg-amberGlow/[0.08] text-amber-100'
      : 'border-emerald-300/25 bg-emerald-300/[0.07] text-emerald-100';
  return (
    <article className="rounded-[1.05rem] border border-white/10 bg-white/[0.035] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate font-display text-xl text-ivory">{item.name}</h3>
          <p className="mt-1 text-lg font-semibold text-cyanGlow">{formatInventoryQuantity(item.balance, item.base_unit, item.precision_scale)}</p>
        </div>
        {state !== 'uncounted' ? <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[0.62rem] font-semibold uppercase tracking-[0.12em] ${stateClass}`}>{stateLabel}</span> : null}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-mist">
        <p>Unidad base<br/><strong className="text-ivory">{inventoryUnitLabels[item.base_unit]}</strong></p>
        <p>Mínimo<br/><strong className="text-ivory">{formatConfiguredInventoryQuantity(item.minimum_quantity, item.base_unit, item.precision_scale)}</strong></p>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2">
        <button type="button" className={smallPrimaryButton} onClick={() => onReport('replenishment')}>Solicitar</button>
        <button type="button" className={smallGhostButton} onClick={() => onReport('count')}>Contar</button>
        <button type="button" className={smallDangerButton} onClick={() => onReport('damage')}>Daño</button>
      </div>
    </article>
  );
}

function InventoryReportDialog({ areaLabel, busy, error, item, kind, notes, presentations, quantity, selectedPresentationId, onClose, onNotesChange, onQuantityChange, onSelectedPresentationChange, onSubmit }: {
  areaLabel: string;
  busy: boolean;
  error: string | null;
  item: InventoryItem;
  kind: InventorySubmissionKind;
  notes: string;
  presentations: InventoryPresentation[];
  quantity: string;
  selectedPresentationId: string;
  onClose: () => void;
  onNotesChange: (value: string) => void;
  onQuantityChange: (value: string) => void;
  onSelectedPresentationChange: (value: string) => void;
  onSubmit: () => Promise<void>;
}) {
  const selectedPresentation = presentations.find((presentation) => presentation.id === selectedPresentationId) ?? null;
  const packageQuantity = Number(quantity);
  const equivalentQuantity = selectedPresentation && Number.isInteger(packageQuantity) && packageQuantity > 0
    ? calculateInventoryRequestedBaseQuantity(packageQuantity, Number(selectedPresentation.content_per_package))
    : kind === 'replenishment' && !presentations.length && Number.isFinite(packageQuantity) && packageQuantity > 0
      ? packageQuantity
      : null;
  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/75 p-3 sm:items-center" role="dialog" aria-modal="true">
      <div className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-[1.4rem] border border-white/12 bg-[#0d0d13] p-5 shadow-2xl sm:p-7">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div><p className="text-xs uppercase tracking-[0.2em] text-cyanGlow">Inventario de {areaLabel}</p><h2 className="mt-2 font-display text-3xl text-ivory">{submissionKindLabels[kind]}</h2></div>
          <button type="button" className={ghostButton} onClick={onClose}>Cerrar</button>
        </div>
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void onSubmit(); }}>
          {error ? <div role="alert" className="rounded-[1rem] border border-rose-300/30 bg-rose-300/10 p-4 text-sm text-rose-100">{error}</div> : null}
          <Field label="Artículo"><div className="rounded-[1rem] border border-white/10 bg-white/[0.04] px-4 py-3 text-base text-ivory">{item.name} · {formatInventoryQuantity(item.balance, item.base_unit, item.precision_scale)}</div></Field>
          {kind === 'replenishment' ? (
            <>
              <Field label="Presentación">
                {!presentations.length ? <div className={lockedValueClass}>Solicitud directa en unidad base · {inventoryUnitLabels[item.base_unit]}</div> : presentations.length === 1 ? <div className={lockedValueClass}>{presentations[0].name} · {formatInventoryQuantity(Number(presentations[0].content_per_package), presentations[0].content_unit, item.precision_scale)}</div> : <select aria-label="Presentación solicitada" className={inputClass} required value={selectedPresentationId} onChange={(event) => onSelectedPresentationChange(event.target.value)}>{presentations.map((presentation) => <option key={presentation.id} value={presentation.id}>{presentation.name} · {formatInventoryQuantity(Number(presentation.content_per_package), presentation.content_unit, item.precision_scale)}</option>)}</select>}
              </Field>
              <Field label={presentations.length ? 'Cantidad de paquetes/pacas/envases' : `Cantidad a solicitar en ${inventoryUnitLabels[item.base_unit]}`}>
                <input className={inputClass} type="number" min={presentations.length ? '1' : item.precision_scale > 0 ? '0.001' : '1'} step={presentations.length ? '1' : item.precision_scale > 0 ? '0.001' : '1'} required value={quantity} onChange={(event) => onQuantityChange(event.target.value)} />
              </Field>
              <Field label="Equivale a">
                <div className={lockedValueClass}>{equivalentQuantity == null ? 'Indica una cantidad para calcular la equivalencia.' : selectedPresentation ? `${packageQuantity} × ${selectedPresentation.name} = ${formatInventoryQuantity(equivalentQuantity, item.base_unit, item.precision_scale)}` : formatInventoryQuantity(equivalentQuantity, item.base_unit, item.precision_scale)}</div>
              </Field>
            </>
          ) : <Field label={kind === 'count' ? 'Cantidad física observada' : 'Cantidad'}><input className={inputClass} type="number" min={kind === 'count' ? '0' : item.precision_scale > 0 ? '0.001' : '1'} step={item.precision_scale > 0 ? '0.001' : '1'} required value={quantity} onChange={(event) => onQuantityChange(event.target.value)} /></Field>}
          <Field label={kind === 'damage' ? 'Descripción del daño o pérdida' : 'Nota opcional'}><textarea className={inputClass} rows={3} required={kind === 'damage'} value={notes} onChange={(event) => onNotesChange(event.target.value)} /></Field>
          <p className="text-sm text-mist">El reporte se enviará para revisión y no cambiará las existencias por sí solo.</p>
          <div className="flex flex-wrap justify-end gap-2 pt-2"><button type="button" className={ghostButton} onClick={onClose}>Cancelar</button><button type="submit" className={primaryButton} disabled={busy || quantity === '' || (kind === 'replenishment' && presentations.length > 0 && !selectedPresentation) || (kind === 'damage' && !notes.trim())}>{busy ? 'Enviando…' : kind === 'replenishment' ? 'Enviar solicitud' : 'Enviar reporte'}</button></div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-2 block text-xs font-semibold uppercase tracking-[0.16em] text-mist">{label}</span>{children}</label>;
}

function EmptyState({ message }: { message: string }) {
  return <p className="rounded-[0.9rem] border border-white/8 bg-black/15 p-4 text-sm text-mist">{message}</p>;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('es-CO', { day: '2-digit', hour: 'numeric', minute: '2-digit', month: '2-digit', timeZone: 'America/Bogota' }).format(new Date(value));
}

const inputClass = 'w-full rounded-[0.9rem] border border-white/10 bg-obsidian/60 px-4 py-3 text-base text-ivory outline-none transition focus:border-cyanGlow/40';
const lockedValueClass = 'w-full rounded-[0.9rem] border border-white/10 bg-white/[0.04] px-4 py-3 text-base text-ivory';
const primaryButton = 'rounded-full border border-cyanGlow/30 bg-cyanGlow/12 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-cyanGlow transition hover:bg-cyanGlow/18 disabled:cursor-not-allowed disabled:opacity-50';
const ghostButton = 'rounded-full border border-white/12 bg-white/[0.05] px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-ivory transition hover:border-cyanGlow/25 hover:bg-white/[0.09] disabled:cursor-not-allowed disabled:opacity-50';
const smallPrimaryButton = 'min-w-0 rounded-full border border-cyanGlow/30 bg-cyanGlow/12 px-2 py-2 text-[0.62rem] font-semibold uppercase tracking-[0.1em] text-cyanGlow transition hover:bg-cyanGlow/18';
const smallGhostButton = 'min-w-0 rounded-full border border-white/12 bg-white/[0.05] px-2 py-2 text-[0.62rem] font-semibold uppercase tracking-[0.1em] text-ivory transition hover:border-cyanGlow/25 hover:bg-white/[0.09]';
const smallDangerButton = 'min-w-0 rounded-full border border-rose-300/25 bg-rose-300/10 px-2 py-2 text-[0.62rem] font-semibold uppercase tracking-[0.1em] text-rose-100 transition hover:bg-rose-300/16';
