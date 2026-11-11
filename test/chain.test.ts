// The NEAR part against a real local node (near-workspaces sandbox: no accounts on any real network, nothing signed for real).
// One sandbox for the whole file: it deploys the Fair Share contract and the official Sputnik DAO v2 wasm.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bitsToShare, checkRound } from "../src/chain.ts";
import { fairShare } from "../src/rule.ts";
import { loadRound } from "../src/rpc.ts";
import { NEAR, commit, commitAll, createRound, dLiesRows, failedWith, payOut, reveal, revealAll, runRound, send, settle, startWorld, truthfulRows, chainNowMs } from "../sandbox/harness.ts";
import type { World } from "../sandbox/harness.ts";
import type { SplitView } from "../src/chain.ts";

let w: World;
before(async () => {
  w = await startWorld();
});
after(async () => {
  await w.worker.tearDown();
});

const verify = async (round: string) => (await settle(w), checkRound(await loadRound(w.rpc, w.contract.accountId, round)));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntilChainPast(ms: number) {
  while ((await chainNowMs(w)) <= ms) await pause(500);
}

test("consensual 40/30/20/10 on a 10 NEAR pot: stored split and DAO payout are exact", async () => {
  const { reveals, split } = await runRound(w, "consensual", truthfulRows(), 10n * NEAR);
  assert.ok(reveals.every((r) => r.succeeded));
  const want = [4n, 3n, 2n, 1n].map((x) => x * NEAR);
  assert.deepEqual(split.amounts.map(BigInt), want);
  assert.equal(split.amounts.map(BigInt).reduce((a, b) => a + b), 10n * NEAR);
  // the contract's f64 result is bit-identical to src/rule.ts
  assert.deepEqual(split.share_bits.map(bitsToShare), fairShare(truthfulRows()));

  const pay = await payOut(w, "consensual", split);
  assert.equal(pay.proposalIds.length, 4);
  assert.deepEqual(pay.gained, want); // each member received exactly the amount (their vote gas added back), to the yocto
  // the DAO pays 10 NEAR; it also gets 30% of the gas burnt by calls to it, so only a range is exact
  assert.ok(pay.daoDelta >= -10n * NEAR && pay.daoDelta < -10n * NEAR + NEAR / 100n, `dao delta ${pay.daoDelta}`);

  const { match, checks } = await verify("consensual");
  assert.ok(match, JSON.stringify(checks.filter((c) => !c.ok)));
  assert.match(checks.at(-1)!.detail, /4 Transfer proposals, 4 executed/);
});

test("D lies (rates A 90 / B 5 / C 5): D keeps 10.0% and the amounts still add up", async () => {
  const { split } = await runRound(w, "d-lies", dLiesRows(), 10n * NEAR);
  const shares = split.share_bits.map(bitsToShare);
  assert.deepEqual(shares, fairShare(dLiesRows()));
  assert.ok(Math.abs(shares[3] - 0.1) < 1e-12, `D share ${shares[3]}`);
  const amounts = split.amounts.map(BigInt);
  assert.ok(amounts[3] > NEAR - NEAR / 10n ** 9n && amounts[3] < NEAR + NEAR / 10n ** 9n, `D amount ${amounts[3]}`);
  assert.equal(amounts.reduce((a, b) => a + b), 10n * NEAR);
  assert.ok(amounts[0] > amounts[1] && amounts[1] > amounts[2]); // the others still end in order A > B > C
  assert.ok(shares[1] < 0.3 - 0.05, "D's lie did move B's share (that is in the paper), only D's own share is protected");

  assert.ok((await verify("d-lies")).match, "split verifies before any DAO proposal exists");
});

test("a reveal that does not match its commit is rejected; the honest reveal still works", async () => {
  const [alice, bob, carol, dave] = w.team;
  const rows = truthfulRows();
  await createRound(w, "mismatch", 10n * NEAR);
  const salts = await commitAll(w, "mismatch", w.team, rows);

  const otherRatings = await reveal(w, "mismatch", dave, [90, 5, 5, 0], salts[3]); // different ratings, right salt
  assert.ok(failedWith(otherRatings, "ERR_REVEAL_MISMATCH"));
  const otherSalt = await reveal(w, "mismatch", dave, rows[3], "00ff"); // right ratings, wrong salt
  assert.ok(failedWith(otherSalt, "ERR_REVEAL_MISMATCH"));
  const selfRating = await reveal(w, "mismatch", dave, [10, 5, 5, 7], salts[3]); // rating yourself is refused before anything else
  assert.ok(failedWith(selfRating, "ERR_BAD_RATINGS"));
  const stranger = await reveal(w, "mismatch", w.relay, rows[3], salts[3]);
  assert.ok(failedWith(stranger, "ERR_NOT_A_MEMBER"));
  assert.deepEqual(((await w.contract.view("get_round", { round_id: "mismatch" })) as { revealed: boolean[] }).revealed, [false, false, false, false]);

  // the three honest members reveal first: no split exists yet, and the opened ratings are not readable either
  for (const [i, a] of [alice, bob, carol].entries()) assert.ok((await reveal(w, "mismatch", a, rows[i], salts[i])).succeeded);
  assert.equal(await w.contract.view("get_split", { round_id: "mismatch" }), null);
  await assert.rejects(w.contract.view("get_reveals", { round_id: "mismatch" }), /ERR_NOT_FINAL/);
  assert.equal(((await w.contract.view("get_round", { round_id: "mismatch" })) as { status: string }).status, "reveal");

  // the one honest reveal that is left closes the round
  assert.ok((await reveal(w, "mismatch", dave, rows[3], salts[3])).succeeded);
  const split = (await w.contract.view("get_split", { round_id: "mismatch" })) as SplitView;
  assert.deepEqual(split.amounts.map(BigInt), [4n, 3n, 2n, 1n].map((x) => x * NEAR));
  assert.ok((await verify("mismatch")).match);
});

test("nothing can be revealed or read before every member has committed; wrong callers and double commits fail", async () => {
  const [alice, bob] = w.team;
  const rows = truthfulRows();
  await createRound(w, "early", 10n * NEAR);
  const { salt } = await commit(w, "early", alice, rows[0]);
  assert.ok(failedWith(await reveal(w, "early", alice, rows[0], salt), "ERR_COMMIT_PHASE_OPEN"));
  assert.ok(failedWith((await commit(w, "early", alice, rows[0])).r, "ERR_ALREADY_COMMITTED"));
  assert.ok(failedWith((await commit(w, "early", w.relay, rows[0])).r, "ERR_NOT_A_MEMBER"));
  assert.ok(failedWith(await send(w, bob, w.contract, "commit", { round_id: "early", commitment: "not-a-hash" }, "commit bad"), "ERR_BAD_COMMITMENT"));
  assert.equal(await w.contract.view("get_split", { round_id: "early" }), null);
  await assert.rejects(w.contract.view("get_reveals", { round_id: "early" }), /ERR_NOT_FINAL/);
  const view = (await w.contract.view("get_round", { round_id: "early" })) as { status: string; commits: (string | null)[] };
  assert.equal(view.status, "commit");
  assert.equal(view.commits.filter(Boolean).length, 1);
  // a round id can be used once
  assert.ok(failedWith(await createRound(w, "early", 10n * NEAR), "ERR_ROUND_EXISTS"));
});

test("create_round refuses fewer than 4 members, duplicates and an empty pot", async () => {
  const names = w.team.map((a) => a.accountId);
  const now = await chainNowMs(w);
  const base = { dao: w.dao.accountId, pot: NEAR.toString(), members: names, commit_until_ms: String(now + 60_000), reveal_until_ms: String(now + 120_000) };
  const call = (round_id: string, over: object) => send(w, w.relay, w.contract, "create_round", { round_id, ...base, ...over }, `create_round ${round_id}`);
  assert.ok(failedWith(await call("few", { members: names.slice(0, 3) }), "ERR_MEMBER_COUNT"));
  assert.ok(failedWith(await call("dup", { members: [names[0], names[0], names[2], names[3]] }), "ERR_DUPLICATE_MEMBER"));
  assert.ok(failedWith(await call("zero", { pot: "0" }), "ERR_ZERO_POT"));
  assert.ok(failedWith(await call("order", { reveal_until_ms: String(now + 30_000) }), "ERR_BAD_DEADLINES"));
});

test("a missed commit deadline aborts the round: no late commit, no reveal, no split", async () => {
  const [alice, bob, carol, dave] = w.team;
  const rows = truthfulRows();
  await createRound(w, "late-commit", 10n * NEAR, { commitMs: 12_000, revealMs: 24_000 });
  const deadline = Number(((await w.contract.view("get_round", { round_id: "late-commit" })) as { commit_until_ms: string }).commit_until_ms);
  const salts = await Promise.all([alice, bob, carol].map((a, i) => commit(w, "late-commit", a, rows[i]))); // dave never commits
  assert.ok(salts.every((s) => s.r.succeeded), "the three commits must land before the 12 s deadline (slow machine?)");
  await waitUntilChainPast(deadline);
  assert.ok(failedWith((await commit(w, "late-commit", dave, rows[3])).r, "ERR_COMMIT_CLOSED"));
  assert.ok(failedWith(await reveal(w, "late-commit", alice, rows[0], salts[0].salt), "ERR_COMMIT_PHASE_OPEN"));
  assert.equal(((await w.contract.view("get_round", { round_id: "late-commit" })) as { status: string }).status, "aborted");
  assert.equal(await w.contract.view("get_split", { round_id: "late-commit" }), null);
  assert.equal((await verify("late-commit")).match, false);
});

test("a missed reveal deadline aborts the round: the late reveal is refused and no split is ever stored", async () => {
  const [alice, bob, carol, dave] = w.team;
  const rows = truthfulRows();
  await createRound(w, "late-reveal", 10n * NEAR, { commitMs: 10_000, revealMs: 22_000 });
  const deadline = Number(((await w.contract.view("get_round", { round_id: "late-reveal" })) as { reveal_until_ms: string }).reveal_until_ms);
  const salts = await commitAll(w, "late-reveal", w.team, rows);
  const early = await revealAll(w, "late-reveal", [alice, bob, carol], rows, salts); // dave stays silent
  assert.ok(early.every((r) => r.succeeded), "reveals must land before the 22 s deadline (slow machine?)");
  await waitUntilChainPast(deadline);
  assert.ok(failedWith(await reveal(w, "late-reveal", dave, rows[3], salts[3]), "ERR_REVEAL_CLOSED"));
  assert.equal(((await w.contract.view("get_round", { round_id: "late-reveal" })) as { status: string }).status, "aborted");
  assert.equal(await w.contract.view("get_split", { round_id: "late-reveal" }), null);
  await assert.rejects(w.contract.view("get_reveals", { round_id: "late-reveal" }), /ERR_NOT_FINAL/);
});
