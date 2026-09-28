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

  execFileSync(exe('initdb'), ['-D', path.join(dir, 'data'), '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C'], opts);
  execFileSync(exe('pg_ctl'), ['-D', path.join(dir, 'data'), '-l', path.join(dir, 'server.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', 'start'], { ...opts, stdio: 'ignore' });
  try {
    for (const file of ['tests/cash-local-bootstrap.sql', 'supabase/schema.sql', 'supabase/pos-schema.sql', 'supabase/migrations/202609270001_cash_management.sql', 'supabase/migrations/202609270002_sales_business_date.sql', 'supabase/migrations/202609270003_session_financial_report.sql', 'supabase/migrations/202609270004_session_adjustments.sql', 'supabase/migrations/202609270005_inventory.sql']) sql(readFileSync(file, 'utf8'));
    sql(`insert into public.admin_users(email) values ('admin@test.invalid');
      insert into public.staff_profiles(email,full_name,is_active) values ('cashier@test.invalid','Caja',true),('bar@test.invalid','Bar',true),('kitchen@test.invalid','Cocina',true),('waiter@test.invalid','Mesero',true),('inactive@test.invalid','Inactivo',false);
      insert into public.staff_role_assignments(email,role) values ('cashier@test.invalid','cashier'),('bar@test.invalid','bar'),('kitchen@test.invalid','kitchen'),('waiter@test.invalid','waiter'),('inactive@test.invalid','cashier');
      insert into public.menu_items(source_key,legacy_id,slug,hoja_origen,tipo,name,orden) values ('menu-burger',9001,'burger','test','Comida','Hamburguesa',1),('menu-soda',9002,'soda','test','Bebida','Soda',2);`);

    let bread;
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
      command('cashier@test.invalid', { action: 'receive', expense_movement_id: expense, total_cost: 1000, lines: [{ item_id: bread.id, base_quantity: 1 }] });
      fails(login('cashier@test.invalid') + `select public.inventory_command('${randomUUID()}',${quote(JSON.stringify({ action: 'receive', expense_movement_id: expense, total_cost: 1000, lines: [{ item_id: bread.id, base_quantity: 1 }] }))}::jsonb);`, 'duplicate key');
    });

    await t.test('receta se congela al entregar y doble clic descuenta una vez', async () => {
      command('admin@test.invalid', { action: 'save_recipe', menu_item_source_key: 'menu-burger', control_mode: 'partial', components: [{ item_id: bread.id, quantity_base: 1 }] });
      const sessionId = randomUUID(), orderId = randomUUID(), orderItemId = randomUUID();
      sql(login('waiter@test.invalid') + `insert into public.pos_sales_sessions(id,session_label,business_date,opened_by_email) values('${sessionId}','QA','2026-09-27','waiter@test.invalid');
        insert into public.pos_orders(id,sales_session_id,opened_by_email) values('${orderId}','${sessionId}','waiter@test.invalid');
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
      const request = command('kitchen@test.invalid', { action: 'submit', kind: 'replenishment', area: 'kitchen', status: 'sent', notes: 'Faltan panes', lines: [{ item_id: bread.id, requested_quantity: 10 }] });
      assert.equal(sql(`select sum(quantity_delta) from public.inventory_movements where item_id='${bread.id}';`), before);
      const requestLine = sql(`select id from public.inventory_submission_lines where submission_id='${request.id}';`);
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

    await t.test('barra/cocina no ven costos; mesero e inactivo no leen; tablas no admiten escritura directa', () => {
      const kitchen = JSON.parse(sql(login('kitchen@test.invalid') + 'select public.inventory_read();'));
      assert.equal(kitchen.can_manage, false);
      assert.equal(kitchen.receipts.length, 0);
      assert.equal(kitchen.items.length, 1);
      const bar = JSON.parse(sql(login('bar@test.invalid') + 'select public.inventory_read();'));
      assert.equal(bar.items.length, 0);
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
