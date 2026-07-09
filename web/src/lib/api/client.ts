import { env } from '@/env'

// ─── Envelope types ───────────────────────────────────────────────────────

export interface ApiSource {
  label: string
  url: string
}

export interface ApiWarning {
  code: string
  message: string
}

export interface ApiError {
  code: string
  message: string
}

interface ApiEnvelope<T> {
  success: boolean
  error: ApiError | null
  data: T
  sources: Array<ApiSource>
  warnings: Array<ApiWarning>
  generated_at: string
}

/** Unwrapped result returned from every client helper */
export interface ApiResult<T> {
  data: T
  sources: Array<ApiSource>
  warnings: Array<ApiWarning>
  generatedAt: string
}

/** Thrown when success === false */
export class ApiRequestError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiRequestError'
    this.code = code
    this.status = status
  }
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────

async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const base = env.VITE_API_URL.replace(/\/$/, '')
  const url = `${base}${path}`

  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  })

  const envelope: ApiEnvelope<T> = (await res.json()) as ApiEnvelope<T>

  if (!envelope.success || envelope.error !== null) {
    const errCode = envelope.error !== null ? envelope.error.code : 'UNKNOWN'
    const errMsg =
      envelope.error !== null
        ? envelope.error.message
        : 'An unknown error occurred.'
    throw new ApiRequestError(errCode, errMsg, res.status)
  }

  return {
    data: envelope.data,
    sources: envelope.sources ?? [],
    warnings: envelope.warnings ?? [],
    generatedAt: envelope.generated_at,
  }
}

// ─── BE envelope-shape helpers ────────────────────────────────────────────
// Backend routes wrap payloads in named sub-objects (e.g. `{ pulls, nextCursor }`)
// and inject `_disclosure` via buildEnvelope. FE consumers expect flat shapes.
// These helpers unwrap those without mutating the sources/warnings/generatedAt.

async function unwrapField<TWrapped, TField>(
  p: Promise<ApiResult<TWrapped>>,
  field: keyof TWrapped,
  fallback: TField,
): Promise<ApiResult<TField>> {
  const res = await p
  const inner =
    res.data !== null && typeof res.data === 'object'
      ? ((res.data as Record<string, unknown>)[field as string] as
          | TField
          | undefined)
      : undefined
  return {
    data: inner ?? fallback,
    sources: res.sources,
    warnings: res.warnings,
    generatedAt: res.generatedAt,
  }
}

// ─── Pull normalization (BE uses buyerAddress / fmvUsdCents; FE uses address / fmv) ─

type RawPull = Record<string, unknown>

function parseGradeNum(grade: unknown): number | null {
  if (typeof grade === 'number' && Number.isFinite(grade)) return grade
  if (typeof grade === 'string') {
    const m = grade.match(/\d+/)
    return m ? Number(m[0]) : null
  }
  return null
}

function mapGrader(company: unknown): Pull['grader'] {
  const g = String(company ?? 'RAW').toUpperCase()
  if (g === 'PSA' || g === 'BGS' || g === 'CGC' || g === 'SGC') return g
  return 'RAW'
}

export function normalizePull(raw: RawPull): Pull {
  const fmvCents = raw.fmvUsdCents ?? raw.fmv
  const packCents = raw.packPriceUsdCents ?? raw.packCost
  const pulledAt = raw.pulledAtTimestamp ?? raw.pulledAt
  const image = raw.frontImageUrl ?? raw.imageUrl

  const tokenIdRaw = raw.collectibleTokenId ?? raw.tokenId
  const netGainCents = raw.netGainUsdCents ?? raw.netGain

  return {
    id: String(raw.id ?? ''),
    txHash: String(raw.txHash ?? raw.collectibleTokenId ?? ''),
    address: String(raw.buyerAddress ?? raw.address ?? ''),
    cardName: String(raw.cardName ?? ''),
    setName: String(raw.setName ?? ''),
    grader: mapGrader(raw.gradingCompany ?? raw.grader),
    grade: parseGradeNum(raw.grade),
    fmv:
      typeof fmvCents === 'number' && Number.isFinite(fmvCents)
        ? fmvCents / 100
        : null,
    packCost:
      typeof packCents === 'number' && Number.isFinite(packCents)
        ? packCents / 100
        : null,
    pulledAt:
      pulledAt instanceof Date
        ? pulledAt.toISOString()
        : String(pulledAt ?? ''),
    imageUrl: typeof image === 'string' && image.length > 0 ? image : null,
    tokenId: tokenIdRaw !== undefined ? String(tokenIdRaw) : undefined,
    tier: typeof raw.tier === 'string' ? raw.tier : null,
    netGain:
      typeof netGainCents === 'number' && Number.isFinite(netGainCents)
        ? netGainCents / 100
        : null,
    packSlug: typeof raw.packSlug === 'string' ? raw.packSlug : null,
  }
}

function normalizePullList(rows: Array<RawPull>): Array<Pull> {
  return rows.map((row) => normalizePull(row))
}

async function unwrapPullField<TWrapped>(
  p: Promise<ApiResult<TWrapped>>,
  field: keyof TWrapped,
): Promise<ApiResult<Array<Pull>>> {
  const res = await unwrapField<TWrapped, Array<RawPull>>(p, field, [])
  return {
    ...res,
    data: normalizePullList(res.data),
  }
}

async function unwrapSinglePull<TWrapped>(
  p: Promise<ApiResult<TWrapped>>,
  field: keyof TWrapped,
): Promise<ApiResult<Pull | null>> {
  const res = await unwrapField<TWrapped, RawPull | null>(p, field, null)
  return {
    ...res,
    data: res.data ? normalizePull(res.data) : null,
  }
}

function buildQuery(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) sp.set(k, String(v))
  }
  const str = sp.toString()
  return str ? `?${str}` : ''
}

// ─── Domain types (minimal — other agents refine) ─────────────────────────

export interface Pull {
  id: string
  txHash: string
  address: string
  cardName: string
  setName: string
  grader: 'PSA' | 'BGS' | 'CGC' | 'SGC' | 'RAW'
  grade: number | null
  fmv: number | null
  packCost: number | null
  pulledAt: string
  imageUrl: string | null
  // Optional metadata that the indexer may or may not have resolved yet.
  // Populated by `normalizePull` when the backend returns them.
  tokenId?: string
  tier?: string | null
  netGain?: number | null
  packSlug?: string | null
}

export interface WalletSummary {
  address: string
  firstSeenAt: string
  totalPulls: number
  totalFmv: number | null

}

export interface PriceResult {
  cardName: string
  setName: string
  grader: string
  grade: number | null
  renaiissFloor: number | null
  lastSale: number | null
  priceCharting: number | null
  snkrdunk: number | null
  gradingPremium: number | null
  imageUrl: string | null

}

export interface Pack {
  id: string
  slug?: string
  name: string
  price: number
  packType?: string
  stage?: string
  remainingSupply: number | null
  closesAt: string | null
  coverUrl: string | null
  isActive: boolean
  expectedValue?: number | null
  buyUrl?: string | null
  recentOpenedPacks?: Array<{ tokenId: string; pulledAt: string; fmvUsd?: number | null }>
}

export interface MarketSet {
  game: string
  setName: string
  volume24h: number
  delta24h: number
  cardCount: number
  coverUrl: string | null
  spark?: Array<number>
}

export interface UserProfile {
  uuid: string
  discordId: string
  username: string
  avatarUrl: string | null

}

export interface OddsEntry {
  rarity: string
  probability: number
  upstream_recent?: Record<string, number>
  empirical_90d?: Record<string, number>
  divergence?: Array<{ rarity: string; delta: number }>
}

export interface CardDetail {
  renaiissId: string
  cardName: string
  setName: string
  game: string
  imageUrl: string | null
}

/** Renaiss OS Index GET /v1/cards/{game}/{set}/{card} */
export interface IndexCardDetail {
  id?: string
  name: string
  setName?: string | null
  setCode?: string | null
  cardNumber?: string | null
  game: string
  gradeLabel?: string
  company?: string
  grade?: string | null
  priceUsdCents?: number | null
  confidence?: 'high' | 'medium' | 'low' | null
  deltas?: {
    d7: number | null
    d30: number | null
    d365: number | null
  }
  imageUrl?: string | null
  imageUrlLg?: string | null
  lastSaleAt?: string | null
  href?: string
}

export interface LeaderboardEntry {
  rank: number
  pull: Pull
  netGainUsdCents: number
  fmvUsdCents: number | null
}

export interface DailyLeaderboardPayload {
  windowStartAt: string
  windowEndAt: string
  computedAt: string
  entries: Array<LeaderboardEntry>
}

export interface RecentTrade {
  id?: string
  observedAt?: string
  priceUsdCents?: number | null
  currency?: string
  company?: string | null
  gradeLabel?: string | null
  source?: string
  displayName?: string
  card?: {
    name?: string
    setCode?: string | null
    cardNumber?: string | null
    game?: string
    imageUrl?: string | null
    href?: string | null
  }
}

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down'
  upstreams: Array<{ name: string; status: string; latencyMs: number }>
}

/** Live adoption metrics from Postgres aggregates */
export interface StatsPayload {
  cardsShared: number
  walletsTracked: number
  discordServers: number
  delta24h: {
    cardsShared: number
    walletsTracked: number
    discordServers: number
  }
}

// ─── Wallet endpoints ─────────────────────────────────────────────────────

export const getWalletSummary = (address: string) =>
  apiFetch<WalletSummary>(
    `/api/wallets/${encodeURIComponent(address)}/summary`,
  )

// ─── Pull endpoints ───────────────────────────────────────────────────────
// BE returns `{ pulls, nextCursor, _disclosure }` — unwrap to Array<Pull> for FE.

export const getPulls = (cursor?: string, limit = 20) =>
  unwrapPullField(
    apiFetch<{ pulls: Array<RawPull>; nextCursor: string | null }>(
      `/api/pulls${buildQuery({ cursor, limit })}`,
    ),
    'pulls',
  )

export const getPullById = (id: string) =>
  unwrapSinglePull(
    apiFetch<{ pull: RawPull }>(`/api/pulls/${encodeURIComponent(id)}`),
    'pull',
  )

export const getPullsForAddress = (address: string) =>
  unwrapPullField(
    apiFetch<{ pulls: Array<RawPull>; nextCursor: string | null }>(
      `/api/wallets/${encodeURIComponent(address)}/pulls`,
    ),
    'pulls',
  )

// ─── Price endpoints ──────────────────────────────────────────────────────

export const getPriceForToken = (tokenId: string) =>
  apiFetch<PriceResult>(`/api/price/token/${encodeURIComponent(tokenId)}`)

export const getPriceForCert = (cert: string) =>
  apiFetch<PriceResult>(`/api/price/cert/${encodeURIComponent(cert)}`)

// BE returns `{ query, limit, results, _disclosure }` — unwrap to results array.
export const searchPrice = (q: string) =>
  unwrapField<
    { query: string; limit: number; results: Array<PriceResult> },
    Array<PriceResult>
  >(
    apiFetch<{ query: string; limit: number; results: Array<PriceResult> }>(
      `/api/price/search${buildQuery({ q })}`,
    ),
    'results',
    [],
  )

/** Renaiss OS Index search hits (GET /v1/search). */
export interface IndexSearchHit {
  name?: string
  setName?: string
  cardNumber?: string
  gradeLabel?: string
  priceUsdCents?: number | null
  confidence?: string
  href?: string
  imageUrl?: string | null
  game?: string
}

export const searchIndex = (q: string, limit = 12) =>
  unwrapField<
    { query: string; limit: number; results: Array<IndexSearchHit> },
    Array<IndexSearchHit>
  >(
    apiFetch<{ query: string; limit: number; results: Array<IndexSearchHit> }>(
      `/api/price/search${buildQuery({ q, limit })}`,
    ),
    'results',
    [],
  )

// ─── Marketplace endpoints ────────────────────────────────────────────────

export interface MarketplaceFilters extends Record<string, string | number | boolean | undefined> {
  search?: string
  categoryFilter?: string
  listedOnly?: boolean
  languageFilter?: string
  gradingCompanyFilter?: string
  gradeFilter?: string
  yearRange?: string
  priceRangeFilter?: string
  sortBy?: string
  sortOrder?: string
  limit?: number
  offset?: number
}

export interface MarketplaceItem {
  tokenId: string
  name: string
  setName: string
  cardNumber: string
  ownerAddress: string
  askPriceInUSDT?: string | null
  fmvPriceInUSD?: string | null
  gradingCompany: string
  grade: string
  year: number
  vaultLocation?: string
}

export interface MarketplaceSearchResponse {
  collection: Array<MarketplaceItem>
  pagination: {
    total: number
    limit: number
    offset: number
  }
}

export const searchMarketplace = (filters: MarketplaceFilters = {}) =>
  apiFetch<MarketplaceSearchResponse>(`/api/marketplace${buildQuery(filters)}`)

/** @deprecated Use searchMarketplace — returns full collection + pagination envelope. */
export const getMarketplace = searchMarketplace

// ─── Pack endpoints ───────────────────────────────────────────────────────

// BE returns `{ includeInactive, packs, _disclosure }` — unwrap to Array<Pack>.
export const getPacks = (includeInactive = false) =>
  unwrapField<{ includeInactive: boolean; packs: Array<Pack> }, Array<Pack>>(
    apiFetch<{ includeInactive: boolean; packs: Array<Pack> }>(
      `/api/packs${buildQuery({ includeInactive })}`,
    ),
    'packs',
    [],
  )

// BE returns a rich object with `upstream_recent.tierFrequency` and
// `empirical_90d.tierFrequency`. We reshape it into Array<OddsEntry> the FE
// packs modal expects: one entry per unique tier, with `probability` (0..1)
// from upstream and `empirical_90d` (0..1) from the empirical block.
interface OddsBackendPayload {
  packSlug: string
  upstream_recent: {
    tierFrequency: Array<{ tier: string; count: number; pct: number }>
  }
  empirical_90d: {
    tierFrequency: Array<{ tier: string; count: number; pct: number }>
  }
  divergence: Array<{ rarity: string; delta: number }>
}

export const getOdds = async (pack: string): Promise<ApiResult<Array<OddsEntry>>> => {
  const res = await apiFetch<OddsBackendPayload>(
    `/api/odds/${encodeURIComponent(pack)}`,
  )
  const upstream = res.data?.upstream_recent?.tierFrequency ?? []
  const empirical = res.data?.empirical_90d?.tierFrequency ?? []
  const empiricalByTier = new Map<string, number>()
  for (const e of empirical) empiricalByTier.set(e.tier, e.pct)

  const tiers = new Set<string>([
    ...upstream.map((u) => u.tier),
    ...empirical.map((e) => e.tier),
  ])

  const entries: Array<OddsEntry> = Array.from(tiers).map((tier) => {
    const upstreamPct =
      upstream.find((u) => u.tier === tier)?.pct ?? empiricalByTier.get(tier) ?? 0
    const empiricalPct = empiricalByTier.get(tier)
    return {
      rarity: tier,
      probability: upstreamPct,
      // packs.tsx casts `entry.empirical_90d as number | undefined` — we emit
      // the empirical pct (0..1) directly so the FE consumer stays simple.
      empirical_90d:
        empiricalPct !== undefined
          ? (empiricalPct as unknown as Record<string, number>)
          : undefined,
    } as OddsEntry
  })

  return {
    data: entries,
    sources: res.sources,
    warnings: res.warnings,
    generatedAt: res.generatedAt,
  }
}

// ─── User endpoints ───────────────────────────────────────────────────────

export const getUser = (uuid: string) =>
  apiFetch<UserProfile>(`/api/users/${encodeURIComponent(uuid)}`)

// ─── Report endpoint ──────────────────────────────────────────────────────

export interface ReportPayload {
  pullId?: string
  reason: string
  details?: string
}

/**
 * Backend `/api/report` accepts:
 *   { card?: { tokenId?, cert?, setName?, itemNo? }, reason, evidence?, submitterHandle? }
 * FE call sites use the ergonomic `{ pullId, reason, details }`. We map:
 *   pullId  → card.tokenId  (Pull.id today is the on-chain tokenId)
 *   details → evidence
 */
export const submitReport = (payload: ReportPayload) => {
  const body: Record<string, unknown> = { reason: payload.reason }
  if (payload.pullId) {
    body.card = { tokenId: payload.pullId }
  }
  if (payload.details) {
    body.evidence = payload.details
  }
  return apiFetch<{ received: true; reportId?: string }>('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ─── Valuation endpoints ──────────────────────────────────────────────────

export const valuatePhoto = (file: File): Promise<ApiResult<PriceResult>> => {
  const form = new FormData()
  form.append('photo', file)
  return apiFetch<PriceResult>('/api/valuate/photo', {
    method: 'POST',
    body: form,
  })
}

export const valuateCert = (cert: string): Promise<ApiResult<PriceResult>> => {
  return apiFetch<PriceResult>(`/api/valuate/cert/${encodeURIComponent(cert)}`)
}

// ─── Market endpoints ─────────────────────────────────────────────────────

// Raw upstream tile as returned by Renaiss OS Index /v1/indices. Fields differ
// from the `MarketSet` FE type, so we adapt below.
interface RawIndexTile {
  game: string
  label?: string
  value?: number
  deltas?: { d7?: number; d30?: number; d365?: number }
  constituentCount?: number
  sparkline?: Array<{ t: string; usdCents: number }>
  coverUrl?: string | null
}

const adaptTileToMarketSet = (raw: RawIndexTile): MarketSet => ({
  game: raw.game,
  setName: raw.label ?? raw.game,
  volume24h: typeof raw.value === 'number' ? raw.value : 0,
  delta24h: typeof raw.deltas?.d7 === 'number' ? raw.deltas.d7 : 0,
  cardCount: typeof raw.constituentCount === 'number' ? raw.constituentCount : 0,
  coverUrl: raw.coverUrl ?? null,
  spark: Array.isArray(raw.sparkline)
    ? raw.sparkline.map((p) => (typeof p.usdCents === 'number' ? p.usdCents / 100 : 0))
    : undefined,
})

// BE returns `{ indices, _disclosure }` — unwrap and adapt each tile.
export const getMarket = async (): Promise<ApiResult<Array<MarketSet>>> => {
  const res = await apiFetch<{ indices?: Array<RawIndexTile> }>('/api/market')
  const raw = Array.isArray(res.data?.indices) ? res.data.indices : []
  return {
    data: raw.map(adaptTileToMarketSet),
    sources: res.sources,
    warnings: res.warnings,
    generatedAt: res.generatedAt,
  }
}

// BE `/api/market/:game` returns an IndexDetail object; expose as `MarketSet[]`
// for FE compat (unused by current pages, kept for the router).
export const getMarketByGame = (game: string) =>
  apiFetch<Array<MarketSet>>(
    `/api/market/${encodeURIComponent(game)}`,
  )

// Drill-down helper: return just the constituent image URLs for a given game.
// The Renaiss OS Index /v1/indices/{game} response has a full `constituents`
// array of 50 cards, each with `imageUrl`. We only need the first few for the
// market tile hero fallback when /featured happens to skew all-Pokemon.
export interface IndexConstituent {
  rank?: number
  name?: string
  imageUrl?: string | null
  imageUrlThumb?: string | null
  href?: string
}

export const getIndexConstituents = async (
  game: string,
): Promise<Array<IndexConstituent>> => {
  try {
    const res = await apiFetch<{
      constituents?: Array<IndexConstituent>
    }>(`/api/market/${encodeURIComponent(game)}`)
    return Array.isArray(res.data?.constituents) ? res.data.constituents : []
  } catch {
    // Silent failure — this is a UX enhancement, not critical data.
    return []
  }
}

// Featured cards are richer than Pull — they carry CardSummary-shaped fields from Renaiss OS Index.
export interface FeaturedCard extends Pull {
  confidence?: 'high' | 'medium' | 'low'
  href?: string
  game?: string
  deltaPct?: number
  priceUsdCents?: number
}

// Raw upstream featured card as returned by Renaiss OS Index /v1/cards/featured.
// The FE FeaturedCard/Pull types use legacy names (cardName, grader, fmv,
// imageUrl); the upstream uses (name, company, priceUsdCents, imageUrl).
// This adapter bridges the two so the /featured route renders without changes.
interface RawFeaturedCard {
  name?: string
  setName?: string
  setCode?: string
  cardNumber?: string
  company?: string
  grade?: string | number
  gradeLabel?: string
  priceUsdCents?: number | null
  deltaPct?: number | null
  imageUrl?: string | null
  imageUrlThumb?: string | null
  href?: string
  game?: string
  confidence?: 'high' | 'medium' | 'low'
  lastSaleAt?: string
  slugs?: unknown
}

const gradeFromUpstream = (raw: RawFeaturedCard): number | null => {
  if (typeof raw.grade === 'number' && Number.isFinite(raw.grade)) return raw.grade
  if (typeof raw.grade === 'string') {
    const m = raw.grade.match(/\d+(\.\d+)?/)
    return m ? Number(m[0]) : null
  }
  if (typeof raw.gradeLabel === 'string') {
    const m = raw.gradeLabel.match(/\d+(\.\d+)?/)
    return m ? Number(m[0]) : null
  }
  return null
}

const graderFromUpstream = (raw: RawFeaturedCard): Pull['grader'] => {
  const c = typeof raw.company === 'string' ? raw.company.toUpperCase() : ''
  if (c === 'PSA' || c === 'BGS' || c === 'CGC' || c === 'SGC') return c
  return 'RAW'
}

const adaptFeaturedCard = (raw: RawFeaturedCard, idx: number): FeaturedCard => ({
  id: `featured-${idx}-${raw.href ?? raw.name ?? idx}`,
  txHash: '',
  address: '',
  cardName: raw.name ?? 'Unknown card',
  setName: raw.setName ?? '',
  grader: graderFromUpstream(raw),
  grade: gradeFromUpstream(raw),
  fmv:
    typeof raw.priceUsdCents === 'number' && Number.isFinite(raw.priceUsdCents)
      ? raw.priceUsdCents / 100
      : null,
  packCost: null,
  pulledAt: raw.lastSaleAt ?? new Date().toISOString(),
  imageUrl: raw.imageUrl ?? raw.imageUrlThumb ?? null,
  confidence: raw.confidence,
  href: raw.href,
  game: raw.game,
  deltaPct: typeof raw.deltaPct === 'number' ? raw.deltaPct : undefined,
  priceUsdCents:
    typeof raw.priceUsdCents === 'number' ? raw.priceUsdCents : undefined,
})

// BE returns `{ limit, cards, _disclosure }` — unwrap and adapt each card.
export const getFeatured = async (
  limit = 12,
): Promise<ApiResult<Array<FeaturedCard>>> => {
  const res = await apiFetch<{ limit?: number; cards?: Array<RawFeaturedCard> }>(
    `/api/featured${buildQuery({ limit })}`,
  )
  const raw = Array.isArray(res.data?.cards) ? res.data.cards : []
  return {
    data: raw.map(adaptFeaturedCard),
    sources: res.sources,
    warnings: res.warnings,
    generatedAt: res.generatedAt,
  }
}

// ─── Set endpoints ────────────────────────────────────────────────────────

export interface SetListingCard {
  name: string
  setName?: string | null
  setCode?: string | null
  cardNumber?: string | null
  gradeLabel?: string
  company?: string
  grade?: string | null
  priceUsdCents?: number | null
  deltaPct?: number | null
  confidence?: string | null
  imageUrl?: string | null
  href?: string
  game?: string
}

export interface SetDetail {
  game: string
  setName: string | null
  setCode: string | null
  setSegment?: string
  language?: string | null
  cardCount: number
  href?: string
  cards: Array<SetListingCard>
}

export const getSet = (game: string, set: string) =>
  apiFetch<SetDetail>(
    `/api/sets/${encodeURIComponent(game)}/${encodeURIComponent(set)}`,
  )

// ─── Card endpoints ───────────────────────────────────────────────────────

export interface CardTrades {
  trades: Array<{
    observedAt?: string
    priceUsdCents?: number | null
    displayName?: string
    source?: string
    gradeLabel?: string | null
  }>
  total?: number
}

export interface IndexOverviewGrade {
  company?: string
  grade?: string
  gradeLabel?: string
  priceUsdCents?: number | null
  deltaPct?: number | null
  confidence?: string | null
  spark?: Array<number>
  href?: string
  lastSaleAt?: string | null
}

export interface IndexCardOverview {
  game: string
  name: string
  setName?: string | null
  cardNumber?: string | null
  gradeCount?: number
  href?: string
  grades: Array<IndexOverviewGrade>
}

export interface IndexFmvSeriesPoint {
  t: string
  usdCents: number
}

export interface IndexFmvSeriesResponse {
  windowDays?: number
  gradeLabel?: string
  points?: Array<IndexFmvSeriesPoint>
  series?: Array<{
    method: string
    label: string
    points: Array<IndexFmvSeriesPoint>
  }>
}

/** @deprecated Use IndexFmvSeriesResponse */
export interface CardSeries {
  window: string
  points: Array<{ date: string; fmv: number }>
}

export const getCardByRenaissId = (rid: string) =>
  apiFetch<CardDetail>(`/api/cards/by-id/${encodeURIComponent(rid)}`)

export const getCardOverviewByRenaissId = (rid: string) =>
  apiFetch<CardDetail>(`/api/cards/by-id/${encodeURIComponent(rid)}/overview`)

export const getCardTradesByRenaissId = (rid: string) =>
  apiFetch<CardTrades>(`/api/cards/by-id/${encodeURIComponent(rid)}/trades`)

export const getCardSeriesByRenaissId = (rid: string) =>
  apiFetch<CardSeries>(`/api/cards/by-id/${encodeURIComponent(rid)}/series`)

export const getCardFmvSeriesByRenaissId = (rid: string) =>
  apiFetch<CardSeries>(`/api/cards/by-id/${encodeURIComponent(rid)}/fmv-series`)

export const getCardBySlug = (game: string, set: string, card: string) =>
  apiFetch<IndexCardDetail>(
    `/api/cards/${encodeURIComponent(game)}/${encodeURIComponent(set)}/${encodeURIComponent(card)}`,
  )

export const getCardOverviewBySlug = (
  game: string,
  set: string,
  card: string,
) =>
  apiFetch<IndexCardOverview>(
    `/api/cards/${encodeURIComponent(game)}/${encodeURIComponent(set)}/${encodeURIComponent(card)}/overview`,
  )

export const getCardTradesBySlug = (game: string, set: string, card: string) =>
  apiFetch<CardTrades>(
    `/api/cards/${encodeURIComponent(game)}/${encodeURIComponent(set)}/${encodeURIComponent(card)}/trades`,
  )

export const getCardSeriesBySlug = (game: string, set: string, card: string) =>
  apiFetch<CardSeries>(
    `/api/cards/${encodeURIComponent(game)}/${encodeURIComponent(set)}/${encodeURIComponent(card)}/series`,
  )

export const getCardFmvSeriesBySlug = (
  game: string,
  set: string,
  card: string,
  window: '7d' | '30d' | '90d' = '30d',
) =>
  apiFetch<IndexFmvSeriesResponse>(
    `/api/cards/${encodeURIComponent(game)}/${encodeURIComponent(set)}/${encodeURIComponent(card)}/fmv-series${buildQuery({ window })}`,
  )

export const getCardSeriesById = (id: string, window?: string) =>
  apiFetch<CardSeries>(
    `/api/cards/by-id/${encodeURIComponent(id)}/series${buildQuery({ window })}`,
  )

// ─── Stats endpoint ───────────────────────────────────────────────────────

export const getStats = () => apiFetch<StatsPayload>('/api/stats')

// ─── Leaderboard endpoint ─────────────────────────────────────────────────

export const getLeaderboardDaily = () =>
  apiFetch<DailyLeaderboardPayload>('/api/leaderboard/daily')

export const getRecentTrades = (limit = 20) =>
  unwrapField<{ limit: number; trades: Array<RecentTrade> }, Array<RecentTrade>>(
    apiFetch<{ limit: number; trades: Array<RecentTrade> }>(
      `/api/trades/recent${buildQuery({ limit })}`,
    ),
    'trades',
    [],
  )

/** @deprecated Prefer getLeaderboardDaily */
export const getLeaderboard = (period: string) =>
  apiFetch<DailyLeaderboardPayload>(
    `/api/leaderboard/${encodeURIComponent(period)}`,
  )

// ─── AI endpoints ─────────────────────────────────────────────────────────

export interface ExplainPayload {
  pullId: string

}

export interface ListingPayload {
  pullId: string

}

export const getExplain = (payload: ExplainPayload) =>
  apiFetch<{ explanation: string }>('/api/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

export const getListing = (payload: ListingPayload) =>
  apiFetch<{ listing: string }>('/api/listing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

// ─── Health endpoint ──────────────────────────────────────────────────────
// Backend shape: { renaiss_main: {ok,status,latency_ms}, renaiss_index: {...}, bsc_rpc: {...}, _disclosure }
// Frontend shape: { status, upstreams: [{ name, status, latencyMs }] }

interface RawUpstreamEntry {
  ok?: boolean
  status?: string
  latency_ms?: number
}

const HEALTH_UPSTREAM_LABELS: Record<string, string> = {
  renaiss_main: 'Renaiss main API',
  renaiss_index: 'Renaiss OS Index',
  bsc_rpc: 'BSC RPC',
}

export const getHealthUpstream = async (): Promise<ApiResult<HealthStatus>> => {
  const res = await apiFetch<Record<string, unknown>>('/health/upstream')
  const raw = res.data ?? {}
  const upstreams = Object.entries(raw)
    .filter(([key, value]) => !key.startsWith('_') && value !== null && typeof value === 'object')
    .map(([key, value]) => {
      const entry = value as RawUpstreamEntry
      // Backend `status` can be 'ok' | 'degraded' | 'down' | descriptive string
      // (e.g. "block=109225022"). Prefer the boolean `ok` for rollup.
      const rawStatus = typeof entry.status === 'string' ? entry.status : ''
      const isKnownState = rawStatus === 'ok' || rawStatus === 'degraded' || rawStatus === 'down'
      const derived = entry.ok === false ? 'down' : 'ok'
      return {
        name: HEALTH_UPSTREAM_LABELS[key] ?? key,
        status: isKnownState ? rawStatus : derived,
        latencyMs: typeof entry.latency_ms === 'number' ? entry.latency_ms : 0,
      }
    })
  const anyDown = upstreams.some((u) => u.status === 'down')
  const anyDegraded = upstreams.some((u) => u.status === 'degraded')
  const rollup: HealthStatus['status'] = anyDown ? 'down' : anyDegraded ? 'degraded' : 'ok'
  return {
    data: { status: rollup, upstreams },
    sources: res.sources,
    warnings: res.warnings,
    generatedAt: res.generatedAt,
  }
}
