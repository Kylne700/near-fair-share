// npm run build:web -> docs/ (what GitHub Pages serves). The page runs the SAME files as the command line: src/rule.ts, payout.ts, chain.ts, rpc.ts
// are only stripped of their type annotations (node:module stripTypeScriptTypes) and renamed .js; node:crypto is swapped for web/crypto-shim.ts.
// test/web.test.ts rebuilds into a temp folder and fails if docs/ differs.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const SOURCES = ["src/rule.ts", "src/payout.ts", "src/chain.ts", "src/rpc.ts", "web/crypto-shim.ts", "web/app.ts"];
const COPIES: [string, string][] = [
  ["web/index.html", "index.html"],
  ["vendor/sputnikdao2.wasm", "sputnikdao2.wasm"],
  ...["deployment.json", "setup.txt", "d-lies.txt", "withhold.txt"].map((f): [string, string] => [`evidence/testnet/${f}`, `evidence/${f}`]),
];

export function buildWeb(outDir: string) {
  mkdirSync(join(outDir, "evidence"), { recursive: true });
  for (const src of SOURCES) {
    const js = stripTypeScriptTypes(readFileSync(new URL(src, root), "utf8"))
      .replace(/from "(?:\.\.?\/)+(?:src\/|web\/)?([\w-]+)\.ts"/g, 'from "./$1.js"')
      .replace('from "node:crypto"', 'from "./crypto-shim.js"');
    // the only node: import allowed to stay is the lazy node:fs one in rpc.ts, which the browser never runs (it passes vendoredCodeHash)
    if (/from "(node:|\.\.?\/[^"]*\.ts")/.test(js)) throw new Error(`${src}: an import is left that a browser cannot load`);
    writeFileSync(join(outDir, basename(src).replace(/\.ts$/, ".js")), `// generated from ${src} by scripts/build-web.ts: do not edit\n${js}`);
  }
  for (const [from, to] of COPIES) copyFileSync(new URL(from, root), join(outDir, to));
  writeFileSync(join(outDir, ".nojekyll"), "");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildWeb(join(dirname(fileURLToPath(import.meta.url)), "../docs"));
