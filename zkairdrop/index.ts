// Test Compressed Token Airdrop - LocalNet
// This script integrates with the quest system:
// 1. Calls fund_external_airdrop to transfer tokens from quest escrow to distributor ATA
// 2. Distributes compressed tokens to recipients
// 3. Calls settle_external_airdrop to update quest state

import * as anchor from "@coral-xyz/anchor";
import {
  CompressedTokenProgram,
  createTokenPool,
  getTokenPoolInfos,
  selectTokenPoolInfo,
} from "@lightprotocol/compressed-token";
import {
  createRpc,
  Rpc,
  selectStateTreeInfo,
} from "@lightprotocol/stateless.js";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Configuration
const PROGRAM_ID = "9ctNgXvXeorsripJP7K61CH1UytzoMNzvPtQFBrFK5qU";
const RPC_URL = process.env.RPC_URL || "http://localhost:8899";

// Helper to derive PDAs (matching airdrop-worker)
function getPDAs(programId: string, questId: string) {
  const pid = new PublicKey(programId);

  const questSeed = Buffer.from(questId, "utf8");
  const seed =
    questSeed.length <= 32
      ? questSeed
      : crypto.createHash("sha256").update(questSeed).digest();

  const [globalState] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_state")],
    pid
  );
  const [quest] = PublicKey.findProgramAddressSync(
    [Buffer.from("quest"), seed],
    pid
  );
  const [escrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), quest.toBuffer()],
    pid
  );

  return { globalState, quest, escrow };
}

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments: quest ID, mint address, and optionally recipients
  const questIdIndex = args.indexOf("--quest");
  const mintIndex = args.indexOf("--mint");
  const recipientsIndex = args.indexOf("--recipients");

  if (questIdIndex === -1 || args[questIdIndex + 1] === undefined) {
    console.error(
      "Usage: npm run airdrop -- --quest <quest_id> --mint <mint_address> [--recipients <json_array>]"
    );
    console.error("\nExample:");
    console.error(
      '  npm run airdrop -- --quest "test-quest-1" --mint <mint_address>'
    );
    console.error(
      '  npm run airdrop -- --quest "test-quest-1" --mint <mint_address> --recipients \'[{"pubkey":"...","amount":1000000}]\''
    );
    process.exit(1);
  }

  if (mintIndex === -1 || args[mintIndex + 1] === undefined) {
    console.error("Error: --mint is required");
    process.exit(1);
  }

  const questId = args[questIdIndex + 1];
  const mintAddress = args[mintIndex + 1];
  const mint = new PublicKey(mintAddress);

  // Default recipients for testing (3 recipients with different amounts)
  let recipients: Array<{ pubkey: string; amount: number }> = [
    {
      pubkey: Keypair.generate().publicKey.toBase58(),
      amount: 20_000_000_000, // 20 tokens with 9 decimals
    },
    {
      pubkey: Keypair.generate().publicKey.toBase58(),
      amount: 30_000_000_000, // 30 tokens
    },
    {
      pubkey: Keypair.generate().publicKey.toBase58(),
      amount: 40_000_000_000, // 40 tokens
    },
  ];

  if (recipientsIndex !== -1 && args[recipientsIndex + 1]) {
    try {
      recipients = JSON.parse(args[recipientsIndex + 1]);
    } catch (e) {
      console.error("Error parsing recipients JSON:", e);
      process.exit(1);
    }
  }

  if (!recipients?.length) {
    console.error("Error: No recipients provided");
    process.exit(1);
  }

  console.log("=== Quest Airdrop Script ===\n");
  console.log(`Quest ID: ${questId}`);
  console.log(`Mint: ${mintAddress}`);
  console.log(`Recipients: ${recipients.length}\n`);

  // Step 1: Setup connections and wallet
  console.log("Step 1: Setting up connections...");
  const conn = new Connection(RPC_URL, "confirmed");
  const lconn: Rpc = createRpc(RPC_URL);

  const walletPath = `${os.homedir()}/.config/solana/id.json`;
  const secretKey = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const payer = Keypair.fromSecretKey(Buffer.from(secretKey));
  console.log(`✓ Payer: ${payer.publicKey.toBase58()}`);

  // Step 2: Setup Anchor program
  console.log("\nStep 2: Loading Anchor program...");
  const provider = new anchor.AnchorProvider(
    conn,
    new (class Wallet {
      publicKey = payer.publicKey;
      async signTransaction(tx: any) {
        tx.partialSign(payer);
        return tx;
      }
      async signAllTransactions(txs: any[]) {
        txs.forEach((t) => t.partialSign(payer));
        return txs;
      }
    })(),
    { commitment: "confirmed" }
  );
  anchor.setProvider(provider);

  // Load IDL
  const idlPath = path.join(
    __dirname,
    "..",
    "target",
    "idl",
    "svm_contracts.json"
  );
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const program = new anchor.Program(idl, new PublicKey(PROGRAM_ID), provider);
  console.log(`✓ Program loaded: ${PROGRAM_ID}`);

  // Step 3: Derive PDAs
  console.log("\nStep 3: Deriving PDAs...");
  const { globalState, quest, escrow } = getPDAs(PROGRAM_ID, questId);
  console.log(`✓ Global State: ${globalState.toBase58()}`);
  console.log(`✓ Quest: ${quest.toBase58()}`);
  console.log(`✓ Escrow: ${escrow.toBase58()}`);

  // Step 4: Get distributor ATA
  console.log("\nStep 4: Setting up distributor ATA...");
  const distributorOwner = payer.publicKey;
  const distributorAta = await getAssociatedTokenAddress(
    mint,
    distributorOwner
  );
  console.log(`✓ Distributor ATA: ${distributorAta.toBase58()}`);

  // Step 5: Calculate total amount
  const total = recipients.reduce((acc, r) => acc + BigInt(r.amount), 0n);
  console.log(
    `\nTotal amount to distribute: ${total.toString()} (${
      Number(total) / 1e9
    } tokens)`
  );

  // Step 6: Fund external airdrop (transfer from escrow to distributor ATA)
  console.log("\nStep 5: Funding external airdrop from quest escrow...");
  const batchId = BigInt(Date.now());
  try {
    const fundTx = await program.methods
      .fundExternalAirdrop(
        new anchor.BN(total.toString()),
        new anchor.BN(batchId.toString())
      )
      .accounts({
        signer: payer.publicKey,
        globalState,
        quest,
        escrowAccount: escrow,
        distributorAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log(`✓ Fund transaction: ${fundTx}`);
  } catch (error: any) {
    console.error("Error funding airdrop:", error.message);
    if (error.logs) {
      console.error("Logs:", error.logs);
    }
    process.exit(1);
  }

  // Step 7: Ensure token pool exists
  console.log("\nStep 6: Ensuring token pool exists...");
  const pools = await getTokenPoolInfos(lconn, mint);
  let pool = selectTokenPoolInfo(pools);
  if (!pool) {
    console.log("Creating token pool...");
    const poolTxId = await createTokenPool(lconn, payer, mint);
    console.log(`✓ Token pool created: ${poolTxId}`);
    // Re-fetch pools after creation
    const newPools = await getTokenPoolInfos(lconn, mint);
    pool = selectTokenPoolInfo(newPools);
  } else {
    console.log(`✓ Token pool exists: ${pool.poolId}`);
  }

  if (!pool) {
    throw new Error("Failed to get token pool");
  }

  // Step 8: Get state tree info
  console.log("\nStep 7: Selecting state tree...");
  const activeStateTrees = await lconn.getStateTreeInfos();
  const treeInfo = selectStateTreeInfo(activeStateTrees);
  if (!treeInfo) {
    throw new Error("No active state trees available");
  }
  console.log(`✓ State tree: ${treeInfo.treeId}`);

  // Step 9: Distribute compressed tokens
  console.log("\nStep 8: Distributing compressed tokens...");
  const CHUNK_SIZE = 1000; // Process in chunks if needed
  for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
    const chunk = recipients.slice(i, i + CHUNK_SIZE);
    console.log(
      `Processing chunk ${Math.floor(i / CHUNK_SIZE) + 1} (${
        chunk.length
      } recipients)...`
    );

    const compressIx = await CompressedTokenProgram.compress({
      payer: payer.publicKey,
      owner: payer.publicKey,
      source: distributorAta,
      toAddress: chunk.map((r) => new PublicKey(r.pubkey)),
      amount: chunk.map((r) => BigInt(r.amount)),
      mint,
      tokenPoolInfo: pool,
      outputStateTreeInfo: treeInfo,
    });

    const tx = await anchor.web3.sendAndConfirmTransaction(
      conn,
      new anchor.web3.Transaction().add(compressIx),
      [payer]
    );
    console.log(`✓ Compressed chunk sent: ${tx}`);
  }

  // Step 10: Settle external airdrop (update quest state)
  console.log("\nStep 9: Settling external airdrop...");
  try {
    const settleTx = await program.methods
      .settleExternalAirdrop(
        new anchor.BN(total.toString()),
        new anchor.BN(recipients.length),
        new anchor.BN(batchId.toString())
      )
      .accounts({
        signer: payer.publicKey,
        globalState,
        quest,
      })
      .rpc();
    console.log(`✓ Settle transaction: ${settleTx}`);
  } catch (error: any) {
    console.error("Error settling airdrop:", error.message);
    if (error.logs) {
      console.error("Logs:", error.logs);
    }
    process.exit(1);
  }

  // Step 11: Verify distribution
  console.log("\nStep 10: Verifying distribution...");
  for (let i = 0; i < recipients.length; i++) {
    const recipientPubkey = new PublicKey(recipients[i].pubkey);
    const recipientAccounts = await lconn.getCompressedTokenAccountsByOwner(
      recipientPubkey,
      { mint }
    );
    const balance = recipientAccounts.items.reduce(
      (sum, account) => sum + Number(account.parsed.amount),
      0
    );
    console.log(
      `✓ Recipient ${i + 1} (${recipientPubkey.toBase58()}): ${
        balance / 1e9
      } compressed tokens`
    );
  }

  console.log(
    `\n✅ Airdrop complete: ${
      recipients.length
    } recipients, ${total.toString()} units`
  );
}

main().catch((e) => {
  console.error("Airdrop failed:", e);
  process.exit(1);
});
