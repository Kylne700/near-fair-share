import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash as nodeHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "../web/crypto-shim.ts";
import { base58 } from "../src/chain.ts";
import { buildWeb } from "../scripts/build-web.ts";

test("browser sha256 equals node:crypto, including the padding edges", () => {
  for (const len of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 100_000]) {
    const bytes = randomBytes(len);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), nodeHash("sha256").update(bytes).digest("hex"), `length ${len}`);
  }
  assert.equal(createHash("sha256").update("fair-share/v1|").update("round").digest("hex"), nodeHash("sha256").update("fair-share/v1|round").digest("hex"));
});

test("the page hashes the vendored Sputnik wasm to the code hash recorded on testnet", () => {
  const wasm = readFileSync(new URL("../vendor/sputnikdao2.wasm", import.meta.url));
  const deployment = JSON.parse(readFileSync(new URL("../evidence/testnet/deployment.json", import.meta.url), "utf8"));
  assert.equal(base58(createHash("sha256").update(wasm).digest() as Uint8Array), deployment.daoCodeHash);
});

test("docs/ is exactly what `npm run build:web` produces (the page runs the repo's own code)", () => {
  const out = mkdtempSync(join(tmpdir(), "fs-web-"));
  buildWeb(out);
  const files = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length)).sort();
  const docs = new URL("../docs", import.meta.url).pathname;
  assert.deepEqual(files(docs), files(out));
  for (const f of files(out)) assert.ok(readFileSync(join(docs, f)).equals(readFileSync(join(out, f))), `docs${f} differs: run npm run build:web`);
});
