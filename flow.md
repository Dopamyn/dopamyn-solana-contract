# Quest Manager Flow

## 1. Initialization
- Owner deploys contract
- Owner adds supported tokens
- Contract is ready for quest creation

## 2. Quest Creation
**Actor**: Quest Creator

1. Creator calls `createQuest(questId, token, amount, deadline, maxWinners)`
2. Creator approves token transfer to contract
3. Tokens are transferred to escrow account
4. Quest is created with:
   - `isActive = true`
   - `totalWinners = 0`
   - `totalRewardDistributed = 0`

## 3. Reward Distribution
**Actor**: Owner (Admin)

### Option A: Send Main Winner + Referrers Together
1. Owner calls `sendReward(questId, winner, mainAmount, referrerWinners[], referrerAmounts[], skipClaimedCheck)`
2. Main winner receives `mainAmount`
3. Each referrer receives corresponding amount from `referrerAmounts[]`
4. `totalRewardDistributed` increases by total amount
5. `totalWinners` increments if winner hasn't claimed before

### Option B: Send Only Referrers
1. Owner calls `sendReferrerRewards(questId, referrerWinners[], referrerAmounts[])`
2. Each referrer receives corresponding amount
3. `totalRewardDistributed` increases by total referrer amount
4. `totalWinners` does NOT increment

**Rules**:
- Quest must be active
- `totalRewardDistributed + newAmount <= quest.amount`
- Max 50 referrers per call
- Referrer arrays must match in length

## 4. Quest Management

### Cancel Quest
**Actor**: Quest Creator
1. Creator calls `cancelQuest(questId)`
2. All escrowed tokens returned to creator
3. Quest `isActive = false`

### Update Quest Status
**Actor**: Owner
1. Owner calls `updateQuestStatus(questId, isActive)`
2. Quest status updated (can activate/deactivate)

## 5. Claim Remaining Rewards
**Actor**: Quest Creator or Owner

1. Quest must be inactive (`isActive = false`)
2. Must wait 1 week after deadline
3. Creator/Owner calls `claimRemainingReward(questId)`
4. Remaining tokens (`amount - totalRewardDistributed`) sent to creator
5. Quest amount updated to prevent double claiming

## 6. Token Management
**Actor**: Owner

- `addSupportedToken(token)` - Add new supported token
- `removeSupportedToken(token)` - Remove supported token
- `pause()` / `unpause()` - Pause/unpause contract

## State Tracking

- `totalWinners`: Counts unique winners (only incremented in `sendReward`)
- `totalRewardDistributed`: Tracks all rewards sent (main + referrers)
- `hasClaimedReward`: Tracks if a winner has claimed (Base only)
- `rewardAmountClaimed`: Tracks accumulated reward per winner (Base only)

## Constraints

- Quest must be active for reward distribution
- Cannot exceed `maxWinners` limit
- Cannot exceed quest `amount` limit
- Contract must not be paused
- Only owner can distribute rewards
- Only creator can cancel quest

