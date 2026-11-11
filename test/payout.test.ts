import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { toAmounts, YOCTO_PER_NEAR } from "../src/payout.ts";

const shares = fc
  .array(fc.integer({ min: 1, max: 1000 }), { minLength: 4, maxLength: 12 })
  .map((w) => w.map((v) => v / w.reduce((a, b) => a + b, 0)));
const sum = (a: bigint[]) => a.reduce((x, y) => x + y, 0n);

test("amounts sum exactly to the pot (random shares, pots from 0 to 10^28)", () => {
  fc.assert(
    fc.property(shares, fc.bigInt({ min: 0n, max: 10n ** 28n }), (s, pot) => {
      const a = toAmounts(s, pot);
      assert.equal(sum(a), pot);
      assert.ok(a.every((v) => v >= 0n));
    }),
    { numRuns: 3000 },
  );
});

test("tiny and huge pots", () => {
  assert.deepEqual(toAmounts([0.25, 0.25, 0.25, 0.25], 1n), [1n, 0n, 0n, 0n]);
  assert.equal(sum(toAmounts([0.5, 0.3, 0.2], 3n)), 3n);
  const pot = 10_000n * YOCTO_PER_NEAR;
  assert.equal(sum(toAmounts([0.4, 0.3, 0.2, 0.1], pot)), pot);
});

test("ties go to the earlier member: three equal shares of 10 are 4,3,3", () => {
  assert.deepEqual(toAmounts([1 / 3, 1 / 3, 1 / 3], 10n), [4n, 3n, 3n]);
});

test("exact splits stay exact", () => {
  assert.deepEqual(toAmounts([0.4, 0.3, 0.2, 0.1], 1_000_000n), [400000n, 300000n, 200000n, 100000n]);
});

test("input errors", () => {
  assert.throws(() => toAmounts([0.5, 0.5], -1n), /pot/);
  assert.throws(() => toAmounts([], 1n), /no shares/);
  assert.throws(() => toAmounts([0.5, -0.5, 1], 1n), /finite and >= 0/);
  assert.throws(() => toAmounts([0.5, 0.4], 1n), /sum to 1/);
  assert.throws(() => toAmounts([NaN, 1], 1n), /finite/);
});
