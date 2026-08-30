import { RescueCipher, x25519 } from "@arcium-hq/client";
import type { NormalizedStrategy } from "@silentedge/types";

/**
 * Client-side strategy encryption.
 *
 * Runs in the browser and nowhere else. The plaintext strategy exists in page
 * memory, is encrypted, and only the ciphertext leaves — no server, ours or
 * anyone's, is ever in a position to read it. That is the entire privacy claim
 * of the product, so this module is deliberately small enough to audit at a
 * glance.
 *
 * Mechanism (current Arcium SDK, verified against the docs):
 *
 *   1. generate an ephemeral x25519 keypair
 *   2. derive a shared secret against the MXE cluster's x25519 public key
 *   3. encrypt the four strategy scalars with RescueCipher under a fresh nonce
 *
 * The MXE derives the same secret from its own private key and the submitted
 * public key. Neither half of the exchange is ever stored anywhere we control.
 */

/**
 * Domain-separated message signed to derive a user's encryption key.
 *
 * Changing this string changes every user's key and orphans every strategy
 * already on chain. It is versioned for that reason.
 */
export const KEY_DERIVATION_MESSAGE =
  "SilentEdge strategy encryption key v1";

/**
 * Derive the encryption keypair from a wallet signature.
 *
 * Deterministic rather than ephemeral, so a user can always recover the key by
 * signing the same message again — with an ephemeral key they could never read
 * their own strategy back, because only the MXE would hold the other half.
 *
 * The alternative is storing a key in the browser, which is a private key on
 * disk in exchange for saving one signature. Deriving costs nothing at rest.
 *
 * The stable public key does not leak: submissions are already linked by the
 * vault PDA, which is derived from the owner's address.
 */
export async function deriveEncryptionKeypair(
  signMessage: (message: Uint8Array) => Promise<Uint8Array>
): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array }> {
  const signature = await signMessage(
    new TextEncoder().encode(KEY_DERIVATION_MESSAGE)
  );
  // x25519 clamps the scalar internally, so any 32 bytes are a valid secret.
  const digest = await crypto.subtle.digest("SHA-256", signature as unknown as ArrayBuffer);
  const privateKey = new Uint8Array(digest);
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

/** Field order. Must match the Arcis struct exactly — a mismatch silently corrupts. */
export const STRATEGY_FIELD_ORDER = [
  "entryBelow",
  "exitAbove",
  "stopBelow",
] as const;

/**
 * `sizeBps` is deliberately absent. It is a public vault setting, not an
 * encrypted field: the traded amount and the vault balance are both public in
 * the same transaction, so their ratio recovers it exactly from one trade.
 * See SECURITY.md T-38.
 */

/** What the ciphertext actually covers — `sizeBps` is public and not in here. */
export type EncryptedFields = Omit<NormalizedStrategy, "sizeBps">;

export type EncryptedStrategy = {
  /** One 32-byte ciphertext per scalar, in circuit field order. */
  ciphertexts: Uint8Array[];
  /** 16 bytes. Fresh per encryption — never reuse. */
  nonce: Uint8Array;
  /** The ephemeral x25519 public key the MXE needs to derive the shared secret. */
  encryptionPublicKey: Uint8Array;
};

/** 16 random bytes from the platform CSPRNG. Works in browsers and Node 19+. */
function freshNonce(): Uint8Array {
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  return nonce;
}

/**
 * Encrypt a normalized strategy for an MXE cluster.
 *
 * `privateKey` should come from `deriveEncryptionKeypair` so the user can
 * decrypt their own strategy later; omit it for a one-way ephemeral key.
 *
 * The nonce is always fresh regardless. Reusing a nonce would make identical
 * strategies encrypt to identical bytes — enough to tell an observer that a
 * strategy did not change, without ever reading it.
 */
export function encryptStrategy(
  strategy: NormalizedStrategy,
  mxePublicKey: Uint8Array,
  privateKey: Uint8Array = x25519.utils.randomSecretKey()
): EncryptedStrategy {
  if (mxePublicKey.length !== 32) {
    throw new Error("MXE public key must be 32 bytes");
  }

  const encryptionPublicKey = x25519.getPublicKey(privateKey);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);

  const nonce = freshNonce();
  const plaintext: bigint[] = [
    strategy.entryBelow,
    strategy.exitAbove,
    strategy.stopBelow,
  ];

  // The SDK works in number[][]; expose Uint8Array so callers deal in bytes.
  const ciphertexts = new RescueCipher(sharedSecret)
    .encrypt(plaintext, nonce)
    .map((c) => Uint8Array.from(c));

  return { ciphertexts, nonce, encryptionPublicKey };
}

/** Decrypt a strategy with the user's own derived key. */
export function decryptStrategy(
  encrypted: EncryptedStrategy,
  userPrivateKey: Uint8Array,
  mxePublicKey: Uint8Array
): EncryptedFields {
  const sharedSecret = x25519.getSharedSecret(userPrivateKey, mxePublicKey);
  const values = new RescueCipher(sharedSecret).decrypt(
    encrypted.ciphertexts.map((c) => Array.from(c)),
    encrypted.nonce
  );
  return {
    entryBelow: values[0],
    exitAbove: values[1],
    stopBelow: values[2],
  };
}

/**
 * Decrypt with the MXE's private key. Test-only.
 *
 * Exists so the round trip can be asserted rather than assumed — an encryption
 * routine that silently produces garbage still looks like it works.
 */
export function decryptStrategyWithMxeKey(
  encrypted: EncryptedStrategy,
  mxePrivateKey: Uint8Array
): EncryptedFields {
  const sharedSecret = x25519.getSharedSecret(
    mxePrivateKey,
    encrypted.encryptionPublicKey
  );
  const values = new RescueCipher(sharedSecret).decrypt(
    encrypted.ciphertexts.map((c) => Array.from(c)),
    encrypted.nonce
  );

  return {
    entryBelow: values[0],
    exitAbove: values[1],
    stopBelow: values[2],
  };
}

/** The nonce is a u128 on chain; the SDK produces 16 bytes. */
export function nonceToU128(nonce: Uint8Array): bigint {
  if (nonce.length !== 16) throw new Error("nonce must be 16 bytes");
  let value = 0n;
  for (let i = nonce.length - 1; i >= 0; i--) {
    value = (value << 8n) | BigInt(nonce[i]);
  }
  return value;
}

export function u128ToNonce(value: bigint): Uint8Array {
  const nonce = new Uint8Array(16);
  let v = value;
  for (let i = 0; i < 16; i++) {
    nonce[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return nonce;
}
