/**
 * Put a live TradeIntent on a surfpool mainnet fork, so the executor's
 * *execute* leg can be watched end to end against a real Jupiter route.
 *
 * Neither environment can show the whole loop: devnet has the Arcium cluster
 * but no routable liquidity, and a mainnet fork has the liquidity but no MXE.
 * The seam is the intent. This writes one directly — the same cheatcode the
 * swap suite uses, and for the same reason: a test-only instruction that mints
 * authorizations would be a forgery path in the shipped program.
 *
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=... \
 *     node scripts/seed-fork-intent.mjs
 */
// Namespace import gives no working BN under ESM; the package is CJS.
import anchorPkg from "@coral-xyz/anchor";
const anchor = anchorPkg;
import web3 from "@solana/web3.js";
import * as spl from "@solana/spl-token";

const { PublicKey, SystemProgram } = web3;
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const PYTH = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const DEPOSIT = 5_000_000_000n;
const TRADE_IN = 300_000_000n;

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.Vault;
const owner = provider.wallet.payer;
const conn = provider.connection;

const pda = (s, k) =>
  PublicKey.findProgramAddressSync([Buffer.from(s), k.toBuffer()], program.programId)[0];
const vault = pda("vault", owner.publicKey);
const strat = pda("strategy", vault);
const intent = pda("intent", vault);
const ata = (m) => spl.getAssociatedTokenAddressSync(m, vault, true);

const rpc = async (m, p) => {
  const r = await conn._rpcRequest(m, p);
  if (r?.error) throw new Error(`${m}: ${JSON.stringify(r.error)}`);
  return r;
};

const LIMITS = {
  maxTradeBps: 1_000, maxSlippageBps: 100, dailyLossLimitBps: 500,
  cooldownSeconds: 0, maxOracleStalenessSec: 30, maxConfBps: 100,
  maxOracleDeviationBps: 200, sizeBps: 1_000,
};

if (!(await conn.getAccountInfo(vault))) {
  await program.methods.initializeVault(LIMITS).accountsPartial({
    owner: owner.publicKey, vaultConfig: vault, baseMint: WSOL, quoteMint: USDC,
    vaultBaseAta: ata(WSOL), vaultQuoteAta: ata(USDC),
    tokenProgram: spl.TOKEN_PROGRAM_ID,
    associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).signers([owner]).rpc();
  console.log("vault created", vault.toBase58());
}
if (!(await conn.getAccountInfo(strat))) {
  await program.methods.submitStrategy(
    [Array(32).fill(1), Array(32).fill(2), Array(32).fill(3)],
    new anchor.BN(1), Array(32).fill(7)
  ).accountsPartial({
    owner: owner.publicKey, vaultConfig: vault, strategyState: strat,
    systemProgram: SystemProgram.programId,
  }).signers([owner]).rpc();
}
if (!(await conn.getAccountInfo(intent))) {
  await program.methods.initTradeIntent().accountsPartial({
    owner: owner.publicKey, vaultConfig: vault, tradeIntent: intent,
    systemProgram: SystemProgram.programId,
  }).signers([owner]).rpc();
}

await rpc("surfnet_setTokenAccount", [vault.toBase58(), USDC.toBase58(), { amount: Number(DEPOSIT) }]);
await rpc("surfnet_setTokenAccount", [vault.toBase58(), WSOL.toBase58(), { amount: 0 }]);

// The forked Pyth account ages against the fork's own clock; refresh only its
// timestamps so the staleness guard still runs on real published data.
{
  const acc = await conn.getAccountInfo(PYTH);
  const d = Buffer.from(acc.data);
  const clock = await conn.getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111"));
  const now = clock.data.readBigInt64LE(32);
  d.writeBigInt64LE(now, 93);
  d.writeBigInt64LE(now, 101);
  await rpc("surfnet_setAccount", [PYTH.toBase58(), {
    data: d.toString("hex"), owner: acc.owner.toBase58(), lamports: acc.lamports, executable: false,
  }]);
}

// Forge only the authorization fields; keep the discriminator and bump the
// program itself wrote.
{
  const existing = await conn.getAccountInfo(intent);
  const d = Buffer.from(existing.data);
  const slot = await conn.getSlot("confirmed");
  const vc = await program.account.vaultConfig.fetch(vault);
  const ss = await program.account.strategyState.fetch(strat);
  let o = 8;
  vault.toBuffer().copy(d, o); o += 32;
  d.writeUInt8(1, o); o += 1;                                   // side BUY
  d.writeBigUInt64LE(TRADE_IN, o); o += 8;
  d.writeBigUInt64LE(0n, o); o += 8;                            // min_out: on-chain
  d.writeBigUInt64LE(BigInt(slot + 150), o); o += 8;
  d.writeBigUInt64LE(BigInt(vc.nonce.toString()), o); o += 8;
  d.writeUInt32LE(ss.mxeVersion, o); o += 4;
  d.writeBigUInt64LE(0n, o); o += 8;                            // oracle_price: on-chain
  d.writeUInt8(0, o);                                           // consumed = false
  await rpc("surfnet_setAccount", [intent.toBase58(), {
    data: d.toString("hex"), owner: program.programId.toBase58(),
    lamports: existing.lamports, executable: false,
  }]);
}

const i = await program.account.tradeIntent.fetch(intent);
console.log(`seeded intent: side=${i.side} amountIn=${i.amountIn} consumed=${i.consumed}`);
console.log(`vault=${vault.toBase58()}`);
