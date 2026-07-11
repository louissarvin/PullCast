import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import {
  buildIndexAuthHeaders,
  hasIndexPartnerAuth,
} from '../src/lib/renaiss-index/index-headers.ts';

describe('index-headers', () => {
  const prevKey = process.env.RENAISS_INDEX_KEY_ID;
  const prevSecret = process.env.RENAISS_INDEX_SECRET;

  beforeEach(() => {
    delete process.env.RENAISS_INDEX_KEY_ID;
    delete process.env.RENAISS_INDEX_SECRET;
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.RENAISS_INDEX_KEY_ID;
    else process.env.RENAISS_INDEX_KEY_ID = prevKey;
    if (prevSecret === undefined) delete process.env.RENAISS_INDEX_SECRET;
    else process.env.RENAISS_INDEX_SECRET = prevSecret;
  });

  test('buildIndexAuthHeaders omits partner keys when unset', () => {
    const headers = buildIndexAuthHeaders();
    expect(headers.accept).toBe('application/json');
    expect(headers['X-Api-Key']).toBeUndefined();
    expect(headers['X-Api-Secret']).toBeUndefined();
    expect(hasIndexPartnerAuth()).toBe(false);
  });

  test('buildIndexAuthHeaders includes partner keys when both set', () => {
    process.env.RENAISS_INDEX_KEY_ID = 'pk_test';
    process.env.RENAISS_INDEX_SECRET = 'sk_test';
    const headers = buildIndexAuthHeaders({ accept: 'text/event-stream' });
    expect(headers['X-Api-Key']).toBe('pk_test');
    expect(headers['X-Api-Secret']).toBe('sk_test');
    expect(headers.accept).toBe('text/event-stream');
    expect(hasIndexPartnerAuth()).toBe(true);
  });
});
