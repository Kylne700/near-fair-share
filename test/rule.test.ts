import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { fairShare, neutralRow } from "../src/rule.ts";
import { toAmounts } from "../src/payout.ts";
import type { Reports } from "../src/rule.ts";

// n members, integer weights 1..1000 for every cell except the diagonal (0); integers keep ratios finite
const weights = (n: number) => fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: n, maxLength: n });
const profile = fc
  .integer({ min: 4, max: 8 })
  .chain((n) => fc.array(weights(n), { minLength: n, maxLength: n }))
  .map((rows) => rows.map((row, k) => row.map((v, j) => (j === k ? 0 : v))));

test("shares sum to 1 (1e-9) and none is negative", () => {
  fc.assert(
    fc.property(profile, (p) => {
      const s = fairShare(p);
      assert.ok(Math.abs(s.reduce((a, b) => a + b, 0) - 1) < 1e-9);
      assert.ok(s.every((v) => v >= 0));
    }),
    { numRuns: 9000 },
  );
});

test("impartial: changing k's own report never changes k's share (bit for bit)", () => {
  const arb = profile.chain((p) =>
    fc.tuple(fc.constant(p), fc.nat(p.length - 1), weights(p.length)),
  );
  fc.assert(
    fc.property(arb, ([p, k, newRow]) => {
      const q: Reports = p.map((row, i) => (i === k ? newRow.map((v, j) => (j === k ? 0 : v)) : row));
      assert.equal(fairShare(q)[k], fairShare(p)[k]);
    }),
    { numRuns: 9000 },
  );
});

test("consensual: if every report agrees with one split, that split is returned", () => {
  const split = fc.integer({ min: 4, max: 8 }).chain((n) => weights(n));
  fc.assert(
    fc.property(split, (w) => {
      const total = w.reduce((a, b) => a + b, 0);
      const p = w.map((_, k) => w.map((v, j) => (j === k ? 0 : v)));
      fairShare(p).forEach((s, i) => assert.ok(Math.abs(s - w[i] / total) < 1e-12));
    }),
    { numRuns: 2000 },
  );
});

test("reports are normalised: scaling a row changes nothing", () => {
  const p = [[0, 1, 2, 3], [4, 0, 5, 6], [7, 8, 0, 9], [1, 3, 5, 0]];
  const q = p.map((row, k) => (k === 1 ? row.map((v) => v * 37) : row));
  assert.deepEqual(fairShare(q), fairShare(p));
});

test("input errors: n < 4, non-square, self-rating, non-positive or non-finite reports", () => {
  const three = [[0, 1, 1], [1, 0, 1], [1, 1, 0]];
  assert.throws(() => fairShare(three), /at least 4/);
  const ok = [[0, 1, 1, 1], [1, 0, 1, 1], [1, 1, 0, 1], [1, 1, 1, 0]];
  assert.doesNotThrow(() => fairShare(ok));
  assert.throws(() => fairShare([[0, 1, 1], ...ok.slice(1)]), /expected 4/);
  assert.throws(() => fairShare(ok.map((r, k) => (k === 2 ? [1, 1, 1, 1] : r))), /yourself must be 0/);
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.throws(() => fairShare(ok.map((r, k) => (k === 1 ? [1, 0, bad, 1] : r))), /positive finite/);
  }
});

test("withholding gains nothing: the neutral row never changes the withholder's own share, and the split stays valid", () => {
  const pot = 10n * 10n ** 24n;
  const arb = profile.chain((p) => fc.tuple(fc.constant(p), fc.nat(p.length - 1)));
  fc.assert(
    fc.property(arb, ([p, k]) => {
      const q: Reports = p.map((row, i) => (i === k ? neutralRow(p.length, k) : row));
      const s = fairShare(q);
      assert.equal(s[k], fairShare(p)[k]); // bit for bit
      assert.ok(Math.abs(s.reduce((a, b) => a + b, 0) - 1) < 1e-9 && s.every((v) => v >= 0));
      assert.equal(toAmounts(s, pot).reduce((a, b) => a + b, 0n), pot);
    }),
    { numRuns: 9000 },
  );
});

test("everybody silent: the all-neutral profile splits equally; one silent member in a consensual round leaves 3 of 4 shares near the truth", () => {
  for (const n of [4, 7, 12]) fairShare(Array.from({ length: n }, (_, k) => neutralRow(n, k))).forEach((s) => assert.ok(Math.abs(s - 1 / n) < 1e-12));
  const t = [40, 30, 20, 10];
  const rows = t.map((_, k) => t.map((v, j) => (j === k ? 0 : v)));
  const s = fairShare(rows.map((r, k) => (k === 3 ? neutralRow(4, 3) : r)));
  assert.ok(Math.abs(s[3] - 0.1) < 1e-12, "the silent member keeps their 10%");
  assert.ok(s[0] > s[1] && s[1] > s[2], "the order of the others survives");
});
