import { type Address, createPublicClient, GetContractEventsParameters, http } from 'viem'
import { sendEarnAbi, sendEarnFactoryAbi } from './generated'
import { base } from 'viem/chains'
import dotenv from 'dotenv';
dotenv.config();

const SEND_EARN_FACTORY = '0xC4b42349E919e6c66B57d4832B20029b3D0f79Bd'
const START_BLOCK = 28928370n;

const BASE_RPC_URL = process.env.BASE_RPC_URL ?? base.rpcUrls.default.http[0]

const baseMainnet: typeof base = {
  ...base,
  rpcUrls: {
    default: { http: [BASE_RPC_URL] }
  },
} as typeof base

export const baseMainnetClient = createPublicClient({
  chain: baseMainnet,
  transport: http(baseMainnet.rpcUrls.default.http[0]),
})

const createSendEarnEvent = sendEarnFactoryAbi.find(
  (x) => x.type === 'event' && x.name === 'CreateSendEarn'
);

type VaultCache = {
  address: Address;
  vault: Address;
  balance: bigint;
};

type CacheConfig = {
  lastUpdated: number;
  latestBlock: bigint;
}

let vaultCache: Map<string, VaultCache> = new Map();

let cacheConfig: CacheConfig = {
  lastUpdated: 0,
  latestBlock: START_BLOCK,
};

export const EARN_CACHE_DURATION = 1000 * 60 * 60; // 1 hour

export async function cacheEarnFactoryEvents() {
  try {
    if (!createSendEarnEvent) {
      throw new Error('CreateSendEarn event abi not found');
    }
    const currentBlock = await baseMainnetClient.getBlockNumber();
    const fromBlock = cacheConfig.latestBlock;
    const BATCH_SIZE = 499n;

    // Create batches
    const batches: GetContractEventsParameters<
      typeof sendEarnFactoryAbi,
      'CreateSendEarn'
    >[] = [];
    let currentBatchBlock = fromBlock;
    while (currentBatchBlock <= currentBlock) {
      const endBlock = currentBatchBlock + BATCH_SIZE > currentBlock
        ? currentBlock
        : currentBatchBlock + BATCH_SIZE;

      batches.push({
        address: SEND_EARN_FACTORY,
        abi: sendEarnFactoryAbi,
        eventName: 'CreateSendEarn',
        fromBlock: currentBatchBlock,
        toBlock: endBlock
      });

      currentBatchBlock += BATCH_SIZE + 1n;
    }

    console.log(`Cacheing ${batches.length} earn factory event batches`);


    // Create and execute promises immediately
    const promises = batches.map(batch => {
      const promise = (async () => {
        let attempt = 0;
        const maxAttempts = 5;

        while (attempt < maxAttempts) {
          try {
            const events = await baseMainnetClient.getContractEvents(batch);
            attempt = 0
            return events;
          } catch (error: any) {
            if (error?.code === 429 && attempt < maxAttempts - 1) {
              const backoffMs = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 1000, 64000);
              await new Promise(resolve => setTimeout(resolve, backoffMs));
              attempt++;
            } else {
              throw error;
            }
          }
        }
        throw new Error('Max retry attempts reached');
      })();
      return promise; // Return the executing promise
    });

    const results = await Promise.all(promises);

    // Process all events
    results.flat().forEach(event => {
      const caller = event.args.caller;
      const vault = event.args.vault;
      if (!!caller && !!vault) {
        vaultCache.set(caller.toLowerCase(), {
          address: caller,
          vault,
          balance: 0n,
        });
      }
    });

    cacheConfig = {
      ...cacheConfig,
      latestBlock: currentBlock,
      lastUpdated: Date.now()
    };

    await updateVaultBalances();

    console.log(`Initialized cache with ${vaultCache.size} vaults up to block ${currentBlock}`);
  } catch (error) {
    console.error('Error initializing vault cache:', error);
  }
}

export async function updateVaultBalances() {
  try {
    const vaultEntries = Array.from(vaultCache.values());
    console.log(`Updating ${vaultEntries.length} vaults`);

    const maxWithdrawCalls = vaultEntries.map(entry => ({
      address: entry.vault,
      abi: sendEarnAbi,
      functionName: 'maxWithdraw',
      args: [entry.address],
    } as const));

    // Split into batches of 20
    const batchSize = 20;
    const batches = Array.from(
      { length: Math.ceil(maxWithdrawCalls.length / batchSize) },
      (_, i) => maxWithdrawCalls.slice(i * batchSize, (i + 1) * batchSize)
    );

    // Process all batches in parallel
    let completed = 0;
    const results = await Promise.all(
      batches.map(async (batch, batchIndex) => {
        const balances = await baseMainnetClient.multicall({
          contracts: batch,
          allowFailure: true,
        });

        completed++;
        console.log(`Progress: ${completed}/${batches.length}`);

        // Update cache for this batch
        balances.forEach((result, index) => {
          const entry = vaultEntries[batchIndex * batchSize + index];
          if (result.result !== undefined) {
            vaultCache.set(entry.address.toLowerCase(), {
              ...entry,
              balance: result.result as bigint,
            });
          }
        });

        return balances;
      })
    );

    cacheConfig = {
      ...cacheConfig,
      lastUpdated: Date.now()
    };

    console.log(`Updated balances for ${vaultEntries.length} vaults`);
  } catch (error) {
    console.error('Error updating balances:', error);
  }
}
export const getVaultBalance = (address: Address): bigint | null => {
  const cached = vaultCache.get(address.toLowerCase());
  if (!cached) return null;
  return cached.balance;
}

export const getCacheConfig = () => ({ ...cacheConfig });


