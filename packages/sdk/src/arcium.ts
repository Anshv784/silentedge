/**
 * The Arcium account maps every queueing instruction needs.
 *
 * These lists are long, order-insensitive but name-sensitive, and getting one
 * wrong fails *after* the computation has been queued and paid for. They lived
 * only in the test suite, which meant the browser and the executor would each
 * have grown their own copy — and a copy that drifts is a bug that costs real
 * fees to discover. One definition, three callers.
 */
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
} from "@arcium-hq/client";

/** Circuit names, which are also what the comp-def offsets are derived from. */
export const CIRCUIT_STORE = "store_strategy_v2";
export const CIRCUIT_EVALUATE = "evaluate_strategy_v3";

export function compDefAccount(programId: PublicKey, circuit: string): PublicKey {
  const offset = Buffer.from(getCompDefAccOffset(circuit)).readUInt32LE();
  return getCompDefAccAddress(programId, offset);
}

/**
 * A fresh, unpredictable computation offset.
 *
 * It seeds the computation account's PDA, so a collision with a live
 * computation is a failed transaction. 8 random bytes, as the Arcium examples
 * do; `crypto.getRandomValues` works in both the browser and Node 19+.
 */
export function freshComputationOffset(): bigint {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}

export type ArciumAccounts = {
  computationAccount: PublicKey;
  clusterAccount: PublicKey;
  mxeAccount: PublicKey;
  mempoolAccount: PublicKey;
  executingPool: PublicKey;
  compDefAccount: PublicKey;
};

/**
 * @param clusterOffset must match the vault program's compiled-in
 *   `EXPECTED_CLUSTER_OFFSET`. The callbacks reject any other cluster, so a
 *   mismatch here queues a computation whose result the program will refuse —
 *   paid for, and rejected.
 */
export function arciumAccounts(
  programId: PublicKey,
  clusterOffset: number,
  computationOffset: bigint,
  circuit: string
): ArciumAccounts {
  return {
    // A BN, not a bigint: the Arcium helper calls `.isNeg()` on this and a
    // bigint fails with "value.isNeg is not a function" at PDA derivation —
    // long before any transaction is built, so the error names nothing useful.
    computationAccount: getComputationAccAddress(
      clusterOffset,
      new BN(computationOffset.toString()) as never
    ),
    clusterAccount: getClusterAccAddress(clusterOffset),
    mxeAccount: getMXEAccAddress(programId),
    mempoolAccount: getMempoolAccAddress(clusterOffset),
    executingPool: getExecutingPoolAccAddress(clusterOffset),
    compDefAccount: compDefAccount(programId, circuit),
  };
}
