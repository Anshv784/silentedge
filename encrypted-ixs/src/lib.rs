use arcis::*;

/// Encrypted instructions, compiled by Arcis into MPC circuits.
///
/// Everything in here runs secret-shared across the Arx nodes in a cluster. No
/// single node sees a plaintext value, and under Arcium's dishonest-majority
/// model that holds as long as one node is honest — even if every other node
/// colludes.
#[encrypted]
mod circuits {
    use arcis::*;

    /// The whole strategy: four fixed-width integers.
    ///
    /// Fixed shape is not a style choice. Arcis compiles to circuits whose
    /// shape is known at compile time — no `Vec`, no variable-length loops — so
    /// the editable rules in the UI have to collapse into exactly this before
    /// they can ever be evaluated. Prices are fixed-point with 6 decimals;
    /// `size_bps` is basis points of vault value.
    ///
    /// A rule the user switched off is stored as a value whose comparison can
    /// never be true (0 for buy, `u64::MAX` for sell) rather than being absent.
    /// In MPC both branches of a conditional execute regardless, so "off" has
    /// to be indistinguishable from "on" from the outside.
    pub struct Strategy {
        entry_below: u64,
        exit_above: u64,
        stop_below: u64,
        size_bps: u64,
    }

    /// The smallest computation that proves the pipeline is real: `x + 10`.
    ///
    /// `x` arrives encrypted and is never revealed. `10` is a compile-time
    /// constant baked into the circuit, so it is public by construction — which
    /// is the distinction worth demonstrating before any of this touches money.
    ///
    /// The result is re-encrypted to the caller rather than revealed, so the
    /// answer comes back readable only by whoever asked. A `.reveal()` here
    /// would publish it to everyone, and the difference between those two lines
    /// is the whole confidentiality model.
    #[instruction]
    pub fn add_ten(x_ctxt: Enc<Shared, u64>) -> Enc<Shared, u64> {
        let x = x_ctxt.to_arcis();
        let sum = x + 10;
        x_ctxt.owner.from_arcis(sum)
    }

    /// Take a strategy the user encrypted to a shared secret and re-encrypt it
    /// to the MXE cluster, producing state that survives between computations.
    ///
    /// This handover is what makes an unattended bot possible.
    /// `Enc<Shared, _>` is readable by the submitter, which is right for
    /// something they just typed. `Enc<Mxe, _>` is readable only by the cluster
    /// acting together, which is what lets later evaluations use the strategy
    /// without anyone — including the owner's own browser — being online.
    ///
    /// The plaintext exists only inside the MPC, secret-shared across nodes,
    /// for the duration of this computation.
    #[instruction]
    pub fn store_strategy(input: Enc<Shared, Strategy>) -> Enc<Mxe, Strategy> {
        let strategy = input.to_arcis();
        Mxe::get().from_arcis(strategy)
    }

    /// Evaluate a private strategy against a public price.
    ///
    /// The whole product in one function: secret thresholds meet a public
    /// market price inside MPC, and only the resulting action escapes.
    ///
    /// # Why `_v2`
    ///
    /// A computation definition is keyed by circuit *name* and pins the
    /// circuit's interface at registration. Adding `base_value` changed that
    /// interface, and a registered definition cannot be re-pointed at a new one
    /// — closing it needs a deactivation plus a TTL. Renaming allocates a fresh
    /// offset, which is the supported way to ship a signature change. The v1
    /// definition is deactivated so nothing can queue against the old sizing.
    ///
    /// # What is deliberately not hidden
    ///
    /// `price`, `quote_value` and `base_value` are plaintext parameters. Every
    /// Arx node sees them, and they are visible on chain in the queueing
    /// transaction. That is correct — the price is public information and both
    /// vault balances are public token accounts. Encrypting them would cost
    /// gates and hide nothing.
    ///
    /// The return value is `.reveal()`ed because a trade cannot be executed
    /// without it. This is the minimum: a side and a size. Nothing about *why*
    /// the action fired is returned — which threshold was crossed, how far past
    /// it the price is, or what the other thresholds are.
    ///
    /// # Branch structure
    ///
    /// Both branches of a conditional always execute in MPC, so the comparisons
    /// below cost the same regardless of the outcome and take the same time.
    /// A rule that is switched off is a sentinel that can never match rather
    /// than a skipped branch, so "off" is indistinguishable from "on".
    ///
    /// The two `.reveal()` calls sit at the end, outside every conditional —
    /// Arcis rejects revealing inside a non-constant branch, and that rule
    /// exists precisely to stop the control flow leaking.
    #[instruction]
    pub fn evaluate_strategy_v2(
        strategy_ctxt: Enc<Mxe, Strategy>,
        price: u64,
        quote_value: u64,
        base_value: u64,
    ) -> (u8, u64) {
        let s = strategy_ctxt.to_arcis();

        let stop_hit = price < s.stop_below;
        let take_profit = price > s.exit_above;
        let entry_hit = price < s.entry_below;

        // Selling wins over buying. A price below the stop is also below the
        // entry, and exiting a losing position must not be read as an entry.
        let sell = stop_hit | take_profit;
        let action: u8 = if sell {
            2
        } else if entry_hit {
            1
        } else {
            0
        };

        // The returned amount is always denominated in the mint being *spent*,
        // because that is what `execute_trade` debits. A buy spends quote, a
        // sell spends base. Sizing both from the quote balance — as this did
        // until the swap made it observable — asks a stop-loss to sell a
        // USDC-denominated quantity of SOL.
        //
        // Widened to u128 for the multiply: size_bps can be 10_000, which
        // overflows u64 for large balances.
        let buy_size = ((quote_value as u128 * s.size_bps as u128) / 10_000u128) as u64;
        let sell_size = ((base_value as u128 * s.size_bps as u128) / 10_000u128) as u64;

        // A stop exits the whole position; anything else trades the configured
        // fraction. HOLD trades nothing.
        let amount = if stop_hit {
            base_value
        } else if action == 2 {
            sell_size
        } else if action == 1 {
            buy_size
        } else {
            0
        };

        (action.reveal(), amount.reveal())
    }

    /// Read persisted strategy state back out, re-encrypted to a reader.
    ///
    /// Proves the stored `Enc<Mxe, Strategy>` is intact and usable in a *later*
    /// computation than the one that wrote it — the property the whole design
    /// depends on.
    ///
    /// SECURITY: this circuit has no idea who asked. It re-encrypts to whatever
    /// x25519 key it is handed, so anyone able to queue it could read the
    /// strategy. Authorization is the Solana program's job and the program must
    /// require the owner's signature. A circuit cannot authenticate a caller;
    /// only the chain can.
    #[instruction]
    pub fn export_strategy(
        stored: Enc<Mxe, Strategy>,
        reader: Shared,
    ) -> Enc<Shared, Strategy> {
        let strategy = stored.to_arcis();
        reader.from_arcis(strategy)
    }
}
