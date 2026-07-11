/**
 * Static grounding corpus for /explain + /listing.
 *
 * Every entry cites a real, publicly-reachable URL. Content was fetched via
 * WebFetch on 2026-07-02 from:
 *   - Renaiss Medium archive (medium.com/@renaissxyz)
 *   - Approved industry coverage (cryptobriefing.com, mpost.io)
 *   - Renaiss OpenAPI specs (api.renaiss.xyz, api.renaissos.com)
 *
 * Chunk shape (~500 tokens, 1800-2200 chars, 50-token overlap between sibling
 * chunks of the same document). Chunks are ordered by source, chunkIndex so
 * the retriever surfaces the earliest-matching passage first when scores tie.
 *
 * NEVER add a chunk without a real, verifiable `sourceUrl`. If a source cannot
 * be fetched (paywall, TLS error, 404), skip it and log in
 * `/memory/d8-corpus-seed-progress.md`. Placeholder chunks are BANNED here;
 * the retriever + citation-guard together enforce the >= 2 real source rule.
 */

import { INDEX_BETA_DISCLOSURE } from '../renaiss-index/types-runtime.ts';

const LOG_PREFIX = '[corpus]';

export type CorpusCategory = 'medium' | 'industry' | 'openapi';

/**
 * The shape stored in the in-process corpus and mirrored into the
 * `AnthropicCorpus` table by `scripts/seed-corpus.ts`. All fields are required
 * (except `tags`, which is optional but conventionally non-empty).
 */
export interface CorpusSeed {
  /** Deterministic dedupe id: `<slug-of-source>-c<chunkIndex>`. Stable. */
  id: string;
  /** Human-readable source title. Shown in citation blocks. */
  title: string;
  /** Legacy URL field expected by retriever.ts. Equal to `sourceUrl`. */
  url: string;
  /** Canonical public URL of the source document. Required. */
  sourceUrl: string;
  /** ISO YYYY-MM-DD publish date (best-effort for OpenAPI). */
  publishedAt: string;
  /** Chunk category. */
  category: CorpusCategory;
  /** 0-based chunk index within the source document. */
  chunkIndex: number;
  /** ~500-token verbatim-preferred passage (1800-2200 chars typical). */
  excerpt: string;
  /** Rough token count for observability + budget accounting. */
  tokensEstimated: number;
  /** Bag-of-words tags used by the TF-IDF-lite scorer. */
  tags: string[];
}

const estTokens = (s: string): number => Math.ceil(s.length / 4);

const seed = (
  id: string,
  title: string,
  sourceUrl: string,
  publishedAt: string,
  category: CorpusCategory,
  chunkIndex: number,
  excerpt: string,
  tags: string[]
): CorpusSeed => {
  const clean = excerpt.replace(/\s+/g, ' ').trim();
  return {
    id,
    title,
    url: sourceUrl,
    sourceUrl,
    publishedAt,
    category,
    chunkIndex,
    excerpt: clean,
    tokensEstimated: estTokens(clean),
    tags,
  };
};

// ---------------------------------------------------------------------------
// Medium: Renaiss Tech Hackathon S1 (2026-06-26)
// ---------------------------------------------------------------------------
const HACKATHON_URL =
  'https://medium.com/@renaissxyz/renaiss-tech-hackathon-s1-is-open-build-ai-games-tools-for-the-collector-economy-0ab1b39c23c4';

// ---------------------------------------------------------------------------
// Medium: Community Builders & Tools Guide (2026-04-14)
// ---------------------------------------------------------------------------
const TOOLS_URL =
  'https://medium.com/@renaissxyz/renaiss-community-builders-tools-guide-ongoing-updates-db8d6801e89d';

// ---------------------------------------------------------------------------
// Medium: Global Redemption Guide (2026-07-xx)
// ---------------------------------------------------------------------------
const GLOBAL_REDEEM_URL =
  'https://medium.com/@renaissxyz/renaiss-redemption-guide-how-to-redeem-your-vaulted-cards-2062b3e72aa5';

// ---------------------------------------------------------------------------
// Medium: Beta Redemption Guide (2026-05-22)
// ---------------------------------------------------------------------------
const BETA_REDEEM_URL =
  'https://medium.com/@renaissxyz/renaiss-beta-redemption-guide-how-to-redeem-your-vaulted-cards-27c90897b1e1';

// ---------------------------------------------------------------------------
// Medium: Wallet Layer Update / Base Layer Migration (2026-05-21)
// ---------------------------------------------------------------------------
const WALLET_LAYER_URL =
  'https://medium.com/@renaissxyz/base-layer-update-is-live-migration-guide-fb9f5e8df226';

// ---------------------------------------------------------------------------
// Medium: Region Royale (2026-05-19)
// ---------------------------------------------------------------------------
const REGION_ROYALE_URL =
  'https://medium.com/@renaissxyz/region-royale-begins-how-the-invite-battle-works-9d3466ab6b2e';

// ---------------------------------------------------------------------------
// Medium: Superliquid Beta 2.0 (2026-03-21)
// ---------------------------------------------------------------------------
const SUPERLIQUID_URL =
  'https://medium.com/@renaissxyz/superliquid-beta-2-0-upgrading-the-liquidity-mechanism-market-depth-c4a9f3b40662';

// ---------------------------------------------------------------------------
// Medium: Ambassador 2.0 (2026-03-10)
// ---------------------------------------------------------------------------
const AMBASSADOR_URL =
  'https://medium.com/@renaissxyz/renaiss-ambassador-2-0-building-a-community-driven-leadership-system-8f1548d70f88';

// ---------------------------------------------------------------------------
// Industry: CryptoBriefing on Renaiss $1.5M raise (2026-06-22)
// ---------------------------------------------------------------------------
const CB_URL = 'https://cryptobriefing.com/renaiss-funding-round-yzi-labs/';

// ---------------------------------------------------------------------------
// Industry: mpost.io on Renaiss $1.5M raise (2026-06-18)
// ---------------------------------------------------------------------------
const MPOST_URL =
  'https://mpost.io/renaiss-secures-1-5m-in-first-round-led-by-yzi-labs-to-build-trustless-infrastructure-for-real-world-collectibles/';

// ---------------------------------------------------------------------------
// OpenAPI: Renaiss main API (api.renaiss.xyz/openapi.json)
// ---------------------------------------------------------------------------
const MAIN_OPENAPI_URL = 'https://api.renaiss.xyz/openapi.json';

// ---------------------------------------------------------------------------
// OpenAPI: Renaiss Index API (api.renaissos.com/v1/openapi.json)
// ---------------------------------------------------------------------------
const INDEX_OPENAPI_URL = 'https://api.renaissos.com/v1/openapi.json';

export const CORPUS_SEEDS: ReadonlyArray<CorpusSeed> = [
  // ---- Hackathon post ------------------------------------------------------
  seed(
    'medium-hackathon-c0',
    'Renaiss Tech Hackathon S1 Is Open: Build AI, Games & Tools for the Collector Economy',
    HACKATHON_URL,
    '2026-06-26',
    'medium',
    0,
    `Build tools, not decks. Renaiss Tech Hackathon S1 invites developers to create functional products for the collector economy, including AI workflows, dashboards, bots, and interactive experiences supporting the Renaiss ecosystem. Registration opens June 25-27 (11:59 PM UTC+8) via Google Form. The build period runs July 4-11, with winner announcement on July 15. Total prize pool is $4,000 USDT distributed as: Champion ($2,000), two Excellence Awards ($1,000 each). Winners receive Community Dev SBT, Tool Directory Listing, and limited merchandise. Three Build Categories: AI (price analysis tools, trading agents, market prediction assistants, and collector workflows), Tools (dashboards, bots, CLI utilities, data tools, and market tracking applications), and Games (playable prototypes, interactive showcases, and collector-facing mini-games).`,
    ['hackathon', 'renaiss', 's1', 'ai', 'tools', 'games', 'sbt']
  ),
  seed(
    'medium-hackathon-c1',
    'Renaiss Tech Hackathon S1: Judging Criteria and Requirements',
    HACKATHON_URL,
    '2026-06-26',
    'medium',
    1,
    `Projects are evaluated on usability, innovation, ecosystem relevance, clarity, and safety. The organizers emphasize a working demo or playable prototype over polished production software. Key requirements: submissions must demonstrate practical value without exposing private data or relying on unclear sources. Pure PR ideas, campaign concepts, or content-only plans are explicitly excluded. Winners receive Community Dev SBT, Tool Directory Listing, and limited merchandise. The hackathon spans AI, Tools, and Games categories, all targeted at the Renaiss collector economy on BNB Chain.`,
    ['hackathon', 'judging', 'safety', 'sbt', 'clarity']
  ),

  // ---- Community tools -----------------------------------------------------
  seed(
    'medium-tools-c0',
    'Renaiss Community Builders & Tools Guide (Ongoing Updates) - Part 1',
    TOOLS_URL,
    '2026-04-14',
    'medium',
    0,
    `Renaiss Community Tools Overview (curated, community-built). Deal Sniper Alerts (TG Bot) by @Gawin233 is a Telegram bot that scans the market every minute and alerts you when a card is listed below FMV, tracking below-market-value listings and user activity. SquirtleScan by @Jason094560893 is a Discord AI-powered assistant that identifies cards from images, estimates values, and provides insights via Discord commands. SNKRDUNK Price Checker by @steventswu is a Chrome extension that displays real-time listing prices and recent sales data from external markets while browsing Renaiss. Renaiss Portfolio Calculator by @angus91426 is a Telegram tool that calculates total portfolio value from wallet addresses and tracks holdings and collection value. TCGVALUE by @treegavin0121 is a Discord tool providing card image recognition, market data aggregation, and analysis report generation, with a feedback system for bug reports and feature suggestions.`,
    ['tools', 'community', 'discord', 'telegram', 'bot', 'ai', 'fmv', 'portfolio']
  ),
  seed(
    'medium-tools-c1',
    'Renaiss Community Builders & Tools Guide (Ongoing Updates) - Part 2',
    TOOLS_URL,
    '2026-04-14',
    'medium',
    1,
    `Additional community tools continued. Market Browser by @treegavin0121 is a Discord tool that aggregates trading channel listings in a cleaner interface, enabling quick deal scanning. Collection Poster Generator by @treegavin0121 generates visual collection showcases from wallet data with multiple layout options. Market Signals Feed by @treegavin0121 tracks pricing gaps across Renaiss, PriceCharting, and SNKRDUNK to identify trading opportunities. Lazy Gengar by @Crypto0XGoblin analyzes wallet activity including pack openings, trades, and cash flows. SBT Rank Feature by @Crypto0XGoblin is a ranking system based on SBT holdings with tiered cards (Gold/Silver/Bronze/Black). The article emphasizes that community contribution goes beyond participation and notes these tools will become increasingly important with SuperLiquid Beta 2.0 and the upcoming Renaiss Collectibles Hackathon.`,
    ['tools', 'community', 'discord', 'signals', 'sbt', 'wallet', 'poster']
  ),

  // ---- Global redemption ---------------------------------------------------
  seed(
    'medium-global-redeem-c0',
    'Renaiss Global Redemption Guide: How to Redeem Your Vaulted Cards',
    GLOBAL_REDEEM_URL,
    '2026-07-01',
    'medium',
    0,
    `Global Redemption is now live on Renaiss. For Renaiss, redemption represents a pivotal moment connecting on-chain ownership to tangible collectibles in the physical world. This initial phase grants access exclusively to collectors holding 25 or more Renaiss SBTs, functioning as the final testing phase before opening completely on August 1 without access restrictions. Through Renaiss OS, authenticated physical cards are held in verified third-party custody and represented digitally on-chain. With Global Redemption, users can convert supported vaulted cards from digital ownership into physical delivery, with transparent confirmation at each stage. Note: Redemption currently unavailable for Mainland China shipping addresses.`,
    ['redemption', 'vault', 'sbt', 'renaiss-os', 'physical', 'custody']
  ),
  seed(
    'medium-global-redeem-c1',
    'Global Redemption: Step-by-step process',
    GLOBAL_REDEEM_URL,
    '2026-07-01',
    'medium',
    1,
    `Step-by-step redemption process. Steps 1-3: Access the redemption page at renaiss.xyz, select desired cards for your cart, and review the critical reminder that redeeming these cards will permanently burn the NFTs. Steps 4-7: Add shipping address details in English, complete contact information (first/last name, email, phone), and verify both email and phone through confirmation codes. Steps 8-11: Retrieve courier options showing delivery timelines and costs, review the complete redemption summary with total fees, confirm NFT burn acknowledgment, then authorize payment and sign the redemption request via wallet. Upon successful completion, the redemption order is created and the Renaiss team proceeds with processing based on submitted information. The service emphasizes transparency and verification throughout the redemption journey.`,
    ['redemption', 'burn', 'shipping', 'wallet', 'nft', 'process']
  ),

  // ---- Beta redemption -----------------------------------------------------
  seed(
    'medium-beta-redeem-c0',
    'Renaiss Beta Redemption Guide: How to Redeem Your Vaulted Cards',
    BETA_REDEEM_URL,
    '2026-05-22',
    'medium',
    0,
    `For Renaiss, redemption represents a critical bridge between blockchain ownership and physical collectibles. The platform allows users with vaulted cards, held in verified third-party custody and represented as NFTs, to convert their digital assets into tangible items. The guide outlines an 11-step redemption workflow: (1) access the redemption page at renaiss.xyz/redeem to view available cards, (2) select and cart your desired card for redemption, (3) review cart with critical warning that redeeming these cards will permanently burn the NFTs and cannot be undone, (4) add shipping address in English with country, address details, postal code, city, and state, (5) enter contact information including name, email, and phone number, (6) verify email through 6-digit confirmation code, (7) verify phone via OTP.`,
    ['redemption', 'beta', 'vault', 'nft', 'burn', 'shipping']
  ),
  seed(
    'medium-beta-redeem-c1',
    'Beta Redemption: courier, fees, and NFT burn confirmation',
    BETA_REDEEM_URL,
    '2026-05-22',
    'medium',
    1,
    `Continuing the beta redemption workflow: (8) obtain courier options showing delivery timeframes and shipping costs, (9) review final summary including FMV, insurance, handling fees, and total costs, (10) confirm NFT burn by checking acknowledgment checkbox, (11) pay and sign the redemption request via wallet signature. The process emphasizes transparency across custody, digital ownership, and physical delivery. Users must acknowledge that NFT burning is irreversible before proceeding with payment. The platform notes regional variations may exist, suggesting users contact regional ambassadors for arrangements outside listed redemption areas.`,
    ['redemption', 'beta', 'fmv', 'courier', 'insurance', 'burn', 'ambassador']
  ),

  // ---- Wallet / Base Layer -------------------------------------------------
  seed(
    'medium-wallet-layer-c0',
    'Wallet Layer Update Is Live: Migration Guide (overview)',
    WALLET_LAYER_URL,
    '2026-05-21',
    'medium',
    0,
    `Base Layer Update rolled out May 21, 2026, introducing infrastructure improvements including Wallet Migration, multi-language support, better scalability and stability, and future AI integrations. For most users, the biggest visible change will be Wallet Migration. Existing assets remain safe; migration typically takes only a few minutes. Users with social login (Google/X/Discord) will have a simpler flow. Users using external wallets (EOA) may need additional authorization through Privy. Migration requires confirming ownership of your wallet. Renaiss is upgrading its wallet infrastructure to support better scalability, more stable transactions, future product expansions, improved account flexibility across login methods, and stronger foundations for upcoming features.`,
    ['wallet', 'migration', 'privy', 'base-layer', 'eoa', 'social-login']
  ),
  seed(
    'medium-wallet-layer-c1',
    'Wallet Migration: 7-step process',
    WALLET_LAYER_URL,
    '2026-05-21',
    'medium',
    1,
    `Step-by-step migration process. Step 1: External wallet users need additional authorization; if you previously logged in using an external wallet, you will be asked to authenticate again through Privy. This does not mean a new account, it confirms ownership under the upgraded wallet system. Step 2: Sign in with Privy to connect your existing Renaiss wallet to the upgraded infrastructure. Step 3: Start Wallet Migration to begin moving your account. Step 4: Review migration details including wallet ownership and assets involved. Step 5: Transfer BNB into the upgraded wallet setup. Step 6: Transfer remaining assets automatically into the new structure; avoid refreshing the page. Step 7: Migration complete. FAQ: You will not lose assets during migration; the interface change is expected; Privy re-connection is for security and wallet ownership authorization.`,
    ['wallet', 'migration', 'privy', 'bnb', 'assets', 'faq']
  ),

  // ---- Region Royale -------------------------------------------------------
  seed(
    'medium-region-royale-c0',
    'Region Royale Begins: How the Invite Battle Works',
    REGION_ROYALE_URL,
    '2026-05-19',
    'medium',
    0,
    `Region Royale: Invite Battle is a global community campaign where every region competes by inviting new users into Renaiss.xyz. Users from different regions invite friends, collectors, and communities to join Renaiss, make their first pack purchase, and push their region to the top. The rule: the region with the highest number of valid new users becomes the Champion Region. Campaign period: May 19, 2026, 00:00 (UTC+8) to June 19, 2026, 00:00 (UTC+8). Open globally; any Renaiss user from any region can participate. User regions determined by IP data during the campaign period and calculated by region. Participation: go to Renaiss.xyz, find your invite/referral link, share it, invite new users to register, and make sure they complete at least 1 pack purchase or draw.`,
    ['region-royale', 'invite', 'referral', 'campaign', 'community']
  ),
  seed(
    'medium-region-royale-c1',
    'Region Royale: valid users, prize pool, and fair play',
    REGION_ROYALE_URL,
    '2026-05-19',
    'medium',
    1,
    `A new user counts as valid when all three conditions are completed: registers during the campaign period, successfully binds an inviter/invite code, and purchases at least 1 pack from any gacha machine on Renaiss.xyz. Prize pool: 10,000U total. Airdrop Rewards (5,000U) shared equally by qualified inviters from the Champion Region who belong to the Champion Region, successfully invite at least 1 Valid New User via their referral link, and personally complete at least 1 pack purchase/draw. Champion Region Community Budget (5,000U) awarded to the winning region for local events and bonding activities. Fair play: Region Royale is designed for real users, real invites, and real community growth. Invalid or fraudulent activity may be excluded from final calculations.`,
    ['region-royale', 'airdrop', 'gacha', 'pack', 'fair-play']
  ),

  // ---- Superliquid Beta 2.0 -----------------------------------------------
  seed(
    'medium-superliquid-c0',
    'Superliquid Beta 2.0: What Superliquid is and how points work',
    SUPERLIQUID_URL,
    '2026-03-21',
    'medium',
    0,
    `Liquidity has always been a core challenge in the collectibles market. In TCG markets, assets are inherently non-standardized: each card carries its own unique value based on edition, grading, condition, and market demand. Without sufficient bid depth and effective listings, trading can easily become fragmented and inefficient. On renaiss.xyz, Superliquid is designed to address this structural problem. It introduces a liquidity incentive mechanism that encourages users to provide real, executable liquidity to the market. By introducing the Micro Market Maker mechanism, users participate through more precise bidding and more realistic listings. The system evaluates participants based on how effectively their actions contribute to overall market depth. Superliquid Points represent a user's real contribution to liquidity and serve as reference for future ecosystem incentives. Points are earned via bidding (buy-side depth), listing (effective inventory), and trading (realizing liquidity).`,
    ['superliquid', 'liquidity', 'points', 'micro-market-maker', 'depth', 'bidding', 'listing', 'trading']
  ),
  seed(
    'medium-superliquid-c1',
    'Superliquid 1.0 recap and Beta 2.0 optimizations',
    SUPERLIQUID_URL,
    '2026-03-21',
    'medium',
    1,
    `Superliquid 1.0 was completed in January 2026. By encouraging higher-quality bids, realistic listings, and real transactions, Superliquid improved market depth and trading activity on the Renaiss Marketplace. Key results from Superliquid 1.0: 886 participants joined, 37,798 Superliquid Points generated, 248% increase in P2P trading volume, and 618% increase in transaction count. The Superliquid Test Pioneer SBT was awarded to users who earned 15+ points. Superliquid Beta 2.0 test period began March 24, 2026, 15:00 (UTC+8). Key optimizations: (1) Adjusted baseline for realistic pricing - the Golden Zone for maximum Bid points was shifted downward to reflect brick-and-mortar TCG store pricing. (2) Massive boost for real transactions - point weighting for executed Buy/Sell trades significantly increased. (3) Crackdown on ghost listings - passive listing rewards reduced to discourage inefficient or non-executable orders and prioritize active, fillable liquidity. Points from 1.0 carry over into Beta 2.0.`,
    ['superliquid', 'beta-2', 'sbt', 'golden-zone', 'ghost-listings', 'p2p', 'recap']
  ),

  // ---- Ambassador 2.0 -----------------------------------------------------
  seed(
    'medium-ambassador-c0',
    'Renaiss Ambassador 2.0: growth path and regional structure',
    AMBASSADOR_URL,
    '2026-03-10',
    'medium',
    0,
    `Renaiss Ambassador 2.0 transforms the Ambassador Program into a more community-driven, structured, and scalable leadership system where contributors from different regions can participate, grow, and help shape the future of the Renaiss ecosystem. Every ambassador begins as Regional Ambassador, then Senior Ambassador, then Core Ambassador. Regional Ambassadors act as grassroots community builders within their regions. Regions covered: Chinese-speaking community, Taiwan, Korea, Japan, Malaysia, Philippines, Global community. Each region has two ambassadors representing two contribution roles: Active Contributor and Community Supporter. Active Contributors focus on content creation and external visibility on X and social media, driving brand awareness and attracting new users. Community Supporters focus on community engagement and operational support across Discord and Telegram, helping members onboard and reducing pressure on the core team.`,
    ['ambassador', 'program', 'regional', 'senior', 'core', 'regions', 'community']
  ),
  seed(
    'medium-ambassador-c1',
    'Ambassador 2.0: selection, terms, and incentives',
    AMBASSADOR_URL,
    '2026-03-10',
    'medium',
    1,
    `Regional Ambassador selection is community-involved. Step 1: regional nomination (community members may nominate themselves or others from their region). Step 2: regional voting (candidates voted on by members within the corresponding regional community, one vote per member). Step 3: team confirmation (Renaiss team conducts final confirmation for fairness and long-term community alignment). Term: 1 month with up to two consecutive terms. After a term, outcomes are: return to regular community member, re-elected for another term, or promoted to Senior Ambassador. Senior Ambassadors are invited by the team based on long-term contributions; benefits include a Seasonal SBT, participation in Regional Ambassador nominations, participation in selected internal discussions, and X badge support (1-year Blue Check). Core Ambassadors are selected from Senior Ambassadors based on outstanding contribution; benefits include higher-tier SBT recognition and deeper ecosystem-development opportunities, including possibly joining the Renaiss core team.`,
    ['ambassador', 'selection', 'term', 'senior', 'core', 'sbt', 'incentives']
  ),

  // ---- Industry: CryptoBriefing on $1.5M raise ----------------------------
  seed(
    'industry-cryptobriefing-c0',
    'CryptoBriefing: Renaiss raises $1.5M led by YZi Labs to bring trading cards on-chain',
    CB_URL,
    '2026-06-22',
    'industry',
    0,
    `Renaiss, an infrastructure project focused on bringing physical collectibles like trading cards onto the blockchain, has secured $1.5 million in its inaugural funding round. YZi Labs led the investment, joined by Gate Ventures, Hash Global, and Redline Labs. The platform's distinctive approach converts physical card shops and vaults into multi-signature blockchain verification nodes. Rather than centralizing custody in a single warehouse, Renaiss distributes verification across a network of real-world locations using cryptographic tools. The infrastructure operates on RenaissOS, proprietary software built on BNB Chain that establishes verifiable custody chains for physical items. A trading card feature is currently operational at renaiss.xyz. Following its November 2025 testnet launch, the project claims approximately $20 million in revenue and over 260,000 users, predominantly from Asian markets.`,
    ['funding', 'yzi-labs', 'renaiss-os', 'bnb-chain', 'custody', 'multi-sig', 'verification']
  ),
  seed(
    'industry-cryptobriefing-c1',
    'CryptoBriefing: Renaiss thesis, no native token',
    CB_URL,
    '2026-06-22',
    'industry',
    1,
    `YZi Labs' leadership aligns with the firm's focus on real-world asset tokenization within the BNB ecosystem. Renaiss plans to expand its vault network, extend support beyond trading cards to other collectibles, and develop integrations with DeFi and AI platforms. Notable distinction: the project currently lacks a native token, meaning user engagement metrics reflect genuine adoption rather than incentive farming. Renaiss's approach positions physical card shops and vaults as multi-signature blockchain verification nodes; distributes verification across a network of real-world locations using cryptographic tools; and runs RenaissOS on BNB Chain to establish verifiable custody chains for physical items. Trading cards are operational at renaiss.xyz, with the project reporting approximately $20 million in revenue and 260,000+ users since testnet launch in November 2025.`,
    ['funding', 'yzi-labs', 'rwa', 'defi', 'ai', 'no-token', 'thesis']
  ),

  // ---- Industry: mpost on $1.5M raise -------------------------------------
  seed(
    'industry-mpost-c0',
    'mpost: Renaiss secures $1.5M in first round led by YZi Labs',
    MPOST_URL,
    '2026-06-18',
    'industry',
    0,
    `Renaiss, an RWA liquidity infrastructure project for real-world collectibles built on BNB Chain, has secured $1.5 million in funding, with YZi Labs leading the first round and participation from Gate Ventures, Hash Global, XIN Family, Redline Labs, and angels from Mask Network, Far East Group, Logoman, Hoopi, and Legit App. The funding will support Renaiss as it scales its vault network, expands into new collectible verticals, strengthens product and ecosystem integrations, improves capital efficiency, and grows its global presence. At the core of its stack is RenaissOS, which turns independent vaults and card shops into on-chain verification nodes. Assets are co-signed through cryptographic multi-sig, reducing reliance on any single party and allowing custody status to be independently verified.`,
    ['funding', 'yzi-labs', 'renaiss-os', 'multi-sig', 'bnb-chain', 'vault', 'rwa']
  ),
  seed(
    'industry-mpost-c1',
    'mpost: Renaiss market context and collectibles thesis',
    MPOST_URL,
    '2026-06-18',
    'industry',
    1,
    `Renaiss started with trading cards as its first major collectible category, with Renaiss.xyz serving as the application layer for users to access collectible markets, trading and on-chain ownership. Its broader goal is to support more real-world collectible categories and ecosystem partners through on-chain rails. High-value collectibles already have strong global demand, active secondary markets and deep cultural relevance. However, the market remains fragmented: authentication, custody, pricing, settlement and cross-border transactions are often handled through separate offline processes, creating friction for both buyers and sellers. While RWA tokenization has largely focused on treasuries, credit and real estate, collectibles represent a more consumer-native RWA category, shaped by financial value, culture, scarcity, identity and community demand. Renaiss addresses this gap with a verifiable multi-region custody and liquidity layer, enabling physical collectibles to trade permissionlessly on-chain.`,
    ['collectibles', 'rwa', 'tcg', 'custody', 'liquidity', 'settlement', 'cross-border']
  ),
  seed(
    'industry-mpost-c2',
    'mpost: Renaiss traction, ecosystem, and roadmap',
    MPOST_URL,
    '2026-06-18',
    'industry',
    2,
    `Since launching its beta in November 2025, Renaiss has surpassed $20 million in revenue in roughly six months. The platform has also grown to more than 260,000 users, with strong activity across Asian markets including South Korea, Taiwan, Japan and Southeast Asia. Growth has been driven by primary collectible distribution, marketplace activity and increasing user participation around on-chain collectible assets. Secondary marketplace activity has become an important signal, showing early liquidity beyond one-time drops. In December 2025, the project was named a winner at Binance Blockchain Week Dubai Demo Night. It has ranked as the No. 1 RWA on BNB Chain. In May 2026, Renaiss graduated from EASY Residency Season 3, a YZi Labs-backed incubation program. With the new funding, Renaiss plans to scale its vault network, expand into new collectible categories, strengthen product integrations and support ecosystem growth through Renaiss SDK, DeFi integrations and AI agent infrastructure. Its Trustless Leverage Engine is designed to improve capital efficiency as more verified, vault-backed supply moves on-chain.`,
    ['traction', 'revenue', 'users', 'binance', 'easy-residency', 'sdk', 'trustless-leverage']
  ),

  // ---- OpenAPI: Renaiss main API (api.renaiss.xyz) -----------------------
  seed(
    'openapi-main-c0',
    'Renaiss main API (api.renaiss.xyz): card, pack, marketplace endpoints',
    MAIN_OPENAPI_URL,
    '2026-06-01',
    'openapi',
    0,
    `Renaiss main API endpoints extracted from https://api.renaiss.xyz/openapi.json. GET /v0/cards/{tokenId}: Get card by token ID. Returns public card data for CLI and detail views. Price details and activity history can be requested explicitly (verbosePrice, includeActivities query params). GET /v0/packs: List packs. Returns public pack metadata for CLI consumers without pack contents. GET /v0/packs/{slug}: Get pack by slug. Returns basic pack details. Perpetual packs include recent activity; contents are never returned. GET /v0/marketplace: List collectibles. Returns a paginated list of collectibles with filtering and sorting options. GET /v0/users/{id}: Get public user profile. Returns public user profile with favorited collectibles and SBT badges. GET /v0/health: Health check. Returns a minimal serverless-friendly health status.`,
    ['api', 'main-api', 'card', 'pack', 'marketplace', 'user', 'health', 'openapi']
  ),
  seed(
    'openapi-main-c1',
    'Renaiss main API (api.renaiss.xyz): perpetual gacha endpoints',
    MAIN_OPENAPI_URL,
    '2026-06-01',
    'openapi',
    1,
    `Renaiss main API perpetual gacha endpoints. POST /v0/gacha/temporary/perpetual/pull/prepare: Prepares unsigned perpetual gacha pull payload and Permit2 batch witness typed data for client signing. POST /v0/gacha/temporary/perpetual/pull: Executes signed perpetual gacha batch checkout payload. Use quantity 1 for a normal pull and 5 or 10 for super-mode pulls. POST /v0/gacha/temporary/perpetual/buyback/prepare: Prepares sponsored Safe UserOperation and SafeOp typed data for perpetual buyback checkout records. POST /v0/gacha/temporary/perpetual/buyback/finalize: Accepts Safe owner signature, submits sponsored UserOperation, and syncs related records. These endpoints back the on-chain pull-and-buyback flow at renaiss.xyz and are the surface that community indexers watch for new pack activity.`,
    ['api', 'main-api', 'gacha', 'pack', 'permit2', 'safe', 'buyback', 'openapi']
  ),

  // ---- OpenAPI: Renaiss Index API (api.renaissos.com) --------------------
  seed(
    'openapi-index-c0',
    'Renaiss Index API (api.renaissos.com/v1): graded and cert endpoints',
    INDEX_OPENAPI_URL,
    '2026-06-01',
    'openapi',
    0,
    `Renaiss Index API endpoints extracted from https://api.renaissos.com/v1/openapi.json. GET /v1/graded/{cert}: Graded cert lookup. Look up graded card by certification number using a cache-first approach. GET /v1/graded/{cert}/stream: Graded cert lookup, live progress via Server-Sent Events streaming on-demand valuation progress. POST /v1/graded/by-image: Graded valuation by photo (SSE); AI reads card identity and pricing. GET /v1/search: Free-text card search. Queries shorter than 2 characters return no results. GET /v1/health and GET /health: liveness probes, never cached. POST /v1/partners/apply and POST /v1/report are rate-limited per IP for shop intake and data-issue reporting. ${INDEX_BETA_DISCLOSURE}`,
    ['api', 'index-api', 'graded', 'cert', 'sse', 'search', 'partners', 'openapi']
  ),
  seed(
    'openapi-index-c1',
    'Renaiss Index API: card detail, overview, trades, series endpoints',
    INDEX_OPENAPI_URL,
    '2026-06-01',
    'openapi',
    1,
    `Renaiss Index API card-focused endpoints. GET /v1/cards/{game}/{set}/{card}: Card detail (price, confidence, source breakdown, other grades, similar cards). GET /v1/cards/{game}/{set}/{card}/trades: listings and completed sales for a card, with optional filters. GET /v1/cards/{game}/{set}/{card}/series: daily-average price points over a window. GET /v1/cards/{game}/{set}/{card}/fmv-series: daily fair-market-value reference-price methodology evaluated once per day. GET /v1/cards/{game}/{set}/{card}/overview: grade-agnostic view of a card and every grading company/grade tracked. GET /v1/cards/by-id/{id}, /overview, /trades, /series, /fmv-series: same functionality keyed by catalog id. GET /v1/cards/by-renaiss-id/{rid} and variants: keyed by upstream Renaiss item id. GET /v1/sets/{game}/{set}: every card tracked in a set. GET /v1/cards/featured: top-mover card tiles. GET /v1/trades/recent: cross-card live trade feed newest first. GET /v1/indices and GET /v1/indices/{game}: Pokémon and One Piece index tiles and drill-down. ${INDEX_BETA_DISCLOSURE}`,
    ['api', 'index-api', 'card', 'overview', 'trades', 'series', 'fmv', 'indices', 'openapi']
  ),
];

/**
 * Stop-word list used by the TF-IDF-lite scorer. Kept aggressive so query
 * tokens are dominated by proper nouns and domain terms.
 */
const STOPWORDS = new Set<string>([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'it',
  'this', 'that', 'with', 'by', 'as', 'at', 'from', 'be', 'are', 'was', 'were',
  'i', 'you', 'we', 'they', 'he', 'she', 'his', 'her', 'their', 'my', 'your',
  'about', 'into', 'over', 'up', 'down', 'out', 'so', 'if', 'then', 'than',
  'what', 'how', 'why', 'when', 'where', 'who', 'which', 'do', 'does', 'did',
]);

const tokenize = (text: string): string[] => {
  if (typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
};

/**
 * TF-IDF-lite scorer. Counts overlapping tokens between the query and each
 * chunk's (title + excerpt + tags) bag. Returns the top `k` matches ordered by
 * score (ties broken by publishedAt desc, then chunkIndex asc). Chunks with
 * zero query-token overlap are dropped.
 */
export const scoreCorpus = (query: string, k = 2): CorpusSeed[] => {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) {
    console.warn(`${LOG_PREFIX} scoreCorpus called with empty query`);
    return [];
  }

  const scored = CORPUS_SEEDS.map((seedRow) => {
    const bag = tokenize(
      `${seedRow.title} ${seedRow.excerpt} ${seedRow.tags.join(' ')}`
    );
    let hits = 0;
    for (const t of bag) {
      if (qTokens.has(t)) hits += 1;
    }
    return { seed: seedRow, score: hits };
  })
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const dateCmp = b.seed.publishedAt.localeCompare(a.seed.publishedAt);
      if (dateCmp !== 0) return dateCmp;
      return a.seed.chunkIndex - b.seed.chunkIndex;
    });

  return scored.slice(0, k).map((r) => r.seed);
};
