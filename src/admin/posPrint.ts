import { getSupabaseClient } from '../integrations/supabase/client';
import zafiroLogo from '../assets/zafiro-logo-white.png';
import type { PosOrderItem, PreparationArea } from '../shared/operations/operations.types';
import type { PosOrderWithRelations } from '../shared/operations/operations.types';

export type PreparationTicketSnapshot = {
  area: PreparationArea;
  createdAt: string;
  items: Array<{ id: string; name: string; notes: string; quantity: number }>;
  orderId: string;
  orderNumber: string;
  server: string;
  table: string;
};

export type PreparationPrintJob = {
  id: string;
  ticket_snapshot: PreparationTicketSnapshot;
};

export async function enqueuePreparationPrintJobs(input: {
  items: PosOrderItem[];
  orderId: string;
  orderNumber: string;
  salesSessionId: string;
  server: string;
  table: string;
}) {
  const createdAt = new Date().toISOString();
  const groups = new Map<PreparationArea, PosOrderItem[]>();
  input.items.forEach((item) => groups.set(item.prepArea, [...(groups.get(item.prepArea) ?? []), item]));
  const rows = [...groups.entries()].map(([area, items]) => {
    const itemIds = items.map((item) => item.id).sort();
    const snapshot: PreparationTicketSnapshot = {
      area, createdAt, orderId: input.orderId, orderNumber: input.orderNumber, server: input.server, table: input.table,
      items: items.map((item) => ({ id: item.id, name: item.productName, notes: item.notes?.trim() ?? '', quantity: item.quantity })),
    };
    return {
      dedupe_key: `preparation:${input.orderId}:${area}:${itemIds.join(',')}`,
      order_id: input.orderId,
      preparation_area: area,
      sales_session_id: input.salesSessionId,
      ticket_snapshot: snapshot,
    };
  });
  if (!rows.length) return;
  const table = getSupabaseClient().from('pos_preparation_print_jobs' as never) as any;
  const { error } = await table.upsert(rows, { onConflict: 'dedupe_key', ignoreDuplicates: true });
  if (error) throw new Error(`El pedido se envió, pero no fue posible crear la comanda: ${error.message}`);
}

export async function claimPreparationPrintJob(stationId: string, sessionId: string) {
  const { data, error } = await getSupabaseClient().rpc('claim_pos_preparation_print_job' as never, { station_id: stationId, active_session_id: sessionId } as never);
  if (error) throw new Error(error.message);
  return (data as unknown as PreparationPrintJob[])[0] ?? null;
}

export async function completePreparationPrintJob(jobId: string, stationId: string, succeeded: boolean, failure?: string) {
  const { error } = await getSupabaseClient().rpc('complete_pos_preparation_print_job' as never, {
    job_id: jobId, station_id: stationId, succeeded, failure: failure ?? null,
  } as never);
  if (error) throw new Error(error.message);
}

export async function beginPreparationPrintJob(jobId: string, stationId: string) {
  const { error } = await getSupabaseClient().rpc('begin_pos_preparation_print_job' as never, { job_id: jobId, station_id: stationId } as never);
  if (error) throw new Error(error.message);
}

export async function finishPreparationPrintJob(jobId: string, stationId: string, succeeded: boolean, failure?: string) {
  const { error } = await getSupabaseClient().rpc('finish_pos_preparation_print_job' as never, { job_id: jobId, station_id: stationId, succeeded, failure: failure ?? null } as never);
  if (error) throw new Error(error.message);
}

export async function releasePreparationPrintJob(jobId: string, stationId: string) {
  const { error } = await getSupabaseClient().rpc('release_pos_preparation_print_job' as never, { job_id: jobId, station_id: stationId } as never);
  if (error) throw new Error(error.message);
}

export function subscribeToPreparationPrintJobs(onChange: () => void) {
  const client = getSupabaseClient() as any;
  const channel = client.channel(`zafiro-preparation-print-${crypto.randomUUID()}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'pos_preparation_print_jobs' }, onChange)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'pos_preparation_print_jobs' }, onChange)
    .subscribe();
  return () => { void client.removeChannel(channel); };
}

function formatTicketDateTime(value: string) {
  const date = new Date(value);
  return {
    date: new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric',
    }).format(date),
    time: new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: true,
    }).format(date).toUpperCase(),
  };
}

function groupTicketItems(items: PreparationTicketSnapshot['items']) {
  const grouped = new Map<string, PreparationTicketSnapshot['items'][number]>();
  for (const item of items) {
    const notes = item.notes.trim();
    const key = `${item.name}\u0000${notes}`;
    const existing = grouped.get(key);
    grouped.set(key, existing ? { ...existing, quantity: existing.quantity + item.quantity } : { ...item, notes });
  }
  return [...grouped.values()];
}

export function printPreparationTicket(ticket: PreparationTicketSnapshot) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:58mm;height:1px;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const view = frame.contentWindow;
  if (!doc || !view) { frame.remove(); throw new Error('No fue posible crear la comanda temporal.'); }
  const label = ticket.area === 'kitchen' ? 'COCINA' : 'BARRA';
  const createdAt = formatTicketDateTime(ticket.createdAt);
  const items = groupTicketItems(ticket.items);
  const escaped = (value: string) => value.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c] ?? c));
  doc.write(`<!doctype html><meta charset="utf-8"><style>@page{size:58mm auto;margin:0}*{box-sizing:border-box}html,body{width:58mm;margin:0;background:#fff;font-family:Arial,sans-serif;color:#000}.ticket{width:53mm;margin:0;padding:2mm 0 3mm;font-size:9pt;line-height:1.15}.center{text-align:center}.venue{margin:0 0 2mm;font-size:10pt;font-weight:700;line-height:12pt}.area-rule{height:0;border:0;border-top:.3mm solid #000;margin:0}.area{margin:0;padding:1.5mm 0;font-size:16pt;font-weight:700;line-height:19pt;letter-spacing:.04em}.order{margin:2mm 0 2.5mm;text-align:center;font-size:8pt;font-weight:500;line-height:1}.main-rule{height:0;border:0;border-top:.25mm solid #000;margin:0 0 2mm}.table{margin:0 0 2mm;font-size:16pt;font-weight:700;line-height:19pt}.date-row{display:flex;justify-content:space-between;gap:2mm;margin-bottom:1.5mm;font-size:8pt;font-weight:400;white-space:nowrap}.server{margin:0 0 2mm;font-size:9pt;font-weight:500;overflow-wrap:anywhere}.items-rule{height:0;border:0;border-top:.25mm solid #000;margin:1mm 0 3mm}.items{display:grid}.item{display:grid;grid-template-columns:8mm minmax(0,1fr);column-gap:1.5mm;align-items:start}.quantity{font-size:14pt;font-weight:700;line-height:1.15}.name{min-width:0;font-size:11pt;font-weight:700;line-height:13pt;overflow-wrap:anywhere}.note{grid-column:2;margin-top:1mm;font-size:9pt;font-weight:500;line-height:1.15;overflow-wrap:anywhere}.product-separator{width:100%;height:0;border:0;border-top:.15mm dashed #b0b0b0;margin:2mm 0}.total-rule{height:0;border:0;border-top:.25mm solid #000;margin:3mm 0 2mm}.total{font-size:10pt;font-weight:700;line-height:12pt}.end{margin:2mm 0;font-size:8pt;font-weight:500}.cut-rule{height:0;border:0;border-top:.2mm dashed #000;margin:0}.cut{padding:1.5mm 0;font-size:9pt;font-weight:700;line-height:1}</style><main class="ticket"><h1 class="center venue">ZAFIRO BAR LOUNGE</h1><hr class="area-rule"><h2 class="center area">${label}</h2><hr class="area-rule"><div class="order">PEDIDO #${escaped(ticket.orderNumber)} · NUEVO</div><hr class="main-rule"><div class="table">MESA ${escaped(ticket.table)}</div><div class="date-row"><span>${createdAt.date}</span><span>${createdAt.time}</span></div><div class="server">Mesero: ${escaped(ticket.server)}</div><hr class="items-rule"><section class="items">${items.map((item, index) => `<article class="item"><div class="quantity">${item.quantity}×</div><div class="name">${escaped(item.name)}</div>${item.notes ? `<div class="note">${escaped(item.notes)}</div>` : ''}</article>${index < items.length - 1 ? '<hr class="product-separator">' : ''}`).join('')}</section><hr class="total-rule"><div class="center total">TOTAL: ${items.reduce((total, item) => total + item.quantity, 0)} UNIDADES</div><div class="center end">FIN ${label}</div><hr class="cut-rule"><div class="center cut">✂ SEPARAR AQUÍ</div><hr class="cut-rule"></main>`);
  doc.close();
  frame.style.height = `${Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight)}px`;
  return new Promise<void>((resolve, reject) => {
    const clean = () => frame.remove();
    view.addEventListener('afterprint', () => { clean(); resolve(); }, { once: true });
    window.setTimeout(() => { try { view.print(); window.setTimeout(() => { clean(); resolve(); }, 15000); } catch (error) { clean(); reject(error); } }, 0);
  });
}

type ReceiptLine = Pick<PosOrderItem, 'productName' | 'quantity' | 'unitPrice' | 'totalPrice'>;

function groupReceiptLines(items: ReceiptLine[]) {
  const grouped = new Map<string, ReceiptLine>();
  for (const item of items) {
    const key = `${item.productName}\u0000${item.unitPrice}`;
    const existing = grouped.get(key);
    grouped.set(key, existing
      ? { ...existing, quantity: existing.quantity + item.quantity, totalPrice: existing.totalPrice + item.totalPrice }
      : { ...item });
  }
  return [...grouped.values()];
}

function formatReceiptDateTime(value: string) {
  const date = new Date(value);
  const day = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(date);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(date).toUpperCase();
  return `${day} · ${time}`;
}

function formatReceiptNumber(orderId: string) {
  let hash = 2166136261;
  for (let index = 0; index < orderId.length; index += 1) {
    hash ^= orderId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return String((hash >>> 0) % 1_000_000).padStart(6, '0');
}

const receiptWhatsAppIcon = '<svg class="contact-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20 11.7A8.3 8.3 0 0 1 7.7 19l-3.7 1 1.1-3.5A8.3 8.3 0 1 1 20 11.7Z"/><path d="M9.2 8.8c.2-.4.4-.4.7-.4h.6c.2 0 .4 0 .5.4l.6 1.5c.1.3 0 .5-.1.7l-.5.6c-.1.1-.2.3 0 .5.3.6 1.1 1.7 2.3 2.3.2.1.4.1.5 0l.6-.5c.2-.2.5-.2.7-.1l1.5.6c.3.1.4.3.4.5v.6c0 .3 0 .5-.4.7-.4.2-1.2.4-2 .2a7.7 7.7 0 0 1-4.7-4.7c-.2-.8 0-1.6.2-2Z"/></svg>';
const receiptInstagramIcon = '<svg class="contact-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none"/></svg>';

export function printSaleReceipt(order: PosOrderWithRelations) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true'); frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:58mm;height:220mm;border:0;'; document.body.appendChild(frame);
  const doc = frame.contentDocument; const view = frame.contentWindow;
  if (!doc || !view) { frame.remove(); return Promise.reject(new Error('No fue posible crear el recibo temporal.')); }
  const esc = (v: string) => v.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c] ?? c));
  const money = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
  const items = groupReceiptLines(order.items.filter((item) => item.operationalStatus !== 'cancelled'));
  const receiptDateTime = formatReceiptDateTime(order.closedAt ?? order.updatedAt);
  const receiptNumber = formatReceiptNumber(order.id);
  doc.write(`<!doctype html><meta charset="utf-8"><style>@page{size:58mm auto;margin:0}*{box-sizing:border-box}html,body{width:58mm;margin:0;background:#fff;font-family:Arial,sans-serif;font-variant-numeric:tabular-nums;color:#000}.receipt{width:53mm;margin:0;padding:2.5mm 0 5mm;font-size:8pt;line-height:1.2}.center{text-align:center}.brand{display:block;width:100%;height:auto;margin:0 auto 3mm;filter:invert(1)}.address-line{font-size:7pt;font-weight:400;line-height:1.2}.city{margin-top:.5mm;font-size:8pt;font-weight:400;line-height:1.2}.location{margin-bottom:3mm}.rule{height:0;border:0;border-top:.3mm solid #000;margin:0}.receipt-number{padding:2mm 0;font-size:9pt;font-weight:700}.sale-meta{display:flex;align-items:center;justify-content:space-between;gap:2mm;margin:3mm 0}.table{font-size:11pt;font-weight:700;white-space:nowrap}.date{font-size:7pt;font-weight:400;text-align:right;white-space:nowrap}.detail-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2mm;padding:2mm 0;font-size:8pt;font-weight:700}.detail-heading span:last-child{text-align:right}.detail-rule{height:0;border:0;border-top:.2mm solid #000;margin:0}.items{display:grid;gap:3mm;margin:3mm 0}.item-main{display:grid;grid-template-columns:33mm 18mm;column-gap:2mm;align-items:start;font-size:9pt;font-weight:500}.item-name{min-width:0;overflow-wrap:anywhere}.item-price{text-align:right;white-space:nowrap}.unit{margin-top:.5mm;font-size:7.5pt;font-weight:400}.summary-rule{height:0;border:0;border-top:.3mm solid #000;margin:0}.subtotal{display:flex;justify-content:space-between;gap:2mm;padding:2mm 0;font-size:9pt;font-weight:400}.total{display:flex;justify-content:space-between;gap:2mm;border-top:.5mm solid #000;border-bottom:.5mm solid #000;padding:2.5mm 0;font-size:14pt;font-weight:700}.thanks{margin-top:4mm;font-size:9pt;font-weight:700;line-height:1.2}.soon{display:block;margin-top:1mm;font-size:8pt;font-weight:400}.contacts{display:flex;align-items:center;justify-content:space-between;margin-top:3mm;white-space:nowrap;font-size:8pt;font-weight:500}.contact-group{display:flex;align-items:center;gap:.8mm;flex:none}.contact-group+ .contact-group{margin-left:0}.contact-icon{width:4mm;height:4mm;flex:none}</style><main class="receipt"><img class="brand" src="${zafiroLogo}" alt="Zafiro Bar Lounge"><div class="center location"><div class="address-line">Calle 25 #21A - 07 · Barrio La Libertad</div><div class="city">Florencia, Caquetá</div></div><hr class="rule"><div class="center receipt-number">RECIBO DE VENTA N.º ${receiptNumber}</div><hr class="rule"><div class="sale-meta"><span class="table">MESA ${esc(order.tableCodeSnapshot ?? '—')}</span><span class="date">${receiptDateTime}</span></div><hr class="rule"><div class="detail-heading"><span>DETALLE DEL CONSUMO</span><span>TOTAL</span></div><hr class="detail-rule"><section class="items">${items.map((item) => `<article><div class="item-main"><span class="item-name">${item.quantity}× ${esc(item.productName)}</span><span class="item-price">${money(item.totalPrice)}</span></div><div class="unit">${money(item.unitPrice)} c/u</div></article>`).join('')}</section><hr class="summary-rule"><section><div class="subtotal"><span>Subtotal</span><span>${money(order.summary.subtotal)}</span></div><div class="total"><span>TOTAL</span><span>${money(order.summary.totalDue)}</span></div></section><div class="center thanks">¡GRACIAS POR TU VISITA!<span class="soon">Esperamos verte pronto.</span></div><div class="contacts"><span class="contact-group">${receiptWhatsAppIcon}<span>321 290 0379</span></span><span class="contact-group">${receiptInstagramIcon}<span>@zafirobarlounge</span></span></div></main>`); doc.close();
  return new Promise<void>((resolve, reject) => { const done = () => { frame.remove(); resolve(); }; view.addEventListener('afterprint', done, { once: true }); window.setTimeout(() => { try { view.print(); window.setTimeout(done, 15000); } catch (e) { frame.remove(); reject(e); } }, 0); });
}
