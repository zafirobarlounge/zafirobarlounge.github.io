import type { InventorySubmissionStatus } from './inventory.domain';

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
