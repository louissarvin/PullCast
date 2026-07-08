/**
 * PullCast CLI envelope.
 *
 * Every command that returns data MUST wrap the payload in this shape before
 * emitting. It mirrors the /api/market envelope from the backend so downstream
 * skills / bots / dashboards can rely on ONE contract across CLI and REST.
 *
 * Shape:
 *   { data, sources: [{ label, url }], warnings: [{ code, message }], generated_at }
 *
 * The `warnings` array always contains `{ code: "BETA", ... }`. This satisfies
 * the Renaiss builder disclosure requirement.
 */

export interface EnvelopeSource {
  label: string;
  url: string;
}

export interface EnvelopeWarning {
  code: string;
  message: string;
}

export interface Envelope<T> {
  data: T;
  sources: EnvelopeSource[];
  warnings: EnvelopeWarning[];
  generated_at: string;
}

export const BETA_WARNING: EnvelopeWarning = {
  code: 'BETA',
  message:
    'Experimental beta data from Renaiss APIs. Not financial advice.',
};

export const BETA_DISCLOSURE_LINE =
  'Experimental beta data from Renaiss APIs. Not financial advice.';

export function envelope<T>(data: T, sources: EnvelopeSource[]): Envelope<T> {
  return {
    data,
    sources,
    warnings: [BETA_WARNING],
    generated_at: new Date().toISOString(),
  };
}
