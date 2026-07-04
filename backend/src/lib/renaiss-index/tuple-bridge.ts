/**
 * Tuple Bridge — third FMV path when cert and rid are unavailable.
 *
 * Uses Renaiss OS Index structural identity (set_name, item_no, language)
 * documented at https://index.renaissos.com/api-docs
 *
 * Priority:
 *   1. GET /v1/index/item-by-no (when deployed)
 *   2. GET /v1/search fallback (live today)
 */

import { renaissIndex } from './client.ts';
import { IndexApiError } from './errors.ts';
import type { IndexSearchResult } from './types.ts';

const LOG_PREFIX = '[tuple-bridge]';

export interface TupleIdentity {
  setName: string;
  itemNo: string;
  language?: string | null;
  variation?: string;
  gradingCompany?: string | null;
  grade?: string | null;
}

export interface TupleBridgeHit {
  source: 'tuple';
  fmvUsdCents: number;
  confidence: 'high' | 'medium' | 'low' | null;
  lastSaleAt: string | null;
  match: IndexSearchResult;
}

const mapLanguage = (raw: string | null | undefined): string => {
  if (!raw || typeof raw !== 'string') return 'en';
  const lower = raw.trim().toLowerCase();
  if (lower.startsWith('jap') || lower === 'ja' || lower === 'japanese') return 'ja';
  if (lower.startsWith('eng') || lower === 'en' || lower === 'english') return 'en';
  return lower.slice(0, 2) || 'en';
};

const norm = (s: string | null | undefined): string =>
  typeof s === 'string' ? s.toLowerCase().replace(/[^a-z0-9]/g, '') : '';

const pickGradeMatch = (
  candidates: IndexSearchResult[],
  gradingCompany?: string | null,
  grade?: string | null
): IndexSearchResult | null => {
  if (candidates.length === 0) return null;
  const company = norm(gradingCompany);
  const gradeNorm = norm(grade);

  if (company || gradeNorm) {
    const exact = candidates.find((c) => {
      const cCompany = norm((c as { company?: string }).company);
      const cGrade = norm((c as { grade?: string }).grade ?? (c as { gradeLabel?: string }).gradeLabel);
      const companyOk = !company || cCompany.includes(company) || company.includes(cCompany);
      const gradeOk = !gradeNorm || cGrade.includes(gradeNorm) || gradeNorm.includes(cGrade);
      return companyOk && gradeOk;
    });
    if (exact) return exact;
  }

  const withPrice = candidates.find(
    (c) => typeof c.priceUsdCents === 'number' && Number.isFinite(c.priceUsdCents)
  );
  return withPrice ?? candidates[0] ?? null;
};

/**
 * Resolve FMV via structural tuple. Returns null on miss; never throws.
 */
export const lookupTupleBridge = async (
  tuple: TupleIdentity
): Promise<TupleBridgeHit | null> => {
  if (!tuple.setName?.trim() || !tuple.itemNo?.trim()) return null;

  const language = mapLanguage(tuple.language);
  let candidates: IndexSearchResult[] = [];

  try {
    const tiers = await renaissIndex.getItemByTuple({
      setName: tuple.setName.trim(),
      itemNo: tuple.itemNo.trim(),
      variation: tuple.variation ?? '',
      language,
    });
    if (tiers && tiers.length > 0) candidates = tiers;
  } catch (err) {
    if (!(err instanceof IndexApiError)) {
      console.warn(`${LOG_PREFIX} item-by-no error:`, err);
    }
  }

  if (candidates.length === 0) {
    try {
      const q = `${tuple.setName} ${tuple.itemNo}`.trim();
      candidates = await renaissIndex.searchCards(q, { limit: 8 });
    } catch (err) {
      console.warn(`${LOG_PREFIX} search fallback error:`, err);
      return null;
    }
  }

  const match = pickGradeMatch(candidates, tuple.gradingCompany, tuple.grade);
  if (
    match === null ||
    typeof match.priceUsdCents !== 'number' ||
    !Number.isFinite(match.priceUsdCents)
  ) {
    return null;
  }

  const confidenceRaw = (match as { confidence?: string }).confidence;
  const confidence =
    confidenceRaw === 'high' || confidenceRaw === 'medium' || confidenceRaw === 'low'
      ? confidenceRaw
      : null;

  console.log(
    `${LOG_PREFIX} hit set=${tuple.setName} no=${tuple.itemNo} fmv=${match.priceUsdCents}`
  );

  return {
    source: 'tuple',
    fmvUsdCents: match.priceUsdCents,
    confidence,
    lastSaleAt:
      typeof (match as { lastSaleAt?: string }).lastSaleAt === 'string'
        ? (match as { lastSaleAt: string }).lastSaleAt
        : null,
    match,
  };
};
