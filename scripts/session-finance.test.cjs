const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const compile = (file) =>
  ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
function moduleAt(file, require = () => {}) {
  const c = { exports: {}, require, Intl, Date, encodeURIComponent };
  vm.runInNewContext(compile(file), c);
  return c.exports;
}
const domain = moduleAt("src/admin/cash/cash.domain.ts");
const finance = moduleAt("src/admin/cash/sessionFinance.ts", () => domain);
const id = "00000000-0000-4000-8000-000000000027";
const fixture = () => ({
  sessions: [
    {
      id,
      status: "open",
      components: {
        opening: null,
        cash: 40000,
        contributions: 0,
        withdrawals: 0,
        expenses: 0,
      },
    },
  ],
  registers: [],
  movements: [],
});
test("sin base/arqueo no inventa cero; UUID estricto excluye anulados y gastos sin jornada", () => {
  const data = fixture();
  data.movements = [
    {
      id: "1",
      sales_session_id: id,
      kind: "expense",
      amount: 100,
      origin: "owner",
    },
    {
      id: "2",
      sales_session_id: null,
      kind: "expense",
      amount: 999,
      origin: "owner",
    },
    {
      id: "3",
      sales_session_id: id,
      kind: "expense",
      amount: 200,
      origin: "register",
      voided_at: "today",
    },
  ];
  const f = finance.sessionFinance(id, data);
  assert.equal(f.opening, null);
  assert.equal(f.expected, null);
  assert.equal(f.status, "Pendiente de cierre");
  assert.equal(f.expenses.owner, 100);
  assert.equal(f.expenses.register, 0);
  assert.equal(f.movements.length, 2);
  assert.equal(finance.financeCsv(id, data).efectivo_contado, null);
});
test("snapshot cerrado manda sobre cifras actuales; cero registrado es distinto de ausencia", () => {
  const data = fixture();
  data.sessions[0].status = "closed";
  data.sessions[0].components.cash = 999999;
  data.registers = [
    {
      sales_session_id: id,
      opening_amount: 0,
      closed_at: "2026-09-28T10:00:00Z",
      expected: 440000,
      counted: 430000,
      difference: -10000,
      difference_reason: "Faltante",
      closed_by: "caja",
      components: {
        opening: 0,
        cash: 500000,
        contributions: 0,
        withdrawals: 0,
        expenses: 60000,
      },
    },
  ];
  const f = finance.sessionFinance(id, data);
  assert.equal(f.components.cash, 500000);
  assert.equal(f.expected, 440000);
  assert.equal(f.opening, 0);
  assert.equal(finance.financeCsv(id, data).diferencia, -10000);
});
test("enlaces UUID conservan destino fuera del mes; desglose no agrupa Nequi como transferencia", () => {
  assert.equal(
    finance.sessionDetailUrl(id),
    `/admin/sales-sessions?session=${id}`,
  );
  const scope = finance.includeLinkedSession(
    [{ id: "other" }],
    [{ id }, { id: "other" }],
    id,
  );
  assert.equal(scope[0].id, id);
  assert.equal(scope.length, 2);
  assert.equal(finance.includeLinkedSession([], [], id).length, 0);
  const amounts = finance.paymentBreakdown({
    summary: {
      paymentMethods: [
        { method: "nequi", totalAmount: 200 },
        { method: "bank_transfer", totalAmount: 300 },
      ],
    },
  });
  assert.equal(amounts.nequi, 200);
  assert.equal(amounts.bank_transfer, 300);
  assert.equal(amounts.cash, 0);
  assert.equal(domain.csvCell("=SUM(A1)"), '"\'=SUM(A1)"');
  assert.equal(domain.csvCell(null), '""');
  assert.equal(domain.csvCell(0), '"0"');
});
const settle = () => new Promise((r) => setImmediate(r));
function reportHarness({
  roles = ["cashier"],
  cashFails = false,
  reconciled = false,
  query = id,
  history,
  sales = [],
} = {}) {
  const downloads = [];
  let cursor = 0,
    states = [],
    effects = [],
    params = new URLSearchParams(query ? `session=${query}` : ""),
    reads = 0,
    cashReads = 0;
  const session = {
    id,
    businessDate: "2020-01-01",
    sessionLabel: "Jornada antigua",
    status: "closed",
    openedAt: "2020-01-01T18:00:00Z",
    closedAt: "2020-01-02T05:00:00Z",
    updatedAt: "2020-01-02T05:00:00Z",
    totalSold: 0,
    totalCollected: 0,
    orderCount: 0,
    paymentCount: 0,
    notes: "",
    summary: {
      products: [],
      paymentMethods: [],
      totalCollected: 0,
      grossSales: 0,
      pendingBalance: 0,
    },
  };
  const data = fixture();
  if (reconciled) data.registers.push({sales_session_id:id,closed_at:'2020-01-02T05:00:00Z'});
  data.sessions[0].status = "closed";
  const hooks = {
    useState(v) {
      let i = cursor++;
      if (!(i in states)) states[i] = typeof v === "function" ? v() : v;
      return [
        states[i],
        (x) => (states[i] = typeof x === "function" ? x(states[i]) : x),
      ];
    },
    useRef(v) {
      let i = cursor++;
      return (states[i] ??= { current: v });
    },
    useMemo: (f) => f(),
    useEffect(fn, deps) {
      const i = cursor++;
      if (!states[i] || deps.some((d, n) => d !== states[i][n]))
        effects.push(fn);
      states[i] = deps;
    },
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const c = {
    exports: {},
    Intl,
    Date,
    Map,
    Set,
    URLSearchParams,
    Blob,
    URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() {} }) },
    window: { setTimeout: () => {}, scrollTo: () => {} },
    require(name) {
      if (name === "react") return hooks;
      if (name === "react/jsx-runtime")
        return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "react-router-dom")
        return {
          Link: "a",
          useSearchParams: () => [
            params,
            (p) => (params = new URLSearchParams(p)),
          ],
        };
      if (name.includes("SupabaseAuthProvider"))
        return {
          useSupabaseAuth: () => ({
            isCatalogAdmin: false,
            staffRoles: roles,
            user: { email: "test" },
            staffProfile: null,
          }),
        };
      if (name.includes("posOperationsRepository"))
        return {
          loadAuthorizedSessionReportFromSupabase: async () => {
            reads++;
            return { history: history ?? [session], closedSales: sales, tables: [] };
          },
        };
      if (name.includes("cash.repository"))
        return {
          loadCash: async () => {
            cashReads++;
            if (cashFails) throw new Error("Caja offline");
            return data;
          },
        };
      if (name.includes("cash.domain")) return domain;
      if (name.includes("sessionFinance")) return finance;
      if (name.includes("SessionFinanceDetail"))
        return {
          SessionFinanceDetail: ({ id }) => jsx("finance", { children: id }),
        };
      if (name.includes("AdminLayout")) return { AdminLayout: "layout" };
      throw new Error(name);
    },
  };
  vm.runInNewContext(compile("src/admin/AdminSalesSessionsView.tsx"), c);
  const expand = (n) =>
    Array.isArray(n)
      ? n.map(expand)
      : n && typeof n === "object"
        ? typeof n.type === "function"
          ? expand(n.type(n.props))
          : { ...n, props: { ...n.props, children: expand(n.props.children) } }
        : n;
  return {
    render() {
      cursor = 0;
      const t = expand(c.exports.AdminSalesSessionsView());
      const es = effects;
      effects = [];
      es.forEach((f) => f());
      return t;
    },
    counts: () => [reads, cashReads],
    downloads,
  };
}
function nodes(n, type) {
  return Array.isArray(n)
    ? n.flatMap((x) => nodes(x, type))
    : n && typeof n === "object"
      ? [...(n.type === type ? [n] : []), ...nodes(n.props.children, type)]
      : [];
}
function text(n) {
  return Array.isArray(n)
    ? n.map(text).join(" ")
    : n && typeof n === "object"
      ? text(n.props.children)
      : n == null || typeof n === "boolean"
        ? ""
        : String(n);
}
test('superadmin conserva ajustes de fechas con arqueo, pero no puede eliminarlo', async () => {
  const h=reportHarness({roles:['superadmin'],reconciled:true});
  h.render(); await settle(); h.render(); await settle();
  const buttons=nodes(h.render(),'button');
  assert.equal(buttons.find(n=>text(n)==='Ajustar fechas').props.disabled,false);
  assert.equal(buttons.find(n=>text(n)==='Eliminar jornada').props.disabled,true);
});

test("cajero consulta/exporta sin controles administrativos y enlace expande fuera del mes al recargar", async () => {
  for (let reload = 0; reload < 2; reload++) {
    const h = reportHarness();
    h.render();
    await settle();
    h.render();
    await settle();
    const tree = h.render();
    assert.ok(nodes(tree, "finance").some((n) => n.props.children === id));
    const buttons = nodes(tree, "button").map(text).join("|");
    assert.match(buttons, /Exportar resumen/);
    assert.doesNotMatch(
      buttons,
      /Crear jornada manual|Ajustar fechas|Eliminar jornada|Mover de jornada|Anular venta/,
    );
  }
});
test("roles denegados no cargan datos; ID inexistente y error caja son explícitos y recuperables", async () => {
  for (const roles of [[], ["waiter"], ["kitchen"], ["bar"]]) {
    const h = reportHarness({ roles });
    const tree = h.render();
    await settle();
    assert.match(text(tree), /Acceso restringido/);
    assert.deepEqual(h.counts(), [0, 0]);
  }
  const h = reportHarness({ cashFails: true, query: "missing" });
  h.render();
  await settle();
  h.render();
  await settle();
  const tree = h.render();
  assert.match(text(tree), /No existe una jornada accesible/);
  assert.match(text(tree), /Caja offline/);
  assert.match(text(tree), /Reintentar carga de caja/);
  assert.match(text(tree), /Enero de 2020/);
  const visible = reportHarness({ cashFails: true });
  visible.render();
  await settle();
  visible.render();
  await settle();
  assert.match(text(visible.render()), /Jornada antigua/);
  const retry = nodes(tree, "button").find(
    (n) => text(n) === "Reintentar carga de caja",
  );
  retry.props.onClick();
  await settle();
  assert.equal(h.counts()[1], 2);
  assert.equal(
    nodes(tree, "button").find((n) => text(n) === "Exportar resumen").props
      .disabled,
    true,
  );
});


test('linked detail outside period never changes metrics, comparisons or either CSV', async () => {
  const makeSession=(sid,date,amount)=>({id:sid,businessDate:date,sessionLabel:sid,status:'closed',openedAt:date+'T23:00:00Z',closedAt:date+'T23:59:00Z',updatedAt:date+'T23:59:00Z',notes:'',totalSold:amount,totalCollected:amount,orderCount:1,paymentCount:1,summary:{grossSales:amount,totalCollected:amount,orderCount:1,confirmedPayments:1,pendingBalance:0,products:[],paymentMethods:[{method:'cash',totalAmount:amount,paymentCount:1}]}});
  const history=[makeSession('outside','2020-01-10',90000),makeSession('inside','2020-02-10',10000)];
  const sales=history.map(s=>({id:'order-'+s.id,salesSessionId:s.id,closedAt:s.closedAt,openedAt:s.openedAt,financialStatus:'paid_total',tableNameSnapshot:s.id,tableCodeSnapshot:s.id,summary:{totalDue:s.totalSold,totalPaid:s.totalSold,remainingBalance:0},items:[],payments:[{id:'pay-'+s.id,status:'confirmed',method:'cash',amountApplied:s.totalCollected}]}));
  const results=[];
  for (const query of [null,'outside']) {
    const h=reportHarness({history,sales,query}); h.render(); await settle(); h.render(); await settle();
    let tree=h.render();
    nodes(tree,'select').find(n=>nodes(n,'option').some(o=>o.props.value==='2020-02')).props.onChange({target:{value:'2020-02'}});
    tree=h.render(); h.render(); tree=h.render();
    const metrics=nodes(tree,'article').filter(n=>String(n.props.className).includes('sm:p-5')).map(text);
    for(const label of ['Exportar resumen','Exportar detalle']) nodes(tree,'button').find(n=>text(n)===label).props.onClick();
    const csv=await Promise.all(h.downloads.map(b=>b.text()));
    assert.equal(csv.length,2);
    for(const output of csv) { assert.match(output,/inside/); assert.doesNotMatch(output,/outside/); }
    if(query) { assert.match(text(tree),/Fuera del per/); assert.ok(nodes(tree,'finance').some(n=>n.props.children==='outside')); assert.match(text(tree),/order-outside|outside/); }
    results.push({metrics,csv});
  }
  assert.deepEqual(results[0],results[1]);
});
