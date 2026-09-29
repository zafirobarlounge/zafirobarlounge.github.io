const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const compile = (file) => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const domain = { exports: {}, Intl, Date };
vm.runInNewContext(compile('src/admin/inventory/inventory.domain.ts'), domain);

test('cantidades distinguen ausencia de cero y respetan precisión', () => {
  assert.equal(domain.exports.formatInventoryQuantity(null, 'unit'), 'Sin conteo inicial');
  assert.equal(domain.exports.formatConfiguredInventoryQuantity(null, 'unit'), 'No configurado');
  assert.match(domain.exports.formatInventoryQuantity(0, 'unit'), /^0 unidad/);
  assert.match(domain.exports.formatConfiguredInventoryQuantity(0, 'unit'), /^0 unidad/);
  assert.match(domain.exports.formatInventoryQuantity(12.5, 'gram', 3), /12,5 g/);
});

test('snapshot de presentación conserva conversión y nota sin romper solicitudes anteriores', () => {
  const presentation = { presentation_id:'p1',presentation_name:'Paca x12',content_per_package:12,content_unit:'unit',package_quantity:2 };
  const encoded = domain.exports.encodeInventorySubmissionLineNotes('Para barra', presentation);
  const parsed = JSON.parse(JSON.stringify(domain.exports.parseInventorySubmissionLineNotes(encoded)));
  assert.deepEqual(parsed, { notes:'Para barra',presentation });
  assert.deepEqual(JSON.parse(JSON.stringify(domain.exports.parseInventorySubmissionLineNotes('Nota anterior'))), { notes:'Nota anterior',presentation:null });
  assert.deepEqual(JSON.parse(JSON.stringify(domain.exports.parseInventorySubmissionLineNotes('zafiro-presentation-v1:{mal'))), { notes:'zafiro-presentation-v1:{mal',presentation:null });
});

test('búsqueda, área y estados filtran existencias sin confundir null con cero', () => {
  const items = [
    { id:'cola',import_code:'BAR_COLA',name:'Coca-Cola 400 ml',areas:['bar'],balance:36,minimum_quantity:null },
    { id:'limon',import_code:'BAR_LIMON',name:'Limón',areas:['bar','kitchen'],balance:0,minimum_quantity:4 },
    { id:'pan',import_code:'KITCHEN_PAN',name:'Pan',areas:['kitchen'],balance:2,minimum_quantity:5 },
    { id:'salsa',import_code:'KITCHEN_SALSA',name:'Salsa',areas:['kitchen'],balance:null,minimum_quantity:1 },
  ].map((item) => ({ active:true,base_unit:'unit',precision_scale:0,target_quantity:null,tracking_started_at:null,pending_incoming:0,last_unit_cost:null,average_unit_cost:null,inventory_value:null,...item }));
  const filter = (search,area,status,order='name_asc') => Array.from(domain.exports.filterInventoryStockItems(items,search,area,status,order), (item) => item.id);
  assert.deepEqual(filter('coca','all','all'), ['cola']);
  assert.deepEqual(filter('bar_limon','all','all'), ['limon']);
  assert.deepEqual(filter('','bar','all'), ['cola','limon']);
  assert.deepEqual(filter('','kitchen','all'), ['limon','pan','salsa']);
  assert.deepEqual(filter('','all','uncounted'), ['salsa']);
  assert.deepEqual(filter('','all','low'), ['limon','pan']);
  assert.deepEqual(filter('','all','depleted'), ['limon']);
  assert.deepEqual(filter('','all','in_stock'), ['cola','pan']);
  assert.deepEqual(filter('','all','all','name_desc'), ['salsa','pan','limon','cola']);
  assert.equal(items.find((item)=>item.id==='cola').id, 'cola');
});

test('todos los selectores filtrados excluyen el articulo anterior y seleccionan la coincidencia', () => {
  const items = [
    { id:'aceite',name:'Aceite para fritura',import_code:'COC_ACEITE' },
    { id:'cola',name:'Coca-Cola 400 ml',import_code:'BAR_COLA' },
  ];
  const filtered = domain.exports.getInventoryItemSearchSelection(items, 'aceite', 'coca');
  assert.deepEqual(Array.from(filtered.options, (item) => item.id), ['cola']);
  assert.equal(filtered.selectedItemId, 'cola');
  const empty = domain.exports.getInventoryItemSearchSelection(items, 'cola', 'sin coincidencias');
  assert.equal(empty.options.length, 0);
  assert.equal(empty.selectedItemId, '');
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  assert.doesNotMatch(view, /selected&&!matching|item&&!matchingTracked/);
  assert.ok((view.match(/getInventoryItemSearchSelection/g) ?? []).length >= 8);
  assert.ok((view.match(/Sin artículos coincidentes/g) ?? []).length >= 4);
  assert.match(view, /setPresentationId\('base'\)[\s\S]*\},\[itemId\]\)/);
});

test('nuevo reporte limita artículos al área elegida incluso para administración', () => {
  const items = [
    { id:'cola',name:'Coca-Cola',areas:['bar'] },
    { id:'pan',name:'Pan',areas:['kitchen'] },
    { id:'limon',name:'Limón',areas:['bar','kitchen'] },
  ];
  assert.deepEqual(Array.from(domain.exports.filterInventoryItemsByArea(items, 'bar'), (item) => item.id), ['cola','limon']);
  assert.deepEqual(Array.from(domain.exports.filterInventoryItemsByArea(items, 'kitchen'), (item) => item.id), ['pan','limon']);
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  assert.match(view, /const available=filterInventoryItemsByArea\(data\.items,selectedArea\)/);
  assert.doesNotMatch(view, /data\.can_manage\|\|item\.areas\.includes\(selectedArea\)/);
});

test('mensajes operativos de inventario vencen y las validaciones permanecen visibles', () => {
  assert.equal(domain.exports.getInventoryMessageDuration(false), 5000);
  assert.equal(domain.exports.getInventoryMessageDuration(true), 8000);
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  assert.match(view, /getInventoryMessageDuration\(Boolean\(error\)\)/);
  assert.match(view, /getInventoryMessageDuration\(true\)/);
  assert.match(view, /window\.clearTimeout/);
  assert.match(view, /const errors=\[\.\.\.\(parsed\?\.errors/);
});

test('importador XLSX se limita a configuración administrativa y exige vista previa', () => {
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  const repository = readFileSync('src/admin/inventory/inventory.repository.ts', 'utf8');
  const migration = readFileSync('supabase/migrations/202609280007_inventory_initial_import.sql', 'utf8');
  assert.match(view, /Descargar plantilla/);
  assert.match(view, /Importar inventario/);
  assert.match(view, /previewInventoryImport/);
  assert.match(view, /Confirmar importación/);
  assert.match(repository, /inventory_import_preview/);
  assert.match(repository, /inventory_import_commit/);
  assert.match(migration, /inventory_can_configure\(\)/);
  assert.match(migration, /inventory_import_batches/);
  assert.match(migration, /pg_advisory_xact_lock\(9272026,7\)/);
  assert.doesNotMatch(migration, /insert into public\.inventory_receipts/);
  assert.doesNotMatch(migration, /insert into public\.pos_cash_movements/);
  assert.doesNotMatch(migration, /update public\.pos_order_items/);
});

test('vista previa calcula presentación, total y costo base sin usar redondeo como autoridad', () => {
  const bread = domain.exports.receiptCostPreview(3, 6, 7000, 'package');
  assert.equal(bread.baseQuantity, 18);
  assert.equal(bread.lineTotal, 21000);
  assert.ok(Math.abs(bread.baseUnitCost - (7000 / 6)) < 1e-10);
  const sauce = domain.exports.receiptCostPreview(1, 200, 4990, 'package');
  assert.equal(sauce.baseQuantity, 200);
  assert.equal(sauce.lineTotal, 4990);
  assert.equal(sauce.baseUnitCost, 24.95);
  const whole = domain.exports.inventoryMoneyInput('7.000');
  assert.equal(whole.display, '7.000');
  assert.equal(whole.value, 7000);
  const decimal = domain.exports.inventoryMoneyInput('24,95');
  assert.equal(decimal.display, '24,95');
  assert.equal(decimal.value, 24.95);
});

test('vista previa separa recibido, aplicado, excedente y pendiente de solicitud', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(domain.exports.receiptRequestApplicationPreview(12, 0, 8))), { pending:12,received:8,applied:8,excess:0,pendingAfter:4 });
  assert.deepEqual(JSON.parse(JSON.stringify(domain.exports.receiptRequestApplicationPreview(12, 0, 12))), { pending:12,received:12,applied:12,excess:0,pendingAfter:0 });
  assert.deepEqual(JSON.parse(JSON.stringify(domain.exports.receiptRequestApplicationPreview(12, 0, 24))), { pending:12,received:24,applied:12,excess:12,pendingAfter:0 });
  assert.deepEqual(JSON.parse(JSON.stringify(domain.exports.receiptRequestApplicationPreview(12, 8, 8))), { pending:4,received:8,applied:4,excess:4,pendingAfter:0 });
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  for (const label of ['Pendiente de solicitud','Cantidad realmente recibida','Aplicado a solicitud','Excedente de esta entrada','Pendiente después de guardar']) assert.match(view, new RegExp(label));
  assert.match(view, /line\.applied_submission_quantity/);
});

test('CSV de inventario protege fórmulas y conserva referencias', () => {
  const csv = domain.exports.inventoryMovementCsv([{
    id: 'movement', item_id: 'item', item_name: '=IMPORTXML("x")', movement_type: 'correction', quantity_delta: -2,
    base_unit_snapshot: 'unit', reason: '+riesgo', actor: '@actor', occurred_at: '2026-09-27T20:00:00Z',
    sales_session_id: 'session-uuid', order_id: null, order_item_id: null, metadata: {},
  }]);
  assert.match(csv, /'=IMPORTXML/);
  assert.match(csv, /'\+riesgo/);
  assert.match(csv, /'@actor/);
  assert.match(csv, /session-uuid/);
});

test('rutas y navegación exponen inventario solo a roles previstos', () => {
  const routes = readFileSync('src/routes/AppRouter.tsx', 'utf8');
  const hub = readFileSync('src/admin/AdminView.tsx', 'utf8');
  const pos = readFileSync('src/admin/AdminPosView.tsx', 'utf8');
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  assert.match(routes, /path="\/admin\/inventory"/);
  for (const role of ['superadmin', 'cashier', 'bar', 'kitchen']) assert.match(hub, new RegExp(role));
  assert.doesNotMatch(hub.match(/Abrir inventario[\s\S]{0,300}/)?.[0] ?? '', /waiter/);
  assert.match(pos, /Existencias y solicitudes/);
  assert.match(view, /\['superadmin','cashier','bar','kitchen'\]/);
  assert.match(view, /Tu rol no tiene acceso al inventario/);
});

test('interfaz muestra conversión congelada y separa recepción de gasto', () => {
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  assert.match(view, /Cantidad realmente recibida/);
  assert.match(view, /presentación real, su conversión y los costos de toda la entrada quedarán congelados/);
  assert.match(view, /La recepción no crea gastos automáticamente/);
  assert.match(view, /Recepción directa en unidad base/);
  assert.match(view, /Costo real por paquete o envase/);
  assert.match(view, /Último costo real/);
  assert.match(view, /item\.last_unit_cost/);
  assert.doesNotMatch(view, /Costo promedio rastreado/);
  assert.match(view, /Valor contable rastreado/);
  assert.match(view, /última compra real/);
  assert.match(view, /solo incluye los componentes configurados/);
  assert.doesNotMatch(view, /costo total del plato/i);
  assert.doesNotMatch(view, /utilidad neta|margen neto/i);
});

test('acciones por tarjeta bloquean el artículo y reutilizan los flujos existentes', () => {
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  assert.match(view, /onAdjust\(item\.id\)/);
  assert.match(view, /onReceive\(item\.id\)/);
  assert.match(view, /<AdjustmentDialog[^>]+itemId=\{selectedItemId\}/);
  assert.match(view, /<ReceiveDialog[^>]+initialItemId=\{selectedItemId\}/);
  assert.match(view, /Conteo \/ corregir/);
  assert.match(view, /Registrar entrada/);
  assert.match(view, /Primero registra el conteo inicial de este artículo/);
  assert.match(view, /lockedValueClass/);
  assert.doesNotMatch(view, /Conteo inicial o corrección/);
  for (const label of ['Buscar existencias','Buscar artículos configurados','Buscar artículo para presentación','Buscar componente','Buscar artículo para reporte','Buscar artículo para entrada']) assert.match(view, new RegExp(label));
  assert.match(view, /function SearchableInventoryItemSelect[\s\S]*getInventoryItemSearchSelection/);
});

test('administración muestra presentación solicitada y equivalencia base', () => {
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  assert.match(view, /parseInventorySubmissionLineNotes/);
  assert.match(view, /Solicitado:/);
  assert.match(view, /Equivale a:/);
  assert.match(view, /formatInventoryQuantity\(requested, item\.base_unit/);
});

test('migración 006 congela costos y aplica valoración sin acoplarla a gastos', () => {
  const sql = readFileSync('supabase/migrations/202609280006_inventory_cost_valuation.sql', 'utf8');
  assert.match(sql, /suggested_package_cost/);
  for (const field of ['actual_package_cost','line_total_cost','base_unit_cost','average_unit_cost_snapshot','tracked_cost']) assert.match(sql, new RegExp(field));
  assert.match(sql, /old_qty<=0/);
  assert.match(sql, /old_qty\*old_avg/);
  assert.match(sql, /cl\.average_unit_cost_snapshot,'return'/);
  assert.match(sql, /expense\.amount<>derived_total/);
  assert.doesNotMatch(sql, /update public\.pos_cash_movements/);
});

test('migración 008 usa último costo real sin reescribir cantidades ni historia', () => {
  const sql = readFileSync('supabase/migrations/202609280008_inventory_last_purchase_cost.sql', 'utf8');
  assert.match(sql, /add column last_unit_cost /);
  assert.match(sql, /add column last_unit_cost_snapshot /);
  assert.match(sql, /operation_kind='receipt' and incoming_unit_cost is not null/);
  assert.match(sql, /cost_state\.last_unit_cost/);
  assert.match(sql, /coalesce\(cl\.last_unit_cost_snapshot,cl\.average_unit_cost_snapshot\)/);
  assert.match(sql, /v\.last_unit_cost/);
  assert.match(sql, /last_actual_purchase/);
  assert.match(sql, /coalesce\(l\.base_unit_cost,l\.unit_cost\)/);
  assert.doesNotMatch(sql, /update public\.inventory_receipt_lines/);
  assert.doesNotMatch(sql, /update public\.inventory_movements/);
  assert.doesNotMatch(sql, /update public\.inventory_pos_consumption_lines set last_unit_cost_snapshot/);
});

test('migración 009 conserva recepción completa y limita aplicación a la solicitud', () => {
  const migration = readFileSync('supabase/migrations/202609280009_inventory_receipt_request_application.sql', 'utf8');
  assert.match(migration, /add column applied_submission_quantity numeric/);
  assert.match(migration, /set applied_submission_quantity=base_quantity[\s\S]*where submission_line_id is not null/);
  assert.match(migration, /applied_qty:=least\(pending_qty,qty\)/);
  assert.match(migration, /received_quantity=least\(approved_quantity,received_quantity\+applied_qty\)/);
  assert.match(migration, /inventory_apply_valuation\(item\.id,qty,base_cost,'receipt'\)/);
  assert.match(migration, /applied_submission_quantity <= base_quantity/);
  assert.doesNotMatch(migration, /received_quantity\+qty>subline\.approved_quantity/);
});

test('migracion 010 pagina historiales en PostgreSQL y la UI consume sus RPC', () => {
  const migration = readFileSync('supabase/migrations/202609290010_inventory_history_pagination.sql', 'utf8');
  const repository = readFileSync('src/admin/inventory/inventory.repository.ts', 'utf8');
  const adminView = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  const areaPanel = readFileSync('src/admin/inventory/AreaInventoryPanel.tsx', 'utf8');
  for (const rpc of ['inventory_recent_submissions','inventory_pending_replenishments','inventory_receipts_page','inventory_submissions_page','inventory_movements_page','inventory_movements_export']) {
    assert.match(migration, new RegExp(`create function public\\.${rpc}`));
    assert.match(repository, new RegExp(rpc));
  }
  assert.match(migration, /limit 8/);
  assert.ok((migration.match(/limit 21/g) ?? []).length >= 2);
  assert.match(migration, /limit 51/);
  assert.match(migration, /\(r\.received_at,r\.id\)<\(before_received_at,before_id\)/);
  assert.match(migration, /\(s\.created_at,s\.id\)<\(before_created_at,before_id\)/);
  assert.match(migration, /\(m\.occurred_at,m\.id\)<\(before_occurred_at,before_id\)/);
  assert.match(migration, /'submissions','\[\]'::jsonb,'receipts','\[\]'::jsonb,'movements','\[\]'::jsonb/);
  assert.doesNotMatch(adminView, /data\.(receipts|submissions|movements)/);
  assert.doesNotMatch(areaPanel, /slice\(0,\s*8\)/);
  assert.match(areaPanel, /loadInventoryRecentSubmissions\(area\)/);
  assert.match(adminView, /loadInventoryMovementExport\(month\)/);
  assert.match(adminView, /type="month"/);
  assert.match(adminView, /Anterior/);
  assert.match(adminView, /Siguiente/);
  assert.match(adminView, /disabled=\{loading\|\|page===0\}/);
  assert.match(adminView, /disabled=\{loading\|\|!hasMore\}/);
  assert.match(adminView, /Última página/);
  assert.match(adminView, /disabled:cursor-not-allowed/);
  assert.match(adminView, /Solicitudes, conteos y daños/);
  assert.doesNotMatch(adminView, /mercanc\?a|administraci\?n|p\?gina|m\?s|l\?nea|presentaci\?n|da\?os|tu \?rea|Reposici\?n|Da\?o|revisi\?n|Art\?culo|Operaci\?n|exportaci\?n/);
  assert.equal(domain.exports.inventoryMonthValue(new Date('2026-09-28T12:00:00Z')), '2026-09');
});
