import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, ChevronRight, ExternalLink } from 'lucide-react'
import type { ApiWarning, IndexCardDetail, IndexCardOverview } from '@/lib/api/client'
import {
  getCardBySlug,
  getCardFmvSeriesBySlug,
  getCardOverviewBySlug,
  getCardTradesBySlug,
} from '@/lib/api/client'
import { Sparkline } from '@/components/charts/Sparkline'
import { IndexAttribution } from '@/components/index/IndexAttribution'
import { indexCardExternalUrl, indexCardGalleryPath, stripGradeSuffix } from '@/lib/index-href'
import { cnm } from '@/utils/style'
import { formatUiNumber } from '@/utils/format'
import { friendlyUpstreamMessage } from '@/utils/upstreamError'

export const Route = createFileRoute('/card/$game/$set/$card')({
  component: IndexCardPage,
})

function WarningBanner({ warnings }: { warnings: Array<ApiWarning> }) {
  if (!warnings.length) return null
  return (
    <div className="flex flex-col gap-2 mb-6">
      {warnings.map((w) => (
        <div
          key={w.code}
          className="flex items-start gap-2 bg-[var(--color-warn-soft)] text-[var(--color-warn)] text-xs px-3 py-2 rounded-[var(--radius-sm)]"
        >
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
          <span>{w.message}</span>
        </div>
      ))}
    </div>
  )
}

function DeltaPill({ label, pct }: { label: string; pct: number | null | undefined }) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) {
    return (
      <div className="text-center">
        <p className="text-caption text-[var(--color-ink-subtle)]">{label}</p>
        <p className="text-num text-[var(--color-ink-muted)] mt-1">—</p>
      </div>
    )
  }
  const up = pct >= 0
  return (
    <div className="text-center">
      <p className="text-caption text-[var(--color-ink-subtle)]">{label}</p>
      <p
        className={cnm(
          'text-num font-medium mt-1 tabular-nums',
          up ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]',
        )}
      >
        {up ? '+' : ''}
        {pct.toFixed(2)}%
      </p>
    </div>
  )
}

function fmvSparkFromSeries(
  series: { points?: Array<{ t: string; usdCents: number }>; series?: Array<{ points: Array<{ usdCents: number }> }> } | undefined,
): Array<number> {
  if (!series) return []
  const median = series.series?.find((s) => s.method === 'median')?.points
  const pts = median ?? series.points ?? []
  return pts.map((p) => p.usdCents / 100)
}

function IndexCardPage() {
  const { game, set, card } = Route.useParams()
  const overviewSlug = stripGradeSuffix(card)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['index-card', game, set, card],
    queryFn: () => getCardBySlug(game, set, card),
    staleTime: 5 * 60_000,
    retry: false,
  })

  // Serialize the 4 upstream calls into a waterfall (main → overview → fmv → trades)
  // so we never exceed the Renaiss burst rate limit. Each satellite waits for
  // the previous one to complete before firing. Adds a bit of latency but every
  // fetch either succeeds or fails cleanly.
  const canFetchOverview = !isLoading && !isError && Boolean(data)

  const {
    data: overviewData,
    isSuccess: overviewOk,
    isError: overviewErr,
  } = useQuery({
    queryKey: ['index-card-overview', game, set, overviewSlug],
    queryFn: () => getCardOverviewBySlug(game, set, overviewSlug),
    staleTime: 5 * 60_000,
    enabled: canFetchOverview,
    retry: false,
  })

  const canFetchFmv = canFetchOverview && (overviewOk || overviewErr)

  const {
    data: fmvData,
    isSuccess: fmvOk,
    isError: fmvErr,
  } = useQuery({
    queryKey: ['index-card-fmv', game, set, card],
    queryFn: () => getCardFmvSeriesBySlug(game, set, card, '30d'),
    staleTime: 5 * 60_000,
    enabled: canFetchFmv,
    retry: false,
  })

  const canFetchTrades = canFetchFmv && (fmvOk || fmvErr)

  const { data: tradesData } = useQuery({
    queryKey: ['index-card-trades', game, set, card],
    queryFn: () => getCardTradesBySlug(game, set, card),
    staleTime: 5 * 60_000,
    enabled: canFetchTrades,
    retry: false,
  })

  const detail = data?.data as IndexCardDetail | undefined
  const overview = overviewData?.data as IndexCardOverview | undefined
  const cardTrades = tradesData?.data?.trades ?? []
  const warnings = data?.warnings ?? []
  const externalUrl = indexCardExternalUrl(detail?.href ?? `/card/${game}/${set}/${card}`)
  const setPath = `/sets/${encodeURIComponent(game)}/${encodeURIComponent(set)}`
  const fmvSpark = fmvSparkFromSeries(fmvData?.data)

  const price =
    typeof detail?.priceUsdCents === 'number'
      ? `$${formatUiNumber(detail.priceUsdCents / 100, '', { defaultDecimals: 2 })}`
      : '—'

  return (
    <main id="main" className="min-h-screen bg-[var(--color-bg)] pt-28 pb-24">
      <div className="max-w-[960px] mx-auto px-5 sm:px-8">
        <nav className="text-caption text-[var(--color-ink-muted)] mb-6 flex flex-wrap items-center gap-1">
          <Link to="/featured" className="hover:text-[var(--color-accent)]">
            Featured
          </Link>
          <ChevronRight size={12} aria-hidden="true" />
          <Link to={setPath} className="hover:text-[var(--color-accent)] capitalize truncate max-w-[200px]">
            {detail?.setName ?? set.replace(/-/g, ' ')}
          </Link>
          <ChevronRight size={12} aria-hidden="true" />
          <span className="text-[var(--color-ink)] truncate max-w-[240px]">{detail?.name ?? card}</span>
        </nav>

        <WarningBanner warnings={warnings} />

        {isLoading && (
          <div className="grid md:grid-cols-[minmax(0,340px)_1fr] gap-10" aria-busy="true">
            <div className="skeleton skeleton-animate aspect-[3/4] rounded-[var(--radius-lg)]" />
            <div className="space-y-4">
              <div className="skeleton skeleton-animate h-10 w-2/3 rounded" />
              <div className="skeleton skeleton-animate h-24 rounded-[var(--radius-lg)]" />
            </div>
          </div>
        )}

        {isError && (() => {
          const msg = friendlyUpstreamMessage(
            error,
            'Failed to load card from Renaiss OS Index. Slugs must match GET /v1/cards/{game}/{set}/{card}.',
          )
          return (
            <div
              role="alert"
              className={cnm(
                'flex items-start gap-3 border rounded-[var(--radius-lg)] p-6',
                msg.kind === 'rate-limited'
                  ? 'bg-[var(--color-warn-soft)] border-[var(--color-warn-soft)]'
                  : 'bg-[var(--color-bg-alt)] border-[var(--color-border)]',
              )}
            >
              <AlertCircle
                size={18}
                className={cnm(
                  'flex-shrink-0 mt-0.5',
                  msg.kind === 'rate-limited'
                    ? 'text-[var(--color-warn)]'
                    : 'text-[var(--color-danger)]',
                )}
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="text-body font-medium text-[var(--color-ink)]">
                  {msg.title}
                </p>
                <p className="text-body-s text-[var(--color-ink-muted)] mt-1">
                  {msg.body}
                </p>
              </div>
            </div>
          )
        })()}

        {!isLoading && !isError && detail && (
          <div className="grid md:grid-cols-[minmax(0,340px)_1fr] gap-10 items-start">
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] overflow-hidden">
              {detail.imageUrlLg ?? detail.imageUrl ? (
                <img
                  src={detail.imageUrlLg ?? detail.imageUrl ?? ''}
                  alt=""
                  className="w-full aspect-[3/4] object-cover"
                />
              ) : (
                <div className="w-full aspect-[3/4] bg-[var(--color-bg-alt)]" aria-hidden="true" />
              )}
            </div>

            <div>
              <p className="text-caption text-[var(--color-ink-subtle)] uppercase tracking-wide mb-2">
                {game}
                {detail.cardNumber ? ` · #${detail.cardNumber}` : ''}
              </p>
              <h1 className="text-h1 text-[var(--color-ink)] mb-2">{detail.name}</h1>
              <p className="text-body-l text-[var(--color-ink-muted)] mb-6">
                {detail.gradeLabel ?? `${detail.company ?? ''} ${detail.grade ?? ''}`.trim()}
                {detail.setName ? ` · ${detail.setName}` : ''}
              </p>

              <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-6 mb-6">
                <p className="text-caption text-[var(--color-ink-subtle)] mb-1">Reference price</p>
                <p className="text-[2rem] font-semibold text-[var(--color-ink)] tabular-nums">{price}</p>
                {detail.confidence && (
                  <p className="text-caption text-[var(--color-ink-muted)] mt-2 capitalize">
                    Confidence: {detail.confidence}
                  </p>
                )}
                {detail.lastSaleAt && (
                  <p className="text-caption text-[var(--color-ink-subtle)] mt-1">
                    Last sale: {new Date(detail.lastSaleAt).toLocaleString()}
                  </p>
                )}
                {fmvSpark.length > 1 && (
                  <div className="mt-4 pt-4 border-t border-[var(--color-border)]">
                    <p className="text-caption text-[var(--color-ink-subtle)] mb-2">
                      30d FMV trend · GET /v1/cards/…/fmv-series
                    </p>
                    <Sparkline data={fmvSpark} width={200} height={44} />
                  </div>
                )}
              </div>

              {detail.deltas && (
                <div className="grid grid-cols-3 gap-4 mb-8 p-4 bg-[var(--color-bg-alt)] rounded-[var(--radius-lg)] border border-[var(--color-border)]">
                  <DeltaPill label="7d" pct={detail.deltas.d7} />
                  <DeltaPill label="30d" pct={detail.deltas.d30} />
                  <DeltaPill label="1y" pct={detail.deltas.d365} />
                </div>
              )}

              {externalUrl && (
                <a
                  href={externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cnm(
                    'inline-flex items-center gap-2 text-body text-[var(--color-accent)]',
                    'hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]',
                  )}
                >
                  View on Renaiss OS Index
                  <ExternalLink size={16} aria-hidden="true" />
                </a>
              )}
            </div>
          </div>
        )}

        {!isLoading && !isError && overview?.grades && overview.grades.length > 0 && (
          <section className="mt-12">
            <h2 className="text-h3 text-[var(--color-ink)] mb-1">All grades</h2>
            <p className="text-caption text-[var(--color-ink-muted)] mb-4">
              GET /v1/cards/{'{game}'}/{'{set}'}/{'{card}'}/overview · {overview.gradeCount ?? overview.grades.length} tiers
            </p>
            <div className="space-y-2">
              {overview.grades.map((g) => {
                const gradePath = indexCardGalleryPath(g.href ?? null)
                const gradePrice =
                  typeof g.priceUsdCents === 'number'
                    ? `$${formatUiNumber(g.priceUsdCents / 100, '', { defaultDecimals: 2 })}`
                    : '—'
                const row = (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="text-body font-medium text-[var(--color-ink)]">
                        {g.gradeLabel ?? `${g.company ?? ''} ${g.grade ?? ''}`.trim()}
                      </p>
                      {g.confidence && (
                        <p className="text-caption text-[var(--color-ink-subtle)] capitalize mt-0.5">
                          {g.confidence} confidence
                        </p>
                      )}
                    </div>
                    {g.spark && g.spark.length > 1 && (
                      <Sparkline data={g.spark.map((c) => c / 100)} width={80} height={28} />
                    )}
                    <span className="text-num font-medium tabular-nums text-[var(--color-ink)] w-24 text-right">
                      {gradePrice}
                    </span>
                  </>
                )
                const className =
                  'flex items-center gap-4 py-3 px-4 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-md)] hover:border-[var(--color-border-strong)] transition-colors'
                return gradePath ? (
                  <Link key={g.gradeLabel ?? g.href} to={gradePath} className={className}>
                    {row}
                  </Link>
                ) : (
                  <div key={g.gradeLabel ?? g.href} className={className}>
                    {row}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {!isLoading && !isError && cardTrades.length > 0 && (
          <section className="mt-12">
            <h2 className="text-h3 text-[var(--color-ink)] mb-4">Recent trades</h2>
            <p className="text-caption text-[var(--color-ink-muted)] mb-4">
              GET /v1/cards/{'{game}'}/{'{set}'}/{'{card}'}/trades
            </p>
            <div className="space-y-2">
              {cardTrades.slice(0, 8).map((t, i) => (
                <div
                  key={`${t.observedAt ?? i}-${t.priceUsdCents}`}
                  className="flex items-center justify-between gap-4 py-3 px-4 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-md)]"
                >
                  <span className="text-caption text-[var(--color-ink-muted)]">
                    {t.observedAt
                      ? new Date(t.observedAt).toLocaleString()
                      : '—'}
                    {t.displayName ? ` · ${t.displayName}` : ''}
                  </span>
                  <span className="text-num font-medium tabular-nums text-[var(--color-ink)]">
                    {typeof t.priceUsdCents === 'number'
                      ? `$${formatUiNumber(t.priceUsdCents / 100, '', { defaultDecimals: 2 })}`
                      : '—'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <footer className="mt-16 pt-6 border-t border-[var(--color-border)] space-y-2">
          <IndexAttribution />
          <p className="text-caption text-[var(--color-ink-subtle)]">
            Cert Bridge: pair this Index card with a Renaiss tokenId via{' '}
            <Link to="/price" className="text-[var(--color-accent)] hover:underline">
              Card Lens
            </Link>
            .
          </p>
        </footer>
      </div>
    </main>
  )
}
