use anchor_lang::prelude::*;

// Space constants for GlobalState
pub const GLOBAL_STATE_SEED: &[u8] = b"global_state";
pub const DISCRIMINATOR_SIZE: usize = 8;
pub const PUBKEY_SIZE: usize = 32;
pub const BOOL_SIZE: usize = 1;
pub const VEC_LENGTH_SIZE: usize = 4;
pub const STRING_LENGTH_SIZE: usize = 4; // anchor serializes String as vec<u8> with 4-byte len
pub const MAX_SUPPORTED_TOKEN_MINTS: usize = 10;
pub const REWARD_CLAIMED_SPACE: usize = DISCRIMINATOR_SIZE + // discriminator
    PUBKEY_SIZE + // quest (pubkey)
    PUBKEY_SIZE + // winner (pubkey)
    U64_SIZE + // reward_amount
    BOOL_SIZE; // claimed

// Space constants for Quest
pub const MAX_QUEST_ID_LENGTH: usize = 36;
pub const U64_SIZE: usize = 8;
pub const U32_SIZE: usize = 4;

// Calculated space constants
pub const GLOBAL_STATE_SPACE: usize = DISCRIMINATOR_SIZE + // discriminator
    PUBKEY_SIZE + // owner pubkey
    BOOL_SIZE + // paused bool
    VEC_LENGTH_SIZE + // vec len for supported_token_mints
    (PUBKEY_SIZE * MAX_SUPPORTED_TOKEN_MINTS) + // space for up to 10 token mints
    U32_SIZE; // quest_count

pub const QUEST_SPACE: usize = DISCRIMINATOR_SIZE + // discriminator
    STRING_LENGTH_SIZE + MAX_QUEST_ID_LENGTH + // id string (max)
    PUBKEY_SIZE + // creator pubkey
    PUBKEY_SIZE + // token mint pubkey
    PUBKEY_SIZE + // escrow account pubkey
    U64_SIZE + // amount
    U64_SIZE + // deadline
    BOOL_SIZE + // is_active
    U32_SIZE + // total_winners
    U64_SIZE + // total_reward_distributed
    U32_SIZE; // max_winners

#[account]
pub struct GlobalState {
    pub owner: Pubkey,
    pub paused: bool,
    pub supported_token_mints: Vec<Pubkey>,
    pub quest_count: u32,
}

#[account]
pub struct Quest {
    pub id: String,
    pub creator: Pubkey,
    pub token_mint: Pubkey,
    pub escrow_account: Pubkey,
    pub amount: u64,
    pub deadline: i64,
    pub is_active: bool,
    pub total_winners: u32,
    pub total_reward_distributed: u64,
    pub max_winners: u32,
}

#[account]
pub struct RewardClaimed {
    pub quest: Pubkey, // Using Pubkey instead of String for consistency
    pub winner: Pubkey,
    pub reward_amount: u64,
    pub claimed: bool,
}
