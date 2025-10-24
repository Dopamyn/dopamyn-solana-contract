# SVM Contracts - Quest Reward System

A Solana program built with Anchor that enables users to create quests with token rewards. The system allows quest creators to deposit tokens into escrow accounts and distribute rewards to winners through a secure, decentralized mechanism.

## Quick Start

### Prerequisites

1. Install Rust and Solana

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env

# Install Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/v1.18.4/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Install Anchor
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest
avm use latest

# Install Node.js and Yarn
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install node
nvm use node
npm install -g yarn
```

### Development Setup

1. Clone and install dependencies

```bash
git clone <repository-url>
cd svm-contracts
yarn install
```

2. Build the program

```bash
anchor build
```

3. Run tests

```bash
anchor test
```

## Program Overview

The program implements a quest reward system where:

- Users can create quests with token rewards
- Quest creators deposit tokens into escrow accounts
- Only the contract owner can distribute rewards to winners
- Winners can only claim rewards once per quest
- Quest creators can cancel quests and reclaim their tokens

### Program ID

Current program ID on devnet:

```
43RRcJN1k3kVRDx4i3dNHtCEaY7NCZeaPJe7p7u6vcUd
```

## Modifying and Deploying the Program

### 1. Local Development

1. Start a local validator:

```bash
solana-test-validator --reset
```

2. Configure Solana to use localnet:

```bash
solana config set --url localhost
```

3. Create a new keypair (if you don't have one):

```bash
solana-keygen new
```

### 2. Making Changes

1. Program code is located in:

   - Main program logic: `programs/svm-contracts/src/lib.rs`
   - Constants and data structures: `programs/svm-contracts/src/constants.rs`

2. Key files to modify:

   - `lib.rs`: Contains all instruction handlers and program logic
   - `constants.rs`: Contains account structures and space calculations
   - `Anchor.toml`: Program configuration and deployment settings

3. Important constants to consider when modifying:
   - `MAX_SUPPORTED_TOKEN_MINTS`: Maximum number of supported token mints (currently 10)
   - `MAX_QUESTS`: Maximum number of quests (currently 100)
   - `MAX_QUEST_ID_LENGTH`: Maximum length of quest IDs (currently 36)

### 3. Testing Changes

1. Write tests in `tests/svm-contracts.ts`

2. Run tests:

```bash
anchor test
```

### 4. Deploying to Devnet

1. Configure Solana for devnet:

```bash
solana config set --url devnet
```

2. Get devnet SOL:

```bash
solana airdrop 2
```

3. Build the program:

```bash
anchor build
```

4. Deploy:

```bash
anchor deploy
```

5. Update Program ID:
   - After deployment, update the program ID in:
     - `programs/svm-contracts/src/lib.rs` (in `declare_id!` macro)
     - `Anchor.toml` (under `[programs.devnet]`)

### 5. Deploying to Mainnet

1. Configure Solana for mainnet:

```bash
solana config set --url mainnet-beta
```

2. Update `Anchor.toml`:

```toml
[provider]
cluster = "mainnet"
wallet = "/path/to/deploy/keypair.json"

[programs.mainnet]
svm_contracts = "your-program-id"
```

3. Deploy:

```bash
anchor deploy --provider.cluster mainnet
```

## Account Structures

### GlobalState

```rust
pub struct GlobalState {
    pub owner: Pubkey,
    pub paused: bool,
    pub supported_token_mints: Vec<Pubkey>,
    pub quests: Vec<String>,
}
```

### Quest

```rust
pub struct Quest {
    pub id: String,
    pub creator: Pubkey,
    pub token_mint: Pubkey,
    pub escrow_account: Pubkey,
    pub amount: u64,
    pub deadline: i64,
    pub is_active: bool,
    pub total_winners: u32,
    pub total_reward_distributed: u64,
    pub max_winners: u32,
}
```

### RewardClaimed

```rust
pub struct RewardClaimed {
    pub quest_id: String,
    pub winner: Pubkey,
    pub reward_amount: u64,
    pub claimed: bool,
}
```

## Common Issues and Solutions

1. **Program Size Error**

   - If you get "Program too large" error, try:
     - Removing unnecessary dependencies
     - Optimizing account space calculations
     - Using smaller data structures

2. **Deployment Failures**

   - Ensure you have enough SOL for deployment
   - Check program ID matches in all files
   - Verify BPF toolchain is up to date

3. **Testing Issues**
   - Reset local validator between test runs
   - Clear build artifacts: `anchor clean`
   - Update TypeScript types: `anchor build`

## Security Considerations

1. **Access Control**

   - Only contract owner can distribute rewards
   - Quest creators can only cancel their own quests
   - Winners can only claim rewards once per quest

2. **Token Safety**

   - Tokens are held in PDA escrow accounts
   - Escrow accounts are program-controlled
   - Token transfers use secure CPI calls

3. **State Management**
   - Quest state transitions are strictly controlled
   - Deadline checks prevent early withdrawals
   - Pausing mechanism for emergency stops

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests
5. Submit a pull request

## License

ISC
