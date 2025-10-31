use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use anchor_spl::{
    associated_token::{self, AssociatedToken, Create},
    token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer},
};

mod constants;
use constants::{
    GlobalState, Quest, RewardClaimed, GLOBAL_STATE_SEED, GLOBAL_STATE_SPACE, MAX_BATCH_RECIPIENTS,
    QUEST_SPACE, REWARD_CLAIMED_SPACE,
};

declare_id!("9ctNgXvXeorsripJP7K61CH1UytzoMNzvPtQFBrFK5qU");

#[program]
pub mod svm_contracts {
    use super::*;

    // ----------------- Admin & Setup -----------------

    pub fn initialize(ctx: Context<Initialize>, supported_token_mints: Vec<Pubkey>) -> Result<()> {
        let gs = &mut ctx.accounts.global_state;
        gs.owner = ctx.accounts.owner.key();
        gs.paused = false;
        require!(
            supported_token_mints.len() <= constants::MAX_SUPPORTED_TOKEN_MINTS,
            CustomError::TooManySupportedMints
        );
        gs.supported_token_mints = supported_token_mints;
        Ok(())
    }

    pub fn create_quest(
        ctx: Context<CreateQuest>,
        quest_id: String,
        amount: u64,
        deadline: i64,
        max_winners: u32,
    ) -> Result<()> {
        require!(!ctx.accounts.global_state.paused, CustomError::ContractPaused);
        require!(amount > 0, CustomError::InvalidAmount);
        require!(max_winners > 0, CustomError::InvalidMaxWinners);
        require!(Clock::get()?.unix_timestamp < deadline, CustomError::InvalidDeadline);

        // Validate that the quest account is at the correct PDA address
        let (expected_quest_pda, _bump) = Pubkey::find_program_address(
            &[b"quest", quest_id.as_bytes()],
            ctx.program_id,
        );
        require!(
            expected_quest_pda == ctx.accounts.quest.key(),
            CustomError::InvalidQuestPda
        );

        require!(
            ctx.accounts
                .global_state
                .supported_token_mints
                .contains(&ctx.accounts.token_mint.key()),
            CustomError::UnsupportedTokenMint
        );

        let quest = &mut ctx.accounts.quest;
        quest.id = quest_id.clone();
        quest.creator = ctx.accounts.creator.key();
        quest.token_mint = ctx.accounts.token_mint.key();
        quest.escrow_account = ctx.accounts.escrow_account.key();
        quest.amount = amount;
        quest.deadline = deadline;
        quest.is_active = true;
        quest.total_winners = 0;
        quest.total_reward_distributed = 0;
        quest.max_winners = max_winners;

        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.creator_token_account.to_account_info(),
                to: ctx.accounts.escrow_account.to_account_info(),
                authority: ctx.accounts.creator.to_account_info(),
            },
        );
        token::transfer(cpi, amount)?;

        emit!(QuestCreated {
            quest: quest.key(),
            quest_id: quest_id.clone(),
            mint: quest.token_mint,
            budget: amount,
            deadline,
            creator: quest.creator
        });

        Ok(())
    }

    // ----------------- Quest lifecycle -----------------

    pub fn update_quest_status(ctx: Context<UpdateQuestStatus>, is_active: bool) -> Result<()> {
        require!(
            ctx.accounts.owner.key() == ctx.accounts.global_state.owner,
            CustomError::UnauthorizedStatusUpdate
        );
        ctx.accounts.quest.is_active = is_active;
        Ok(())
    }

    pub fn add_supported_token(ctx: Context<ModifyToken>) -> Result<()> {
        let gs = &mut ctx.accounts.global_state;
        require!(ctx.accounts.owner.key() == gs.owner, CustomError::UnauthorizedTokenModification);
        require!(
            !gs.supported_token_mints.contains(&ctx.accounts.token_mint.key()),
            CustomError::TokenAlreadySupported
        );
        require!(
            gs.supported_token_mints.len() < constants::MAX_SUPPORTED_TOKEN_MINTS,
            CustomError::TooManySupportedMints
        );
        gs.supported_token_mints.push(ctx.accounts.token_mint.key());
        Ok(())
    }

    pub fn remove_supported_token(ctx: Context<ModifyToken>) -> Result<()> {
        let gs = &mut ctx.accounts.global_state;
        require!(ctx.accounts.owner.key() == gs.owner, CustomError::UnauthorizedTokenModification);
        let tm = ctx.accounts.token_mint.key();
        let pos = gs
            .supported_token_mints
            .iter()
            .position(|x| *x == tm)
            .ok_or(CustomError::TokenNotFound)?;
        gs.supported_token_mints.remove(pos);
        Ok(())
    }

    pub fn pause(ctx: Context<PauseContract>) -> Result<()> {
        let gs = &mut ctx.accounts.global_state;
        require!(ctx.accounts.owner.key() == gs.owner, CustomError::UnauthorizedPauseAction);
        require!(!gs.paused, CustomError::AlreadyPaused);
        gs.paused = true;
        emit!(Paused { admin: gs.owner });
        Ok(())
    }

    pub fn unpause(ctx: Context<PauseContract>) -> Result<()> {
        let gs = &mut ctx.accounts.global_state;
        require!(ctx.accounts.owner.key() == gs.owner, CustomError::UnauthorizedPauseAction);
        require!(gs.paused, CustomError::AlreadyUnpaused);
        gs.paused = false;
        emit!(Unpaused { admin: gs.owner });
        Ok(())
    }

    // ----------------- Cancel Quest -----------------
    pub fn cancel_quest(ctx: Context<CancelQuest>) -> Result<()> {
        let q = &mut ctx.accounts.quest;
        require!(q.is_active, CustomError::QuestNotActive);
        require!(q.creator == ctx.accounts.creator.key(), CustomError::UnauthorizedCancellation);

        let signer_seeds: &[&[&[u8]]] = &[&[GLOBAL_STATE_SEED, &[ctx.bumps.global_state]]];

        let remaining = ctx.accounts.escrow_account.amount;
        if remaining > 0 {
            let cpi = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow_account.to_account_info(),
                    to: ctx.accounts.creator_token_account.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(cpi, remaining)?;
        }

        let close_cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.escrow_account.to_account_info(),
                destination: ctx.accounts.creator.to_account_info(),
                authority: ctx.accounts.global_state.to_account_info(),
            },
            signer_seeds,
        );
        token::close_account(close_cpi)?;

        q.is_active = false;

        emit!(QuestCancelled {
            quest: q.key(),
            creator: q.creator,
            refunded: remaining
        });

        Ok(())
    }

    // ----------------- SPL: BATCH REWARDS -----------------
    pub fn send_reward_batch<'a>(
        ctx: Context<'a, SendRewardBatch<'a>>,
        total_amount: u64,
        recipients: Vec<RecipientBps>,
        create_atas: bool,
    ) -> Result<()> {
        require!(!ctx.accounts.global_state.paused, CustomError::ContractPaused);
        require!(total_amount > 0, CustomError::InvalidAmount);
        require!(
            recipients.len() > 0 && recipients.len() <= MAX_BATCH_RECIPIENTS,
            CustomError::TooManyRecipients
        );

        let signer = ctx.accounts.signer.key();
        require!(
            signer == ctx.accounts.global_state.owner,
            CustomError::UnauthorizedRewardAction
        );

        let q = &mut ctx.accounts.quest;
        require!(q.is_active, CustomError::QuestNotActive);
        require!(Clock::get()?.unix_timestamp <= q.deadline, CustomError::InvalidDeadline);

        require!(
            q.total_reward_distributed.saturating_add(total_amount) <= q.amount,
            CustomError::InsufficientRewardBalance
        );
        require!(
            ctx.accounts.escrow_account.amount >= total_amount,
            CustomError::InsufficientRewardBalance
        );

        let sum_bps: u32 = recipients.iter().map(|r| r.bps as u32).sum();
        require!(sum_bps == 10_000, CustomError::InvalidBps);

        let expected = recipients.len() * 3;
        require!(
            ctx.remaining_accounts.len() == expected,
            CustomError::InvalidRemainingAccountsLayout
        );

        let signer_seeds: &[&[&[u8]]] = &[&[GLOBAL_STATE_SEED, &[ctx.bumps.global_state]]];
        let mut idx = 0usize;
        let mut distributed: u64 = 0;
        let mut winners_increment: u32 = 0;

        for (i, r) in recipients.iter().enumerate() {
            let recipient_ai = &ctx.remaining_accounts[idx];
            let recipient_ata_ai = &ctx.remaining_accounts[idx + 1];
            let reward_claimed_ai = &ctx.remaining_accounts[idx + 2];
            idx += 3;

            require!(
                *recipient_ai.key == r.recipient,
                CustomError::RecipientKeyMismatch
            );

            let mut amount = ((total_amount as u128 * r.bps as u128) / 10_000) as u64;
            if i == recipients.len() - 1 {
                amount = total_amount.saturating_sub(distributed);
            }
            require!(amount > 0, CustomError::InvalidAmount);

            if recipient_ata_ai.data_is_empty() {
                let expected_ata = anchor_spl::associated_token::get_associated_token_address(
                    &r.recipient,
                    &q.token_mint,
                );
                require!(
                    expected_ata == recipient_ata_ai.key(),
                    CustomError::InvalidAtaForRecipient
                );
                require!(create_atas, CustomError::AtaMissing);

                let rent_needed = Rent::get()?.minimum_balance(165);
                require!(
                    ctx.accounts.signer.to_account_info().lamports() >= rent_needed,
                    CustomError::InsufficientLamportsForAta
                );

                let payer_ai = ctx.accounts.signer.to_account_info();
                let associated_token_program_ai = ctx.accounts.associated_token_program.to_account_info();
                let mint_ai = ctx.accounts.token_mint.to_account_info();
                let system_program_ai = ctx.accounts.system_program.to_account_info();
                let token_program_ai = ctx.accounts.token_program.to_account_info();
                
                let create_cpi = CpiContext::new(
                    associated_token_program_ai.clone(),
                    Create {
                        payer: payer_ai.clone(),
                        associated_token: recipient_ata_ai.clone(),
                        authority: recipient_ai.clone(),
                        mint: mint_ai.clone(),
                        system_program: system_program_ai.clone(),
                        token_program: token_program_ai.clone(),
                    },
                );
                associated_token::create(create_cpi)?;
            }

            // RewardClaimed PDA
            if reward_claimed_ai.data_is_empty() {
                let lamports = Rent::get()?.minimum_balance(REWARD_CLAIMED_SPACE);
                let signer_key = ctx.accounts.signer.key();
                let reward_claimed_key = reward_claimed_ai.key();
                let create_ix = anchor_lang::solana_program::system_instruction::create_account(
                    &signer_key,
                    &reward_claimed_key,
                    lamports,
                    REWARD_CLAIMED_SPACE as u64,
                    &crate::ID,
                );
                let signer_ai = ctx.accounts.signer.to_account_info();
                let reward_claimed_ai_clone = reward_claimed_ai.clone();
                let system_program_ai = ctx.accounts.system_program.to_account_info();
                anchor_lang::solana_program::program::invoke(
                    &create_ix,
                    &[
                        signer_ai,
                        reward_claimed_ai_clone,
                        system_program_ai,
                    ],
                )?;
                let mut data = reward_claimed_ai.try_borrow_mut_data()?;
                let disc = RewardClaimed::discriminator();
                data[..8].copy_from_slice(&disc);
            }

            // transfer tokens
            let token_program_ai = ctx.accounts.token_program.to_account_info();
            let from_escrow_ai = ctx.accounts.escrow_account.to_account_info();
            let to_recipient_ai = recipient_ata_ai.clone();
            let authority_ai = ctx.accounts.global_state.to_account_info();

            let cpi = CpiContext::new_with_signer(
                token_program_ai,
                Transfer {
                    from: from_escrow_ai,
                    to: to_recipient_ai,
                    authority: authority_ai,
                },
                signer_seeds,
            );
            token::transfer(cpi, amount)?;

            distributed = distributed.saturating_add(amount);
            winners_increment = winners_increment.saturating_add(1);
        }

        require!(distributed == total_amount, CustomError::RoundingError);

        q.total_reward_distributed = q.total_reward_distributed.saturating_add(distributed);
        q.total_winners = q.total_winners.saturating_add(winners_increment);

        emit!(RewardBatchSent {
            quest: q.key(),
            total: distributed,
            recipients: recipients.iter().map(|r| r.recipient).collect(),
        });

        Ok(())
    }

    // ----------------- External Airdrop -----------------
    // ----------------- EXTERNAL (PROGRAMMATIC) AIRDROP SUPPORT -----------------
    // Use this pair when your dispatcher decides to run zk-compressed airdrops
    // via AirShip/Light off-chain. No "raffle" state is stored on-chain.

    pub fn fund_external_airdrop(
        ctx: Context<FundExternalAirdrop>,
        amount: u64,
        batch_id: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.global_state.paused, CustomError::ContractPaused);
        let signer = ctx.accounts.signer.key();
        let q = &mut ctx.accounts.quest;

        // auth: admin or quest creator (for now removed authority to creator since they can take advantage of it)
        require!(
            signer == ctx.accounts.global_state.owner,
            CustomError::UnauthorizedRewardAction
        );
        require!(q.is_active, CustomError::QuestNotActive);
        require!(Clock::get()?.unix_timestamp <= q.deadline, CustomError::InvalidDeadline);
        require!(amount > 0, CustomError::InvalidAmount);
        require!(ctx.accounts.escrow_account.mint == q.token_mint, CustomError::UnsupportedTokenMint);
        require!(ctx.accounts.distributor_ata.mint == q.token_mint, CustomError::UnsupportedTokenMint);
        require!(ctx.accounts.escrow_account.amount >= amount, CustomError::InsufficientRewardBalance);

        // Transfer from escrow PDA to distributor ATA
        let signer_seeds: &[&[&[u8]]] = &[&[GLOBAL_STATE_SEED, &[ctx.bumps.global_state]]];
        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.escrow_account.to_account_info(),
                to: ctx.accounts.distributor_ata.to_account_info(),
                authority: ctx.accounts.global_state.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi, amount)?;

        emit!(ExternalAirdropPlanned {
            quest: q.key(),
            mint: q.token_mint,
            distributor_ata: ctx.accounts.distributor_ata.key(),
            amount,
            batch_id,
        });
        Ok(())
    }

    pub fn settle_external_airdrop(
        ctx: Context<SettleExternalAirdrop>,
        distributed: u64,
        winners_count: u32,
        batch_id: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.global_state.paused, CustomError::ContractPaused);
        let signer = ctx.accounts.signer.key();
        let q = &mut ctx.accounts.quest;

        require!(
            signer == ctx.accounts.global_state.owner,
            CustomError::UnauthorizedRewardAction
        );
        require!(distributed > 0, CustomError::InvalidAmount);
        // ensure we don't overshoot quest budget
        require!(
            q.total_reward_distributed.saturating_add(distributed) <= q.amount,
            CustomError::InsufficientRewardBalance
        );

        q.total_reward_distributed = q.total_reward_distributed.saturating_add(distributed);
        q.total_winners = q.total_winners.saturating_add(winners_count);

        emit!(ExternalAirdropSettled {
            quest: q.key(),
            distributed,
            winners_count,
            batch_id,
        });
        Ok(())
    }

    // ----------------- Withdraw remaining after deadline -----------------

    pub fn claim_remaining_reward(ctx: Context<ClaimRemainingReward>) -> Result<()> {
        require!(!ctx.accounts.global_state.paused, CustomError::ContractPaused);

        let q = &mut ctx.accounts.quest;

        require!(
            q.creator == ctx.accounts.claimer.key()
                || ctx.accounts.claimer.key() == ctx.accounts.global_state.owner,
            CustomError::UnauthorizedWithdrawal
        );
        require!(!q.is_active, CustomError::QuestNotActive);

        let now = Clock::get()?.unix_timestamp;
        require!(now >= q.deadline + 604800, CustomError::WithdrawalTooEarly);

        let remaining = q.amount.saturating_sub(q.total_reward_distributed);
        require!(remaining > 0, CustomError::NoTokensToWithdraw);

        q.amount = q.total_reward_distributed;

        let signer_seeds: &[&[&[u8]]] = &[&[GLOBAL_STATE_SEED, &[ctx.bumps.global_state]]];

        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.escrow_account.to_account_info(),
                to: ctx.accounts.creator_token_account.to_account_info(),
                authority: ctx.accounts.global_state.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi, remaining)?;

        let close_cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.escrow_account.to_account_info(),
                destination: ctx.accounts.claimer.to_account_info(),
                authority: ctx.accounts.global_state.to_account_info(),
            },
            signer_seeds,
        );
        token::close_account(close_cpi)?;

        emit!(RemainingClaimed {
            quest: q.key(),
            to: ctx.accounts.creator_token_account.owner,
            amount: remaining
        });

        Ok(())
    }
}

// ----------------- Types -----------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub struct RecipientBps {
    pub recipient: Pubkey,
    pub bps: u16, // parts per 10_000
}

// ----------------- Errors -----------------
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
    #[msg("Unauthorized status update")]
    UnauthorizedStatusUpdate,
    #[msg("Unauthorized token modification")]
    UnauthorizedTokenModification,
    #[msg("Token already supported")]
    TokenAlreadySupported,
    #[msg("Token not found")]
    TokenNotFound,
    #[msg("Unauthorized pause/unpause action")]
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
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid max_winners")]
    InvalidMaxWinners,
    #[msg("Invalid deadline")]
    InvalidDeadline,
    #[msg("Too many supported mints")]
    TooManySupportedMints,
    #[msg("Sum of bps must be 10_000")]
    InvalidBps,
    #[msg("Invalid remaining accounts layout")]
    InvalidRemainingAccountsLayout,
    #[msg("Recipient key mismatch")]
    RecipientKeyMismatch,
    #[msg("Invalid ATA for recipient")]
    InvalidAtaForRecipient,
    #[msg("Rounding error")]
    RoundingError,
    #[msg("Too many recipients")]
    TooManyRecipients,
    #[msg("Recipient ATA missing")]
    AtaMissing,
    #[msg("Payer has insufficient lamports for ATA creation")]
    InsufficientLamportsForAta,
    #[msg("Invalid quest PDA")]
    InvalidQuestPda,
}

// ----------------- Events -----------------
#[event]
pub struct QuestCreated {
    pub quest: Pubkey,
    pub quest_id: String,
    pub mint: Pubkey,
    pub budget: u64,
    pub deadline: i64,
    pub creator: Pubkey,
}

#[event]
pub struct RewardBatchSent {
    pub quest: Pubkey,
    pub total: u64,
    pub recipients: Vec<Pubkey>,
}

#[event]
pub struct QuestCancelled {
    pub quest: Pubkey,
    pub creator: Pubkey,
    pub refunded: u64,
}

#[event]
pub struct RemainingClaimed {
    pub quest: Pubkey,
    pub to: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Paused {
    pub admin: Pubkey,
}

#[event]
pub struct Unpaused {
    pub admin: Pubkey,
}

#[event]
pub struct ExternalAirdropPlanned {
    pub quest: Pubkey,
    pub mint: Pubkey,
    pub distributor_ata: Pubkey,
    pub amount: u64,
    pub batch_id: u64,
}

#[event]
pub struct ExternalAirdropSettled {
    pub quest: Pubkey,
    pub distributed: u64,
    pub winners_count: u32,
    pub batch_id: u64,
}

// ----------------- Accounts -----------------

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

    #[account(mut, seeds = [GLOBAL_STATE_SEED], bump)]
    pub global_state: Account<'info, GlobalState>,

    pub token_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    #[account(
        init,
        payer = creator,
        space = QUEST_SPACE
    )]
    pub quest: Account<'info, Quest>,

    #[account(
        init,
        payer = creator,
        seeds = [b"escrow", quest.key().as_ref()],
        bump,
        token::mint = token_mint,
        token::authority = global_state
    )]
    pub escrow_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = creator_token_account.mint == token_mint.key(),
        constraint = creator_token_account.owner == creator.key()
    )]
    pub creator_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
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
pub struct CancelQuest<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(mut, seeds = [GLOBAL_STATE_SEED], bump)]
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
pub struct SendRewardBatch<'info> {
    /// Payer + authority (admin or quest creator)
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(mut, seeds = [GLOBAL_STATE_SEED], bump)]
    pub global_state: Account<'info, GlobalState>,

    #[account(mut)]
    pub quest: Account<'info, Quest>,

    #[account(
        mut,
        constraint = escrow_account.mint == quest.token_mint,
        constraint = escrow_account.owner == global_state.key()
    )]
    pub escrow_account: Account<'info, TokenAccount>,

    pub token_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundExternalAirdrop<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(mut, seeds = [GLOBAL_STATE_SEED], bump)]
    pub global_state: Account<'info, GlobalState>,

    #[account(mut)]
    pub quest: Account<'info, Quest>,

    #[account(
        mut,
        constraint = escrow_account.mint == quest.token_mint,
        constraint = escrow_account.owner == global_state.key()
    )]
    pub escrow_account: Account<'info, TokenAccount>,

    /// Distributor ATA owned by your off-chain airdrop signer
    #[account(mut)]
    pub distributor_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SettleExternalAirdrop<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(mut, seeds = [GLOBAL_STATE_SEED], bump)]
    pub global_state: Account<'info, GlobalState>,

    #[account(mut)]
    pub quest: Account<'info, Quest>,
}

#[derive(Accounts)]
pub struct ClaimRemainingReward<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,

    #[account(mut, seeds = [GLOBAL_STATE_SEED], bump)]
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
