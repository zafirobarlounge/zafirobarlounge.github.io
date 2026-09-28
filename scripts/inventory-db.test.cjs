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
  const previewImport = (email, payload) => JSON.parse(sql(login(email) + `select public.inventory_import_preview(${quote(JSON.stringify(payload))}::jsonb);`));
  const commitImport = (email, payload, fingerprint, requestId = randomUUID()) => JSON.parse(sql(login(email) + `select public.inventory_import_commit('${requestId}','${fingerprint}',${quote(JSON.stringify(payload))}::jsonb);`));

  execFileSync(exe('initdb'), ['-D', path.join(dir, 'data'), '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C'], opts);
  execFileSync(exe('pg_ctl'), ['-D', path.join(dir, 'data'), '-l', path.join(dir, 'server.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'], { ...opts, stdio: 'ignore' });
  try {
    for (const file of ['tests/cash-local-bootstrap.sql', 'supabase/schema.sql', 'supabase/pos-schema.sql', 'supabase/migrations/202609270001_cash_management.sql', 'supabase/migrations/202609270002_sales_business_date.sql', 'supabase/migrations/202609270003_session_financial_report.sql', 'supabase/migrations/202609270004_session_adjustments.sql', 'supabase/migrations/202609270005_inventory.sql', 'supabase/migrations/202609280006_inventory_cost_valuation.sql', 'supabase/migrations/202609280007_inventory_initial_import.sql']) sql(readFileSync(file, 'utf8'));
    const legacyItemId = randomUUID(), legacyReceiptA = randomUUID(), legacyReceiptB = randomUUID();
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
    sql(`insert into public.admin_users(email) values ('admin@test.invalid');
      insert into public.staff_profiles(email,full_name,is_active) values ('cashier@test.invalid','Caja',true),('bar@test.invalid','Bar',true),('kitchen@test.invalid','Cocina',true),('waiter@test.invalid','Mesero',true),('inactive@test.invalid','Inactivo',false);
      insert into public.staff_role_assignments(email,role) values ('cashier@test.invalid','cashier'),('bar@test.invalid','bar'),('kitchen@test.invalid','kitchen'),('waiter@test.invalid','waiter'),('inactive@test.invalid','cashier');
      insert into public.menu_items(source_key,legacy_id,slug,hoja_origen,tipo,name,orden) values ('menu-burger',9001,'burger','test','Comida','Hamburguesa',1),('menu-soda',9002,'soda','test','Bebida','Soda',2);`);

    let bread;
    let openSessionId;
    await t.test('migración conserva historia y recupera el último costo real conocido', () => {
      assert.equal(Number(sql(`select last_unit_cost from public.inventory_item_valuations where item_id='${legacyItemId}';`)), 12.5);
      assert.equal(sql(`select row(current_quantity,average_unit_cost,inventory_value)::text from public.inventory_item_valuations where item_id='${legacyItemId}';`), compatibilityBefore.valuation);
      assert.equal(sql(`select count(*) from public.inventory_receipts where id in ('${legacyReceiptA}','${legacyReceiptB}');`), compatibilityBefore.receipts);
      assert.equal(sql(`select count(*) from public.inventory_receipt_lines where item_id='${legacyItemId}';`), compatibilityBefore.lines);
      assert.equal(sql(`select count(*) from public.inventory_movements where item_id='${legacyItemId}';`), compatibilityBefore.movements);
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
      assert.equal(sql(`select sum(quantity_delta) from public.inventory_movements where item_id='${bread.id}';`), '12.000');
      const expense = randomUUID();
      sql(`insert into public.pos_cash_movements(id,kind,concept,category,amount,expense_date,method,origin,created_by) values('${expense}','expense','Compra QA','supplies',1000,'2026-09-27','bank_transfer','business','cashier@test.invalid');`);
      fails(login('cashier@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'receive', expense_movement_id: expense, total_cost: 999, lines: [{ item_id: bread.id, base_quantity: 1 }] }))}::jsonb);`, 'no coincide');
      command('cashier@test.invalid', { action: 'receive', expense_movement_id: expense, total_cost: 1000, lines: [{ item_id: bread.id, base_quantity: 1, line_total_cost: 1000 }] });
      fails(login('cashier@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'receive', expense_movement_id: expense, total_cost: 1000, lines: [{ item_id: bread.id, base_quantity: 1, line_total_cost: 1000 }] }))}::jsonb);`, 'duplicate key');
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
      sql(login('waiter@test.invalid') + `insert into public.pos_sales_sessions(id,session_label,business_date,opened_by_email) values('${sessionId}','Costo QA','2026-09-27','waiter@test.invalid');
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
      fails(login('cashier@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'receive', lines: [{ item_id: bread.id, base_quantity: 1, submission_line_id: requestLine }] }))}::jsonb);`, 'supera la cantidad aprobada');
      const count = command('kitchen@test.invalid', { action: 'submit', kind: 'count', area: 'kitchen', status: 'sent', lines: [{ item_id: bread.id, observed_quantity: 9 }] });
      command('cashier@test.invalid', { action: 'correction', item_id: bread.id, quantity_delta: 1, reason: 'Movimiento posterior al conteo' });
      const countLine = sql(`select id from public.inventory_submission_lines where submission_id='${count.id}';`);
      command('cashier@test.invalid', { action: 'review_submission', submission_id: count.id, status: 'approved', notes: 'Conteo revisado', lines: [{ line_id: countLine, approved_quantity: 9 }] });
      assert.equal(sql(`select sum(quantity_delta) from public.inventory_movements where item_id='${bread.id}';`), '10.000');
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
      for (const email of ['waiter@test.invalid', 'inactive@test.invalid']) fails(login(email) + 'select public.inventory_read();', 'Acceso denegado');
      fails(login('cashier@test.invalid') + `update public.inventory_items set name='Alterado';`, 'permission denied');
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
