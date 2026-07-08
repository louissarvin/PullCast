/**
 * Canonical PullCast REST envelope. Every /api/* success response must be
 * shaped by `buildEnvelope` so the client sees ONE contract regardless of the
 * route. Before this helper existed the D8 route surface drifted into three
 * shapes (flat with success/error, flat without, and double-nested `data.data`
 * via `attachDisclosure`). See memory/d8-code-review.md MAJOR #3.
 *
 * Shape:
 *   {
 *     success: true,
 *     error:   null,
 *     data:    T,
 *     sources: Array<{ label, url }>,
 *     warnings: Array<{ code, message }>,
 *     generated_at: <ISO 8601>,
 *   }
 *
 * The `warnings` array ALWAYS carries `BETA_WARNING` when the caller does not
 * supply their own warnings block. Warnings are additive: pass extra codes via
 * `opts.warnings` and BETA is retained. To omit BETA (rare — internal / debug
 * routes only) pass `{ warnings: [], includeBeta: false }`.
 *
 * The `_disclosure` marker is folded into `data` via a shallow spread so the
 * legacy client contract (parts of the frontend still read `data._disclosure`)
 * keeps working.
 */

import { DISCLOSURE_TEXT_FULL } from '../lib/disclosure/index.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnvelopeSource {
  label: string;
  url: string;
}

export interface EnvelopeWarning {
  code: string;
  message: string;
}

export interface Envelope<T> {
  success: true;
  error: null;
  data: T;
  sources: EnvelopeSource[];
  warnings: EnvelopeWarning[];
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Canonical BETA warning (file 17 §7). This is the exact copy required by the
// PullCast Safety criterion. Do NOT paraphrase; downstream Discord embeds and
// AI responses key off this string.
// ---------------------------------------------------------------------------

export const BETA_WARNING: EnvelopeWarning = {
  code: 'BETA',
  message:
    'Beta data from Renaiss API and Renaiss Index API (experimental). Sources cited. Not financial advice.',
} as const;

// ---------------------------------------------------------------------------
// Standard upstream source labels. Route files should prefer these constants
// over inline literals so the disclosure surface stays consistent.
// ---------------------------------------------------------------------------

export const SOURCE_RENAISS_MAIN: EnvelopeSource = {
  label: 'Renaiss main API (beta)',
  url: 'https://api.renaiss.xyz',
} as const;

export const SOURCE_RENAISS_INDEX: EnvelopeSource = {
  label: 'Renaiss OS Index (beta)',
  url: 'https://api.renaissos.com/v1',
} as const;

export const SOURCE_BSC_ORDERBOOK: EnvelopeSource = {
  label: 'Orderbook TradeExecutedV2 (on-chain BSC)',
  url: 'https://bscscan.com',
} as const;

export const SOURCE_BSC_TVM: EnvelopeSource = {
  label: 'TokenVendingMachine PackOpened (on-chain BSC)',
  url: 'https://bscscan.com',
} as const;

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export interface BuildEnvelopeOptions {
  sources?: EnvelopeSource[];
  warnings?: EnvelopeWarning[];
  /**
   * Whether to prepend BETA_WARNING to `warnings`. Defaults to true. Only set
   * to false on internal / non-consumer routes.
   */
  includeBeta?: boolean;
  /**
   * Whether to embed `_disclosure: DISCLOSURE_TEXT_FULL` into `data`. Defaults
   * to true when `data` is a plain object so legacy consumers keep working.
   * Automatically skipped when `data` is not a plain object (array, primitive,
   * null).
   */
  attachDisclosure?: boolean;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

export const buildEnvelope = <T>(
  data: T,
  opts: BuildEnvelopeOptions = {}
): Envelope<T> => {
  const includeBeta = opts.includeBeta ?? true;
  const warnings: EnvelopeWarning[] = [];
  if (includeBeta) warnings.push(BETA_WARNING);
  if (opts.warnings) {
    for (const w of opts.warnings) {
      // Deduplicate BETA if the caller already included it explicitly.
      if (includeBeta && w.code === 'BETA') continue;
      warnings.push(w);
    }
  }

  const attach = opts.attachDisclosure ?? true;
  let finalData: T = data;
  if (attach && isPlainObject(data)) {
    finalData = { ...(data as Record<string, unknown>), _disclosure: DISCLOSURE_TEXT_FULL } as T;
  }

  return {
    success: true,
    error: null,
    data: finalData,
    sources: opts.sources ?? [],
    warnings,
    generated_at: new Date().toISOString(),
  };
};

