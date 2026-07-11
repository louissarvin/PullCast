/**
 * CLI smoke tests.
 *
 * We import the command handlers and program factory from `cli/src` directly
 * and inject a mock fetch. This gives us:
 *  - Deterministic assertions on the envelope shape
 *  - No network dependency in CI
 *  - Coverage of the input-validation error paths
 *  - Coverage of the Commander wiring (unknown command exits non-zero)
 */

import { describe, test, expect } from 'bun:test';

import {
  runPull,
  runValuate,
  runMarket,
  runFeatured,
  runPrice,
  runMarketplace,
  runCard,
  runPacks,
  runSearch,
  runSet,
  makeContext,
} from '../cli/src/commands.ts';
import { createProgram } from '../cli/src/index.ts';
import {
  formatGraded,
  formatMarket,
  formatFeatured,
  formatPulls,
  formatPrice,
  formatMarketplace,
  formatCard,
  formatPacks,
  formatSearch,
  formatSet,
} from '../cli/src/format.ts';
import { BETA_DISCLOSURE_LINE } from '../cli/src/envelope.ts';

// ---------------------------------------------------------------------------
// Fetch mocks
// ---------------------------------------------------------------------------

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
};

/**
 * Build a fetch mock that returns a fixed body for a given URL substring.
 * Any URL not matched throws (so tests catch typos in the URL).
 */
const mockFetch = (routes: Array<{ match: string; body: unknown; status?: number }>) => {
  const calls: string[] = [];
  const impl: typeof fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    calls.push(url);
    for (const route of routes) {
      if (url.includes(route.match)) {
        return jsonResponse(route.body, route.status ?? 200);
      }
    }
    throw new Error(`Unexpected URL in mockFetch: ${url}`);
  };
  return { impl, calls };
};

// ---------------------------------------------------------------------------
// runValuate
// ---------------------------------------------------------------------------

describe('cli: valuate', () => {
  test('returns envelope with data, sources, warnings, generated_at', async () => {
    const { impl } = mockFetch([
      {
        match: '/v1/graded/PSA73628064',
        body: {
          cert: 'PSA73628064',
          found: true,
          reason: null,
          gradeLabel: 'PSA 10',
          card: {
            name: 'Charizard',
            setName: 'Pokemon Japanese Sword & Shield Vmax Climax',
            priceUsdCents: 7839,
            deltaPct: -11.96,
            confidence: 'medium',
            lastSaleAt: '2026-07-01T15:00:00.000Z',
            href: '/card/pokemon/x',
          },
        },
      },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runValuate('PSA73628064', ctx);
    expect(env.data.cert).toBe('PSA73628064');
    expect(env.data.found).toBe(true);
    expect(env.data.card?.priceUsdCents).toBe(7839);
    expect(env.sources.length).toBeGreaterThan(0);
    expect(env.sources[0]!.url).toContain('renaissos.com');
    expect(env.warnings[0]!.code).toBe('BETA');
    expect(typeof env.generated_at).toBe('string');
  });

  test('rejects malformed cert without hitting the network', async () => {
    const { impl, calls } = mockFetch([]);
    const ctx = makeContext({ fetchImpl: impl });
    await expect(runValuate('bad-cert!', ctx)).rejects.toThrow(/Invalid cert/);
    expect(calls.length).toBe(0);
  });

  test('pretty output ends with beta disclosure', () => {
    const text = formatGraded({
      cert: 'PSA73628064',
      found: true,
      gradeLabel: 'PSA 10',
      card: {
        name: 'Charizard',
        setName: 'X',
        priceUsdCents: 7839,
        deltaPct: -12,
        confidence: 'medium',
        lastSaleAt: '2026-07-01T15:00:00.000Z',
      },
    });
    expect(text).toContain(BETA_DISCLOSURE_LINE);
  });

  test('found:false path surfaces the reason', async () => {
    const { impl } = mockFetch([
      {
        match: '/v1/graded/PSA00000001',
        body: {
          cert: 'PSA00000001',
          found: false,
          reason: 'not_ingested',
        },
      },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runValuate('PSA00000001', ctx);
    expect(env.data.found).toBe(false);
    expect(env.data.reason).toBe('not_ingested');
  });
});

// ---------------------------------------------------------------------------
// runMarket
// ---------------------------------------------------------------------------

describe('cli: market', () => {
  test('all-games returns array of tiles with deltas', async () => {
    const { impl } = mockFetch([
      {
        match: '/v1/indices',
        body: {
          indices: [
            {
              game: 'pokemon',
              value: 12282.25,
              base: 10000,
              deltas: { d7: -5.83, d30: -15.98, d365: 72.52 },
              constituentCount: 50,
            },
            {
              game: 'one-piece',
              value: 18159.81,
              deltas: { d7: -6.94, d30: 6.93, d365: 231.55 },
              constituentCount: 50,
            },
          ],
        },
      },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runMarket({}, ctx);
    expect(env.data.indices.length).toBe(2);
    expect(env.data.indices[0]!.game).toBe('pokemon');
    expect(env.data.indices[0]!.deltas?.d7).toBe(-5.83);
    expect(env.sources[0]!.url).toContain('/v1/indices');
    expect(env.warnings[0]!.code).toBe('BETA');
  });

  test('game filter hits the drill-down endpoint', async () => {
    const { impl, calls } = mockFetch([
      {
        match: '/v1/indices/pokemon',
        body: {
          game: 'pokemon',
          value: 12282.25,
          deltas: { d7: -5.83, d30: -15.98, d365: 72.52 },
          constituentCount: 50,
        },
      },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runMarket({ game: 'pokemon' }, ctx);
    expect(env.data.game).toBe('pokemon');
    expect(env.data.indices.length).toBe(1);
    expect(calls[0]).toContain('/v1/indices/pokemon');
  });

  test('rejects invalid game slug', async () => {
    const { impl } = mockFetch([]);
    const ctx = makeContext({ fetchImpl: impl });
    // TypeScript: assertion cast for the test.
    await expect(
      runMarket({ game: 'invalid' as 'pokemon' }, ctx)
    ).rejects.toThrow(/Invalid --game/);
  });

  test('pretty output contains disclosure', () => {
    const text = formatMarket([
      {
        game: 'pokemon',
        value: 12282.25,
        deltas: { d7: -5.83, d30: -15.98, d365: 72.52 },
        constituentCount: 50,
      },
    ]);
    expect(text).toContain(BETA_DISCLOSURE_LINE);
  });
});

// ---------------------------------------------------------------------------
// runFeatured
// ---------------------------------------------------------------------------

describe('cli: featured', () => {
  test('returns cards array with priceUsdCents', async () => {
    const { impl } = mockFetch([
      {
        match: '/v1/cards/featured',
        body: {
          cards: [
            {
              name: 'Charizard',
              setName: 'X',
              gradeLabel: 'PSA 10',
              priceUsdCents: 7839,
              deltaPct: -11.96,
              confidence: 'medium',
            },
          ],
        },
      },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runFeatured({ limit: 3 }, ctx);
    expect(env.data.limit).toBe(3);
    expect(env.data.cards.length).toBe(1);
    expect(env.data.cards[0]!.priceUsdCents).toBe(7839);
  });

  test('rejects out-of-range limit', async () => {
    const { impl } = mockFetch([]);
    const ctx = makeContext({ fetchImpl: impl });
    await expect(runFeatured({ limit: 100 }, ctx)).rejects.toThrow(/Invalid --limit/);
  });

  test('pretty output contains disclosure', () => {
    const text = formatFeatured([
      { name: 'A', gradeLabel: 'PSA 10', priceUsdCents: 1000, deltaPct: 5 },
    ]);
    expect(text).toContain(BETA_DISCLOSURE_LINE);
  });
});

// ---------------------------------------------------------------------------
// runPull
// ---------------------------------------------------------------------------

describe('cli: pull', () => {
  test('returns pulls array from PullCast backend envelope', async () => {
    const { impl } = mockFetch([
      {
        match: '/api/wallets/0x',
        body: {
          data: {
            pulls: [
              {
                id: 'p_1',
                collectibleTokenId: '156730',
                name: 'Cynthia\'s Roserade',
                tier: 'legendary',
                fmvCents: 4900,
                pulledAtTimestamp: '2026-07-01T00:00:00.000Z',
              },
            ],
          },
        },
      },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runPull(
      '0x602119ef58d2aa963256b105948899ea0a890903',
      { limit: 10 },
      ctx
    );
    expect(env.data.pulls.length).toBe(1);
    expect(env.data.pulls[0]!.name).toContain('Roserade');
    expect(env.sources[0]!.label).toBe('PullCast API');
  });

  test('rejects invalid address before network call', async () => {
    const { impl, calls } = mockFetch([]);
    const ctx = makeContext({ fetchImpl: impl });
    await expect(runPull('not-an-address', {}, ctx)).rejects.toThrow(
      /Invalid wallet address/
    );
    expect(calls.length).toBe(0);
  });

  test('rejects out-of-range limit', async () => {
    const { impl } = mockFetch([]);
    const ctx = makeContext({ fetchImpl: impl });
    await expect(
      runPull(
        '0x602119ef58d2aa963256b105948899ea0a890903',
        { limit: 500 },
        ctx
      )
    ).rejects.toThrow(/Invalid --limit/);
  });

  test('404 from backend returns empty pulls array (no throw)', async () => {
    const { impl } = mockFetch([{ match: '/api/wallets/0x', body: {}, status: 404 }]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runPull(
      '0x602119ef58d2aa963256b105948899ea0a890903',
      { limit: 10 },
      ctx
    );
    expect(env.data.pulls).toEqual([]);
  });

  test('pretty output contains disclosure and address', () => {
    const text = formatPulls('0xABC', [
      {
        collectibleTokenId: '123',
        name: 'X',
        tier: 'rare',
        fmvCents: 100,
        pulledAtTimestamp: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(text).toContain(BETA_DISCLOSURE_LINE);
    expect(text).toContain('0xABC');
  });
});

// ---------------------------------------------------------------------------
// runPrice
// ---------------------------------------------------------------------------

describe('cli: price', () => {
  test('cert-shaped input goes to Index API', async () => {
    const { impl, calls } = mockFetch([
      {
        match: '/v1/graded/PSA73628064',
        body: {
          cert: 'PSA73628064',
          found: true,
          card: { priceUsdCents: 7839, confidence: 'high' },
        },
      },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runPrice('PSA73628064', ctx);
    expect(env.data.indexFmvUsd).toBeCloseTo(78.39, 2);
    expect(env.data.confidence).toBe('high');
    expect(calls[0]).toContain('renaissos.com');
  });

  test('tokenId-shaped input goes to PullCast backend blend', async () => {
    const { impl, calls } = mockFetch([
      {
        match: '/api/price/token/',
        body: {
          data: {
            index: { priceUsdCents: 7839, confidence: 'medium' },
            renaiss: { fmvPriceInUSD: '7350' },
            variancePct: 0.062,
          },
        },
      },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runPrice('15673003569618327101057043351765386873514582732', ctx);
    expect(env.data.indexFmvUsd).toBeCloseTo(78.39, 2);
    expect(env.data.renaissFmvUsd).toBeCloseTo(73.5, 2);
    expect(env.sources.length).toBeGreaterThan(1);
    expect(calls[0]).toContain('/api/price/token/');
  });

  test('pretty output contains disclosure', () => {
    const text = formatPrice({
      input: 'X',
      indexFmvUsd: 78.39,
      renaissFmvUsd: 73.5,
      confidence: 'high',
      variancePct: 6.2,
    });
    expect(text).toContain(BETA_DISCLOSURE_LINE);
  });
});

// ---------------------------------------------------------------------------
// runMarketplace (mirror of `renaiss marketplace`)
// ---------------------------------------------------------------------------

describe('cli: marketplace', () => {
  test('returns collection + pagination in envelope', async () => {
    const { impl, calls } = mockFetch([
      {
        match: '/api/marketplace',
        body: {
          data: {
            collection: [
              {
                tokenId: '1104074443064635774981472037247520288',
                name: 'PSA 10 Gem Mint Starmie V',
                setName: 'Astral Radiance',
                grade: '10 Gem Mint',
                gradingCompany: 'PSA',
                fmvPriceInUSD: '33495',
                askPriceInUSDT: '408000000000000000000',
                year: 2022,
              },
            ],
            pagination: { total: 802, limit: 5, offset: 0, hasMore: true },
          },
        },
      },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runMarketplace(
      { grading: 'PSA', category: 'POKEMON', limit: 5 },
      ctx
    );
    expect(env.data.collection.length).toBe(1);
    expect(env.data.collection[0]!.name).toContain('Starmie');
    expect(env.data.pagination.total).toBe(802);
    // Backend query params must be the mapped names, not the CLI flag names.
    expect(calls[0]).toContain('gradingCompanyFilter=PSA');
    expect(calls[0]).toContain('categoryFilter=POKEMON');
    expect(calls[0]).toContain('limit=5');
    expect(env.warnings[0]!.code).toBe('BETA');
    expect(env.sources.length).toBeGreaterThan(0);
  });

  test('rejects invalid --grading before network call', async () => {
    const { impl, calls } = mockFetch([]);
    const ctx = makeContext({ fetchImpl: impl });
    await expect(
      runMarketplace({ grading: 'INVALID' }, ctx)
    ).rejects.toThrow(/--grading must be one of/);
    expect(calls.length).toBe(0);
  });

  test('rejects out-of-range --limit before network call', async () => {
    const { impl, calls } = mockFetch([]);
    const ctx = makeContext({ fetchImpl: impl });
    await expect(runMarketplace({ limit: 500 }, ctx)).rejects.toThrow(
      /--limit must be an integer in \[1, 100\]/
    );
    expect(calls.length).toBe(0);
  });

  test('rejects malformed --year before network call', async () => {
    const { impl } = mockFetch([]);
    const ctx = makeContext({ fetchImpl: impl });
    await expect(runMarketplace({ year: 'notayear' }, ctx)).rejects.toThrow(
      /--year must look like/
    );
  });

  test('rejects malformed --price before network call', async () => {
    const { impl } = mockFetch([]);
    const ctx = makeContext({ fetchImpl: impl });
    await expect(runMarketplace({ price: 'expensive' }, ctx)).rejects.toThrow(
      /--price must look like/
    );
  });

  test('rejects too-short --search', async () => {
    const { impl } = mockFetch([]);
    const ctx = makeContext({ fetchImpl: impl });
    await expect(runMarketplace({ search: 'ab' }, ctx)).rejects.toThrow(
      /--search must be/
    );
  });

  test('pretty output contains disclosure and table headers', () => {
    const text = formatMarketplace(
      [
        {
          tokenId: '123',
          name: 'X',
          grade: '10',
          gradingCompany: 'PSA',
          fmvPriceInUSD: '10000',
          askPriceInUSDT: '100000000000000000000',
        },
      ],
      { total: 1, limit: 10, offset: 0, hasMore: false }
    );
    expect(text).toContain(BETA_DISCLOSURE_LINE);
    expect(text).toContain('Marketplace');
    expect(text).toContain('$100.00'); // fmv $100.00
    expect(text).toContain('$100.00'); // ask $100.00
  });

  test('pretty output shows "no results" on empty collection', () => {
    const text = formatMarketplace(
      [],
      { total: 0, limit: 10, offset: 0, hasMore: false }
    );
    expect(text).toContain('No results');
  });
});

// ---------------------------------------------------------------------------
// runCard (mirror of `renaiss card`)
// ---------------------------------------------------------------------------

describe('cli: card', () => {
  test('returns blended card data in envelope shape', async () => {
    const { impl, calls } = mockFetch([
      {
        match: '/api/price/token/',
        body: {
          data: {
            tokenId: '11040744430646357749814720',
            cardName: 'Starmie V',
            setName: 'Astral Radiance',
            cardNumber: 'TG13',
            gradingCompany: 'PSA',
            grade: '10 Gem Mint',
            serial: 'PSA114458483',
            imageUrl: 'https://cdn.renaiss.xyz/x.png',
            mainApiFmvUsdCents: 33495,
            indexApiFmvUsdCents: 34200,
            recommendedFmvUsdCents: 34200,
            confidence: 'high',
            lastSaleAt: '2026-06-30T14:22:11.000Z',
            variancePctOver20: false,
            lastSaleOnChain: {
              priceUsdcFormatted: '408.00',
              paymentToken: 'USDC',
              txHash: '0xabc123def4560000000000000000000000000000000000000000000000000000',
              blockNumber: 51_234_567,
              timestamp: 1_720_000_000,
              bscscanUrl: 'https://bscscan.com/tx/0xabc',
            },
          },
        },
      },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runCard('11040744430646357749814720', {}, ctx);
    expect(env.data.tokenId).toBe('11040744430646357749814720');
    expect(env.data.cardName).toBe('Starmie V');
    expect(env.data.price?.mainApiFmvUsdCents).toBe(33495);
    expect(env.data.price?.indexApiFmvUsdCents).toBe(34200);
    expect(env.data.price?.onChainLastSale?.priceUsdcFormatted).toBe('408.00');
    expect(env.warnings[0]!.code).toBe('BETA');
    expect(calls[0]).toContain('/api/price/token/');
    // No --verbose → no sourceUrls injected.
    expect(env.data.price?.sourceUrls).toBeUndefined();
  });

  test('--verbose injects extended source URLs', async () => {
    const { impl } = mockFetch([
      {
        match: '/api/price/token/',
        body: {
          data: {
            cardName: 'X',
            serial: 'psa123',
            mainApiFmvUsdCents: 1000,
          },
        },
      },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runCard('12345', { verbose: true }, ctx);
    expect(env.data.price?.sourceUrls?.renaissMainCard).toContain(
      '/v0/collectibles/12345'
    );
    // Serial is uppercased in the URL for consistency with backend.
    expect(env.data.price?.sourceUrls?.renaissIndexCert).toContain(
      '/v1/graded/PSA123'
    );
  });

  test('--activities surfaces an empty items array with reason marker', async () => {
    const { impl } = mockFetch([
      {
        match: '/api/price/token/',
        body: { data: { cardName: 'X' } },
      },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runCard('12345', { activities: true }, ctx);
    expect(env.data.activities?.items).toEqual([]);
    expect(env.data.activities?._reason).toBeDefined();
  });

  test('rejects invalid tokenId before network call', async () => {
    const { impl, calls } = mockFetch([]);
    const ctx = makeContext({ fetchImpl: impl });
    await expect(runCard('not a token', {}, ctx)).rejects.toThrow(
      /Invalid tokenId/
    );
    expect(calls.length).toBe(0);
  });

  test('pretty output contains disclosure and card name', () => {
    const text = formatCard({
      tokenId: '123',
      cardName: 'Test Card',
      setName: 'Set X',
      gradingCompany: 'PSA',
      grade: '10',
      price: {
        mainApiFmvUsdCents: 10000,
        indexApiFmvUsdCents: 10500,
        recommendedFmvUsdCents: 10500,
        confidence: 'high',
        variancePctOver20: false,
      },
    });
    expect(text).toContain(BETA_DISCLOSURE_LINE);
    expect(text).toContain('Test Card');
    expect(text).toContain('$100.00');
    expect(text).toContain('confidence: high');
  });
});

// ---------------------------------------------------------------------------
// runPacks
// ---------------------------------------------------------------------------

describe('cli: packs', () => {
  test('list mode (no slug) hits /api/packs and returns envelope', async () => {
    const { impl, calls } = mockFetch([
      {
        match: '/api/packs',
        body: {
          data: {
            includeInactive: false,
            packs: [
              {
                slug: 'eden-pack',
                name: 'Eden Pack',
                packType: 'perpetual',
                stage: 'active',
                author: 'Renaiss x Logoman',
                priceInUsdt: '150000000000000000000',
                expectedValueInUsd: '15500',
                featuredCardFmvInUsd: '443400',
              },
            ],
          },
        },
      },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runPacks({}, ctx);
    expect(env.data.mode).toBe('list');
    expect(env.data.slug).toBe(null);
    expect(env.data.packs.length).toBe(1);
    expect(env.data.packs[0]!.slug).toBe('eden-pack');
    expect(calls[0]).toContain('/api/packs');
    expect(env.sources.length).toBeGreaterThan(0);
    expect(env.warnings[0]!.code).toBe('BETA');
  });

  test('--include-inactive is propagated to the backend query string', async () => {
    const { impl, calls } = mockFetch([
      { match: '/api/packs', body: { data: { packs: [] } } },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    await runPacks({ includeInactive: true }, ctx);
    expect(calls[0]).toContain('includeInactive=true');
  });

  test('slug mode hits /api/packs/:slug and returns detail envelope', async () => {
    const { impl, calls } = mockFetch([
      {
        match: '/api/packs/eden-pack',
        body: {
          data: {
            pack: {
              slug: 'eden-pack',
              name: 'Eden Pack',
              packType: 'perpetual',
              stage: 'active',
              priceInUsdt: '150000000000000000000',
              expectedValueInUsd: '15500',
            },
          },
        },
      },
    ]);
    const ctx = makeContext({ fetchImpl: impl });
    const env = await runPacks({ slug: 'eden-pack' }, ctx);
    expect(env.data.mode).toBe('detail');
    expect(env.data.slug).toBe('eden-pack');
    expect(env.data.packs.length).toBe(1);
    expect(env.data.packs[0]!.name).toBe('Eden Pack');
    expect(calls[0]).toContain('/api/packs/eden-pack');
  });

  test('rejects invalid slug shape without hitting the network', async () => {
    const { impl, calls } = mockFetch([]);
    const ctx = makeContext({ fetchImpl: impl });
    await expect(
      runPacks({ slug: 'bad slug with spaces!' }, ctx)
    ).rejects.toThrow(/Invalid pack slug/);
    expect(calls.length).toBe(0);
  });

  test('pretty list output contains disclosure line', () => {
    const text = formatPacks(
      [
        {
          slug: 'eden-pack',
          name: 'Eden Pack',
          packType: 'perpetual',
          stage: 'active',
          priceInUsdt: '150000000000000000000',
          expectedValueInUsd: '15500',
        },
      ],
      'list'
    );
    expect(text).toContain(BETA_DISCLOSURE_LINE);
    expect(text).toContain('eden-pack');
  });

  test('pretty detail output prints usdt price + expected value', () => {
    const text = formatPacks(
      [
        {
          slug: 'eden-pack',
          name: 'Eden Pack',
          packType: 'perpetual',
          stage: 'active',
          priceInUsdt: '150000000000000000000',
          expectedValueInUsd: '15500',
          featuredCardFmvInUsd: '443400',
        },
      ],
      'detail'
    );
    expect(text).toContain('Eden Pack');
    expect(text).toContain('150 USDT');
    expect(text).toContain('$15,500');
    expect(text).toContain('$443,400');
    expect(text).toContain(BETA_DISCLOSURE_LINE);
  });
});

// ---------------------------------------------------------------------------
// createProgram (Commander wiring)
// ---------------------------------------------------------------------------

describe('cli: program', () => {
  test('unknown command exits non-zero and does not throw uncaught', () => {
    const exits: number[] = [];
    const program = createProgram({
      exit: (code) => {
        exits.push(code);
        // Throw so `parseAsync` unwinds. We assert on `exits` below.
        throw new Error(`__exit_${code}__`);
      },
      emit: {
        json: () => {},
        pretty: () => {},
        error: () => {},
      },
    });
    // Commander's `parse` for an unknown command triggers its own error path
    // which calls our `exitOverride` -> we throw with `__exit_N__`.
    let caught: unknown = null;
    try {
      program.parse(['pullcast', 'bogus-command'], { from: 'user' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(exits.length).toBeGreaterThan(0);
    expect(exits[0]).not.toBe(0);
  });

  test('packs (deprecated) and gacha verbs are both registered in help', () => {
    const outputs: string[] = [];
    const program = createProgram({
      exit: (code) => {
        throw new Error(`__exit_${code}__`);
      },
      emit: { json: () => {}, pretty: () => {}, error: () => {} },
    });
    program.configureOutput({
      writeOut: (s) => outputs.push(s),
      writeErr: () => {},
    });
    try {
      program.parse(['pullcast', '--help'], { from: 'user' });
    } catch {
      // expected — commander exits after --help
    }
    const joined = outputs.join('');
    expect(joined).toContain('packs');
    expect(joined).toContain('gacha');
  });

  test('marketplace --help lists every mirrored flag', () => {
    const exits: number[] = [];
    const outputs: string[] = [];
    const program = createProgram({
      exit: (code) => {
        exits.push(code);
        throw new Error(`__exit_${code}__`);
      },
      emit: { json: () => {}, pretty: () => {}, error: () => {} },
    });
    program.configureOutput({
      writeOut: (s) => outputs.push(s),
      writeErr: (s) => outputs.push(s),
    });
    for (const cmd of program.commands) {
      cmd.configureOutput({
        writeOut: (s) => outputs.push(s),
        writeErr: (s) => outputs.push(s),
      });
    }
    try {
      program.parse(['marketplace', '--help'], { from: 'user' });
    } catch {
      // expected
    }
    const help = outputs.join('');
    // Every flag on `npx renaiss@0.0.3-beta.2 marketplace --help` must appear
    // here. `--character` was REMOVED upstream in 0.0.3-beta.2 (verified live
    // 2026-07-05); it must NOT be present. See tests below.
    for (const flag of [
      '--search',
      '--category',
      '--listed',
      '--language',
      '--grading',
      '--grade',
      '--year',
      '--price',
      '--sort',
      '--order',
      '--limit',
      '--offset',
    ]) {
      expect(help).toContain(flag);
    }
    expect(help).not.toContain('--character');
  });

  test('marketplace --character X fails with unknown option (parity with 0.0.3-beta.2)', () => {
    const errors: unknown[] = [];
    const exits: number[] = [];
    const program = createProgram({
      exit: (code) => {
        exits.push(code);
        throw new Error(`__exit_${code}__`);
      },
      emit: {
        json: () => {},
        pretty: () => {},
        error: (err) => {
          errors.push(err);
        },
      },
    });
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
    for (const cmd of program.commands) {
      cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    }
    try {
      program.parse(['marketplace', '--character', 'Pikachu'], { from: 'user' });
    } catch {
      // expected
    }
    expect(exits.length).toBeGreaterThan(0);
    expect(exits[0]).not.toBe(0);
  });

  test('card --help lists every mirrored flag', () => {
    const exits: number[] = [];
    const outputs: string[] = [];
    const program = createProgram({
      exit: (code) => {
        exits.push(code);
        throw new Error(`__exit_${code}__`);
      },
      emit: { json: () => {}, pretty: () => {}, error: () => {} },
    });
    program.configureOutput({
      writeOut: (s) => outputs.push(s),
      writeErr: (s) => outputs.push(s),
    });
    for (const cmd of program.commands) {
      cmd.configureOutput({
        writeOut: (s) => outputs.push(s),
        writeErr: (s) => outputs.push(s),
      });
    }
    try {
      program.parse(['card', '--help'], { from: 'user' });
    } catch {
      // expected
    }
    const help = outputs.join('');
    for (const flag of ['--price', '--activities', '--verbose', '--json']) {
      expect(help).toContain(flag);
    }
  });

  test('gacha --help lists list + info subcommands (no pull/buyback)', () => {
    const outputs: string[] = [];
    const program = createProgram({
      exit: (code) => {
        throw new Error(`__exit_${code}__`);
      },
      emit: { json: () => {}, pretty: () => {}, error: () => {} },
    });
    program.configureOutput({
      writeOut: (s) => outputs.push(s),
      writeErr: (s) => outputs.push(s),
    });
    for (const cmd of program.commands) {
      cmd.configureOutput({
        writeOut: (s) => outputs.push(s),
        writeErr: (s) => outputs.push(s),
      });
      for (const sub of cmd.commands) {
        sub.configureOutput({
          writeOut: (s) => outputs.push(s),
          writeErr: (s) => outputs.push(s),
        });
      }
    }
    try {
      program.parse(['gacha', '--help'], { from: 'user' });
    } catch {
      // expected
    }
    const help = outputs.join('');
    expect(help).toContain('list');
    expect(help).toContain('info');
    // Write verbs must NOT be present — PullCast is read-only.
    expect(help).not.toContain('gacha pull');
    expect(help).not.toContain('gacha buyback');
  });

  test('gacha list --help mirrors renaiss 0.0.3-beta.2 shape (same flags as deprecated packs)', () => {
    const outputs: string[] = [];
    const program = createProgram({
      exit: (code) => {
        throw new Error(`__exit_${code}__`);
      },
      emit: { json: () => {}, pretty: () => {}, error: () => {} },
    });
    program.configureOutput({
      writeOut: (s) => outputs.push(s),
      writeErr: (s) => outputs.push(s),
    });
    for (const cmd of program.commands) {
      cmd.configureOutput({
        writeOut: (s) => outputs.push(s),
        writeErr: (s) => outputs.push(s),
      });
      for (const sub of cmd.commands) {
        sub.configureOutput({
          writeOut: (s) => outputs.push(s),
          writeErr: (s) => outputs.push(s),
        });
      }
    }
    try {
      program.parse(['gacha', 'list', '--help'], { from: 'user' });
    } catch {
      // expected
    }
    const help = outputs.join('');
    for (const flag of ['--include-inactive', '--json']) {
      expect(help).toContain(flag);
    }
  });

  test('gacha info --help lists json flag', () => {
    const outputs: string[] = [];
    const program = createProgram({
      exit: (code) => {
        throw new Error(`__exit_${code}__`);
      },
      emit: { json: () => {}, pretty: () => {}, error: () => {} },
    });
    program.configureOutput({
      writeOut: (s) => outputs.push(s),
      writeErr: (s) => outputs.push(s),
    });
    for (const cmd of program.commands) {
      cmd.configureOutput({
        writeOut: (s) => outputs.push(s),
        writeErr: (s) => outputs.push(s),
      });
      for (const sub of cmd.commands) {
        sub.configureOutput({
          writeOut: (s) => outputs.push(s),
          writeErr: (s) => outputs.push(s),
        });
      }
    }
    try {
      program.parse(['gacha', 'info', '--help'], { from: 'user' });
    } catch {
      // expected
    }
    const help = outputs.join('');
    expect(help).toContain('--json');
    expect(help).toContain('packSlug');
  });

  test('top-level --help shows new banner text (0.0.3+ verb tree)', () => {
    const outputs: string[] = [];
    const program = createProgram({
      exit: (code) => {
        throw new Error(`__exit_${code}__`);
      },
      emit: { json: () => {}, pretty: () => {}, error: () => {} },
    });
    // Force color-off so ASCII assertions do not have to match ANSI codes.
    process.env.NO_COLOR = '1';
    program.configureOutput({
      writeOut: (s) => outputs.push(s),
      writeErr: () => {},
    });
    try {
      program.parse(['pullcast', '--help'], { from: 'user' });
    } catch {
      // expected
    }
    delete process.env.NO_COLOR;
    const help = outputs.join('');
    expect(help).toContain('Read-only PullCast layer');
    expect(help).toContain('gacha list');
    expect(help).toContain('gacha info');
    expect(help).toContain('0.0.3+');
  });

  test('deprecated `packs` alias emits deprecation warning to stderr and still runs the handler', async () => {
    const stderrWrites: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    // Type-safe monkey-patch scoped to this test.
    (process.stderr.write as unknown as (chunk: string) => boolean) = ((
      chunk: string
    ): boolean => {
      stderrWrites.push(String(chunk));
      return true;
    }) as (chunk: string) => boolean;

    let jsonEmitted: unknown = null;
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/api/packs')) {
        return new Response(
          JSON.stringify({ data: { packs: [{ slug: 'eden-pack', name: 'Eden Pack' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const program = createProgram({
      fetchImpl,
      exit: (code) => {
        if (code !== 0) throw new Error(`__exit_${code}__`);
      },
      emit: {
        json: (payload) => {
          jsonEmitted = payload;
        },
        pretty: () => {},
        error: () => {},
      },
    });
    try {
      await program.parseAsync(['packs', '--json'], { from: 'user' });
    } catch {
      // ignore — action may or may not throw
    }
    // Restore stderr.
    (process.stderr.write as unknown as typeof originalWrite) = originalWrite;

    const stderrJoined = stderrWrites.join('');
    expect(stderrJoined).toContain('deprecated');
    expect(stderrJoined).toContain('gacha list');
    expect(jsonEmitted).not.toBeNull();
    const env = jsonEmitted as { data: { packs: Array<{ slug?: string }> } };
    expect(env.data.packs[0]?.slug).toBe('eden-pack');
  });

  test('gacha info --json returns envelope with pack + odds blend', async () => {
    const fetchImpl: typeof fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.includes('/api/packs/eden-pack')) {
        return new Response(
          JSON.stringify({
            data: {
              pack: {
                slug: 'eden-pack',
                name: 'Eden Pack',
                packType: 'perpetual',
                stage: 'active',
                author: 'Renaiss x Logoman',
                priceInUsdt: '150000000000000000000',
                expectedValueInUsd: '15500',
                featuredCardFmvInUsd: '443400',
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/api/odds/eden-pack')) {
        return new Response(
          JSON.stringify({
            data: {
              packSlug: 'eden-pack',
              upstream_recent: {
                source:
                  'Renaiss main API GET /v0/packs/{slug}.cardPack.recentOpenedPacks',
                sampleSize: 30,
                tierFrequency: [
                  { tier: 'common', count: 17, pct: 0.5666 },
                  { tier: 'uncommon', count: 9, pct: 0.3 },
                  { tier: 'rare', count: 4, pct: 0.1333 },
                ],
                error: null,
              },
              empirical_90d: {
                source: 'PullCast indexer (trailing 90d, tracked packs only)',
                windowDays: 90,
                totalPulls: 423,
                insufficientSample: false,
                minSample: 10,
                tierFrequency: [
                  { tier: 'common', count: 245, pct: 0.579 },
                  { tier: 'uncommon', count: 118, pct: 0.279 },
                  { tier: 'rare', count: 48, pct: 0.113 },
                  { tier: 'epic', count: 12, pct: 0.028 },
                ],
                error: null,
              },
              divergence: [
                {
                  tier: 'common',
                  upstreamPct: 0.5666,
                  empiricalPct: 0.579,
                  deltaPct: -1.24,
                  flagged: false,
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    let jsonEmitted: unknown = null;
    const program = createProgram({
      fetchImpl,
      exit: (code) => {
        if (code !== 0) throw new Error(`__exit_${code}__`);
      },
      emit: {
        json: (payload) => {
          jsonEmitted = payload;
        },
        pretty: () => {},
        error: () => {},
      },
    });
    await program.parseAsync(['gacha', 'info', 'eden-pack', '--json'], {
      from: 'user',
    });
    expect(jsonEmitted).not.toBeNull();
    const env = jsonEmitted as {
      data: {
        pack: { slug?: string; name?: string };
        odds: {
          upstream_recent: { sampleSize: number };
          empirical_90d: { totalPulls: number };
          divergence: unknown[];
        };
      };
      sources: Array<{ url: string }>;
      warnings: Array<{ code: string }>;
    };
    expect(env.data.pack.slug).toBe('eden-pack');
    expect(env.data.pack.name).toBe('Eden Pack');
    expect(env.data.odds.upstream_recent.sampleSize).toBe(30);
    expect(env.data.odds.empirical_90d.totalPulls).toBe(423);
    expect(env.data.odds.divergence.length).toBe(1);
    expect(env.sources.length).toBeGreaterThanOrEqual(2);
    expect(env.warnings[0]!.code).toBe('BETA');
  });

  test('--version prints 0.0.1 and exits 0', () => {
    const exits: number[] = [];
    const outputs: string[] = [];
    const program = createProgram({
      exit: (code) => {
        exits.push(code);
        throw new Error(`__exit_${code}__`);
      },
      emit: { json: () => {}, pretty: () => {}, error: () => {} },
    });
    // Commander's version handler writes to stdout; we intercept by proxying
    // configureOutput on the created program instance.
    program.configureOutput({
      writeOut: (s) => outputs.push(s),
      writeErr: () => {},
    });
    try {
      program.parse(['pullcast', '--version'], { from: 'user' });
    } catch {
      // expected
    }
    expect(exits[0]).toBe(0);
    expect(outputs.join('')).toContain('0.0.1');
  });
});

// ---------------------------------------------------------------------------
// runSearch
// ---------------------------------------------------------------------------

describe('cli: search', () => {
  test('returns envelope with Index search results', async () => {
    const { impl } = mockFetch([
      {
        match: '/v1/search',
        body: {
          query: 'charizard',
          results: [
            {
              name: 'Charizard',
              gradeLabel: 'PSA 10',
              priceUsdCents: 125000,
              confidence: 'high',
            },
          ],
        },
      },
    ]);
    const env = await runSearch(
      'charizard',
      { limit: 5 },
      makeContext({ fetchImpl: impl })
    );
    expect(env.data.query).toBe('charizard');
    expect(env.data.results).toHaveLength(1);
    expect(env.data.results[0]!.name).toBe('Charizard');
    expect(env.sources[0]!.url).toContain('/v1/search');
    expect(env.warnings[0]!.code).toBe('BETA');
  });

  test('rejects query shorter than 2 chars', async () => {
    await expect(runSearch('a', {}, makeContext())).rejects.toThrow(/2 characters/);
  });

  test('formatSearch renders disclosure', () => {
    const text = formatSearch('pikachu', [
      { name: 'Pikachu', gradeLabel: 'PSA 9', priceUsdCents: 5000 },
    ]);
    expect(text).toContain('Pikachu');
    expect(text).toContain(BETA_DISCLOSURE_LINE);
  });
});

describe('cli: set', () => {
  test('returns envelope with set listing', async () => {
    const { impl } = mockFetch([
      {
        match: '/v1/sets/pokemon/',
        body: {
          game: 'pokemon',
          setName: 'Pokemon 151',
          cardCount: 2,
          cards: [
            { name: 'Mew ex', gradeLabel: 'PSA 10', priceUsdCents: 125000 },
            { name: 'Pikachu', gradeLabel: 'PSA 9', priceUsdCents: 5000 },
          ],
        },
      },
    ]);
    const env = await runSet(
      'pokemon',
      'pokemon-japanese-sv2a-pokemon-151',
      makeContext({ fetchImpl: impl })
    );
    expect(env.data.setName).toBe('Pokemon 151');
    expect(env.data.cards).toHaveLength(2);
    expect(env.sources[0]!.url).toContain('/v1/sets');
  });
});
