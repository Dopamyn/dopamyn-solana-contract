# SVM Contracts - Quest Reward System

A Solana program built with Anchor that enables users to create quests with token rewards. The system allows quest creators to deposit tokens into escrow accounts and distribute rewards to winners through a secure, decentralized mechanism.

## Overview

This program implements a quest reward system where:

- Users can create quests with token rewards
- Quest creators deposit tokens into escrow accounts
- Only the contract owner can distribute rewards to winners
- Winners can only claim rewards once per quest
- Quest creators can cancel quests and reclaim their tokens

## Program ID

```
8JtK5RkLntLPujMLCuue7NZJXkoopoZWGA3kAp3dJNvL
```

## Data Structures

### GlobalState

- `owner`: Pubkey of the contract owner
- `paused`: Boolean indicating if the contract is paused
- `supported_token_mints`: Vector of supported token mint addresses
- `quests`: Vector of quest IDs

### Quest

- `id`: Unique quest identifier (String)
- `creator`: Pubkey of the quest creator
- `token_mint`: Token mint address for rewards
- `escrow_account`: PDA escrow account holding the reward tokens
- `amount`: Total reward amount in tokens
- `deadline`: Quest deadline timestamp
- `is_active`: Boolean indicating if quest is active
- `total_winners`: Number of winners who have received rewards
- `total_reward_distributed`: Total amount of tokens distributed
- `max_winners`: Maximum number of winners allowed

### RewardClaimed

- `quest_id`: ID of the quest
- `winner`: Pubkey of the winner
- `reward_amount`: Amount of tokens rewarded
- `claimed`: Boolean indicating if reward was claimed

## Functions

### `initialize(supported_token_mints: Vec<Pubkey>)`

Initializes the global state of the contract.

**Parameters:**

- `supported_token_mints`: Vector of token mint addresses that can be used for quests

**Requirements:**

- Must be called by the contract owner
- Can only be called once

### `create_quest(id: String, amount: u64, deadline: i64, max_winners: u32)`

Creates a new quest with token rewards.

**Parameters:**

- `id`: Unique identifier for the quest
- `amount`: Total reward amount in tokens
- `deadline`: Quest deadline timestamp
- `max_winners`: Maximum number of winners allowed

**Requirements:**

- Contract must not be paused
- Token mint must be in supported tokens list
- Creator must have sufficient token balance
- Quest ID must be unique

**Actions:**

- Creates quest account
- Creates escrow PDA account
- Transfers tokens from creator to escrow
- Adds quest to global state

### `get_quest_info()`

Retrieves information about a specific quest.

**Returns:**

- Complete quest data structure

### `get_all_quests()`

Retrieves all quest IDs from the global state.

**Returns:**

- Vector of quest IDs

### `cancel_quest()`

Cancels an active quest and returns tokens to the creator.

**Requirements:**

- Quest must be active
- Must be called by the quest creator

**Actions:**

- Transfers all tokens from escrow back to creator
- Marks quest as inactive

### `update_quest_status(is_active: bool)`

Updates the active status of a quest.

**Parameters:**

- `is_active`: New active status

**Requirements:**

- Must be called by contract owner

### `add_supported_token()`

Adds a new token mint to the supported tokens list.

**Requirements:**

- Must be called by contract owner
- Token must not already be supported

### `remove_supported_token()`

Removes a token mint from the supported tokens list.

**Requirements:**

- Must be called by contract owner
- Token must exist in supported list

### `pause()`

Pauses the contract, preventing new quest creation.

**Requirements:**

- Must be called by contract owner
- Contract must not already be paused

### `unpause()`

Unpauses the contract, allowing new quest creation.

**Requirements:**

- Must be called by contract owner
- Contract must be paused

### `send_reward(reward_amount: u64)`

Distributes reward tokens to a winner.

**Parameters:**

- `reward_amount`: Amount of tokens to reward

**Requirements:**

- Contract must not be paused
- Must be called by contract owner
- Quest must be active
- Sufficient reward balance in escrow
- Winner limit not exceeded
- Winner must not have already claimed reward

**Actions:**

- Creates reward claimed PDA account
- Updates quest statistics
- Transfers tokens from escrow to winner

## Error Codes

- `ContractPaused`: Contract is currently paused
- `UnsupportedTokenMint`: Token mint is not supported
- `UnauthorizedCancellation`: Only quest creator can cancel
- `QuestNotActive`: Quest is not active
- `UnauthorizedStatusUpdate`: Only owner can update quest status
- `UnauthorizedTokenModification`: Only owner can modify supported tokens
- `TokenAlreadySupported`: Token is already in supported list
- `TokenNotFound`: Token not found in supported list
- `UnauthorizedPauseAction`: Only owner can pause/unpause
- `AlreadyPaused`: Contract is already paused
- `AlreadyUnpaused`: Contract is already unpaused
- `UnauthorizedRewardAction`: Only owner can send rewards
- `InsufficientRewardBalance`: Not enough tokens in escrow
- `MaxWinnersReached`: Quest has reached maximum winners
- `AlreadyRewarded`: Winner has already claimed reward

## Setup Instructions

### Prerequisites

1. **Install Rust**

   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source ~/.cargo/env
   ```

2. **Install Solana CLI**

   ```bash
   sh -c "$(curl -sSfL https://release.solana.com/v1.18.4/install)"
   export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
   ```

3. **Install Anchor**

   ```bash
   cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
   avm install latest
   avm use latest
   ```

4. **Install Node.js and Yarn**

   ```bash
   # Install Node.js (using nvm)
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
   nvm install node
   nvm use node

   # Install Yarn
   npm install -g yarn
   ```

### Project Setup

1. **Clone and Install Dependencies**

   ```bash
   git clone <repository-url>
   cd svm-contracts
   yarn install
   ```

2. **Build the Program**

   ```bash
   anchor build
   ```

3. **Run Tests**

   ```bash
   anchor test
   ```

4. **Deploy to Localnet**

   ```bash
   # Start local validator
   solana-test-validator

   # In another terminal, deploy
   anchor deploy
   ```

### Development Workflow

1. **Start Local Validator**

   ```bash
   solana-test-validator --reset
   ```

2. **Build and Deploy**

   ```bash
   anchor build
   anchor deploy
   ```

3. **Run Tests**

   ```bash
   anchor test
   ```

4. **Generate TypeScript Types**
   ```bash
   anchor build
   # Types will be generated in target/types/
   ```

### Configuration

The project uses the following configuration files:

- `Anchor.toml`: Anchor configuration
- `package.json`: Node.js dependencies
- `Cargo.toml`: Rust dependencies
- `tsconfig.json`: TypeScript configuration

### Testing

The test suite includes comprehensive tests for all functions:

- Quest creation and management
- Token transfers and escrow handling
- Reward distribution
- Access control and error handling
- Edge cases and security scenarios

Run tests with:

```bash
yarn test
# or
anchor test
```

### Deployment

For mainnet deployment:

1. Update the program ID in `lib.rs`
2. Build the program: `anchor build`
3. Deploy: `anchor deploy --provider.cluster mainnet`

## System Flows & User Journeys

### **User Roles & Actors**

1. **Contract Owner** - Deploys and manages the contract
2. **Quest Creator** - Users who create quests with token rewards
3. **Quest Participants/Winners** - Users who can receive rewards
4. **General Users** - Anyone who can view quest information

### **Complete System Flows**

#### **1. Contract Initialization Flow**

```
Contract Owner → Initialize Contract
├── Set supported token mints
├── Set contract owner
├── Initialize global state (paused: false)
└── Ready for quest creation
```

#### **2. Token Management Flow**

```
Contract Owner → Manage Supported Tokens
├── Add new token mint to supported list
├── Remove token mint from supported list
└── Update available tokens for quests
```

#### **3. Quest Creation Flow**

```
Quest Creator → Create Quest
├── Check contract is not paused
├── Verify token mint is supported
├── Create quest account
├── Create escrow PDA account
├── Transfer tokens from creator to escrow
├── Set quest parameters (amount, deadline, max_winners)
└── Quest becomes active
```

#### **4. Quest Discovery Flow**

```
Any User → Discover Quests
├── Get all quest IDs from global state
├── Get specific quest information
└── View quest details (amount, deadline, status, etc.)
```

#### **5. Quest Management Flow**

```
Quest Creator → Manage Their Quest
├── Cancel quest (if active)
│   ├── Transfer tokens back from escrow to creator
│   └── Mark quest as inactive
└── Quest remains in global state but inactive

Contract Owner → Manage Any Quest
├── Update quest status (active/inactive)
└── Control quest availability
```

#### **6. Reward Distribution Flow**

```
Contract Owner → Distribute Rewards
├── Verify quest is active
├── Check sufficient escrow balance
├── Verify winner limit not exceeded
├── Check winner hasn't already claimed
├── Create reward claimed PDA account
├── Transfer tokens from escrow to winner
├── Update quest statistics
└── Mark reward as claimed
```

#### **7. Contract Administration Flow**

```
Contract Owner → Admin Functions
├── Pause contract (prevents new quest creation)
├── Unpause contract (allows new quest creation)
├── Add/remove supported tokens
└── Update quest statuses
```

### **Detailed User Journeys**

#### **Journey 1: Complete Quest Lifecycle**

```
1. Contract Owner deploys and initializes contract
2. Contract Owner adds supported token mints
3. Quest Creator creates quest with token rewards
4. Quest Creator deposits tokens into escrow
5. Quest becomes active and discoverable
6. Contract Owner distributes rewards to winners
7. Winners receive tokens directly
8. Quest Creator can cancel quest anytime (gets tokens back)
```

#### **Journey 2: Quest Creator Experience**

```
1. Quest Creator checks supported tokens
2. Quest Creator creates quest with parameters:
   - Quest ID
   - Token amount
   - Deadline
   - Max winners
3. Tokens automatically transferred to escrow
4. Quest becomes active
5. Quest Creator can cancel anytime
6. If cancelled, tokens returned to creator
```

#### **Journey 3: Winner Experience**

```
1. User discovers available quests
2. User participates in quest (off-chain)
3. Contract Owner identifies winner
4. Contract Owner calls send_reward()
5. Winner receives tokens directly to their account
6. Winner cannot claim again for same quest
```

#### **Journey 4: Contract Owner Management**

```
1. Deploy and initialize contract
2. Add/remove supported tokens
3. Monitor quest creation
4. Distribute rewards to winners
5. Manage quest statuses
6. Pause/unpause contract as needed
```

### **Key Flow Characteristics**

#### **Security Flows**

- **Escrow Protection**: Tokens locked in PDA escrow accounts
- **Single Claim**: Winners can only claim once per quest
- **Owner Control**: Only owner can distribute rewards
- **Creator Rights**: Only creators can cancel their quests

#### **State Transitions**

```
Quest States:
Active → Cancelled (by creator)
Active → Inactive (by owner)
Inactive → Active (by owner)

Contract States:
Unpaused → Paused (by owner)
Paused → Unpaused (by owner)
```

#### **Token Flows**

```
Creator → Escrow (quest creation)
Escrow → Winner (reward distribution)
Escrow → Creator (quest cancellation)
```

#### **Error Handling Flows**

- Contract paused → Cannot create quests
- Unsupported token → Cannot create quest
- Insufficient balance → Cannot create quest
- Already rewarded → Cannot claim again
- Max winners reached → Cannot distribute more rewards

## Security Considerations

- Only the contract owner can distribute rewards
- Quest creators can only cancel their own quests
- Winners can only claim rewards once per quest
- Token transfers use secure CPI calls
- PDA accounts prevent unauthorized access
- Comprehensive error handling prevents edge cases

## License

ISC
