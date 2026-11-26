import {
  categories,
  dateTime,
  kinds,
  methods,
  money,
  origins,
  type CashData,
} from "./cash.domain";
import { sessionFinance } from "./sessionFinance";

export function SessionFinanceDetail({
  id,
  data,
}: {
  id: string;
  data: CashData;
}) {
  const f = sessionFinance(id, data),
    c = f.components,
    r = f.register;
  const amount = (n: number | null | undefined) =>
    n == null ? "Sin registrar" : money(n);
  return (
    <details className="rounded-2xl border border-cyanGlow/20 p-4">
      <summary className="cursor-pointer rounded text-lg font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyanGlow">
        Detalle financiero · {f.status}
      </summary>
      <div className="mt-4 space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Base inicial", f.opening],
            ["Aportes", c?.contributions],
            ["Retiros", c?.withdrawals],
            ["Gastos desde caja", f.closed ? c?.expenses : f.expenses.register],
            ["Efectivo esperado", f.expected],
            ["Gastos con fondos del negocio", f.expenses.business],
            ["Gastos con dinero del propietario", f.expenses.owner],
            ["Efectivo contado", r?.counted],
            ["Diferencia", r?.difference],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <p className="text-sm text-mist">{label}</p>
              <p>{amount(value as number | null | undefined)}</p>
            </div>
          ))}
        </div>
        <p>
          Arqueo:{" "}
          {f.closed ? "Cerrado · cifras guardadas al cierre" : "Sin registrar"}
        </p>
        {f.closed && (
          <div className="space-y-1 text-sm">
            <p>
              {r!.difference! < 0
                ? "Faltante"
                : r!.difference! > 0
                  ? "Sobrante"
                  : "Sin diferencia"}
            </p>
            <p>Explicación: {r?.difference_reason || "Sin observación"}</p>
            <p>Observaciones: {r?.closing_notes || "Sin observación"}</p>
            <p>
              Responsable: {r?.closed_by} ·{" "}
              {r?.closed_at && dateTime(r.closed_at)}
            </p>
            <p className="text-mist">
              Jornada arqueada: sus cifras están protegidas frente a
              modificaciones.
            </p>
          </div>
        )}
        <h4 className="font-semibold">Movimientos asociados a esta jornada</h4>
        {!f.movements.length && (
          <p className="text-mist">Sin movimientos asociados.</p>
        )}
        <div className="grid gap-3 lg:grid-cols-2">
          {f.movements.map((m) => (
            <article
              key={m.id}
              className="space-y-1 rounded-xl border border-white/10 p-3 text-sm"
            >
              <p className="font-semibold">
                {kinds[m.kind]} · {m.concept} · {money(m.amount)}
              </p>
              <p>
                {origins[m.origin]} · {methods[m.method]}
                {m.category ? ` · ${categories[m.category]}` : ""}
              </p>
              <p>
                Responsable: {m.created_by} · {dateTime(m.created_at)}
              </p>
              <p>Fecha del gasto: {m.expense_date}</p>
              <p>{m.notes}</p>
              <p className={m.voided_at ? "text-rose-200" : "text-mist"}>
                {m.voided_at
                  ? `Anulado: ${m.void_reason} · ${m.voided_by} · ${dateTime(m.voided_at)}`
                  : "Vigente"}
              </p>
            </article>
          ))}
        </div>
      </div>
    </details>
  );
}
