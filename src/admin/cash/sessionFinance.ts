import { expectedCash, movementTotals, type CashData } from "./cash.domain";
import type {
  PosSalesSessionHistoryEntry,
  StaffRole,
} from "../../shared/operations/operations.types";

export function reportAccess(admin: boolean, roles: StaffRole[]) {
  return {
    read: admin || roles.includes("superadmin") || roles.includes("cashier"),
    manage: admin || roles.includes("superadmin"),
  };
}
export const sessionDetailUrl = (id: string) =>
  `/admin/sales-sessions?session=${encodeURIComponent(id)}`;
export function includeLinkedSession<T extends { id: string }>(
  filtered: T[],
  all: T[],
  id: string | null,
) {
  const linked = all.find((s) => s.id === id);
  return linked && !filtered.some((s) => s.id === id)
    ? [linked, ...filtered]
    : filtered;
}
export function sessionFinance(id: string, data: CashData) {
  const session = data.sessions.find((s) => s.id === id);
  const register = data.registers.find((r) => r.sales_session_id === id);
  const movements = data.movements.filter((m) => m.sales_session_id === id);
  const closed = Boolean(register?.closed_at);
  // A closed reconciliation is authoritative, even if current aggregates differ.
  const components = closed ? register?.components : session?.components;
  const expense = (origin: string) =>
    movementTotals(movements.filter((m) => m.origin === origin)).expenses;
  return {
    register,
    movements,
    closed,
    components,
    expected: closed
      ? (register?.expected ?? null)
      : components
        ? expectedCash(components)
        : null,
    opening: closed
      ? (components?.opening ?? null)
      : (register?.opening_amount ?? null),
    status: closed
      ? "Arqueada"
      : session?.status === "open"
        ? "Pendiente de cierre"
        : "Sin registrar",
    expenses: {
      register: expense("register"),
      business: expense("business"),
      owner: expense("owner"),
    },
  };
}
export function paymentBreakdown(session: PosSalesSessionHistoryEntry) {
  const totals = { cash: 0, nequi: 0, bank_transfer: 0, card: 0, other: 0 };
  for (const entry of session.summary?.paymentMethods ?? [])
    totals[entry.method] += entry.totalAmount;
  return totals;
}
export function financeCsv(id: string, data: CashData) {
  const f = sessionFinance(id, data),
    c = f.components,
    r = f.register;
  return {
    base_inicial: f.opening,
    aportes: c?.contributions ?? null,
    retiros: c?.withdrawals ?? null,
    gastos_desde_caja: f.closed ? (c?.expenses ?? null) : f.expenses.register,
    gastos_fondos_negocio: f.expenses.business,
    gastos_propietario: f.expenses.owner,
    efectivo_esperado: f.expected,
    efectivo_contado: r?.counted ?? null,
    diferencia: r?.difference ?? null,
    estado_arqueo: f.status,
    explicacion_diferencia: r?.difference_reason ?? "",
    observaciones_cierre: r?.closing_notes ?? "",
    responsable_cierre_caja: r?.closed_by ?? "",
    fecha_cierre_caja: r?.closed_at ?? "",
  };
}
