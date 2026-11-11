// npm run test:contract: Rust unit tests of the contract + parity of contract/src/rule.rs with src/rule.ts on 9,000 profiles.
// Needs rustc 1.86 (rustup toolchain, like the Sputnik repo). Build output goes to /tmp, never into the repo.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const target = process.env.CARGO_TARGET_DIR ?? "/tmp/near-fs-target";
const vectors = `${target}/vectors.json`;
mkdirSync(target, { recursive: true });
const run = (cmd: string, args: string[], env = {}) => execFileSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
run("node", [new URL("./gen-vectors.ts", import.meta.url).pathname, vectors]);
run("cargo", ["+1.86.0", "test", "--locked", "--manifest-path", new URL("../contract/Cargo.toml", import.meta.url).pathname], { CARGO_TARGET_DIR: target, VECTORS: vectors, CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS: "fallback" });
