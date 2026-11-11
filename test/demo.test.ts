import { test } from "node:test";
import assert from "node:assert/strict";
import { fairShare } from "../src/rule.ts";
import { toAmounts } from "../src/payout.ts";
import { POT_CENTS, scenario } from "../src/scenario.ts";

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

test("demo: $10,000 pot, true split 40/30/20/10, D lies", () => {
  const { plain, fair, plainCents, fairCents } = scenario();
  near(plain[3], 0.325); // plain average of claims: D gets 32.5% = $3,250
  assert.equal(plainCents[3], 325000n);
  near(fair[3], 0.1); // Fair Share: D stays at 10.0% = $1,000
  assert.equal(fairCents[3], 100000n);
  assert.equal(fairCents.reduce((a, b) => a + b), POT_CENTS);
});

test("demo: D's share stays 10% whatever D writes", () => {
  for (const d of [[90, 5, 5, 0], [1, 1, 1, 0], [1, 1000, 1, 0], [3, 2, 1, 0], [0.001, 0.001, 1000, 0]]) {
    const rows = [[0, 30, 20, 10], [40, 0, 20, 10], [40, 30, 0, 10], d];
    near(fairShare(rows)[3], 0.1, 1e-12);
  }
});

test("known limit: A and D rate each other 90% (B, C 5%) and both gain, B and C lose", () => {
  const rows = [[0, 5, 5, 90], [40, 0, 20, 10], [40, 30, 0, 10], [90, 5, 5, 0]];
  const s = fairShare(rows);
  assert.deepEqual(s.map((v) => (v * 100).toFixed(1)), ["58.8", "10.7", "9.0", "21.5"]); // matches research/110:45
  const cents = toAmounts(s, POT_CENTS).map((c) => Math.round(Number(c) / 100));
  assert.equal(cents[0] - 4000, 1884); // A +$1,884
  assert.equal(cents[3] - 1000, 1152); // D +$1,152
});
