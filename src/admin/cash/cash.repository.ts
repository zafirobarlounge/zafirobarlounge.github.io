import { getSupabaseClient } from "../../integrations/supabase/client";
import type { CashData } from "./cash.domain";

export async function loadCash(): Promise<CashData> {
  const { data, error } = await getSupabaseClient().rpc("pos_cash_read");
  if (error)
    throw new Error(
      `No se pudo cargar caja: ${error.message}. Si el módulo aún no está habilitado, solicita la revisión de la migración.`,
    );
  return data as unknown as CashData;
}
export async function saveCash(
  requestId: string,
  payload: Record<string, unknown>,
) {
  const { data, error } = await getSupabaseClient().rpc(
    payload.action === "open" ? "pos_cash_open" : "pos_cash_command",
    {
      request_id: requestId,
      payload,
    },
  );
  if (error)
    throw Object.assign(
      new Error(
        error.code === "PGRST202" && payload.action === "open"
          ? "QA requiere aplicar primero la migración 202609270002_sales_business_date.sql para abrir o completar caja."
          : error.message,
      ),
      {
        confirmedRejection: Boolean(error.code),
      },
    );
  return data;
}
