import { ClipboardList, LoaderCircle, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { getSupabaseClient } from '../integrations/supabase/client';
import { printPreparationTicket, type PreparationTicketSnapshot } from './posPrint';

type Job = {
  id: string;
  status: string;
  ticket_snapshot: PreparationTicketSnapshot;
  created_at: string;
  error_message: string | null;
  reviewed_at: string | null;
  reviewed_by_email: string | null;
};

export function isPendingPrintIncident(job: Pick<Job, 'status' | 'reviewed_at'>) {
  return !job.reviewed_at && (job.status === 'review' || job.status === 'failed');
}

export function PrintJobsPanel({ active, actor }: { active: boolean; actor: string }) {
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [confirm, setConfirm] = useState<Job | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const table = getSupabaseClient().from('pos_preparation_print_jobs' as never) as any;
    const { data, error: loadError } = await table
      .select('*')
      .in('status', ['review', 'failed'])
      .is('reviewed_at', null)
      .order('created_at', { ascending: false });
    if (loadError) {
      setError(`No fue posible consultar los trabajos: ${loadError.message}`);
      return;
    }
    setJobs((data ?? []) as Job[]);
  };

  useEffect(() => {
    void load();
    const client = getSupabaseClient() as any;
    const channel = client
      .channel(`zafiro-print-review-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pos_preparation_print_jobs' }, () => void load())
      .subscribe();
    return () => { void client.removeChannel(channel); };
  }, []);

  const pendingCount = useMemo(() => jobs.filter(isPendingPrintIncident).length, [jobs]);

  useEffect(() => {
    if (!pendingCount) setOpen(false);
  }, [pendingCount]);

  useEffect(() => {
    if (!open) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [open]);

  const review = async (job: Job) => {
    setError(null);
    setBusyJobId(job.id);
    try {
      const { error: reviewError } = await (getSupabaseClient() as any).rpc('review_pos_preparation_print_job', {
        job_id: job.id,
        reviewer_email: actor,
      });
      if (reviewError) throw reviewError;
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No fue posible marcar el trabajo como revisado.');
    } finally {
      setBusyJobId(null);
    }
  };

  const retry = async (job: Job) => {
    if (!active || busyJobId) return;
    setError(null);
    setBusyJobId(job.id);
    const requestId = crypto.randomUUID();
    try {
      await printPreparationTicket({
        ...job.ticket_snapshot,
        orderNumber: `${job.ticket_snapshot.orderNumber} · REIMPRESIÓN`,
      });
      const client = getSupabaseClient() as any;
      const { error: recordError } = await client.rpc('record_pos_preparation_reprint', {
        job_id: job.id,
        request_id: requestId,
        actor_email: actor,
        station_id: null,
        result: 'browser_cycle_finished',
        failure: null,
      });
      if (recordError) throw recordError;

      const jobsTable = client.from('pos_preparation_print_jobs' as never) as any;
      const { data: completedJob, error: completeError } = await jobsTable
        .update({ status: 'printed', printed_at: new Date().toISOString(), error_message: null })
        .eq('id', job.id)
        .in('status', ['review', 'failed'])
        .select('id')
        .maybeSingle();
      if (completeError) throw completeError;
      if (!completedJob) throw new Error('El trabajo ya no estaba disponible para resolver.');
      await load();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'No fue posible enviar la reimpresión.';
      setError(message);
      await (getSupabaseClient() as any).rpc('record_pos_preparation_reprint', {
        job_id: job.id,
        request_id: requestId,
        actor_email: actor,
        station_id: null,
        result: 'error',
        failure: message,
      });
      await load();
    } finally {
      setBusyJobId(null);
      setConfirm(null);
    }
  };

  if (!pendingCount) return null;

  const panel = open ? (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/75 p-3 sm:p-5" role="dialog" aria-modal="true" aria-label="Trabajos de impresión">
      <div className="flex max-h-[85vh] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0d0d13] text-ivory shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/10 bg-black/20 px-4 py-4 sm:px-5">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-cyanGlow">Seguimiento de impresión</p>
            <h2 className="mt-1 font-display text-xl">Trabajos de impresión <span className="text-cyanGlow">({pendingCount})</span></h2>
          </div>
          <button type="button" onClick={() => setOpen(false)} className="rounded-full border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-ivory transition hover:border-cyanGlow/35 hover:bg-white/[0.08]">Cerrar</button>
        </div>
        <div className="min-h-0 overflow-y-auto p-3 sm:p-4">
          {error ? <p role="alert" className="mb-3 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">{error}</p> : null}
          <div className="space-y-3">
            {jobs.map((job) => {
              const area = job.ticket_snapshot.area === 'kitchen' ? 'COCINA' : 'BARRA';
              return (
                <article key={job.id} className="rounded-xl border border-white/10 bg-white/[0.025] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyanGlow">{area}</p>
                      <h3 className="mt-1 font-display text-lg text-ivory">Pedido #{job.ticket_snapshot.orderNumber}</h3>
                    </div>
                    <span className="rounded-full border border-amber-300/35 bg-amber-300/10 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-amber-100">{job.status}</span>
                  </div>
                  <div className="mt-3 grid gap-x-5 gap-y-1 text-sm text-mist sm:grid-cols-2">
                    <p><span className="text-white/45">Mesa</span> <span className="ml-1 text-ivory">{job.ticket_snapshot.table}</span></p>
                    <p><span className="text-white/45">Mesero</span> <span className="ml-1 text-ivory">{job.ticket_snapshot.server}</span></p>
                    <p className="sm:col-span-2"><span className="text-white/45">Fecha</span> <span className="ml-1 text-ivory">{new Date(job.created_at).toLocaleString('es-CO')}</span></p>
                  </div>
                  <div className="mt-4 border-t border-white/8 pt-3">
                    <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-white/45">Productos</p>
                    <div className="mt-2 space-y-2 text-sm">
                      {job.ticket_snapshot.items.map((item) => (
                        <div key={item.id}>
                          <p className="text-ivory"><span className="mr-2 font-semibold text-cyanGlow">{item.quantity}×</span>{item.name}</p>
                          {item.notes ? <p className="mt-0.5 pl-6 text-xs text-mist">Observación: {item.notes}</p> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="mt-4 rounded-lg border border-amber-300/20 bg-amber-300/[0.06] px-3 py-2.5 text-sm">
                    <p className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-amber-200">Inconveniente</p>
                    <p className="mt-1 text-amber-50">{job.error_message ?? 'Sin detalle técnico disponible.'}</p>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {!job.reviewed_at ? <button type="button" disabled={busyJobId === job.id} onClick={() => void review(job)} className="rounded-full border border-white/15 bg-white/[0.04] px-3 py-2 text-xs font-semibold text-ivory transition hover:border-cyanGlow/35 hover:bg-white/[0.08] disabled:opacity-50">{busyJobId === job.id ? 'Guardando…' : 'Marcar como revisado'}</button> : <span className="text-xs text-cyanGlow">Revisado por {job.reviewed_by_email ?? 'usuario'}.</span>}
                    <button type="button" disabled={busyJobId === job.id} onClick={() => setConfirm(job)} className="inline-flex items-center gap-1 rounded-full border border-amber-300/40 bg-amber-300/[0.06] px-3 py-2 text-xs font-semibold text-amber-100 transition hover:bg-amber-300/[0.12] disabled:opacity-50"><RotateCw size={14} /> Reintentar impresión</button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const confirmation = confirm ? (
    <div className="fixed inset-0 z-[1010] flex items-center justify-center bg-black/75 p-3" role="dialog" aria-modal="true" aria-label="Confirmar reimpresión">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0d0d13] p-5 text-ivory shadow-2xl">
        <p className="text-xs uppercase tracking-[0.2em] text-amber-200">Posible duplicación física</p>
        <h2 className="mt-2 font-display text-xl">¿Reimprimir la comanda?</h2>
        <p className="mt-3 text-sm text-mist">Se usará el snapshot original marcado como REIMPRESIÓN. El navegador no confirma que el papel haya salido físicamente.</p>
        {!active ? <p className="mt-3 rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">Habilita la estación en verde antes de reimprimir.</p> : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={() => setConfirm(null)} className="rounded-full border border-white/15 px-3 py-2 text-xs">Cancelar</button>
          <button type="button" disabled={!active || busyJobId === confirm.id} onClick={() => void retry(confirm)} className="inline-flex items-center gap-1 rounded-full bg-cyanGlow px-3 py-2 text-xs font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50">{busyJobId === confirm.id ? <LoaderCircle size={14} className="animate-spin" /> : null} Confirmar reimpresión</button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-ivory"><ClipboardList size={16} /> Trabajos ({pendingCount})</button>
      {createPortal(<>{panel}{confirmation}</>, document.body)}
    </>
  );
}
