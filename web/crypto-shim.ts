// Stands in for node:crypto in the browser build (scripts/build-web.ts rewrites the import). src/chain.ts needs SHA-256 synchronously and
// crypto.subtle is async, so this is a plain SHA-256. Only createHash("sha256").update(...).digest(...) is supported.
// test/web.test.ts compares it with node:crypto, including the 55/56/63/64/65-byte padding edges.

const primes: number[] = [];
for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
const frac32 = (x: number) => Math.floor((x - Math.floor(x)) * 2 ** 32);
const K = primes.map((p) => frac32(Math.cbrt(p))); // first 32 bits of the fractional parts of the cube roots of the first 64 primes
const H0 = primes.slice(0, 8).map((p) => frac32(Math.sqrt(p))); // ... square roots of the first 8 primes

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256(data: Uint8Array): Uint8Array {
  const total = Math.ceil((data.length + 9) / 64) * 64;
  const padded = new Uint8Array(total);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(total - 8, Math.floor(data.length / 2 ** 29)); // bit length, high word
  dv.setUint32(total - 4, (data.length * 8) >>> 0); // low word
  const h = Uint32Array.from(H0);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + 4 * i);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] += v));
  }
  const out = new Uint8Array(32);
  h.forEach((v, i) => new DataView(out.buffer).setUint32(4 * i, v));
  return out;
}

export function createHash(algorithm: string) {
  if (algorithm !== "sha256") throw new Error(`only sha256 is supported, got ${algorithm}`);
  const parts: Uint8Array[] = [];
  const hash = {
    update(data: string | Uint8Array) {
      parts.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
      return hash;
    },
    digest(encoding?: "hex"): Uint8Array | string {
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      parts.reduce((at, p) => (all.set(p, at), at + p.length), 0);
      const out = sha256(all);
      return encoding === "hex" ? Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("") : out;
    },
  };
  return hash;
}
