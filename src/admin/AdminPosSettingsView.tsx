import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { AdminLayout } from './AdminLayout';
import { useSupabaseAuth } from '../auth/SupabaseAuthProvider';
import type { PosOrderItem, PosOperationalFlowSettings, StaffRole } from '../shared/operations/operations.types';
import {
  defaultPosOperationalFlowSettings,
  loadPosOperationalFlowSettingsFromSupabase,
  subscribeToPosOperationalSettingsRealtime,
  updatePosOperationalFlowSettingsInSupabase,
} from '../integrations/supabase/posOperationsRepository';

export function AdminPosSettingsView() {
  const { isCatalogAdmin, staffRoles, user } = useSupabaseAuth();
  const [operationalFlowSettings, setOperationalFlowSettings] = useState<PosOperationalFlowSettings>(defaultPosOperationalFlowSettings);
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [savingOperationalFlowArea, setSavingOperationalFlowArea] = useState<PosOrderItem['prepArea'] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const realtimeTimerRef = useRef<number | null>(null);

  const actor = useMemo(
    () => ({
      email: user?.email?.trim().toLowerCase() ?? '',
      roles: Array.from(
        new Set<StaffRole>([
          isCatalogAdmin ? 'superadmin' : null,
          ...(staffRoles ?? []),
        ].filter(Boolean) as StaffRole[]),
      ),
    }),
    [isCatalogAdmin, staffRoles, user?.email],
  );

  useEffect(() => {
    if (!isCatalogAdmin) {
      return undefined;
    }

    let isMounted = true;
    let pendingLoad: Promise<void> | null = null;
    let reloadRequested = false;

    const loadState = (): Promise<void> => {
      if (!isMounted) {
        return Promise.resolve();
      }
      if (pendingLoad) {
        reloadRequested = true;
        return pendingLoad;
      }
      pendingLoad = (async () => {
        setErrorMessage(null);
        setIsLoading(true);
        do {
          reloadRequested = false;
          try {
            const nextSettings = await loadPosOperationalFlowSettingsFromSupabase();
            if (!isMounted) {
              return;
            }
            setOperationalFlowSettings(nextSettings);
          } catch (error) {
            if (isMounted) {
              setErrorMessage(error instanceof Error ? error.message : 'No fue posible cargar la configuracion POS.');
            }
          }
        } while (isMounted && reloadRequested);
      })().finally(() => {
        pendingLoad = null;
        if (isMounted) {
          setIsLoading(false);
        }
      });
      return pendingLoad;
    };

    void loadState();

    const unsubscribe = subscribeToPosOperationalSettingsRealtime(() => {
      if (realtimeTimerRef.current != null) {
        window.clearTimeout(realtimeTimerRef.current);
      }

      realtimeTimerRef.current = window.setTimeout(() => {
        realtimeTimerRef.current = null;
        if (!isMounted) {
          return;
        }

        void loadState();
      }, 12);
    });

    return () => {
      isMounted = false;
      if (realtimeTimerRef.current != null) {
        window.clearTimeout(realtimeTimerRef.current);
        realtimeTimerRef.current = null;
      }
      unsubscribe();
    };
  }, [isCatalogAdmin]);

  const handleToggleOperationalFlowSetting = async (
    area: PosOrderItem['prepArea'],
    field: keyof PosOperationalFlowSettings[PosOrderItem['prepArea']],
    value: boolean,
  ) => {
    setBusyAction('saving');
    setSavingOperationalFlowArea(area);
    setErrorMessage(null);
    setActionMessage(null);

    try {
      const nextSettings = await updatePosOperationalFlowSettingsInSupabase(
        {
          area,
          useDirectDelivery: field === 'useDirectDelivery' ? value : operationalFlowSettings[area].useDirectDelivery,
          useInProcess: field === 'useInProcess' ? value : operationalFlowSettings[area].useInProcess,
          usePickingUp: field === 'usePickingUp' ? value : operationalFlowSettings[area].usePickingUp,
        },
        actor,
      );

      setOperationalFlowSettings(nextSettings);
      setActionMessage('La configuracion operativa se actualizo correctamente.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'No fue posible guardar la configuracion operativa.');
    } finally {
      setBusyAction(null);
      setSavingOperationalFlowArea(null);
    }
  };

  if (!isCatalogAdmin) {
    return <Navigate to="/admin" replace />;
  }

  return (
    <AdminLayout>
      <section className="space-y-6">
        <div className="max-w-3xl">
          <p className="text-[0.72rem] uppercase tracking-[0.28em] text-cyanGlow/80">Ajustes POS</p>
          <h1 className="mt-3 font-display text-[1.7rem] leading-[0.95] text-ivory sm:text-[3.4rem]">Flujo operativo</h1>
          <p className="mt-3 max-w-2xl text-[0.98rem] leading-7 text-mist sm:text-lg">
            Esta vista permite cambiar el comportamiento de los pasos intermedios de cocina y bar sin generar ruido en la operacion diaria.
            Se carga una sola vez, se actualiza al guardar y se sincroniza por realtime si otro equipo lo modifica.
          </p>
        </div>

        {errorMessage ? (
          <div className="rounded-[1.2rem] border border-rose-300/20 bg-rose-400/5 p-4 text-sm text-rose-100">
            {errorMessage}
          </div>
        ) : null}

        {actionMessage ? (
          <div className="rounded-[1.2rem] border border-emerald-300/20 bg-emerald-300/10 p-4 text-sm text-emerald-100">
            {actionMessage}
          </div>
        ) : null}

        {isLoading ? (
          <Panel title="Cargando ajustes" subtitle="Espera mientras se lee la configuracion actual del POS.">
            <p className="text-sm leading-7 text-mist">Cargando información de flujo operativo...</p>
          </Panel>
        ) : (
          <OperationalFlowSettingsPanel
            busyAction={busyAction}
            onToggle={handleToggleOperationalFlowSetting}
            savingArea={savingOperationalFlowArea}
            settings={operationalFlowSettings}
          />
        )}
      </section>
    </AdminLayout>
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
    <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.34fr)]">
      <Panel title="Flujo operativo" subtitle="Elige que pasos ve cada area. Cada cambio afecta los botones disponibles y conserva la trazabilidad.">
        <div className="grid gap-3 md:grid-cols-2">
          {areas.map(({ area, label }) => (
            <article key={area} className="rounded-[1.1rem] border border-white/8 bg-white/[0.02] p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-semibold text-ivory">{label}</p>
                  <p className="mt-1 text-xs uppercase tracking-[0.18em] text-cyanGlow/75">
                    {savingArea === area ? 'Guardando' : 'Configurado'}
                  </p>
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
      <Panel title="Alcance" subtitle="Estos ajustes cambian como avanza la operacion, no los productos ni las cuentas ya cobradas.">
        <div className="space-y-3 text-sm leading-6 text-mist">
          <p>Cuando un paso está apagado, los botones saltan al siguiente estado operativo.</p>
          <p>Los productos que ya estén en un estado intermedio se pueden terminar normalmente.</p>
          <p>Solo superadmin puede ver y cambiar esta configuración.</p>
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

function Panel({ children, subtitle, title }: { children: ReactNode; subtitle: string; title: string }) {
  return (
    <section className="rounded-[1.3rem] border border-white/10 bg-white/[0.03] p-4 shadow-[0_18px_40px_rgba(0,0,0,0.2)] sm:rounded-[1.7rem] sm:p-5">
      <p className="text-[0.68rem] uppercase tracking-[0.24em] text-cyanGlow/80">{title}</p>
      <p className="mt-2 text-sm leading-6 text-mist sm:mt-3 sm:leading-7">{subtitle}</p>
      <div className="mt-3 sm:mt-4">{children}</div>
    </section>
  );
}
