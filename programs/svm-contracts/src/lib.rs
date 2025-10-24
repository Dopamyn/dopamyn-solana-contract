use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
mod constants;
use constants::RewardClaimed;
use constants::{
    GlobalState, Quest, GLOBAL_STATE_SEED, GLOBAL_STATE_SPACE, QUEST_SPACE, REWARD_CLAIMED_SPACE,
};

declare_id!("43RRcJN1k3kVRDx4i3dNHtCEaY7NCZeaPJe7p7u6vcUd");

#[program]
pub mod svm_contracts {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, supported_token_mints: Vec<Pubkey>) -> Result<()> {
        let global_state = &mut ctx.accounts.global_state;
        global_state.owner = ctx.accounts.owner.key();
        global_state.paused = false;
        global_state.supported_token_mints = supported_token_mints;
        global_state.quests = Vec::new();
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
        global_state.quests.push(id);

        Ok(())
    }

    pub fn get_quest_info(ctx: Context<GetQuestInfo>) -> Result<Quest> {
        Ok((*ctx.accounts.quest).clone())
    }

    pub fn get_all_quests(ctx: Context<GetAllQuests>) -> Result<Vec<String>> {
        let global_state = &ctx.accounts.global_state;
        Ok(global_state.quests.clone())
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

    pub fn send_reward(ctx: Context<SendReward>, reward_amount: u64) -> Result<()> {
        require!(
            !ctx.accounts.global_state.paused,
            CustomError::ContractPaused
        );
        require!(
            ctx.accounts.owner.key() == ctx.accounts.global_state.owner,
            CustomError::UnauthorizedRewardAction
        );

        let quest = &mut ctx.accounts.quest;
        require!(quest.is_active, CustomError::QuestNotActive);
        require!(
            quest.total_reward_distributed + reward_amount <= quest.amount,
            CustomError::InsufficientRewardBalance
        );
        require!(
            quest.total_winners < quest.max_winners,
            CustomError::MaxWinnersReached
        );

        // Check if winner has already claimed reward
        let reward_claimed_pda = &mut ctx.accounts.reward_claimed;
        require!(!reward_claimed_pda.claimed, CustomError::AlreadyRewarded);

        // Update quest state
        quest.total_reward_distributed += reward_amount;
        quest.total_winners += 1;

        // Initialize reward claimed account
        reward_claimed_pda.quest_id = quest.id.clone();
        reward_claimed_pda.winner = ctx.accounts.winner.key();
        reward_claimed_pda.reward_amount = reward_amount;
        reward_claimed_pda.claimed = true;

        // Transfer reward tokens from escrow to winner
        let signer_seeds: &[&[&[u8]]] = &[&[GLOBAL_STATE_SEED, &[ctx.bumps.global_state]]];
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_account.to_account_info(),
                to: ctx.accounts.winner_token_account.to_account_info(),
                authority: ctx.accounts.global_state.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, reward_amount)?;

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
}

#[error_code]
pub enum CustomError {
    #[msg(ERR_CONTRACT_PAUSED)]
    ContractPaused,
    #[msg(ERR_UNSUPPORTED_TOKEN_MINT)]
    UnsupportedTokenMint,
    #[msg(ERR_UNAUTHORIZED_CANCELLATION)]
    UnauthorizedCancellation,
    #[msg(ERR_QUEST_NOT_ACTIVE)]
    QuestNotActive,
    #[msg(ERR_QUEST_ALREADY_CANCELLED)]
    QuestAlreadyCancelled,
    #[msg(ERR_UNAUTHORIZED_STATUS_UPDATE)]
    UnauthorizedStatusUpdate,
    #[msg(ERR_UNAUTHORIZED_TOKEN_MODIFICATION)]
    UnauthorizedTokenModification,
    #[msg(ERR_TOKEN_ALREADY_SUPPORTED)]
    TokenAlreadySupported,
    #[msg(ERR_TOKEN_NOT_FOUND)]
    TokenNotFound,
    #[msg(ERR_UNAUTHORIZED_PAUSE_ACTION)]
    UnauthorizedPauseAction,
    #[msg(ERR_ALREADY_PAUSED)]
    AlreadyPaused,
    #[msg(ERR_ALREADY_UNPAUSED)]
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
        init,
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
