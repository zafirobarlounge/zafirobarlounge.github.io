import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, Navigate } from "react-router-dom";
import { useSupabaseAuth } from "../../auth/SupabaseAuthProvider";
import { AdminLayout } from "../AdminLayout";
import {
  bogotaToday,
  categories,
  cashInput,
  dateTime,
  expectedCash,
  kinds,
  methods,
  money,
  movementCsv,
  movementTotals,
  origins,
  type CashData,
  type Movement,
} from "./cash.domain";
import { loadCash, saveCash } from "./cash.repository";
import { salesDayOptions } from "../../shared/operations/salesBusinessDate";
import { sessionDetailUrl } from './sessionFinance';

const input =
  "w-full rounded-xl border border-white/20 bg-obsidian p-3 text-ivory";
const button =
  "rounded-full border border-cyanGlow/40 px-4 py-2 text-cyanGlow disabled:opacity-40";
const panel =
  "space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-6";
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-sm text-mist">{label}</span>
      {children}
    </label>
  );
}
function Options({ items }: { items: Record<string, string> }) {
  return (
    <>
      {Object.entries(items).map(([key, label]) => (
        <option key={key} value={key}>
          {label}
        </option>
      ))}
    </>
  );
}
function Amount({
  name,
  onChange,
}: {
  name?: string;
  onChange?: (s: string) => void;
}) {
  return (
    <div className="relative">
    <span aria-hidden="true" className="pointer-events-none absolute left-4 top-3 text-mist">$</span>
    <input
      className={`${input} pl-9 pr-16 text-lg tabular-nums`}
      name={name ?? "amount"}
      type="text"
      inputMode="decimal"
      placeholder="0"
      autoComplete="off"
      required
      onChange={(e) => {
        const field = e.target;
        const result = cashInput(field.value);
        field.setCustomValidity?.(result ? '' : 'Ingresa un importe válido, con máximo dos decimales separados por coma.');
        if (!result) { onChange?.(''); return; }
        const position = field.selectionStart;
        const logical = position == null ? null : field.value.slice(0, position).replace(/\./g, '').length;
        field.value = result.display;
        if (logical !== null) {
          let cursor = 0, seen = 0;
          while (cursor < result.display.length && seen < logical) { if (result.display[cursor] !== '.') seen++; cursor++; }
          field.setSelectionRange?.(cursor, cursor);
        }
        onChange?.(result.value);
      }}
    />
    <span aria-hidden="true" className="pointer-events-none absolute right-4 top-3 text-sm leading-7 text-mist">COP</span>
    </div>
  );
}

export function AdminCashView({ embedded = false, initialAction = null, onClose }: { embedded?: boolean; initialAction?: 'session' | 'movement' | null; onClose?: () => void } = {}) {
  const { isCatalogAdmin, staffRoles, user } = useSupabaseAuth();
  const admin = isCatalogAdmin || staffRoles.includes("superadmin");
  const allowed = admin || staffRoles.includes("cashier");
  const [data, setData] = useState<CashData | null>(null);
  const [sessionId, setSessionId] = useState("");
  const [month, setMonth] = useState(() => bogotaToday().slice(0, 7));
  const [modal, setModal] = useState<'session' | 'movement' | null>(initialAction);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [kind, setKind] = useState<Movement["kind"]>("expense");
  const [origin, setOrigin] = useState<Movement["origin"]>("register");
  const [counted, setCounted] = useState("");
  const dayOptions = salesDayOptions();
  const [voiding, setVoiding] = useState<Movement | null>(null);
  const [filters, setFilters] = useState({
    start: "",
    end: "",
    category: "",
    method: "",
    origin: "",
    session: "all",
  });
  const inFlight = useRef(false);
  const pendingKey = `zafiro-cash-pending:${user?.id ?? ""}`;
  type Pending = { id: string; payload: Record<string, unknown> };
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(pendingKey) ?? "null");
    } catch {
      return null;
    }
  });
  const loadVersion = useRef(0);
  async function refresh() {
    const version = ++loadVersion.current;
    const next = await loadCash();
    if (version !== loadVersion.current) return;
    setData(next);
    setSessionId(
      (current) =>
        current ||
        next.sessions.find((s) => (embedded || s.business_date.startsWith(month)) && s.status === "open")?.id ||
        (embedded ? '' : next.sessions.find(s => s.business_date.startsWith(month))?.id) ||
        "",
    );
  }
  useEffect(() => {
    if (allowed) void refresh().catch((e) => setError(e.message));
  }, [allowed]);
  useEffect(() => {
    if (!modal || typeof document === 'undefined') return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; previous?.focus(); };
  }, [modal]);
  if (!allowed) return <Navigate to="/admin/pos" replace />;
  const selected = data?.sessions.find((s) => s.id === sessionId);
  const active = data?.sessions.find((s) => s.status === "open");
  const monthSessions = (data?.sessions ?? []).filter(s => s.business_date.startsWith(month));
  function closeModal() { if (busy) return; setModal(null); onClose?.(); }
  function openModal(action: 'session' | 'movement') {
    if (active) setMonth(active.business_date.slice(0, 7));
    setSessionId(active?.id ?? ''); setCounted(''); setError(''); setModal(action);
  }
  const register = data?.registers.find(
    (c) => c.sales_session_id === sessionId,
  );
  const isActive = selected?.status === "open";
  const components = register?.components ?? selected?.components;
  const expected = components ? expectedCash(components) : null;
  const difference =
    counted !== "" && expected !== null
      ? Math.round((Number(counted) - expected) * 100) / 100
      : null;
  const movements = (data?.movements ?? []).filter(
    (m) =>
      m.expense_date.startsWith(month) &&
      (filters.session === "all" ||
        (filters.session === "none"
          ? !m.sales_session_id
          : m.sales_session_id === sessionId)) &&
      (!filters.start || m.expense_date >= filters.start) &&
      (!filters.end || m.expense_date <= filters.end) &&
      (!filters.category || m.category === filters.category) &&
      (!filters.method || m.method === filters.method) &&
      (!filters.origin || m.origin === filters.origin),
  );
  const totals = movementTotals(movements);
  async function run(payload: Record<string, unknown>, form?: HTMLFormElement) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    let request: Pending | null = null;
    try {
      request = JSON.parse(
        localStorage.getItem(pendingKey) ?? "null",
      ) as Pending | null;
      if (
        request &&
        JSON.stringify(request.payload) !== JSON.stringify(payload)
      ) {
        setPending(request);
        throw new Error(
          "Hay una operación pendiente de confirmar. Reinténtala antes de registrar otra.",
        );
      }
      request ??= { id: crypto.randomUUID(), payload };
      localStorage.setItem(pendingKey, JSON.stringify(request));
      setPending(request);
      const result = await saveCash(request.id, request.payload);
      localStorage.removeItem(pendingKey);
      setPending(null);
      form?.reset();
      setCounted("");
      setVoiding(null);
      if (payload.action === "open")
        setSessionId(String(result.sales_session_id));
      setNotice("Operación guardada.");
      setModal(null);
      if (payload.action === 'open') setMonth(salesDayOptions().suggested.slice(0, 7));
      try {
        await refresh();
      } catch (e) {
        setError(
          `Se guardó, pero no se pudo actualizar la vista: ${(e as Error).message}`,
        );
      }
      onClose?.();
    } catch (e) {
      if ((e as { confirmedRejection?: boolean }).confirmedRejection) {
        localStorage.removeItem(pendingKey);
        setPending(null);
      }
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function submit(e: FormEvent<HTMLFormElement>, action: string) {
    e.preventDefault();
    const form = e.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (action !== 'void') {
      const amount = cashInput(String(values.amount ?? ''));
      if (!amount?.value) { setError('Ingresa un importe válido. Usa coma para los decimales.'); return; }
      values.amount = amount.value;
    }
    if (
      action === "close" &&
      !window.confirm(
        "¿Guardar el arqueo y cerrar la jornada? Sus cifras quedarán protegidas.",
      )
    )
      return;
    const payload: Record<string, unknown> = {
      ...values,
      action,
      session: sessionId || null,
    };
    if (action === "open" && !active) { payload.session = null; payload.business_date = salesDayOptions().suggested; }
    if (action === "close") payload.expected = expected;
    if (action === "movement") {
      payload.kind = kind;
      payload.origin = kind === "expense" ? origin : "register";
      if (payload.origin === "register") payload.method = "cash";
      if (kind !== "expense") {
        payload.category = null;
        payload.date = selected?.business_date ?? bogotaToday();
      }
      if (values.relation === "none") payload.session = null;
      delete payload.relation;
    }
    if (action === "void") {
      payload.movement = voiding?.id;
      delete payload.session;
    }
    void run(payload, form);
  }
  function exportCsv() {
    const url = URL.createObjectURL(
      new Blob([movementCsv(movements)], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "zafiro-caja-gastos.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }
  const operationDialog = modal && (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4">
      <div role="dialog" aria-modal="true" onKeyDown={e => {
        if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
        if (e.key === 'Tab') {
          const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'));
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }} aria-label={modal === 'movement' ? 'Registrar movimiento' : !active ? 'Abrir jornada y caja' : 'Arqueo y cierre de jornada'} className="max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/20 bg-obsidian p-4">
        <div className="mb-5 flex justify-end border-b border-white/10 pb-4">
          <button autoFocus type="button" className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-white/15 px-4 py-2 text-sm text-mist transition hover:border-white/30 hover:bg-white/10 hover:text-ivory focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyanGlow disabled:opacity-40" disabled={busy} onClick={closeModal}>
            Cerrar <span aria-hidden="true" className="text-xl leading-none">×</span>
          </button>
        </div>
        {error && <p role="alert" className="my-3 text-rose-200">{error}</p>}
        {pending && <button type="button" disabled={busy} className={button} onClick={() => void run(pending.payload)}>Reintentar operación pendiente</button>}
        {!data ? <p>Cargando caja...</p> : <>
            <div className="space-y-4">
              {(modal === "session" && (!active || (isActive && !register))) && (
                <form className={panel} onSubmit={(e) => submit(e, "open")}>
                  <h2 className="text-xl">
                    {active
                      ? "Completar base de la jornada activa"
                      : "Abrir jornada y caja"}
                  </h2>
                  <p className="text-sm text-mist">
                    La base puede ser cero. El responsable y la hora se
                    registran con tu sesión.
                  </p>
                  {active ? (
                    <p className="text-sm text-mist">
                      Fecha de la jornada: {active.business_date}. Ingresa el
                      efectivo que había al inicio de la jornada, sin incluir
                      las ventas cobradas después
                    </p>
                  ) : (
                    <p className="text-sm text-mist">Fecha de la jornada: {dayOptions.suggested} (automatica, corte a las 06:00 en Bogota).</p>
                  )}
                  <Field label="Base inicial (COP)">
                    <Amount />
                  </Field>
                  <Field label="Observación opcional">
                    <input className={input} name="notes" maxLength={2000} />
                  </Field>
                  <button disabled={busy} className={button}>
                    Registrar apertura
                  </button>
                </form>
              )}
              {modal === "movement" && <form className={panel} onSubmit={(e) => submit(e, "movement")}>
                <h2 className="text-xl">Registrar movimiento</h2>
                <Field label="Tipo">
                  <select
                    className={input}
                    value={kind}
                    onChange={(e) =>
                      setKind(e.target.value as Movement["kind"])
                    }
                  >
                    <Options items={kinds} />
                  </select>
                </Field>
                <p className="text-sm text-mist">
                  Un gasto desde caja ya descuenta efectivo: no registres otro
                  retiro por ese pago. Aportes y retiros no son ventas ni
                  gastos.
                </p>
                <Field label="Concepto / motivo">
                  <input
                    className={input}
                    required
                    name="concept"
                    maxLength={500}
                  />
                </Field>
                <Field label="Valor (COP)">
                  <Amount />
                </Field>
                {kind === "expense" && (
                  <>
                    <Field label="Categoría">
                      <select className={input} name="category">
                        <Options items={categories} />
                      </select>
                    </Field>
                    <Field label="Fecha del gasto">
                      <input
                        className={input}
                        type="date"
                        required
                        name="date"
                        defaultValue={bogotaToday()}
                      />
                    </Field>
                    <Field label="Origen del dinero">
                      <select
                        className={input}
                        value={origin}
                        onChange={(e) =>
                          setOrigin(e.target.value as Movement["origin"])
                        }
                      >
                        <Options items={origins} />
                      </select>
                    </Field>
                    {origin !== "register" && (
                      <>
                        <Field label="Método de pago">
                          <select className={input} name="method">
                            <Options items={methods} />
                          </select>
                        </Field>
                        <Field label="Jornada relacionada">
                          <select className={input} name="relation">
                            <option value="none">
                              Sin jornada (gasto fuera de caja)
                            </option>
                            {isActive && register && (
                              <option value="selected">
                                Jornada seleccionada
                              </option>
                            )}
                          </select>
                        </Field>
                      </>
                    )}
                  </>
                )}
                {(kind !== "expense" || origin === "register") && (
                  <p className="text-sm text-mist">
                    Efectivo · Caja del local · Jornada seleccionada abierta.{" "}
                    {(!isActive || !register) &&
                      "Selecciona la jornada activa y registra su base primero."}
                  </p>
                )}
                <Field label="Observación opcional">
                  <input className={input} name="notes" maxLength={2000} />
                </Field>
                <button
                  className={button}
                  disabled={
                    busy ||
                    ((kind !== "expense" || origin === "register") &&
                      (!isActive || !register))
                  }
                >
                  Guardar movimiento
                </button>
              </form>}
              {modal === "session" && isActive && register && (
                <form className={panel} onSubmit={(e) => submit(e, "close")}>
                  <h2 className="text-xl">Arqueo y cierre de jornada</h2>
                  <p>
                    Esperado:{" "}
                    {expected === null ? "Sin registrar" : money(expected)}
                  </p>
                  <Field label="Efectivo contado (COP)">
                    <Amount onChange={setCounted} />
                  </Field>
                  {difference !== null && (
                    <p aria-live="polite">
                      {difference < 0
                        ? "Faltante"
                        : difference > 0
                          ? "Sobrante"
                          : "Sin diferencia"}
                      : {money(Math.abs(difference))}
                    </p>
                  )}
                  <Field label="Explicación de diferencia (obligatoria si existe)">
                    <input
                      className={input}
                      name="reason"
                      required={difference !== null && difference !== 0}
                      maxLength={2000}
                    />
                  </Field>
                  <Field label="Observación del cierre">
                    <textarea className={input} name="notes" maxLength={2000} />
                  </Field>
                  <p className="text-sm text-mist">
                    No se puede cerrar con cuentas abiertas, saldos pendientes o
                    pagos por confirmar.
                  </p>
                  <button className={button} disabled={busy}>
                    Guardar arqueo y cerrar
                  </button>
                </form>
              )}
            </div>

        </>}
      </div>
    </div>
  );
  if (embedded) return operationDialog;
  return (
    <AdminLayout>
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-3xl">Caja y gastos</h1>
            <p className="mt-2 text-mist">
              Pesos colombianos · Fechas de Bogotá · Base, recaudo y movimientos
              separados de ventas.
            </p>
          </div>
          <Link className={button} to="/admin/pos">
            Volver al POS
          </Link>
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-xl bg-rose-500/10 p-4 text-rose-200"
          >
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="text-cyanGlow">
            {notice}
          </p>
        )}
        {pending && (
          <div className={panel}>
            <p>
              Operación pendiente de confirmar:{" "}
              {String(pending.payload.concept ?? pending.payload.action)}. El
              reintento utiliza la misma solicitud para evitar duplicados.
            </p>
            <button
              className={button}
              disabled={busy}
              onClick={() => void run(pending.payload)}
            >
              Reintentar operación pendiente
            </button>
          </div>
        )}
        <button
          className={button}
          disabled={busy}
          onClick={() => {
            setError("");
            void refresh().catch((e) => setError(e.message));
          }}
        >
          Recargar caja y gastos
        </button>
        {!data ? (
          <p>Cargando módulo de caja…</p>
        ) : (
          <>
            <div className="flex flex-col items-start gap-3">
              <button className={button} disabled={busy} onClick={() => openModal('session')}>{active ? 'Arqueo y cierre de jornada' : 'Abrir jornada y caja'}</button>
              <button className={button} disabled={busy} onClick={() => openModal('movement')}>Registrar movimiento</button>
              {admin && selected && <Link to={sessionDetailUrl(selected.id)} className={button}>Ver detalle de la jornada</Link>}
            </div>
            <Field label="Mes de consulta">
              <input type="month" className={input} value={month} disabled={busy} onChange={e => {
                if (!e.target.value) return;
                setMonth(e.target.value); setSessionId(''); setCounted('');
                setFilters(f => ({ ...f, session: 'all', start: '', end: '' }));
              }} />
            </Field>
            {!monthSessions.length && <p className="text-mist">No hay jornadas en este mes. Puedes consultar los gastos sin jornada.</p>}
            <Field label="Jornada">
              <select
                className={input}
                value={sessionId}
                onChange={(e) => {
                  setSessionId(e.target.value);
                  setFilters(f => ({ ...f, session: e.target.value ? 'selected' : 'all' }));
                  setCounted("");
                }}
                disabled={busy}
              >
                <option value="">Selecciona una jornada</option>
                {(modal ? data.sessions.filter(s => s.id === sessionId) : monthSessions).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.session_label} ·{" "}
                    {s.status === "open" ? "Abierta" : "Cerrada"}
                  </option>
                ))}
              </select>
            </Field>
            {selected && (
              <section className={panel}>
                <h2 className="text-xl">Arqueo · {selected.business_date}</h2>
                <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
                  {[
                    [
                      "Base inicial",
                      components?.opening == null
                        ? "Sin registrar"
                        : money(components.opening),
                    ],
                    ["Cobros netos en efectivo", money(components?.cash ?? 0)],
                    ["Aportes", money(components?.contributions ?? 0)],
                    ["Gastos desde caja", money(components?.expenses ?? 0)],
                    ["Retiros", money(components?.withdrawals ?? 0)],
                    [
                      "Efectivo esperado",
                      expected === null ? "Sin registrar" : money(expected),
                    ],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <p className="text-sm text-mist">{label}</p>
                      <p className="mt-2 text-lg">{value}</p>
                    </div>
                  ))}
                </div>
                {register ? (
                  <p className="text-sm text-mist">
                    Base registrada por {register.opened_by} ·{" "}
                    {dateTime(register.opened_at)} · {register.opening_notes}
                  </p>
                ) : (
                  <p className="text-mist">
                    Apertura y arqueo sin registrar. No se asignan bases ni
                    conteos históricos automáticamente.
                  </p>
                )}
                {register?.closed_at && (
                  <div className="space-y-2 border-t border-white/10 pt-4">
                    <p>
                      Contado: {money(register.counted!)} · Diferencia:{" "}
                      {money(register.difference!)} (
                      {register.difference! < 0
                        ? "Faltante"
                        : register.difference! > 0
                          ? "Sobrante"
                          : "Sin diferencia"}
                      )
                    </p>
                    <p>
                      {register.difference_reason} {register.closing_notes}
                    </p>
                    <p className="text-sm text-mist">
                      Cerrado por {register.closed_by} ·{" "}
                      {dateTime(register.closed_at)}
                    </p>
                    <p className="text-sm text-mist">
                      El arqueo protege la jornada, sus cuentas, pagos y
                      productos frente a cambios posteriores.
                    </p>
                  </div>
                )}
              </section>
            )}
            {operationDialog}
            <section className={panel}>
              <h2 className="text-xl">Consulta de movimientos y gastos</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Ámbito">
                  <select
                    className={input}
                    value={filters.session}
                    onChange={(e) =>
                      setFilters({ ...filters, session: e.target.value })
                    }
                  >
                    <option value="selected">Jornada seleccionada</option>
                    <option value="all">
                      Todas las jornadas del mes y gastos sin jornada
                    </option>
                    <option value="none">Sin jornada</option>
                  </select>
                </Field>
                <Field label="Desde (fecha del gasto)">
                  <input
                    type="date"
                    className={input}
                    value={filters.start}
                    onChange={(e) =>
                      setFilters({ ...filters, start: e.target.value })
                    }
                  />
                </Field>
                <Field label="Hasta">
                  <input
                    type="date"
                    className={input}
                    value={filters.end}
                    onChange={(e) =>
                      setFilters({ ...filters, end: e.target.value })
                    }
                  />
                </Field>
                {(["category", "method", "origin"] as const).map((key) => (
                  <Field
                    key={key}
                    label={
                      {
                        category: "Categoría",
                        method: "Método",
                        origin: "Origen",
                      }[key]
                    }
                  >
                    <select
                      className={input}
                      value={filters[key]}
                      onChange={(e) =>
                        setFilters({ ...filters, [key]: e.target.value })
                      }
                    >
                      <option value="">Todos</option>
                      <Options
                        items={
                          {
                            category: categories,
                            method: methods,
                            origin: origins,
                          }[key]
                        }
                      />
                    </select>
                  </Field>
                ))}
              </div>
              <p>
                Gastos pagados: {money(totals.expenses)} · Compras de insumos
                (incluidas en gastos): {money(totals.supplies)} · Aportes:{" "}
                {money(totals.contributions)} · Retiros:{" "}
                {money(totals.withdrawals)}
              </p>
              <p className="text-sm text-mist">
                Totales de los filtros, excluyendo anulados. Estos desembolsos
                no representan utilidad neta.
              </p>
              <button className={button} onClick={exportCsv}>
                Exportar detalle CSV
              </button>
              {!movements.length && (
                <p className="text-mist">
                  No hay movimientos para estos filtros.
                </p>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                {movements.map((m) => (
                  <article
                    className="space-y-2 rounded-xl border border-white/10 p-4"
                    key={m.id}
                  >
                    <div className="flex justify-between gap-3">
                      <strong>
                        {kinds[m.kind]} · {m.concept}
                      </strong>
                      <span>{money(m.amount)}</span>
                    </div>
                    <p>
                      {m.category && `${categories[m.category]} · `}
                      {methods[m.method]} · {origins[m.origin]}
                    </p>
                    <p className="text-sm text-mist">
                      Fecha: {m.expense_date} · Registro:{" "}
                      {dateTime(m.created_at)} · {m.created_by}
                    </p>
                    <p className="text-sm">{m.notes}</p>
                    {m.voided_at ? (
                      <p className="text-rose-200">
                        Anulado: {m.void_reason} · {m.voided_by} ·{" "}
                        {dateTime(m.voided_at)}
                      </p>
                    ) : (
                      admin &&
                      (!m.sales_session_id ||
                        data.sessions.some(
                          (s) =>
                            s.id === m.sales_session_id && s.status === "open",
                        )) && (
                        <button
                          className={button}
                          disabled={busy}
                          onClick={() => setVoiding(m)}
                        >
                          Anular con motivo
                        </button>
                      )
                    )}
                  </article>
                ))}
              </div>
            </section>
            {voiding && (
              <form className={panel} onSubmit={(e) => submit(e, "void")}>
                <h2 className="text-xl">
                  Anular: {voiding.concept} · {money(voiding.amount)}
                </h2>
                <p>Se conserva el original y se excluye de los cálculos.</p>
                <Field label="Motivo obligatorio">
                  <input
                    autoFocus
                    className={input}
                    name="reason"
                    required
                    maxLength={2000}
                  />
                </Field>
                <button className={button} disabled={busy}>
                  Confirmar anulación
                </button>{" "}
                <button
                  type="button"
                  className={button}
                  onClick={() => setVoiding(null)}
                  disabled={busy}
                >
                  Volver
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </AdminLayout>
  );
}
