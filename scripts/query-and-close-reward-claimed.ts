import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { SvmContracts } from "../target/types/svm_contracts";

/**
 * Query all RewardClaimed PDAs for a given program using Anchor's account fetching
 * This is the recommended approach as it handles discriminators automatically
 * @param program - Anchor program instance
 * @returns Array of RewardClaimed account data with their addresses
 */
export async function queryAllRewardClaimedPDAs(
  program: Program<SvmContracts>
): Promise<Array<{ address: PublicKey; data: any }>> {
  try {
    // Use Anchor's account fetching which handles discriminators automatically
    const accounts = await program.account.rewardClaimed.all();
    
    return accounts.map((account) => ({
      address: account.publicKey,
      data: account.account,
    }));
  } catch (error) {
    console.error("Error fetching RewardClaimed accounts:", error);
    return [];
  }
}

/**
 * Query RewardClaimed PDAs using getProgramAccounts (lower-level approach)
 * This is useful if you don't have a full program instance
 * @param connection - Solana connection
 * @param programId - Program ID
 * @param program - Optional program instance for decoding
 * @returns Array of RewardClaimed account data with their addresses
 */
export async function queryRewardClaimedByAccountName(
  connection: Connection,
  programId: PublicKey,
  program?: Program<SvmContracts>
): Promise<Array<{ address: PublicKey; data: any }>> {
  // Use getProgramAccounts with filters
  // The account data size for RewardClaimed is: 8 (discriminator) + 32 (quest) + 32 (winner) + 8 (reward_amount) + 1 (claimed) = 81 bytes
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      {
        dataSize: 81, // REWARD_CLAIMED_SPACE = 8 + 32 + 32 + 8 + 1
      },
    ],
  });

  if (!program) {
    // If no program instance provided, return addresses only
    return accounts.map((account) => ({
      address: account.pubkey,
      data: null,
    }));
  }

  const rewardClaimedAccounts: Array<{ address: PublicKey; data: any }> = [];

  for (const account of accounts) {
    try {
      // Try to decode as RewardClaimed
      const data = program.coder.accounts.decode(
        "RewardClaimed",
        account.account.data
      );
      
      // Verify it's actually a RewardClaimed account by checking if it has the expected fields
      if (data.quest && data.winner && typeof data.claimed === "boolean") {
        rewardClaimedAccounts.push({
          address: account.pubkey,
          data,
        });
      }
    } catch (e) {
      // Not a RewardClaimed account, skip
      continue;
    }
  }

  return rewardClaimedAccounts;
}

/**
 * Close a specific RewardClaimed PDA
 * @param program - Anchor program instance
 * @param quest - Quest public key
 * @param winner - Winner public key
 * @param closer - Keypair of the account closing (must be owner or winner)
 * @param recipient - PublicKey to receive the closed account's rent
 */
export async function closeRewardClaimed(
  program: Program<SvmContracts>,
  quest: PublicKey,
  winner: PublicKey,
  closer: Keypair,
  recipient: PublicKey
): Promise<string> {
  const [rewardClaimedPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("reward_claimed"),
      quest.toBuffer(),
      winner.toBuffer(),
    ],
    program.programId
  );

  // Get global state PDA
  const [globalStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_state")],
    program.programId
  );

  const tx = await program.methods
    .closeRewardClaimed()
    .accounts({
      closer: closer.publicKey,
      globalState: globalStatePDA,
      rewardClaimed: rewardClaimedPDA,
      quest: quest,
      winner: winner,
      recipient: recipient,
    })
    .signers([closer])
    .rpc();

  return tx;
}

/**
 * Close all RewardClaimed PDAs that can be closed by the owner
 * @param program - Anchor program instance
 * @param owner - Owner keypair
 * @param recipient - PublicKey to receive the closed accounts' rent
 */
export async function closeAllRewardClaimedPDAs(
  program: Program<SvmContracts>,
  owner: Keypair,
  recipient: PublicKey
): Promise<Array<{ address: PublicKey; tx: string; error?: string }>> {
  // Query all RewardClaimed PDAs using Anchor's built-in method
  const rewardClaimedAccounts = await queryAllRewardClaimedPDAs(program);

  const [globalStatePDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_state")],
    program.programId
  );

  const results: Array<{ address: PublicKey; tx: string; error?: string }> = [];

  // Close each PDA
  for (const account of rewardClaimedAccounts) {
    try {
      const quest = new PublicKey(account.data.quest);
      const winner = new PublicKey(account.data.winner);

      const tx = await closeRewardClaimed(
        program,
        quest,
        winner,
        owner,
        recipient
      );

      results.push({
        address: account.address,
        tx,
      });

      console.log(
        `Closed RewardClaimed PDA: ${account.address.toString()}, TX: ${tx}`
      );
    } catch (error: any) {
      const errorMsg = error.message || String(error);
      console.error(
        `Failed to close ${account.address.toString()}:`,
        errorMsg
      );
      results.push({
        address: account.address,
        tx: "",
        error: errorMsg,
      });
    }
  }

  return results;
}

/**
 * Example usage:
 * 
 * ```typescript
 * import * as anchor from "@coral-xyz/anchor";
 * import { Keypair, PublicKey } from "@solana/web3.js";
 * import { 
 *   queryAllRewardClaimedPDAs, 
 *   closeAllRewardClaimedPDAs,
 *   closeRewardClaimed 
 * } from "./scripts/query-and-close-reward-claimed";
 * import { SvmContracts } from "../target/types/svm_contracts";
 * 
 * const provider = anchor.AnchorProvider.env();
 * anchor.setProvider(provider);
 * 
 * const program = anchor.workspace.svmContracts as Program<SvmContracts>;
 * const owner = Keypair.fromSecretKey(...); // Your owner keypair
 * const recipient = owner.publicKey; // Or any other address
 * 
 * // Method 1: Query all RewardClaimed PDAs using Anchor's built-in method (recommended)
 * const accounts = await queryAllRewardClaimedPDAs(program);
 * console.log(`Found ${accounts.length} RewardClaimed PDAs`);
 * 
 * // Method 2: Close all PDAs as owner
 * const results = await closeAllRewardClaimedPDAs(program, owner, recipient);
 * console.log(`Closed ${results.length} PDAs`);
 * results.forEach((result) => {
 *   if (result.error) {
 *     console.error(`Failed: ${result.address.toString()} - ${result.error}`);
 *   } else {
 *     console.log(`Success: ${result.address.toString()} - TX: ${result.tx}`);
 *   }
 * });
 * 
 * // Method 3: Close a specific PDA
 * const quest = new PublicKey("..."); // Quest public key
 * const winner = new PublicKey("..."); // Winner public key
 * const tx = await closeRewardClaimed(program, quest, winner, owner, recipient);
 * console.log(`Closed PDA, TX: ${tx}`);
 * ```
 */

