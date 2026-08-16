/**
 * Strategy encryption.
 *
 * Two things are being checked, and the second matters more:
 *
 *   1. the ciphertext round-trips — encryption that silently produces garbage
 *      still looks like it works;
 *   2. the plaintext does not survive anywhere it should not — not in the
 *      ciphertext, not in the account, not in the transaction.
 *
 * A privacy claim that has never been checked against the actual bytes is a
 * hope, not a property.
 */

import { expect } from "chai";
import { x25519 } from "@arcium-hq/client";
import {
  encryptStrategy,
  decryptStrategy,
  decryptStrategyWithMxeKey,
  deriveEncryptionKeypair,
  nonceToU128,
  u128ToNonce,
} from "@silentedge/sdk";
import { normalize, type Strategy } from "@silentedge/types";

const MAX_SIZE_BPS = 1_000;

const secretDraft = (): Strategy => ({
  name: "Range trade",
  rules: [
    { kind: "entry", value: "150" },
    { kind: "exit", value: "180.5" },
    { kind: "stop", value: "120" },
  ],
  sizeBps: 1_000,
});

/** What the ciphertext actually covers. `sizeBps` is public and not encrypted. */
function encryptedPartOf(s: any) {
  const { sizeBps, ...rest } = s;
  return rest;
}

/** Stands in for the MXE cluster until a real one is deployed. */
function fakeMxeKeypair() {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

describe("encryptStrategy", () => {
  it("produces one 32-byte ciphertext per circuit field", () => {
    const mxe = fakeMxeKeypair();
    const e = encryptStrategy(normalize(secretDraft(), MAX_SIZE_BPS), mxe.publicKey);

    // Three, not four. `sizeBps` left the encrypted struct because a single
    // trade recovers it exactly from public data — THREAT_MODEL T-38.
    expect(e.ciphertexts).to.have.length(3);
    for (const ct of e.ciphertexts) expect(ct).to.have.length(32);
    expect(e.nonce).to.have.length(16);
    expect(e.encryptionPublicKey).to.have.length(32);
  });

  it("round-trips through the MXE's private key", () => {
    const mxe = fakeMxeKeypair();
    const normalized = normalize(secretDraft(), MAX_SIZE_BPS);
    const decrypted = decryptStrategyWithMxeKey(
      encryptStrategy(normalized, mxe.publicKey),
      mxe.privateKey
    );
    expect(decrypted).to.deep.equal(encryptedPartOf(normalized));
  });

  /**
   * Nonce reuse would make identical strategies encrypt to identical bytes —
   * enough for an observer to tell that a strategy did not change, without
   * ever reading it. Holds even with a stable derived key.
   */
  it("never repeats a ciphertext, even with the same key", () => {
    const mxe = fakeMxeKeypair();
    const normalized = normalize(secretDraft(), MAX_SIZE_BPS);
    const stableKey = x25519.utils.randomSecretKey();

    const seen = new Set<string>();
    const nonces = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const e = encryptStrategy(normalized, mxe.publicKey, stableKey);
      seen.add(Buffer.from(e.ciphertexts[0]).toString("hex"));
      nonces.add(Buffer.from(e.nonce).toString("hex"));
    }
    expect(seen.size, "ciphertexts repeated").to.equal(20);
    expect(nonces.size, "nonces repeated").to.equal(20);
  });

  /**
   * The user must be able to read their own strategy back. With a purely
   * ephemeral key only the MXE could ever decrypt it.
   */
  it("lets the user decrypt their own strategy with a derived key", async () => {
    const mxe = fakeMxeKeypair();
    const normalized = normalize(secretDraft(), MAX_SIZE_BPS);

    // A wallet signature is deterministic for a given message and key.
    const fakeSignature = new Uint8Array(64).fill(7);
    const user = await deriveEncryptionKeypair(async () => fakeSignature);

    const e = encryptStrategy(normalized, mxe.publicKey, user.privateKey);
    expect(decryptStrategy(e, user.privateKey, mxe.publicKey))
      .to.deep.equal(encryptedPartOf(normalized));
    // The MXE side still works from the other direction.
    expect(decryptStrategyWithMxeKey(e, mxe.privateKey))
      .to.deep.equal(encryptedPartOf(normalized));
  });

  it("derives the same key from the same signature", async () => {
    const sig = new Uint8Array(64).fill(3);
    const a = await deriveEncryptionKeypair(async () => sig);
    const b = await deriveEncryptionKeypair(async () => sig);
    expect(Buffer.from(a.publicKey)).to.deep.equal(Buffer.from(b.publicKey));

    const other = await deriveEncryptionKeypair(async () => new Uint8Array(64).fill(4));
    expect(Buffer.from(a.publicKey)).to.not.deep.equal(Buffer.from(other.publicKey));
  });

  /**
   * The values are small integers, so a weak cipher would leave them lying in
   * the output. Check the bytes directly rather than trusting the library.
   */
  it("leaves no plaintext value recoverable from the ciphertext", () => {
    const mxe = fakeMxeKeypair();
    const normalized = normalize(secretDraft(), MAX_SIZE_BPS);
    const e = encryptStrategy(normalized, mxe.publicKey);
    const blob = Buffer.concat(e.ciphertexts.map((c) => Buffer.from(c)));

    for (const value of [
      normalized.entryBelow,
      normalized.exitAbove,
      normalized.stopBelow,
      BigInt(normalized.sizeBps),
    ]) {
      // Both endiannesses, since "not present" should hold either way.
      const le = Buffer.alloc(16);
      const be = Buffer.alloc(16);
      let v = value;
      for (let i = 0; i < 16; i++) {
        le[i] = Number(v & 0xffn);
        be[15 - i] = Number(v & 0xffn);
        v >>= 8n;
      }
      expect(blob.includes(le.subarray(0, 8)), `LE ${value} found`).to.equal(false);
      expect(blob.includes(be.subarray(8)), `BE ${value} found`).to.equal(false);
    }
  });

  it("rejects a malformed MXE public key", () => {
    const normalized = normalize(secretDraft(), MAX_SIZE_BPS);
    expect(() => encryptStrategy(normalized, new Uint8Array(31))).to.throw(/32 bytes/);
  });

  it("decrypts to nonsense under the wrong key", () => {
    const mxe = fakeMxeKeypair();
    const wrong = fakeMxeKeypair();
    const normalized = normalize(secretDraft(), MAX_SIZE_BPS);
    const e = encryptStrategy(normalized, mxe.publicKey);

    const decrypted = decryptStrategyWithMxeKey(e, wrong.privateKey);
    expect(decrypted.entryBelow).to.not.equal(normalized.entryBelow);
  });
});

describe("nonce encoding", () => {
  it("round-trips through the on-chain u128 representation", () => {
    for (let i = 0; i < 50; i++) {
      const nonce = new Uint8Array(16);
      crypto.getRandomValues(nonce);
      expect(u128ToNonce(nonceToU128(nonce))).to.deep.equal(nonce);
    }
  });

  it("keeps the value inside u128", () => {
    const max = new Uint8Array(16).fill(0xff);
    expect(nonceToU128(max)).to.equal(2n ** 128n - 1n);
  });

  it("rejects a wrong-length nonce", () => {
    expect(() => nonceToU128(new Uint8Array(8))).to.throw(/16 bytes/);
  });
});
