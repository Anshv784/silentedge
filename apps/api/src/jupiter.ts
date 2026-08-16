/**
 * A Jupiter route, constrained so the swap instruction fits inside a CPI.
 *
 * CPI forfeits address lookup tables, so every account the route touches has to
 * fit in the transaction's own list. Unconstrained, a USDC/SOL route carries 43
 * accounts — 1,376 bytes of keys alone, past the 1,232-byte transaction limit
 * before the vault's own accounts are added. `onlyDirectRoutes` is what bounds
 * it, at a cost measured at ~0.04 bps (RESEARCH §4.3).
 */
import type { PublicKey } from "@solana/web3.js";

const BUILD_URL = "https://api.jup.ag/swap/v2/build";

export type SwapInstruction = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};

export async function fetchRoute(opts: {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: bigint;
  taker: PublicKey;
  slippageBps?: number;
}): Promise<SwapInstruction> {
  const url =
    `${BUILD_URL}?inputMint=${opts.inputMint.toBase58()}` +
    `&outputMint=${opts.outputMint.toBase58()}` +
    `&amount=${opts.amount}` +
    `&taker=${opts.taker.toBase58()}` +
    `&maxAccounts=24&onlyDirectRoutes=true` +
    // Keep proceeds as wSOL in the vault's ATA. Unwrapping closes that account
    // and sends native SOL, which the program's post-swap balance assertion
    // would reject — correctly, since that is not where vault funds belong.
    `&wrapAndUnwrapSol=false` +
    `&slippageBps=${opts.slippageBps ?? 100}`;

  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url);
    if (r.status === 429 && attempt < 4) {
      await new Promise((res) => setTimeout(res, 2_000 * (attempt + 1)));
      continue;
    }
    if (!r.ok) throw new Error(`jupiter /build ${r.status}: ${await r.text()}`);
    const j: any = await r.json();
    if (!j.swapInstruction) {
      throw new Error(`no route: ${JSON.stringify(j).slice(0, 160)}`);
    }
    return j.swapInstruction as SwapInstruction;
  }
}
