# Complete User Journey: Quest Creation → Airdrop Distribution

## Phase 1: Quest Creation (Creator/Admin)

### 1. Creator Creates Quest via Backend API
- Creator sets quest details: title, tasks, reward pool, deadline, max winners
- Backend generates `quest_id` (e.g., "summer-campaign-2024")
- Quest stored in database with status, tasks, eligibility criteria

### 2. On-Chain Quest Creation (`create_quest`)
- Creator calls Solana program with:
  - `quest_id` (string)
  - `amount` (total reward budget in token units)
  - `deadline` (Unix timestamp)
  - `max_winners` (maximum number of winners)
- Program creates:
  - **Quest PDA**: `[b"quest", quest_id]`
  - **Escrow PDA**: `[b"escrow", quest_pda]`
- Creator transfers tokens from their ATA → Quest Escrow PDA
- Quest state initialized:
  - `is_active = true`
  - `total_winners = 0`
  - `total_reward_distributed = 0`
- Emits `QuestCreated` event

---

## Phase 2: User Participation (Users)

### 3. Users Discover and Join Quest
- Users browse quests on frontend
- Click "Join Quest" → creates `user_quest_task` entries in database
- Users see available tasks and requirements

### 4. Users Complete Tasks
- Users perform actions:
  - Follow accounts
  - Tweet with hashtags/cashtags
  - Retweet specific tweets
  - Reply to tweets
  - Quote tweet
- Frontend calls `/api/quests/user-tasks/create` with `task_status: "under_review"`
- Backend verifies task completion:
  - Twitter API verification
  - Metrics collection
  - Task validation
- Task status updates: `under_review` → `verified` → `completed`

### 5. Backend Tracks Progress
- Backend monitors all task completions
- Determines winners based on:
  - `reward_system`: 
    - `"first_come"` → First N users who complete all tasks
    - `"custom"` → KOL list with predefined rewards
  - Eligibility criteria (filters, KOL lists)
- Calculates reward amounts per winner
- Prepares recipient list with wallet addresses and amounts

---

## Phase 3: Airdrop Execution (Admin/Backend)

### 6. Admin Runs Airdrop Script
```bash
npm run airdrop -- --quest "summer-campaign-2024" --mint <token_mint_address> --recipients '[{"pubkey":"...","amount":20000000000}]'
```

### 7. Script Execution Flow

#### Step 1: Setup
- Loads wallet from `~/.config/solana/id.json`
- Connects to RPC (local validator or mainnet/devnet)
- Loads Anchor program from `target/idl/svm_contracts.json`
- Initializes provider and program instance

#### Step 2: Derive PDAs
- **Global State PDA**: `[b"global_state"]` → Program's global configuration
- **Quest PDA**: `[b"quest", quest_id]` → Quest account
- **Escrow PDA**: `[b"escrow", quest_pda]` → Token escrow account

#### Step 3: Fund External Airdrop (`fund_external_airdrop`)
- Transfers tokens from **Quest Escrow PDA** → **Distributor ATA**
- Validations performed:
  - ✅ Quest is active (`is_active = true`)
  - ✅ Deadline not passed (`now <= deadline`)
  - ✅ Sufficient balance in escrow
  - ✅ Only admin/owner can call (authorization check)
  - ✅ Token mint matches quest token mint
- Emits `ExternalAirdropPlanned` event with:
  - Quest address
  - Mint address
  - Distributor ATA
  - Amount
  - Batch ID

#### Step 4: Token Pool Setup
- Checks if token pool exists for the mint
- Creates pool if missing (required for compression)
- Token pool enables compressed token functionality

#### Step 5: Compressed Token Distribution
- Selects active state tree from Light Protocol
- For each recipient (or chunk of recipients):
  - Calls `CompressedTokenProgram.compress()`
  - Transfers from **Distributor ATA** → **Compressed token accounts**
  - Recipients receive compressed tokens (cheaper, off-chain state)
  - Processes in chunks (default: 1000 recipients per transaction)
- Compressed tokens are stored off-chain but verifiable on-chain

#### Step 6: Settle Airdrop (`settle_external_airdrop`)
- Updates quest state on-chain:
  - `total_reward_distributed += distributed_amount`
  - `total_winners += winners_count`
- Validations:
  - ✅ Budget not exceeded (`total_reward_distributed <= quest.amount`)
  - ✅ Only admin/owner can call
- Emits `ExternalAirdropSettled` event with:
  - Quest address
  - Distributed amount
  - Winners count
  - Batch ID

#### Step 7: Verification
- Queries compressed token accounts for each recipient
- Verifies balances match expected amounts
- Logs distribution summary

---

## Phase 4: User Receives Rewards

### 8. Users Receive Compressed Tokens
- Tokens appear in their wallets as compressed SPL tokens
- Users can view balances via Light Protocol RPC
- Compressed tokens offer:
  - ✅ Lower transaction fees
  - ✅ Off-chain state storage
  - ✅ On-chain verification
  - ✅ Same functionality as regular SPL tokens

### 9. Quest State Updates
- Quest on-chain state reflects:
  - How many winners rewarded (`total_winners`)
  - Total amount distributed (`total_reward_distributed`)
  - Remaining balance in escrow
- Backend can query quest state to track distribution

---

## Phase 5: Quest Completion (Optional)

### 10. Claim Remaining Rewards (After Deadline + 1 Week)
- If quest ends with unclaimed rewards
- Creator or admin can call `claim_remaining_reward()`
- Transfers remaining tokens from escrow → creator
- Closes escrow account
- Emits `RemainingClaimed` event

---

## Key On-Chain State Transitions

```
Quest Creation:
  escrow.balance: 0 → 100 tokens
  quest.total_winners: 0
  quest.total_reward_distributed: 0

Fund External Airdrop:
  escrow.balance: 100 → 10 tokens (90 transferred to distributor)
  distributor_ata.balance: 0 → 90 tokens

Compressed Distribution:
  distributor_ata.balance: 90 → 0 tokens
  recipient1.compressed_balance: 0 → 20 tokens
  recipient2.compressed_balance: 0 → 30 tokens
  recipient3.compressed_balance: 0 → 40 tokens

Settle Airdrop:
  quest.total_winners: 0 → 3
  quest.total_reward_distributed: 0 → 90 tokens
```

---

## Security & Validation Points

### Authorization Checks
- ✅ Only admin/owner can call `fund_external_airdrop`
- ✅ Only admin/owner can call `settle_external_airdrop`
- ✅ Quest creator can cancel quest (before deadline)
- ✅ Quest creator or admin can claim remaining rewards (after deadline + 1 week)

### State Validations
- ✅ Quest must be active (`is_active = true`)
- ✅ Deadline must not be passed (for funding)
- ✅ Budget validation: `total_reward_distributed + new_amount <= quest.amount`
- ✅ Escrow balance validation before funding
- ✅ Token mint validation (must be in supported list)

### Error Handling
- Contract can be paused by admin
- Invalid quest PDA validation
- Insufficient balance checks
- Rounding error prevention

---

## Program Accounts Structure

### Global State
- `owner`: Admin/owner public key
- `paused`: Contract pause status
- `supported_token_mints`: List of supported token mints

### Quest Account
- `id`: Quest ID string
- `creator`: Quest creator public key
- `token_mint`: Token mint address
- `escrow_account`: Escrow token account
- `amount`: Total reward budget
- `deadline`: Quest deadline timestamp
- `is_active`: Quest active status
- `total_winners`: Number of winners rewarded
- `total_reward_distributed`: Total tokens distributed
- `max_winners`: Maximum number of winners

### Escrow Account
- Token account owned by Global State PDA
- Holds quest reward tokens
- Authority: Global State PDA

---

## Events Emitted

### QuestCreated
- Quest address
- Quest ID
- Mint address
- Budget amount
- Deadline
- Creator address

### ExternalAirdropPlanned
- Quest address
- Mint address
- Distributor ATA
- Amount
- Batch ID

### ExternalAirdropSettled
- Quest address
- Distributed amount
- Winners count
- Batch ID

### RemainingClaimed
- Quest address
- Claimer address
- Amount claimed

---

## Usage Examples

### Basic Airdrop (Default 3 Recipients)
```bash
npm run airdrop -- --quest "test-quest-1" --mint <mint_address>
```

### Custom Recipients
```bash
npm run airdrop -- --quest "test-quest-1" --mint <mint_address> --recipients '[{"pubkey":"ABC123...","amount":1000000000},{"pubkey":"XYZ789...","amount":2000000000}]'
```

### Custom RPC
```bash
RPC_URL=http://localhost:8899 npm run airdrop -- --quest "test-quest-1" --mint <mint_address>
```

---

## Benefits of This Architecture

1. **Separation of Concerns**
   - Off-chain: Task verification, user tracking, winner selection
   - On-chain: Token custody, distribution, state tracking

2. **Cost Efficiency**
   - Compressed tokens reduce transaction costs
   - Batch processing for multiple recipients
   - Off-chain state storage

3. **Security**
   - Tokens held in program-controlled escrow
   - Admin-only distribution functions
   - Budget validation prevents overspending

4. **Flexibility**
   - Supports multiple reward systems (first-come, custom KOL lists)
   - Can handle large recipient lists
   - Batch processing for scalability

5. **Transparency**
   - All distributions recorded on-chain
   - Events for tracking
   - Verifiable quest state

