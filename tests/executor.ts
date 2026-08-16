/**
 * The executor's decision logic.
 *
 * Pure, so it needs no chain. Worth testing precisely because the executor is
 * the one component that spends money on its own initiative: every wrong
 * "evaluate" burns MPC fees, and every wrong "execute" burns a transaction the
 * program was always going to reject.
 *
 * The safety properties are the program's, not this file's — `execute_trade`
 * re-checks every binding on chain. What is tested here is that the executor
 * does not waste fees discovering that.
 */
import { expect } from "chai";
import {
  decide,
  intentIsLive,
  MIN_EVALUATE_INTERVAL_MS,
  type IntentView,
  type StrategyView,
  type VaultView,
} from "@silentedge/sdk";

const vault = (over: Partial<VaultView> = {}): VaultView => ({
  address: "V",
  baseBalance: 0n,
  status: 0,
  nonce: 5n,
  lastTradeTs: 0n,
  cooldownSeconds: 60,
  ...over,
});

const strategy = (over: Partial<StrategyView> = {}): StrategyView => ({
  mxeVersion: 3,
  armed: true,
  ...over,
});

const intent = (over: Partial<IntentView> = {}): IntentView => ({
  side: 1,
  amountIn: 500_000_000n,
  expiresAtSlot: 1_000n,
  vaultNonce: 5n,
  strategyVersion: 3,
  consumed: false,
  ...over,
});

const base = {
  slot: 900n,
  nowSeconds: 10_000n,
  lastEvaluatedAtMs: undefined,
  nowMs: 1_000_000,
};

describe("executor decisions", () => {
  it("spends a live authorization before producing another", () => {
    const d = decide({ vault: vault(), strategy: strategy(), intent: intent(), ...base });
    expect(d.action).to.equal("execute");
  });

  it("evaluates when there is nothing to spend", () => {
    const d = decide({ vault: vault(), strategy: strategy(), intent: null, ...base });
    expect(d.action).to.equal("evaluate");
  });

  /**
   * Each of these is a binding `execute_trade` enforces on chain. Submitting
   * anyway is not unsafe — it is just paying to be told no.
   */
  it("does not spend an authorization the program will reject", () => {
    const dead: [string, IntentView][] = [
      ["consumed", intent({ consumed: true })],
      ["zero amount", intent({ amountIn: 0n })],
      ["superseded nonce", intent({ vaultNonce: 4n })],
      ["stale strategy", intent({ strategyVersion: 2 })],
      ["expired", intent({ expiresAtSlot: 899n })],
    ];
    for (const [label, i] of dead) {
      expect(intentIsLive(i, vault(), strategy(), base.slot), label).to.equal(false);
      const d = decide({ vault: vault(), strategy: strategy(), intent: i, ...base });
      expect(d.action, label).to.not.equal("execute");
    }
  });

  /**
   * `execute_trade` requires intent.strategy_version == mxe_version, not
   * mxe_version > 0, so an authorization is spendable at version 0. Ordering
   * the conversion gate first left such an intent stranded.
   */
  it("spends a live authorization even at strategy version zero", () => {
    const d = decide({
      vault: vault(),
      strategy: strategy({ mxeVersion: 0, armed: false }),
      intent: intent({ strategyVersion: 0 }),
      ...base,
    });
    expect(d.action).to.equal("execute");
  });

  it("does nothing to a paused or stopped vault", () => {
    for (const status of [1, 2]) {
      const d = decide({
        vault: vault({ status }), strategy: strategy(), intent: intent(), ...base,
      });
      expect(d.action, `status ${status}`).to.equal("skip");
    }
  });

  /**
   * `convert_strategy` is seeded by the payer, so only the owner can run it.
   * An unconverted strategy is not a fault the executor can clear, and
   * evaluating one would fail on StrategyNotConverted after being paid for.
   */
  it("waits for the owner to convert a strategy rather than paying to fail", () => {
    // The third case is the one that is easy to get wrong: `convert_strategy`
    // claims `mxeVersion` when it queues the computation, so a conversion in
    // flight looks converted to anything testing the version alone. Evaluating
    // there is refused on chain, and paying for a computation that cannot
    // succeed is the mild half — reporting it as armed is the other half.
    for (const s of [
      null,
      strategy({ mxeVersion: 0, armed: false }),
      strategy({ mxeVersion: 7, armed: false }),
    ]) {
      const d = decide({ vault: vault(), strategy: s, intent: null, ...base });
      expect(d.action).to.equal("skip");
      expect(d.reason).to.match(/convert/i);
    }
  });

  it("holds off during a cooldown while flat, and resumes after it", () => {
    const v = vault({ lastTradeTs: 9_990n, cooldownSeconds: 60 }); // 10s ago
    expect(decide({ vault: v, strategy: strategy(), intent: null, ...base }).action)
      .to.equal("skip");

    const later = { ...base, nowSeconds: 10_051n }; // 61s ago
    expect(decide({ vault: v, strategy: strategy(), intent: null, ...later }).action)
      .to.equal("evaluate");
  });

  /**
   * A cooldown must never delay spending an authorization that already exists:
   * the program exempts exits from the cooldown precisely so a stop can fire,
   * and an executor that sat on it would reintroduce the delay the program
   * went out of its way to remove.
   */
  it("still spends a live authorization during a cooldown", () => {
    const v = vault({ lastTradeTs: 9_990n, cooldownSeconds: 3_600 });
    const d = decide({ vault: v, strategy: strategy(), intent: intent(), ...base });
    expect(d.action).to.equal("execute");
  });

  /**
   * The cooldown must not disarm the stop-loss.
   *
   * Only an evaluation can mint a SELL, so an executor that skips evaluating
   * for the whole cooldown cannot produce an exit for the whole cooldown — the
   * longer the owner sets it for safety, the longer their stop is off. The
   * program is deliberately built the other way round: exits are exempt from
   * the cooldown, and this restores the same asymmetry off chain.
   *
   * This is the detector for that. Delete the `nothingToExit` guard in
   * decide.ts and this test goes red while every other cooldown test stays
   * green, because they all run flat.
   */
  it("keeps evaluating during a cooldown while a position is open", () => {
    const holding = vault({
      lastTradeTs: 9_990n, // 10s ago
      cooldownSeconds: 3_600,
      baseBalance: 1n,
    });
    const d = decide({ vault: holding, strategy: strategy(), intent: null, ...base });
    expect(
      d.action,
      "a cooldown must not stop the vault looking for an exit"
    ).to.equal("evaluate");

    // Same vault, same cooldown, no position: nothing to exit, so the cooldown
    // does suppress it. This pairing is what makes the assertion above specific
    // to the stop-loss rather than to cooldowns being ignored generally.
    const flat = { ...holding, baseBalance: 0n };
    expect(decide({ vault: flat, strategy: strategy(), intent: null, ...base }).action)
      .to.equal("skip");
  });

  it("does not pay for evaluations faster than the interval", () => {
    const justNow = { ...base, lastEvaluatedAtMs: base.nowMs - 1_000 };
    expect(decide({ vault: vault(), strategy: strategy(), intent: null, ...justNow }).action)
      .to.equal("skip");

    const longAgo = { ...base, lastEvaluatedAtMs: base.nowMs - MIN_EVALUATE_INTERVAL_MS - 1 };
    expect(decide({ vault: vault(), strategy: strategy(), intent: null, ...longAgo }).action)
      .to.equal("evaluate");
  });

  /** A vault that has never traded must not be held back by a cooldown. */
  it("lets a brand new vault trade immediately", () => {
    const d = decide({
      vault: vault({ lastTradeTs: 0n, cooldownSeconds: 3_600 }),
      strategy: strategy(), intent: null, ...base,
    });
    expect(d.action).to.equal("evaluate");
  });
});
