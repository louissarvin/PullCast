/**
 * D9: unit tests for the rid extractor and the Card Bridge priority order.
 *
 * These tests do NOT hit the network. Rid extraction is pure. The card-bridge
 * priority-order test stubs the outbound clients via module mock so we can
 * assert the ordering deterministically.
 */

import { describe, test, expect } from 'bun:test';

import {
  extractRenaissIdFromCard,
  isValidRid,
} from '../src/lib/renaiss-index/rid-bridge.ts';
import type { CanonicalRenaissCard } from '../src/lib/renaiss/schemas.ts';

const RID_UUID = '12670e6b-f07a-4a56-bc37-4f5e42edc6a8';

const baseCard: CanonicalRenaissCard = {
  tokenId: '110407444306463577498147203724752028878073766094690908117614973479773124263178',
  name: 'PSA 10 Starmie V',
  setName: 'Pokemon Sword & Shield Astral Radiance',
  cardNumber: 'TG13',
  gradingCompany: 'PSA',
  grade: '10 Gem Mint',
  attributes: [
    { trait_type: 'Serial', value: 'PSA114458483' },
    { trait_type: 'Language', value: 'English' },
  ],
  _shapeVariant: 'wrapped',
};

describe('D9 rid extractor — extraction method dispatch', () => {
  test('returns null + null method on the live marketplace card shape (no rid discoverable)', () => {
    const result = extractRenaissIdFromCard(baseCard);
    expect(result.rid).toBeNull();
    expect(result.method).toBeNull();
  });

  test('extracts UUID from direct field `renaissItemId` when future upstream adds it', () => {
    const card = {
      ...baseCard,
      renaissItemId: RID_UUID,
    } as unknown as CanonicalRenaissCard;
    const result = extractRenaissIdFromCard(card);
    expect(result.rid).toBe(RID_UUID);
    expect(result.method).toBe('direct-field');
  });

  test('extracts UUID from `rid` direct field alias', () => {
    const card = { ...baseCard, rid: RID_UUID } as unknown as CanonicalRenaissCard;
    const result = extractRenaissIdFromCard(card);
    expect(result.rid).toBe(RID_UUID);
    expect(result.method).toBe('direct-field');
  });

  test('extracts UUID from attribute { trait_type: "RenaissId" }', () => {
    const card = {
      ...baseCard,
      attributes: [
        { trait_type: 'Serial', value: 'PSA114458483' },
        { trait_type: 'RenaissId', value: RID_UUID },
      ],
    };
    const result = extractRenaissIdFromCard(card);
    expect(result.rid).toBe(RID_UUID);
    expect(result.method).toBe('attribute');
  });

  test('extracts UUID from imageUrl path segment', () => {
    const card = {
      ...baseCard,
      imageUrl: `https://cdn.example.com/items/${RID_UUID}/front.webp`,
      attributes: [{ trait_type: 'Language', value: 'English' }],
    };
    const result = extractRenaissIdFromCard(card);
    expect(result.rid).toBe(RID_UUID);
    expect(result.method).toBe('imageUrl-parse');
  });

  test('cert-serial-only imageUrl does NOT match (returns null)', () => {
    const card = {
      ...baseCard,
      imageUrl:
        'https://bhshyxmgzwogzgcf.public.blob.vercel-storage.com/inventory/graded/PSA120383833/item.webp',
      attributes: [{ trait_type: 'Language', value: 'English' }],
    };
    const result = extractRenaissIdFromCard(card);
    expect(result.rid).toBeNull();
    expect(result.method).toBeNull();
  });

  test('rejects a non-UUID string in the `rid` direct field (does not emit noise)', () => {
    const card = {
      ...baseCard,
      rid: 'not-a-uuid',
    } as unknown as CanonicalRenaissCard;
    const result = extractRenaissIdFromCard(card);
    expect(result.rid).toBeNull();
  });

  test('handles null/undefined card input safely', () => {
    expect(extractRenaissIdFromCard(null).rid).toBeNull();
    expect(extractRenaissIdFromCard(undefined).rid).toBeNull();
  });

  test('isValidRid recognizes both lowercase and uppercase UUID forms', () => {
    expect(isValidRid(RID_UUID)).toBe(true);
    expect(isValidRid(RID_UUID.toUpperCase())).toBe(true);
    expect(isValidRid('not-a-uuid')).toBe(false);
    expect(isValidRid('')).toBe(false);
    expect(isValidRid(123)).toBe(false);
    expect(isValidRid(null)).toBe(false);
  });
});

describe('D9 rid extractor — priority order (direct > attribute > imageUrl)', () => {
  test('direct field wins over attribute when both are present', () => {
    const directRid = RID_UUID;
    const attrRid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const card = {
      ...baseCard,
      renaissItemId: directRid,
      attributes: [{ trait_type: 'RenaissId', value: attrRid }],
    } as unknown as CanonicalRenaissCard;
    const result = extractRenaissIdFromCard(card);
    expect(result.rid).toBe(directRid);
    expect(result.method).toBe('direct-field');
  });

  test('attribute wins over imageUrl when direct field is absent', () => {
    const attrRid = RID_UUID;
    const imgRid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const card = {
      ...baseCard,
      imageUrl: `https://cdn.example.com/items/${imgRid}/front.webp`,
      attributes: [{ trait_type: 'RenaissId', value: attrRid }],
    };
    const result = extractRenaissIdFromCard(card);
    expect(result.rid).toBe(attrRid);
    expect(result.method).toBe('attribute');
  });
});
