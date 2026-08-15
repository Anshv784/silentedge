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
}
