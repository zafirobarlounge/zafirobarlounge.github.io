import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
  formatInventoryMoneyInput,
  formatInventoryQuantity,
  inventoryAreaName,
  inventoryItemMatchesSearch,
  inventoryMoneyInput,
  inventoryUnitLabels,
  receiptCostPreview,
  receiptRequestApplicationPreview,
  type InventoryData,
  type InventorySubmission,
} from './inventory.domain';

export type InventoryPurchaseDraftLine = {
  key: string;
  itemId: string;
  presentationId: string;
  quantity: string;
  costDisplay: string;
  costValue: number | null;
  submissionLineId?: string | null;
  submissionSelectionResolved?: boolean;
};

export function createInventoryPurchaseLine(data: InventoryData, itemId?: string): InventoryPurchaseDraftLine {
  const tracked = data.items.filter((item) => item.tracking_started_at);
  return { key: crypto.randomUUID(), itemId: itemId ?? tracked[0]?.id ?? '', presentationId: 'base', quantity: '', costDisplay: '', costValue: null, submissionSelectionResolved: false };
}

export function inventoryPurchaseLinePreview(data: InventoryData, line: InventoryPurchaseDraftLine) {
  const item = data.items.find((row) => row.id === line.itemId);
  const presentation = data.presentations.find((row) => row.id === line.presentationId && row.item_id === line.itemId && row.active);
  const preview = receiptCostPreview(Number(line.quantity || 0), presentation ? Number(presentation.content_per_package) : 1, Number(line.costValue || 0), presentation ? 'package' : 'line_total');
  return { item, presentation, ...preview, costKnown: line.costValue != null };
}

export function buildInventoryPurchaseLines(data: InventoryData, lines: InventoryPurchaseDraftLine[]) {
  return lines.map((line) => {
    const preview = inventoryPurchaseLinePreview(data, line);
    return {
      item_id: line.itemId,
      presentation_id: preview.presentation?.id ?? null,
      package_quantity: preview.presentation ? Number(line.quantity) : null,
      base_quantity: preview.presentation ? null : Number(line.quantity),
      actual_package_cost: preview.presentation ? line.costValue : null,
      line_total_cost: preview.presentation ? null : line.costValue,
      base_unit_cost: null,
      submission_line_id: line.submissionLineId || null,
    };
  });
}

export function inventoryPurchaseTotal(data: InventoryData, lines: InventoryPurchaseDraftLine[]) {
  if (!lines.length || lines.some((line) => !inventoryPurchaseLinePreview(data, line).costKnown)) return null;
  return Math.round(lines.reduce((sum, line) => sum + inventoryPurchaseLinePreview(data, line).lineTotal, 0) * 100) / 100;
}

export function inventoryPurchaseLinesValid(data: InventoryData, lines: InventoryPurchaseDraftLine[]) {
  return lines.length > 0 && lines.every((line) => {
    const preview = inventoryPurchaseLinePreview(data, line);
    return Boolean(preview.item?.tracking_started_at) && Number(line.quantity) > 0;
  });
}

export type InventoryPendingSubmissionLine = InventorySubmission['lines'][number] & {
  area: InventorySubmission['area'];
  createdAt: string;
  submissionId: string;
};

export function inventoryPendingSubmissionLines(submissions: InventorySubmission[], itemId: string): InventoryPendingSubmissionLine[] {
  return submissions.flatMap((submission) => {
    if (submission.kind !== 'replenishment' || !['approved', 'partially_received'].includes(submission.status)) return [];
    return submission.lines
      .filter((line) => line.item_id === itemId && Number(line.approved_quantity ?? 0) > Number(line.received_quantity ?? 0))
      .map((line) => ({ ...line, area: submission.area, createdAt: submission.created_at, submissionId: submission.id }));
  });
}

export function reconcileInventoryPurchaseSubmissionLinks(lines: InventoryPurchaseDraftLine[], submissions: InventorySubmission[]) {
  const selected = new Set<string>();
  let invalidated = false;
  const next = lines.map((line) => {
    const compatible = inventoryPendingSubmissionLines(submissions, line.itemId);
    if (line.submissionLineId) {
      const remainsValid = compatible.some((candidate) => candidate.id === line.submissionLineId) && !selected.has(line.submissionLineId);
      if (remainsValid) {
        selected.add(line.submissionLineId);
        return line;
      }
      invalidated = true;
      return { ...line, submissionLineId: null, submissionSelectionResolved: true };
    }
    if (line.submissionSelectionResolved) return line;
    const available = compatible.filter((candidate) => !selected.has(candidate.id));
    if (available.length === 1) {
      selected.add(available[0].id);
      return { ...line, submissionLineId: available[0].id, submissionSelectionResolved: true };
    }
    return line;
  });
  return { lines: next, invalidated };
}

const fieldClass = 'w-full rounded-[0.9rem] border border-white/10 bg-obsidian/60 px-4 py-3 text-base text-ivory outline-none transition focus:border-cyanGlow/40';

export function InventoryPurchaseLinesEditor({ data, lines, setLines, lockedFirstItemId = null, pendingSubmissions = null, pendingError = null, onSubmissionNotice }: {
  data: InventoryData;
  lines: InventoryPurchaseDraftLine[];
  setLines: Dispatch<SetStateAction<InventoryPurchaseDraftLine[]>>;
  lockedFirstItemId?: string | null;
  pendingSubmissions?: InventorySubmission[] | null;
  pendingError?: string | null;
  onSubmissionNotice?: (message: string | null) => void;
}) {
  const tracked = data.items.filter((item) => item.tracking_started_at && item.active);
  const [searches, setSearches] = useState<Record<string, string>>({});
  const update = (key: string, changes: Partial<InventoryPurchaseDraftLine>) => setLines((current) => current.map((line) => line.key === key ? { ...line, ...changes } : line));

  useEffect(() => {
    if (pendingSubmissions == null) return;
    const reconciled = reconcileInventoryPurchaseSubmissionLinks(lines, pendingSubmissions);
    if (reconciled.lines.some((line, index) => line !== lines[index])) setLines(reconciled.lines);
    if (reconciled.invalidated) onSubmissionNotice?.('Una solicitud seleccionada dejó de estar disponible. La línea quedó como recepción directa; revisa antes de guardar.');
  }, [lines, onSubmissionNotice, pendingSubmissions, setLines]);

  return <div className="space-y-3">
    {pendingError ? <p role="alert" className="rounded-[0.8rem] border border-amberGlow/25 bg-amberGlow/[0.07] p-3 text-sm text-amber-100">{pendingError}</p> : null}
    {lines.map((line, index) => {
      const preview = inventoryPurchaseLinePreview(data, line);
      const presentations = data.presentations.filter((row) => row.item_id === line.itemId && row.active);
      const matchingItems = tracked.filter((item) => inventoryItemMatchesSearch(item, searches[line.key] ?? ''));
      const precision = preview.presentation ? 0 : preview.item?.precision_scale ?? 3;
      const selectedElsewhere = new Set(lines.filter((candidate) => candidate.key !== line.key).map((candidate) => candidate.submissionLineId).filter(Boolean));
      const compatibleRequests = pendingSubmissions == null ? [] : inventoryPendingSubmissionLines(pendingSubmissions, line.itemId).filter((candidate) => !selectedElsewhere.has(candidate.id));
      const linkedRequest = compatibleRequests.find((candidate) => candidate.id === line.submissionLineId);
      const requestPreview = linkedRequest ? receiptRequestApplicationPreview(Number(linkedRequest.approved_quantity ?? 0), Number(linkedRequest.received_quantity ?? 0), preview.baseQuantity) : null;

      return <section key={line.key} className="rounded-[1rem] border border-white/10 bg-black/15 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <strong className="text-ivory">Producto {index + 1}</strong>
          {lines.length > 1 ? <button type="button" className="text-sm text-rose-200 underline" onClick={() => setLines((current) => current.filter((candidate) => candidate.key !== line.key))}>Quitar</button> : null}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-mist">Producto</span>
            <div className="space-y-2">{index === 0 && lockedFirstItemId ? <div className={fieldClass}>{preview.item?.name}</div> : <>
              <input aria-label={`Buscar artículo para entrada ${index + 1}`} className={fieldClass} value={searches[line.key] ?? ''} onChange={(event) => {
                const search = event.target.value;
                const nextMatches = tracked.filter((item) => inventoryItemMatchesSearch(item, search));
                setSearches((current) => ({ ...current, [line.key]: search }));
                if (!nextMatches.some((item) => item.id === line.itemId)) update(line.key, { itemId: nextMatches[0]?.id ?? '', presentationId: 'base', costDisplay: '', costValue: null, submissionLineId: null, submissionSelectionResolved: false });
              }} placeholder="Nombre o código" />
              <select aria-label={`Producto de compra ${index + 1}`} className={fieldClass} value={matchingItems.some((item) => item.id === line.itemId) ? line.itemId : ''} onChange={(event) => update(line.key, { itemId: event.target.value, presentationId: 'base', costDisplay: '', costValue: null, submissionLineId: null, submissionSelectionResolved: false })}>{matchingItems.length ? matchingItems.map((item) => <option key={item.id} value={item.id}>{item.name}</option>) : <option value="">Sin artículos coincidentes</option>}</select>
            </>}</div>
          </label>
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-mist">Presentación</span>
            <select aria-label={`Presentación de compra ${index + 1}`} className={fieldClass} value={line.presentationId} onChange={(event) => {
              const presentation = presentations.find((row) => row.id === event.target.value);
              update(line.key, { presentationId: event.target.value, costDisplay: formatInventoryMoneyInput(presentation?.suggested_package_cost), costValue: presentation?.suggested_package_cost ?? null });
            }}><option value="base">Unidad base directa</option>{presentations.map((row) => <option key={row.id} value={row.id}>{row.name} · {row.content_per_package} {inventoryUnitLabels[row.content_unit]}</option>)}</select>
          </label>
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-mist">{preview.presentation ? 'Cantidad de paquetes/presentaciones' : `Cantidad en ${preview.item ? inventoryUnitLabels[preview.item.base_unit] : 'unidad base'}`}</span>
            <input aria-label={`Cantidad comprada ${index + 1}`} className={fieldClass} type="number" min={precision === 0 ? 1 : 0.001} step={precision === 0 ? 1 : 0.001} required value={line.quantity} onChange={(event) => update(line.key, { quantity: event.target.value })} />
          </label>
          <label className="block">
            <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-mist">{preview.presentation ? 'Costo real por presentación' : 'Costo total de la línea'} (COP)</span>
            <input aria-label={`Costo de compra ${index + 1}`} className={fieldClass} inputMode="decimal" value={line.costDisplay} onChange={(event) => { const value = inventoryMoneyInput(event.target.value); update(line.key, { costDisplay: value.display, costValue: value.value }); }} placeholder="0" />
          </label>
        </div>
        <div className={`mt-4 rounded-[0.9rem] border p-3 transition ${linkedRequest ? 'border-emerald-300/35 bg-emerald-300/[0.08]' : compatibleRequests.length ? 'border-amberGlow/40 bg-amberGlow/[0.08]' : 'border-white/10 bg-black/10'}`}>
          <label className="block">
            <span className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-ivory">Aplicar a solicitud pendiente (opcional)</span>
              {linkedRequest ? <span className="inline-flex items-center gap-2 rounded-full border border-emerald-300/30 bg-emerald-300/10 px-2.5 py-1 text-xs font-semibold text-emerald-200"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />Solicitud vinculada</span> : compatibleRequests.length ? <span className="inline-flex items-center gap-2 rounded-full border border-amberGlow/30 bg-amberGlow/10 px-2.5 py-1 text-xs font-semibold text-amber-100"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />{compatibleRequests.length} {compatibleRequests.length === 1 ? 'pendiente por aplicar' : 'pendientes por aplicar'}</span> : null}
            </span>
            <select aria-label={`Solicitud pendiente para producto ${index + 1}`} className={`${fieldClass} ${linkedRequest ? 'border-emerald-300/40' : compatibleRequests.length ? 'border-amberGlow/50' : ''}`} disabled={pendingSubmissions == null} value={line.submissionLineId ?? ''} onChange={(event) => { onSubmissionNotice?.(null); update(line.key, { submissionLineId: event.target.value || null, submissionSelectionResolved: true }); }}>
              <option value="">{pendingSubmissions == null ? 'Cargando solicitudes…' : 'Recepción directa, sin solicitud'}</option>
              {compatibleRequests.map((request) => <option key={request.id} value={request.id}>{inventoryAreaName(data.areas, request.area)} · {preview.item ? formatInventoryQuantity(Number(request.approved_quantity) - Number(request.received_quantity), preview.item.base_unit, preview.item.precision_scale) : Number(request.approved_quantity) - Number(request.received_quantity)} pendientes · {new Date(request.createdAt).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' })}</option>)}
            </select>
          </label>
        </div>
        {requestPreview && preview.item ? <div className="mt-3 grid gap-x-5 gap-y-1 rounded-[0.8rem] border border-cyanGlow/20 bg-cyanGlow/[0.06] p-3 text-sm text-mist sm:grid-cols-2">
          <p>Pendiente de solicitud: <strong className="text-ivory">{formatInventoryQuantity(requestPreview.pending, preview.item.base_unit, preview.item.precision_scale)}</strong></p>
          <p>Cantidad realmente recibida: <strong className="text-ivory">{formatInventoryQuantity(requestPreview.received, preview.item.base_unit, preview.item.precision_scale)}</strong></p>
          <p>Aplicado a solicitud: <strong className="text-cyanGlow">{formatInventoryQuantity(requestPreview.applied, preview.item.base_unit, preview.item.precision_scale)}</strong></p>
          {requestPreview.excess > 0 ? <p>Excedente: <strong className="text-amber-100">{formatInventoryQuantity(requestPreview.excess, preview.item.base_unit, preview.item.precision_scale)}</strong></p> : null}
          {requestPreview.pendingAfter > 0 ? <p>Pendiente después de guardar: <strong className="text-ivory">{formatInventoryQuantity(requestPreview.pendingAfter, preview.item.base_unit, preview.item.precision_scale)}</strong></p> : null}
        </div> : null}
        <p className="mt-3 text-sm text-mist">Cantidad base recibida: <strong className="text-cyanGlow">{preview.baseQuantity || 0} {preview.item ? inventoryUnitLabels[preview.item.base_unit] : ''}</strong>{preview.presentation ? ` = ${line.quantity || 0} × ${preview.presentation.content_per_package}` : ''} · Total línea: <strong className="text-ivory">{preview.costKnown ? new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 2 }).format(preview.lineTotal) : 'Sin costo'}</strong>{preview.costKnown && preview.baseQuantity > 0 ? ` · Costo base: ${new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 2 }).format(preview.baseUnitCost)}` : ''}</p>
        <p className="mt-2 text-xs text-mist">La presentación real, su conversión y los costos de toda la entrada quedarán congelados.</p>
      </section>;
    })}
    <button type="button" className="rounded-full border border-cyanGlow/40 px-4 py-2 text-sm font-semibold text-cyanGlow transition hover:bg-cyanGlow/10" onClick={() => setLines((current) => [...current, createInventoryPurchaseLine(data)])}>+ Agregar producto</button>
  </div>;
}
