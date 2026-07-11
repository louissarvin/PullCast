import { Contract } from 'ethers';
import { getBscProvider } from './provider.ts';
import registryV3Abi from './abi/registry-v3.json' with { type: 'json' };
import tvmAbi from './abi/tvm.json' with { type: 'json' };
import orderbookAbi from './abi/orderbook.json' with { type: 'json' };

/**
 * BSC mainnet contract addresses for the Renaiss stack.
 * Source: /Users/macbookair/Documents/pullcast/10_final_implementation_spec.md Section 1.
 *
 * Verified event ABIs pulled from the BscScan-verified source at:
 *  - RegistryV3 proxy   0xF8646A3Ca093e97Bb404c3b25e675C0394DD5b30
 *    -> impl (source)   https://bscscan.com/address/0xee4f1FCfa8f9934c788f1a5e94b7cc20cbf57440#code
 *  - Orderbook          https://bscscan.com/address/0xdb44a7c5598855b78e4f41552c11acc9d0a5892a#code
 *  - TokenVendingMachine https://bscscan.com/address/0x9215503e1e14ce0a16dad63d144687ba79485bd7#code
 *
 * Confirmed event topics (keccak256 of the canonical signature):
 *  - CheckoutSuccess(address,bytes32,bytes32,uint256)
 *      = 0xd505514c5f9bb134a66621a7fd46a679442a1a0e45f5ad5dff0724e4b4588fed
 *      (also cross-verified via 4byte.directory id=274384)
 *  - BuybackSuccessV3(address,bytes32,address,uint256,uint256)
 *      = 0x3a50fc956257733436af07a2199cd0ea917826d1f0cb6f639800ebb7912d9888
 *      (cross-verified via 4byte.directory id=274383)
 *  - TradeExecutedV2(address,address,uint256,address,uint256,bytes,uint256,bytes32,bytes32)
 *      = 0x89dace909271d76078ac99dcc8a24e8d911d0cf6f005a2dfc17c82492ae7640e
 *  - Transfer(address,address,uint256)  (ERC-721 standard)
 *      = 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
 *
 * Note the discovered event shapes differ from earlier internal guesses:
 *  - CheckoutSuccess carries a `packId` (bytes32) but NO tokenId. Resolving
 *    the actual minted tokenId requires cross-referencing the Registry V3
 *    Transfer events in the same transaction (see `getRecentPullsFallback`
 *    in `reads.ts`).
 *  - TradeExecutedV2 uses `bidder`/`asker` (not taker/maker) and the payment
 *    token is emitted as `erc20Token` in the data payload, so we do NOT need
 *    to hardcode USDC to decode the event.
 */
export const BSC_CONTRACT_ADDRESSES = {
  registryV3: '0xF8646A3Ca093e97Bb404c3b25e675C0394DD5b30',
  tokenVendingMachine: '0x9215503e1e14ce0a16dad63d144687ba79485bd7',
  orderbook: '0xdb44a7c5598855b78e4f41552c11acc9d0a5892a',
} as const;

/**
 * BSC ERC-20 stablecoins used to settle Renaiss trades. BOTH are 18 decimals
 * on BSC (verified via `decimals()` eth_call on 2026-07-02):
 *  - Binance-Peg USDC 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d -> 0x12 (18)
 *  - Binance-Peg USDT 0x55d398326f99059fF775485246999027B3197955 -> 0x12 (18)
 *
 * This is different from Ethereum-native USDC (6 decimals). Downstream code
 * that formats `amount` from TradeExecutedV2 / CheckoutSuccess MUST use 18
 * decimals for these tokens, and fall back to reading `decimals()` for any
 * other `erc20Token` address that appears in the event data.
 *
 * Addresses are lowercased to match ethers `getAddress` output when compared.
 */
export const BSC_SETTLEMENT_TOKENS = {
  usdc: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
  usdt: '0x55d398326f99059ff775485246999027b3197955',
} as const;

/**
 * Read-only handle for the Renaiss Registry V3 (the ERC721 collectible).
 * Caller gets a fresh Contract instance bound to the cached FallbackProvider.
 */
export const registryV3 = (): Contract => {
  return new Contract(BSC_CONTRACT_ADDRESSES.registryV3, registryV3Abi, getBscProvider());
};

/**
 * Read-only handle for the Renaiss Token Vending Machine (pack purchases +
 * mints). `CheckoutSuccess` is the indexer's on-chain ground truth when the
 * public API recentOpenedPacks window has rolled past a pull.
 */
export const tokenVendingMachine = (): Contract => {
  return new Contract(BSC_CONTRACT_ADDRESSES.tokenVendingMachine, tvmAbi, getBscProvider());
};

/**
 * Read-only handle for the Renaiss orderbook. `TradeExecutedV2` is the
 * canonical fill event; indexed topics let us filter by bidder, asker, or
 * nftTokenId directly through eth_getLogs.
 */
export const orderbook = (): Contract => {
  return new Contract(BSC_CONTRACT_ADDRESSES.orderbook, orderbookAbi, getBscProvider());
};
