from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import TransferParams, transfer
from solders.transaction import VersionedTransaction, Transaction
from solders.message import Message
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.rpc.types import TxOpts
import os
from dotenv import load_dotenv
import time
from typing import List, Dict, Optional
import logging
import sys
import csv
from datetime import datetime
import asyncio
import base58
import struct

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('sol_token_distribution.log'),
        logging.StreamHandler()
    ]
)

# CSV file paths
SUCCESSFUL_TRANSACTIONS_CSV = 'sol_successful_transactions.csv'
FAILED_TRANSACTIONS_CSV = 'sol_failed_transactions.csv'

# CSV headers
TRANSACTION_HEADERS = ['timestamp', 'amount', 'to_address', 'signature']
FAILED_HEADERS = ['timestamp', 'amount', 'to_address', 'error']

def update_csv_record(file_path: str, headers: List[str], new_data: Dict):
    """Update CSV file with new transaction data"""
    # Create file with headers if it doesn't exist
    if not os.path.exists(file_path):
        with open(file_path, 'w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=headers)
            writer.writeheader()
    
    # Append new data
    with open(file_path, 'a', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writerow(new_data)

# Load environment variables
load_dotenv()

# Program IDs
TOKEN_PROGRAM_ID = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
ASSOCIATED_TOKEN_PROGRAM_ID = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")

# Initialize Solana connection
RPC_URL = os.getenv('SOLANA_DEVNET_RPC_URL', 'https://api.devnet.solana.com')

# Load your private key from environment variable
private_key = os.getenv('SOLANA_PRIVATE_KEY')
if not private_key:
    logging.error("Solana private key not found in .env file")
    sys.exit(1)

try:
    # Handle both base58 and byte array formats
    if private_key.startswith('[') and private_key.endswith(']'):
        # Handle byte array format [1,2,3,...]
        key_bytes = eval(private_key)
        keypair = Keypair.from_bytes(bytes(key_bytes))
    else:
        # Handle base58 format
        keypair = Keypair.from_base58_string(private_key)
except Exception as e:
    logging.error(f"Invalid private key format: {str(e)}")
    sys.exit(1)

def get_associated_token_address(owner: Pubkey, mint: Pubkey) -> Pubkey:
    """Get associated token address for owner and mint"""
    seeds = [
        bytes(owner),
        bytes(TOKEN_PROGRAM_ID),
        bytes(mint),
    ]
    
    # Find program address
    address, _ = Pubkey.find_program_address(seeds, ASSOCIATED_TOKEN_PROGRAM_ID)
    return address

def create_transfer_instruction(
    source: Pubkey,
    dest: Pubkey,
    owner: Pubkey,
    amount: int,
    decimals: int,
    mint: Pubkey
) -> any:
    """Create a token transfer instruction"""
    from solders.instruction import Instruction, AccountMeta
    
    # SPL Token Transfer instruction data
    # Instruction: 12 (TransferChecked)
    # Amount: 8 bytes (little endian)
    # Decimals: 1 byte
    data = struct.pack('<BQB', 12, amount, decimals)
    
    accounts = [
        AccountMeta(source, False, True),     # Source account
        AccountMeta(mint, False, False),      # Mint
        AccountMeta(dest, False, True),       # Destination account  
        AccountMeta(owner, True, False),      # Owner
    ]
    
    return Instruction(TOKEN_PROGRAM_ID, data, accounts)

def create_associated_token_account_instruction(
    payer: Pubkey,
    owner: Pubkey,
    mint: Pubkey
) -> any:
    """Create instruction to create associated token account"""
    from solders.instruction import Instruction, AccountMeta
    from solders.system_program import ID as SYSTEM_PROGRAM_ID
    
    associated_token_address = get_associated_token_address(owner, mint)
    
    accounts = [
        AccountMeta(payer, True, True),                    # Payer
        AccountMeta(associated_token_address, False, True), # Associated token account
        AccountMeta(owner, False, False),                   # Owner
        AccountMeta(mint, False, False),                    # Mint
        AccountMeta(SYSTEM_PROGRAM_ID, False, False),       # System program
        AccountMeta(TOKEN_PROGRAM_ID, False, False),        # Token program
    ]
    
    return Instruction(ASSOCIATED_TOKEN_PROGRAM_ID, bytes(), accounts)

class SolanaTokenDistributor:
    def __init__(self, token_mint: str, decimals: int, batch_size: int = 15, max_workers: int = 2):
        self.token_mint = Pubkey.from_string(token_mint)
        self.decimals = decimals
        self.batch_size = batch_size
        self.max_workers = max_workers
        self.keypair = keypair
        
        self.successful_transfers = 0
        self.failed_transfers = 0
        self.failed_transactions = []
        
        # Initialize async components
        self.client = AsyncClient(RPC_URL)
        
    async def get_token_balance(self) -> float:
        """Get token balance of the sender"""
        try:
            # Get associated token account
            token_account = get_associated_token_address(
                self.keypair.pubkey(), 
                self.token_mint
            )
            
            # Get token account info
            response = await self.client.get_token_account_balance(token_account)
            if response.value:
                balance = float(response.value.amount) / (10 ** self.decimals)
                logging.info(f"Token balance of sender: {balance}")
                return balance
            else:
                logging.warning("Token account not found or has no balance")
                return 0.0
        except Exception as e:
            logging.error(f"Error getting token balance: {str(e)}")
            return 0.0

    async def account_exists(self, account: Pubkey) -> bool:
        """Check if account exists"""
        try:
            account_info = await self.client.get_account_info(account)
            return account_info.value is not None
        except:
            return False

    async def prepare_spl_transfer(self, recipient_address: str, amount: float) -> Optional[Dict]:
        """Prepare an SPL token transfer transaction"""
        try:
            recipient_pubkey = Pubkey.from_string(recipient_address)
            amount_lamports = int(amount * (10 ** self.decimals))
            
            # Get sender's token account
            sender_token_account = get_associated_token_address(
                self.keypair.pubkey(), 
                self.token_mint
            )
            
            # Get recipient's token account
            recipient_token_account = get_associated_token_address(
                recipient_pubkey,
                self.token_mint
            )
            
            # Check if recipient token account exists
            account_exists = await self.account_exists(recipient_token_account)
            
            instructions = []
            
            # Add create account instruction if needed
            if not account_exists:
                create_instruction = create_associated_token_account_instruction(
                    self.keypair.pubkey(),
                    recipient_pubkey,
                    self.token_mint
                )
                instructions.append(create_instruction)
            
            # Create transfer instruction
            transfer_instruction = create_transfer_instruction(
                sender_token_account,
                recipient_token_account,
                self.keypair.pubkey(),
                amount_lamports,
                self.decimals,
                self.token_mint
            )
            instructions.append(transfer_instruction)
            
            return {
                'instructions': instructions,
                'recipient_address': recipient_address,
                'amount': amount,
            }
            
        except Exception as e:
            error_msg = str(e)
            logging.error(f"Error preparing SPL transfer for {recipient_address}: {error_msg}")
            
            # Record failed transaction
            update_csv_record(
                FAILED_TRANSACTIONS_CSV,
                FAILED_HEADERS,
                {
                    'timestamp': datetime.now().isoformat(),
                    'amount': amount,
                    'to_address': recipient_address,
                    'error': error_msg
                }
            )
            return None

    async def send_spl_transaction(self, transfer_data: Dict) -> bool:
        """Send an SPL token transfer transaction"""
        try:
            # Get recent blockhash
            blockhash_resp = await self.client.get_latest_blockhash()
            recent_blockhash = blockhash_resp.value.blockhash
            
            # Create and sign transaction
            message = Message.new_with_blockhash(
                transfer_data['instructions'],
                self.keypair.pubkey(),
                recent_blockhash
            )
            
            transaction = Transaction.new_unsigned(message)
            transaction.sign([self.keypair])
            
            # Send transaction
            opts = TxOpts(skip_confirmation=False, skip_preflight=False)
            result = await self.client.send_transaction(transaction, opts=opts)
            
            if result.value:
                self.successful_transfers += 1
                signature = str(result.value)
                logging.info(f"SPL transfer successful! Signature: {signature}")
                
                # Record successful transaction
                update_csv_record(
                    SUCCESSFUL_TRANSACTIONS_CSV,
                    TRANSACTION_HEADERS,
                    {
                        'timestamp': datetime.now().isoformat(),
                        'amount': transfer_data['amount'],
                        'to_address': transfer_data['recipient_address'],
                        'signature': signature
                    }
                )
                return True
            else:
                self.failed_transfers += 1
                error_msg = "Transaction failed - no signature returned"
                logging.error(f"SPL transfer failed: {error_msg}")
                
                # Record failed transaction
                update_csv_record(
                    FAILED_TRANSACTIONS_CSV,
                    FAILED_HEADERS,
                    {
                        'timestamp': datetime.now().isoformat(),
                        'amount': transfer_data['amount'],
                        'to_address': transfer_data['recipient_address'],
                        'error': error_msg
                    }
                )
                return False
                
        except Exception as e:
            self.failed_transfers += 1
            error_msg = str(e)
            logging.error(f"Error sending SPL transaction: {error_msg}")
            
            # Record failed transaction
            update_csv_record(
                FAILED_TRANSACTIONS_CSV,
                FAILED_HEADERS,
                {
                    'timestamp': datetime.now().isoformat(),
                    'amount': transfer_data['amount'],
                    'to_address': transfer_data['recipient_address'],
                    'error': error_msg
                }
            )
            return False

    async def process_batch(self, batch: List[Dict]) -> None:
        """Process a batch of SPL token transfers"""
        for transfer in batch:
            wallet = transfer['wallet']
            amount = transfer['amount']
            
            # Add delay to avoid rate limiting
            await asyncio.sleep(0.5)
            
            transfer_data = await self.prepare_spl_transfer(wallet, amount)
            if transfer_data:
                success = await self.send_spl_transaction(transfer_data)
                if not success:
                    self.failed_transactions.append(transfer)
            else:
                self.failed_transactions.append(transfer)
                self.failed_transfers += 1

    async def distribute_tokens(self, input_data: List[Dict]) -> None:
        """Distribute SPL tokens to multiple wallets with batching"""
        start_time = time.time()
        total_transfers = len(input_data)
        total_amount = sum(transfer['amount'] for transfer in input_data)
        
        logging.info(f"Preparing to distribute {total_amount} SPL tokens to {total_transfers} wallets")
        
        # Check token balance
        balance = await self.get_token_balance()
        if balance < total_amount:
            logging.error(f"Insufficient token balance. Required: {total_amount}, Available: {balance}")
            return
        
        # Split input data into batches
        batches = [input_data[i:i + self.batch_size] for i in range(0, len(input_data), self.batch_size)]
        
        logging.info(f"Starting distribution of {total_transfers} transfers in {len(batches)} batches")
        
        # Process batches sequentially
        for i, batch in enumerate(batches):
            logging.info(f"Processing batch {i+1}/{len(batches)}")
            await self.process_batch(batch)
            
            # Add delay between batches
            if i < len(batches) - 1:
                await asyncio.sleep(2)
        
        end_time = time.time()
        duration = end_time - start_time
        
        # Print summary
        logging.info("\nDistribution Summary:")
        logging.info(f"Total transfers: {total_transfers}")
        logging.info(f"Total amount distributed: {total_amount}")
        logging.info(f"Successful transfers: {self.successful_transfers}")
        logging.info(f"Failed transfers: {self.failed_transfers}")
        logging.info(f"Time taken: {duration:.2f} seconds")
        
        # Print CSV file locations
        logging.info(f"\nTransaction records:")
        logging.info(f"Successful transactions: {SUCCESSFUL_TRANSACTIONS_CSV}")
        logging.info(f"Failed transactions: {FAILED_TRANSACTIONS_CSV}")
        
        # Close client
        await self.client.close()

async def distribute_spl_tokens(token_mint: str, token_decimals: int, distribution_list: List[Dict]) -> None:
    """Main function to handle SPL token distribution"""
    try:
        # Initialize distributor
        distributor = SolanaTokenDistributor(
            token_mint=token_mint,
            decimals=token_decimals,
            batch_size=15,  # Small batches for Solana
            max_workers=2   # Conservative for rate limiting
        )
        
        # Start distribution
        await distributor.distribute_tokens(distribution_list)
        
    except Exception as e:
        logging.error(f"Distribution failed: {str(e)}")
        sys.exit(1)

def run_distribution(token_mint: str, token_decimals: int, distribution_list: List[Dict]):
    """Synchronous wrapper for async distribution"""
    asyncio.run(distribute_spl_tokens(token_mint, token_decimals, distribution_list))

# if __name__ == "__main__":
#     # Example: USDC SPL token mint address on Solana mainnet
#     token_mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"  # USDC
    
#     # USDC decimals on Solana
#     token_decimals = 6
    
#     # Your distribution list
#     distribution_list = [
#         {
#             "wallet": "11111111111111111111111111111112",  # Example address
#             "amount": 1.0
#         },
#         # ... more wallet entries ...
#     ]
    
#     run_distribution(token_mint, token_decimals, distribution_list)
