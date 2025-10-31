import 'dotenv/config';

export function getConfig() {
  return {
    rpc: process.env.HELIUS_RPC!,
    programId: process.env.PROGRAM_ID!,
    mint: process.env.MINT!,
    secretKey: process.env.PAYER_SECRET_KEY!,
    distributorOwner: process.env.DISTRIBUTOR_OWNER,
  };
}
