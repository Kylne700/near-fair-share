// Builds contract/fair_share.wasm (committed, so `npm test` needs no Rust). usage: npm run build:contract
// Why the extra steps: nearcore rejects the sign-ext / multivalue / reference-types / bulk-memory wasm that rustc emits,
// so wasm-opt lowers them (same job cargo-near does). Toolchain: rustc 1.86 (like the Sputnik repo), build dir /tmp.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL("..", import.meta.url).pathname;
const target = process.env.CARGO_TARGET_DIR ?? "/tmp/near-fs-target";
const run = (cmd: string, args: string[], env = {}) => execFileSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });

run(
  "cargo",
  ["+1.86.0", "build", "--locked", "--manifest-path", join(here, "contract/Cargo.toml"), "--target", "wasm32-unknown-unknown", "--release"],
  // --cfg near: without it near-sdk-env compiles panic_str/sha256 as plain Rust, so an ERR_ code would reach the caller as a bare trap
  { CARGO_TARGET_DIR: target, CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS: "fallback", RUSTFLAGS: "--cfg near" },
);
const raw = join(target, "wasm32-unknown-unknown/release/fair_share.wasm");
const tmp = mkdtempSync(join(tmpdir(), "fs-wasm-"));
const mid = join(tmp, "mid.wasm");
const out = join(here, "contract/fair_share.wasm");
const opt = (args: string[]) => run("npx", ["--yes", "--package=binaryen@132.0.0", "--", "wasm-opt", ...args]);
opt([raw, "--enable-sign-ext", "--enable-multivalue", "--enable-reference-types", "--enable-mutable-globals", "--enable-bulk-memory", "--signext-lowering", "--llvm-memory-copy-fill-lowering", "-o", mid]);
opt([mid, "--mvp-features", "-Oz", "-o", out]);
console.log(`${out} ${statSync(out).size} bytes sha256 ${createHash("sha256").update(readFileSync(out)).digest("hex")}`);
