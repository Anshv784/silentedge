/**
 * What the executor should do about one vault, right now.
 *
 * Split out from the loop and kept pure so it can be tested without a chain, a
 * cluster, or a Jupiter route. The loop below it does IO and nothing else; every
 * judgement about *whether* to act lives here.
 *
 * The executor holds no privilege. `evaluate_strategy` and `execute_trade` are
 * both permissionless — seeded by `vault_config.owner`, not by the payer — so
 * everything this decides could equally be decided by the vault's owner, or by
 * a stranger. It pays fees and picks moments. That is the whole job, and it is
 * why losing this service cannot strand anyone's funds.
 */

export type VaultView = {
  address: string;
  /** Base units held. Zero means there is nothing an exit could sell. */
  baseBalance: bigint;
  /** 0 Active, 1 Paused, 2 Stopped. */
  status: number;
  nonce: bigint;
  lastTradeTs: bigint;
  cooldownSeconds: number;
};

export type StrategyView = {
  /**
   * The version the converted copy is for. Non-zero from the moment
   * `convert_strategy` queues the computation — so this is NOT "converted".
   */
  mxeVersion: number;
  /**
   * Is there actually a converted strategy to evaluate?
   *
   * `convert_strategy` claims `mxeVersion` when it queues, before the callback
   * writes any ciphertext, so a non-zero version can mean "conversion in
   * flight". Evaluating there is refused on chain (`StrategyNotConverted`), and
   * paying for a computation that cannot succeed is the mild version of the
   * problem — the interface reporting "armed" is the real one.
   */
  armed: boolean;
};

export type IntentView = {
  side: number;
  amountIn: bigint;
  expiresAtSlot: bigint;
  vaultNonce: bigint;
  strategyVersion: number;
  consumed: boolean;
};

export type Decision =
  | { action: "execute"; reason: string }
  | { action: "evaluate"; reason: string }
  | { action: "skip"; reason: string };

export const SIDE_BUY = 1;

/** Minimum spacing between evaluations we pay for, per vault. */
export const MIN_EVALUATE_INTERVAL_MS = 30_000;

/**
 * An intent is spendable only if every binding still holds. These mirror the
 * program's own checks in `execute_trade`; duplicating them here is not trust,
 * it is fee avoidance — submitting a transaction the program will reject costs
 * the executor and achieves nothing.
 */
export function intentIsLive(
  intent: IntentView | null,
  vault: VaultView,
  strategy: StrategyView,
  slot: bigint
): boolean {
  if (!intent) return false;
  if (intent.consumed) return false;
  if (intent.amountIn === 0n) return false;
  if (intent.vaultNonce !== vault.nonce) return false;
  if (intent.strategyVersion !== strategy.mxeVersion) return false;
  if (slot > intent.expiresAtSlot) return false;
  return true;
}

export function decide(input: {
  vault: VaultView;
  strategy: StrategyView | null;
  intent: IntentView | null;
  slot: bigint;
  nowSeconds: bigint;
  lastEvaluatedAtMs: number | undefined;
  nowMs: number;
}): Decision {
  const { vault, strategy, intent, slot, nowSeconds, lastEvaluatedAtMs, nowMs } = input;

  // Paused and Stopped both mean "no new trading". Withdrawals keep working
  // without us, which is the point.
  if (vault.status !== 0) return { action: "skip", reason: "vault not active" };

  // A live authorization outranks everything, including the conversion gate
  // below. `execute_trade` requires the intent's strategy_version to *match*
  // mxe_version, not to be non-zero, so an authorization can be valid at
  // version 0. Checking conversion first left a spendable intent unspent —
  // harmless in production, where no intent can exist before conversion, and
  // wrong in exactly the environment where the execute path is testable.
  if (strategy && intentIsLive(intent, vault, strategy, slot)) {
    return { action: "execute", reason: "live authorization pending" };
  }

  if (!strategy || !strategy.armed) {
    // The owner submitted a strategy but has not converted it to Enc<Mxe>.
    // Only they can: `convert_strategy` is seeded by the payer.
    return { action: "skip", reason: "strategy not converted by owner" };
  }

  // Entries are refused during cooldown; exits are not. Evaluation is the only
  // thing that can mint a SELL, so skipping it during a cooldown disables the
  // stop-loss for the whole window — the opposite of the intent, and worse the
  // longer the cooldown. It cost nothing to get wrong in tests because they
  // only exercised spending an intent that already existed.
  //
  // So the cooldown only suppresses evaluation when there is nothing to exit.
  // With a base position open, the vault keeps evaluating and the program
  // refuses the entry itself — paying for an occasional wasted computation is
  // the right trade against silently disarming a stop.
  const elapsed = nowSeconds - vault.lastTradeTs;
  const nothingToExit = vault.baseBalance === 0n;
  if (
    nothingToExit &&
    vault.lastTradeTs > 0n &&
    elapsed < BigInt(vault.cooldownSeconds)
  ) {
    return {
      action: "skip",
      reason: `cooldown: ${elapsed}s of ${vault.cooldownSeconds}s, nothing to exit`,
    };
  }

  // Do not pay for evaluations faster than the market can move meaningfully.
  if (lastEvaluatedAtMs !== undefined && nowMs - lastEvaluatedAtMs < MIN_EVALUATE_INTERVAL_MS) {
    return { action: "skip", reason: "evaluated recently" };
  }

  return { action: "evaluate", reason: "no live authorization" };
}
