/**
 * The executor: the thing that makes the vault a *bot* rather than a set of
 * instructions somebody could call.
 *
 * It discovers vaults, queues evaluations, and spends the authorizations those
 * evaluations produce. It holds one keypair, which pays fees.
 *
 * # What it deliberately cannot do
 *
 * Every instruction it sends is permissionless. `evaluate_strategy` and
 * `execute_trade` derive `vault_config` from `vault_config.owner`, never from
 * the signer, so this service has exactly the same powers as any stranger with
 * a funded keypair — which is to say, the power to pay for someone else's
 * computation and to submit a trade the MPC already authorized. It cannot
 * withdraw, cannot change limits, cannot convert a strategy, cannot pause.
 *
 * That is not a policy this file enforces. It is a property of the program's
 * account constraints, and it is why this service losing its key, going
 * offline, or turning hostile costs users latency and nothing else.
 */
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type AccountMeta,
} from "@solana/web3.js";
// Anchor's BN, not bn.js. They are different classes, and Anchor's coder calls
// methods (`isNeg`) a bare bn.js instance does not carry — it fails at
// serialisation with "value.isNeg is not a function". Imported as a default
// because the package is CJS and has no named ESM exports.
import anchorPkg from "@coral-xyz/anchor";
const { BN } = anchorPkg;
// Explicit subpaths: this app is ESM and the SDK ships raw TypeScript with no
// exports map, so the barrel re-export resolves inconsistently across loaders.
import {
  arciumAccounts,
  CIRCUIT_EVALUATE,
  freshComputationOffset,
} from "@silentedge/sdk/src/arcium.ts";
import {
  decide,
  type IntentView,
  type StrategyView,
  type VaultView,
} from "@silentedge/sdk/src/decide.ts";

import { fetchRoute } from "./jupiter.js";

const RPC = process.env.EXECUTOR_RPC ?? "http://127.0.0.1:8899";
const KEYPAIR = process.env.EXECUTOR_KEYPAIR ?? "";
const CLUSTER_OFFSET = Number(process.env.ARCIUM_CLUSTER_OFFSET ?? 456);
const INTERVAL_MS = Number(process.env.EXECUTOR_INTERVAL_MS ?? 15_000);
const DRY_RUN = process.env.EXECUTOR_DRY_RUN === "1";

const VAULT_DISCRIMINATOR = [99, 86, 43, 216, 184, 102, 119, 77];

type Ctx = {
  connection: Connection;
  payer: Keypair;
  program: any;
  programId: PublicKey;
};

const lastEvaluatedAtMs = new Map<string, number>();

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

async function loadProgram(): Promise<Ctx> {
  if (!KEYPAIR) throw new Error("EXECUTOR_KEYPAIR is required");
  const anchor = anchorPkg as any;
  const idl = JSON.parse(fs.readFileSync("target/idl/vault.json", "utf-8"));
  const connection = new Connection(RPC, "confirmed");
  const payer = Keypair.fromSecretKey(
    Buffer.from(JSON.parse(fs.readFileSync(KEYPAIR, "utf-8")))
  );
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const program = new anchor.Program(idl, provider);
  return { connection, payer, program, programId: program.programId };
}

/**
 * Every vault this program knows about.
 *
 * The discriminator is matched client-side rather than with a `memcmp` filter.
 * Surfpool answers `getProgramAccounts` but returns nothing for a filtered
 * query, so a filtered executor silently sees zero vaults on a fork — a
 * failure that looks exactly like "no work to do". Fetching the first eight
 * bytes and comparing here costs one small response and works on every RPC.
 */
async function discoverVaults(ctx: Ctx): Promise<PublicKey[]> {
  const accounts = await ctx.connection.getProgramAccounts(ctx.programId, {
    dataSlice: { offset: 0, length: 8 },
  });
  const want = Buffer.from(VAULT_DISCRIMINATOR);
  return accounts
    .filter((a) => Buffer.from(a.account.data).equals(want))
    .map((a) => a.pubkey);
}

/**
 * Send, or throw with the program's own logs.
 *
 * Anchor's `.rpc()` reports on-chain failures here as `Unknown action
 * 'undefined'` — no instruction, no error code, nothing to act on. A service
 * that logs that on a loop is a service nobody can debug, so simulate first and
 * surface the AnchorError line.
 */
async function sendChecked(ctx: Ctx, tx: Transaction): Promise<string> {
  tx.feePayer = ctx.payer.publicKey;
  tx.recentBlockhash = (await ctx.connection.getLatestBlockhash()).blockhash;
  tx.sign(ctx.payer);
  const sim = await ctx.connection.simulateTransaction(tx);
  if (sim.value.err) {
    // Keep the last few program logs, not just lines containing "Error".
    // A CPI failure often reports the code on a "failed:" line and says
    // nothing matching "Error" at all, which reduced the message to a bare
    // instruction index — the error equivalent of silence.
    const logs = sim.value.logs ?? [];
    const why = logs.filter((l) => /Error|failed|Instruction:/.test(l)).slice(-4);
    throw new Error(`${JSON.stringify(sim.value.err)} :: ${why.join(" | ")}`);
  }
  const sig = await ctx.connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
  await ctx.connection.confirmTransaction(sig, "confirmed");
  return sig;
}

const pda = (seed: string, key: PublicKey, programId: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from(seed), key.toBuffer()], programId)[0];

async function readVault(ctx: Ctx, vault: PublicKey) {
  const v: any = await ctx.program.account.vaultConfig.fetch(vault);
  const strategyPda = pda("strategy", vault, ctx.programId);
  const intentPda = pda("intent", vault, ctx.programId);
  const strategy: any = await ctx.program.account.strategyState
    .fetch(strategyPda)
    .catch(() => null);
  const intent: any = await ctx.program.account.tradeIntent
    .fetch(intentPda)
    .catch(() => null);

  // The stop-loss depends on this: decide() suppresses evaluation during a
  // cooldown only when there is nothing to sell, so a wrong reading here can
  // disarm an exit. Treat an unreadable balance as a position held rather than
  // as flat — evaluating unnecessarily costs a computation fee, not a stop.
  const baseAta = ata.getAssociatedTokenAddressSync(v.baseMint, vault, true);
  const baseBalance = await ctx.connection
    .getTokenAccountBalance(baseAta)
    .then((r) => BigInt(r.value.amount))
    .catch(() => 1n);

  const vaultView: VaultView = {
    address: vault.toBase58(),
    baseBalance,
    status: typeof v.status === "object" ? Object.keys(v.status)[0] === "active" ? 0
      : Object.keys(v.status)[0] === "paused" ? 1 : 2 : Number(v.status),
    nonce: BigInt(v.nonce.toString()),
    lastTradeTs: BigInt(v.lastTradeTs.toString()),
    cooldownSeconds: Number(v.limits.cooldownSeconds),
  };
  const strategyView: StrategyView | null = strategy
    ? {
        mxeVersion: Number(strategy.mxeVersion),
        armed:
          Number(strategy.mxeVersion) > 0 &&
          (strategy.mxeCiphertexts as number[][]).some((c) =>
            c.some((b) => b !== 0)
          ),
      }
    : null;
  const intentView: IntentView | null = intent
    ? {
        side: Number(intent.side),
        amountIn: BigInt(intent.amountIn.toString()),
        expiresAtSlot: BigInt(intent.expiresAtSlot.toString()),
        vaultNonce: BigInt(intent.vaultNonce.toString()),
        strategyVersion: Number(intent.strategyVersion),
        consumed: Boolean(intent.consumed),
      }
    : null;

  return { v, vaultView, strategyView, intentView, strategyPda, intentPda };
}

async function queueEvaluation(ctx: Ctx, vault: PublicKey, v: any, strategyPda: PublicKey, intentPda: PublicKey) {
  const offset = freshComputationOffset();
  const arcium = arciumAccounts(ctx.programId, CLUSTER_OFFSET, offset, CIRCUIT_EVALUATE);
  const ata = await import("@solana/spl-token");
  const tx = await ctx.program.methods
    .evaluateStrategy(new BN(offset.toString()))
    .accountsPartial({
      payer: ctx.payer.publicKey,
      vaultConfig: vault,
      strategyState: strategyPda,
      tradeIntent: intentPda,
      vaultQuoteAta: ata.getAssociatedTokenAddressSync(v.quoteMint, vault, true),
      vaultBaseAta: ata.getAssociatedTokenAddressSync(v.baseMint, vault, true),
      priceUpdate: new PublicKey(process.env.PYTH_SOL_USD!),
      ...arcium,
    })
    .transaction();
  return sendChecked(ctx, tx);
}

async function spendIntent(ctx: Ctx, vault: PublicKey, v: any, intent: IntentView, strategyPda: PublicKey, intentPda: PublicKey) {
  const ata = await import("@solana/spl-token");
  const quote = ata.getAssociatedTokenAddressSync(v.quoteMint, vault, true);
  const base = ata.getAssociatedTokenAddressSync(v.baseMint, vault, true);

  const si = await fetchRoute({
    inputMint: intent.side === 1 ? v.quoteMint : v.baseMint,
    outputMint: intent.side === 1 ? v.baseMint : v.quoteMint,
    amount: intent.amountIn,
    taker: vault,
  });

  const tx: Transaction = await ctx.program.methods
    .executeTrade(Buffer.from(si.data, "base64"))
    .accountsPartial({
      executor: ctx.payer.publicKey,
      vaultConfig: vault,
      tradeIntent: intentPda,
      strategyState: strategyPda,
      vaultQuoteAta: quote,
      vaultBaseAta: base,
      priceUpdate: new PublicKey(process.env.PYTH_SOL_USD!),
      jupiterProgram: new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
    })
    .remainingAccounts(
      si.accounts.map((a: any): AccountMeta => ({
        pubkey: new PublicKey(a.pubkey),
        isSigner: false, // the vault PDA signs via invoke_signed
        isWritable: a.isWritable,
      }))
    )
    .transaction();

  // Simulation is not optional here: a revert is the normal case, not an
  // exception. The intent may have expired or the route moved between quote and
  // submit, and paying for a doomed transaction is the one harm a
  // permissionless executor can reliably inflict on itself.
  return sendChecked(ctx, tx);
}

async function tick(ctx: Ctx) {
  const vaults = await discoverVaults(ctx);
  const slot = BigInt(await ctx.connection.getSlot("confirmed"));
  // Say how many. "Found nothing" and "skipped everything" produce identical
  // silence otherwise, and they call for opposite responses.
  log(`tick: ${vaults.length} vault(s)`);
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

  for (const vault of vaults) {
    const key = vault.toBase58();
    try {
      const { v, vaultView, strategyView, intentView, strategyPda, intentPda } =
        await readVault(ctx, vault);

      const d = decide({
        vault: vaultView,
        strategy: strategyView,
        intent: intentView,
        slot,
        nowSeconds,
        lastEvaluatedAtMs: lastEvaluatedAtMs.get(key),
        nowMs: Date.now(),
      });

      if (d.action === "skip") {
        log(`${key.slice(0, 8)} skip: ${d.reason}`);
        continue;
      }
      if (DRY_RUN) {
        log(`${key.slice(0, 8)} would ${d.action}: ${d.reason}`);
        continue;
      }

      if (d.action === "evaluate") {
        lastEvaluatedAtMs.set(key, Date.now());
        const sig = await queueEvaluation(ctx, vault, v, strategyPda, intentPda);
        log(`${key.slice(0, 8)} evaluate queued ${sig.slice(0, 16)}`);
      } else {
        const sig = await spendIntent(ctx, vault, v, intentView!, strategyPda, intentPda);
        log(`${key.slice(0, 8)} executed side=${intentView!.side} ${sig.slice(0, 16)}`);
      }
    } catch (e) {
      // One vault's failure must never stop the others.
      //
      // An out-of-range read is the specific, expected shape of a vault created
      // before the current account layout: borsh runs off the end of a shorter
      // account. Those vaults are unreachable by this program version and there
      // is nothing an executor can do about them, so say so once rather than
      // printing a decoder stack trace every tick.
      const text = String(e);
      // Two distinct symptoms, one cause: a vault created under an older
      // account layout. A size change makes borsh run off the end; a field
      // inserted mid-struct decodes into garbage and the program then rejects
      // the mis-read bump with ConstraintSeeds. Both are unreachable by this
      // program version and neither is actionable, so they are reported as
      // what they are rather than as generic errors — but nothing else is
      // folded in, because a catch-all here would hide a live fault.
      const staleLayout =
        /out of range|AccountDidNotDeserialize/.test(text) ||
        (/ConstraintSeeds/.test(text) && /vault_config/.test(text));
      log(
        key.slice(0, 8) +
          (staleLayout
            ? " SKIP predates the current account layout"
            : ` ERROR ${text.slice(0, 180)}`)
      );
    }
  }
}

async function main() {
  const ctx = await loadProgram();
  log(`executor up: payer=${ctx.payer.publicKey.toBase58()} program=${ctx.programId.toBase58()}`);
  log(`cluster=${CLUSTER_OFFSET} interval=${INTERVAL_MS}ms dryRun=${DRY_RUN}`);
  for (;;) {
    await tick(ctx).catch((e) => log("tick failed:", String(e).slice(0, 200)));
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
