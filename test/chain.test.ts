// The NEAR part against a real local node (near-workspaces sandbox: no accounts on any real network, nothing signed for real).
// One sandbox for the whole file: it deploys the Fair Share contract and the official Sputnik DAO v2 wasm.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { bitsToShare, checkRound } from "../src/chain.ts";
import { fairShare, neutralRow } from "../src/rule.ts";
import { loadRound } from "../src/rpc.ts";
import { NEAR, ROUND_BOND, balanceOf, chainNowMs, commit, commitAll, createRound, dLiesRows, failedWith, finalize, payOut, reveal, revealAll, runRound, send, settle, startWorld, truthfulRows, waitUntilChainPast } from "../sandbox/harness.ts";
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
const roundView = async (id: string) => (await w.contract.view("get_round", { round_id: id })) as { status: string; revealed: boolean[]; commits: (string | null)[]; reveal_until_ms: string; commit_until_ms: string };

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
  assert.match(checks.find((c) => c.name === "DAO proposals match the stored split")!.detail, /4 Transfer proposals, 4 executed/);
  assert.ok(checks.at(-1)!.name.includes("code hash") && checks.at(-1)!.ok, "the DAO runs exactly the vendored wasm");
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
  assert.ok(failedWith(await send(w, bob, w.contract, "commit", { round_id: "early", commitment: "not-a-hash" }, "commit bad", ROUND_BOND), "ERR_BAD_COMMITMENT"));
  assert.ok(failedWith((await commit(w, "early", bob, rows[1], "ab", 0n)).r, "ERR_BOND"));
  assert.ok(failedWith((await commit(w, "early", bob, rows[1], "ab", ROUND_BOND + 1n)).r, "ERR_BOND"));
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
  const base = { dao: w.dao.accountId, pot: NEAR.toString(), bond: ROUND_BOND.toString(), members: names, commit_until_ms: String(now + 60_000), reveal_until_ms: String(now + 120_000) };
  const call = (round_id: string, over: object) => send(w, w.relay, w.contract, "create_round", { round_id, ...base, ...over }, `create_round ${round_id}`);
  assert.ok(failedWith(await call("few", { members: names.slice(0, 3) }), "ERR_MEMBER_COUNT"));
  assert.ok(failedWith(await call("dup", { members: [names[0], names[0], names[2], names[3]] }), "ERR_DUPLICATE_MEMBER"));
  assert.ok(failedWith(await call("zero", { pot: "0" }), "ERR_ZERO_POT"));
  assert.ok(failedWith(await call("nobond", { bond: "0" }), "ERR_ZERO_BOND"));
  assert.ok(failedWith(await call("order", { reveal_until_ms: String(now + 30_000) }), "ERR_BAD_DEADLINES"));
});

test("a member who never commits cannot stop the round: reveals open at the commit deadline, their row is the neutral one", async () => {
  const [alice, bob, carol, dave] = w.team;
  const rows = truthfulRows();
  await createRound(w, "late-commit", 10n * NEAR, { commitMs: 12_000, revealMs: 28_000 });
  const v0 = await roundView("late-commit");
  const salts = await Promise.all([alice, bob, carol].map((a, i) => commit(w, "late-commit", a, rows[i]))); // dave never commits
  assert.ok(salts.every((s) => s.r.succeeded), "the three commits must land before the 12 s deadline (slow machine?)");
  assert.ok(failedWith(await reveal(w, "late-commit", alice, rows[0], salts[0].salt), "ERR_COMMIT_PHASE_OPEN"), "still waiting for dave's commit");
  await waitUntilChainPast(w, Number(v0.commit_until_ms));
  assert.ok(failedWith((await commit(w, "late-commit", dave, rows[3])).r, "ERR_COMMIT_CLOSED"));
  assert.ok(failedWith(await reveal(w, "late-commit", dave, rows[3], "00"), "ERR_NOT_COMMITTED"));
  assert.equal((await roundView("late-commit")).status, "reveal");
  for (const [i, a] of [alice, bob, carol].entries()) assert.ok((await reveal(w, "late-commit", a, rows[i], salts[i].salt)).succeeded, "reveals must land before the 28 s deadline");
  assert.equal(await w.contract.view("get_split", { round_id: "late-commit" }), null, "the round waits for dave until the reveal deadline");
  await waitUntilChainPast(w, Number(v0.reveal_until_ms));
  assert.equal((await roundView("late-commit")).status, "expired");
  const daoBefore = await balanceOf(w.dao);
  assert.ok((await finalize(w, "late-commit")).succeeded);
  await settle(w);
  assert.equal(await balanceOf(w.dao), daoBefore, "dave paid no bond, so none is forfeited");
  const split = (await w.contract.view("get_split", { round_id: "late-commit" })) as SplitView;
  assert.deepEqual(split.share_bits.map(bitsToShare), fairShare(rows.map((r, k) => (k === 3 ? neutralRow(4, 3) : r))));
  const { match, checks } = await verify("late-commit");
  assert.ok(match, JSON.stringify(checks.filter((c) => !c.ok)));
  assert.match(checks[1].detail, /3 of 4; never committed: /);
});

test("a member who commits and never reveals loses the bond, the round still finalizes, and their own share is unchanged", async () => {
  const [alice, bob, carol, dave] = w.team;
  const rows = truthfulRows();
  await createRound(w, "withhold", 10n * NEAR, { commitMs: 10_000, revealMs: 30_000 });
  const v0 = await roundView("withhold");
  const salts = await commitAll(w, "withhold", w.team, rows);
  await settle(w); // gas refunds of the commits land after the call returns
  const before = await Promise.all([alice, bob, carol].map(balanceOf));
  const early = await revealAll(w, "withhold", [alice, bob, carol], rows, salts); // dave sees all three and stays silent
  assert.ok(failedWith(await finalize(w, "withhold"), "ERR_REVEAL_OPEN"), "nobody can close the round early (reveals must land before the 30 s deadline, slow machine?)");
  assert.ok(early.every((r) => r.succeeded));
  assert.equal(await w.contract.view("get_split", { round_id: "withhold" }), null);
  await settle(w);
  const after = await Promise.all([alice, bob, carol].map(balanceOf));
  after.forEach((a, i) => assert.ok(a - before[i] > ROUND_BOND - NEAR / 100n && a - before[i] < ROUND_BOND, `the bond of member ${i} came back (minus gas): ${a - before[i]}`));
  await waitUntilChainPast(w, Number(v0.reveal_until_ms));
  assert.ok(failedWith(await reveal(w, "withhold", dave, rows[3], salts[3]), "ERR_REVEAL_CLOSED"), "too late");

  await settle(w);
  const daoBefore = await balanceOf(w.dao);
  assert.ok((await finalize(w, "withhold")).succeeded, "anyone can finalize, here the non-member relay");
  await settle(w);
  assert.equal((await balanceOf(w.dao)) - daoBefore, ROUND_BOND, "dave's bond went to the DAO, exactly");
  assert.ok(failedWith(await finalize(w, "withhold"), "ERR_ALREADY_FINAL"));

  const split = (await w.contract.view("get_split", { round_id: "withhold" })) as SplitView;
  const shares = split.share_bits.map(bitsToShare);
  assert.deepEqual(shares, fairShare(rows.map((r, k) => (k === 3 ? neutralRow(4, 3) : r))));
  assert.equal(shares[3], fairShare(rows)[3], "dave's own share is bit-identical to what revealing would have given");
  assert.equal(split.amounts.map(BigInt).reduce((a, b) => a + b), 10n * NEAR);
  const { match, checks } = await verify("withhold");
  assert.ok(match, JSON.stringify(checks.filter((c) => !c.ok)));
  assert.match(checks[1].detail, /3 of 4; bond forfeited by /);
  const pay = await payOut(w, "withhold", split); // the DAO still pays everybody, dave's share included
  assert.deepEqual(pay.gained, pay.amounts);
  assert.ok((await verify("withhold")).match);
});
