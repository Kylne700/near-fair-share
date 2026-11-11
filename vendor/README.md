# vendor/sputnikdao2.wasm

The official Sputnik DAO v2 contract, unmodified. It pays the Fair Share splits (one Transfer proposal per member).

- These are the exact bytes the NEAR testnet DAO factory `sputnikv2.testnet` deploys by default: contract version 3.31, commit `7764926cfd3c47f62b5fcde231c251f3c3892887` (both from the factory's `get_contracts_metadata`), source https://github.com/near-daos/sputnik-dao-contract.
- Size 539,647 bytes, sha256 `880bae9a58c99ec1efe8b10cf834b3f0c0ebc7a05d71206f3c1202c4280952da`, which is NEAR code hash `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH` (base58 of the sha256). Fetched with the RPC call `view_code` from a DAO the factory created (`unhuntable-treasury.sputnikv2.testnet`), then hashed here.
- `npm run verify` compares the code hash of the DAO on the chain with this file, so a DAO that runs anything else is a MISMATCH.
- D2 (the local sandbox only) used the older v2.0 binary (commit `5434a59`, sha256 `6e3f1814d407...`), which is not what the factory deploys today; it is replaced by this file, and the sandbox tests were re-run on it.
- License of the upstream project: see its repository. Not changed here.
- Use another build for a run: `SPUTNIK_WASM=/path/to/other.wasm npm run sandbox`.
