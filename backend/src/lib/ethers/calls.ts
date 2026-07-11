/**
 * Ethers fallback indexer path.
 *
 * Purpose: on-chain read layer for the dual-mode architecture in file 15 §6.4.
 * PRIMARY data source is the Renaiss main API (`api.renaiss.xyz/v0`); this
 * module is the FALLBACK that reads events directly from BSC when the API is
 * degraded, and also powers the `lastSaleOnChain` field on `/api/price/token/*`
 * so responses can show a verifiable on-chain price alongside FMV.
 *
 * Verified event signatures (see `./contracts.ts` for BscScan source links):
 *  - TokenVendingMachine.CheckoutSuccess(address caller, bytes32 packId,
 *      bytes32 checkoutMessageHash, uint256 amount)
 *      topic0 = 0xd505514c5f9bb134a66621a7fd46a679442a1a0e45f5ad5dff0724e4b4588fed
 *
 *  - Orderbook.TradeExecutedV2(address bidder, address asker, uint256 nftTokenId,
 *      address erc20Token, uint256 amount, bytes tradeSignature,
 *      uint256 feeAccrued, bytes32 bidDigest, bytes32 askId)
 *      topic0 = 0x89dace909271d76078ac99dcc8a24e8d911d0cf6f005a2dfc17c82492ae7640e
 *
 * IMPORTANT: `CheckoutSuccess` does NOT emit a tokenId. The pack mint produces
 * one or more ERC-721 Transfer events in the same transaction from address(0)
 * to the buyer. Callers that need actual pulled tokenIds must reconcile
 * CheckoutSuccess with Transfer receipts in the same tx (see
 * `getRecentPullsFallback` in `reads.ts`).
 *
 * All parsers here follow the MUST-NEVER-THROW contract: any RPC error,
 * missing log, or malformed decode returns an empty array. The indexer treats
 * an empty result the same as "no new activity" and waits for the next tick.
 */

import { Contract, Interface, type EventLog, type Log } from 'ethers';

import { getBscProvider } from './provider.ts';
import { BSC_CONTRACT_ADDRESSES } from './contracts.ts';
import tvmAbi from './abi/tvm.json' with { type: 'json' };
import orderbookAbi from './abi/orderbook.json' with { type: 'json' };

const LOG_PREFIX = '[bsc-read]';

/** keccak256("CheckoutSuccess(address,bytes32,bytes32,uint256)") */
export const TOPIC_CHECKOUT_SUCCESS =
  '0xd505514c5f9bb134a66621a7fd46a679442a1a0e45f5ad5dff0724e4b4588fed';

/** keccak256("TradeExecutedV2(address,address,uint256,address,uint256,bytes,uint256,bytes32,bytes32)") */
export const TOPIC_TRADE_EXECUTED_V2 =
  '0x89dace909271d76078ac99dcc8a24e8d911d0cf6f005a2dfc17c82492ae7640e';

/** keccak256("Transfer(address,address,uint256)") - ERC-721 standard */
export const TOPIC_TRANSFER =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ---------------------------------------------------------------------------
// CheckoutSuccess
// ---------------------------------------------------------------------------

/**
 * Parsed CheckoutSuccess event. `amount` and `pricePaidUsdc` are both the
 * raw uint256 from the `amount` field, kept as decimal string to preserve
 * precision past 2^53. BSC-USDC / BSC-USDT are 18 decimals, so a 12 USDC
 * checkout would surface as "12000000000000000000".
 */
export interface ParsedCheckoutEvent {
  txHash: string;
  blockNumber: number;
  logIndex: number;
  buyer: string;
  packId: string;
  checkoutMessageHash: string;
  pricePaidUsdc: string;
  quantity: number;
}

export interface ParseRecentCheckoutEventsOpts {
  fromBlock: number;
  toBlock: number | 'latest';
  // Reserved for parity with the API path. Unused because CheckoutSuccess
  // emits a bytes32 packId hash, not a slug; callers that need a slug filter
  // must resolve packId -> slug from the app's pack registry.
  packSlugFilter?: string[];
}

/**
 * Legacy wrapper kept for backwards compatibility with `src/workers/indexer.ts`.
 * Prefer `parseCheckoutSuccessEvents` for new call sites; this thin adapter
 * converts to the older `ParsedCheckoutEvent` layout the indexer imported.
 */
export const parseRecentCheckoutEvents = async (
  opts: ParseRecentCheckoutEventsOpts
): Promise<
  Array<{
    txHash: string;
    blockNumber: number;
    tokenId: string;
    buyer: string;
    timestamp: Date;
  }>
> => {
  if (
    typeof opts.fromBlock !== 'number' ||
    !Number.isFinite(opts.fromBlock) ||
    opts.fromBlock < 0
  ) {
    console.warn(`${LOG_PREFIX} parseRecentCheckoutEvents invalid fromBlock=${opts.fromBlock}`);
    return [];
  }

  if (Array.isArray(opts.packSlugFilter) && opts.packSlugFilter.length > 0) {
    console.log(
      `${LOG_PREFIX} parseRecentCheckoutEvents packSlugFilter ignored (event has bytes32 packId, not slug) count=${opts.packSlugFilter.length}`
    );
  }

  const events = await parseCheckoutSuccessEvents(opts.fromBlock, opts.toBlock);
  if (events.length === 0) {
    return [];
  }

  // CheckoutSuccess has no tokenId. For each event, we reconcile the pulled
  // tokenId by scanning ERC-721 Transfer logs in the same transaction with
  // `from == address(0)` and `to == buyer`. That work is done here so the
  // legacy indexer worker path continues to receive a `tokenId` field.
  const provider = getBscProvider();
  const results: Array<{
    txHash: string;
    blockNumber: number;
    tokenId: string;
    buyer: string;
    timestamp: Date;
  }> = [];

  // Cache block timestamps to avoid re-fetching per event in the same block.
  const blockTsCache = new Map<number, number>();

  for (const evt of events) {
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
      console.warn(`${LOG_PREFIX} getTransactionReceipt failed tx=${evt.txHash}: ${formatErr(err)}`);
      continue;
    }
    if (receipt === null) continue;

    const zeroTopic = '0x' + '00'.repeat(32);
    const buyerTopic = '0x' + '0'.repeat(24) + evt.buyer.replace(/^0x/, '').toLowerCase();

    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() !== BSC_CONTRACT_ADDRESSES.registryV3.toLowerCase()
      ) {
        continue;
      }
      if (log.topics.length !== 4) continue;
      if (log.topics[0] !== TOPIC_TRANSFER) continue;
      if (log.topics[1] !== zeroTopic) continue;
      if (log.topics[2] !== buyerTopic) continue;
      const tokenId = BigInt(log.topics[3]).toString();
      results.push({
        txHash: evt.txHash,
        blockNumber: evt.blockNumber,
        tokenId,
        buyer: evt.buyer,
        timestamp: new Date(ts * 1000),
      });
    }
  }

  return results;
};

/**
 * Query CheckoutSuccess logs from the TokenVendingMachine and decode them
 * into structured records. Returns [] on any RPC failure.
 *
 * @param fromBlock  inclusive start block
 * @param toBlock    inclusive end block or 'latest'
 * @param filter     optional narrowing on the indexed topics
 */
export const parseCheckoutSuccessEvents = async (
  fromBlock: number,
  toBlock: number | 'latest' = 'latest',
  filter?: { buyer?: string; packId?: string }
): Promise<ParsedCheckoutEvent[]> => {
  if (
    typeof fromBlock !== 'number' ||
    !Number.isFinite(fromBlock) ||
    fromBlock < 0
  ) {
    console.warn(`${LOG_PREFIX} parseCheckoutSuccessEvents invalid fromBlock=${fromBlock}`);
    return [];
  }

  const provider = getBscProvider();
  const tvm = new Contract(BSC_CONTRACT_ADDRESSES.tokenVendingMachine, tvmAbi, provider);

  // Build the topics filter. topic0 is CheckoutSuccess; topic1 is buyer;
  // topic2 is packId. Undefined topics act as wildcards.
  const topics: Array<string | null> = [TOPIC_CHECKOUT_SUCCESS];
  if (filter?.buyer !== undefined) {
    topics.push(padAddressToTopic(filter.buyer));
  } else {
    topics.push(null);
  }
  if (filter?.packId !== undefined) {
    topics.push(normalizeBytes32Topic(filter.packId));
  }

  let rawLogs: Array<Log | EventLog>;
  try {
    rawLogs = (await tvm.queryFilter(
      { topics } as unknown as string,
      fromBlock,
      toBlock
    )) as Array<Log | EventLog>;
  } catch (err) {
    console.warn(`${LOG_PREFIX} queryFilter CheckoutSuccess failed: ${formatErr(err)}`);
    return [];
  }

  const iface = new Interface(tvmAbi);
  const parsed: ParsedCheckoutEvent[] = [];

  for (const log of rawLogs) {
    try {
      const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (decoded === null || decoded.name !== 'CheckoutSuccess') continue;
      const args = decoded.args;
      const buyer = String(args.getValue('caller')).toLowerCase();
      const packId = String(args.getValue('packId'));
      const messageHash = String(args.getValue('checkoutMessageHash'));
      const amount = args.getValue('amount') as bigint;
      parsed.push({
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.index,
        buyer,
        packId,
        checkoutMessageHash: messageHash,
        pricePaidUsdc: amount.toString(),
        // CheckoutSuccess encodes a single checkout call. The unit-count of
        // packs bought inside that call is not on the event; we surface 1 as
        // the default and callers who need the true count can decode the tx
        // input or count Registry Transfer logs in the receipt.
        quantity: 1,
      });
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} CheckoutSuccess decode failed tx=${log.transactionHash}: ${formatErr(err)}`
      );
      continue;
    }
  }

  return parsed;
};

// ---------------------------------------------------------------------------
// TradeExecutedV2
// ---------------------------------------------------------------------------

/**
 * Parsed TradeExecutedV2 event. `priceUsdc` is the raw `amount` uint256 as a
 * decimal string; BSC-USDC / BSC-USDT are both 18 decimals (verified via
 * `decimals()` on 2026-07-02). Callers formatting for display should read
 * `paymentToken` and consult `BSC_SETTLEMENT_TOKENS` before assuming 18.
 */
export interface ParsedTradeExecutedEvent {
  txHash: string;
  blockNumber: number;
  logIndex: number;
  tokenId: string;
  bidder: string;
  asker: string;
  paymentToken: string;
  priceUsdc: string;
  feeAccrued: string;
  bidDigest: string;
  askId: string;
}

export const parseTradeExecutedV2Events = async (
  fromBlock: number,
  toBlock: number | 'latest' = 'latest',
  filter?: { bidder?: string; asker?: string; tokenId?: string | bigint }
): Promise<ParsedTradeExecutedEvent[]> => {
  if (
    typeof fromBlock !== 'number' ||
    !Number.isFinite(fromBlock) ||
    fromBlock < 0
  ) {
    console.warn(`${LOG_PREFIX} parseTradeExecutedV2Events invalid fromBlock=${fromBlock}`);
    return [];
  }

  const provider = getBscProvider();
  const ob = new Contract(BSC_CONTRACT_ADDRESSES.orderbook, orderbookAbi, provider);

  const topics: Array<string | null> = [TOPIC_TRADE_EXECUTED_V2];
  topics.push(filter?.bidder !== undefined ? padAddressToTopic(filter.bidder) : null);
  topics.push(filter?.asker !== undefined ? padAddressToTopic(filter.asker) : null);
  if (filter?.tokenId !== undefined) {
    topics.push(padUint256ToTopic(filter.tokenId));
  }

  let rawLogs: Array<Log | EventLog>;
  try {
    rawLogs = (await ob.queryFilter(
      { topics } as unknown as string,
      fromBlock,
      toBlock
    )) as Array<Log | EventLog>;
  } catch (err) {
    console.warn(`${LOG_PREFIX} queryFilter TradeExecutedV2 failed: ${formatErr(err)}`);
    return [];
  }

  const iface = new Interface(orderbookAbi);
  const parsed: ParsedTradeExecutedEvent[] = [];

  for (const log of rawLogs) {
    try {
      const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (decoded === null || decoded.name !== 'TradeExecutedV2') continue;
      const args = decoded.args;
      parsed.push({
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.index,
        tokenId: (args.getValue('nftTokenId') as bigint).toString(),
        bidder: String(args.getValue('bidder')).toLowerCase(),
        asker: String(args.getValue('asker')).toLowerCase(),
        paymentToken: String(args.getValue('erc20Token')).toLowerCase(),
        priceUsdc: (args.getValue('amount') as bigint).toString(),
        feeAccrued: (args.getValue('feeAccrued') as bigint).toString(),
        bidDigest: String(args.getValue('bidDigest')),
        askId: String(args.getValue('askId')),
      });
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} TradeExecutedV2 decode failed tx=${log.transactionHash}: ${formatErr(err)}`
      );
      continue;
    }
  }

  return parsed;
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const padAddressToTopic = (addr: string): string => {
  const stripped = addr.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(stripped)) {
    throw new Error(`invalid address for topic filter: ${addr}`);
  }
  return '0x' + '0'.repeat(24) + stripped;
};

const padUint256ToTopic = (v: string | bigint): string => {
  const big = typeof v === 'bigint' ? v : BigInt(v);
  const hex = big.toString(16);
  if (hex.length > 64) {
    throw new Error(`uint256 topic overflow: ${v}`);
  }
  return '0x' + '0'.repeat(64 - hex.length) + hex;
};

const normalizeBytes32Topic = (v: string): string => {
  const stripped = v.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(stripped)) {
    throw new Error(`invalid bytes32 for topic filter: ${v}`);
  }
  return '0x' + stripped;
};

const formatErr = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
};
