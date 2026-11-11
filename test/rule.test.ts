import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { fairShare } from "../src/rule.ts";
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
