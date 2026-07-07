/**
 * /listing entrypoint. Suggests a deterministic listing price range
 * (low / mid / high) for a graded card, then asks Anthropic to EXPLAIN the
 * reasoning with citations.
 *
 * SAFETY BOUNDARY (load-bearing):
 *   - The NUMBERS are computed deterministically from real Renaiss data.
 *     The AI never touches them.
 *   - The AI is only allowed to write the EXPLANATION, which is then forced
 *     through the same citation guard pipeline as /explain.
 *
 * Range formula (per brief):
 *   - mid  = primary FMV (Index API graded value if confidence === 'high';
 *            otherwise main API FMV).
 *   - low  = min(comparable trade prices) * 0.95   (or fall back to mid * 0.85
 *            when comparables are missing)
 *   - high = max(comparable trade prices) * 1.05   (or fall back to mid * 1.15
 *            when comparables are missing)
 */

import {
  AnthropicUnavailableError,
  getAnthropic,
  isAnthropicAvailable,
} from './client.ts';
import {
  AnthropicBudgetError,
  assertTokenBudget,
  recordTokenSpend,
} from './budget.ts';
import {
  appendDisclosureFooter,
  assertGroundingChunks,
  enforceCitations,
  stripUnreferencedCitations,
} from './citation-guard.ts';
import {
  buildListingPrompt,
  SYSTEM_LISTING,
  UNCITED_REFUSAL,
} from './prompts.ts';
import {
  gatherSourcesForCert,
  gatherSourcesForTokenId,
  type Source,
} from './retriever.ts';
import {
  getOrFetchCert,
  IndexApiError,
  renaissIndex,
} from '../renaiss-index/index.ts';
import { renaissApi, parsePriceCents, RenaissApiError } from '../renaiss/index.ts';
import { GROQ_MODEL } from '../../config/main-config.ts';

const LOG_PREFIX = '[listing]';

export interface ListingResult {
  text: string;
  sources: Source[];
  rangeLowUsdCents: number | null;
  rangeMidUsdCents: number | null;
  rangeHighUsdCents: number | null;
  comparableCount: number;
  primaryFmvUsdCents: number | null;
  primarySource: string;
  confidence: 'high' | 'medium' | 'low' | null;
  card: {
    name: string | null;
    setName: string | null;
    grade: string | null;
    cardId: string | null;
    cert: string | null;
  };
  refused?: { reason: string };
}

const refusal = (reason: string, text: string): ListingResult => ({
  text: appendDisclosureFooter(text),
  sources: [],
  rangeLowUsdCents: null,
  rangeMidUsdCents: null,
  rangeHighUsdCents: null,
  comparableCount: 0,
  primaryFmvUsdCents: null,
  primarySource: 'none',
  confidence: null,
  card: { name: null, setName: null, grade: null, cardId: null, cert: null },
  refused: { reason },
});

interface TradeRow {
  priceUsdCents?: number | null;
  occurredAt?: string;
  source?: string;
}

const tradePrices = (trades: TradeRow[]): number[] => {
  return trades
    .map((t) => (typeof t.priceUsdCents === 'number' ? t.priceUsdCents : null))
    .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
};

const stringOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

interface ResolvedCard {
  name: string | null;
  setName: string | null;
  grade: string | null;
  cardId: string | null;
  cert: string | null;
  mainApiFmv: number | null;
  indexApiFmv: number | null;
  confidence: 'high' | 'medium' | 'low' | null;
}

/**
 * Pull deterministic FMV + identity info from the Renaiss surfaces.
 *
 * For a cert: cert lookup gives indexApiFmv + confidence + cardId; we cannot
 * fetch a tokenId-keyed mainApiFmv since the cert doesn't carry that.
 *
 * For a tokenId: main API gives mainApiFmv + serial; if serial present, the
 * cert lookup gives indexApiFmv + confidence + cardId.
 */
const resolveCardForCert = async (cert: string): Promise<ResolvedCard> => {
  const out: ResolvedCard = {
    name: null,
    setName: null,
    grade: null,
    cardId: null,
    cert: cert,
    mainApiFmv: null,
    indexApiFmv: null,
    confidence: null,
  };
  try {
    const lookup = await getOrFetchCert(cert);
    if (lookup.found === true) {
      const card = (lookup.card ?? {}) as Record<string, unknown>;
      out.name = stringOrNull(card.name);
      out.setName = stringOrNull(card.setName);
      out.grade = stringOrNull(card.grade);
      out.confidence = (card.confidence ?? null) as 'high' | 'medium' | 'low' | null;
      out.indexApiFmv = parsePriceCents(
        (card as { priceUsdCents?: number | null }).priceUsdCents ?? null
      );
      const id = (card as Record<string, unknown>).id ?? (card as Record<string, unknown>).cardId;
      if (typeof id === 'string' && id.length > 0) out.cardId = id;
    }
  } catch (err) {
    if (err instanceof IndexApiError) {
      console.warn(`${LOG_PREFIX} cert lookup failed cert=${cert} status=${err.status}`);
    } else {
      console.error(`${LOG_PREFIX} cert lookup unexpected cert=${cert}:`, err);
    }
  }
  return out;
};

const resolveCardForTokenId = async (tokenId: string): Promise<ResolvedCard> => {
  const out: ResolvedCard = {
    name: null,
    setName: null,
    grade: null,
    cardId: null,
    cert: null,
    mainApiFmv: null,
    indexApiFmv: null,
    confidence: null,
  };
  let card: unknown = null;
  try {
    card = await renaissApi.getCard(tokenId, { verbosePrice: true });
  } catch (err) {
    if (err instanceof RenaissApiError) {
      console.warn(`${LOG_PREFIX} main API failed token=${tokenId} status=${err.status}`);
    } else {
      console.error(`${LOG_PREFIX} main API unexpected token=${tokenId}:`, err);
    }
    return out;
  }
  const c = (card ?? {}) as Record<string, unknown>;
  out.name = stringOrNull(c.name);
  out.setName = stringOrNull(c.setName);
  out.grade = stringOrNull(c.grade);
  out.mainApiFmv = parsePriceCents(
    (c as { fmvPriceInUSD?: unknown }).fmvPriceInUSD as
      | string
      | number
      | null
      | undefined
  );

  // Pull serial from attributes.
  let serial: string | null = stringOrNull(c.serial);
  if (serial === null && Array.isArray(c.attributes)) {
    for (const a of c.attributes) {
      if (typeof a !== 'object' || a === null) continue;
      const t = (a as { trait_type?: unknown }).trait_type;
      const v = (a as { value?: unknown }).value;
      if (typeof t !== 'string') continue;
      const lower = t.toLowerCase();
      if (
        lower === 'serial' ||
        lower === 'cert' ||
        lower === 'cert number' ||
        lower === 'certification'
      ) {
        if (typeof v === 'string' && v.length > 0) {
          serial = v;
          break;
        }
      }
    }
  }

  if (serial !== null) {
    const certUpper = serial.toUpperCase();
    out.cert = certUpper;
    try {
      const lookup = await getOrFetchCert(certUpper);
      if (lookup.found === true) {
        const card2 = (lookup.card ?? {}) as Record<string, unknown>;
        out.indexApiFmv = parsePriceCents(
          (card2 as { priceUsdCents?: number | null }).priceUsdCents ?? null
        );
        out.confidence = (card2.confidence ?? null) as 'high' | 'medium' | 'low' | null;
        const id = (card2 as Record<string, unknown>).id ?? (card2 as Record<string, unknown>).cardId;
        if (typeof id === 'string' && id.length > 0) out.cardId = id;
        // Prefer Index API metadata when available (more authoritative).
        out.name = out.name ?? stringOrNull(card2.name);
        out.setName = out.setName ?? stringOrNull(card2.setName);
        out.grade = out.grade ?? stringOrNull(card2.grade);
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} index lookup failed cert=${certUpper}:`, err);
    }
  }

  return out;
};

/**
 * Compute the deterministic listing range from FMV + comparable trades.
 *
 * primaryFmv:
 *   - If Index API value present AND confidence === 'high' -> Index value.
 *   - Else if Index API value present -> Index value (still better than main).
 *   - Else main API value.
 *   - Else null.
 *
 * Range with comparables (>= 1):
 *   - low  = min(prices) * 0.95
 *   - high = max(prices) * 1.05
 *   - mid  = primaryFmv (clamped into [low, high] if outside)
 *
 * Range without comparables (fallback):
 *   - low  = primaryFmv * 0.85
 *   - high = primaryFmv * 1.15
 *   - mid  = primaryFmv
 */
const computeRange = (
  primaryFmv: number | null,
  prices: number[]
): {
  low: number | null;
  mid: number | null;
  high: number | null;
} => {
  if (prices.length > 0) {
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const low = Math.round(min * 0.95);
    const high = Math.round(max * 1.05);
    if (primaryFmv === null) {
      // Use comparable median as mid when FMV missing.
      const sorted = [...prices].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      return { low, mid: median, high };
    }
    const mid = Math.min(Math.max(primaryFmv, low), high);
    return { low, mid, high };
  }
  if (primaryFmv === null) {
    return { low: null, mid: null, high: null };
  }
  return {
    low: Math.round(primaryFmv * 0.85),
    mid: primaryFmv,
    high: Math.round(primaryFmv * 1.15),
  };
};

/**
 * OpenAI-compatible chat completion response shape (Groq mirrors this).
 * Only the fields we consume are typed.
 */
interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
interface ChatCompletionChoice {
  message?: { role?: string; content?: string | null };
  finish_reason?: string;
}
interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
}

const extractText = (resp: ChatCompletionResponse): string => {
  const choices = Array.isArray(resp?.choices) ? resp.choices : [];
  const first = choices[0];
  const content = first?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
};

export const listingSuggest = async (input: {
  tokenId?: string;
  cert?: string;
}): Promise<ListingResult> => {
  const hasToken = typeof input.tokenId === 'string' && input.tokenId.length > 0;
  const hasCert = typeof input.cert === 'string' && input.cert.length > 0;

  if (hasToken === hasCert) {
    return refusal(
      'invalid-input',
      'Provide exactly one of tokenId or cert (not both, not neither).'
    );
  }

  if (!isAnthropicAvailable()) {
    return refusal('ai-disabled', 'AI is currently disabled on this deployment.');
  }

  // 1. Resolve card identity + FMVs.
  const card = hasCert
    ? await resolveCardForCert(input.cert as string)
    : await resolveCardForTokenId(input.tokenId as string);

  // primaryFmv selection
  let primaryFmv: number | null = null;
  let primarySource: string = 'none';
  if (card.indexApiFmv !== null && card.confidence === 'high') {
    primaryFmv = card.indexApiFmv;
    primarySource = 'Renaiss Index API (graded, high confidence)';
  } else if (card.indexApiFmv !== null) {
    primaryFmv = card.indexApiFmv;
    primarySource = `Renaiss Index API (graded, ${card.confidence ?? 'unknown'} confidence)`;
  } else if (card.mainApiFmv !== null) {
    primaryFmv = card.mainApiFmv;
    primarySource = 'Renaiss main API';
  }

  // 2. Fetch comparable trades (deterministic data path).
  let comparablePrices: number[] = [];
  if (card.cardId !== null) {
    try {
      const trades = (await renaissIndex.getCardTrades(card.cardId, {
        limit: 3,
      })) as TradeRow[];
      comparablePrices = tradePrices(trades);
    } catch (err) {
      console.warn(`${LOG_PREFIX} trades failed cardId=${card.cardId}:`, err);
    }
  }

  // 3. Compute the deterministic range.
  const range = computeRange(primaryFmv, comparablePrices);

  if (range.mid === null) {
    return refusal(
      'no-fmv',
      'Cannot compute a listing range: no FMV available from main or Index API.'
    );
  }

  // 4. Retrieve sources for the prompt context.
  let sources: Source[];
  try {
    sources = hasCert
      ? await gatherSourcesForCert(input.cert as string)
      : await gatherSourcesForTokenId(input.tokenId as string);
  } catch (err) {
    console.error(`${LOG_PREFIX} retriever crashed:`, err);
    return refusal('retriever-error', 'Could not load grounding data.');
  }

  const grounding = assertGroundingChunks(sources);
  if (!grounding.ok) {
    return refusal(grounding.reason, grounding.refusal);
  }

  // 5. Build prompt + budget check.
  const userPrompt = buildListingPrompt({
    card: {
      name: card.name,
      setName: card.setName,
      grade: card.grade,
      cardId: card.cardId,
      cert: card.cert,
    },
    fmv: {
      primaryFmvUsdCents: primaryFmv,
      primarySource,
      confidence: card.confidence,
    },
    range: {
      lowUsdCents: range.low,
      midUsdCents: range.mid,
      highUsdCents: range.high,
      comparableCount: comparablePrices.length,
    },
    sources,
  });

  const estimated = Math.ceil(
    (userPrompt.length + SYSTEM_LISTING.length + JSON.stringify(sources).length) / 4
  );
  try {
    await assertTokenBudget(estimated);
  } catch (err) {
    if (err instanceof AnthropicBudgetError) {
      return refusal(err.kind, err.message);
    }
    console.error(`${LOG_PREFIX} budget check unexpected:`, err);
    return refusal('budget-error', 'AI temporarily unavailable.');
  }

  // 6. LLM call (Groq via OpenAI-compatible chat completions).
  let response: ChatCompletionResponse;
  try {
    const client = getAnthropic();
    response = (await client.chat.completions.create({
      model: GROQ_MODEL,
      max_tokens: 700,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_LISTING },
        { role: 'user', content: userPrompt },
      ],
    })) as unknown as ChatCompletionResponse;
  } catch (err) {
    if (err instanceof AnthropicUnavailableError) {
      return refusal('ai-disabled', 'AI is currently disabled.');
    }
    console.error(`${LOG_PREFIX} groq call failed:`, err);
    return refusal('groq-error', 'AI service is temporarily unavailable.');
  }

  // 7. Record spend. Groq usage is OpenAI-shape:
  //    prompt_tokens + completion_tokens (not input/output_tokens).
  const inputTokens = response.usage?.prompt_tokens ?? estimated;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  recordTokenSpend(inputTokens, outputTokens).catch((err: unknown) => {
    console.warn(`${LOG_PREFIX} recordTokenSpend failed:`, err);
  });

  // 8. Citation guard pipeline.
  let text = extractText(response);
  if (text.length === 0) {
    return refusal('empty-response', 'AI returned an empty response.');
  }
  text = stripUnreferencedCitations(text, sources);
  const enforce = enforceCitations(text, sources);
  if (!enforce.ok) {
    console.warn(`${LOG_PREFIX} enforce failed reason=${enforce.reason}`);
    return refusal(
      `uncited-response:${enforce.reason ?? 'unknown'}`,
      UNCITED_REFUSAL
    );
  }

  const finalText = appendDisclosureFooter(text);
  console.log(
    `${LOG_PREFIX} ok cardId=${card.cardId ?? 'none'} cert=${card.cert ?? 'none'} mid=${range.mid} input=${inputTokens} output=${outputTokens}`
  );

  return {
    text: finalText,
    sources,
    rangeLowUsdCents: range.low,
    rangeMidUsdCents: range.mid,
    rangeHighUsdCents: range.high,
    comparableCount: comparablePrices.length,
    primaryFmvUsdCents: primaryFmv,
    primarySource,
    confidence: card.confidence,
    card: {
      name: card.name,
      setName: card.setName,
      grade: card.grade,
      cardId: card.cardId,
      cert: card.cert,
    },
  };
};
