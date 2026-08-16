use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::VaultError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum VaultStatus {
    /// Normal operation: deposits, withdrawals, and (later) trading.
    Active,
    /// Circuit breaker. Blocks deposits and trading. **Withdrawals still work.**
    Paused,
    /// Terminal wind-down. Blocks deposits and trading forever. Withdrawals still work.
    Stopped,
}

/// User-chosen risk parameters, fixed at vault creation.
///
/// Stored now but enforced by `execute_trade`, which arrives with the trading
/// phases. Keeping them here means a vault's risk envelope is chosen by its
/// owner at creation rather than supplied by whoever happens to submit a trade.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, InitSpace)]
pub struct RiskLimits {
    /// Max single trade as a fraction of vault value.
    pub max_trade_bps: u16,
    /// Max tolerated slippage on a swap.
    pub max_slippage_bps: u16,
    /// Max cumulative realised loss per UTC day before trading halts.
    pub daily_loss_limit_bps: u16,
    /// Minimum seconds between trades.
    pub cooldown_seconds: u32,
    /// Reject oracle prices older than this.
    pub max_oracle_staleness_sec: u32,
    /// Reject oracle prices whose confidence/price ratio exceeds this.
    pub max_conf_bps: u16,
    /// Reject executions deviating from the oracle band by more than this.
    pub max_oracle_deviation_bps: u16,
}

impl RiskLimits {
    /// Bounds-check user input. Every field is attacker-controlled at init, so
    /// each one is validated rather than trusted.
    pub fn validate(&self) -> Result<()> {
        require!(
            self.max_trade_bps > 0 && self.max_trade_bps <= MAX_TRADE_BPS_CEILING,
            VaultError::InvalidRiskLimit
        );
        require!(
            self.max_slippage_bps > 0 && self.max_slippage_bps <= MAX_SLIPPAGE_BPS_CEILING,
            VaultError::InvalidRiskLimit
        );
        require!(
            self.daily_loss_limit_bps > 0 && self.daily_loss_limit_bps <= BPS_DENOMINATOR,
            VaultError::InvalidRiskLimit
        );
        require!(
            self.max_oracle_staleness_sec > 0
                && self.max_oracle_staleness_sec <= MAX_ORACLE_STALENESS_CEILING,
            VaultError::InvalidRiskLimit
        );
        require!(
            self.max_conf_bps > 0 && self.max_conf_bps <= MAX_CONF_BPS_CEILING,
            VaultError::InvalidRiskLimit
        );
        require!(
            self.max_oracle_deviation_bps > 0
                && self.max_oracle_deviation_bps <= MAX_ORACLE_DEVIATION_CEILING,
            VaultError::InvalidRiskLimit
        );
        Ok(())
    }
}

#[account]
#[derive(InitSpace, Debug)]
pub struct VaultConfig {
    /// The only address funds can ever be withdrawn to.
    pub owner: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub limits: RiskLimits,
    pub status: VaultStatus,
    pub bump: u8,
    /// Monotonic. Bumped on every executed trade, so an old authorization can
    /// never be replayed against a vault that has moved on.
    pub nonce: u64,
}

impl VaultConfig {
    pub fn seeds(&self) -> [&[u8]; 3] {
        [VAULT_SEED, self.owner.as_ref(), std::slice::from_ref(&self.bump)]
    }
}

/// A vault's encrypted strategy.
///
/// The program stores these bytes and never interprets them. It cannot: the
/// plaintext is four integers encrypted under a secret shared between the
/// submitter and the MXE cluster, and nothing on chain holds either half of
/// that exchange. Storing opaque bytes is the point, not a limitation.
///
/// `encryption_pubkey` is the submitter's x25519 public key. The MXE needs it
/// to derive the same shared secret, so it is public by construction — it
/// reveals who encrypted, never what.
#[account]
#[derive(InitSpace, Debug)]
pub struct StrategyState {
    pub vault: Pubkey,
    /// One 32-byte ciphertext per encrypted scalar, in circuit field order.
    pub ciphertexts: [[u8; 32]; STRATEGY_FIELDS],
    /// Encryption nonce. Fresh per submission; reuse would leak.
    pub nonce: u128,
    pub encryption_pubkey: [u8; 32],
    /// Bumped on every submission. Binds trade authorizations to the strategy
    /// that produced them, so replacing a strategy invalidates work in flight.
    pub version: u32,
    pub bump: u8,

    /// The same strategy re-encrypted to the MXE cluster.
    ///
    /// `ciphertexts` above is what the user submitted, readable by them. This is
    /// what the cluster produced from it, readable only by the cluster acting
    /// together — which is what lets evaluation run with nobody online.
    /// Zero `mxe_version` means the conversion has not happened yet.
    pub mxe_ciphertexts: [[u8; 32]; STRATEGY_FIELDS],
    pub mxe_nonce: u128,
    pub mxe_version: u32,
}

/// A single authorized trade, written only by a verified Arcium callback.
///
/// This is the whole authorization surface for moving vault funds into a swap.
/// It is deliberately a singleton per vault: a new decision overwrites any
/// unconsumed one, so there is no queue to stuff and no ordering to reason about.
///
/// Every field here is a constraint the executor must satisfy, not a hint. The
/// executor is permissionless precisely because it holds no privilege — it
/// chooses only whether and when to submit, inside a window this account defines.
#[account]
#[derive(InitSpace, Debug)]
pub struct TradeIntent {
    pub vault: Pubkey,
    /// 1 = BUY (quote -> base), 2 = SELL (base -> quote). 0 never lands here.
    pub side: u8,
    /// Input amount in the source mint's base units.
    pub amount_in: u64,
    /// Floor on the output, in the destination mint's base units.
    ///
    /// NOT YET ENFORCED. The callback writes 0 and `execute_trade` moves no
    /// funds, so nothing reads this today. The swap lands in the trading phase,
    /// and it must set this from a fresh quote bounded by
    /// `RiskLimits.max_slippage_bps` *before* any CPI — a swap submitted while
    /// this is still 0 has no slippage floor at all.
    pub min_amount_out: u64,
    /// Slot after which this authorization is dead.
    pub expires_at_slot: u64,
    /// Must equal `VaultConfig.nonce`. Bumped on execution, which is what makes
    /// a consumed intent unreplayable even if `consumed` were somehow cleared.
    pub vault_nonce: u64,
    /// Binds the authorization to the strategy that produced it. Replacing the
    /// strategy invalidates any intent still in flight.
    pub strategy_version: u32,
    /// The oracle price the decision was made at, for the execution-time
    /// deviation check.
    pub oracle_price: u64,
    pub consumed: bool,
    pub bump: u8,
}
