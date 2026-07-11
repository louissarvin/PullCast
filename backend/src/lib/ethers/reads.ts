import { registryV3, BSC_CONTRACT_ADDRESSES, BSC_SETTLEMENT_TOKENS } from './contracts.ts';
import { BscReadError } from './errors.ts';
import { getBscProvider } from './provider.ts';
import {
  parseCheckoutSuccessEvents,
  parseTradeExecutedV2Events,
  type ParsedCheckoutEvent,
} from './calls.ts';

const LOG_PREFIX = '[bsc-read]';

/**
 * Best-effort read helpers. The MUST-NEVER-THROW contract: a missing tokenId,
 * a reverting view function, or an RPC blip all return null. Callers treat
 * null as "data unknown, fall back to the API value".
 *
 * If the caller specifically wants to know WHY a read failed, log inspection
 * is the path; we deliberately do not expose the underlying provider error to
 * avoid leaking RPC URLs into route responses.
 */

const tokenIdToBigInt = (tokenId: string): bigint => {
  // ethers v6 Contract methods accept bigint OR a decimal string. We coerce to
  // bigint explicitly so a malformed input throws here (in a typed way) rather
  // than producing a confusing provider-level error.
  if (typeof tokenId !== 'string' || tokenId.length === 0) {
    throw new BscReadError('tokenId must be a non-empty decimal string', {
      contract: 'registryV3',
      method: 'tokenIdToBigInt',
    });
  }
  if (!/^\d+$/.test(tokenId)) {
    throw new BscReadError('tokenId must be a decimal integer string', {
      contract: 'registryV3',
      method: 'tokenIdToBigInt',
    });
  }
  return BigInt(tokenId);
};

/**
 * Returns the owner of `tokenId` on Registry V3, or null if the token does
 * not exist or the read fails. Address is returned as the 0x-prefixed
 * checksum form that ethers produces; callers that compare against database
 * values should `.toLowerCase()` first.
 */
export const getOwnerOf = async (tokenId: string): Promise<string | null> => {
  try {
    const id = tokenIdToBigInt(tokenId);
    const contract = registryV3();
    const owner: unknown = await contract.ownerOf(id);
    if (typeof owner !== 'string' || owner.length === 0) {
      return null;
    }
    return owner;
  } catch (err) {
    console.warn(`${LOG_PREFIX} ownerOf failed tokenId=${tokenId} reason="${formatErr(err)}"`);
    return null;
  }
};

/**
 * Returns the tokenURI string for `tokenId`, or null on failure. Often the
 * URI is `ipfs://...` or `https://...` returning a JSON metadata blob.
 */
export const getTokenUri = async (tokenId: string): Promise<string | null> => {
  try {
    const id = tokenIdToBigInt(tokenId);
    const contract = registryV3();
    const uri: unknown = await contract.tokenURI(id);
    if (typeof uri !== 'string' || uri.length === 0) {
      return null;
    }
    return uri;
  } catch (err) {
    console.warn(`${LOG_PREFIX} tokenURI failed tokenId=${tokenId} reason="${formatErr(err)}"`);
    return null;
  }
};

/**
 * Returns Registry V3 totalSupply as bigint. Throws BscReadError if the
 * provider cannot satisfy the call. Used by the smoke test below and by the
 * D4 health endpoint to prove the BSC pipeline is live.
 *
 * Unlike the ownerOf/tokenURI helpers, this one throws on failure because
 * "no totalSupply" is a hard infrastructure issue, not a missing token.
 */
export const getRegistryTotalSupply = async (): Promise<bigint> => {
  try {
    const contract = registryV3();
    const supply: unknown = await contract.totalSupply();
    if (typeof supply !== 'bigint') {
      // ethers v6 returns bigint for uint256 outputs; defensive cast below.
      return BigInt(String(supply));
    }
    return supply;
  } catch (err) {
    throw new BscReadError('registryV3.totalSupply read failed', {
      contract: 'registryV3',
      method: 'totalSupply',
      cause: err,
    });
  }
};

/**
 * One-shot smoke test. Exported but NOT wired into routes; D4 indexer or a
 * dev script can call this to verify the BSC pipeline before adding more
 * reads. Returns a status object instead of throwing so callers can log it.
 */
export const smokeTestBscReads = async (): Promise<{
  ok: boolean;
  totalSupply?: string;
  error?: string;
}> => {
  try {
    const supply = await getRegistryTotalSupply();
    console.log(`${LOG_PREFIX} smoke test ok totalSupply=${supply.toString()}`);
    return { ok: true, totalSupply: supply.toString() };
  } catch (err) {
    const reason = formatErr(err);
    console.warn(`${LOG_PREFIX} smoke test failed reason="${reason}"`);
    return { ok: false, error: reason };
  }
};

// ---------------------------------------------------------------------------
// Event-based reads for dual-mode resilience (file 15 §6.4).
// ---------------------------------------------------------------------------

/**
 * Wrap a Promise with a wall-clock timeout. Returns null if `p` does not
 * settle before `ms` elapses. Preserves original rejection semantics if `p`
 * rejects before the timer fires.
 */
const withTimeout = <T>(p: Promise<T>, ms: number, tag: string): Promise<T | null> => {
  return new Promise<T | null>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      console.warn(`${LOG_PREFIX} ${tag} timed out after ${ms}ms`);
      resolve(null);
    }, ms);
    p.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        console.warn(`${LOG_PREFIX} ${tag} rejected: ${formatErr(err)}`);
        resolve(null);
      }
    );
  });
};

/**
 * Format a raw uint256 balance string using `decimals` places. Rounds toward
 * zero and preserves 6 significant fractional digits. Purely for display;
 * callers doing math must use the raw string / bigint form.
 *
 * `formatUsdcAmount("12345678901234567890", 18) === "12.345678"`
 */
export const formatUsdcAmount = (raw: string, decimals: number): string => {
  if (!/^\d+$/.test(raw)) return '0';
  if (decimals <= 0) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals);
  // Trim trailing zeros; keep at most 6 fractional digits for display.
  const trimmed = fracPart.replace(/0+$/, '').slice(0, 6);
  return trimmed.length > 0 ? `${intPart}.${trimmed}` : intPart;
};

/**
 * Decimals for a known BSC settlement token. Both BSC-USDC and BSC-USDT are
 * 18 (verified via `decimals()` eth_call). Returns 18 as a conservative
 * default for unknown tokens; callers with unknown paymentToken should read
 * `decimals()` on the token contract instead.
 */
export const paymentTokenDecimals = (paymentToken: string): number => {
  const lower = paymentToken.toLowerCase();
  if (lower === BSC_SETTLEMENT_TOKENS.usdc) return 18;
  if (lower === BSC_SETTLEMENT_TOKENS.usdt) return 18;
  return 18;
};

export interface LastOnChainSale {
  priceUsdc: string;
  priceUsdcFormatted: string;
  paymentToken: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  buyer: string;
  seller: string;
}

/**
 * Return the most recent Orderbook TradeExecutedV2 fill for `tokenId`, or
 * null if none is found in the last `lookbackBlocks` blocks (or the read
 * times out). Uses the `nftTokenId` indexed topic for a server-side filter
 * so no full-log scan is required.
 *
 * BSC produces ~2s blocks so 100_000 blocks covers roughly the last 2.3
 * days. Public BSC RPCs typically enforce archive-request limits beyond
 * ~128 blocks; if the primary rejects the range the FallbackProvider will
 * try the secondary. Callers that need deeper history should call the
 * Renaiss API path first and use this only as a resilience layer.
 *
 * All failures (bad tokenId, RPC down, empty result, timeout) return null.
 */
export const getLastOnChainSale = async (
  tokenId: string,
  lookbackBlocks = 100_000
): Promise<LastOnChainSale | null> => {
  if (typeof tokenId !== 'string' || !/^\d+$/.test(tokenId)) {
    return null;
  }
  const inner = async (): Promise<LastOnChainSale | null> => {
    const provider = getBscProvider();
    let latest: number;
    try {
      latest = await provider.getBlockNumber();
    } catch (err) {
      console.warn(`${LOG_PREFIX} getBlockNumber failed: ${formatErr(err)}`);
      return null;
    }
    const fromBlock = Math.max(0, latest - lookbackBlocks);

    const events = await parseTradeExecutedV2Events(fromBlock, latest, {
      tokenId,
    });
    if (events.length === 0) {
      return null;
    }
    // parseTradeExecutedV2Events returns ascending order by (blockNumber, logIndex).
    // We want the most recent, so pop the last entry.
    const last = events[events.length - 1];

    let timestamp = 0;
    try {
      const block = await provider.getBlock(last.blockNumber);
      if (block !== null) timestamp = block.timestamp;
    } catch (err) {
      console.warn(`${LOG_PREFIX} getBlock failed block=${last.blockNumber}: ${formatErr(err)}`);
    }

    const decimals = paymentTokenDecimals(last.paymentToken);

    return {
      priceUsdc: last.priceUsdc,
      priceUsdcFormatted: formatUsdcAmount(last.priceUsdc, decimals),
      paymentToken: last.paymentToken,
      txHash: last.txHash,
      blockNumber: last.blockNumber,
      timestamp,
      // In TradeExecutedV2 the `bidder` is the party PAYING (the buyer) and
      // the `asker` is the party RECEIVING payment (the seller). This
      // matches the Renaiss orderbook semantics where a bid buys an NFT and
      // an ask sells one.
      buyer: last.bidder,
      seller: last.asker,
    };
  };

  return withTimeout(inner(), 15_000, `getLastOnChainSale(${tokenId})`);
};

export interface RecentPullFallback {
  buyer: string;
  tokenId: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
  pricePaidUsdc: string;
  pricePaidFormatted: string;
  packId: string;
}

/**
 * Return recent pack pulls by cross-referencing CheckoutSuccess events on
 * the TokenVendingMachine with ERC-721 Transfer events (`from == address(0)`)
 * on Registry V3 in the same transaction. Used by the indexer worker when
 * the Renaiss main API is degraded.
 *
 * @param packContract - reserved for future filtering by contract; currently
 *   ignored because CheckoutSuccess is always emitted by the single
 *   TokenVendingMachine at `BSC_CONTRACT_ADDRESSES.tokenVendingMachine`.
 * @param lookbackBlocks - how many blocks back to scan (default 5000 = ~2.8h)
 */
export const getRecentPullsFallback = async (
  packContract: string,
  lookbackBlocks = 5000
): Promise<RecentPullFallback[]> => {
  const _packContract = packContract; // kept for future filtering
  void _packContract;

  const inner = async (): Promise<RecentPullFallback[]> => {
    const provider = getBscProvider();
    let latest: number;
    try {
      latest = await provider.getBlockNumber();
    } catch (err) {
      console.warn(`${LOG_PREFIX} getBlockNumber failed: ${formatErr(err)}`);
      return [];
    }
    const fromBlock = Math.max(0, latest - lookbackBlocks);

    const checkouts: ParsedCheckoutEvent[] = await parseCheckoutSuccessEvents(
      fromBlock,
      latest
    );
    if (checkouts.length === 0) return [];

    const results: RecentPullFallback[] = [];
    const blockTsCache = new Map<number, number>();

    for (const evt of checkouts) {
      let ts = blockTsCache.get(evt.blockNumber);
      if (ts === undefined) {
        try {
          const block = await provider.getBlock(evt.blockNumber);
          if (block === null) continue;
          ts = block.timestamp;
          blockTsCache.set(evt.blockNumber, ts);
        } catch (err) {
          console.warn(`${LOG_PREFIX} getBlock failed block=${evt.blockNumber}: ${formatErr(err)}`);
          continue;
        }
      }

      let receipt;
      try {
        receipt = await provider.getTransactionReceipt(evt.txHash);
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} getTransactionReceipt failed tx=${evt.txHash}: ${formatErr(err)}`
        );
        continue;
      }
      if (receipt === null) continue;

      const zeroTopic = '0x' + '00'.repeat(32);
      const buyerTopic = '0x' + '0'.repeat(24) + evt.buyer.replace(/^0x/, '').toLowerCase();
      const registryAddr = BSC_CONTRACT_ADDRESSES.registryV3.toLowerCase();

      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== registryAddr) continue;
        if (log.topics.length !== 4) continue;
        if (log.topics[0] !== '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
          continue;
        }
        if (log.topics[1] !== zeroTopic) continue;
        if (log.topics[2] !== buyerTopic) continue;
        const tokenId = BigInt(log.topics[3]).toString();
        results.push({
          buyer: evt.buyer,
          tokenId,
          txHash: evt.txHash,
          blockNumber: evt.blockNumber,
          timestamp: ts,
          pricePaidUsdc: evt.pricePaidUsdc,
          pricePaidFormatted: formatUsdcAmount(evt.pricePaidUsdc, 18),
          packId: evt.packId,
        });
      }
    }

    return results;
  };

  const out = await withTimeout(inner(), 15_000, 'getRecentPullsFallback');
  return out ?? [];
};

const formatErr = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
};
