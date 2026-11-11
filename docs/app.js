// generated from web/app.ts by scripts/build-web.ts: do not edit
// The page. It runs the repo's own code: rule.ts (fairShare, plainAverage), payout.ts (toAmounts), chain.ts (checkRound, ...), rpc.ts (loadRound).
// No wallet, no signing, no keys, no backend: the only network traffic is JSON-RPC view calls to a public testnet node and static files of this site.
import { fairShare, plainAverage } from "./rule.js";
import { toAmounts } from "./payout.js";
import { bitsToShare, checkRound, commitHash, shareBits, wasmCodeHash } from "./chain.js";
                                             
import { loadRound } from "./rpc.js";

const h = (tag        , attrs                         = {}, ...kids                   ) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};
const $ =                        (id        ) => document.getElementById(id)     ;
const pct = (x        , digits = 2) => `${(x * 100).toFixed(digits)}%`;
const usd = (cents        ) => `$${(Number(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const short = (account        ) => account.replace(/^.*-(?=[^-]+\.testnet$)/, "").replace(/\.testnet$/, ""); // fairshare-d3a-alice.testnet -> alice
const near = (yocto        ) => `${(Number(yocto / 10n ** 12n) / 1e12).toFixed(6)} NEAR`;

// ---------- 1. Try it ----------
const NAMES = "ABCDEF";
const TRUE_SPLIT                           = { 4: [40, 30, 20, 10], 5: [35, 25, 20, 12, 8], 6: [30, 25, 20, 12, 8, 5] };
let n = 4;
let who = 3; // whose ratings the sliders show
let ratings             = [];
let lies            = [];

const truth = () => TRUE_SPLIT[n];
const honestRow = (k        ) => truth().map((v, j) => (j === k ? 0 : v));
const rival = (k        ) => truth().reduce((best, v, j) => (j !== k && (best < 0 || v > truth()[best]) ? j : best), -1);
// the lie of the recorded testnet round: praise the biggest rival (90), rate everybody else 5
const lieRow = (k        ) => truth().map((_, j) => (j === k ? 0 : j === rival(k) ? 90 : 5));

function start() {
  n = Number($                   ("size").value);
  ratings = truth().map((_, k) => honestRow(k));
  lies = truth().map(() => false);
  who = n - 1;
  lies[who] = true;
  ratings[who] = lieRow(who);
  drawRaters();
  drawSliders();
}

function drawRaters() {
  const box = $("raters");
  box.replaceChildren(
    ...truth().map((_, k) => {
      const input = h("input", { type: "radio", name: "rater", id: `rater${k}`, value: String(k) })                    ;
      input.checked = k === who;
      input.addEventListener("change", () => ((who = k), drawSliders()));
      return h("label", {}, input, ` ${NAMES[k]}${lies[k] ? " (lies)" : ""}`);
    }),
  );
}

function drawSliders() {
  const name = NAMES[who];
  const r = NAMES[rival(who)];
  $("lie").onchange = () => {
    lies[who] = ($("lie")                    ).checked;
    ratings[who] = lies[who] ? lieRow(who) : honestRow(who);
    drawRaters();
    drawSliders();
  };
  ($("lie")                    ).checked = lies[who];
  $("lielabel").textContent = `${name} lies`;
  $("liehelp").textContent = `Plain average: ${name} claims 100% of the pot for ${name}. Fair Share: ${name} praises the biggest rival (${r}) with 90 and rates everybody else 5. Switched off, ${name} rates the others by the true split.`;
  $("slidersTitle").textContent = `${name} rates the others (1 to 100; only the ratios count)`;
  $("sliders").replaceChildren(
    ...truth().flatMap((_, j) => {
      if (j === who) return [];
      const id = `s${who}_${j}`;
      const out = h("output", { for: id }, String(ratings[who][j]));
      const input = h("input", { type: "range", id, min: "1", max: "100", step: "1", value: String(ratings[who][j]) })                    ;
      input.addEventListener("input", () => ((ratings[who][j] = Number(input.value)), (out.textContent = input.value), draw()));
      return [h("div", { class: "slider" }, h("label", { for: id }, `${name} rates ${NAMES[j]}`), input, out)];
    }),
  );
  draw();
}

function draw() {
  const potInput = Number($                  ("pot").value);
  const pot = BigInt(Math.round((Number.isFinite(potInput) && potInput >= 1 ? potInput : 10000) * 100));
  const shares = fairShare(ratings);
  const paid = toAmounts(shares, pot);
  const claims = truth().map((_, k) => (lies[k] ? truth().map((_, j) => (j === k ? 100 : 0)) : truth()));
  const plain = plainAverage(claims);
  const plainPaid = toAmounts(plain, pot);
  const without = fairShare(ratings.map((row, k) => (k === who ? honestRow(k) : row))); // the same team if `who` had rated honestly
  const sign = (d        ) => (Math.abs(d) < 5e-5 ? "0.00" : `${d > 0 ? "+" : "-"}${Math.abs(d * 100).toFixed(2)}`);
  const head = h("tr", {}, ...["Member", "True", "Plain average", "Fair Share", `Moved by ${NAMES[who]}`].map((t) => h("th", { scope: "col" }, t)));
  const rows = truth().map((t, j) =>
    h("tr", j === who ? { class: "hot" } : {}, h("td", {}, NAMES[j] + (j === who ? " (shown)" : "")), h("td", {}, `${t}%`), h("td", {}, `${pct(plain[j])} ${usd(plainPaid[j])}`), h("td", {}, `${pct(shares[j])} ${usd(paid[j])}`), h("td", {}, j === who ? "0.00 (own)" : `${sign(shares[j] - without[j])} pts`)),
  );
  $("result").replaceChildren($("result").querySelector("caption") , head, ...rows);
  const same = shareBits(shares[who]) === shareBits(without[who]);
  const own = $("own");
  own.className = same ? "own" : "own changed";
  own.textContent = `${NAMES[who]}'s own share: ${pct(without[who], 4)} if ${NAMES[who]} rates honestly, ${pct(shares[who], 4)} with the ratings above: ${same ? "unchanged, identical to the last bit." : "CHANGED (this would be a bug)."}`;
}

$("size").addEventListener("change", start);
$("pot").addEventListener("input", draw);
start();

// ---------- 2. Check the real testnet round ----------
const FALLBACK_RPC = "https://rpc.testnet.near.org";
const ROUNDS = [
  { id: "d-lies", about: "D rated the others 90 / 5 / 5 although the truth is 40 / 30 / 20 / 10, and still gets 10.0000%." },
  { id: "withhold", about: "D committed and never revealed: the other three are split by the rule, D loses the 0.1 NEAR bond to the DAO." },
];
                                                                   

/** Lines of evidence/<file>: `label | from -> call | hash | success | link` -> a list of links. */
async function txList(file        , title        ) {
  const text = await (await fetch(`evidence/${file}`)).text();
  const txs = text.split("\n").map((l) => l.split(" | ")).filter((f) => f.length === 5 && f[3] === "success" && f[4].startsWith("https://"));
  return h("details", {}, h("summary", {}, `${title}: ${txs.length} transactions`), h("ul", {}, ...txs.map((f) => h("li", {}, h("a", { href: f[4] }, f[0]), ` (${f[1]})`))));
}

async function readRound(dep            , vendored        , id        ) {
  let failure = "";
  for (const rpc of [dep.rpc, FALLBACK_RPC]) {
    try {
      return { rpc, data: await loadRound(rpc, dep.contract, id, vendored) };
    } catch (e) {
      failure += `${rpc}: ${e instanceof Error ? e.message.slice(0, 200) : e}\n`;
    }
  }
  throw new Error(failure);
}

async function card(dep            , vendored        , round                         ) {
  const box = h("article", { class: "card", "data-round": round.id, "data-verdict": "reading" }, h("h3", {}, `Round ${round.id}`), h("p", {}, round.about));
  try {
    const { rpc, data } = await readRound(dep, vendored, round.id);
    const { match, checks } = checkRound(data);
    $("reading").textContent = `Reading contract ${dep.contract} at ${rpc}`;
    const head = h("tr", {}, ...["Member", "Chain", "Here", "Paid", "Check"].map((t) => h("th", { scope: "col" }, t)));
    const rows = data.round.members.flatMap((m, i) => {
      let verdict = "MISMATCH";
      let recomputed = "-";
      let amount = "-";
      let rated = "no reveal";
      try {
        const split = data.split ;
        const rev = data.reveals [i];
        const shares = fairShare(data.reveals .map((r) => r.ratings));
        const amounts = toAmounts(shares, BigInt(data.round.pot));
        const commitOk = !rev.revealed || commitHash(data.round.round_id, m, rev.ratings, rev.salt) === rev.commit;
        recomputed = pct(shares[i], 4);
        amount = near(amounts[i]).replace(" NEAR", "");
        rated = rev.revealed ? `rated ${rev.ratings.filter((_, j) => j !== i).join(" / ")}` : "no reveal, bond lost";
        if (commitOk && shareBits(shares[i]) === split.share_bits[i] && amounts[i].toString() === split.amounts[i]) verdict = "MATCH";
      } catch { /* stays MISMATCH */ }
      const stored = data.split ? pct(bitsToShare(data.split.share_bits[i]), 4) : "-";
      return [
        h("tr", { class: "top" }, h("td", {}, h("code", { title: m }, short(m))), h("td", {}, stored), h("td", {}, recomputed), h("td", {}, amount), h("td", { class: verdict }, verdict)),
        h("tr", {}, h("td", { colspan: "5", class: "note" }, rated)),
      ];
    });
    const list = (c       ) => h("li", {}, h("span", { class: c.ok ? "ok" : "FAIL" }, c.ok ? "ok " : "FAIL "), `${c.name}: `, h("code", {}, c.detail));
    box.setAttribute("data-verdict", match ? "MATCH" : "MISMATCH");
    box.append(
      h("p", {}, h("span", { class: `verdict ${match ? "MATCH" : "MISMATCH"}` }, `${match ? "MATCH" : "MISMATCH"} ${round.id}`), ` ${checks.filter((c) => c.ok).length} of ${checks.length} checks ok`),
      h("div", { class: "scroll" }, h("table", {}, h("caption", {}, "Each member. Chain = share stored by the contract. Here = share this page recomputes from the revealed ratings. Paid = NEAR amount stored."), head, ...rows)),
      h("p", { class: "note" }, "Accounts: ", ...data.round.members.flatMap((m) => [h("code", {}, `${short(m)} = ${m}`), "; "])),
      h("details", {}, h("summary", {}, "All checks (the same list as npm run verify)"), h("ul", {}, ...checks.map(list))),
      await txList(`${round.id}.txt`, "Transactions of this round"),
    );
  } catch (e) {
    box.setAttribute("data-verdict", "ERROR");
    box.append(h("p", {}, h("span", { class: "verdict ERROR" }, "Could not read the chain"), " Nothing was compared, so this is neither MATCH nor MISMATCH. ", h("code", {}, e instanceof Error ? e.message.slice(0, 300) : String(e))));
  }
  return box;
}

async function checkChain() {
  const button = $                   ("recheck");
  button.disabled = true;
  $("reading").textContent = "Reading the testnet ...";
  try {
    const dep = (await (await fetch("evidence/deployment.json")).json())              ;
    const vendored = wasmCodeHash(new Uint8Array(await (await fetch("sputnikdao2.wasm")).arrayBuffer()));
    $("rounds").replaceChildren(...(await Promise.all(ROUNDS.map((r) => card(dep, vendored, r)))));
    $("setup").replaceChildren(await txList("setup.txt", "Setup: deploy the contract, create the team DAO"));
  } catch (e) {
    $("rounds").replaceChildren(h("p", {}, `Could not start the check: ${e instanceof Error ? e.message : e}`));
  }
  button.disabled = false;
}
$("recheck").addEventListener("click", checkChain);
checkChain();
