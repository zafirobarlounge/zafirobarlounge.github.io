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
  const { data, error } = await getSupabaseClient().rpc("pos_cash_command", {
    request_id: requestId,
    payload,
  });
  if (error)
    throw Object.assign(new Error(error.message), {
      confirmedRejection: Boolean(error.code),
    });
  return data;
}
