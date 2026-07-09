import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, ExternalLink } from 'lucide-react'
import type { ApiWarning, RecentTrade } from '@/lib/api/client'
import { getRecentTrades } from '@/lib/api/client'
import { IndexAttribution } from '@/components/index/IndexAttribution'
import { indexCardGalleryPath, indexCardExternalUrl } from '@/lib/index-href'
import { cnm } from '@/utils/style'
import { formatUiNumber } from '@/utils/format'
import { friendlyUpstreamMessage } from '@/utils/upstreamError'

export const Route = createFileRoute('/trades')({
  component: TradesPage,
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

function TradeRow({ trade }: { trade: RecentTrade }) {
  const name = trade.card?.name ?? 'Unknown card'
  const grade = trade.gradeLabel ?? trade.company ?? '—'
  const price =
    typeof trade.priceUsdCents === 'number'
      ? `$${formatUiNumber(trade.priceUsdCents / 100, '', { defaultDecimals: 2 })}`
      : '—'
  const when = trade.observedAt
    ? new Date(trade.observedAt).toLocaleString()
    : '—'
  const source = trade.displayName ?? trade.source ?? 'Renaiss OS Index'
  const galleryPath = indexCardGalleryPath(trade.card?.href ?? null)
  const externalUrl = indexCardExternalUrl(trade.card?.href ?? null)

  return (
    <article className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-5 flex gap-4">
      {trade.card?.imageUrl ? (
        <img
          src={trade.card.imageUrl}
          alt=""
          className="w-16 h-[88px] object-cover rounded-[var(--radius-sm)] border border-[var(--color-border)] flex-shrink-0"
          loading="lazy"
        />
      ) : (
        <div
          className="w-16 h-[88px] rounded-[var(--radius-sm)] bg-[var(--color-bg-alt)] border border-[var(--color-border)] flex-shrink-0"
          aria-hidden="true"
        />
      )}
      <div className="min-w-0 flex-1">
        <h2 className="text-body font-medium text-[var(--color-ink)] truncate">{name}</h2>
        <p className="text-caption text-[var(--color-ink-muted)] mt-1">
          {grade}
          {trade.card?.setCode ? ` · ${trade.card.setCode}` : ''}
          {trade.card?.cardNumber ? ` #${trade.card.cardNumber}` : ''}
        </p>
        <p className="text-num text-[var(--color-ink)] font-medium mt-2 tabular-nums">{price}</p>
        <p className="text-caption text-[var(--color-ink-subtle)] mt-1">
          {when} · {source}
        </p>
        {galleryPath ? (
          <Link
            to={galleryPath}
            className={cnm(
              'inline-flex items-center gap-1 text-caption text-[var(--color-accent)] mt-2',
              'hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]',
            )}
          >
            View on PullCast
          </Link>
        ) : externalUrl ? (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cnm(
              'inline-flex items-center gap-1 text-caption text-[var(--color-accent)] mt-2',
              'hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]',
            )}
          >
            View on Renaiss OS Index
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        ) : null}
      </div>
    </article>
  )
}

function TradesPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['trades', 'recent', 24],
    queryFn: () => getRecentTrades(24),
    // Refetch every 3 min so we don't hammer upstream. Renaiss trade feed
    // moves slowly enough that a 60s poll gave no real user value while
    // dominating our per-window rate-limit budget.
    staleTime: 3 * 60_000,
    refetchInterval: 3 * 60_000,
    retry: false,
  })

  const trades = data?.data ?? []
  const warnings = data?.warnings ?? []

  return (
    <main id="main" className="min-h-screen bg-[var(--color-bg)] pt-28 pb-24">
      <div className="max-w-[900px] mx-auto px-5 sm:px-8">
        <header className="mb-10">
          <h1 className="text-h1 text-[var(--color-ink)] mb-3">Live trades</h1>
          <p className="text-body-l text-[var(--color-ink-muted)] max-w-[560px]">
            Cross-market graded card sales indexed by Renaiss OS — snkrdunk, partner
            shops, and public sources. Refreshes every minute.
          </p>
        </header>

        <WarningBanner warnings={warnings} />

        {isLoading && (
          <div className="space-y-4" aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="skeleton skeleton-animate h-28 rounded-[var(--radius-lg)]"
              />
            ))}
          </div>
        )}

        {isError && (() => {
          const msg = friendlyUpstreamMessage(
            error,
            'Failed to load trades from Renaiss OS Index (beta).',
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

        {!isLoading && !isError && (
          <div className="space-y-4">
            {trades.map((trade, i) => (
              <TradeRow key={trade.id ?? `trade-${i}`} trade={trade} />
            ))}
            {trades.length === 0 && (
              <p className="text-body text-[var(--color-ink-muted)]">
                No recent trades returned from the Index API.
              </p>
            )}
          </div>
        )}

        <footer className="mt-16 pt-6 border-t border-[var(--color-border)]">
          <IndexAttribution />
          <p className="text-caption text-[var(--color-ink-subtle)] mt-2">
            Live feed via PullCast /api/trades/recent · GET /v1/trades/recent
          </p>
        </footer>
      </div>
    </main>
  )
}
