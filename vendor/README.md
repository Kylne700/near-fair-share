# vendor/sputnikdao2.wasm

The official Sputnik DAO v2 contract, unmodified. It pays the Fair Share splits (one Transfer proposal per member).

- Source: https://github.com/near-daos/sputnik-dao-contract, commit `5434a59dec23ee0c49df8c8c4350c208a7e75b0b`, file `sputnikdao2_original.wasm` at the repo root (the deployed v2 binary).
- Size 469,723 bytes, sha256 `6e3f1814d40769d8f57b9a7af689d22aaab96d3232cec4d861311829c1d2318f`. Check with `sha256sum vendor/sputnikdao2.wasm`.
- License of the upstream project: see its repository. Not changed here.
- Only used in the local sandbox so far. This is the deployed v2 binary, not the head source (2.3.1): it is NOT VERIFIED that the code the NEAR testnet DAO factory deploys by default behaves the same for `add_proposal` / `act_proposal` as this file.
- Use another build for a run: `SPUTNIK_WASM=/path/to/other.wasm npm run sandbox`.
