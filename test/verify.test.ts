// checkRound (what `npm run verify` prints MATCH or MISMATCH from) on hand-made chain data: no node needed.
// The honest data must match, and every single tampering must be caught.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRound, commitHash, proposalDescription, shareBits, splitHash, transferKind } from "../src/chain.ts";
import type { ChainData, DaoProposal } from "../src/chain.ts";
import { toAmounts, YOCTO_PER_NEAR as NEAR } from "../src/payout.ts";
import { fairShare } from "../src/rule.ts";

const TRUTH = [40, 30, 20, 10];
const rows = TRUTH.map((_, k) => TRUTH.map((v, j) => (j === k ? 0 : v)));
const members = ["a.near", "b.near", "c.near", "d.near"];

/** What the contract and the DAO would hold for an honest round "r1". */
function honest(pot = 10n * NEAR): ChainData {
  const salts = members.map((_, i) => `salt${i}`);
  const commits = members.map((m, i) => commitHash("r1", m, rows[i], salts[i]));
  const shares = fairShare(rows);
  const share_bits = shares.map(shareBits);
  const amounts = toAmounts(shares, pot);
  const hash = splitHash("r1", pot, members, share_bits, amounts);
  const proposals: DaoProposal[] = [];
  members.forEach((m, i) => {
    if (amounts[i] > 0n) proposals.push({ id: proposals.length, proposer: "relay.near", description: proposalDescription("r1", hash, m), kind: { Transfer: { ...transferKind(m, amounts[i]).Transfer, msg: null } }, status: "Approved" });
  });
  return {
    round: { round_id: "r1", creator: "relay.near", dao: "dao.near", pot: pot.toString(), members, commit_until_ms: "1", reveal_until_ms: "2", status: "final", commits, revealed: members.map(() => true) },
    split: { round_id: "r1", members, pot: pot.toString(), share_bits, amounts: amounts.map(String), hash },
    reveals: members.map((m, i) => ({ member: m, commit: commits[i], ratings: rows[i], salt: salts[i] })),
    proposals,
  };
}
const failing = (d: ChainData) => checkRound(d).checks.filter((c) => !c.ok).map((c) => c.name);
const clone = (d: ChainData): ChainData => structuredClone(d);

test("honest data: MATCH, with every check ok", () => {
  const r = checkRound(honest());
  assert.equal(r.match, true);
  assert.equal(r.checks.length, 6);
  assert.deepEqual(r.checks.filter((c) => !c.ok), []);
});

test("honest data before any DAO proposal exists: MATCH on the split alone", () => {
  const d = honest();
  d.proposals = [];
  const r = checkRound(d);
  assert.equal(r.match, true);
  assert.match(r.checks.at(-1)!.detail, /none created yet/);
});

test("proposals still in progress are fine; rejected or expired ones are not", () => {
  const d = honest();
  d.proposals[0].status = "InProgress";
  assert.equal(checkRound(d).match, true);
  d.proposals[0].status = "Rejected";
  assert.deepEqual(failing(d), ["DAO proposals match the stored split"]);
});

test("a changed share bit is caught (the recomputed split differs)", () => {
  const d = clone(honest());
  d.split!.share_bits[0] = (BigInt("0x" + d.split!.share_bits[0]) + 1n).toString(16).padStart(16, "0");
  assert.ok(failing(d).includes("split recomputed from the revealed ratings (bit for bit)"));
  assert.ok(failing(d).includes("split hash recomputed"));
});

test("moving one yocto between members is caught, even if the sum and the hash are fixed up", () => {
  const d = clone(honest());
  const a = d.split!.amounts.map(BigInt);
  a[0] -= 1n;
  a[1] += 1n;
  d.split!.amounts = a.map(String);
  d.split!.hash = splitHash("r1", 10n * NEAR, members, d.split!.share_bits, a);
  assert.deepEqual(failing(d).slice(0, 1), ["amounts recomputed and sum exactly to the pot"]);
});

test("amounts that do not add up to the pot are caught", () => {
  const d = clone(honest());
  d.split!.amounts[3] = (BigInt(d.split!.amounts[3]) + 1n).toString();
  assert.ok(failing(d).includes("amounts recomputed and sum exactly to the pot"));
});

test("a reveal that does not open its commit is caught (wrong salt, or ratings changed)", () => {
  const d = clone(honest());
  d.reveals![2].salt = "other";
  assert.ok(failing(d).includes("every reveal matches its commit (sha256 recomputed)"));
  const e = clone(honest());
  e.reveals![3].ratings = [90, 5, 5, 0];
  assert.ok(failing(e).includes("every reveal matches its commit (sha256 recomputed)"));
  assert.ok(failing(e).includes("split recomputed from the revealed ratings (bit for bit)")); // and the stored split is not what these ratings give
});

test("DAO side: a missing, a doubled, a wrong-amount, a wrong-payee, a stale-hash and a stray proposal are all caught", () => {
  const dao = "DAO proposals match the stored split";
  const missing = clone(honest());
  missing.proposals.pop();
  assert.deepEqual(failing(missing), [dao]);

  const doubled = clone(honest());
  doubled.proposals.push({ ...doubled.proposals[0], id: 9 });
  assert.deepEqual(failing(doubled), [dao]);

  const wrongAmount = clone(honest());
  (wrongAmount.proposals[1].kind as { Transfer: { amount: string } }).Transfer.amount = (3n * NEAR + 1n).toString();
  assert.deepEqual(failing(wrongAmount), [dao]);

  const wrongPayee = clone(honest());
  (wrongPayee.proposals[1].kind as { Transfer: { receiver_id: string } }).Transfer.receiver_id = "thief.near";
  assert.deepEqual(failing(wrongPayee), [dao]);

  const staleHash = clone(honest());
  staleHash.proposals[0].description = proposalDescription("r1", "0".repeat(64), "a.near");
  assert.deepEqual(failing(staleHash), [dao]);

  const stray = clone(honest());
  stray.proposals.push({ id: 7, proposer: "x.near", description: "fair-share round=r1 extra payout", kind: transferKind("x.near", 1n), status: "InProgress" });
  assert.deepEqual(failing(stray), [dao]);

  const otherRound = clone(honest());
  otherRound.proposals.push({ id: 8, proposer: "x.near", description: "something else entirely", kind: transferKind("x.near", 1n), status: "Approved" });
  assert.equal(checkRound(otherRound).match, true, "proposals that are not about this round are ignored");
});

test("a round that is not final has nothing to verify", () => {
  const d = clone(honest());
  d.split = null;
  d.reveals = null;
  d.round.status = "reveal";
  const r = checkRound(d);
  assert.equal(r.match, false);
  assert.equal(r.checks.length, 1);
});

test("a tiny pot: a member whose amount is 0 gets no proposal, and one would be a mismatch", () => {
  const d = honest(1n);
  assert.deepEqual(d.split!.amounts.map(BigInt).filter((a) => a > 0n).length, d.proposals.length);
  assert.ok(d.proposals.length < 4);
  assert.equal(checkRound(d).match, true);
  const e = clone(d);
  const zero = e.split!.amounts.findIndex((a) => a === "0");
  e.proposals.push({ id: 5, proposer: "relay.near", description: proposalDescription("r1", e.split!.hash, members[zero]), kind: transferKind(members[zero], 0n), status: "Approved" });
  assert.deepEqual(failing(e), ["DAO proposals match the stored split"]);
});
