// This runner creates its own disposable cluster. It cannot accept a database URL.
// It never connects to the application's Supabase or an existing PostgreSQL instance.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, execFile } = require("node:child_process");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const net = require("node:net");
const bin =
  process.env.PGBIN ||
  (process.platform === "win32"
    ? "C:/Program Files/PostgreSQL/15/bin"
    : "/usr/lib/postgresql/15/bin");
const exe = (name) =>
  path.join(bin, name + (process.platform === "win32" ? ".exe" : ""));
const dir = mkdtempSync(path.join(tmpdir(), "zafiro-cash-test-"));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.toUpperCase().startsWith("PG"),
  ),
);
const opts = {
  encoding: "utf8",
  windowsHide: true,
  env,
  stdio: ["pipe", "pipe", "pipe"],
};
const quote = (s) => "'" + String(s).replaceAll("'", "''") + "'";
const login = (email = "cashier@test.invalid") =>
  `set role authenticated; set request.jwt.claims=${quote(JSON.stringify({ email }))};`;
test("PostgreSQL aislado: finanzas, transiciones, RLS, protección histórica y concurrencia", async (t) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const args = [
    "-X",
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-Atq",
  ];
  const sql = (input) =>
    execFileSync(exe("psql"), args, { ...opts, input }).trim();
  const parallel = (input) =>
    new Promise((resolve, reject) => {
      const child = execFile(exe("psql"), args, opts, (error, stdout) =>
        error ? reject(error) : resolve(stdout.trim()),
      );
      child.stdin.end(input);
    });
  const rpc = (payload, id = randomUUID()) =>
    `select public.pos_cash_command('${id}',${quote(JSON.stringify(payload))}::jsonb);`;
  const command = (payload, id, email) =>
    JSON.parse(sql(login(email) + rpc(payload, id)));
  const fails = (input, text) =>
    assert.throws(
      () => sql(input),
      (error) => String(error.stderr).includes(text),
    );
  let sid;
  execFileSync(
    exe("initdb"),
    [
      "-D",
      path.join(dir, "data"),
      "-U",
      "postgres",
      "-A",
      "trust",
      "--encoding=UTF8",
      "--locale=C",
    ],
    opts,
  );
  execFileSync(
    exe("pg_ctl"),
    [
      "-D",
      path.join(dir, "data"),
      "-l",
      path.join(dir, "server.log"),
      "-o",
      `-h 127.0.0.1 -p ${port}`,
      "-w",
      "start",
    ],
    { ...opts, stdio: "ignore" },
  );
  try {
    for (const file of [
      "tests/cash-local-bootstrap.sql",
      "supabase/schema.sql",
      "supabase/pos-schema.sql",
    ])
      sql(readFileSync(file, "utf8"));
    const legacy = randomUUID();
    sql(
      `insert into public.pos_sales_sessions(id,session_label,business_date,status,opened_by_email,closed_at) values('${legacy}','Histórica','2020-01-01','closed','legacy@test.invalid',now());`,
    );
    const before = sql(
      `select row_to_json(s) from public.pos_sales_sessions s where id='${legacy}';`,
    );
    sql(
      readFileSync(
        "supabase/migrations/202609270001_cash_management.sql",
        "utf8",
      ),
    );
    sql(`insert into public.staff_profiles(email,full_name) values ('cashier@test.invalid','Caja'),('waiter@test.invalid','Mesero'),('kitchen@test.invalid','Cocina'),('bar@test.invalid','Bar');
      insert into public.staff_role_assignments(email,role) values ('cashier@test.invalid','cashier'),('waiter@test.invalid','waiter'),('kitchen@test.invalid','kitchen'),('bar@test.invalid','bar');
      insert into public.admin_users(email) values ('admin@test.invalid');`);
    const existing26 = randomUUID();
    sql(
      `insert into public.pos_sales_sessions(id,session_label,business_date,opened_at,opened_by_email) values('${existing26}','Jornada 2026-09-26','2026-09-26','2026-09-26T23:00:00-05:00','legacy@test.invalid');`,
    );
    const beforeIncrement = sql(
      "select jsonb_agg(s order by id) from public.pos_sales_sessions s;",
    );
    sql(
      readFileSync(
        "supabase/migrations/202609270002_sales_business_date.sql",
        "utf8",
      ),
    );
    await t.test(
      "incremental conserva todos los registros, incluida la jornada abierta del 26 con corte 18",
      () => {
        assert.equal(
          sql(
            "select jsonb_agg(s order by id) from public.pos_sales_sessions s;",
          ),
          beforeIncrement,
        );
        const reused = JSON.parse(
          sql(
            login("waiter@test.invalid") +
              "select public.pos_cash_ensure_session();",
          ),
        );
        assert.equal(reused.id, existing26);
        assert.equal(reused.business_date, "2026-09-26");
        assert.equal(reused.cutoff_hour, 18);
      },
    );
    await t.test(
      "regla SQL Bogotá a las 11, 16, 17, 01, 05:59 y 06:00 y validación manual",
      () => {
        for (const [instant, day] of [
          ["2026-09-27 11:00", "2026-09-27"],
          ["2026-09-27 16:00", "2026-09-27"],
          ["2026-09-27 17:00", "2026-09-27"],
          ["2026-09-28 01:00", "2026-09-27"],
          ["2026-09-28 05:59", "2026-09-27"],
          ["2026-09-28 06:00", "2026-09-28"],
        ])
          assert.equal(
            sql(
              `select public.pos_sales_business_date('${instant}-05'::timestamptz);`,
            ),
            day,
          );
        for (const day of ["2026-09-27", "2026-09-28"])
          assert.equal(
            sql(
              `select public.pos_validate_operational_date('${day}','2026-09-28 01:00-05');`,
            ),
            day,
          );
        for (const day of ["2026-09-26", "2026-09-29"])
          fails(
            `select public.pos_validate_operational_date('${day}','2026-09-28 01:00-05');`,
            "hoy o ayer",
          );
      },
    );
    await t.test(
      "migración conserva jornada histórica sin inventar arqueo",
      () => {
        assert.equal(
          sql(
            `select row_to_json(s) from public.pos_sales_sessions s where id='${legacy}';`,
          ),
          before,
        );
        assert.equal(
          sql(`select count(*) from public.pos_cash_registers;`),
          "0",
        );
        const data = JSON.parse(
          sql(login() + "select public.pos_cash_read();"),
        );
        assert.equal(data.sessions[0].components.opening, null);
      },
    );
    await t.test(
      "dos aperturas simultáneas con mismo UUID producen una sola base",
      async () => {
        const payload = { action: "open", amount: 100000 };
        const id = randomUUID();
        const results = await Promise.all([
          parallel(login() + rpc(payload, id)),
          parallel(login() + rpc(payload, id)),
        ]);
        assert.equal(results[0], results[1]);
        sid = JSON.parse(results[0]).sales_session_id;
        assert.equal(
          sql("select count(*) from public.pos_cash_registers;"),
          "1",
        );
        fails(login() + rpc(payload), "ya está registrada");
        fails(login() + rpc({ ...payload, amount: 1 }, id), "otros datos");
      },
    );
    const order = randomUUID();
    const payment = randomUUID();
    const item = randomUUID();
    sql(`insert into public.pos_orders(id,sales_session_id,opened_by_email,closed_at,financial_status) values('${order}','${sid}','cashier@test.invalid',now(),'paid_total');
      insert into public.pos_order_items(id,order_id,product_name,product_slug,prep_area,quantity,unit_price,total_price,created_by_email,operational_status,financial_status) values('${item}','${order}','Test','test','bar',1,500000,500000,'cashier@test.invalid','delivered','paid_total');
      insert into public.pos_payments(id,order_id,sales_session_id,method,status,allocation_mode,amount_applied,amount_received,change_due,created_by_email) values('${payment}','${order}','${sid}','cash','confirmed','amount',40000,50000,10000,'cashier@test.invalid');
      insert into public.pos_payments(order_id,sales_session_id,method,status,allocation_mode,amount_applied,created_by_email) values('${order}','${sid}','cash','confirmed','amount',460000,'cashier@test.invalid'),('${order}','${sid}','bank_transfer','confirmed','amount',99999,'cashier@test.invalid');`);
    const movement = (extra = {}) => ({
      action: "movement",
      session: sid,
      kind: "expense",
      concept: "Chef",
      category: "personal",
      amount: 160000,
      date: "2026-09-27",
      method: "cash",
      origin: "register",
      ...extra,
    });
    let expense;
    await t.test(
      "neto aplicado, transferencia, gasto desde caja y gasto propietario",
      () => {
        expense = command(movement());
        command(
          movement({ origin: "owner", amount: 20000, category: "supplies" }),
        );
        command(
          movement({
            origin: "business",
            method: "bank_transfer",
            amount: 30000,
          }),
        );
        const c = JSON.parse(
          sql(login() + "select public.pos_cash_read();"),
        ).sessions.find((s) => s.id === sid).components;
        assert.equal(c.cash, 500000);
        assert.equal(c.expenses, 160000);
        assert.equal(c.opening + c.cash - c.expenses, 440000);
        fails(
          login() + rpc(movement({ method: "bank_transfer" })),
          "check constraint",
        );
        for (const amount of [-1, 0, 1.001, "NaN", "Infinity"])
          fails(
            login() + rpc(movement({ amount })),
            amount === 0 ? "check constraint" : "Importe inválido",
          );
      },
    );
    await t.test(
      "RLS y RPC niegan acceso financiero a mesero/cocina/bar y escritura directa a caja",
      () => {
        for (const role of ["waiter", "kitchen", "bar"]) {
          fails(
            login(`${role}@test.invalid`) + "select public.pos_cash_read();",
            "Acceso denegado",
          );
          fails(
            login(`${role}@test.invalid`) + rpc(movement()),
            "Acceso denegado",
          );
          assert.equal(
            sql(
              login(`${role}@test.invalid`) +
                "select count(*) from public.pos_cash_movements;",
            ),
            "0",
          );
        }
        fails(
          login() + `update public.pos_cash_registers set opening_amount=0;`,
          "permission denied",
        );
        fails(
          login() +
            rpc({ action: "void", movement: expense.id, reason: "Prueba" }),
          "Solo superadmin",
        );
        fails(
          login() +
            `update public.pos_sales_sessions set status='closed' where id='${sid}';`,
          "Caja y gastos",
        );
      },
    );
    await t.test(
      "aportes y retiros independientes; anulación conserva original y excluye total",
      () => {
        const contribution = command(
          movement({ kind: "contribution", category: null, amount: 50000 }),
        );
        const withdrawal = command(
          movement({ kind: "withdrawal", category: null, amount: 30000 }),
        );
        let c = JSON.parse(
          sql(login() + "select public.pos_cash_read();"),
        ).sessions.find((s) => s.id === sid).components;
        assert.equal(c.contributions, 50000);
        assert.equal(c.withdrawals, 30000);
        for (const row of [contribution, withdrawal])
          command(
            {
              action: "void",
              movement: row.id,
              reason: "Corrección de prueba",
            },
            undefined,
            "admin@test.invalid",
          );
        c = JSON.parse(
          sql(login() + "select public.pos_cash_read();"),
        ).sessions.find((s) => s.id === sid).components;
        assert.equal(c.contributions, 0);
        assert.equal(c.withdrawals, 0);
        assert.equal(
          sql(
            `select count(*) from public.pos_cash_movements where voided_at is not null;`,
          ),
          "2",
        );
      },
    );
    const close = {
      action: "close",
      session: sid,
      amount: 430000,
      expected: 440000,
      reason: "Faltan diez mil",
    };
    await t.test(
      "cierre valida diferencia, esperado actualizado, cuentas y pagos pendientes sin escritura parcial",
      () => {
        fails(login() + rpc({ ...close, reason: "" }), "Explica");
        fails(
          login() + rpc({ ...close, expected: 123 }),
          "componentes cambiaron",
        );
        sql(`update public.pos_orders set closed_at=null where id='${order}';`);
        fails(login() + rpc(close), "Cierra las cuentas");
        sql(
          `update public.pos_orders set closed_at=now() where id='${order}'; update public.pos_payments set status='pending' where id='${payment}';`,
        );
        fails(login() + rpc(close), "Cierra las cuentas");
        sql(
          `update public.pos_payments set status='confirmed' where id='${payment}';`,
        );
        assert.equal(
          sql(
            `select closed_at is null from public.pos_cash_registers where sales_session_id='${sid}';`,
          ),
          "t",
        );
      },
    );
    await t.test(
      "cierre concurrente bloquea movimiento posterior; snapshot consistente e idempotente",
      async () => {
        const closeId = randomUUID();
        // Start the closing transaction, holding the same lock before committing.
        const closing = parallel(
          login() +
            `begin; ${rpc(close, closeId)} select pg_sleep(0.5); commit;`,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        await assert.rejects(parallel(login() + rpc(movement({ amount: 1 }))));
        await closing;
        const result = command(close, closeId);
        assert.equal(result.expected, 440000);
        assert.equal(result.difference, -10000);
        assert.equal(result.components.cash, 500000);
        assert.equal(
          sql(
            `select status from public.pos_sales_sessions where id='${sid}';`,
          ),
          "closed",
        );
      },
    );
    await t.test(
      "caja cerrada protege ventas, pagos, líneas, reasignación, edición y eliminación de jornada",
      () => {
        for (const statement of [
          `update public.pos_orders set financial_status='cancelled' where id='${order}'`,
          `update public.pos_orders set sales_session_id='${legacy}' where id='${order}'`,
          `update public.pos_payments set amount_applied=1 where id='${payment}'`,
          `update public.pos_order_items set total_price=1 where id='${item}'`,
          `update public.pos_sales_sessions set notes='edit' where id='${sid}'`,
          `select public.delete_pos_sales_session('${sid}')`,
          `select public.reassign_pos_order_sales_session('${order}','${legacy}')`,
        ])
          fails(login("admin@test.invalid") + statement + ";", "Caja cerrada");
        fails(
          login("admin@test.invalid") +
            rpc({ action: "void", movement: expense.id, reason: "Tarde" }),
          "abierta",
        );
      },
    );
    await t.test(
      "apertura manual hoy/ayer y rechazo fuera de alcance mediante RPC",
      () => {
        const today = sql(
          "select (now() at time zone 'America/Bogota')::date;",
        );
        const yesterday = sql(
          "select (now() at time zone 'America/Bogota')::date - 1;",
        );
        for (const day of [today, yesterday]) {
          const output = sql(
            login() +
              "begin;" +
              rpc({ action: "open", amount: 0, business_date: day }).replace(
                "pos_cash_command",
                "pos_cash_open",
              ) +
              "select business_date,cutoff_hour from public.pos_sales_sessions where status='open';rollback;",
          ).split("\n");
          const result = JSON.parse(output[0]);
          assert.ok(result.sales_session_id);
          assert.equal(output[1], day + "|6");
        }
        for (const date of ["2020-01-01", "2099-01-01"])
          fails(
            login() + rpc({ action: "open", amount: 0, business_date: date }),
            "hoy o ayer",
          );
        fails(
          login() +
            "insert into public.pos_sales_sessions(session_label,business_date,opened_by_email) values('Inválida','2020-01-01','cashier@test.invalid');",
          "hoy o ayer",
        );
        assert.equal(
          sql(
            "select count(*) from public.pos_sales_sessions where status='open';",
          ),
          "0",
        );
      },
    );
    await t.test(
      "primeros pedidos simultáneos crean una sola jornada sin base; cobros y base conservan fecha",
      async () => {
        const firstOrder = () =>
          parallel(
            login("waiter@test.invalid") +
              `with s as (select public.pos_cash_ensure_session() as row) insert into public.pos_orders(sales_session_id,opened_by_email,closed_at) select (row->>'id')::uuid,'waiter@test.invalid',now() from s returning sales_session_id;`,
          );
        const ids = await Promise.all([firstOrder(), firstOrder()]);
        assert.equal(ids[0], ids[1]);
        sid = ids[0];
        assert.equal(
          sql(
            `select count(*) from public.pos_cash_registers where sales_session_id='${sid}';`,
          ),
          "0",
        );
        const sessionBefore = sql(
          `select row_to_json(s) from public.pos_sales_sessions s where id='${sid}';`,
        );
        assert.equal(JSON.parse(sessionBefore).cutoff_hour, 6);
        assert.equal(
          JSON.parse(sessionBefore).business_date,
          sql("select public.pos_sales_business_date();"),
        );
        sql(
          `insert into public.pos_payments(order_id,sales_session_id,method,status,allocation_mode,amount_applied,created_by_email) select id,'${sid}','cash','confirmed','amount',40000,'cashier@test.invalid' from public.pos_orders where sales_session_id='${sid}' limit 1;`,
        );
        fails(login() + rpc(movement()), "base inicial");
        fails(
          login() +
            rpc({
              action: "close",
              session: sid,
              amount: 40000,
              expected: 40000,
            }),
          "base inicial",
        );
        fails(
          login() +
            rpc({
              action: "open",
              session: sid,
              amount: 0,
              business_date: "2020-01-01",
            }),
          "no se puede cambiar",
        );
        const opened = command({ action: "open", amount: 0 });
        sid = opened.sales_session_id;
        assert.equal(
          sql(
            `select row_to_json(s) from public.pos_sales_sessions s where id='${sid}';`,
          ),
          sessionBefore,
        );
        assert.equal(
          sql(
            `select sum(amount_applied) from public.pos_payments where sales_session_id='${sid}';`,
          ),
          "40000",
        );
        const id = randomUUID(),
          payload = movement({ amount: 10 });
        const results = await Promise.all([
          parallel(login() + rpc(payload, id)),
          parallel(login() + rpc(payload, id)),
        ]);
        assert.equal(results[0], results[1]);
        assert.equal(
          sql(
            `select count(*) from public.pos_cash_movements where id='${id}';`,
          ),
          "1",
        );
        command(movement({ session: null, origin: "owner" }));
        fails(login() + rpc(movement({ session: null })), "check constraint");
      },
    );
    await t.test(
      "anónimo y caja inactiva no acceden; funciones internas no están expuestas",
      () => {
        fails(
          "set role anon; select public.pos_cash_read();",
          "permission denied",
        );
        fails(
          login() + `select public.pos_cash_components('${sid}');`,
          "permission denied",
        );
        fails(
          login() + `select public.pos_cash_sales_summary('${sid}');`,
          "permission denied",
        );
        sql(
          "update public.staff_profiles set is_active=false where email='cashier@test.invalid';",
        );
        fails(login() + "select public.pos_cash_read();", "Acceso denegado");
        sql(
          "update public.staff_profiles set is_active=true where email='cashier@test.invalid';",
        );
      },
    );
    await t.test(
      "base de jornada autoabierta se completa sin cambiar su registro original",
      () => {
        command({
          action: "close",
          session: sid,
          amount: 39990,
          expected: 39990,
          reason: "Caja de prueba sin fondos",
        });
        const auto = JSON.parse(
          sql(
            login("waiter@test.invalid") +
              "select public.pos_cash_ensure_session();",
          ),
        );
        const before = sql(
          `select row_to_json(s) from public.pos_sales_sessions s where id='${auto.id}';`,
        );
        sid = auto.id;
        fails(login() + rpc(movement()), "base inicial");
        command({
          action: "open",
          session: sid,
          amount: 0,
          notes: "Registro tardío explícito",
        });
        assert.equal(
          sql(
            `select row_to_json(s) from public.pos_sales_sessions s where id='${sid}';`,
          ),
          before,
        );
        assert.equal(
          sql(
            `select count(*) from public.pos_order_status_logs where event_type='sales_session_opened' and after_data->>'id'='${sid}';`,
          ),
          "1",
        );
      },
    );
    await t.test(
      "asociaciones antiguas inconsistentes detienen cierre sin reasignar cuentas o pagos",
      () => {
        const orphan = randomUUID();
        sql(`insert into public.pos_orders(id,opened_by_email,closed_at) values('${orphan}','legacy@test.invalid',now());
        insert into public.pos_payments(order_id,sales_session_id,method,status,allocation_mode,amount_applied,created_by_email) values('${orphan}','${sid}','cash','confirmed','amount',0,'legacy@test.invalid');`);
        fails(
          login() +
            rpc({ action: "close", session: sid, amount: 0, expected: 0 }),
          "jornadas diferentes",
        );
        assert.equal(
          sql(
            `select sales_session_id is null from public.pos_orders where id='${orphan}';`,
          ),
          "t",
        );
        assert.equal(
          sql(
            `select status from public.pos_sales_sessions where id='${sid}';`,
          ),
          "open",
        );
      },
    );
  } finally {
    execFileSync(
      exe("pg_ctl"),
      ["-D", path.join(dir, "data"), "-m", "fast", "-w", "stop"],
      opts,
    );
    t.diagnostic(
      `Cluster local detenido; archivos de prueba conservados en ${dir}`,
    );
  }
});
