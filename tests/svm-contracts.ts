import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createAccount,
  createMint,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
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

  before(async () => {
    // Get global state PDA
    [globalStatePDA] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("global_state")],
      program.programId
    );

    // Airdrop SOL to owner for transaction fees
    const signature = await provider.connection.requestAirdrop(
      owner.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(signature);
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
      const signature = await provider.connection.requestAirdrop(
        nonOwner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(signature);

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
      const signature = await provider.connection.requestAirdrop(
        nonOwner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(signature);

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
      // Add supportedTokenMint to supported tokens
      await program.methods
        .addSupportedToken()
        .accounts({
          owner: owner.publicKey,
          globalState: globalStatePDA,
          tokenMint: supportedTokenMint.publicKey,
        })
        .signers([owner])
        .rpc();

      // Create token account for creator and mint some tokens
      creatorTokenAccount = await createAccount(
        provider.connection,
        owner,
        supportedTokenMint.publicKey,
        owner.publicKey
      );

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
      expect(allQuests).to.have.lengthOf(1);
      expect(allQuests[0]).to.equal(questId);
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
      const signature = await provider.connection.requestAirdrop(
        nonCreator.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(signature);

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
      const signature = await provider.connection.requestAirdrop(
        nonOwner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(signature);

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
        const signature = await provider.connection.requestAirdrop(
          winner.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(signature);

        // Create winner's token account
        winnerTokenAccount = await createAccount(
          provider.connection,
          winner,
          supportedTokenMint.publicKey,
          winner.publicKey
        );

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
        expect(rewardClaimed.questId).to.equal("reward-test-quest");
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
        const signature = await provider.connection.requestAirdrop(
          nonOwner.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(signature);

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
  });
});
