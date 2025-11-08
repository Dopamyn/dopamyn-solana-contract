import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountInstruction,
  createMint,
  getAccount,
  getAssociatedTokenAddress,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";
import { SvmContracts } from "../target/types/svm_contracts";

describe("svm-contracts", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.svmContracts as Program<SvmContracts>;
  const owner = Keypair.generate();
  let globalStatePDA: PublicKey;
  let supportedTokenMint: Keypair;

  // Helper function to airdrop SOL only if needed
  async function airdropIfNeeded(
    publicKey: PublicKey,
    amount: number = 2 * anchor.web3.LAMPORTS_PER_SOL
  ): Promise<void> {
    try {
      const balance = await provider.connection.getBalance(publicKey);
      if (balance >= amount) {
        return; // Already has enough SOL
      }

      // Request airdrop with retry logic
      let retries = 3;
      let delay = 1000;
      while (retries > 0) {
        try {
          const signature = await provider.connection.requestAirdrop(
            publicKey,
            amount
          );
          await provider.connection.confirmTransaction(signature);
          return;
        } catch (error: any) {
          if (
            error.message?.includes("429") ||
            error.message?.includes("Too Many Requests")
          ) {
            retries--;
            if (retries > 0) {
              console.log(`Rate limited, retrying after ${delay}ms...`);
              await new Promise((resolve) => setTimeout(resolve, delay));
              delay *= 2; // Exponential backoff
            } else {
              // If we've exhausted retries, check if we have enough balance anyway
              const currentBalance = await provider.connection.getBalance(
                publicKey
              );
              if (currentBalance >= amount * 0.5) {
                console.log(
                  `Using existing balance: ${
                    currentBalance / anchor.web3.LAMPORTS_PER_SOL
                  } SOL`
                );
                return;
              }
              throw new Error(
                `Failed to airdrop after retries: ${error.message}`
              );
            }
          } else {
            throw error;
          }
        }
      }
    } catch (error) {
      // If airdrop fails, check if we have enough balance anyway
      const balance = await provider.connection.getBalance(publicKey);
      if (balance >= amount * 0.5) {
        console.log(
          `Using existing balance: ${
            balance / anchor.web3.LAMPORTS_PER_SOL
          } SOL`
        );
        return;
      }
      throw error;
    }
  }

  before(async () => {
    // Get global state PDA
    [globalStatePDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_state")],
      program.programId
    );

    // Airdrop SOL to owner for transaction fees
    await airdropIfNeeded(owner.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
  });

  describe("initialize", () => {
    it("should initialize global state with supported token mints", async () => {
      // Create token mint for testing
      supportedTokenMint = Keypair.generate();
      await createMint(
        provider.connection,
        owner,
        owner.publicKey,
        null,
        9,
        supportedTokenMint
      );
      const supportedTokenMints = [supportedTokenMint.publicKey];

      // Check if global state already exists
      try {
        await program.account.globalState.fetch(globalStatePDA);
        console.log("Global state already exists, skipping initialization");
        return; // Skip this test if already initialized
      } catch (error) {
        // Global state doesn't exist, proceed with initialization
      }

      const tx = await program.methods
        .initialize(supportedTokenMints)
        .accounts({
          owner: owner.publicKey,
          globalState: globalStatePDA,
          system_program: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();

      // Fetch the global state account
      const state = await program.account.globalState.fetch(globalStatePDA);

      // Verify the state
      expect(state.owner.toString()).to.equal(owner.publicKey.toString());
      expect(state.paused).to.be.false;
      expect(state.supportedTokenMints.length).to.equal(1);
      expect(state.supportedTokenMints[0].toString()).to.equal(
        supportedTokenMints[0].toString()
      );
    });

    it("should fail when initializing with no supported token mints", async () => {
      try {
        await program.methods
          .initialize([])
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            system_program: SystemProgram.programId,
          })
          .signers([owner])
          .rpc();
        expect.fail("Expected the transaction to fail");
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it("should fail when initialized by non-signer owner", async () => {
      const nonSigner = Keypair.generate();
      const supportedTokenMints = [Keypair.generate().publicKey];

      try {
        await program.methods
          .initialize(supportedTokenMints)
          .accounts({
            owner: nonSigner.publicKey,
            globalState: globalStatePDA,
            system_program: SystemProgram.programId,
          })
          .signers([]) // Deliberately omitting the owner signer
          .rpc();
        expect.fail("Expected the transaction to fail");
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe("contract management", () => {
    before(async () => {
      // Ensure global state is initialized
      try {
        await program.account.globalState.fetch(globalStatePDA);
      } catch (error) {
        // Global state doesn't exist, initialize it
        if (!supportedTokenMint) {
          supportedTokenMint = Keypair.generate();
          await createMint(
            provider.connection,
            owner,
            owner.publicKey,
            null,
            9,
            supportedTokenMint
          );
        }
        const supportedTokenMints = [supportedTokenMint.publicKey];

        await program.methods
          .initialize(supportedTokenMints)
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            system_program: SystemProgram.programId,
          })
          .signers([owner])
          .rpc();
      }
    });

    it("should allow owner to add supported token", async () => {
      const newTokenMint = Keypair.generate();
      await createMint(
        provider.connection,
        owner,
        owner.publicKey,
        null,
        9,
        newTokenMint
      );

      await program.methods
        .addSupportedToken()
        .accounts({
          owner: owner.publicKey,
          globalState: globalStatePDA,
          tokenMint: newTokenMint.publicKey,
        })
        .signers([owner])
        .rpc();

      const state = await program.account.globalState.fetch(globalStatePDA);
      expect(state.supportedTokenMints.map((pk) => pk.toString())).to.include(
        newTokenMint.publicKey.toString()
      );
    });

    it("should allow owner to remove supported token", async () => {
      await program.methods
        .removeSupportedToken()
        .accounts({
          owner: owner.publicKey,
          globalState: globalStatePDA,
          tokenMint: supportedTokenMint.publicKey,
        })
        .signers([owner])
        .rpc();

      const state = await program.account.globalState.fetch(globalStatePDA);
      expect(
        state.supportedTokenMints.map((pk) => pk.toString())
      ).to.not.include(supportedTokenMint.publicKey.toString());
    });

    it("should not allow non-owner to add supported token", async () => {
      const nonOwner = Keypair.generate();
      const newTokenMint = Keypair.generate();
      await airdropIfNeeded(
        nonOwner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );

      try {
        await program.methods
          .addSupportedToken()
          .accounts({
            owner: nonOwner.publicKey,
            globalState: globalStatePDA,
            tokenMint: newTokenMint.publicKey,
          })
          .signers([nonOwner])
          .rpc();
        expect.fail("Expected the transaction to fail");
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it("should allow owner to pause contract", async () => {
      await program.methods
        .pause()
        .accounts({
          owner: owner.publicKey,
          globalState: globalStatePDA,
        })
        .signers([owner])
        .rpc();

      const state = await program.account.globalState.fetch(globalStatePDA);
      expect(state.paused).to.be.true;
    });

    it("should allow owner to unpause contract", async () => {
      await program.methods
        .unpause()
        .accounts({
          owner: owner.publicKey,
          globalState: globalStatePDA,
        })
        .signers([owner])
        .rpc();

      const state = await program.account.globalState.fetch(globalStatePDA);
      expect(state.paused).to.be.false;
    });

    it("should not allow non-owner to pause contract", async () => {
      const nonOwner = Keypair.generate();
      await airdropIfNeeded(
        nonOwner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );

      try {
        await program.methods
          .pause()
          .accounts({
            owner: nonOwner.publicKey,
            globalState: globalStatePDA,
          })
          .signers([nonOwner])
          .rpc();
        expect.fail("Expected the transaction to fail");
      } catch (error) {
        expect(error).to.exist;
      }
    });
  });

  describe("quest management", () => {
    let creatorTokenAccount: anchor.web3.PublicKey;

    before(async () => {
      // Ensure global state is initialized
      try {
        await program.account.globalState.fetch(globalStatePDA);
      } catch (error) {
        // Global state doesn't exist, initialize it
        if (!supportedTokenMint) {
          supportedTokenMint = Keypair.generate();
          await createMint(
            provider.connection,
            owner,
            owner.publicKey,
            null,
            9,
            supportedTokenMint
          );
        }
        const supportedTokenMints = [supportedTokenMint.publicKey];

        await program.methods
          .initialize(supportedTokenMints)
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            system_program: SystemProgram.programId,
          })
          .signers([owner])
          .rpc();
      }

      // Add supportedTokenMint to supported tokens (if not already added)
      try {
        await program.methods
          .addSupportedToken()
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            tokenMint: supportedTokenMint.publicKey,
          })
          .signers([owner])
          .rpc();
      } catch (error) {
        // Token might already be supported, continue
        console.log("Token might already be supported, continuing...");
      }

      // Create Associated Token Account for creator and mint some tokens
      creatorTokenAccount = await getAssociatedTokenAddress(
        supportedTokenMint.publicKey,
        owner.publicKey
      );

      // Create the ATA if it doesn't exist
      try {
        await getAccount(provider.connection, creatorTokenAccount);
      } catch (error) {
        // ATA doesn't exist, create it
        const createATAInstruction = createAssociatedTokenAccountInstruction(
          owner.publicKey, // payer
          creatorTokenAccount, // ata
          owner.publicKey, // owner
          supportedTokenMint.publicKey // mint
        );

        const transaction = new anchor.web3.Transaction().add(
          createATAInstruction
        );
        await provider.sendAndConfirm(transaction, [owner]);
      }

      await mintTo(
        provider.connection,
        owner,
        supportedTokenMint.publicKey,
        creatorTokenAccount,
        owner,
        1000000000 // Mint 1000 tokens (assuming 6 decimals)
      );
    });

    const questId = "quest-1";
    const questKeypair = Keypair.generate();
    const amount = new anchor.BN(1000000);
    const deadline = new anchor.BN(Date.now() / 1000 + 86400); // 24 hours from now
    const maxWinners = 10;

    it("should create a new quest and transfer tokens to escrow", async () => {
      // Get escrow PDA
      const [escrowPDA] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), questKeypair.publicKey.toBuffer()],
        program.programId
      );

      // Log creator's token balance before
      const creatorBalanceBefore = (
        await getAccount(provider.connection, creatorTokenAccount)
      ).amount;
      console.log("Creator balance before:", creatorBalanceBefore.toString());

      const tx = await program.methods
        .createQuest(questId, amount, deadline, maxWinners)
        .accounts({
          creator: owner.publicKey,
          globalState: globalStatePDA,
          tokenMint: supportedTokenMint.publicKey,
          escrowAccount: escrowPDA,
          creatorTokenAccount: creatorTokenAccount,
          quest: questKeypair.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([owner, questKeypair])
        .rpc();

      // Get and log balances after
      const escrowTokenAccount = await getAccount(
        provider.connection,
        escrowPDA
      );
      const creatorBalanceAfter = (
        await getAccount(provider.connection, creatorTokenAccount)
      ).amount;

      console.log("Creator balance after:", creatorBalanceAfter.toString());
      console.log("Escrow balance:", escrowTokenAccount.amount.toString());
      console.log("Transfer amount:", amount.toString());

      // Verify token transfer
      expect(escrowTokenAccount.amount.toString()).to.equal(amount.toString());
      expect(creatorBalanceAfter.toString()).to.equal(
        (creatorBalanceBefore - BigInt(amount.toString())).toString()
      );

      // Verify quest creation
      const quest = await program.account.quest.fetch(questKeypair.publicKey);
      expect(quest.id).to.equal(questId);
      expect(quest.creator.toString()).to.equal(owner.publicKey.toString());
      expect(quest.tokenMint.toString()).to.equal(
        supportedTokenMint.publicKey.toString()
      );
      expect(quest.escrowAccount.toString()).to.equal(escrowPDA.toString());
      expect(quest.amount.toString()).to.equal(amount.toString());
      expect(quest.deadline.toString()).to.equal(deadline.toString());
      expect(quest.isActive).to.be.true;
      expect(quest.totalWinners.toString()).to.equal("0");
      expect(quest.totalRewardDistributed.toString()).to.equal("0");
      expect(quest.maxWinners.toString()).to.equal(maxWinners.toString());
    });

    it("should get quest info", async () => {
      const questInfo = await program.methods
        .getQuestInfo()
        .accounts({
          quest: questKeypair.publicKey,
        })
        .view();

      expect(questInfo.id).to.equal(questId);
      expect(questInfo.creator.toString()).to.equal(owner.publicKey.toString());
      expect(questInfo.tokenMint.toString()).to.equal(
        supportedTokenMint.publicKey.toString()
      );
      expect(questInfo.amount.toString()).to.equal(amount.toString());
      expect(questInfo.deadline.toString()).to.equal(deadline.toString());
      expect(questInfo.isActive).to.be.true;
    });

    it("should get all quests", async () => {
      const allQuests = await program.methods
        .getAllQuests()
        .accounts({
          globalState: globalStatePDA,
        })
        .view();

      expect(allQuests).to.be.an("array");
      // Note: getAllQuests is deprecated and returns empty array
      // Quest accounts should be fetched directly client-side
      expect(allQuests).to.have.lengthOf(0);
    });

    it("should fail to create quest with unsupported token mint", async () => {
      const unsupportedMint = Keypair.generate();
      const newQuestKeypair = Keypair.generate();

      try {
        await program.methods
          .createQuest(questId, amount, deadline, maxWinners)
          .accounts({
            creator: owner.publicKey,
            globalState: globalStatePDA,
            tokenMint: unsupportedMint.publicKey,
            escrowAccount: escrowPDA,
            quest: newQuestKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner, newQuestKeypair])
          .rpc();
        expect.fail("Expected the transaction to fail");
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it("should allow creator to cancel quest and return tokens", async () => {
      // Get escrow PDA
      const [escrowPDA] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), questKeypair.publicKey.toBuffer()],
        program.programId
      );

      // Get balances before cancellation
      const creatorBalanceBefore = (
        await getAccount(provider.connection, creatorTokenAccount)
      ).amount;
      const escrowBalanceBefore = (
        await getAccount(provider.connection, escrowPDA)
      ).amount;

      console.log("Before cancellation:");
      console.log("Creator balance:", creatorBalanceBefore.toString());
      console.log("Escrow balance:", escrowBalanceBefore.toString());

      await program.methods
        .cancelQuest()
        .accounts({
          creator: owner.publicKey,
          globalState: globalStatePDA,
          quest: questKeypair.publicKey,
          escrowAccount: escrowPDA,
          creatorTokenAccount: creatorTokenAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([owner])
        .rpc();

      // Get balances after cancellation
      const quest = await program.account.quest.fetch(questKeypair.publicKey);
      const creatorBalanceAfter = (
        await getAccount(provider.connection, creatorTokenAccount)
      ).amount;
      const escrowBalanceAfter = (
        await getAccount(provider.connection, escrowPDA)
      ).amount;

      console.log("After cancellation:");
      console.log("Creator balance:", creatorBalanceAfter.toString());
      console.log("Escrow balance:", escrowBalanceAfter.toString());

      // Verify quest state and token transfer
      expect(quest.isActive).to.be.false;
      expect(escrowBalanceAfter.toString()).to.equal("0");
      expect(creatorBalanceAfter.toString()).to.equal(
        (creatorBalanceBefore + escrowBalanceBefore).toString()
      );
    });

    it("should not allow non-creator to cancel quest", async () => {
      const nonCreator = Keypair.generate();
      await airdropIfNeeded(
        nonCreator.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );

      try {
        await program.methods
          .cancelQuest()
          .accounts({
            creator: nonCreator.publicKey,
            quest: questKeypair.publicKey,
          })
          .signers([nonCreator])
          .rpc();
        expect.fail("Expected the transaction to fail");
      } catch (error) {
        expect(error).to.exist;
      }
    });

    it("should allow owner to update quest status", async () => {
      await program.methods
        .updateQuestStatus(true)
        .accounts({
          owner: owner.publicKey,
          globalState: globalStatePDA,
          quest: questKeypair.publicKey,
        })
        .signers([owner])
        .rpc();

      const quest = await program.account.quest.fetch(questKeypair.publicKey);
      expect(quest.isActive).to.be.true;
    });

    it("should not allow non-owner to update quest status", async () => {
      const nonOwner = Keypair.generate();
      await airdropIfNeeded(
        nonOwner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );

      try {
        await program.methods
          .updateQuestStatus(false)
          .accounts({
            owner: nonOwner.publicKey,
            globalState: globalStatePDA,
            quest: questKeypair.publicKey,
          })
          .signers([nonOwner])
          .rpc();
        expect.fail("Expected the transaction to fail");
      } catch (error) {
        expect(error).to.exist;
      }
    });

    describe("reward management", () => {
      let questKeypair: Keypair;
      let escrowPDA: PublicKey;
      let winner: Keypair;
      let winnerTokenAccount: PublicKey;
      let rewardAmount: anchor.BN;

      before(async () => {
        // Create a new quest
        questKeypair = Keypair.generate();
        [escrowPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), questKeypair.publicKey.toBuffer()],
          program.programId
        );

        // Setup winner account
        winner = Keypair.generate();
        await airdropIfNeeded(
          winner.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        );

        // Create winner's Associated Token Account
        winnerTokenAccount = await getAssociatedTokenAddress(
          supportedTokenMint.publicKey,
          winner.publicKey
        );

        // Create the ATA if it doesn't exist
        try {
          await getAccount(provider.connection, winnerTokenAccount);
        } catch (error) {
          // ATA doesn't exist, create it
          const createATAInstruction = createAssociatedTokenAccountInstruction(
            winner.publicKey, // payer
            winnerTokenAccount, // ata
            winner.publicKey, // owner
            supportedTokenMint.publicKey // mint
          );

          const transaction = new Transaction().add(createATAInstruction);
          await provider.sendAndConfirm(transaction, [winner]);
        }

        // Create quest with 1000 tokens
        rewardAmount = new anchor.BN(100000); // 0.1 token per reward
        const questAmount = new anchor.BN(1000000); // 1 token total
        const deadline = new anchor.BN(Date.now() / 1000 + 86400);
        const maxWinners = 10;

        await program.methods
          .createQuest("reward-test-quest", questAmount, deadline, maxWinners)
          .accounts({
            creator: owner.publicKey,
            globalState: globalStatePDA,
            tokenMint: supportedTokenMint.publicKey,
            escrowAccount: escrowPDA,
            creatorTokenAccount: creatorTokenAccount,
            quest: questKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([owner, questKeypair])
          .rpc();
      });

      it("should allow owner to send reward", async () => {
        const [rewardClaimedPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from("reward_claimed"),
            questKeypair.publicKey.toBuffer(),
            winner.publicKey.toBuffer(),
          ],
          program.programId
        );

        // Get balances before reward
        const winnerBalanceBefore = (
          await getAccount(provider.connection, winnerTokenAccount)
        ).amount;
        const escrowBalanceBefore = (
          await getAccount(provider.connection, escrowPDA)
        ).amount;

        await program.methods
          .sendReward(rewardAmount)
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            quest: questKeypair.publicKey,
            escrowAccount: escrowPDA,
            winner: winner.publicKey,
            winnerTokenAccount: winnerTokenAccount,
            rewardClaimed: rewardClaimedPDA,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([owner])
          .rpc();

        // Get balances after reward
        const winnerBalanceAfter = (
          await getAccount(provider.connection, winnerTokenAccount)
        ).amount;
        const escrowBalanceAfter = (
          await getAccount(provider.connection, escrowPDA)
        ).amount;
        const quest = await program.account.quest.fetch(questKeypair.publicKey);
        const rewardClaimed = await program.account.rewardClaimed.fetch(
          rewardClaimedPDA
        );

        // Verify token transfer
        expect(winnerBalanceAfter.toString()).to.equal(
          (winnerBalanceBefore + BigInt(rewardAmount.toString())).toString()
        );
        expect(escrowBalanceAfter.toString()).to.equal(
          (escrowBalanceBefore - BigInt(rewardAmount.toString())).toString()
        );

        // Verify quest state
        expect(quest.totalRewardDistributed.toString()).to.equal(
          rewardAmount.toString()
        );
        expect(quest.totalWinners.toString()).to.equal("1");

        // Verify reward claimed state
        expect(rewardClaimed.quest.toString()).to.equal(
          questKeypair.publicKey.toString()
        );
        expect(rewardClaimed.winner.toString()).to.equal(
          winner.publicKey.toString()
        );
        expect(rewardClaimed.rewardAmount.toString()).to.equal(
          rewardAmount.toString()
        );
        expect(rewardClaimed.claimed).to.be.true;
      });

      it("should not allow sending reward when contract is paused", async () => {
        // Pause the contract
        await program.methods
          .pause()
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
          })
          .signers([owner])
          .rpc();

        const newWinner = Keypair.generate();
        const [rewardClaimedPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from("reward_claimed"),
            questKeypair.publicKey.toBuffer(),
            newWinner.publicKey.toBuffer(),
          ],
          program.programId
        );

        try {
          await program.methods
            .sendReward(rewardAmount)
            .accounts({
              owner: owner.publicKey,
              globalState: globalStatePDA,
              quest: questKeypair.publicKey,
              escrowAccount: escrowPDA,
              winner: newWinner.publicKey,
              winnerTokenAccount: winnerTokenAccount,
              rewardClaimed: rewardClaimedPDA,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([owner])
            .rpc();
          expect.fail("Expected the transaction to fail");
        } catch (error) {
          expect(error).to.exist;
        }

        // Unpause for other tests
        await program.methods
          .unpause()
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
          })
          .signers([owner])
          .rpc();
      });

      it("should not allow non-owner to send reward", async () => {
        const nonOwner = Keypair.generate();
        await airdropIfNeeded(
          nonOwner.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        );

        const newWinner = Keypair.generate();
        const [rewardClaimedPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from("reward_claimed"),
            questKeypair.publicKey.toBuffer(),
            newWinner.publicKey.toBuffer(),
          ],
          program.programId
        );

        try {
          await program.methods
            .sendReward(rewardAmount)
            .accounts({
              owner: nonOwner.publicKey,
              globalState: globalStatePDA,
              quest: questKeypair.publicKey,
              escrowAccount: escrowPDA,
              winner: newWinner.publicKey,
              winnerTokenAccount: winnerTokenAccount,
              rewardClaimed: rewardClaimedPDA,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([nonOwner])
            .rpc();
          expect.fail("Expected the transaction to fail");
        } catch (error) {
          expect(error).to.exist;
        }
      });

      it("should not allow rewarding same winner twice", async () => {
        const [rewardClaimedPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from("reward_claimed"),
            questKeypair.publicKey.toBuffer(),
            winner.publicKey.toBuffer(),
          ],
          program.programId
        );

        try {
          await program.methods
            .sendReward(rewardAmount)
            .accounts({
              owner: owner.publicKey,
              globalState: globalStatePDA,
              quest: questKeypair.publicKey,
              escrowAccount: escrowPDA,
              winner: winner.publicKey,
              winnerTokenAccount: winnerTokenAccount,
              rewardClaimed: rewardClaimedPDA,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([owner])
            .rpc();
          expect.fail("Expected the transaction to fail");
        } catch (error) {
          expect(error).to.exist;
        }
      });

      it("should not allow reward when quest is inactive", async () => {
        // Deactivate quest
        await program.methods
          .updateQuestStatus(false)
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            quest: questKeypair.publicKey,
          })
          .signers([owner])
          .rpc();

        const newWinner = Keypair.generate();
        const [rewardClaimedPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from("reward_claimed"),
            questKeypair.publicKey.toBuffer(),
            newWinner.publicKey.toBuffer(),
          ],
          program.programId
        );

        try {
          await program.methods
            .sendReward(rewardAmount)
            .accounts({
              owner: owner.publicKey,
              globalState: globalStatePDA,
              quest: questKeypair.publicKey,
              escrowAccount: escrowPDA,
              winner: newWinner.publicKey,
              winnerTokenAccount: winnerTokenAccount,
              rewardClaimed: rewardClaimedPDA,
              tokenProgram: TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([owner])
            .rpc();
          expect.fail("Expected the transaction to fail");
        } catch (error) {
          expect(error).to.exist;
        }
      });
    });

    describe("claim remaining reward", () => {
      let claimQuestKeypair: Keypair;
      let claimEscrowPDA: PublicKey;
      let claimCreatorTokenAccount: PublicKey;
      let claimAmount: anchor.BN;
      let claimDeadline: anchor.BN;

      before(async () => {
        // Create a new quest for claiming tests
        claimQuestKeypair = Keypair.generate();
        [claimEscrowPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), claimQuestKeypair.publicKey.toBuffer()],
          program.programId
        );

        // Create Associated Token Account for creator
        claimCreatorTokenAccount = await getAssociatedTokenAddress(
          supportedTokenMint.publicKey,
          owner.publicKey
        );

        // Create the ATA if it doesn't exist
        try {
          await getAccount(provider.connection, claimCreatorTokenAccount);
        } catch (error) {
          // ATA doesn't exist, create it
          const createATAInstruction = createAssociatedTokenAccountInstruction(
            owner.publicKey, // payer
            claimCreatorTokenAccount, // ata
            owner.publicKey, // owner
            supportedTokenMint.publicKey // mint
          );

          const transaction = new Transaction().add(createATAInstruction);
          await provider.sendAndConfirm(transaction, [owner]);
        }

        // Mint tokens to creator account
        await mintTo(
          provider.connection,
          owner,
          supportedTokenMint.publicKey,
          claimCreatorTokenAccount,
          owner,
          2000000000 // Mint 2000 tokens
        );

        // Create quest with 1000 tokens
        claimAmount = new anchor.BN(1000000); // 1 token total
        claimDeadline = new anchor.BN(Date.now() / 1000 - 8 * 86400); // 8 days ago (expired + 1 week)

        await program.methods
          .createQuest("claim-test-quest", claimAmount, claimDeadline, 5)
          .accounts({
            creator: owner.publicKey,
            globalState: globalStatePDA,
            tokenMint: supportedTokenMint.publicKey,
            escrowAccount: claimEscrowPDA,
            creatorTokenAccount: claimCreatorTokenAccount,
            quest: claimQuestKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([owner, claimQuestKeypair])
          .rpc();

        // Deactivate the quest (simulate ended quest)
        await program.methods
          .updateQuestStatus(false)
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            quest: claimQuestKeypair.publicKey,
          })
          .signers([owner])
          .rpc();
      });

      it("should allow quest creator to claim remaining reward after deadline + 1 week", async () => {
        // Wait for 1 week to pass (simulate by setting deadline further in the past)
        const pastDeadline = new anchor.BN(Date.now() / 1000 - 8 * 86400); // 8 days ago

        // Update quest deadline to simulate 1 week has passed
        const quest = await program.account.quest.fetch(
          claimQuestKeypair.publicKey
        );
        // Note: In a real scenario, we'd need to modify the quest deadline, but for testing
        // we'll assume the quest was created with a deadline far enough in the past

        // Get balances before claiming
        const creatorBalanceBefore = (
          await getAccount(provider.connection, claimCreatorTokenAccount)
        ).amount;
        const escrowBalanceBefore = (
          await getAccount(provider.connection, claimEscrowPDA)
        ).amount;

        console.log("Before claiming remaining reward:");
        console.log("Creator balance:", creatorBalanceBefore.toString());
        console.log("Escrow balance:", escrowBalanceBefore.toString());

        // Claim remaining reward
        await program.methods
          .claimRemainingReward()
          .accounts({
            claimer: owner.publicKey,
            globalState: globalStatePDA,
            quest: claimQuestKeypair.publicKey,
            escrowAccount: claimEscrowPDA,
            creatorTokenAccount: claimCreatorTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();

        // Get balances after claiming
        const creatorBalanceAfter = (
          await getAccount(provider.connection, claimCreatorTokenAccount)
        ).amount;
        const escrowBalanceAfter = (
          await getAccount(provider.connection, claimEscrowPDA)
        ).amount;
        const updatedQuest = await program.account.quest.fetch(
          claimQuestKeypair.publicKey
        );

        console.log("After claiming remaining reward:");
        console.log("Creator balance:", creatorBalanceAfter.toString());
        console.log("Escrow balance:", escrowBalanceAfter.toString());

        // Verify token transfer
        expect(escrowBalanceAfter.toString()).to.equal("0");
        expect(creatorBalanceAfter.toString()).to.equal(
          (creatorBalanceBefore + escrowBalanceBefore).toString()
        );

        // Verify quest state updated to prevent double claiming
        expect(updatedQuest.amount.toString()).to.equal(
          updatedQuest.totalRewardDistributed.toString()
        );
      });

      it("should allow admin to claim remaining reward", async () => {
        // Create a new quest for admin test
        const adminQuestKeypair = Keypair.generate();
        const [adminEscrowPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), adminQuestKeypair.publicKey.toBuffer()],
          program.programId
        );

        const adminCreatorTokenAccount = await getAssociatedTokenAddress(
          supportedTokenMint.publicKey,
          owner.publicKey
        );

        // Create the ATA if it doesn't exist
        try {
          await getAccount(provider.connection, adminCreatorTokenAccount);
        } catch (error) {
          // ATA doesn't exist, create it
          const createATAInstruction = createAssociatedTokenAccountInstruction(
            owner.publicKey, // payer
            adminCreatorTokenAccount, // ata
            owner.publicKey, // owner
            supportedTokenMint.publicKey // mint
          );

          const transaction = new Transaction().add(createATAInstruction);
          await provider.sendAndConfirm(transaction, [owner]);
        }

        await mintTo(
          provider.connection,
          owner,
          supportedTokenMint.publicKey,
          adminCreatorTokenAccount,
          owner,
          1000000000
        );

        const adminAmount = new anchor.BN(500000);
        const adminDeadline = new anchor.BN(Date.now() / 1000 - 8 * 86400); // 8 days ago

        await program.methods
          .createQuest("admin-claim-test", adminAmount, adminDeadline, 3)
          .accounts({
            creator: owner.publicKey,
            globalState: globalStatePDA,
            tokenMint: supportedTokenMint.publicKey,
            escrowAccount: adminEscrowPDA,
            creatorTokenAccount: adminCreatorTokenAccount,
            quest: adminQuestKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([owner, adminQuestKeypair])
          .rpc();

        // Deactivate the quest
        await program.methods
          .updateQuestStatus(false)
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            quest: adminQuestKeypair.publicKey,
          })
          .signers([owner])
          .rpc();

        // Admin (owner) claims remaining reward
        await program.methods
          .claimRemainingReward()
          .accounts({
            claimer: owner.publicKey, // owner is admin
            globalState: globalStatePDA,
            quest: adminQuestKeypair.publicKey,
            escrowAccount: adminEscrowPDA,
            creatorTokenAccount: adminCreatorTokenAccount,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([owner])
          .rpc();

        // Verify escrow is empty
        const escrowBalance = (
          await getAccount(provider.connection, adminEscrowPDA)
        ).amount;
        expect(escrowBalance.toString()).to.equal("0");
      });

      it("should not allow non-creator and non-admin to claim remaining reward", async () => {
        const nonCreator = Keypair.generate();
        await airdropIfNeeded(
          nonCreator.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        );

        try {
          await program.methods
            .claimRemainingReward()
            .accounts({
              claimer: nonCreator.publicKey,
              globalState: globalStatePDA,
              quest: claimQuestKeypair.publicKey,
              escrowAccount: claimEscrowPDA,
              creatorTokenAccount: claimCreatorTokenAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([nonCreator])
            .rpc();
          expect.fail("Expected the transaction to fail");
        } catch (error) {
          expect(error).to.exist;
        }
      });

      it("should not allow claiming when quest is still active", async () => {
        // Create an active quest
        const activeQuestKeypair = Keypair.generate();
        const [activeEscrowPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), activeQuestKeypair.publicKey.toBuffer()],
          program.programId
        );

        const activeCreatorTokenAccount = await getAssociatedTokenAddress(
          supportedTokenMint.publicKey,
          owner.publicKey
        );

        // Create the ATA if it doesn't exist
        try {
          await getAccount(provider.connection, activeCreatorTokenAccount);
        } catch (error) {
          // ATA doesn't exist, create it
          const createATAInstruction = createAssociatedTokenAccountInstruction(
            owner.publicKey, // payer
            activeCreatorTokenAccount, // ata
            owner.publicKey, // owner
            supportedTokenMint.publicKey // mint
          );

          const transaction = new Transaction().add(createATAInstruction);
          await provider.sendAndConfirm(transaction, [owner]);
        }

        await mintTo(
          provider.connection,
          owner,
          supportedTokenMint.publicKey,
          activeCreatorTokenAccount,
          owner,
          1000000000
        );

        const activeAmount = new anchor.BN(500000);
        const activeDeadline = new anchor.BN(Date.now() / 1000 - 8 * 86400);

        await program.methods
          .createQuest("active-quest-test", activeAmount, activeDeadline, 3)
          .accounts({
            creator: owner.publicKey,
            globalState: globalStatePDA,
            tokenMint: supportedTokenMint.publicKey,
            escrowAccount: activeEscrowPDA,
            creatorTokenAccount: activeCreatorTokenAccount,
            quest: activeQuestKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([owner, activeQuestKeypair])
          .rpc();

        // Quest remains active, try to claim
        try {
          await program.methods
            .claimRemainingReward()
            .accounts({
              claimer: owner.publicKey,
              globalState: globalStatePDA,
              quest: activeQuestKeypair.publicKey,
              escrowAccount: activeEscrowPDA,
              creatorTokenAccount: activeCreatorTokenAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([owner])
            .rpc();
          expect.fail("Expected the transaction to fail");
        } catch (error) {
          expect(error).to.exist;
        }
      });

      it("should not allow claiming when no remaining tokens", async () => {
        // Create a quest where all tokens have been distributed
        const emptyQuestKeypair = Keypair.generate();
        const [emptyEscrowPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), emptyQuestKeypair.publicKey.toBuffer()],
          program.programId
        );

        const emptyCreatorTokenAccount = await getAssociatedTokenAddress(
          supportedTokenMint.publicKey,
          owner.publicKey
        );

        // Create the ATA if it doesn't exist
        try {
          await getAccount(provider.connection, emptyCreatorTokenAccount);
        } catch (error) {
          // ATA doesn't exist, create it
          const createATAInstruction = createAssociatedTokenAccountInstruction(
            owner.publicKey, // payer
            emptyCreatorTokenAccount, // ata
            owner.publicKey, // owner
            supportedTokenMint.publicKey // mint
          );

          const transaction = new Transaction().add(createATAInstruction);
          await provider.sendAndConfirm(transaction, [owner]);
        }

        await mintTo(
          provider.connection,
          owner,
          supportedTokenMint.publicKey,
          emptyCreatorTokenAccount,
          owner,
          1000000000
        );

        const emptyAmount = new anchor.BN(100000); // Small amount
        const emptyDeadline = new anchor.BN(Date.now() / 1000 - 8 * 86400);

        await program.methods
          .createQuest("empty-quest-test", emptyAmount, emptyDeadline, 1)
          .accounts({
            creator: owner.publicKey,
            globalState: globalStatePDA,
            tokenMint: supportedTokenMint.publicKey,
            escrowAccount: emptyEscrowPDA,
            creatorTokenAccount: emptyCreatorTokenAccount,
            quest: emptyQuestKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([owner, emptyQuestKeypair])
          .rpc();

        // Distribute all tokens as rewards
        const winner = Keypair.generate();

        // Airdrop SOL to winner for transaction fees
        await airdropIfNeeded(
          winner.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        );

        const winnerTokenAccount = await getAssociatedTokenAddress(
          supportedTokenMint.publicKey,
          winner.publicKey
        );

        // Create the ATA if it doesn't exist
        try {
          await getAccount(provider.connection, winnerTokenAccount);
        } catch (error) {
          // ATA doesn't exist, create it
          const createATAInstruction = createAssociatedTokenAccountInstruction(
            winner.publicKey, // payer
            winnerTokenAccount, // ata
            winner.publicKey, // owner
            supportedTokenMint.publicKey // mint
          );

          const transaction = new Transaction().add(createATAInstruction);
          await provider.sendAndConfirm(transaction, [winner]);
        }

        const [rewardClaimedPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from("reward_claimed"),
            emptyQuestKeypair.publicKey.toBuffer(),
            winner.publicKey.toBuffer(),
          ],
          program.programId
        );

        await program.methods
          .sendReward(emptyAmount)
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            quest: emptyQuestKeypair.publicKey,
            escrowAccount: emptyEscrowPDA,
            winner: winner.publicKey,
            winnerTokenAccount: winnerTokenAccount,
            rewardClaimed: rewardClaimedPDA,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([owner])
          .rpc();

        // Deactivate quest
        await program.methods
          .updateQuestStatus(false)
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            quest: emptyQuestKeypair.publicKey,
          })
          .signers([owner])
          .rpc();

        // Try to claim remaining reward (should fail as no tokens left)
        try {
          await program.methods
            .claimRemainingReward()
            .accounts({
              claimer: owner.publicKey,
              globalState: globalStatePDA,
              quest: emptyQuestKeypair.publicKey,
              escrowAccount: emptyEscrowPDA,
              creatorTokenAccount: emptyCreatorTokenAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([owner])
            .rpc();
          expect.fail("Expected the transaction to fail");
        } catch (error) {
          expect(error).to.exist;
        }
      });

      it("should not allow claiming when contract is paused", async () => {
        // Pause the contract
        await program.methods
          .pause()
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
          })
          .signers([owner])
          .rpc();

        try {
          await program.methods
            .claimRemainingReward()
            .accounts({
              claimer: owner.publicKey,
              globalState: globalStatePDA,
              quest: claimQuestKeypair.publicKey,
              escrowAccount: claimEscrowPDA,
              creatorTokenAccount: claimCreatorTokenAccount,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([owner])
            .rpc();
          expect.fail("Expected the transaction to fail");
        } catch (error) {
          expect(error).to.exist;
        }

        // Unpause for other tests
        await program.methods
          .unpause()
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
          })
          .signers([owner])
          .rpc();
      });
    });

    describe("close reward claimed", () => {
      let closeQuestKeypair: Keypair;
      let closeEscrowPDA: PublicKey;
      let closeCreatorTokenAccount: PublicKey;
      let closeWinner: Keypair;
      let closeWinnerTokenAccount: PublicKey;
      let closeRewardClaimedPDA: PublicKey;
      let closeRewardAmount: anchor.BN;

      before(async () => {
        // Create a new quest for closing tests
        closeQuestKeypair = Keypair.generate();
        [closeEscrowPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), closeQuestKeypair.publicKey.toBuffer()],
          program.programId
        );

        // Create Associated Token Account for creator
        closeCreatorTokenAccount = await getAssociatedTokenAddress(
          supportedTokenMint.publicKey,
          owner.publicKey
        );

        // Create the ATA if it doesn't exist
        try {
          await getAccount(provider.connection, closeCreatorTokenAccount);
        } catch (error) {
          const createATAInstruction = createAssociatedTokenAccountInstruction(
            owner.publicKey,
            closeCreatorTokenAccount,
            owner.publicKey,
            supportedTokenMint.publicKey
          );
          const transaction = new Transaction().add(createATAInstruction);
          await provider.sendAndConfirm(transaction, [owner]);
        }

        // Mint tokens to creator account
        await mintTo(
          provider.connection,
          owner,
          supportedTokenMint.publicKey,
          closeCreatorTokenAccount,
          owner,
          2000000000
        );

        // Create quest
        closeRewardAmount = new anchor.BN(500000);
        const closeDeadline = new anchor.BN(Date.now() / 1000 + 86400); // 1 day from now

        await program.methods
          .createQuest("close-test-quest", closeRewardAmount, closeDeadline, 5)
          .accounts({
            creator: owner.publicKey,
            globalState: globalStatePDA,
            tokenMint: supportedTokenMint.publicKey,
            escrowAccount: closeEscrowPDA,
            creatorTokenAccount: closeCreatorTokenAccount,
            quest: closeQuestKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([owner, closeQuestKeypair])
          .rpc();

        // Create winner and send reward
        closeWinner = Keypair.generate();
        await airdropIfNeeded(
          closeWinner.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        );

        closeWinnerTokenAccount = await getAssociatedTokenAddress(
          supportedTokenMint.publicKey,
          closeWinner.publicKey
        );

        // Create winner ATA if it doesn't exist
        try {
          await getAccount(provider.connection, closeWinnerTokenAccount);
        } catch (error) {
          const createATAInstruction = createAssociatedTokenAccountInstruction(
            closeWinner.publicKey,
            closeWinnerTokenAccount,
            closeWinner.publicKey,
            supportedTokenMint.publicKey
          );
          const transaction = new Transaction().add(createATAInstruction);
          await provider.sendAndConfirm(transaction, [closeWinner]);
        }

        [closeRewardClaimedPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from("reward_claimed"),
            closeQuestKeypair.publicKey.toBuffer(),
            closeWinner.publicKey.toBuffer(),
          ],
          program.programId
        );

        // Send reward to create the RewardClaimed PDA
        await program.methods
          .sendReward(closeRewardAmount)
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            quest: closeQuestKeypair.publicKey,
            escrowAccount: closeEscrowPDA,
            winner: closeWinner.publicKey,
            winnerTokenAccount: closeWinnerTokenAccount,
            rewardClaimed: closeRewardClaimedPDA,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([owner])
          .rpc();
      });

      it("should allow owner to close RewardClaimed PDA and reclaim SOL", async () => {
        // Create a new quest and reward for this specific test
        const ownerCloseQuestKeypair = Keypair.generate();
        const [ownerCloseEscrowPDA] =
          anchor.web3.PublicKey.findProgramAddressSync(
            [
              Buffer.from("escrow"),
              ownerCloseQuestKeypair.publicKey.toBuffer(),
            ],
            program.programId
          );

        await mintTo(
          provider.connection,
          owner,
          supportedTokenMint.publicKey,
          closeCreatorTokenAccount,
          owner,
          1000000000
        );

        const ownerCloseDeadline = new anchor.BN(Date.now() / 1000 + 86400);
        await program.methods
          .createQuest(
            "owner-close-test",
            closeRewardAmount,
            ownerCloseDeadline,
            5
          )
          .accounts({
            creator: owner.publicKey,
            globalState: globalStatePDA,
            tokenMint: supportedTokenMint.publicKey,
            escrowAccount: ownerCloseEscrowPDA,
            creatorTokenAccount: closeCreatorTokenAccount,
            quest: ownerCloseQuestKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([owner, ownerCloseQuestKeypair])
          .rpc();

        const ownerCloseWinner = Keypair.generate();
        await airdropIfNeeded(
          ownerCloseWinner.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        );

        const ownerCloseWinnerTokenAccount = await getAssociatedTokenAddress(
          supportedTokenMint.publicKey,
          ownerCloseWinner.publicKey
        );

        try {
          await getAccount(provider.connection, ownerCloseWinnerTokenAccount);
        } catch (error) {
          const createATAInstruction = createAssociatedTokenAccountInstruction(
            ownerCloseWinner.publicKey,
            ownerCloseWinnerTokenAccount,
            ownerCloseWinner.publicKey,
            supportedTokenMint.publicKey
          );
          const transaction = new Transaction().add(createATAInstruction);
          await provider.sendAndConfirm(transaction, [ownerCloseWinner]);
        }

        const [ownerCloseRewardClaimedPDA] =
          anchor.web3.PublicKey.findProgramAddressSync(
            [
              Buffer.from("reward_claimed"),
              ownerCloseQuestKeypair.publicKey.toBuffer(),
              ownerCloseWinner.publicKey.toBuffer(),
            ],
            program.programId
          );

        // Send reward
        await program.methods
          .sendReward(closeRewardAmount)
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            quest: ownerCloseQuestKeypair.publicKey,
            escrowAccount: ownerCloseEscrowPDA,
            winner: ownerCloseWinner.publicKey,
            winnerTokenAccount: ownerCloseWinnerTokenAccount,
            rewardClaimed: ownerCloseRewardClaimedPDA,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([owner])
          .rpc();

        // Get admin (owner) balance before closing
        const adminBalanceBefore = await provider.connection.getBalance(
          owner.publicKey
        );

        // Verify the RewardClaimed PDA exists
        const rewardClaimedBefore = await program.account.rewardClaimed.fetch(
          ownerCloseRewardClaimedPDA
        );
        expect(rewardClaimedBefore.claimed).to.be.true;

        // Get account balance before closing
        const accountInfoBefore = await provider.connection.getAccountInfo(
          ownerCloseRewardClaimedPDA
        );
        const rentAmount = accountInfoBefore?.lamports || 0;

        console.log("Before closing RewardClaimed PDA (admin):");
        console.log("Admin balance:", adminBalanceBefore.toString());
        console.log("RewardClaimed PDA balance:", rentAmount.toString());

        // Close the PDA as admin (owner) and reclaim SOL to admin's account
        await program.methods
          .closeRewardClaimed()
          .accounts({
            closer: owner.publicKey,
            globalState: globalStatePDA,
            rewardClaimed: ownerCloseRewardClaimedPDA,
            quest: ownerCloseQuestKeypair.publicKey,
            winner: ownerCloseWinner.publicKey,
            recipient: owner.publicKey, // Admin reclaims SOL to their own account
          })
          .signers([owner])
          .rpc();

        // Verify the account is closed
        const accountInfoAfter = await provider.connection.getAccountInfo(
          ownerCloseRewardClaimedPDA
        );
        expect(accountInfoAfter).to.be.null;

        // Verify SOL was returned to admin
        const adminBalanceAfter = await provider.connection.getBalance(
          owner.publicKey
        );

        console.log("After closing RewardClaimed PDA (admin):");
        console.log("Admin balance:", adminBalanceAfter.toString());
        console.log(
          "SOL reclaimed:",
          (adminBalanceAfter - adminBalanceBefore).toString()
        );

        expect(adminBalanceAfter).to.be.greaterThan(adminBalanceBefore);
        expect(adminBalanceAfter - adminBalanceBefore).to.be.greaterThan(0);
      });

      it("should allow winner to close their own RewardClaimed PDA", async () => {
        // Create another quest and reward for this test
        const testQuestKeypair = Keypair.generate();
        const [testEscrowPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), testQuestKeypair.publicKey.toBuffer()],
          program.programId
        );

        // Mint tokens
        await mintTo(
          provider.connection,
          owner,
          supportedTokenMint.publicKey,
          closeCreatorTokenAccount,
          owner,
          1000000000
        );

        const testDeadline = new anchor.BN(Date.now() / 1000 + 86400);
        await program.methods
          .createQuest("close-winner-test", closeRewardAmount, testDeadline, 5)
          .accounts({
            creator: owner.publicKey,
            globalState: globalStatePDA,
            tokenMint: supportedTokenMint.publicKey,
            escrowAccount: testEscrowPDA,
            creatorTokenAccount: closeCreatorTokenAccount,
            quest: testQuestKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([owner, testQuestKeypair])
          .rpc();

        // Create another winner
        const testWinner = Keypair.generate();
        await airdropIfNeeded(
          testWinner.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        );

        const testWinnerTokenAccount = await getAssociatedTokenAddress(
          supportedTokenMint.publicKey,
          testWinner.publicKey
        );

        try {
          await getAccount(provider.connection, testWinnerTokenAccount);
        } catch (error) {
          const createATAInstruction = createAssociatedTokenAccountInstruction(
            testWinner.publicKey,
            testWinnerTokenAccount,
            testWinner.publicKey,
            supportedTokenMint.publicKey
          );
          const transaction = new Transaction().add(createATAInstruction);
          await provider.sendAndConfirm(transaction, [testWinner]);
        }

        const [testRewardClaimedPDA] =
          anchor.web3.PublicKey.findProgramAddressSync(
            [
              Buffer.from("reward_claimed"),
              testQuestKeypair.publicKey.toBuffer(),
              testWinner.publicKey.toBuffer(),
            ],
            program.programId
          );

        // Send reward
        await program.methods
          .sendReward(closeRewardAmount)
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            quest: testQuestKeypair.publicKey,
            escrowAccount: testEscrowPDA,
            winner: testWinner.publicKey,
            winnerTokenAccount: testWinnerTokenAccount,
            rewardClaimed: testRewardClaimedPDA,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([owner])
          .rpc();

        // Get winner balance before closing
        const winnerBalanceBefore = await provider.connection.getBalance(
          testWinner.publicKey
        );

        // Get account balance before closing
        const accountInfoBefore = await provider.connection.getAccountInfo(
          testRewardClaimedPDA
        );
        const rentAmount = accountInfoBefore?.lamports || 0;

        console.log("Before closing RewardClaimed PDA (winner):");
        console.log("Winner balance:", winnerBalanceBefore.toString());
        console.log("RewardClaimed PDA balance:", rentAmount.toString());

        // Close as winner
        await program.methods
          .closeRewardClaimed()
          .accounts({
            closer: testWinner.publicKey,
            globalState: globalStatePDA,
            rewardClaimed: testRewardClaimedPDA,
            quest: testQuestKeypair.publicKey,
            winner: testWinner.publicKey,
            recipient: testWinner.publicKey, // Winner receives the SOL
          })
          .signers([testWinner])
          .rpc();

        // Verify account is closed
        const accountInfoAfter = await provider.connection.getAccountInfo(
          testRewardClaimedPDA
        );
        expect(accountInfoAfter).to.be.null;

        // Verify winner received SOL
        const winnerBalanceAfter = await provider.connection.getBalance(
          testWinner.publicKey
        );

        console.log("After closing RewardClaimed PDA (winner):");
        console.log("Winner balance:", winnerBalanceAfter.toString());
        console.log(
          "SOL reclaimed:",
          (winnerBalanceAfter - winnerBalanceBefore).toString()
        );

        expect(winnerBalanceAfter).to.be.greaterThan(winnerBalanceBefore);
      });

      it("should not allow unauthorized user to close RewardClaimed PDA", async () => {
        // Create another quest and reward
        const unauthorizedQuestKeypair = Keypair.generate();
        const [unauthorizedEscrowPDA] =
          anchor.web3.PublicKey.findProgramAddressSync(
            [
              Buffer.from("escrow"),
              unauthorizedQuestKeypair.publicKey.toBuffer(),
            ],
            program.programId
          );

        await mintTo(
          provider.connection,
          owner,
          supportedTokenMint.publicKey,
          closeCreatorTokenAccount,
          owner,
          1000000000
        );

        const unauthorizedDeadline = new anchor.BN(Date.now() / 1000 + 86400);
        await program.methods
          .createQuest(
            "unauthorized-close-test",
            closeRewardAmount,
            unauthorizedDeadline,
            5
          )
          .accounts({
            creator: owner.publicKey,
            globalState: globalStatePDA,
            tokenMint: supportedTokenMint.publicKey,
            escrowAccount: unauthorizedEscrowPDA,
            creatorTokenAccount: closeCreatorTokenAccount,
            quest: unauthorizedQuestKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([owner, unauthorizedQuestKeypair])
          .rpc();

        const unauthorizedWinner = Keypair.generate();
        const unauthorizedWinner2 = Keypair.generate();
        await airdropIfNeeded(
          unauthorizedWinner.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        );

        const unauthorizedWinnerTokenAccount = await getAssociatedTokenAddress(
          supportedTokenMint.publicKey,
          unauthorizedWinner.publicKey
        );

        try {
          await getAccount(provider.connection, unauthorizedWinnerTokenAccount);
        } catch (error) {
          const createATAInstruction = createAssociatedTokenAccountInstruction(
            unauthorizedWinner.publicKey,
            unauthorizedWinnerTokenAccount,
            unauthorizedWinner.publicKey,
            supportedTokenMint.publicKey
          );
          const transaction = new Transaction().add(createATAInstruction);
          await provider.sendAndConfirm(transaction, [unauthorizedWinner]);
        }

        const [unauthorizedRewardClaimedPDA] =
          anchor.web3.PublicKey.findProgramAddressSync(
            [
              Buffer.from("reward_claimed"),
              unauthorizedQuestKeypair.publicKey.toBuffer(),
              unauthorizedWinner.publicKey.toBuffer(),
            ],
            program.programId
          );

        // Send reward
        await program.methods
          .sendReward(closeRewardAmount)
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            quest: unauthorizedQuestKeypair.publicKey,
            escrowAccount: unauthorizedEscrowPDA,
            winner: unauthorizedWinner.publicKey,
            winnerTokenAccount: unauthorizedWinnerTokenAccount,
            rewardClaimed: unauthorizedRewardClaimedPDA,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([owner])
          .rpc();

        // Get balances before unauthorized close attempt
        const unauthorizedBalanceBefore = await provider.connection.getBalance(
          unauthorizedWinner2.publicKey
        );
        const accountInfoBefore = await provider.connection.getAccountInfo(
          unauthorizedRewardClaimedPDA
        );
        const rentAmount = accountInfoBefore?.lamports || 0;

        console.log("Before unauthorized close attempt:");
        console.log(
          "Unauthorized user balance:",
          unauthorizedBalanceBefore.toString()
        );
        console.log("RewardClaimed PDA balance:", rentAmount.toString());

        // Try to close as unauthorized user (different winner)
        try {
          await program.methods
            .closeRewardClaimed()
            .accounts({
              closer: unauthorizedWinner2.publicKey,
              globalState: globalStatePDA,
              rewardClaimed: unauthorizedRewardClaimedPDA,
              quest: unauthorizedQuestKeypair.publicKey,
              winner: unauthorizedWinner.publicKey,
              recipient: unauthorizedWinner2.publicKey,
            })
            .signers([unauthorizedWinner2])
            .rpc();
          expect.fail("Expected the transaction to fail");
        } catch (error: any) {
          expect(error).to.exist;
          // Verify the account still exists
          const accountInfo = await provider.connection.getAccountInfo(
            unauthorizedRewardClaimedPDA
          );
          expect(accountInfo).to.not.be.null;

          const unauthorizedBalanceAfter = await provider.connection.getBalance(
            unauthorizedWinner2.publicKey
          );

          console.log("After unauthorized close attempt (failed):");
          console.log(
            "Unauthorized user balance:",
            unauthorizedBalanceAfter.toString()
          );
          console.log(
            "RewardClaimed PDA still exists with balance:",
            accountInfo?.lamports?.toString() || "0"
          );
        }
      });

      it("should allow querying RewardClaimed info", async () => {
        // Create a quest and reward for query test
        const queryQuestKeypair = Keypair.generate();
        const [queryEscrowPDA] = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("escrow"), queryQuestKeypair.publicKey.toBuffer()],
          program.programId
        );

        await mintTo(
          provider.connection,
          owner,
          supportedTokenMint.publicKey,
          closeCreatorTokenAccount,
          owner,
          1000000000
        );

        const queryDeadline = new anchor.BN(Date.now() / 1000 + 86400);
        await program.methods
          .createQuest("query-test", closeRewardAmount, queryDeadline, 5)
          .accounts({
            creator: owner.publicKey,
            globalState: globalStatePDA,
            tokenMint: supportedTokenMint.publicKey,
            escrowAccount: queryEscrowPDA,
            creatorTokenAccount: closeCreatorTokenAccount,
            quest: queryQuestKeypair.publicKey,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([owner, queryQuestKeypair])
          .rpc();

        const queryWinner = Keypair.generate();
        await airdropIfNeeded(
          queryWinner.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        );

        const queryWinnerTokenAccount = await getAssociatedTokenAddress(
          supportedTokenMint.publicKey,
          queryWinner.publicKey
        );

        try {
          await getAccount(provider.connection, queryWinnerTokenAccount);
        } catch (error) {
          const createATAInstruction = createAssociatedTokenAccountInstruction(
            queryWinner.publicKey,
            queryWinnerTokenAccount,
            queryWinner.publicKey,
            supportedTokenMint.publicKey
          );
          const transaction = new Transaction().add(createATAInstruction);
          await provider.sendAndConfirm(transaction, [queryWinner]);
        }

        const [queryRewardClaimedPDA] =
          anchor.web3.PublicKey.findProgramAddressSync(
            [
              Buffer.from("reward_claimed"),
              queryQuestKeypair.publicKey.toBuffer(),
              queryWinner.publicKey.toBuffer(),
            ],
            program.programId
          );

        // Send reward
        await program.methods
          .sendReward(closeRewardAmount)
          .accounts({
            owner: owner.publicKey,
            globalState: globalStatePDA,
            quest: queryQuestKeypair.publicKey,
            escrowAccount: queryEscrowPDA,
            winner: queryWinner.publicKey,
            winnerTokenAccount: queryWinnerTokenAccount,
            rewardClaimed: queryRewardClaimedPDA,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([owner])
          .rpc();

        // Query the RewardClaimed info
        const rewardClaimedInfo = await program.methods
          .getRewardClaimedInfo()
          .accounts({
            rewardClaimed: queryRewardClaimedPDA,
            quest: queryQuestKeypair.publicKey,
            winner: queryWinner.publicKey,
          })
          .view();

        expect(rewardClaimedInfo).to.exist;
        expect(rewardClaimedInfo.quest.toString()).to.equal(
          queryQuestKeypair.publicKey.toString()
        );
        expect(rewardClaimedInfo.winner.toString()).to.equal(
          queryWinner.publicKey.toString()
        );
        expect(rewardClaimedInfo.rewardAmount.toString()).to.equal(
          closeRewardAmount.toString()
        );
        expect(rewardClaimedInfo.claimed).to.be.true;
      });
    });
  });
});
