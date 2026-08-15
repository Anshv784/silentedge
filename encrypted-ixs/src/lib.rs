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
