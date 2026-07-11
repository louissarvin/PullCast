import { FallbackProvider, JsonRpcProvider, Network } from 'ethers';
import {
  BSC_CHAIN_ID,
  BSC_RPC_FALLBACK,
  BSC_RPC_PRIMARY,
} from '../../config/main-config.ts';
import { redactUrlForLog } from '../../utils/urlAllowlist.ts';

const LOG_PREFIX = '[bsc-read]';

/**
 * Per-provider stall timeout, in ms. If the primary takes longer than this to
 * respond the FallbackProvider activates the next provider in priority order.
 *
 * 6000 ms matches the indexer poll cadence floor; anything longer would let a
 * stuck provider eat a whole tick.
 */
const STALL_TIMEOUT_MS = 6000;

let cached: FallbackProvider | null = null;

/**
 * Construct (or return cached) read-only BSC FallbackProvider with primary +
 * fallback failover. Quorum=1 because we are read-only and any healthy peer is
 * sufficient; weighting both at 1 keeps the load balanced when both respond.
 *
 * Chain explicitly pinned (chainId 56, name `bnb`) so ethers does not waste a
 * network roundtrip auto-detecting on first call.
 */
export const getBscProvider = (): FallbackProvider => {
  if (cached !== null) {
    return cached;
  }

  // Build the static Network once so both inner providers skip chain detection.
  const network = new Network('bnb', BSC_CHAIN_ID);

  const primary = new JsonRpcProvider(BSC_RPC_PRIMARY, network, {
    staticNetwork: network,
  });
  const fallback = new JsonRpcProvider(BSC_RPC_FALLBACK, network, {
    staticNetwork: network,
  });

  cached = new FallbackProvider(
    [
      { provider: primary, priority: 1, weight: 1, stallTimeout: STALL_TIMEOUT_MS },
      { provider: fallback, priority: 2, weight: 1, stallTimeout: STALL_TIMEOUT_MS },
    ],
    network,
    { quorum: 1 }
  );

  // D8-M-7: never log the full RPC URL. Paid providers (Ankr, QuickNode,
  // Alchemy) embed the API key in the pathname, and log-aggregation SaaS
  // ingests every console line — a leaked key here would grant an attacker
  // free hits on our paid tier. `redactUrlForLog` keeps the host so operators
  // can still see which upstream is active while dropping the path + query.
  console.log(
    `${LOG_PREFIX} provider initialized chainId=${BSC_CHAIN_ID} primary=${redactUrlForLog(BSC_RPC_PRIMARY)} fallback=${redactUrlForLog(BSC_RPC_FALLBACK)}`
  );

  return cached;
};

/**
 * Test seam: reset the cached provider. Only used in unit tests; production
 * code should never call this.
 */
export const __resetBscProviderForTests = (): void => {
  cached = null;
};
