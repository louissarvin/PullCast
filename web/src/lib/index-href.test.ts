import { describe, expect, test } from 'bun:test'
import { indexCardGalleryPath, parseIndexCardHref, stripGradeSuffix } from './index-href'

describe('index-href', () => {
  test('parseIndexCardHref from relative path', () => {
    const parts = parseIndexCardHref(
      '/card/pokemon/pokemon-japanese-sv2a-pokemon-151/187-mew-ex-psa-10-abc123',
    )
    expect(parts).toEqual({
      game: 'pokemon',
      set: 'pokemon-japanese-sv2a-pokemon-151',
      card: '187-mew-ex-psa-10-abc123',
    })
  })

  test('indexCardGalleryPath builds PullCast route', () => {
    expect(
      indexCardGalleryPath('/card/pokemon/my-set/my-card-psa-10'),
    ).toBe('/card/pokemon/my-set/my-card-psa-10')
  })

  test('stripGradeSuffix removes company and grade tail', () => {
    expect(stripGradeSuffix('114-raikou-holo-psa-10-fbd95fe2')).toBe('114-raikou-holo')
    expect(stripGradeSuffix('187-mew-ex')).toBe('187-mew-ex')
  })
})
