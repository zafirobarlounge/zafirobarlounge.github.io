const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const compile = (file) => ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const domain = { exports: {}, Intl, Date };
vm.runInNewContext(compile('src/admin/inventory/inventory.domain.ts'), domain);
const purchaseEditorModule = { exports: {} };
vm.runInNewContext(compile('src/admin/inventory/InventoryPurchaseLinesEditor.tsx'), {
  module: purchaseEditorModule,
  exports: purchaseEditorModule.exports,
  Intl,
  Date,
  require(name) {
    if (name === 'react') return { useEffect() {}, useState() {} };
    if (name === 'react/jsx-runtime') return { jsx() {}, jsxs() {}, Fragment: 'fragment' };
    if (name.includes('inventory.domain')) return domain.exports;
    throw new Error(name);
  },
});
const purchaseEditor = purchaseEditorModule.exports;

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
  assert.deepEqual(filter('','all','all','operational_priority'), ['salsa','limon','pan','cola']);
  assert.equal(items.find((item)=>item.id==='cola').id, 'cola');
});

test('Caja ordena por prioridad operativa y conserva orden alfabético dentro de cada grupo', () => {
  const base = { active:true,areas:['bar'],import_code:null,base_unit:'unit',precision_scale:0,target_quantity:null,tracking_started_at:null,last_unit_cost:null,average_unit_cost:null,inventory_value:null };
  const items = [
    { ...base,id:'normal-z',name:'Zumo',balance:20,minimum_quantity:5,pending_incoming:0 },
    { ...base,id:'pending-z',name:'Yerbabuena',balance:20,minimum_quantity:5,pending_incoming:3 },
    { ...base,id:'pending-a',name:'Agua',balance:20,minimum_quantity:5,pending_incoming:2 },
    { ...base,id:'low',name:'Pan',balance:2,minimum_quantity:5,pending_incoming:4 },
    { ...base,id:'depleted',name:'Limón',balance:0,minimum_quantity:5,pending_incoming:0 },
    { ...base,id:'uncounted',name:'Salsa',balance:null,minimum_quantity:null,pending_incoming:0 },
    { ...base,id:'normal-a',name:'Cerveza',balance:20,minimum_quantity:5,pending_incoming:0 },
  ];
  assert.deepEqual(Array.from(domain.exports.filterInventoryStockItems(items,'','all','all','operational_priority'), (item) => item.id), ['uncounted','depleted','low','pending-a','pending-z','normal-a','normal-z']);
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  assert.match(view, /useState<InventoryStockOrder>\('operational_priority'\)/);
  assert.match(view, /<option value="operational_priority">Prioridad operativa<\/option>/);
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
  assert.ok((view.match(/Sin artículos coincidentes/g) ?? []).length >= 3);
  assert.match(readFileSync('src/admin/inventory/InventoryPurchaseLinesEditor.tsx','utf8'), /presentationId: 'base'/);
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

test('áreas configurables alimentan etiquetas, filtros y formularios sin volver dinámico el POS', () => {
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  const panel = readFileSync('src/admin/inventory/AreaInventoryPanel.tsx', 'utf8');
  const repository = readFileSync('src/admin/inventory/inventory.repository.ts', 'utf8');
  assert.match(view, /Áreas de inventario/);
  assert.match(view, /<details className="group mt-6/);
  assert.match(view, /<summary[^>]+>.*Áreas de inventario/s);
  assert.match(view, /group-open:hidden/);
  assert.match(view, /data\.areas\.filter\(\(entry\)=>entry\.active\)/);
  assert.match(view, /inventoryAreaName\(data\.areas,entry\.area\)/);
  assert.match(view, /action:'save_area'/);
  assert.match(repository, /requested_area: area/);
  assert.match(view, /usage_type\?\?'consumable'.*item\.areas\.includes\('bar'\).*item\.areas\.includes\('kitchen'\)/);
  assert.match(panel, /PosInventoryArea/);
  assert.doesNotMatch(panel, /operations/);
});

test('tipos de uso separan cargas y limitan recetas desde UI y PostgreSQL', () => {
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  const repository = readFileSync('src/admin/inventory/inventory.repository.ts', 'utf8');
  const migration = readFileSync('supabase/migrations/202609290015_inventory_item_usage_type.sql', 'utf8');
  assert.match(view, /useState<InventoryUsageType \| 'all'>\('all'\)/);
  assert.match(view, /aria-label="Filtrar existencias por tipo"/);
  assert.match(view, /<option value="all">Todos<\/option><option value="consumable">Consumibles<\/option><option value="operational">Operativos<\/option>/);
  assert.match(view, /Consumibles/);
  assert.match(view, /Operativos/);
  assert.match(view, /Tipo de uso/);
  assert.match(repository, /requested_usage_type: usageType/);
  assert.match(migration, /usage_type text not null default 'consumable'/);
  assert.match(migration, /Las recetas solo admiten articulos consumibles/);
  assert.match(migration, /i\.usage_type='consumable'/);
});

test('configuración permite eliminar únicamente registros sin uso mediante RPC protegido', () => {
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  const repository = readFileSync('src/admin/inventory/inventory.repository.ts', 'utf8');
  const migration = readFileSync('supabase/migrations/202609290016_inventory_safe_configuration_delete.sql', 'utf8');
  for (const label of ['Eliminar artículo','Eliminar presentación','Eliminar área']) assert.match(view,new RegExp(label));
  assert.match(repository,/inventory_delete_configuration/);
  assert.match(migration,/not public\.inventory_can_configure\(\)/);
  assert.match(migration,/tiene configuración o historial/);
  assert.match(migration,/presentación ya tiene historial/);
});

test('receta separa componentes medidos del descuento automatico y calcula su costo', () => {
  const complete = JSON.parse(JSON.stringify(domain.exports.summarizeInventoryRecipeCost([
    { active:true,quantity_base:1,tracked_component_cost:2000 },
    { active:true,quantity_base:30,tracked_component_cost:300 },
  ])));
  assert.deepEqual(complete, { hasMeasured:true,isPartial:false,cost:2300 });
  const partial = JSON.parse(JSON.stringify(domain.exports.summarizeInventoryRecipeCost([
    { active:true,quantity_base:1,tracked_component_cost:2000 },
    { active:true,quantity_base:null,tracked_component_cost:null },
  ])));
  assert.deepEqual(partial, { hasMeasured:true,isPartial:true,cost:2000 });
  const unknownCost = JSON.parse(JSON.stringify(domain.exports.summarizeInventoryRecipeCost([
    { active:true,quantity_base:1,tracked_component_cost:2000 },
    { active:true,quantity_base:15,tracked_component_cost:null },
  ])));
  assert.deepEqual(unknownCost, { hasMeasured:true,isPartial:true,cost:2000 });
  const descriptiveOnly = JSON.parse(JSON.stringify(domain.exports.summarizeInventoryRecipeCost([
    { active:true,quantity_base:null,tracked_component_cost:null },
  ])));
  assert.deepEqual(descriptiveOnly, { hasMeasured:false,isPartial:true,cost:null });
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  assert.match(view, /Descontar del inventario autom.ticamente/);
  assert.match(view, /role="switch"/);
  assert.match(view, /aria-checked=\{component\.controls_inventory\}/);
  assert.match(view, /Se usar. para calcular el costo, pero no generar. movimientos autom.ticos de inventario/);
  assert.match(view, /Componente descriptivo sin cantidad definida/);
  assert.match(view, /Costo calculado parcial/);
  assert.match(view, /quantity_base:row\.quantity_base===''\?null:Number\(row\.quantity_base\)/);
  assert.doesNotMatch(view, /Control completo de componentes medidos/);
  assert.doesNotMatch(view, /<Field label="Cobertura">/);
});

test('consumo del menú resume recetas, costos y margen sin duplicar el formulario', () => {
  const items = [
    { id:'pan',name:'Pan hamburguesa',base_unit:'unit' },
    { id:'carne',name:'Carne',base_unit:'gram' },
    { id:'tomate',name:'Tomate',base_unit:'gram' },
  ];
  const recipes = [
    { id:'r1',menu_item_source_key:'menu::completa',menu_name:'Completa',item_id:'pan',controls_inventory:true,quantity_base:1,active:true,control_mode:'partial',tracked_component_cost:1000 },
    { id:'r2',menu_item_source_key:'menu::completa',menu_name:'Completa',item_id:'carne',controls_inventory:false,quantity_base:150,active:true,control_mode:'partial',tracked_component_cost:7000 },
    { id:'r3',menu_item_source_key:'menu::parcial',menu_name:'Parcial',item_id:'tomate',controls_inventory:false,quantity_base:null,active:true,control_mode:'partial',tracked_component_cost:null },
  ];
  const rows = JSON.parse(JSON.stringify(domain.exports.buildInventoryMenuRecipeRows([
    { source_key:'menu::completa',name:'Hamburguesa',price:30000 },
    { source_key:'menu::parcial',name:'Ensalada',price:18000 },
    { source_key:'menu::sin-receta',name:'Limonada',price:9000 },
  ], recipes, items)));
  assert.equal(rows[0].status, 'configured');
  assert.equal(rows[0].calculated_cost, 8000);
  assert.ok(Math.abs(rows[0].estimated_margin - 73.33333333333333) < 1e-10);
  assert.equal(rows[1].status, 'partial');
  assert.equal(rows[1].estimated_margin, null);
  assert.equal(rows[2].status, 'missing');
  assert.equal(rows[2].calculated_cost, null);
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  const migration = readFileSync('supabase/migrations/202609290018_inventory_menu_recipe_overview.sql', 'utf8');
  assert.match(view, /recipes: 'Consumo del menú'/);
  assert.match(view, /Producto<\/th><th[^>]*>Receta<\/th><th[^>]*>Ingredientes<\/th><th[^>]*>Costo calculado<\/th><th[^>]*>Precio venta<\/th><th[^>]*>Margen estimado<\/th><th[^>]*>Acción/);
  assert.match(view, /initialMenuKey=\{selectedRecipeMenuKey\}/);
  assert.equal((view.match(/function RecipeDialog/g) ?? []).length, 1);
  assert.doesNotMatch(view, /action="Configurar receta"/);
  assert.match(migration, /'price',mi\.precio_venta/);
  assert.match(migration, /public\.inventory_can_configure\(\)/);
});

test('migracion 013 permite cantidades de costo sin descuento automatico', () => {
  const migration = readFileSync('supabase/migrations/202609290013_inventory_recipe_cost_quantity.sql', 'utf8');
  assert.match(migration, /not controls_inventory and \(quantity_base is null or quantity_base > 0\)/);
  assert.match(migration, /component->>'quantity_base' is not null and \(component->>'quantity_base'\)::numeric<=0/);
  assert.match(migration, /case when r\.quantity_base is null or v\.last_unit_cost is null then null/);
  assert.doesNotMatch(migration, /case when not r\.controls_inventory or v\.last_unit_cost is null/);
  assert.match(migration, /inventory_deliver_pos_item and inventory_menu_alerts remain unchanged/);
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
  const editor = readFileSync('src/admin/inventory/InventoryPurchaseLinesEditor.tsx', 'utf8');
  for (const label of ['Pendiente de solicitud','Cantidad realmente recibida','Aplicado a solicitud','Excedente','Pendiente después de guardar']) assert.match(editor, new RegExp(label));
  assert.match(view, /line\.applied_submission_quantity/);
  assert.match(editor, /Recepción directa, sin solicitud/);
  assert.doesNotMatch(editor, /Recepci\?n directa/);
});

test('cada producto vincula solo solicitudes compatibles y revalida cambios en tiempo real', () => {
  const submission = (id,item,status='approved',approved=12,received=0,area='kitchen') => ({
    id:`submission-${id}`,kind:'replenishment',area,status,created_at:'2026-10-01T12:00:00Z',
    lines:[{id,item_id:item,item_name:item,approved_quantity:approved,received_quantity:received}],
  });
  const candidates = [
    submission('tomato','tomato'),
    submission('bread','bread'),
    submission('complete','tomato','received',12,12),
    submission('partial-review','tomato','partially_approved',12,0),
  ];
  assert.deepEqual(Array.from(purchaseEditor.inventoryPendingSubmissionLines(candidates,'tomato'), row => row.id), ['tomato']);
  assert.deepEqual(Array.from(purchaseEditor.inventoryPendingSubmissionLines(candidates,'bread'), row => row.id), ['bread']);
  const baseLine = {key:'one',itemId:'tomato',presentationId:'base',quantity:'5',costDisplay:'',costValue:null,submissionLineId:null};
  const automatic = purchaseEditor.reconcileInventoryPurchaseSubmissionLinks([baseLine], candidates);
  assert.equal(automatic.lines[0].submissionLineId,'tomato');
  assert.equal(automatic.invalidated,false);
  assert.equal(purchaseEditor.reconcileInventoryPurchaseSubmissionLinks([{...baseLine,submissionSelectionResolved:true}],candidates).lines[0].submissionLineId,null);
  const multiple = [...candidates,submission('tomato-2','tomato','partially_received',30,5)];
  assert.equal(purchaseEditor.reconcileInventoryPurchaseSubmissionLinks([baseLine],multiple).lines[0].submissionLineId,null);
  const invalidated = purchaseEditor.reconcileInventoryPurchaseSubmissionLinks([{...baseLine,submissionLineId:'tomato'}],[submission('tomato-2','tomato')]);
  assert.equal(invalidated.lines[0].submissionLineId,null);
  assert.equal(invalidated.invalidated,true);
  const mixed = purchaseEditor.reconcileInventoryPurchaseSubmissionLinks([
    {...baseLine,key:'tomato',submissionLineId:'tomato'},
    {...baseLine,key:'bread',itemId:'bread',submissionLineId:'bread'},
    {...baseLine,key:'direct',itemId:'other'},
  ],candidates);
  assert.deepEqual(Array.from(mixed.lines,row=>row.submissionLineId),['tomato','bread',null]);
});

test('compras vinculadas reutilizan líneas, exigen totales y muestran pago y trazabilidad', () => {
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  const cash = readFileSync('src/admin/cash/AdminCashView.tsx', 'utf8');
  const editor = readFileSync('src/admin/inventory/InventoryPurchaseLinesEditor.tsx', 'utf8');
  const repository = readFileSync('src/admin/inventory/inventory.repository.ts', 'utf8');
  const migration = readFileSync('supabase/migrations/202609290021_inventory_linked_purchases.sql', 'utf8');
  assert.match(editor, /\+ Agregar producto/);
  assert.match(editor, /Cantidad base recibida/);
  assert.match(editor, /content_per_package/);
  assert.match(editor, /Aplicar a solicitud pendiente \(opcional\)/);
  assert.match(editor, /Solicitud vinculada/);
  assert.match(editor, /pendiente por aplicar/);
  assert.match(editor, /border-amberGlow\/40 bg-amberGlow/);
  assert.match(editor, /border-emerald-300\/35 bg-emerald-300/);
  assert.match(editor, /pendingSubmissions/);
  assert.match(editor, /onSubmissionNotice/);
  assert.match(view, /pendingSubmissions=\{pendingSubmissions\}/);
  assert.match(cash, /loadInventoryPendingReplenishments/);
  assert.match(cash, /pendingSubmissions=\{pendingSubmissions\}/);
  assert.doesNotMatch(view, /<Field label="Solicitud aprobada \(opcional\)">/);
  assert.match(view, /¿Cómo se pagó esta compra\?/);
  for (const label of ['Caja del local','Fondos del negocio fuera de caja','Dinero de un propietario','Solo registrar inventario / pago pendiente']) assert.match(view,new RegExp(label));
  assert.match(cash,/Registrar productos recibidos en inventario/);
  assert.match(cash,/El total de productos/);
  assert.match(repository,/inventory_purchase_command/);
  assert.match(view,/zafiro-inventory-purchase-pending/);
  assert.match(view,/Reintentar compra/);
  assert.match(migration,/public\.pos_cash_command\(request_id,cash_payload\)/);
  assert.match(migration,/public\.inventory_command\(request_id,receipt_payload\)/);
  assert.match(migration,/request_id uuid not null unique/);
  assert.match(migration,/receipt_id uuid not null unique/);
  assert.match(migration,/expense_movement_id uuid unique/);
  assert.match(migration,/public\.inventory_can_manage\(\)/);
  assert.match(migration,/payment_status in \('paid','pending','legacy_unlinked'\)/);
  assert.match(migration,/r\.expense_movement_id is null then 'legacy_unlinked'/);
  assert.match(view,/Histórico · pago no registrado/);
  assert.match(view,/Sin vínculo financiero histórico/);
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

test('interfaz muestra conversión congelada y permite compra pagada o pendiente', () => {
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  const editor = readFileSync('src/admin/inventory/InventoryPurchaseLinesEditor.tsx','utf8');
  assert.match(editor, /Cantidad realmente recibida/);
  assert.match(editor, /presentación real, su conversión y los costos de toda la entrada quedarán congelados/);
  assert.match(view, /Solo registrar inventario \/ pago pendiente/);
  assert.match(editor, /Unidad base directa/);
  assert.match(editor, /Costo real por presentación/);
  assert.match(view, /Último costo real/);
  assert.match(view, /item\.last_unit_cost/);
  assert.doesNotMatch(view, /Costo promedio rastreado/);
  assert.match(view, /Valor contable rastreado/);
  assert.match(view, /última compra real/);
  assert.match(view, /Solo los marcados para descuento autom.tico generan movimientos de inventario/);
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
  for (const label of ['Buscar existencias','Buscar artículos configurados','Buscar artículo para presentación','Buscar componente','Buscar artículo para reporte']) assert.match(view, new RegExp(label));
  assert.match(readFileSync('src/admin/inventory/InventoryPurchaseLinesEditor.tsx','utf8'), /Buscar artículo para entrada/);
  assert.match(view, /function SearchableInventoryItemSelect[\s\S]*getInventoryItemSearchSelection/);
});

test('crear presentación explica campos faltantes y muestra errores por encima del modal', () => {
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  const dialog = view.slice(view.indexOf('function PresentationDialog'), view.indexOf('function RecipeDialog'));
  assert.match(dialog, /noValidate onSubmit=\{save\}/);
  assert.match(dialog, /Selecciona un artículo válido/);
  assert.match(dialog, /Escribe el nombre de la presentación/);
  assert.match(dialog, /contenido por paquete o envase mayor que cero/);
  assert.match(dialog, /<DialogButtons busy=\{busy\} onClose=\{onClose\} label="Guardar presentación"\/>/);
  assert.doesNotMatch(dialog, /label="Guardar presentación" disabled=/);
  assert.match(view, /top-4 z-\[70\]/);
  assert.match(view, /Cerrar aviso/);
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

test('solicitudes abren en pendientes y filtran estados terminales desde PostgreSQL', () => {
  const view = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  const requests = view.slice(view.indexOf('function RequestsTab'), view.indexOf('function SubmissionLineDetails'));
  const migration = readFileSync('supabase/migrations/202610010022_inventory_pending_submissions_by_kind.sql', 'utf8');
  assert.match(requests, /useState<'pending'\|'all'>\('pending'\)/);
  assert.match(requests, /<Field label="Vista">[\s\S]*?<option value="pending">Pendientes<\/option><option value="all">Todos<\/option>/);
  assert.match(requests, /status==='all'\?\(scope==='pending'\?'pending':null\):\(scope==='pending'\?`pending_\$\{status\}`:status\)/);
  assert.match(requests, /'sent','partially_approved','approved','partially_received'/);
  assert.doesNotMatch(requests.match(/const pendingStatuses=\[[^\]]+\]/)?.[0] ?? '', /draft/);
  assert.match(requests, /scope==='all'\|\|pendingStatuses\.includes\(value\)/);
  assert.match(migration, /requested_status='pending' and \(s\.status in \('sent','partially_approved'\) or \(s\.kind='replenishment' and s\.status in \('approved','partially_received'\)\)\)/);
  assert.match(migration, /requested_status='pending_approved' and s\.kind='replenishment' and s\.status='approved'/);
  assert.match(migration, /order by s\.created_at desc,s\.id desc limit 21/);
});

test('estados de solicitudes reutilizan una pildora visual central con indicador de color', () => {
  const badge = readFileSync('src/admin/inventory/InventoryStatusBadge.tsx', 'utf8');
  const adminView = readFileSync('src/admin/inventory/AdminInventoryView.tsx', 'utf8');
  const areaPanel = readFileSync('src/admin/inventory/AreaInventoryPanel.tsx', 'utf8');
  for (const status of ['draft','sent','partially_approved','approved','partially_received','received','rejected']) {
    assert.match(badge, new RegExp(`${status}:`));
  }
  for (const tone of ['text-mist','text-cyanGlow','text-amber-100','text-emerald-200','text-orange-200','text-emerald-100','text-rose-100']) {
    assert.match(badge, new RegExp(tone));
  }
  assert.match(badge, /rounded-full border/);
  assert.match(badge, /aria-hidden="true"/);
  assert.match(badge, /h-1\.5 w-1\.5 shrink-0 rounded-full bg-current/);
  assert.match(adminView, /<InventoryStatusBadge status=\{entry\.status\}/);
  assert.match(adminView, /<InventorySubmissionStage kind=\{entry\.kind\} status=\{entry\.status\}/);
  assert.match(areaPanel, /<InventoryStatusBadge status=\{submission\.status\}/);
  assert.match(adminView, /Object\.entries\(inventoryStatusLabels\)/);
  for (const stage of ['Por revisar','Por comprar o recibir','Compra completada','Revisado y aplicado']) assert.match(badge,new RegExp(stage));
  assert.match(badge,/kind === 'replenishment'/);
  assert.match(badge,/status === 'sent' \|\| status === 'partially_approved'/);
  assert.match(badge,/absolute inset-y-0 left-0 w-1/);
});

test('Realtime de inventario agrupa eventos, actualiza ambos clientes y limpia suscripciones', async () => {
  const channels=[]; let removals=0;
  const client={
    channel(name){
      const channel={name,handlers:[],on(_type,filter,handler){this.handlers.push({filter,handler});return this;},subscribe(){return this;}};
      channels.push(channel);return channel;
    },
    removeChannel(){removals+=1;return Promise.resolve();},
  };
  const repositoryContext={exports:{},require:(name)=>name.includes('/client')?{getSupabaseClient:()=>client}:{},setTimeout,clearTimeout,URL,Blob};
  vm.runInNewContext(compile('src/admin/inventory/inventory.repository.ts'),repositoryContext);
  const batches={pos:[],inventory:[]};
  const stopPos=repositoryContext.exports.subscribeToInventoryRealtime((kinds)=>batches.pos.push(Array.from(kinds)),5);
  const stopInventory=repositoryContext.exports.subscribeToInventoryRealtime((kinds)=>batches.inventory.push(Array.from(kinds)),5);
  for(const channel of channels){
    const emit=channel.handlers[0].handler;
    emit({new:{event_kind:'movement'}});emit({new:{event_kind:'movement'}});emit({new:{event_kind:'submission'}});
  }
  await new Promise((resolve)=>setTimeout(resolve,20));
  assert.deepEqual(batches,{pos:[['movement','submission']],inventory:[['movement','submission']]});
  stopPos();stopInventory();
  for(const channel of channels)channel.handlers[0].handler({new:{event_kind:'receipt'}});
  await new Promise((resolve)=>setTimeout(resolve,10));
  assert.equal(removals,2);
  assert.deepEqual(batches,{pos:[['movement','submission']],inventory:[['movement','submission']]});
});

test('POS e Inventario refrescan modelos ligeros y operaciones locales sin reemplazar realtime de pedidos', () => {
  const pos=readFileSync('src/admin/AdminPosView.tsx','utf8');
  const admin=readFileSync('src/admin/inventory/AdminInventoryView.tsx','utf8');
  const area=readFileSync('src/admin/inventory/AreaInventoryPanel.tsx','utf8');
  const migration=readFileSync('supabase/migrations/202609290020_inventory_realtime_signal.sql','utf8');
  assert.match(pos,/subscribeToInventoryRealtime\(\(\)=>\{void refreshPosInventoryReadModels\(\);\}\)/);
  assert.match(pos,/subscribeToPosRealtime\(/);
  assert.ok((pos.match(/void refreshPosInventoryReadModels\(\)/g)??[]).length>=4);
  assert.match(pos,/<AreaInventoryPanel area="bar" refreshVersion=\{inventoryRefreshVersion\}/);
  assert.match(admin,/subscribeToInventoryRealtime\(\(kinds\)=>/);
  assert.match(admin,/refreshRef\.current\(true,true\)/);
  assert.match(admin,/refreshSections\(\); await refresh\(true\)/);
  assert.match(admin,/refreshVersion=\{sectionRefreshVersions\.history\}/);
  assert.match(area,/if\(expanded\)void refresh\(true\)/);
  assert.match(migration,/create table public\.inventory_realtime_events/);
  assert.match(migration,/alter publication supabase_realtime add table public\.inventory_realtime_events/);
  assert.doesNotMatch(migration,/unit_cost|tracked_value|quantity_delta/);
});
