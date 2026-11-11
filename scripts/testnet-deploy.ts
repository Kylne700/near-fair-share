// npm run testnet:deploy   -- PREPARED, NOT RUN in D2. Deploying signs transactions on the NEAR TESTNET, which needs the owner's yes.
// Refuses to do anything unless NEAR_TESTNET_OK=1. Needs NEAR_ACCOUNT_ID (a testnet account the owner provides) and
// NEAR_KEY_FILE (path of a file that holds its private key, "ed25519:..."; the key is read, never printed).
// It creates fairshare.<account> and dao.<account>, deploys contract/fair_share.wasm and the
// vendored official Sputnik DAO v2 wasm, and initialises both (same calls as sandbox/harness.ts startWorld).
if (process.env.NEAR_TESTNET_OK !== "1") {
  console.error("testnet:deploy refused: it would sign transactions on the NEAR testnet.\nSet NEAR_TESTNET_OK=1 only after the owner has said yes (and set NEAR_ACCOUNT_ID, NEAR_KEY_FILE).");
  process.exit(2);
}
process.exit(await main());

async function main(): Promise<number> {
  const { readFileSync } = await import("node:fs");
  const { connect, keyStores, KeyPair } = await import("near-api-js");
  const { daoPolicy } = await import("../src/chain.ts");
  const { YOCTO_PER_NEAR: NEAR } = await import("../src/payout.ts");
  const id = process.env.NEAR_ACCOUNT_ID;
  const keyFile = process.env.NEAR_KEY_FILE;
  if (!id || !keyFile || !id.endsWith(".testnet")) {
    console.error("set NEAR_ACCOUNT_ID (a .testnet account) and NEAR_KEY_FILE");
    return 2;
  }
  const members = (process.env.NEAR_MEMBERS ?? "").split(",").filter(Boolean);
  if (members.length < 4) {
    console.error("set NEAR_MEMBERS to at least 4 comma-separated testnet account ids (the DAO council = the team)");
    return 2;
  }
  const key = KeyPair.fromString(readFileSync(keyFile, "utf8").trim() as `ed25519:${string}`);
  const keyStore = new keyStores.InMemoryKeyStore();
  const subs = { fairshare: `fairshare.${id}`, dao: `dao.${id}` };
  for (const a of [id, ...Object.values(subs)]) await keyStore.setKey("testnet", a, key); // the sub-accounts get the same key
  // tsc 7 does not see networkId in near-api-js 5.1.1's ConnectConfig (it is required at runtime), hence the cast
  const near = await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org", keyStore } as never);
  const owner = await near.account(id);
  const wasm = (rel: string) => readFileSync(new URL(rel, import.meta.url));
  for (const [name, file, amount] of [["fairshare", "../contract/fair_share.wasm", 5n * NEAR], ["dao", "../vendor/sputnikdao2.wasm", 8n * NEAR]] as const) {
    await owner.createAccount(subs[name], key.getPublicKey(), amount);
    await (await near.account(subs[name])).deployContract(wasm(file));
    console.log(`deployed ${file.split("/").pop()} to ${subs[name]}`);
  }
  const gas = 100_000_000_000_000n;
  await (await near.account(subs.fairshare)).functionCall({ contractId: subs.fairshare, methodName: "new", args: {}, gas });
  await (await near.account(subs.dao)).functionCall({
    contractId: subs.dao, methodName: "new", gas,
    args: { config: { name: "fair-share-team", purpose: "pays Fair Share splits", metadata: "" }, policy: daoPolicy(members) },
  });
  console.log(`contract ${subs.fairshare}  dao ${subs.dao}`);
  return 0;
}
