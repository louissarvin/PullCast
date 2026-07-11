/**
 * Ethers on-chain parser tests. Verify that the ABI + decode path in
 * `src/lib/ethers/*` correctly round-trips real event log payloads captured
 * from the BscScan-verified contracts.
 *
 * We test the pure Interface.parseLog surface here (rather than mocking the
 * FallbackProvider) because that is the actual failure mode we care about:
 * if the ABI drifts from the deployed contract, decoding will throw or
 * produce wrong values. Provider-side failures return null by contract and
 * are covered by the timeout/no-logs cases below.
 *
 * The imports from `src/lib/ethers/reads.ts` transitively touch
 * `src/config/main-config.ts` which requires several env vars at module
 * load. We populate placeholders here before the dynamic import so the test
 * runs in a clean shell (no .env needed).
 */

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? 'test-token';
process.env.DISCORD_APP_ID = process.env.DISCORD_APP_ID ?? 'test-app';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY ?? 'test-key-groq-must-exceed-twenty-chars';

import { describe, test, expect, beforeAll } from 'bun:test';
import { Interface } from 'ethers';

import checkoutFixture from './fixtures/ethers/checkout-success.json' with { type: 'json' };
import tradeFixture from './fixtures/ethers/trade-executed-v2.json' with { type: 'json' };

import tvmAbi from '../src/lib/ethers/abi/tvm.json' with { type: 'json' };
import orderbookAbi from '../src/lib/ethers/abi/orderbook.json' with { type: 'json' };
import registryAbi from '../src/lib/ethers/abi/registry-v3.json' with { type: 'json' };

// Lazy imports so main-config runs after env vars are set above.
let TOPIC_CHECKOUT_SUCCESS: string;
let TOPIC_TRADE_EXECUTED_V2: string;
let TOPIC_TRANSFER: string;
let formatUsdcAmount: (raw: string, decimals: number) => string;
let paymentTokenDecimals: (paymentToken: string) => number;
let getLastOnChainSale: (tokenId: string, lookbackBlocks?: number) => Promise<unknown>;
let BSC_SETTLEMENT_TOKENS: { usdc: string; usdt: string };

beforeAll(async () => {
  const calls = await import('../src/lib/ethers/calls.ts');
  const reads = await import('../src/lib/ethers/reads.ts');
  const contracts = await import('../src/lib/ethers/contracts.ts');
  TOPIC_CHECKOUT_SUCCESS = calls.TOPIC_CHECKOUT_SUCCESS;
  TOPIC_TRADE_EXECUTED_V2 = calls.TOPIC_TRADE_EXECUTED_V2;
  TOPIC_TRANSFER = calls.TOPIC_TRANSFER;
  formatUsdcAmount = reads.formatUsdcAmount;
  paymentTokenDecimals = reads.paymentTokenDecimals;
  getLastOnChainSale = reads.getLastOnChainSale as typeof getLastOnChainSale;
  BSC_SETTLEMENT_TOKENS = contracts.BSC_SETTLEMENT_TOKENS;
});

describe('event topic constants', () => {
  test('CheckoutSuccess topic matches BscScan-verified signature', () => {
    expect(TOPIC_CHECKOUT_SUCCESS).toBe(
      '0xd505514c5f9bb134a66621a7fd46a679442a1a0e45f5ad5dff0724e4b4588fed'
    );
  });

  test('TradeExecutedV2 topic matches BscScan-verified signature', () => {
    expect(TOPIC_TRADE_EXECUTED_V2).toBe(
      '0x89dace909271d76078ac99dcc8a24e8d911d0cf6f005a2dfc17c82492ae7640e'
    );
  });

  test('Transfer topic matches ERC-721 standard', () => {
    expect(TOPIC_TRANSFER).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    );
  });
});

describe('CheckoutSuccess ABI decode', () => {
  const iface = new Interface(tvmAbi);
  const log = checkoutFixture.log;
  const expected = checkoutFixture.expected;

  test('topic0 in fixture matches keccak256 of the canonical signature', () => {
    expect(log.topics[0]).toBe(
      '0xd505514c5f9bb134a66621a7fd46a679442a1a0e45f5ad5dff0724e4b4588fed'
    );
  });

  test('Interface.parseLog decodes fixture successfully', () => {
    const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe('CheckoutSuccess');
  });

  test('decoded caller (buyer) matches expected', () => {
    const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
    expect(String(decoded!.args.getValue('caller')).toLowerCase()).toBe(expected.buyer);
  });

  test('decoded packId is preserved as bytes32', () => {
    const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
    expect(decoded!.args.getValue('packId')).toBe(expected.packId);
  });

  test('decoded amount matches expected raw uint256', () => {
    const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
    const amt = decoded!.args.getValue('amount') as bigint;
    expect(amt.toString()).toBe(expected.pricePaidUsdc);
  });

  test('formatUsdcAmount at 18 decimals matches expected display', () => {
    const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
    const amt = (decoded!.args.getValue('amount') as bigint).toString();
    expect(formatUsdcAmount(amt, 18)).toBe(expected.pricePaidFormatted);
  });
});

describe('TradeExecutedV2 ABI decode', () => {
  const iface = new Interface(orderbookAbi);
  const log = tradeFixture.log;
  const expected = tradeFixture.expected;

  test('topic0 in fixture matches keccak256 of the canonical signature', () => {
    expect(log.topics[0]).toBe(
      '0x89dace909271d76078ac99dcc8a24e8d911d0cf6f005a2dfc17c82492ae7640e'
    );
  });

  test('Interface.parseLog decodes fixture successfully', () => {
    const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
    expect(decoded).not.toBeNull();
    expect(decoded!.name).toBe('TradeExecutedV2');
  });

  test('bidder / asker / nftTokenId indexed fields decode correctly', () => {
    const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
    expect(String(decoded!.args.getValue('bidder')).toLowerCase()).toBe(expected.bidder);
    expect(String(decoded!.args.getValue('asker')).toLowerCase()).toBe(expected.asker);
    expect((decoded!.args.getValue('nftTokenId') as bigint).toString()).toBe(expected.tokenId);
  });

  test('erc20Token (payment token) decodes to BSC-USDC', () => {
    const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
    expect(String(decoded!.args.getValue('erc20Token')).toLowerCase()).toBe(
      expected.paymentToken
    );
    expect(expected.paymentToken).toBe(BSC_SETTLEMENT_TOKENS.usdc);
  });

  test('amount decodes to raw 18-decimal uint256', () => {
    const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
    const amt = decoded!.args.getValue('amount') as bigint;
    expect(amt.toString()).toBe(expected.priceUsdc);
  });

  test('feeAccrued decodes to expected uint256', () => {
    const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
    expect((decoded!.args.getValue('feeAccrued') as bigint).toString()).toBe(
      expected.feeAccrued
    );
  });

  test('bidDigest and askId preserved as bytes32', () => {
    const decoded = iface.parseLog({ topics: [...log.topics], data: log.data });
    expect(decoded!.args.getValue('bidDigest')).toBe(expected.bidDigest);
    expect(decoded!.args.getValue('askId')).toBe(expected.askId);
  });
});

describe('Registry V3 Transfer ABI', () => {
  test('Interface builds without error and Transfer event topic hash matches', () => {
    const iface = new Interface(registryAbi);
    const frag = iface.getEvent('Transfer');
    expect(frag).not.toBeNull();
    expect(frag!.topicHash).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    );
  });
});

describe('formatUsdcAmount (18-decimal display helper)', () => {
  test('formats 1 USDC (18 decimals) as "1"', () => {
    expect(formatUsdcAmount('1000000000000000000', 18)).toBe('1');
  });

  test('formats 12.345678 USDC correctly', () => {
    expect(formatUsdcAmount('12345678000000000000', 18)).toBe('12.345678');
  });

  test('truncates to 6 significant fractional digits', () => {
    expect(formatUsdcAmount('1123456789000000000', 18)).toBe('1.123456');
  });

  test('sub-1 amounts pad the integer part with 0', () => {
    expect(formatUsdcAmount('500000000000000000', 18)).toBe('0.5');
  });

  test('zero raw value returns "0"', () => {
    expect(formatUsdcAmount('0', 18)).toBe('0');
  });

  test('rejects garbage input by returning "0"', () => {
    expect(formatUsdcAmount('not-a-number', 18)).toBe('0');
  });
});

describe('paymentTokenDecimals', () => {
  test('BSC-USDC returns 18', () => {
    expect(paymentTokenDecimals(BSC_SETTLEMENT_TOKENS.usdc)).toBe(18);
    expect(paymentTokenDecimals(BSC_SETTLEMENT_TOKENS.usdc.toUpperCase())).toBe(18);
  });

  test('BSC-USDT returns 18', () => {
    expect(paymentTokenDecimals(BSC_SETTLEMENT_TOKENS.usdt)).toBe(18);
  });

  test('unknown token defaults to 18 (BSC settlement convention)', () => {
    expect(paymentTokenDecimals('0x0000000000000000000000000000000000000001')).toBe(18);
  });
});

describe('getLastOnChainSale contract', () => {
  test('malformed tokenId returns null without hitting the provider', async () => {
    const result = await Promise.race([
      getLastOnChainSale('not-a-tokenId'),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1000)),
    ]);
    expect(result).toBeNull();
  });

  test('empty string tokenId returns null', async () => {
    const result = await Promise.race([
      getLastOnChainSale(''),
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1000)),
    ]);
    expect(result).toBeNull();
  });
});
