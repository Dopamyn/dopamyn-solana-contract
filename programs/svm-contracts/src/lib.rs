use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
mod constants;
use constants::RewardClaimed;
use constants::{
    GlobalState, Quest, GLOBAL_STATE_SEED, GLOBAL_STATE_SPACE, QUEST_SPACE, REWARD_CLAIMED_SPACE,
};

declare_id!("DRZkDTej9HHkd8NgBdG76C4dFa3wFmbqBT7Sfd5kW7Ky");

#[program]
pub mod svm_contracts {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, supported_token_mints: Vec<Pubkey>) -> Result<()> {
        let global_state = &mut ctx.accounts.global_state;
        global_state.owner = ctx.accounts.owner.key();
        global_state.paused = false;
        global_state.supported_token_mints = supported_token_mints;
        global_state.quest_count = 0;
        Ok(())
    }

    pub fn create_quest(
        ctx: Context<CreateQuest>,
        id: String,
        amount: u64,
        deadline: i64,
        max_winners: u32,
    ) -> Result<()> {
        require!(
            !ctx.accounts.global_state.paused,
            CustomError::ContractPaused
        );
        require!(
            ctx.accounts
                .global_state
                .supported_token_mints
                .contains(&ctx.accounts.token_mint.key()),
            CustomError::UnsupportedTokenMint
        );

        let quest = &mut ctx.accounts.quest;
        quest.id = id.clone();
        quest.creator = ctx.accounts.creator.key();
        quest.token_mint = ctx.accounts.token_mint.key();
        quest.escrow_account = ctx.accounts.escrow_account.key();
        quest.amount = amount;
        quest.deadline = deadline;
        quest.is_active = true;
        quest.total_winners = 0;
        quest.total_reward_distributed = 0;
        quest.max_winners = max_winners;

        // Transfer tokens from creator to escrow account
        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.creator_token_account.to_account_info(),
                to: ctx.accounts.escrow_account.to_account_info(),
                authority: ctx.accounts.creator.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;

        let global_state = &mut ctx.accounts.global_state;
        global_state.quest_count = global_state.quest_count.saturating_add(1);

        Ok(())
    }

    pub fn get_quest_info(ctx: Context<GetQuestInfo>) -> Result<Quest> {
        Ok((*ctx.accounts.quest).clone())
    }

    pub fn get_all_quests(ctx: Context<GetAllQuests>) -> Result<Vec<String>> {
        let global_state = &ctx.accounts.global_state;
        // NOTE: quests changed to Vec<Pubkey> for consistency.
        // This function is deprecated; prefer fetching quest accounts directly client-side.
        Ok(Vec::new())
    }

    pub fn cancel_quest(ctx: Context<CancelQuest>) -> Result<()> {
        let quest = &mut ctx.accounts.quest;

        require!(quest.is_active, CustomError::QuestNotActive);
        require!(
            quest.creator == ctx.accounts.creator.key(),
            CustomError::UnauthorizedCancellation
        );

        let signer_seeds: &[&[&[u8]]] = &[&[GLOBAL_STATE_SEED, &[ctx.bumps.global_state]]];

        // Transfer tokens back to creator
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_account.to_account_info(),
                to: ctx.accounts.creator_token_account.to_account_info(),
                authority: ctx.accounts.global_state.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, ctx.accounts.escrow_account.amount)?;

        quest.is_active = false;
        Ok(())
    }

    pub fn update_quest_status(ctx: Context<UpdateQuestStatus>, is_active: bool) -> Result<()> {
        require!(
            ctx.accounts.owner.key() == ctx.accounts.global_state.owner,
            CustomError::UnauthorizedStatusUpdate
        );

        let quest = &mut ctx.accounts.quest;
        quest.is_active = is_active;
        Ok(())
    }

    pub fn add_supported_token(ctx: Context<ModifyToken>) -> Result<()> {
        require!(
            ctx.accounts.owner.key() == ctx.accounts.global_state.owner,
            CustomError::UnauthorizedTokenModification
        );

        let global_state = &mut ctx.accounts.global_state;
        let token_mint = ctx.accounts.token_mint.key();

        require!(
            !global_state.supported_token_mints.contains(&token_mint),
            CustomError::TokenAlreadySupported
        );

        global_state.supported_token_mints.push(token_mint);
        Ok(())
    }

    pub fn remove_supported_token(ctx: Context<ModifyToken>) -> Result<()> {
        require!(
            ctx.accounts.owner.key() == ctx.accounts.global_state.owner,
            CustomError::UnauthorizedTokenModification
        );

        let global_state = &mut ctx.accounts.global_state;
        let token_mint = ctx.accounts.token_mint.key();

        let position = global_state
            .supported_token_mints
            .iter()
            .position(|x| *x == token_mint)
            .ok_or(CustomError::TokenNotFound)?;

        global_state.supported_token_mints.remove(position);
        Ok(())
    }

    pub fn pause(ctx: Context<PauseContract>) -> Result<()> {
        require!(
            ctx.accounts.owner.key() == ctx.accounts.global_state.owner,
            CustomError::UnauthorizedPauseAction
        );

        let global_state = &mut ctx.accounts.global_state;
        require!(!global_state.paused, CustomError::AlreadyPaused);

        global_state.paused = true;
        Ok(())
    }

    pub fn unpause(ctx: Context<PauseContract>) -> Result<()> {
        require!(
            ctx.accounts.owner.key() == ctx.accounts.global_state.owner,
            CustomError::UnauthorizedPauseAction
        );

        let global_state = &mut ctx.accounts.global_state;
        require!(global_state.paused, CustomError::AlreadyUnpaused);

        global_state.paused = false;
        Ok(())
    }

    pub fn set_owner(ctx: Context<SetOwner>, new_owner: Pubkey) -> Result<()> {
        // Only current owner can rotate ownership
        require!(
            ctx.accounts.current_owner.key() == ctx.accounts.global_state.owner,
            CustomError::UnauthorizedRewardAction
        );

        let global_state = &mut ctx.accounts.global_state;
        global_state.owner = new_owner;
        Ok(())
    }

    pub fn send_reward(
        ctx: Context<SendReward>,
        main_winner_amount: u64,
        referrer_winners: Vec<Pubkey>,
        referrer_amounts: Vec<u64>,
        skip_claimed_check: bool,
    ) -> Result<()> {
        require!(
            !ctx.accounts.global_state.paused,
            CustomError::ContractPaused
        );
        require!(
            ctx.accounts.owner.key() == ctx.accounts.global_state.owner,
            CustomError::UnauthorizedRewardAction
        );

        // Validate referrer lists match
        require!(
            referrer_winners.len() == referrer_amounts.len(),
            CustomError::InvalidReferrerData
        );

        // Calculate total reward amount
        let referrer_total: u64 = referrer_amounts.iter().sum();
        let total_reward_amount = main_winner_amount
            .checked_add(referrer_total)
            .ok_or(CustomError::InvalidRewardAmount)?;

        // Store values before mutable borrow
        let quest_key = ctx.accounts.quest.key();
        let quest_token_mint = ctx.accounts.quest.token_mint;

        let quest = &mut ctx.accounts.quest;
        require!(quest.is_active, CustomError::QuestNotActive);
        require!(
            quest.total_reward_distributed + total_reward_amount <= quest.amount,
            CustomError::InsufficientRewardBalance
        );
        require!(
            quest.total_winners < quest.max_winners,
            CustomError::MaxWinnersReached
        );

        // Validate main winner token account (ATA) exists and is correct
        let winner_token = &ctx.accounts.winner_token_account;
        require!(
            winner_token.mint == quest_token_mint,
            CustomError::MissingAssociatedTokenAccount
        );
        require!(
            winner_token.owner == ctx.accounts.winner.key(),
            CustomError::MissingAssociatedTokenAccount
        );

        // Validate referrer token accounts from remaining_accounts
        require!(
            ctx.remaining_accounts.len() == referrer_winners.len(),
            CustomError::InvalidReferrerAccounts
        );

        // Check if main winner has already claimed reward (only if skip_claimed_check is false)
        let reward_claimed_pda = &mut ctx.accounts.reward_claimed;
        if !skip_claimed_check {
            require!(!reward_claimed_pda.claimed, CustomError::AlreadyRewarded);
        }

        // Update quest state
        quest.total_reward_distributed += total_reward_amount;
        // Only increment total_winners if this is the first time claiming for this winner
        if !reward_claimed_pda.claimed {
            quest.total_winners += 1;
        }

        // Initialize or update reward claimed account for main winner
        reward_claimed_pda.quest = quest_key;
        reward_claimed_pda.winner = ctx.accounts.winner.key();
        reward_claimed_pda.reward_amount += main_winner_amount; // Accumulate reward amount for multiple sends
        reward_claimed_pda.claimed = true;

        let signer_seeds: &[&[&[u8]]] = &[&[GLOBAL_STATE_SEED, &[ctx.bumps.global_state]]];

        // Transfer reward tokens from escrow to main winner
        if main_winner_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.escrow_account.to_account_info(),
                        to: ctx.accounts.winner_token_account.to_account_info(),
                        authority: ctx.accounts.global_state.to_account_info(),
                    },
                    signer_seeds,
                ),
                main_winner_amount,
            )?;
        }

        // Transfer reward tokens to each referrer
        // Note: Due to Anchor's Context lifetime constraints, we need to extract account infos
        // in a way that the borrow checker accepts. We do this by ensuring all operations
        // happen in a single expression where possible.
        for (i, amount) in referrer_amounts.iter().enumerate() {
            if *amount > 0 {
                let referrer_pubkey = &referrer_winners[i];

                // Validate referrer token account
                {
                    let referrer_token_account_info = &ctx.remaining_accounts[i];
                    let account_data = referrer_token_account_info.try_borrow_data()?;
                    if account_data.len() < 72 {
                        return Err(CustomError::MissingAssociatedTokenAccount.into());
                    }
                    let account_mint = Pubkey::try_from(&account_data[0..32])
                        .map_err(|_| CustomError::MissingAssociatedTokenAccount)?;
                    let account_owner = Pubkey::try_from(&account_data[32..64])
                        .map_err(|_| CustomError::MissingAssociatedTokenAccount)?;

                    require!(
                        account_mint == quest_token_mint,
                        CustomError::MissingAssociatedTokenAccount
                    );
                    require!(
                        account_owner == *referrer_pubkey,
                        CustomError::MissingAssociatedTokenAccount
                    );
                }

                // Extract account infos and perform transfer
                // Note: Due to Anchor's lifetime system, AccountInfo from remaining_accounts
                // and accounts have incompatible lifetimes. We work around this by cloning
                // AccountInfo values and using them immediately together.
                {
                    // SAFETY: AccountInfo is essentially a pointer wrapper containing:
                    // - key: Pubkey (Copy type)
                    // - lamports: Rc<RefCell<&'a mut u64>> (reference counted)
                    // - data: Rc<RefCell<&'a mut [u8]>> (reference counted)
                    // - owner: Pubkey (Copy type)
                    // - executable: bool (Copy type)
                    // - rent_epoch: u64 (Copy type)
                    //
                    // At runtime, the lifetimes don't matter since AccountInfo uses Rc (reference counting)
                    // for shared ownership. We clone from both sources and use them immediately together,
                    // which is safe because:
                    // 1. We've already validated the account data above
                    // 2. All AccountInfo values are used synchronously in the same CPI call
                    // 3. The underlying account data remains valid for the duration of the instruction
                    //
                    // The transmute is necessary to satisfy Rust's type system which sees incompatible
                    // lifetimes, but at runtime AccountInfo is just pointers/references that are valid
                    // for the entire instruction execution.
                    let to_account = ctx.remaining_accounts[i].clone();
                    let from_account = ctx.accounts.escrow_account.to_account_info();
                    let program_account = ctx.accounts.token_program.to_account_info();
                    let auth_account = ctx.accounts.global_state.to_account_info();

                    // SAFETY: We transmute AccountInfo<'a> to AccountInfo<'b> to unify lifetimes.
                    // This is safe because:
                    // 1. AccountInfo uses Rc for shared ownership, so the underlying data persists
                    // 2. All accounts are valid for the entire instruction execution
                    // 3. We use the AccountInfo values immediately in the CPI call
                    // 4. We've validated the account structure and ownership above
                    unsafe {
                        // Transmute the lifetime parameter only - the actual data structure is unchanged
                        let to_account_unified: AccountInfo = std::mem::transmute_copy(&to_account);
                        token::transfer(
                            CpiContext::new_with_signer(
                                program_account,
                                Transfer {
                                    from: from_account,
                                    to: to_account_unified,
                                    authority: auth_account,
                                },
                                signer_seeds,
                            ),
                            *amount,
                        )?;
                    }
                }
            }
        }

        Ok(())
    }

    pub fn claim_remaining_reward(ctx: Context<ClaimRemainingReward>) -> Result<()> {
        require!(
            !ctx.accounts.global_state.paused,
            CustomError::ContractPaused
        );

        let quest = &mut ctx.accounts.quest;

        // Only quest creator or admin can call this function
        require!(
            quest.creator == ctx.accounts.claimer.key()
                || ctx.accounts.claimer.key() == ctx.accounts.global_state.owner,
            CustomError::UnauthorizedWithdrawal
        );

        // Quest must be inactive (ended)
        require!(!quest.is_active, CustomError::QuestNotActive);

        // Must wait 1 week after quest deadline (7 days = 604800 seconds)
        let current_timestamp = Clock::get()?.unix_timestamp;
        require!(
            current_timestamp >= quest.deadline + 604800,
            CustomError::WithdrawalTooEarly
        );

        // Calculate remaining unclaimed amount
        let remaining_amount = quest.amount - quest.total_reward_distributed;
        require!(remaining_amount > 0, CustomError::NoTokensToWithdraw);

        // Update the quest to prevent double claiming by setting amount to distributed amount
        quest.amount = quest.total_reward_distributed;

        // Transfer remaining tokens to creator
        let signer_seeds: &[&[&[u8]]] = &[&[GLOBAL_STATE_SEED, &[ctx.bumps.global_state]]];
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_account.to_account_info(),
                to: ctx.accounts.creator_token_account.to_account_info(),
                authority: ctx.accounts.global_state.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, remaining_amount)?;

        Ok(())
    }

    pub fn get_reward_claimed_info(ctx: Context<GetRewardClaimedInfo>) -> Result<RewardClaimed> {
        Ok((*ctx.accounts.reward_claimed).clone())
    }

    pub fn close_reward_claimed(ctx: Context<CloseRewardClaimed>) -> Result<()> {
        let reward_claimed = &ctx.accounts.reward_claimed;

        // Verify that the reward was actually claimed
        require!(reward_claimed.claimed, CustomError::RewardNotClaimed);

        // Only owner or the winner who claimed the reward can close
        require!(
            ctx.accounts.closer.key() == ctx.accounts.global_state.owner
                || ctx.accounts.closer.key() == reward_claimed.winner,
            CustomError::UnauthorizedClosure
        );

        // The close constraint will handle closing the account and returning SOL to recipient
        // No additional logic needed - Anchor's close constraint handles everything
        Ok(())
    }
}

#[error_code]
pub enum CustomError {
    #[msg("Contract is paused")]
    ContractPaused,
    #[msg("Unsupported token mint")]
    UnsupportedTokenMint,
    #[msg("Unauthorized cancellation")]
    UnauthorizedCancellation,
    #[msg("Quest is not active")]
    QuestNotActive,
    #[msg("Quest already cancelled")]
    QuestAlreadyCancelled,
    #[msg("Unauthorized status update")]
    UnauthorizedStatusUpdate,
    #[msg("Unauthorized token modification")]
    UnauthorizedTokenModification,
    #[msg("Token already supported")]
    TokenAlreadySupported,
    #[msg("Token not found")]
    TokenNotFound,
    #[msg("Unauthorized pause action")]
    UnauthorizedPauseAction,
    #[msg("Already paused")]
    AlreadyPaused,
    #[msg("Already unpaused")]
    AlreadyUnpaused,
    #[msg("Unauthorized reward action")]
    UnauthorizedRewardAction,
    #[msg("Insufficient reward balance")]
    InsufficientRewardBalance,
    #[msg("Max winners limit reached")]
    MaxWinnersReached,
    #[msg("Winner has already been rewarded")]
    AlreadyRewarded,
    #[msg("Unauthorized withdrawal")]
    UnauthorizedWithdrawal,
    #[msg("No tokens to withdraw")]
    NoTokensToWithdraw,
    #[msg("Must wait 1 week after quest deadline")]
    WithdrawalTooEarly,
    #[msg("Missing associated token account (ATA) for the provided owner/mint. Please create the ATA before sending rewards.")]
    MissingAssociatedTokenAccount,
    #[msg("Reward has not been claimed yet")]
    RewardNotClaimed,
    #[msg("Unauthorized to close this reward claimed account")]
    UnauthorizedClosure,
    #[msg("Referrer winners and amounts lists must have the same length")]
    InvalidReferrerData,
    #[msg("Invalid reward amount (overflow detected)")]
    InvalidRewardAmount,
    #[msg("Number of referrer accounts does not match number of referrer winners")]
    InvalidReferrerAccounts,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = GLOBAL_STATE_SPACE,
        seeds = [GLOBAL_STATE_SEED],
        bump
    )]
    pub global_state: Account<'info, GlobalState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateQuest<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut)]
    pub global_state: Account<'info, GlobalState>,
    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    #[account(
        init,
        payer = creator,
        seeds = [b"escrow", quest.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = global_state,
    )]
    pub escrow_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = creator_token_account.mint == token_mint.key(),
        constraint = creator_token_account.owner == creator.key()
    )]
    pub creator_token_account: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = creator,
        space = QUEST_SPACE
    )]
    pub quest: Account<'info, Quest>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct GetQuestInfo<'info> {
    pub quest: Account<'info, Quest>,
}

#[derive(Accounts)]
pub struct GetAllQuests<'info> {
    pub global_state: Account<'info, GlobalState>,
}

#[derive(Accounts)]
pub struct CancelQuest<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: Account<'info, GlobalState>,
    #[account(mut)]
    pub quest: Account<'info, Quest>,
    #[account(
        mut,
        constraint = escrow_account.mint == quest.token_mint,
        constraint = escrow_account.owner == global_state.key()
    )]
    pub escrow_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = creator_token_account.mint == quest.token_mint,
        constraint = creator_token_account.owner == creator.key()
    )]
    pub creator_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateQuestStatus<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub global_state: Account<'info, GlobalState>,
    #[account(mut)]
    pub quest: Account<'info, Quest>,
}

#[derive(Accounts)]
pub struct ModifyToken<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub global_state: Account<'info, GlobalState>,
    pub token_mint: Account<'info, Mint>,
}

#[derive(Accounts)]
pub struct PauseContract<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub global_state: Account<'info, GlobalState>,
}

#[derive(Accounts)]
pub struct SendReward<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: Account<'info, GlobalState>,
    #[account(mut)]
    pub quest: Account<'info, Quest>,
    #[account(
        mut,
        constraint = escrow_account.mint == quest.token_mint,
        constraint = escrow_account.owner == global_state.key()
    )]
    pub escrow_account: Account<'info, TokenAccount>,
    /// CHECK: Winner account is safe because we only use it as a key for PDA derivation and token account verification
    pub winner: AccountInfo<'info>,
    #[account(
        mut,
        constraint = winner_token_account.mint == quest.token_mint,
        constraint = winner_token_account.owner == winner.key()
    )]
    pub winner_token_account: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = owner,
        space = REWARD_CLAIMED_SPACE,
        seeds = [b"reward_claimed", quest.key().as_ref(), winner.key().as_ref()],
        bump
    )]
    pub reward_claimed: Account<'info, RewardClaimed>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetOwner<'info> {
    #[account(mut)]
    pub current_owner: Signer<'info>,
    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: Account<'info, GlobalState>,
}

#[derive(Accounts)]
pub struct ClaimRemainingReward<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,
    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: Account<'info, GlobalState>,
    #[account(mut)]
    pub quest: Account<'info, Quest>,
    #[account(
        mut,
        constraint = escrow_account.mint == quest.token_mint,
        constraint = escrow_account.owner == global_state.key()
    )]
    pub escrow_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = creator_token_account.mint == quest.token_mint,
        constraint = creator_token_account.owner == quest.creator
    )]
    pub creator_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct GetRewardClaimedInfo<'info> {
    #[account(
        seeds = [b"reward_claimed", quest.key().as_ref(), winner.key().as_ref()],
        bump
    )]
    pub reward_claimed: Account<'info, RewardClaimed>,
    /// CHECK: Quest account is only used for PDA derivation
    pub quest: AccountInfo<'info>,
    /// CHECK: Winner account is only used for PDA derivation
    pub winner: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct CloseRewardClaimed<'info> {
    #[account(mut)]
    pub closer: Signer<'info>,
    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: Account<'info, GlobalState>,
    #[account(
        mut,
        close = recipient,
        seeds = [b"reward_claimed", quest.key().as_ref(), winner.key().as_ref()],
        bump
    )]
    pub reward_claimed: Account<'info, RewardClaimed>,
    /// CHECK: Quest account is only used for PDA derivation
    pub quest: AccountInfo<'info>,
    /// CHECK: Winner account is only used for PDA derivation
    pub winner: AccountInfo<'info>,
    /// CHECK: Recipient receives the closed account's rent
    #[account(mut)]
    pub recipient: AccountInfo<'info>,
}
