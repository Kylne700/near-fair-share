// generated from src/rpc.ts by scripts/build-web.ts: do not edit
// Read-only JSON-RPC view calls (no accounts, no signing): works against the sandbox node and a testnet RPC, in Node and in the browser (web/).
import { wasmCodeHash } from "./chain.js";
                                                                                           

export async function view   (rpc        , accountId        , method        , args         = {})             {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "fair-share",
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: accountId, method_name: method, args_base64: btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args)))) },
    }),
  });
  const body = (await res.json())                                                                       ;
  if (!body.result || body.result.error || !body.result.result) throw new Error(`view ${accountId}.${method} failed: ${JSON.stringify(body.error ?? body.result)}`);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(body.result.result)));
}

/** base58 sha256 of the contract code deployed on an account (what NEAR calls code_hash). */
export async function codeHash(rpc        , accountId        )                  {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "fair-share", method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }),
  });
  const body = (await res.json())                                                        ;
  if (!body.result?.code_hash) throw new Error(`view_account ${accountId} failed: ${JSON.stringify(body.error ?? body.result)}`);
  return body.result.code_hash;
}

/**
 * Read one round from the Fair Share contract and the payout proposals from the round's DAO.
 * vendoredCodeHash: code hash of the official Sputnik wasm to compare with; without it Node reads vendor/sputnikdao2.wasm (the browser passes it in).
 */
export async function loadRound(rpc        , contract        , roundId        , vendoredCodeHash         )                     {
  const round = await view           (rpc, contract, "get_round", { round_id: roundId });
  const split = await view                  (rpc, contract, "get_split", { round_id: roundId });
  const reveals = split ? await view              (rpc, contract, "get_reveals", { round_id: roundId }) : null;
  const last = await view        (rpc, round.dao, "get_last_proposal_id");
  const proposals                = [];
  for (let from = 0; from < last; from += 50) proposals.push(...(await view               (rpc, round.dao, "get_proposals", { from_index: from, limit: 50 })));
  return { round, split, reveals, proposals, daoCodeHash: await codeHash(rpc, round.dao), vendoredCodeHash: vendoredCodeHash ?? wasmCodeHash((await import("node:fs")).readFileSync(new URL("../vendor/sputnikdao2.wasm", import.meta.url))) };
}
