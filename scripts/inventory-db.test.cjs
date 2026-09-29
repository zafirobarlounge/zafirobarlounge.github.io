// Disposable PostgreSQL cluster only. It never uses the application's Supabase URL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, execFile } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');

const bin = process.env.PGBIN || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/15/bin' : '/usr/lib/postgresql/15/bin');
const exe = (name) => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
const dir = mkdtempSync(path.join(tmpdir(), 'zafiro-inventory-test-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('PG')));
const opts = { encoding: 'utf8', windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] };
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const login = (email) => `set role authenticated; set request.jwt.claims=${quote(JSON.stringify({ email }))};`;

test('PostgreSQL aislado: inventario, permisos, conversiones, POS e idempotencia', async (t) => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const args = ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atq'];
  const sql = (input) => execFileSync(exe('psql'), args, { ...opts, input }).trim();
  const parallel = (input) => new Promise((resolve, reject) => {
    const child = execFile(exe('psql'), args, opts, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    child.stdin.end(input);
  });
  const fails = (input, message) => assert.throws(() => sql(input), (error) => String(error.stderr).includes(message));
  const command = (email, payload, requestId = randomUUID()) => JSON.parse(sql(login(email) + `select public.inventory_command('${requestId}',${quote(JSON.stringify(payload))}::jsonb);`));
  const removeConfig = (email, payload, requestId = randomUUID()) => JSON.parse(sql(login(email) + `select public.inventory_delete_configuration('${requestId}',${quote(JSON.stringify(payload))}::jsonb);`));
  const previewImport = (email, payload) => JSON.parse(sql(login(email) + `select public.inventory_import_preview(${quote(JSON.stringify(payload))}::jsonb);`));
  const commitImport = (email, payload, fingerprint, requestId = randomUUID()) => JSON.parse(sql(login(email) + `select public.inventory_import_commit('${requestId}','${fingerprint}',${quote(JSON.stringify(payload))}::jsonb);`));

  execFileSync(exe('initdb'), ['-D', path.join(dir, 'data'), '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C'], opts);
  execFileSync(exe('pg_ctl'), ['-D', path.join(dir, 'data'), '-l', path.join(dir, 'server.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'], { ...opts, stdio: 'ignore' });
  try {
    for (const file of ['tests/cash-local-bootstrap.sql', 'supabase/schema.sql', 'supabase/pos-schema.sql', 'supabase/migrations/202609270001_cash_management.sql', 'supabase/migrations/202609270002_sales_business_date.sql', 'supabase/migrations/202609270003_session_financial_report.sql', 'supabase/migrations/202609270004_session_adjustments.sql', 'supabase/migrations/202609270005_inventory.sql', 'supabase/migrations/202609280006_inventory_cost_valuation.sql', 'supabase/migrations/202609280007_inventory_initial_import.sql']) sql(readFileSync(file, 'utf8'));
    const legacyItemId = randomUUID(), legacyReceiptA = randomUUID(), legacyReceiptB = randomUUID();
    const historicalItemId = randomUUID(), historicalSubmissionId = randomUUID(), historicalSubmissionLineId = randomUUID(), historicalReceiptId = randomUUID();
    sql(`insert into public.inventory_items(id,name,base_unit,precision_scale,tracking_started_at,created_by,updated_by) values('${legacyItemId}','Compatibilidad costo','unit',0,now(),'legacy@test.invalid','legacy@test.invalid');
      insert into public.inventory_item_valuations(item_id,current_quantity,average_unit_cost,inventory_value) values('${legacyItemId}',7,11,77);
      insert into public.inventory_receipts(id,request_id,total_cost,received_at,received_by) values('${legacyReceiptA}','${randomUUID()}',20,'2026-09-20T18:00:00Z','legacy@test.invalid'),('${legacyReceiptB}','${randomUUID()}',25,'2026-09-21T18:00:00Z','legacy@test.invalid');
      insert into public.inventory_receipt_lines(receipt_id,item_id,base_quantity,unit_cost) values('${legacyReceiptA}','${legacyItemId}',2,10);
      insert into public.inventory_receipt_lines(receipt_id,item_id,base_quantity,unit_cost,base_unit_cost) values('${legacyReceiptB}','${legacyItemId}',2,12.5,12.5);`);
    const compatibilityBefore = {
      valuation: sql(`select row(current_quantity,average_unit_cost,inventory_value)::text from public.inventory_item_valuations where item_id='${legacyItemId}';`),
      receipts: sql(`select count(*) from public.inventory_receipts where id in ('${legacyReceiptA}','${legacyReceiptB}');`),
      lines: sql(`select count(*) from public.inventory_receipt_lines where item_id='${legacyItemId}';`),
      movements: sql(`select count(*) from public.inventory_movements where item_id='${legacyItemId}';`),
    };
    sql(readFileSync('supabase/migrations/202609280008_inventory_last_purchase_cost.sql', 'utf8'));
    sql(`insert into public.inventory_items(id,name,base_unit,precision_scale,tracking_started_at,created_by,updated_by) values('${historicalItemId}','Recepción vinculada anterior','unit',0,now(),'legacy@test.invalid','legacy@test.invalid');
      insert into public.inventory_item_valuations(item_id,current_quantity) values('${historicalItemId}',12);
      insert into public.inventory_submissions(id,request_id,kind,area,status,submitted_at,created_by) values('${historicalSubmissionId}','${randomUUID()}','replenishment','kitchen','received',now(),'legacy@test.invalid');
      insert into public.inventory_submission_lines(id,submission_id,item_id,requested_quantity,approved_quantity,received_quantity) values('${historicalSubmissionLineId}','${historicalSubmissionId}','${historicalItemId}',12,12,12);
      insert into public.inventory_receipts(id,request_id,total_cost,received_at,received_by) values('${historicalReceiptId}','${randomUUID()}',12000,now(),'legacy@test.invalid');
      insert into public.inventory_receipt_lines(receipt_id,item_id,base_quantity,unit_cost,submission_line_id,line_total_cost,base_unit_cost) values('${historicalReceiptId}','${historicalItemId}',12,1000,'${historicalSubmissionLineId}',12000,1000);`);
    sql(readFileSync('supabase/migrations/202609280009_inventory_receipt_request_application.sql', 'utf8'));
    sql(readFileSync('supabase/migrations/202609290010_inventory_history_pagination.sql', 'utf8'));
    sql(readFileSync('supabase/migrations/202609290011_dynamic_inventory_areas.sql', 'utf8'));
    sql(`insert into public.menu_items(source_key,legacy_id,slug,hoja_origen,tipo,name,orden) values ('menu-legacy-recipe',8999,'legacy-recipe','test','Comida','Receta anterior',0);
      insert into public.inventory_menu_tracking(menu_item_source_key,control_mode,updated_by) values('menu-legacy-recipe','complete','legacy@test.invalid');
      insert into public.inventory_menu_recipe_components(menu_item_source_key,item_id,quantity_base,created_by,updated_by) values('menu-legacy-recipe','${legacyItemId}',1,'legacy@test.invalid','legacy@test.invalid');`);
    sql(readFileSync('supabase/migrations/202609290012_inventory_recipe_component_control.sql', 'utf8'));
    sql(readFileSync('supabase/migrations/202609290013_inventory_recipe_cost_quantity.sql', 'utf8'));
    sql(readFileSync('supabase/migrations/202609290014_inventory_pending_submissions_filter.sql', 'utf8'));
    sql(readFileSync('supabase/migrations/202609290015_inventory_item_usage_type.sql', 'utf8'));
    sql(readFileSync('supabase/migrations/202609290016_inventory_safe_configuration_delete.sql', 'utf8'));
    sql(readFileSync('supabase/migrations/202609290017_pos_available_products.sql', 'utf8'));
    sql(`insert into public.admin_users(email) values ('admin@test.invalid');
      insert into public.staff_profiles(email,full_name,is_active) values ('cashier@test.invalid','Caja',true),('bar@test.invalid','Bar',true),('kitchen@test.invalid','Cocina',true),('waiter@test.invalid','Mesero',true),('inactive@test.invalid','Inactivo',false);
      insert into public.staff_role_assignments(email,role) values ('cashier@test.invalid','cashier'),('bar@test.invalid','bar'),('kitchen@test.invalid','kitchen'),('waiter@test.invalid','waiter'),('inactive@test.invalid','cashier');
      insert into public.menu_items(source_key,legacy_id,slug,hoja_origen,tipo,name,orden) values ('menu-burger',9001,'burger','test','Comida','Hamburguesa',1),('menu-soda',9002,'soda','test','Bebida','Soda',2);`);

    let bread;
    let openSessionId;
    await t.test('solo elimina configuración nueva sin relaciones ni historial', () => {
      const area = command('admin@test.invalid',{action:'save_area',code:'temporary',name:'Temporal',active:true});
      const item = command('admin@test.invalid',{action:'save_item',name:'Artículo temporal',base_unit:'unit',precision_scale:0,usage_type:'operational',areas:['temporary']});
      const presentation = command('admin@test.invalid',{action:'save_presentation',item_id:item.id,name:'Paquete temporal',content_per_package:2,content_unit:'unit'});
      fails(login('admin@test.invalid')+`select public.inventory_delete_configuration('${randomUUID()}',${quote(JSON.stringify({action:'delete_item',id:item.id}))}::jsonb);`,'tiene configuración o historial');
      assert.equal(removeConfig('admin@test.invalid',{action:'delete_presentation',id:presentation.id}).id,presentation.id);
      assert.equal(removeConfig('admin@test.invalid',{action:'delete_item',id:item.id}).id,item.id);
      assert.equal(removeConfig('admin@test.invalid',{action:'delete_area',code:area.code}).code,area.code);
      fails(login('cashier@test.invalid')+`select public.inventory_delete_configuration('${randomUUID()}',${quote(JSON.stringify({action:'delete_area',code:'operations'}))}::jsonb);`,'Solo administración');
      fails(login('admin@test.invalid')+`select public.inventory_delete_configuration('${randomUUID()}',${quote(JSON.stringify({action:'delete_area',code:'bar'}))}::jsonb);`,'protegida por el POS');
    });
    await t.test('POS ve productos disponibles aunque estén ocultos de la web', () => {
      sql(`insert into public.menu_items(source_key,legacy_id,slug,hoja_origen,tipo,name,orden,visible,disponible,destacado) values ('menu-private-pos',9010,'private-pos','test','Comida','Poke POS',10,false,true,false);`);
      assert.equal(sql(login('cashier@test.invalid')+`select source_key from public.pos_product_options() where source_key='menu-private-pos';`),'menu-private-pos');
      assert.equal(sql(`select count(*) from public.menu_items_public where source_key='menu-private-pos';`),'0');
      fails(login('outside@test.invalid')+`select * from public.pos_product_options();`,'Acceso denegado al catálogo operativo');
    });
    await t.test('migración conserva historia y recupera el último costo real conocido', () => {
      assert.equal(Number(sql(`select last_unit_cost from public.inventory_item_valuations where item_id='${legacyItemId}';`)), 12.5);
      assert.equal(sql(`select row(current_quantity,average_unit_cost,inventory_value)::text from public.inventory_item_valuations where item_id='${legacyItemId}';`), compatibilityBefore.valuation);
      assert.equal(sql(`select count(*) from public.inventory_receipts where id in ('${legacyReceiptA}','${legacyReceiptB}');`), compatibilityBefore.receipts);
      assert.equal(sql(`select count(*) from public.inventory_receipt_lines where item_id='${legacyItemId}';`), compatibilityBefore.lines);
      assert.equal(sql(`select count(*) from public.inventory_movements where item_id='${legacyItemId}';`), compatibilityBefore.movements);
      assert.equal(Number(sql(`select applied_submission_quantity from public.inventory_receipt_lines where receipt_id='${historicalReceiptId}';`)), 12);
      assert.equal(sql(`select count(*) from public.inventory_receipt_lines where item_id='${legacyItemId}' and applied_submission_quantity is not null;`), '0');
      assert.equal(sql(`select controls_inventory||':'||(quantity_base=1) from public.inventory_menu_recipe_components where menu_item_source_key='menu-legacy-recipe';`), 'true:true');
      assert.equal(sql(`select control_mode from public.inventory_menu_tracking where menu_item_source_key='menu-legacy-recipe';`), 'complete');
      assert.equal(sql(`select usage_type from public.inventory_items where id='${legacyItemId}';`), 'consumable');
    });
    await t.test('consumibles y operativos se separan y las recetas rechazan operativos', () => {
      const operational = command('admin@test.invalid', { action:'save_item',name:'Cuchara de prueba',base_unit:'unit',precision_scale:0,usage_type:'operational',areas:['kitchen'] });
      assert.equal(operational.usage_type, 'operational');
      command('admin@test.invalid', { action:'initial_count',item_id:operational.id,quantity:10,reason:'Conteo operativo' });
      command('cashier@test.invalid', { action:'receive',supplier:'Proveedor',lines:[{ item_id:operational.id,base_quantity:2 }] });
      command('kitchen@test.invalid', { action:'submit',kind:'replenishment',area:'kitchen',status:'sent',lines:[{ item_id:operational.id,requested_quantity:3 }] });
      command('kitchen@test.invalid', { action:'submit',kind:'count',area:'kitchen',status:'sent',lines:[{ item_id:operational.id,observed_quantity:12 }] });
      command('kitchen@test.invalid', { action:'submit',kind:'damage',area:'kitchen',status:'sent',lines:[{ item_id:operational.id,requested_quantity:1,notes:'Rota' }] });
      assert.equal(Number(sql(`select current_quantity from public.inventory_item_valuations where item_id='${operational.id}';`)), 12);
      fails(login('admin@test.invalid')+`select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action:'save_recipe',menu_item_source_key:'menu-burger',components:[{item_id:operational.id,controls_inventory:true,quantity_base:1}] }))}::jsonb);`, 'Las recetas solo admiten articulos consumibles');
      const consumable = command('admin@test.invalid', { action:'save_item',name:'Pan receta tipo',base_unit:'unit',precision_scale:0,usage_type:'consumable',areas:['kitchen'] });
      command('admin@test.invalid', { action:'save_recipe',menu_item_source_key:'menu-burger',components:[{item_id:consumable.id,controls_inventory:true,quantity_base:1}] });
      fails(login('admin@test.invalid')+`select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action:'save_item',id:consumable.id,name:'Pan receta tipo',active:true,usage_type:'operational',minimum_quantity:null,target_quantity:null,areas:['kitchen'] }))}::jsonb);`, 'No puedes cambiar a operativo');
      const consumableRead=JSON.parse(sql(login('cashier@test.invalid')+`select public.inventory_read('consumable',null);`));
      const operationalRead=JSON.parse(sql(login('cashier@test.invalid')+`select public.inventory_read('operational','kitchen');`));
      assert.ok(consumableRead.items.some((item)=>item.id===consumable.id));
      assert.ok(!consumableRead.items.some((item)=>item.id===operational.id));
      assert.deepEqual(operationalRead.items.map((item)=>item.id), [operational.id]);
      assert.equal(JSON.parse(sql(login('bar@test.invalid')+`select public.inventory_read('operational','bar');`)).items.length, 0);
      assert.equal(operationalRead.items[0].last_unit_cost, null);
    });
    await t.test('áreas dinámicas conservan compatibilidad, permisos y límites POS', () => {
      assert.equal(sql(`select string_agg(code||':'||active||':'||operational||':'||system_protected,',' order by code) from public.inventory_areas;`), 'bar:true:true:true,kitchen:true:true:true,operations:true:false:false');
      assert.equal(sql(`select count(*) from public.inventory_submissions where id='${historicalSubmissionId}';`), '1');
      const warehouse = command('admin@test.invalid', { action: 'save_area', code: 'warehouse', name: 'Bodega', active: true });
      assert.equal(warehouse.code, 'warehouse');
      const renamed = command('admin@test.invalid', { action: 'save_area', id: warehouse.id, code: 'ignored', name: 'Bodega principal', active: true });
      assert.equal(renamed.code, 'warehouse');
      assert.equal(renamed.name, 'Bodega principal');
      assert.equal(command('admin@test.invalid', { action: 'save_area', id: warehouse.id, name: 'Bodega principal', active: false }).active, false);
      fails(login('admin@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'save_area', id: sql(`select id from public.inventory_areas where code='bar'`), name: 'Barra', active: false }))}::jsonb);`, 'protegidas del POS');
      fails(login('cashier@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'save_area', code: 'cleaning', name: 'Aseo' }))}::jsonb);`, 'Solo administracion');

      const operationsOnly = command('admin@test.invalid', { action: 'save_item', name: 'Trapero', base_unit: 'unit', precision_scale: 0, areas: ['operations'] });
      const shared = command('admin@test.invalid', { action: 'save_item', name: 'Bolsas compartidas', base_unit: 'unit', precision_scale: 0, areas: ['bar','operations'] });
      const barState = JSON.parse(sql(login('bar@test.invalid') + 'select public.inventory_read();'));
      assert.equal(barState.items.some((item) => item.id === operationsOnly.id), false);
      assert.equal(barState.items.some((item) => item.id === shared.id), true);
      const operationsReport = command('admin@test.invalid', { action: 'submit', kind: 'count', area: 'operations', status: 'sent', lines: [{ item_id: operationsOnly.id, observed_quantity: 0, notes: '' }] });
      assert.equal(operationsReport.area, 'operations');
      fails(login('bar@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'submit', kind: 'count', area: 'operations', status: 'sent', lines: [{ item_id: operationsOnly.id, observed_quantity: 0 }] }))}::jsonb);`, 'Area no autorizada');
      const filtered = JSON.parse(sql(login('admin@test.invalid') + `select public.inventory_submissions_page(null,null,null,null,'operations');`));
      assert.ok(filtered.rows.length >= 1);
      assert.ok(filtered.rows.every((row) => row.area === 'operations'));

      sql(`insert into public.menu_items(source_key,legacy_id,slug,hoja_origen,tipo,name,orden) values ('menu-dynamic-area',9990,'dynamic-area','test','Comida','Prueba área dinámica',99);`);
      fails(login('admin@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'save_recipe', menu_item_source_key: 'menu-dynamic-area', control_mode: 'partial', components: [{ item_id: operationsOnly.id, quantity_base: 1 }] }))}::jsonb);`, 'Barra o Cocina');
      command('admin@test.invalid', { action: 'save_recipe', menu_item_source_key: 'menu-dynamic-area', control_mode: 'partial', components: [{ item_id: shared.id, quantity_base: 1 }] });
      fails(login('admin@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'save_item', id: shared.id, name: 'Bolsas compartidas', base_unit: 'unit', active: true, minimum_quantity: null, target_quantity: null, areas: ['operations'] }))}::jsonb);`, 'receta activa');

      const dynamicPreview = previewImport('admin@test.invalid', { articles: [{ code: 'OPS_JABON', name: 'Jabón', area: 'Operación general', base_unit: 'unit', initial_quantity: null, initial_unit_cost: null, minimum_quantity: null, target_quantity: null, notes: '' }], presentations: [], menu_consumption: [] });
      assert.deepEqual(dynamicPreview.errors, []);
      const unknownPreview = previewImport('admin@test.invalid', { articles: [{ code: 'OPS_X', name: 'X', area: 'Área inexistente', base_unit: 'unit', initial_quantity: null, initial_unit_cost: null, minimum_quantity: null, target_quantity: null, notes: '' }], presentations: [], menu_consumption: [] });
      assert.ok(unknownPreview.errors.some((message) => message.includes('desconocida')));
    });
    await t.test('solo admin configura artículos y varias presentaciones compatibles', () => {
      bread = command('admin@test.invalid', { action: 'save_item', name: 'Pan', base_unit: 'unit', precision_scale: 0, minimum_quantity: 4, target_quantity: 18, areas: ['kitchen'] });
      const p4 = command('admin@test.invalid', { action: 'save_presentation', item_id: bread.id, name: 'Paquete x4', content_per_package: 4, content_unit: 'unit' });
      const p6 = command('admin@test.invalid', { action: 'save_presentation', item_id: bread.id, name: 'Paquete x6', content_per_package: 6, content_unit: 'unit' });
      assert.notEqual(p4.id, p6.id);
      fails(login('cashier@test.invalid') + `select public.inventory_command('${randomUUID()}','{"action":"save_item","name":"X","base_unit":"unit","areas":[]}'::jsonb);`, 'Solo administracion');
      fails(login('admin@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'save_presentation', item_id: bread.id, name: 'Liquido', content_per_package: 1, content_unit: 'milliliter' }))}::jsonb);`, 'no se convierten gramos');
    });

    await t.test('distingue sin conteo de cero e inicia seguimiento auditado', () => {
      let state = JSON.parse(sql(login('cashier@test.invalid') + 'select public.inventory_read();'));
      assert.equal(state.items.find((item) => item.id === bread.id).balance, null);
      command('cashier@test.invalid', { action: 'initial_count', item_id: bread.id, quantity: 0, reason: 'Conteo físico inicial' });
      state = JSON.parse(sql(login('cashier@test.invalid') + 'select public.inventory_read();'));
      assert.equal(Number(state.items.find((item) => item.id === bread.id).balance), 0);
      fails(login('cashier@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'initial_count', item_id: bread.id, quantity: 1 }))}::jsonb);`, 'ya tiene conteo');
    });

    let presentation;
    await t.test('recepción convierte paquetes y conserva snapshot histórico', () => {
      presentation = JSON.parse(sql(login('cashier@test.invalid') + 'select public.inventory_read();')).presentations.find((row) => row.name === 'Paquete x6');
      const receipt = command('cashier@test.invalid', { action: 'receive', supplier: 'Proveedor QA', document_reference: 'F-1', total_cost: 12000, lines: [{ item_id: bread.id, presentation_id: presentation.id, package_quantity: 2, unit_cost: 1000 }] });
      assert.ok(receipt.id);
      command('admin@test.invalid', { action: 'save_presentation', id: presentation.id, item_id: bread.id, name: 'Paquete x6', content_per_package: 8, content_unit: 'unit' });
      const snapshot = JSON.parse(sql(`select row_to_json(l) from public.inventory_receipt_lines l where receipt_id='${receipt.id}';`));
      assert.equal(Number(snapshot.base_quantity), 12);
      assert.equal(Number(snapshot.content_per_package_snapshot), 6);
      assert.equal(snapshot.applied_submission_quantity, null);
      assert.equal(sql(`select sum(quantity_delta) from public.inventory_movements where item_id='${bread.id}';`), '12.000');
      const expense = randomUUID();
      sql(`insert into public.pos_cash_movements(id,kind,concept,category,amount,expense_date,method,origin,created_by) values('${expense}','expense','Compra QA','supplies',1000,'2026-09-27','bank_transfer','business','cashier@test.invalid');`);
      fails(login('cashier@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'receive', expense_movement_id: expense, total_cost: 999, lines: [{ item_id: bread.id, base_quantity: 1 }] }))}::jsonb);`, 'no coincide');
      command('cashier@test.invalid', { action: 'receive', expense_movement_id: expense, total_cost: 1000, lines: [{ item_id: bread.id, base_quantity: 1, line_total_cost: 1000 }] });
      fails(login('cashier@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'receive', expense_movement_id: expense, total_cost: 1000, lines: [{ item_id: bread.id, base_quantity: 1, line_total_cost: 1000 }] }))}::jsonb);`, 'duplicate key');
    });

    await t.test('recepciones aplican hasta el pendiente y conservan completo el ingreso, costo y presentación real', () => {
      const createApprovedRequest = (name) => {
        const requestItem = command('admin@test.invalid', { action: 'save_item', name, base_unit: 'unit', precision_scale: 0, areas: ['kitchen'] });
        command('cashier@test.invalid', { action: 'initial_count', item_id: requestItem.id, quantity: 0, reason: 'Inicio prueba recepción' });
        const submission = command('kitchen@test.invalid', { action: 'submit', kind: 'replenishment', area: 'kitchen', status: 'sent', lines: [{ item_id: requestItem.id, requested_quantity: 12, notes: '' }] });
        const lineId = sql(`select id from public.inventory_submission_lines where submission_id='${submission.id}';`);
        command('cashier@test.invalid', { action: 'review_submission', submission_id: submission.id, status: 'approved', notes: 'Aprobada', lines: [{ line_id: lineId, approved_quantity: 12 }] });
        return { item: requestItem, submissionId: submission.id, lineId };
      };
      const assertRequestReceipt = ({ item, submissionId, lineId }, received, expectedStatus, expectedApplied, expectedPending, extraLine = {}) => {
        const receipt = command('cashier@test.invalid', { action: 'receive', total_cost: extraLine.actual_package_cost ?? null, lines: [{ item_id: item.id, base_quantity: received, submission_line_id: lineId, ...extraLine }] });
        const receiptLine = JSON.parse(sql(`select row_to_json(l) from public.inventory_receipt_lines l where receipt_id='${receipt.id}';`));
        assert.equal(Number(receiptLine.base_quantity), received);
        assert.equal(Number(receiptLine.applied_submission_quantity), expectedApplied);
        assert.equal(Number(sql(`select received_quantity from public.inventory_submission_lines where id='${lineId}';`)), expectedApplied);
        assert.equal(sql(`select status from public.inventory_submissions where id='${submissionId}';`), expectedStatus);
        assert.equal(12 - Number(sql(`select received_quantity from public.inventory_submission_lines where id='${lineId}';`)), expectedPending);
        assert.equal(Number(sql(`select current_quantity from public.inventory_item_valuations where item_id='${item.id}';`)), received);
        assert.equal(sql(`select count(*) from public.inventory_movements where receipt_id='${receipt.id}' and movement_type='purchase_receipt';`), '1');
        return { receipt, receiptLine };
      };

      assertRequestReceipt(createApprovedRequest('Solicitud recibe 8'), 8, 'partially_received', 8, 4);
      assertRequestReceipt(createApprovedRequest('Solicitud recibe 12'), 12, 'received', 12, 0);

      const over = createApprovedRequest('Solicitud x12 recibe x24');
      const requestedPresentation = command('admin@test.invalid', { action: 'save_presentation', item_id: over.item.id, name: 'Paca x12 solicitada', content_per_package: 12, content_unit: 'unit' });
      const actualPresentation = command('admin@test.invalid', { action: 'save_presentation', item_id: over.item.id, name: 'Paca x24 real', content_per_package: 24, content_unit: 'unit' });
      assert.ok(requestedPresentation.id);
      const receipt = command('cashier@test.invalid', { action: 'receive', total_cost: 64000, lines: [{ item_id: over.item.id, presentation_id: actualPresentation.id, package_quantity: 1, actual_package_cost: 64000, submission_line_id: over.lineId }] });
      const overLine = JSON.parse(sql(`select row_to_json(l) from public.inventory_receipt_lines l where receipt_id='${receipt.id}';`));
      assert.equal(Number(overLine.base_quantity), 24);
      assert.equal(Number(overLine.applied_submission_quantity), 12);
      assert.equal(overLine.presentation_name_snapshot, 'Paca x24 real');
      assert.equal(Number(overLine.line_total_cost), 64000);
      assert.ok(Math.abs(Number(overLine.base_unit_cost) - (64000 / 24)) < 0.0000001);
      assert.equal(Number(sql(`select received_quantity from public.inventory_submission_lines where id='${over.lineId}';`)), 12);
      assert.equal(sql(`select status from public.inventory_submissions where id='${over.submissionId}';`), 'received');
      assert.equal(Number(sql(`select current_quantity from public.inventory_item_valuations where item_id='${over.item.id}';`)), 24);
      assert.equal(Number(sql(`select quantity_delta from public.inventory_movements where receipt_id='${receipt.id}';`)), 24);
      assert.equal(sql(`select count(*) from public.inventory_movements where receipt_id='${receipt.id}';`), '1');
      assert.equal(Number(sql(`select (metadata->>'excess_quantity')::numeric from public.inventory_movements where receipt_id='${receipt.id}';`)), 12);

      const invalidReceiptId = randomUUID();
      sql(`insert into public.inventory_receipts(id,request_id,received_at,received_by) values('${invalidReceiptId}','${randomUUID()}',now(),'cashier@test.invalid');`);
      fails(`insert into public.inventory_receipt_lines(receipt_id,item_id,base_quantity,submission_line_id,applied_submission_quantity) values('${invalidReceiptId}','${over.item.id}',1,'${over.lineId}',2);`, 'inventory_receipt_lines_submission_application_check');
      assert.equal(sql(`select count(*) from public.inventory_receipt_lines where receipt_id='${invalidReceiptId}';`), '0');
    });

    await t.test('costos por presentación, snapshots y promedio ponderado móvil', () => {
      const costedBread = command('admin@test.invalid', { action: 'save_item', name: 'Pan valorado', base_unit: 'unit', precision_scale: 0, areas: ['kitchen'] });
      const p6 = command('admin@test.invalid', { action: 'save_presentation', item_id: costedBread.id, name: 'Paquete x6 costo', content_per_package: 6, content_unit: 'unit', suggested_package_cost: 7000 });
      command('cashier@test.invalid', { action: 'initial_count', item_id: costedBread.id, quantity: 10, initial_unit_cost: 1100, reason: 'Conteo conocido' });
      assert.equal(sql(`select last_unit_cost is null from public.inventory_item_valuations where item_id='${costedBread.id}';`), 't');
      const receiptA = command('cashier@test.invalid', { action: 'receive', supplier: 'Compra A', total_cost: 21000, lines: [{ item_id: costedBread.id, presentation_id: p6.id, package_quantity: 3, actual_package_cost: 7000 }] });
      const lineA = JSON.parse(sql(`select row_to_json(l) from public.inventory_receipt_lines l where receipt_id='${receiptA.id}';`));
      assert.equal(Number(lineA.package_quantity), 3);
      assert.equal(Number(lineA.content_per_package_snapshot), 6);
      assert.equal(Number(lineA.base_quantity), 18);
      assert.equal(Number(lineA.actual_package_cost), 7000);
      assert.equal(Number(lineA.line_total_cost), 21000);
      assert.ok(Math.abs(Number(lineA.base_unit_cost) - (7000 / 6)) < 0.0000001);
      let valuation = JSON.parse(sql(`select row_to_json(v) from public.inventory_item_valuations v where item_id='${costedBread.id}';`));
      assert.equal(Number(valuation.current_quantity), 28);
      assert.ok(Math.abs(Number(valuation.average_unit_cost) - (32000 / 28)) < 0.0000001);
      assert.ok(Math.abs(Number(valuation.last_unit_cost) - (7000 / 6)) < 0.0000001);
      assert.equal(Number(valuation.inventory_value), 32000);

      command('admin@test.invalid', { action: 'save_presentation', id: p6.id, item_id: costedBread.id, name: 'Caja modificada', content_per_package: 8, content_unit: 'unit', suggested_package_cost: 7800 });
      const frozen = JSON.parse(sql(`select row_to_json(l) from public.inventory_receipt_lines l where id='${lineA.id}';`));
      assert.equal(frozen.presentation_name_snapshot, 'Paquete x6 costo');
      assert.equal(Number(frozen.content_per_package_snapshot), 6);
      assert.equal(Number(frozen.actual_package_cost), 7000);
      assert.equal(Number(frozen.base_unit_cost), Number(lineA.base_unit_cost));
      command('admin@test.invalid', { action: 'save_presentation', id: p6.id, item_id: costedBread.id, name: 'Paquete x6 costo', content_per_package: 6, content_unit: 'unit', suggested_package_cost: 7800 });
      const receiptB = command('cashier@test.invalid', { action: 'receive', supplier: 'Compra B', total_cost: 7800, lines: [{ item_id: costedBread.id, presentation_id: p6.id, package_quantity: 1, actual_package_cost: 7800 }] });
      assert.equal(Number(sql(`select actual_package_cost from public.inventory_receipt_lines where receipt_id='${receiptA.id}';`)), 7000);
      assert.equal(Number(sql(`select actual_package_cost from public.inventory_receipt_lines where receipt_id='${receiptB.id}';`)), 7800);
      assert.equal(Number(sql(`select base_unit_cost from public.inventory_receipt_lines where receipt_id='${receiptB.id}';`)), 1300);
      assert.equal(Number(sql(`select last_unit_cost from public.inventory_item_valuations where item_id='${costedBread.id}';`)), 1300);
      assert.notEqual(Number(sql(`select average_unit_cost from public.inventory_item_valuations where item_id='${costedBread.id}';`)), 1300);
      command('admin@test.invalid', { action: 'save_presentation', id: p6.id, item_id: costedBread.id, name: 'Paquete x6 costo', content_per_package: 6, content_unit: 'unit', suggested_package_cost: 9000 });
      assert.equal(Number(sql(`select last_unit_cost from public.inventory_item_valuations where item_id='${costedBread.id}';`)), 1300);
      fails(login('cashier@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'receive', total_cost: 1, lines: [{ item_id: costedBread.id, base_quantity: 1, line_total_cost: 2 }] }))}::jsonb);`, 'no coincide');
    });

    await t.test('gramos, costo POS histórico, idempotencia y devolución al costo original', async () => {
      const sauce = command('admin@test.invalid', { action: 'save_item', name: 'Salsa cheddar', base_unit: 'gram', precision_scale: 3, areas: ['kitchen'] });
      const jar = command('admin@test.invalid', { action: 'save_presentation', item_id: sauce.id, name: 'Envase 200 g', content_per_package: 200, content_unit: 'gram', suggested_package_cost: 4990 });
      command('cashier@test.invalid', { action: 'initial_count', item_id: sauce.id, quantity: 0, reason: 'Sin existencias' });
      const sauceReceipt = command('cashier@test.invalid', { action: 'receive', total_cost: 4990, lines: [{ item_id: sauce.id, presentation_id: jar.id, package_quantity: 1, actual_package_cost: 4990 }] });
      assert.equal(Number(sql(`select base_quantity from public.inventory_receipt_lines where receipt_id='${sauceReceipt.id}';`)), 200);
      assert.equal(Number(sql(`select base_unit_cost from public.inventory_receipt_lines where receipt_id='${sauceReceipt.id}';`)), 24.95);
      sql(`insert into public.menu_items(source_key,legacy_id,slug,hoja_origen,tipo,name,orden) values ('menu-costed',9003,'costed','test','Comida','Producto costo',3);`);
      command('admin@test.invalid', { action: 'save_recipe', menu_item_source_key: 'menu-costed', control_mode: 'partial', components: [{ item_id: sauce.id, quantity_base: 15 }] });
      const sessionId = randomUUID(), orderId = randomUUID(), orderItemId = randomUUID();
      openSessionId = sessionId;
      sql(login('waiter@test.invalid') + `insert into public.pos_sales_sessions(id,session_label,business_date,opened_by_email) values('${sessionId}','Costo QA',(now() at time zone 'America/Bogota')::date,'waiter@test.invalid');
        insert into public.pos_orders(id,sales_session_id,opened_by_email) values('${orderId}','${sessionId}','waiter@test.invalid');
        insert into public.pos_order_items(id,order_id,menu_item_source_key,product_name,product_slug,prep_area,quantity,unit_price,total_price,operational_status,ready_at,created_by_email) values('${orderItemId}','${orderId}','menu-costed','Producto costo','costed','kitchen',1,10000,10000,'ready',now(),'waiter@test.invalid');`);
      const deliver = login('waiter@test.invalid') + `select public.inventory_deliver_pos_item('${orderItemId}',false);`;
      await Promise.all([parallel(deliver), parallel(deliver)]);
      assert.equal(sql(`select count(*) from public.inventory_pos_consumptions where pos_order_item_id='${orderItemId}';`), '1');
      assert.equal(sql(`select count(*) from public.inventory_movements where order_item_id='${orderItemId}' and movement_type='pos_consumption';`), '1');
      const consumption = JSON.parse(sql(`select row_to_json(cl) from public.inventory_pos_consumption_lines cl join public.inventory_pos_consumptions c on c.id=cl.consumption_id where c.pos_order_item_id='${orderItemId}';`));
      assert.equal(Number(consumption.average_unit_cost_snapshot), 24.95);
      assert.equal(Number(consumption.last_unit_cost_snapshot), 24.95);
      assert.equal(Number(consumption.tracked_cost), 374.25);
      command('cashier@test.invalid', { action: 'receive', total_cost: 6000, lines: [{ item_id: sauce.id, presentation_id: jar.id, package_quantity: 1, actual_package_cost: 6000 }] });
      assert.equal(Number(sql(`select last_unit_cost from public.inventory_item_valuations where item_id='${sauce.id}';`)), 30);
      assert.equal(Number(sql(`select average_unit_cost_snapshot from public.inventory_pos_consumption_lines where id='${consumption.id}';`)), 24.95);
      assert.equal(Number(sql(`select last_unit_cost_snapshot from public.inventory_pos_consumption_lines where id='${consumption.id}';`)), 24.95);
      assert.equal(Number(sql(`select tracked_cost from public.inventory_pos_consumption_lines where id='${consumption.id}';`)), 374.25);
      const currentRecipe = JSON.parse(sql(login('admin@test.invalid') + 'select public.inventory_read();')).recipes.find((row) => row.menu_item_source_key === 'menu-costed');
      assert.equal(Number(currentRecipe.tracked_component_cost), 450);
      const nextOrderItemId = randomUUID();
      sql(login('waiter@test.invalid') + `insert into public.pos_order_items(id,order_id,menu_item_source_key,product_name,product_slug,prep_area,quantity,unit_price,total_price,operational_status,ready_at,created_by_email) values('${nextOrderItemId}','${orderId}','menu-costed','Producto costo','costed','kitchen',1,10000,10000,'ready',now(),'waiter@test.invalid');`);
      sql(login('waiter@test.invalid') + `select public.inventory_deliver_pos_item('${nextOrderItemId}',false);`);
      const currentConsumption = JSON.parse(sql(`select row_to_json(cl) from public.inventory_pos_consumption_lines cl join public.inventory_pos_consumptions c on c.id=cl.consumption_id where c.pos_order_item_id='${nextOrderItemId}';`));
      assert.equal(Number(currentConsumption.last_unit_cost_snapshot), 30);
      assert.notEqual(Number(currentConsumption.average_unit_cost_snapshot), 30);
      assert.equal(Number(currentConsumption.tracked_cost), 450);
      assert.equal(Number(sql(`select unit_cost_snapshot from public.inventory_movements where order_item_id='${nextOrderItemId}';`)), 30);
      assert.equal(Number(sql(`select tracked_value_delta from public.inventory_movements where order_item_id='${nextOrderItemId}';`)), -450);
      const voidRequest = randomUUID();
      command('cashier@test.invalid', { action: 'correction', item_id: sauce.id, quantity_delta: -500, reason: 'Forzar saldo negativo para probar retorno' });
      const voidPayload = { item_id: orderItemId, reason: 'Devolución recuperable', void_quantity: 1, resolutions: [{ consumption_line_id: consumption.id, returned_quantity: 15, waste_quantity: 0, internal_quantity: 0, client_consumed_quantity: 0 }] };
      sql(login('cashier@test.invalid') + `select public.inventory_void_processed_item('${voidRequest}',${quote(JSON.stringify(voidPayload))}::jsonb);`);
      assert.equal(Number(sql(`select unit_cost_snapshot from public.inventory_movements where operation_key='void:return:${voidRequest}:${consumption.id}';`)), 24.95);
      assert.equal(Number(sql(`select tracked_value_delta from public.inventory_movements where operation_key='void:return:${voidRequest}:${consumption.id}';`)), 374.25);
      assert.equal(Number(sql(`select average_unit_cost from public.inventory_item_valuations where item_id='${sauce.id}';`)), 24.95);
    });

    await t.test('recetas costean componentes medidos y descuentan solo los controlados', async () => {
      const poker = command('admin@test.invalid', { action: 'save_item', name: 'Poker inventario', base_unit: 'unit', precision_scale: 0, areas: ['bar'] });
      const tomato = command('admin@test.invalid', { action: 'save_item', name: 'Tomate medido sin descuento', base_unit: 'gram', precision_scale: 3, areas: ['kitchen'] });
      const lettuce = command('admin@test.invalid', { action: 'save_item', name: 'Lechuga medida sin descuento', base_unit: 'gram', precision_scale: 3, areas: ['kitchen'] });
      const unknown = command('admin@test.invalid', { action: 'save_item', name: 'Ingrediente sin costo', base_unit: 'gram', precision_scale: 3, areas: ['kitchen'] });
      for (const entry of [poker,tomato,lettuce,unknown]) command('cashier@test.invalid', { action: 'initial_count', item_id: entry.id, quantity: 0, reason: 'Inicio receta QA' });
      command('cashier@test.invalid', { action: 'receive', total_cost: 20000, lines: [{ item_id: poker.id, base_quantity: 10, line_total_cost: 20000 }] });
      command('cashier@test.invalid', { action: 'receive', total_cost: 9000, lines: [{ item_id: tomato.id, base_quantity: 1000, line_total_cost: 9000 }] });
      command('cashier@test.invalid', { action: 'receive', total_cost: 12000, lines: [{ item_id: lettuce.id, base_quantity: 1000, line_total_cost: 12000 }] });
      sql(`insert into public.menu_items(source_key,legacy_id,slug,hoja_origen,tipo,name,orden) values
        ('menu-mixed-recipe',9010,'mixed-recipe','test','Comida','Hamburguesa mixta',10),
        ('menu-poker-direct',9011,'poker-direct','test','Bebida','Poker',11),
        ('menu-description-only',9012,'description-only','test','Comida','Producto descriptivo',12);`);

      fails(login('admin@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'save_recipe', menu_item_source_key: 'menu-mixed-recipe', components: [{ item_id: poker.id, controls_inventory: true, quantity_base: null }] }))}::jsonb);`, 'cantidad mayor que cero');
      fails(login('admin@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'save_recipe', menu_item_source_key: 'menu-mixed-recipe', components: [{ item_id: tomato.id, controls_inventory: false, quantity_base: 0 }] }))}::jsonb);`, 'cantidad de receta');
      const operationsOnlyId = sql(`select id from public.inventory_items where name='Trapero';`);
      fails(login('admin@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'save_recipe', menu_item_source_key: 'menu-mixed-recipe', components: [{ item_id: operationsOnlyId, controls_inventory: false, quantity_base: 30 }] }))}::jsonb);`, 'Barra o Cocina');
      fails(`insert into public.inventory_menu_recipe_components(menu_item_source_key,item_id,controls_inventory,quantity_base,created_by,updated_by) values('menu-mixed-recipe','${poker.id}',true,null,'x','x');`, 'inventory_menu_recipe_components_control_quantity_check');
      fails(`insert into public.inventory_menu_recipe_components(menu_item_source_key,item_id,controls_inventory,quantity_base,created_by,updated_by) values('menu-mixed-recipe','${poker.id}',false,0,'x','x');`, 'inventory_menu_recipe_components_control_quantity_check');

      command('admin@test.invalid', { action: 'save_recipe', menu_item_source_key: 'menu-mixed-recipe', components: [
        { item_id: poker.id, controls_inventory: true, quantity_base: 1 },
        { item_id: tomato.id, controls_inventory: false, quantity_base: 30 },
        { item_id: lettuce.id, controls_inventory: false, quantity_base: 15 },
        { item_id: unknown.id, controls_inventory: false, quantity_base: 5 },
      ] });
      const recipeRows = JSON.parse(sql(login('admin@test.invalid') + 'select public.inventory_read();')).recipes.filter((row) => row.menu_item_source_key === 'menu-mixed-recipe');
      assert.equal(recipeRows.length, 4);
      assert.equal(recipeRows.find((row) => row.item_id === poker.id).controls_inventory, true);
      assert.equal(Number(recipeRows.find((row) => row.item_id === poker.id).tracked_component_cost), 2000);
      assert.equal(recipeRows.find((row) => row.item_id === tomato.id).controls_inventory, false);
      assert.equal(Number(recipeRows.find((row) => row.item_id === tomato.id).quantity_base), 30);
      assert.equal(Number(recipeRows.find((row) => row.item_id === tomato.id).tracked_component_cost), 270);
      assert.equal(Number(recipeRows.find((row) => row.item_id === lettuce.id).tracked_component_cost), 180);
      assert.equal(recipeRows.find((row) => row.item_id === unknown.id).tracked_component_cost, null);
      const mixedAlert = JSON.parse(sql(login('admin@test.invalid') + 'select public.inventory_menu_alerts();')).find((row) => row.menu_item_source_key === 'menu-mixed-recipe');
      assert.equal(Number(mixedAlert.controlled_units_available), 10);

      const mixedOrder = randomUUID(), mixedItem = randomUUID();
      sql(login('waiter@test.invalid') + `insert into public.pos_orders(id,sales_session_id,opened_by_email) values('${mixedOrder}','${openSessionId}','waiter@test.invalid');
        insert into public.pos_order_items(id,order_id,menu_item_source_key,product_name,product_slug,prep_area,quantity,unit_price,total_price,operational_status,ready_at,created_by_email) values('${mixedItem}','${mixedOrder}','menu-mixed-recipe','Hamburguesa mixta','mixed-recipe','kitchen',2,10000,20000,'ready',now(),'waiter@test.invalid');`);
      const mixedDelivery = login('waiter@test.invalid') + `select public.inventory_deliver_pos_item('${mixedItem}',false);`;
      await Promise.all([parallel(mixedDelivery), parallel(mixedDelivery)]);
      assert.equal(sql(`select count(*) from public.inventory_pos_consumption_lines cl join public.inventory_pos_consumptions c on c.id=cl.consumption_id where c.pos_order_item_id='${mixedItem}';`), '1');
      assert.equal(sql(`select count(*) from public.inventory_movements where order_item_id='${mixedItem}' and item_id='${poker.id}';`), '1');
      assert.equal(sql(`select quantity_delta from public.inventory_movements where order_item_id='${mixedItem}' and item_id='${poker.id}';`), '-2.000');
      assert.equal(sql(`select count(*) from public.inventory_movements where order_item_id='${mixedItem}' and item_id in ('${tomato.id}','${lettuce.id}','${unknown.id}');`), '0');

      command('admin@test.invalid', { action: 'save_recipe', menu_item_source_key: 'menu-poker-direct', components: [{ item_id: poker.id, controls_inventory: true, quantity_base: 1 }] });
      const pokerOrder = randomUUID(), pokerOrderItem = randomUUID();
      sql(login('waiter@test.invalid') + `insert into public.pos_orders(id,sales_session_id,opened_by_email) values('${pokerOrder}','${openSessionId}','waiter@test.invalid');
        insert into public.pos_order_items(id,order_id,menu_item_source_key,product_name,product_slug,prep_area,quantity,unit_price,total_price,operational_status,ready_at,created_by_email) values('${pokerOrderItem}','${pokerOrder}','menu-poker-direct','Poker','poker-direct','bar',1,5000,5000,'ready',now(),'waiter@test.invalid');`);
      sql(login('waiter@test.invalid') + `select public.inventory_deliver_pos_item('${pokerOrderItem}',false);`);
      assert.equal(sql(`select quantity_delta from public.inventory_movements where order_item_id='${pokerOrderItem}';`), '-1.000');

      command('admin@test.invalid', { action: 'save_recipe', menu_item_source_key: 'menu-description-only', components: [{ item_id: tomato.id, controls_inventory: false, quantity_base: null }] });
      const descriptionRow = JSON.parse(sql(login('admin@test.invalid') + 'select public.inventory_read();')).recipes.find((row) => row.menu_item_source_key === 'menu-description-only');
      assert.equal(descriptionRow.quantity_base, null);
      assert.equal(descriptionRow.tracked_component_cost, null);
      assert.equal(sql(login('admin@test.invalid') + `select count(*) from jsonb_array_elements(public.inventory_menu_alerts()) row where row->>'menu_item_source_key'='menu-description-only';`), '0');
      const descriptiveOrder = randomUUID(), descriptiveOrderItem = randomUUID();
      sql(login('waiter@test.invalid') + `insert into public.pos_orders(id,sales_session_id,opened_by_email) values('${descriptiveOrder}','${openSessionId}','waiter@test.invalid');
        insert into public.pos_order_items(id,order_id,menu_item_source_key,product_name,product_slug,prep_area,quantity,unit_price,total_price,operational_status,ready_at,created_by_email) values('${descriptiveOrderItem}','${descriptiveOrder}','menu-description-only','Producto descriptivo','description-only','kitchen',1,5000,5000,'ready',now(),'waiter@test.invalid');`);
      sql(login('waiter@test.invalid') + `select public.inventory_deliver_pos_item('${descriptiveOrderItem}',false);`);
      assert.equal(sql(`select count(*) from public.inventory_pos_consumption_lines cl join public.inventory_pos_consumptions c on c.id=cl.consumption_id where c.pos_order_item_id='${descriptiveOrderItem}';`), '0');
      assert.equal(sql(`select count(*) from public.inventory_movements where order_item_id='${descriptiveOrderItem}';`), '0');
    });

    await t.test('saldo negativo conserva costo, recepción reinicia promedio y ausencia de costo no inventa cero', () => {
      const item = command('admin@test.invalid', { action: 'save_item', name: 'Negativo QA', base_unit: 'unit', precision_scale: 0, areas: ['bar'] });
      command('cashier@test.invalid', { action: 'initial_count', item_id: item.id, quantity: 1, initial_unit_cost: 500, reason: 'Costo conocido' });
      command('cashier@test.invalid', { action: 'correction', item_id: item.id, quantity_delta: -2, reason: 'Salida con negativo' });
      let valuation = JSON.parse(sql(`select row_to_json(v) from public.inventory_item_valuations v where item_id='${item.id}';`));
      assert.equal(Number(valuation.current_quantity), -1);
      assert.equal(Number(valuation.average_unit_cost), 500);
      assert.equal(Number(valuation.inventory_value), -500);
      command('cashier@test.invalid', { action: 'receive', total_cost: 1800, lines: [{ item_id: item.id, base_quantity: 2, line_total_cost: 1800 }] });
      valuation = JSON.parse(sql(`select row_to_json(v) from public.inventory_item_valuations v where item_id='${item.id}';`));
      assert.equal(Number(valuation.current_quantity), 1);
      assert.equal(Number(valuation.average_unit_cost), 900);
      assert.equal(Number(valuation.inventory_value), 900);
      const unknown = command('admin@test.invalid', { action: 'save_item', name: 'Sin costo QA', base_unit: 'unit', precision_scale: 0, areas: ['bar'] });
      command('cashier@test.invalid', { action: 'initial_count', item_id: unknown.id, quantity: 5, reason: 'Costo desconocido' });
      assert.equal(sql(`select average_unit_cost is null and inventory_value is null from public.inventory_item_valuations where item_id='${unknown.id}';`), 't');
      command('cashier@test.invalid', { action: 'correction', item_id: unknown.id, quantity_delta: -6, reason: 'Salida sin costo conocido' });
      assert.equal(sql(`select average_unit_cost is null from public.inventory_item_valuations where item_id='${unknown.id}';`), 't');
    });

    await t.test('gasto vinculado no duplica ni modifica la valoración', () => {
      const item = command('admin@test.invalid', { action: 'save_item', name: 'Compra vinculada', base_unit: 'unit', precision_scale: 0, areas: ['bar'] });
      command('cashier@test.invalid', { action: 'initial_count', item_id: item.id, quantity: 0, reason: 'Inicio' });
      const expense = randomUUID();
      sql(`insert into public.pos_cash_movements(id,kind,concept,category,amount,expense_date,method,origin,created_by) values('${expense}','expense','Compra vinculada','supplies',300000,'2026-09-27','bank_transfer','business','cashier@test.invalid');`);
      command('cashier@test.invalid', { action: 'receive', expense_movement_id: expense, total_cost: 300000, lines: [{ item_id: item.id, base_quantity: 100, line_total_cost: 300000 }] });
      const before = sql(`select row(current_quantity,average_unit_cost,inventory_value)::text from public.inventory_item_valuations where item_id='${item.id}';`);
      sql(`update public.pos_cash_movements set amount=310000,voided_at=now(),voided_by='admin@test.invalid',void_reason='Prueba independencia' where id='${expense}';`);
      const after = sql(`select row(current_quantity,average_unit_cost,inventory_value)::text from public.inventory_item_valuations where item_id='${item.id}';`);
      assert.equal(after, before);
      assert.equal(Number(sql(`select count(*) from public.inventory_movements where item_id='${item.id}' and movement_type='purchase_receipt';`)), 1);
    });

    await t.test('receta se congela al entregar y doble clic descuenta una vez', async () => {
      command('admin@test.invalid', { action: 'save_recipe', menu_item_source_key: 'menu-burger', control_mode: 'partial', components: [{ item_id: bread.id, quantity_base: 1 }] });
      const sessionId = openSessionId, orderId = randomUUID(), orderItemId = randomUUID();
      sql(login('waiter@test.invalid') + `insert into public.pos_orders(id,sales_session_id,opened_by_email) values('${orderId}','${sessionId}','waiter@test.invalid');
        insert into public.pos_order_items(id,order_id,menu_item_source_key,product_name,product_slug,prep_area,quantity,unit_price,total_price,operational_status,ready_at,created_by_email) values('${orderItemId}','${orderId}','menu-burger','Hamburguesa','burger','kitchen',2,10000,20000,'ready',now(),'waiter@test.invalid');`);
      const statement = login('waiter@test.invalid') + `select public.inventory_deliver_pos_item('${orderItemId}',false);`;
      const results = await Promise.all([parallel(statement), parallel(statement)]);
      assert.equal(results.length, 2);
      assert.equal(sql(`select count(*) from public.inventory_movements where order_item_id='${orderItemId}';`), '1');
      assert.equal(sql(`select quantity_delta from public.inventory_movements where order_item_id='${orderItemId}';`), '-2.000');
      const consumptionLine = sql(`select cl.id from public.inventory_pos_consumption_lines cl join public.inventory_pos_consumptions c on c.id=cl.consumption_id where c.pos_order_item_id='${orderItemId}';`);
      const voidRequest = randomUUID();
      const voidPayload = { item_id: orderItemId, reason: 'Resolución parcial QA', void_quantity: 1, resolutions: [{ consumption_line_id: consumptionLine, returned_quantity: 0.5, waste_quantity: 0.5, internal_quantity: 0, client_consumed_quantity: 0 }] };
      const voidStatement = login('cashier@test.invalid') + `select public.inventory_void_processed_item('${voidRequest}',${quote(JSON.stringify(voidPayload))}::jsonb);`;
      const voidResults = await Promise.all([parallel(voidStatement), parallel(voidStatement)]);
      assert.equal(voidResults[0], voidResults[1]);
      assert.equal(sql(`select count(*) from public.inventory_movements where operation_key like 'void:return:${voidRequest}%';`), '1');
      assert.equal(sql(`select quantity_delta from public.inventory_movements where operation_key like 'void:return:${voidRequest}%';`), '0.500');
      assert.equal(sql(`select (metadata->>'classified_quantity')::numeric from public.inventory_movements where operation_key like 'void:waste:${voidRequest}%';`), '0.5');
      assert.equal(sql(`select tracked_value_delta is null from public.inventory_movements where operation_key like 'void:waste:${voidRequest}%';`), 't');
      const directItem = randomUUID();
      sql(`update public.pos_operational_flow_settings set use_direct_delivery=true where area='bar';
        insert into public.pos_order_items(id,order_id,menu_item_source_key,product_name,product_slug,prep_area,quantity,unit_price,total_price,operational_status,created_by_email) values('${directItem}','${orderId}','menu-soda','Soda','soda','bar',1,1000,1000,'pending_preparation','waiter@test.invalid');`);
      sql(login('waiter@test.invalid') + `select public.inventory_deliver_pos_item('${directItem}',true);`);
      assert.equal(sql(`select operational_status from public.pos_order_items where id='${directItem}';`), 'delivered');
      assert.equal(sql(`select count(*) from public.inventory_movements where order_item_id='${directItem}';`), '0');
      command('admin@test.invalid', { action: 'save_recipe', menu_item_source_key: 'menu-burger', control_mode: 'partial', components: [{ item_id: bread.id, quantity_base: 2 }] });
      assert.equal(sql(`select quantity_per_menu_unit_snapshot from public.inventory_pos_consumption_lines cl join public.inventory_pos_consumptions c on c.id=cl.consumption_id where c.pos_order_item_id='${orderItemId}';`), '1.000');
    });

    await t.test('solicitud no mueve stock, aprobación parcial y conteo reconcilia movimientos posteriores', () => {
      const before = sql(`select sum(quantity_delta) from public.inventory_movements where item_id='${bread.id}';`);
      const snapshotNotes = `zafiro-presentation-v1:${JSON.stringify({ presentation:{ presentation_id:'presentation-qa',presentation_name:'Paquete x4',content_per_package:4,content_unit:'unit',package_quantity:3 },notes:'Faltan panes' })}`;
      const request = command('kitchen@test.invalid', { action: 'submit', kind: 'replenishment', area: 'kitchen', status: 'sent', notes: 'Faltan panes', lines: [{ item_id: bread.id, requested_quantity: 12, notes: snapshotNotes }] });
      assert.equal(sql(`select sum(quantity_delta) from public.inventory_movements where item_id='${bread.id}';`), before);
      const requestLine = sql(`select id from public.inventory_submission_lines where submission_id='${request.id}';`);
      assert.equal(sql(`select requested_quantity from public.inventory_submission_lines where id='${requestLine}';`), '12.000');
      assert.equal(sql(`select notes from public.inventory_submission_lines where id='${requestLine}';`), snapshotNotes);
      command('cashier@test.invalid', { action: 'review_submission', submission_id: request.id, status: 'partially_approved', notes: 'Aprueba 6', lines: [{ line_id: requestLine, approved_quantity: 6 }] });
      command('cashier@test.invalid', { action: 'receive', supplier: 'Parcial QA', lines: [{ item_id: bread.id, base_quantity: 4, submission_line_id: requestLine }] });
      assert.equal(sql(`select status from public.inventory_submissions where id='${request.id}';`), 'partially_received');
      command('cashier@test.invalid', { action: 'receive', supplier: 'Saldo QA', lines: [{ item_id: bread.id, base_quantity: 2, submission_line_id: requestLine }] });
      assert.equal(sql(`select status from public.inventory_submissions where id='${request.id}';`), 'received');
      fails(login('cashier@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'receive', lines: [{ item_id: bread.id, base_quantity: 1, submission_line_id: requestLine }] }))}::jsonb);`, 'no corresponde a una solicitud aprobada');
      const count = command('kitchen@test.invalid', { action: 'submit', kind: 'count', area: 'kitchen', status: 'sent', lines: [{ item_id: bread.id, observed_quantity: 9 }] });
      command('cashier@test.invalid', { action: 'correction', item_id: bread.id, quantity_delta: 1, reason: 'Movimiento posterior al conteo' });
      const countLine = sql(`select id from public.inventory_submission_lines where submission_id='${count.id}';`);
      command('cashier@test.invalid', { action: 'review_submission', submission_id: count.id, status: 'approved', notes: 'Conteo revisado', lines: [{ line_id: countLine, approved_quantity: 9 }] });
      assert.equal(sql(`select sum(quantity_delta) from public.inventory_movements where item_id='${bread.id}';`), '10.000');
    });

    await t.test('recepcion distinta y parcial conserva pendientes por cantidad base', () => {
      const soda = command('admin@test.invalid', { action: 'save_item', name: 'Coca-Cola 400 ml', base_unit: 'unit', precision_scale: 0, areas: ['bar'] });
      const p12 = command('admin@test.invalid', { action: 'save_presentation', item_id: soda.id, name: 'Paca x12', content_per_package: 12, content_unit: 'unit' });
      const p24 = command('admin@test.invalid', { action: 'save_presentation', item_id: soda.id, name: 'Paca x24', content_per_package: 24, content_unit: 'unit' });
      command('cashier@test.invalid', { action: 'initial_count', item_id: soda.id, quantity: 0, reason: 'Inicio QA' });

      const requestNotes = `zafiro-presentation-v1:${JSON.stringify({ presentation:{ presentation_id:p12.id,presentation_name:'Paca x12',content_per_package:12,content_unit:'unit',package_quantity:2 },notes:'Reposicion QA' })}`;
      const movementsBeforeRequest = sql(`select count(*) from public.inventory_movements where item_id='${soda.id}';`);
      const differentPresentationRequest = command('bar@test.invalid', { action: 'submit', kind: 'replenishment', area: 'bar', status: 'sent', lines: [{ item_id: soda.id, requested_quantity: 24, notes: requestNotes }] });
      assert.equal(sql(`select count(*) from public.inventory_movements where item_id='${soda.id}';`), movementsBeforeRequest);
      const differentPresentationLine = sql(`select id from public.inventory_submission_lines where submission_id='${differentPresentationRequest.id}';`);
      command('cashier@test.invalid', { action: 'review_submission', submission_id: differentPresentationRequest.id, status: 'approved', lines: [{ line_id: differentPresentationLine, approved_quantity: 24 }] });
      const differentPresentationReceipt = command('cashier@test.invalid', { action: 'receive', supplier: 'Proveedor x24', lines: [{ item_id: soda.id, presentation_id: p24.id, package_quantity: 1, submission_line_id: differentPresentationLine }] });
      assert.equal(sql(`select presentation_name_snapshot from public.inventory_receipt_lines where receipt_id='${differentPresentationReceipt.id}';`), 'Paca x24');
      assert.equal(sql(`select received_quantity from public.inventory_submission_lines where id='${differentPresentationLine}';`), '24.000');
      assert.equal(sql(`select status from public.inventory_submissions where id='${differentPresentationRequest.id}';`), 'received');

      const partialRequest = command('bar@test.invalid', { action: 'submit', kind: 'replenishment', area: 'bar', status: 'sent', lines: [{ item_id: soda.id, requested_quantity: 24, notes: requestNotes }] });
      const partialLine = sql(`select id from public.inventory_submission_lines where submission_id='${partialRequest.id}';`);
      command('cashier@test.invalid', { action: 'review_submission', submission_id: partialRequest.id, status: 'approved', lines: [{ line_id: partialLine, approved_quantity: 24 }] });
      command('cashier@test.invalid', { action: 'receive', supplier: 'Entrega parcial', lines: [{ item_id: soda.id, presentation_id: p12.id, package_quantity: 1, submission_line_id: partialLine }] });
      assert.equal(sql(`select received_quantity from public.inventory_submission_lines where id='${partialLine}';`), '12.000');
      assert.equal(sql(`select approved_quantity-received_quantity from public.inventory_submission_lines where id='${partialLine}';`), '12.000');
      assert.equal(sql(`select status from public.inventory_submissions where id='${partialRequest.id}';`), 'partially_received');
    });

    await t.test('importación inicial es administrativa, transaccional, idempotente y no inventa movimientos', () => {
      const payload = {
        articles: [{ code:'IMPORT_PAN',name:'Pan importado',area:'kitchen',base_unit:'unit',initial_quantity:null,initial_unit_cost:1200,minimum_quantity:null,target_quantity:null,notes:'QA' }],
        presentations: [{ item_code:'IMPORT_PAN',name:'Paquete x4',content_per_package:4,content_unit:'unit',suggested_package_cost:4800,notes:'' }],
        menu_consumption: [{ menu_item_source_key:'menu-soda',item_code:'IMPORT_PAN',quantity_base:1,unit:'unit',control_mode:'partial' }],
      };
      const firstPreview = previewImport('admin@test.invalid', payload);
      assert.deepEqual(firstPreview.new_articles, ['IMPORT_PAN']);
      assert.equal(firstPreview.initial_count_count, 0);
      assert.equal(firstPreview.errors.length, 0);
      for (const email of ['cashier@test.invalid','bar@test.invalid','kitchen@test.invalid']) {
        fails(login(email) + `select public.inventory_import_preview(${quote(JSON.stringify(payload))}::jsonb);`, 'Solo administraci');
        fails(login(email) + `select public.inventory_import_commit('${randomUUID()}','${'a'.repeat(64)}',${quote(JSON.stringify(payload))}::jsonb);`, 'Solo administraci');
      }
      const requestId = randomUUID(), fingerprint = '1'.repeat(64);
      const before = {
        movements: Number(sql('select count(*) from public.inventory_movements;')),
        receipts: Number(sql('select count(*) from public.inventory_receipts;')),
        expenses: Number(sql('select count(*) from public.pos_cash_movements;')),
        sales: Number(sql('select count(*) from public.pos_order_items;')),
      };
      const result = commitImport('admin@test.invalid', payload, fingerprint, requestId);
      assert.equal(result.created_articles, 1); assert.equal(result.created_presentations, 1); assert.equal(result.created_menu_associations, 1); assert.equal(result.created_initial_counts, 0);
      assert.equal(sql("select tracking_started_at is null from public.inventory_items where import_code='IMPORT_PAN';"), 't');
      assert.equal(Number(sql('select count(*) from public.inventory_movements;')), before.movements);
      assert.equal(Number(sql('select count(*) from public.inventory_receipts;')), before.receipts);
      assert.equal(Number(sql('select count(*) from public.pos_cash_movements;')), before.expenses);
      assert.equal(Number(sql('select count(*) from public.pos_order_items;')), before.sales);
      assert.deepEqual(commitImport('admin@test.invalid', payload, fingerprint, requestId), result);
      assert.deepEqual(commitImport('admin@test.invalid', payload, fingerprint, randomUUID()), result);
      const existingPreview=previewImport('admin@test.invalid',payload);
      assert.deepEqual(existingPreview.existing_articles,['IMPORT_PAN']);
      assert.equal(existingPreview.existing_presentations.length,1);
      assert.deepEqual(existingPreview.existing_menu_products,['menu-soda']);
      assert.equal(sql("select count(*) from public.inventory_items where import_code='IMPORT_PAN';"), '1');
      assert.equal(sql("select count(*) from public.inventory_purchase_presentations p join public.inventory_items i on i.id=p.item_id where i.import_code='IMPORT_PAN';"), '1');

      const articleConflict = structuredClone(payload); articleConflict.articles[0].name = 'Otro nombre';
      assert.ok(previewImport('admin@test.invalid', articleConflict).errors.some((value) => value.includes('Conflicto en artículo')));
      const presentationConflict = structuredClone(payload); presentationConflict.presentations[0].content_per_package = 6;
      assert.ok(previewImport('admin@test.invalid', presentationConflict).errors.some((value) => value.includes('Conflicto en presentación')));
      const recipeConflict = structuredClone(payload); recipeConflict.menu_consumption[0].quantity_base = 2;
      assert.ok(previewImport('admin@test.invalid', recipeConflict).errors.some((value) => value.includes('Conflicto en receta')));

      const invalidUnit = structuredClone(payload); invalidUnit.articles[0].code='IMPORT_QUESO';invalidUnit.articles[0].name='Queso importado';invalidUnit.articles[0].base_unit='gram';invalidUnit.presentations[0].item_code='IMPORT_QUESO';invalidUnit.presentations[0].content_unit='unit';invalidUnit.menu_consumption=[];
      assert.ok(previewImport('admin@test.invalid', invalidUnit).errors.some((value) => value.includes('no se aplican conversiones')));
      const transactional = structuredClone(payload); transactional.articles[0].code='IMPORT_ROLLBACK';transactional.articles[0].name='Debe revertirse';transactional.presentations=[];transactional.menu_consumption[0].item_code='IMPORT_ROLLBACK';transactional.menu_consumption[0].menu_item_source_key='menu-inexistente';
      fails(login('admin@test.invalid') + `select public.inventory_import_commit('${randomUUID()}','${'2'.repeat(64)}',${quote(JSON.stringify(transactional))}::jsonb);`, 'conflictos');
      assert.equal(sql("select count(*) from public.inventory_items where import_code='IMPORT_ROLLBACK';"), '0');

      const counted = { articles:[{code:'IMPORT_CERO',name:'Conteo cero explícito',area:'bar',base_unit:'unit',initial_quantity:0,initial_unit_cost:null,minimum_quantity:null,target_quantity:null,notes:''}],presentations:[],menu_consumption:[] };
      const countResult=commitImport('admin@test.invalid',counted,'3'.repeat(64));
      assert.equal(countResult.created_initial_counts,1);
      assert.equal(sql("select count(*) from public.inventory_movements m join public.inventory_items i on i.id=m.item_id where i.import_code='IMPORT_CERO' and m.movement_type='initial_count';"),'1');
      assert.equal(sql("select current_quantity from public.inventory_item_valuations v join public.inventory_items i on i.id=v.item_id where i.import_code='IMPORT_CERO';"),'0.000');
    });

    await t.test('historiales paginados usan cursores deterministas, filtros PostgreSQL y exportacion completa', () => {
      const pageItem = command('admin@test.invalid', { action: 'save_item', name: 'Articulo paginacion', base_unit: 'unit', precision_scale: 0, areas: ['bar'] });
      const receiptIds = Array.from({ length: 22 }, () => randomUUID());
      sql(receiptIds.map((id) => `insert into public.inventory_receipts(id,request_id,received_at,received_by,notes) values('${id}','${randomUUID()}','2026-09-30T22:00:00Z','cashier@test.invalid','fixture pagination'); insert into public.inventory_receipt_lines(receipt_id,item_id,base_quantity) values('${id}','${pageItem.id}',1);`).join('\n'));
      const firstReceipts = JSON.parse(sql(login('cashier@test.invalid') + 'select public.inventory_receipts_page(null,null);'));
      assert.equal(firstReceipts.rows.length, 20);
      assert.equal(firstReceipts.has_more, true);
      const receiptCursor = firstReceipts.rows.at(-1);
      const secondReceipts = JSON.parse(sql(login('cashier@test.invalid') + `select public.inventory_receipts_page(${quote(receiptCursor.received_at)}::timestamptz,'${receiptCursor.id}');`));
      const pagedReceiptIds = [...firstReceipts.rows, ...secondReceipts.rows].map((row) => row.id);
      assert.equal(new Set(pagedReceiptIds).size, pagedReceiptIds.length);
      assert.ok(receiptIds.every((id) => pagedReceiptIds.includes(id)));

      const rejectedDamageIds = Array.from({ length: 22 }, () => randomUUID());
      const submissionSql = rejectedDamageIds.map((id) => {
        const lineId = randomUUID();
        return `insert into public.inventory_submissions(id,request_id,kind,area,status,created_at,created_by) values('${id}','${randomUUID()}','damage','bar','rejected','2026-09-30T22:30:00Z','bar@test.invalid'); insert into public.inventory_submission_lines(id,submission_id,item_id,observed_quantity,notes) values('${lineId}','${id}','${pageItem.id}',1,'fixture');`;
      });
      const countSubmissionId = randomUUID();
      submissionSql.push(`insert into public.inventory_submissions(id,request_id,kind,area,status,created_at,created_by) values('${countSubmissionId}','${randomUUID()}','count','bar','rejected','2026-09-30T22:31:00Z','bar@test.invalid'); insert into public.inventory_submission_lines(id,submission_id,item_id,observed_quantity,notes) values('${randomUUID()}','${countSubmissionId}','${pageItem.id}',1,'fixture');`);
      const pendingSubmissionId = randomUUID();
      submissionSql.push(`insert into public.inventory_submissions(id,request_id,kind,area,status,created_at,created_by) values('${pendingSubmissionId}','${randomUUID()}','replenishment','bar','sent','2026-09-30T22:32:00Z','bar@test.invalid'); insert into public.inventory_submission_lines(id,submission_id,item_id,requested_quantity,notes) values('${randomUUID()}','${pendingSubmissionId}','${pageItem.id}',1,'fixture pending');`);
      const draftSubmissionId = randomUUID();
      submissionSql.push(`insert into public.inventory_submissions(id,request_id,kind,area,status,created_at,created_by) values('${draftSubmissionId}','${randomUUID()}','replenishment','bar','draft','2026-09-30T22:33:00Z','bar@test.invalid'); insert into public.inventory_submission_lines(id,submission_id,item_id,requested_quantity,notes) values('${randomUUID()}','${draftSubmissionId}','${pageItem.id}',1,'fixture draft');`);
      sql(submissionSql.join('\n'));
      const firstSubmissions = JSON.parse(sql(login('cashier@test.invalid') + "select public.inventory_submissions_page('damage','rejected',null,null);"));
      assert.equal(firstSubmissions.rows.length, 20);
      assert.ok(firstSubmissions.rows.every((row) => row.kind === 'damage' && row.status === 'rejected'));
      const submissionCursor = firstSubmissions.rows.at(-1);
      const secondSubmissions = JSON.parse(sql(login('cashier@test.invalid') + `select public.inventory_submissions_page('damage','rejected',${quote(submissionCursor.created_at)}::timestamptz,'${submissionCursor.id}');`));
      const pagedSubmissionIds = [...firstSubmissions.rows, ...secondSubmissions.rows].map((row) => row.id);
      assert.equal(new Set(pagedSubmissionIds).size, pagedSubmissionIds.length);
      assert.ok(rejectedDamageIds.every((id) => pagedSubmissionIds.includes(id)));
      const countFiltered = JSON.parse(sql(login('cashier@test.invalid') + "select public.inventory_submissions_page('count','rejected',null,null);"));
      assert.ok(countFiltered.rows.some((row) => row.id === countSubmissionId));
      assert.ok(countFiltered.rows.every((row) => row.kind === 'count' && row.status === 'rejected'));
      const pendingFiltered = JSON.parse(sql(login('cashier@test.invalid') + "select public.inventory_submissions_page(null,'pending',null,null);"));
      assert.ok(pendingFiltered.rows.some((row) => row.id === pendingSubmissionId));
      assert.ok(pendingFiltered.rows.every((row) => ['sent','partially_approved','approved','partially_received'].includes(row.status)));
      assert.ok(!pendingFiltered.rows.some((row) => rejectedDamageIds.includes(row.id) || row.id === countSubmissionId || row.id === draftSubmissionId));
      const allFiltered = JSON.parse(sql(login('cashier@test.invalid') + 'select public.inventory_submissions_page(null,null,null,null);'));
      assert.ok(allFiltered.rows.some((row) => row.id === draftSubmissionId));
      const recentBar = JSON.parse(sql(login('bar@test.invalid') + "select public.inventory_recent_submissions('bar');"));
      assert.equal(recentBar.length, 8);
      assert.ok(recentBar.every((row) => row.area === 'bar'));

      const septemberMovementIds = Array.from({ length: 55 }, () => randomUUID());
      const octoberMovementId = randomUUID();
      sql(septemberMovementIds.map((id, index) => `insert into public.inventory_movements(id,operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,occurred_at,metadata) values('${id}','pagination-september-${index}','${pageItem.id}','correction',1,'unit','fixture pagination','admin@test.invalid','2026-09-30T23:00:00Z',jsonb_build_object('actual_package_cost',999,'safe_note','visible'));`).join('\n') + `\ninsert into public.inventory_movements(id,operation_key,item_id,movement_type,quantity_delta,base_unit_snapshot,reason,actor,occurred_at) values('${octoberMovementId}','pagination-october','${pageItem.id}','correction',1,'unit','fixture october','admin@test.invalid','2026-10-01T05:00:00Z');`);
      const firstMovements = JSON.parse(sql(login('cashier@test.invalid') + "select public.inventory_movements_page('2026-09-01',null,null);"));
      assert.equal(firstMovements.rows.length, 50);
      assert.equal(firstMovements.has_more, true);
      const movementCursor = firstMovements.rows.at(-1);
      const secondMovements = JSON.parse(sql(login('cashier@test.invalid') + `select public.inventory_movements_page('2026-09-01',${quote(movementCursor.occurred_at)}::timestamptz,'${movementCursor.id}');`));
      const pagedMovementIds = [...firstMovements.rows, ...secondMovements.rows].map((row) => row.id);
      assert.equal(new Set(pagedMovementIds).size, pagedMovementIds.length);
      assert.ok(septemberMovementIds.every((id) => pagedMovementIds.includes(id)));
      assert.ok(!pagedMovementIds.includes(octoberMovementId));
      const october = JSON.parse(sql(login('cashier@test.invalid') + "select public.inventory_movements_page('2026-10-01',null,null);"));
      assert.ok(october.rows.some((row) => row.id === octoberMovementId));
      const exportRows = JSON.parse(sql(login('cashier@test.invalid') + "select public.inventory_movements_export('2026-09-01');"));
      assert.ok(exportRows.length > 50);
      assert.ok(septemberMovementIds.every((id) => exportRows.some((row) => row.id === id)));
      assert.ok(!exportRows.some((row) => row.id === octoberMovementId));
      const currentState = JSON.parse(sql(login('cashier@test.invalid') + 'select public.inventory_read();'));
      assert.deepEqual(currentState.receipts, []);
      assert.deepEqual(currentState.submissions, []);
      assert.deepEqual(currentState.movements, []);
      assert.equal(typeof currentState.pending_review_count, 'number');
    });

    await t.test('barra/cocina no ven costos; mesero e inactivo no leen; tablas no admiten escritura directa', () => {
      const kitchen = JSON.parse(sql(login('kitchen@test.invalid') + 'select public.inventory_read();'));
      assert.equal(kitchen.can_manage, false);
      assert.equal(kitchen.receipts.length, 0);
      assert.ok(kitchen.items.length >= 1);
      assert.ok(kitchen.items.every((item) => item.areas.includes('kitchen')));
      assert.ok(kitchen.items.every((item) => item.last_unit_cost == null && item.average_unit_cost == null && item.inventory_value == null));
      const bar = JSON.parse(sql(login('bar@test.invalid') + 'select public.inventory_read();'));
      assert.ok(bar.items.length >= 1);
      assert.ok(bar.items.every((item) => item.areas.includes('bar')));
      assert.ok(bar.items.every((item) => item.last_unit_cost == null && item.average_unit_cost == null && item.inventory_value == null));
      const barMovements = JSON.parse(sql(login('bar@test.invalid') + "select public.inventory_movements_page('2026-09-01',null,null);"));
      assert.ok(barMovements.rows.length > 0);
      assert.ok(barMovements.rows.every((row) => row.unit_cost_snapshot == null && row.tracked_value_delta == null && row.average_unit_cost_after == null && row.inventory_value_after == null));
      assert.ok(barMovements.rows.every((row) => row.metadata?.actual_package_cost == null));
      assert.ok(barMovements.rows.some((row) => row.metadata?.safe_note === 'visible'));
      assert.ok(barMovements.rows.every((row) => bar.items.some((item) => item.id === row.item_id)));
      fails(login('kitchen@test.invalid') + "select public.inventory_recent_submissions('bar');", 'Area no autorizada');
      fails(login('bar@test.invalid') + 'select public.inventory_receipts_page(null,null);', 'Acceso denegado a entradas');
      for (const email of ['waiter@test.invalid', 'inactive@test.invalid']) fails(login(email) + 'select public.inventory_read();', 'Acceso denegado');
      for (const email of ['waiter@test.invalid', 'inactive@test.invalid']) fails(login(email) + "select public.inventory_movements_page('2026-09-01',null,null);", 'Acceso denegado al historial');
      fails(login('cashier@test.invalid') + `update public.inventory_items set name='Alterado';`, 'permission denied');
      fails(login('cashier@test.invalid') + `update public.inventory_areas set active=false;`, 'permission denied');
      fails(`update public.inventory_movements set reason='Alterado';`, 'inmutable');
    });

    await t.test('ventas históricas quedan intactas y productos sin receta no bloquean', () => {
      const oldOrder = randomUUID(), oldItem = randomUUID();
      sql(login('admin@test.invalid') + `insert into public.pos_orders(id,opened_by_email,closed_at) values('${oldOrder}','waiter@test.invalid',now());
        insert into public.pos_order_items(id,order_id,menu_item_source_key,product_name,product_slug,prep_area,quantity,unit_price,total_price,operational_status,delivered_at,created_by_email) values('${oldItem}','${oldOrder}','menu-soda','Soda','soda','bar',1,1000,1000,'delivered',now(),'waiter@test.invalid');`);
      assert.equal(sql(`select count(*) from public.inventory_pos_consumptions where pos_order_item_id='${oldItem}';`), '0');
      assert.equal(sql(`select count(*) from public.inventory_movements where order_item_id='${oldItem}';`), '0');
    });
  } finally {
    execFileSync(exe('pg_ctl'), ['-D', path.join(dir, 'data'), '-m', 'immediate', '-w', 'stop'], { ...opts, stdio: 'ignore' });
  }
});
