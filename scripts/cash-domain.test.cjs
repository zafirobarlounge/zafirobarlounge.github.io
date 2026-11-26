const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const context = { exports: {}, Intl, Date };
vm.runInNewContext(
  ts.transpileModule(fs.readFileSync("src/admin/cash/cash.domain.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText,
  context,
);
const { expectedCash, movementTotals, csvCell } = context.exports;
const businessDates = { exports: {}, Intl, Date };
vm.runInNewContext(
  ts.transpileModule(
    fs.readFileSync("src/shared/operations/salesBusinessDate.ts", "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText,
  businessDates,
);
test("fecha comercial Bogotá: horas diurnas y límite exacto de las 06:00", () => {
  for (const [local, expected] of [
    ["2026-09-27T11:00:00", "2026-09-27"],
    ["2026-09-27T16:00:00", "2026-09-27"],
    ["2026-09-27T17:00:00", "2026-09-27"],
    ["2026-09-28T01:00:00", "2026-09-27"],
    ["2026-09-28T05:59:00", "2026-09-27"],
    ["2026-09-28T06:00:00", "2026-09-28"],
    ["2026-01-01T00:00:00", "2025-12-31"],
  ])
    assert.equal(
      businessDates.exports.salesDayOptions(new Date(local + "-05:00"))
        .suggested,
      expected,
    );
});
test("base + recaudo neto - gastos, aportes y retiros", () => {
  const c = {
    opening: 100000,
    cash: 500000,
    expenses: 160000,
    contributions: 0,
    withdrawals: 0,
  };
  assert.equal(expectedCash(c), 440000);
  assert.equal(expectedCash({ ...c, contributions: 50000 }), 490000);
  assert.equal(expectedCash({ ...c, withdrawals: 30000 }), 410000);
  assert.equal(430000 - expectedCash(c), -10000);
  assert.equal(expectedCash({ ...c, opening: null }), null);
  assert.equal(
    expectedCash({
      opening: 0,
      cash: 0.3,
      contributions: 0,
      withdrawals: 0.1,
      expenses: 0,
    }),
    0.2,
  );
});
test("gastos, insumos, aportes y retiros se separan y excluyen anulaciones", () => {
  const rows = [
    { kind: "expense", category: "personal", amount: 160000 },
    { kind: "expense", category: "supplies", amount: 20000, origin: "owner" },
    { kind: "contribution", amount: 50000 },
    { kind: "withdrawal", amount: 30000 },
    { kind: "expense", amount: 999, voided_at: "2026-09-27" },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(movementTotals(rows))), {
    expenses: 180000,
    supplies: 20000,
    contributions: 50000,
    withdrawals: 30000,
  });
});
test("CSV conserva comillas, saltos y neutraliza fórmulas", () => {
  assert.equal(csvCell("=1+1"), '"\'=1+1"');
  assert.equal(csvCell('a;"b"\nc'), '"a;""b""\nc"');
});
