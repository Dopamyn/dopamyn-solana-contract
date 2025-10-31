// src/compressed-airdrop.ts
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { PublicKey, Keypair, Connection } from '@solana/web3.js';
import * as anchor from '@project-serum/anchor';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import { createRpc } from '@lightprotocol/stateless.js';
import { CompressedTokenProgram, createTokenPool, getTokenPoolInfos, selectTokenPoolInfo } from '@lightprotocol/compressed-token';
import { getPDAs } from './helpers/derivePDAs.js';
import { getConfig } from './config.js';
import type { Recipient } from './types.js';

const { values } = parseArgs({
  options: {
    quest: { type: 'string' },
    recipients: { type: 'string' },
  },
});

async function main() {
  const cfg = getConfig();
  const questId = values.quest!;
  const recipients: Recipient[] = JSON.parse(values.recipients!);

  if (!recipients?.length) throw new Error('No recipients provided');

  const conn = new Connection(cfg.rpc, 'confirmed');
  const lconn = createRpc(cfg.rpc);

  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(cfg.secretKey)));
  const provider = new anchor.AnchorProvider(conn, new (class Wallet {
    publicKey = payer.publicKey;
    async signTransaction(tx) { tx.partialSign(payer); return tx; }
    async signAllTransactions(txs) { txs.forEach(t => t.partialSign(payer)); return txs; }
  })(), { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idl = await import('../target/idl/svm_contracts.json', { assert: { type: 'json' } });
  const program = new anchor.Program(idl.default, new PublicKey(cfg.programId), provider);

  const { globalState, quest, escrow } = getPDAs(cfg.programId, questId);
  const distributorOwner = new PublicKey(cfg.distributorOwner || payer.publicKey);
  const distributorAta = await getAssociatedTokenAddress(new PublicKey(cfg.mint), distributorOwner);

  const total = recipients.reduce((acc, r) => acc + BigInt(r.amount), 0n);

  // fund external airdrop
  await program.methods
    .fundExternalAirdrop(new anchor.BN(total.toString()), new anchor.BN(Date.now()))
    .accounts({
      signer: payer.publicKey,
      globalState,
      quest,
      escrowAccount: escrow,
      distributorAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();

  // ensure token pool
  const pools = await getTokenPoolInfos(lconn, new PublicKey(cfg.mint));
  let pool = selectTokenPoolInfo(pools);
  if (!pool) await createTokenPool(lconn, payer, new PublicKey(cfg.mint));

  // compressed transfers in chunks
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
    const chunk = recipients.slice(i, i + CHUNK_SIZE);
    const ix = await CompressedTokenProgram.compress({
      payer: payer.publicKey,
      mint: new PublicKey(cfg.mint),
      source: distributorAta,
      recipients: chunk.map((r) => ({ owner: new PublicKey(r.pubkey), amount: BigInt(r.amount) })),
      connection: lconn,
    });
    const tx = await anchor.web3.sendAndConfirmTransaction(conn, new anchor.web3.Transaction().add(ix), [payer]);
    console.log('Sent compressed chunk:', tx);
  }

  // settle
  await program.methods
    .settleExternalAirdrop(new anchor.BN(total.toString()), new anchor.BN(recipients.length), new anchor.BN(Date.now()))
    .accounts({ signer: payer.publicKey, globalState, quest })
    .rpc();

  console.log(`✅ Airdrop complete: ${recipients.length} recipients, ${total.toString()} units`);
}

main().catch((e) => {
  console.error('Airdrop failed', e);
  process.exit(1);
});
