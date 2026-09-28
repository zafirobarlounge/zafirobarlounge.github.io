export const methods = {
  cash: "Efectivo",
  nequi: "Nequi",
  bank_transfer: "Transferencia",
  card: "Tarjeta",
  other: "Otro",
};
export const origins = {
  register: "Caja del local",
  business: "Fondos del negocio fuera de caja",
  owner: "Dinero de un propietario",
};
export const categories = {
  personal: "Personal",
  supplies: "Compras de insumos",
  rent: "Arriendo",
  utilities: "Servicios",
  transport: "Transporte",
  maintenance: "Mantenimiento",
  other: "Otros",
};
export const kinds = {
  expense: "Gasto pagado",
  contribution: "Aporte a caja",
  withdrawal: "Retiro de caja",
};
export interface Components {
  opening: number | null;
  cash: number;
  contributions: number;
  withdrawals: number;
  expenses: number;
}
export interface CashSession {
  id: string;
  session_label: string;
  business_date: string;
  status: "open" | "closed";
  components: Components;
}
export interface CashRegister {
  sales_session_id: string;
  opening_amount: number;
  opened_at: string;
  opened_by: string;
  opening_notes: string;
  closed_at: string | null;
  closed_by: string | null;
  counted: number | null;
  expected: number | null;
  difference: number | null;
  closing_notes: string | null;
  difference_reason: string | null;
  components: Components | null;
}
export interface Movement {
  id: string;
  sales_session_id: string | null;
  kind: keyof typeof kinds;
  concept: string;
  category: keyof typeof categories | null;
  amount: number;
  expense_date: string;
  method: keyof typeof methods;
  origin: keyof typeof origins;
  notes: string;
  created_at: string;
  created_by: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
}
export interface CashData {
  sessions: CashSession[];
  registers: CashRegister[];
  movements: Movement[];
}
export const money = (amount: number) =>
  new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 2,
  }).format(amount);
export const dateTime = (date: string) =>
  new Date(date).toLocaleString("es-CO", { timeZone: "America/Bogota" });
export const bogotaToday = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
};
export function expectedCash(c: Components): number | null {
  if (c.opening === null) return null;
  return (
    Math.round(
      (Number(c.opening) +
        Number(c.cash) +
        Number(c.contributions) -
        Number(c.withdrawals) -
        Number(c.expenses)) *
        100,
    ) / 100
  );
}
export function movementTotals(movements: Movement[]) {
  const sum = (test: (m: Movement) => boolean) =>
    Math.round(
      movements
        .filter((m) => !m.voided_at && test(m))
        .reduce((n, m) => n + Number(m.amount), 0) * 100,
    ) / 100;
  return {
    expenses: sum((m) => m.kind === "expense"),
    supplies: sum((m) => m.kind === "expense" && m.category === "supplies"),
    contributions: sum((m) => m.kind === "contribution"),
    withdrawals: sum((m) => m.kind === "withdrawal"),
  };
}
export function csvCell(value: unknown) {
  let text = value == null ? "" : String(value);
  if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function movementCsv(movements: Movement[]) {
  const rows: unknown[][] = [
    [
      "ID",
      "Jornada",
      "Tipo",
      "Concepto",
      "Categoría",
      "Valor COP",
      "Fecha gasto",
      "Registro (Bogotá)",
      "Método",
      "Origen",
      "Responsable",
      "Observación",
      "Anulado (Bogotá)",
      "Anulado por",
      "Motivo anulación",
    ],
  ];
  for (const m of movements)
    rows.push([
      m.id,
      m.sales_session_id,
      kinds[m.kind],
      m.concept,
      m.category && categories[m.category],
      m.amount,
      m.expense_date,
      dateTime(m.created_at),
      methods[m.method],
      origins[m.origin],
      m.created_by,
      m.notes,
      m.voided_at && dateTime(m.voided_at),
      m.voided_by,
      m.void_reason,
    ]);
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
}
