// Operational sessions only. Existing sessions always keep their stored businessDate.
export const SALES_DAY_TIME_ZONE = "America/Bogota";
export const SALES_DAY_CUTOFF_HOUR = 6;

export function salesDayOptions(at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SALES_DAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (name: string) => parts.find((p) => p.type === name)!.value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86400000)
    .toISOString()
    .slice(0, 10);
  return {
    today,
    yesterday,
    suggested: Number(part("hour")) < SALES_DAY_CUTOFF_HOUR ? yesterday : today,
  };
}
