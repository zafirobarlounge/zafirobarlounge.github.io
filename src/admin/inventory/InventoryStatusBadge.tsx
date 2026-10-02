import type { InventorySubmissionKind, InventorySubmissionStatus } from './inventory.domain';

export const inventoryStatusLabels: Record<InventorySubmissionStatus, string> = {
  draft: 'Borrador',
  sent: 'Enviada',
  partially_approved: 'Aprobación parcial',
  approved: 'Aprobada',
  partially_received: 'Recibida parcialmente',
  received: 'Recibida',
  rejected: 'Rechazada',
};

const inventoryStatusStyles: Record<InventorySubmissionStatus, string> = {
  draft: 'border-white/12 bg-white/[0.05] text-mist',
  sent: 'border-cyanGlow/30 bg-cyanGlow/10 text-cyanGlow',
  partially_approved: 'border-amberGlow/30 bg-amberGlow/10 text-amber-100',
  approved: 'border-emerald-300/25 bg-emerald-300/[0.08] text-emerald-200',
  partially_received: 'border-orange-300/30 bg-orange-300/10 text-orange-200',
  received: 'border-emerald-300/35 bg-emerald-300/12 text-emerald-100',
  rejected: 'border-rose-300/30 bg-rose-300/10 text-rose-100',
};

export function InventoryStatusBadge({ status }: { status: InventorySubmissionStatus }) {
  return (
    <span className={`inline-flex h-fit shrink-0 items-center gap-2 rounded-full border px-2.5 py-1 text-[0.62rem] font-semibold uppercase leading-none tracking-[0.12em] ${inventoryStatusStyles[status]}`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-current shadow-[0_0_0_3px_currentColor]/10" />
      {inventoryStatusLabels[status]}
    </span>
  );
}

const inventoryStageStyles = {
  draft: { label: 'Borrador', className: 'border-white/10 bg-white/[0.035] text-mist', rail: 'bg-white/30' },
  review: { label: 'Por revisar', className: 'border-amberGlow/20 bg-amberGlow/[0.08] text-amber-100', rail: 'bg-amberGlow' },
  purchase: { label: 'Por comprar o recibir', className: 'border-cyanGlow/20 bg-cyanGlow/[0.07] text-cyanGlow', rail: 'bg-cyanGlow' },
  complete: { label: 'Compra completada', className: 'border-emerald-300/20 bg-emerald-300/[0.07] text-emerald-200', rail: 'bg-emerald-300' },
  applied: { label: 'Revisado y aplicado', className: 'border-emerald-300/20 bg-emerald-300/[0.07] text-emerald-200', rail: 'bg-emerald-300' },
  rejected: { label: 'Rechazada', className: 'border-rose-300/20 bg-rose-300/[0.07] text-rose-100', rail: 'bg-rose-300' },
} as const;

export function inventorySubmissionStage(kind: InventorySubmissionKind, status: InventorySubmissionStatus) {
  if (status === 'draft') return inventoryStageStyles.draft;
  if (status === 'sent' || status === 'partially_approved') return inventoryStageStyles.review;
  if (status === 'rejected') return inventoryStageStyles.rejected;
  if (kind === 'replenishment') return status === 'received' ? inventoryStageStyles.complete : inventoryStageStyles.purchase;
  return inventoryStageStyles.applied;
}

export function InventorySubmissionStage({ kind, status }: { kind: InventorySubmissionKind; status: InventorySubmissionStatus }) {
  const stage = inventorySubmissionStage(kind, status);
  return (
    <div className={`-mx-5 -mt-5 mb-4 flex items-center gap-2 border-b px-5 py-2.5 text-[0.68rem] font-bold uppercase tracking-[0.16em] ${stage.className}`}>
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${stage.rail}`} />
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-current" />
      {stage.label}
    </div>
  );
}
