import { Printer } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { beginPreparationPrintJob, claimPreparationPrintJob, finishPreparationPrintJob, printPreparationTicket, releasePreparationPrintJob, subscribeToPreparationPrintJobs } from './posPrint';

type UsbApi = { getDevices(): Promise<unknown[]>; requestDevice(options: { filters: unknown[] }): Promise<unknown>; addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void };

export function PrinterLinkControl({ menuItem = false, enabled = true }: { menuItem?: boolean; enabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!enabled) return null;
  const usb = (navigator as Navigator & { usb?: UsbApi }).usb;
  if (!usb) return null;
  const link = async () => {
    setError(null);
    try {
      await usb.requestDevice({ filters: [] });
      setOpen(false);
      window.dispatchEvent(new Event('zafiro-printer-linked'));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'NotFoundError') { setOpen(false); return; }
      setError(cause instanceof Error ? cause.message : 'No fue posible vincular la impresora.');
    }
  };
  return <>
    <button type="button" onClick={() => { setError(null); setOpen(true); }} className={menuItem ? 'block w-full rounded-[0.95rem] px-3 py-2 text-left text-sm text-ivory transition hover:bg-white/[0.04]' : 'interactive-button rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-ivory transition hover:border-cyanGlow/35 hover:bg-white/[0.08] sm:px-4 sm:py-2 sm:text-xs sm:tracking-[0.24em]'}>Vincular impresora</button>
    {open ? <div className="zafiro-modal-backdrop fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3" role="dialog" aria-modal="true"><div className="w-full max-w-md rounded-[1.4rem] border border-white/12 bg-[#0d0d13] p-5 shadow-2xl"><p className="text-xs uppercase tracking-[0.2em] text-cyanGlow">Impresora térmica</p><h2 className="mt-2 font-display text-2xl text-ivory">¿Vincular impresora USB?</h2><p className="mt-3 text-sm text-mist">Chrome mostrará sus dispositivos USB. Selecciona USB Printer Port. Esta autorización solo permite detectar la impresora; la impresión continúa mediante Chrome.</p>{error ? <p className="mt-3 text-sm text-rose-200">{error}</p> : null}<div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setOpen(false)} className="rounded-full border border-white/14 bg-white/[0.06] px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-ivory">Cancelar</button><button type="button" onClick={() => void link()} className="rounded-full border border-cyanGlow/28 bg-cyanGlow/12 px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-cyanGlow">Continuar</button></div></div></div> : null}
  </>;
}

export function ThermalPrinterTestPanel({ onStationChange, activeSessionId }: { onStationChange: (active: boolean) => void; activeSessionId: string | null }) {
  const [detected, setDetected] = useState(false);
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const stationId = useRef(crypto.randomUUID());
  const running = useRef(false);
  const claimedJobId = useRef<string | null>(null);
  const printStarted = useRef(false);

  useEffect(() => {
    const usb = (navigator as Navigator & { usb?: UsbApi }).usb;
    if (!usb) return;
    const refresh = async () => setDetected((await usb.getDevices()).length > 0);
    void refresh().catch(() => setDetected(false));
    const disconnected = () => { setDetected(false); setActive(false); activeRef.current = false; onStationChange(false); };
    usb.addEventListener('connect', () => void refresh());
    usb.addEventListener('disconnect', disconnected);
    const linked = () => void refresh();
    window.addEventListener('zafiro-printer-linked', linked);
    return () => { usb.removeEventListener('disconnect', disconnected); window.removeEventListener('zafiro-printer-linked', linked); };
  }, [onStationChange]);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    const process = async () => {
      if (disposed || !activeRef.current || running.current) return;
      running.current = true;
      try {
        if (!activeSessionId) return;
        const job = await claimPreparationPrintJob(stationId.current, activeSessionId);
        if (job && activeRef.current && !disposed) {
          claimedJobId.current = job.id;
          if (!activeRef.current || disposed) { await releasePreparationPrintJob(job.id, stationId.current); return; }
          try { await beginPreparationPrintJob(job.id, stationId.current); printStarted.current = true; await printPreparationTicket(job.ticket_snapshot); await finishPreparationPrintJob(job.id, stationId.current, true); }
          catch (error) { if (printStarted.current) await finishPreparationPrintJob(job.id, stationId.current, false, error instanceof Error ? error.message : 'Resultado de impresión incierto'); else await releasePreparationPrintJob(job.id, stationId.current); }
          finally { claimedJobId.current = null; printStarted.current = false; }
        }
      } finally { running.current = false; }
    };
    void process();
    const unsubscribe = subscribeToPreparationPrintJobs(() => void process());
    const timer = window.setInterval(() => void process(), 2500);
    return () => { disposed = true; window.clearInterval(timer); unsubscribe(); };
  }, [active, activeSessionId]);

  if (!detected) return null;
  return <button type="button" aria-label={active ? 'Deshabilitar estación de impresión' : 'Habilitar estación de impresión'} onClick={() => {
    const next = !active; activeRef.current = next; setActive(next); onStationChange(next);
    if (!next && claimedJobId.current && !printStarted.current) void releasePreparationPrintJob(claimedJobId.current, stationId.current).catch(() => {});
  }} className={`inline-flex h-9 w-9 items-center justify-center rounded-full border transition ${active ? 'border-emerald-300/50 bg-emerald-300/15 text-emerald-200' : 'border-rose-300/50 bg-rose-300/10 text-rose-200'}`}>
    <Printer size={17} aria-hidden="true" />
  </button>;
}
