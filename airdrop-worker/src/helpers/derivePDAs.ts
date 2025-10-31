import { PublicKey } from '@solana/web3.js';
import crypto from 'crypto';

export function getPDAs(programId: string, questId: string) {
  const pid = new PublicKey(programId);

  const questSeed = Buffer.from(questId, 'utf8');
  const seed = questSeed.length <= 32 ? questSeed : crypto.createHash('sha256').update(questSeed).digest();

  const [globalState] = PublicKey.findProgramAddressSync([Buffer.from('global_state')], pid);
  const [quest] = PublicKey.findProgramAddressSync([Buffer.from('quest'), seed], pid);
  const [escrow] = PublicKey.findProgramAddressSync([Buffer.from('escrow'), quest.toBuffer()], pid);

  return { globalState, quest, escrow };
}
