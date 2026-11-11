// npm run sandbox [-- --keep]
// Starts a local NEAR node (nothing touches a real network), deploys the Fair Share contract and the official Sputnik DAO v2,
// plays two rounds with 4 members and a 10 NEAR pot, pays them out through the DAO, and checks the balances and `verify`.
// With --keep the node stays up after the run so you can try `npm run verify -- consensual` in another terminal (Ctrl-C stops it).
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { bitsToShare, checkRound } from "../src/chain.ts";
import { loadRound } from "../src/rpc.ts";
import { NEAR, commit, commitAll, createRound, dLiesRows, failedWith, payOut, reveal, runRound, settle, startWorld, truthfulRows } from "./harness.ts";
import type { World } from "./harness.ts";

const keep = process.argv.includes("--keep");
const lastRun = new URL("./.last-run.json", import.meta.url);
const say = (line = "") => console.log(line);
const heading = (t: string) => say(`\n== ${t}`);
const near = (yocto: bigint) => (Number(yocto / 10n ** 12n) / 1e12).toFixed(6);
const pct = (bits: string) => (bitsToShare(bits) * 100).toFixed(4) + "%";

async function verify(w: World, round: string) {
  await settle(w);
  const { match, checks } = checkRound(await loadRound(w.rpc, w.contract.accountId, round));
  for (const c of checks) say(`   ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  say(`   ${match ? "MATCH" : "MISMATCH"} ${round}`);
  assert.ok(match, `verify ${round}`);
}

const w = await startWorld(say);
let failed = false;
try {
  const [A, B, C, D] = w.team.map((a) => a.accountId.split(".")[0]);
  const view = <T>(method: string, args: Record<string, unknown>) => w.contract.view(method, args) as Promise<T>;

  heading("1. Consensual round: truth is 40/30/20/10, everybody says so");
  const r1 = await runRound(w, "consensual", truthfulRows(), 10n * NEAR);
  say(`   stored split: ${r1.split.share_bits.map(pct).join(" / ")}  amounts: ${r1.split.amounts.map((a) => near(BigInt(a))).join(" / ")} NEAR`);
  say(`   split hash ${r1.split.hash}`);
  assert.deepEqual(r1.split.amounts.map(BigInt), [4n, 3n, 2n, 1n].map((x) => x * NEAR));
  say("   payout: relay adds one Transfer proposal per member to the team's Sputnik DAO, members vote VoteApprove");
  const pay = await payOut(w, "consensual", r1.split);
  say(`   balance gained by ${[A, B, C, D].join("/")} (vote gas added back): ${pay.gained.map((g) => near(g)).join(" / ")} NEAR`);
  say(`   DAO balance change: ${near(pay.daoDelta)} NEAR (pot 10, plus the 30% gas reward the DAO contract earns)`);
  assert.deepEqual(pay.gained, pay.amounts);
  await verify(w, "consensual");

  heading(`2. D lies: truth is 10%, but ${D} rates ${A} 90 / ${B} 5 / ${C} 5`);
  const r2 = await runRound(w, "d-lies", dLiesRows(), 10n * NEAR);
  const shares = r2.split.share_bits.map(bitsToShare);
  say(`   stored split: ${r2.split.share_bits.map(pct).join(" / ")}  -> ${D} keeps ${(shares[3] * 100).toFixed(4)}% = ${near(BigInt(r2.split.amounts[3]))} NEAR`);
  assert.ok(Math.abs(shares[3] - 0.1) < 1e-12);
  await verify(w, "d-lies");

  heading("3. Cheating attempts are refused");
  await createRound(w, "guard", 10n * NEAR);
  const early = await reveal(w, "guard", w.team[0], truthfulRows()[0], "00");
  assert.ok(failedWith(early, "ERR_COMMIT_PHASE_OPEN"));
  const rows = truthfulRows();
  const salts = await commitAll(w, "guard", w.team, rows);
  assert.ok(failedWith(await reveal(w, "guard", w.team[3], [90, 5, 5, 0], salts[3]), "ERR_REVEAL_MISMATCH"));
  assert.ok(failedWith((await commit(w, "guard", w.team[0], rows[0])).r, "ERR_ALREADY_COMMITTED"));
  for (const i of [0, 1, 2]) assert.ok((await reveal(w, "guard", w.team[i], rows[i], salts[i])).succeeded);
  assert.equal(await view("get_split", { round_id: "guard" }), null);
  say("   get_split before the last reveal: null");
  await assert.rejects(view("get_reveals", { round_id: "guard" }), /ERR_NOT_FINAL/);
  say("   get_reveals before the last reveal: ERR_NOT_FINAL");
  assert.ok((await reveal(w, "guard", w.team[3], rows[3], salts[3])).succeeded);
  assert.ok(await view("get_split", { round_id: "guard" }));
  say("   after the last honest reveal the split exists");

  say("\nsandbox: all checks passed");
  if (keep) {
    writeFileSync(lastRun, JSON.stringify({ rpc: w.rpc, contract: w.contract.accountId, dao: w.dao.accountId, rounds: ["consensual", "d-lies", "guard"] }));
    say(`\nnode kept up at ${w.rpc}. In another terminal:  npm run verify -- consensual   (Ctrl-C here stops the node)`);
    await new Promise<void>((done) => ["SIGINT", "SIGTERM"].forEach((s) => process.once(s, () => done())));
  }
} catch (e) {
  failed = true;
  console.error("\nsandbox FAILED:", e);
} finally {
  rmSync(lastRun, { force: true });
  await w.worker.tearDown();
}
process.exit(failed ? 1 : 0);
