import { useEffect } from 'react'
import { Link, createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useReducedMotion } from 'motion/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { AlertCircle, TrendingDown, TrendingUp } from 'lucide-react'
import { z } from 'zod'
import type { ApiWarning, FeaturedCard as Pull } from '@/lib/api/client'
import { cnm } from '@/utils/style'
import { friendlyUpstreamMessage } from '@/utils/upstreamError'
import { formatUiNumber } from '@/utils/format'
import { getFeatured } from '@/lib/api/client'
import { indexCardGalleryPath } from '@/lib/index-href'

gsap.registerPlugin(ScrollTrigger)

// ─── Search params schema ─────────────────────────────────────────────────────

const featuredSearchSchema = z.object({
  game: z.enum(['all', 'pokemon', 'one-piece', 'sports']).optional().default('all'),
})

export const Route = createFileRoute('/featured')({
  validateSearch: featuredSearchSchema,
  component: FeaturedPage,
})

// ─── Types ────────────────────────────────────────────────────────────────────

type GameFilter = 'all' | 'pokemon' | 'one-piece' | 'sports'

const FILTER_LABELS: Record<GameFilter, string> = {
  all: 'All',
  pokemon: 'Pokemon',
  'one-piece': 'One Piece',
  sports: 'Sports',
}

const FILTERS: Array<GameFilter> = ['all', 'pokemon', 'one-piece', 'sports']

// ─── Sub-components ───────────────────────────────────────────────────────────

function WarningBanner({ warnings }: { warnings: Array<ApiWarning> }) {
  if (!warnings.length) return null
  return (
    <div className="flex flex-col gap-2 mb-6">
      {warnings.map((w) => (
        <div
          key={w.code}
          data-testid="beta-notice-banner"
          className="flex items-start gap-2 bg-[var(--color-warn-soft)] text-[var(--color-warn)] text-xs px-3 py-2 rounded-[var(--radius-sm)]"
        >
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
          <span>{w.message}</span>
        </div>
      ))}
    </div>
  )
}

function GradeBadge({ grader, grade }: { grader: string; grade: number | null }) {
  const g = grader.toUpperCase()
  const label = grade !== null ? `${g} ${grade}` : g || 'Raw'

  const classes: Record<string, string> = {
    PSA: 'bg-[#D91E24] text-white',
    BGS: 'text-[#C0A15B] border border-[#C0A15B]',
    CGC: 'bg-[#1D6BB4] text-white',
    SGC: 'bg-[#F2C94C] text-[#171412]',
  }

  const bgsStyle =
    g === 'BGS' ? { background: 'linear-gradient(180deg,#000 0%,#1A1A1A 100%)' } : {}

  return (
    <span
      className={cnm(
        'inline-flex items-center text-caption px-2.5 py-0.5 rounded-[var(--radius-pill)] h-5 flex-shrink-0',
        classes[g] ??
          'bg-[var(--color-bg-alt)] text-[var(--color-ink-muted)] border border-[var(--color-border)]',
      )}
      style={bgsStyle}
    >
      {label}
    </span>
  )
}

function DeltaBadge({ delta }: { delta: number | null | undefined }) {
  const safe = typeof delta === 'number' && Number.isFinite(delta) ? delta : 0
  const isUp = safe >= 0
  return (
    <span
      className={cnm(
        'inline-flex items-center gap-1 text-caption px-2 py-0.5 rounded-[var(--radius-pill)]',
        isUp
          ? 'bg-[var(--color-success-soft)] text-[var(--color-success)]'
          : 'bg-[rgba(214,69,69,0.1)] text-[var(--color-danger)]',
      )}
      aria-label={`${isUp ? 'up' : 'down'} $${Math.abs(safe).toFixed(2)}`}
    >
      {isUp ? (
        <TrendingUp size={10} aria-hidden="true" />
      ) : (
        <TrendingDown size={10} aria-hidden="true" />
      )}
      {isUp ? '+' : ''}${formatUiNumber(safe, '', { defaultDecimals: 2 })}
    </span>
  )
}

function ConfidenceDot({ level }: { level?: string }) {
  const colors: Record<string, string> = {
    high: 'bg-[var(--color-success)]',
    medium: 'bg-[var(--color-warn)]',
    low: 'bg-[var(--color-ink-subtle)]',
  }
  return (
    <span
      className={cnm(
        'inline-block w-2 h-2 rounded-full flex-shrink-0',
        colors[level ?? 'low'] ?? colors.low,
      )}
      aria-label={`Confidence: ${level ?? 'low'}`}
    />
  )
}

// ─── Card tile ────────────────────────────────────────────────────────────────

function CardTile({ pull }: { pull: Pull }) {
  const delta = (pull.fmv ?? 0) - (pull.packCost ?? 0)
  const confidence = pull.confidence

  // Link to PullCast Index card detail when href is parseable
  const galleryPath = indexCardGalleryPath(pull.href)
  const safeHref = galleryPath

  const inner = (
    <article className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] overflow-hidden transition-[border-color,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-[var(--color-border-strong)] reveal-on-scroll">
      {/* Card image */}
      {pull.imageUrl ? (
        <img
          src={pull.imageUrl}
          alt={pull.cardName}
          className="w-full aspect-[3/4] object-cover border-b border-[var(--color-border)]"
          loading="lazy"
        />
      ) : (
        <div
          className="w-full aspect-[3/4] bg-[var(--color-bg-alt)] border-b border-[var(--color-border)] flex items-center justify-center"
          aria-hidden="true"
        >
          <span className="text-caption text-[var(--color-ink-subtle)]">No image</span>
        </div>
      )}

      <div className="p-4">
        {/* Grade + confidence row */}
        <div className="flex items-center justify-between mb-2">
          <GradeBadge grader={pull.grader} grade={pull.grade} />
          <ConfidenceDot level={confidence} />
        </div>

        {/* Name + set */}
        <p className="text-body-s font-semibold text-[var(--color-ink)] truncate mb-0.5">
          {pull.cardName}
        </p>
        <p className="text-caption text-[var(--color-ink-muted)] truncate mb-3">{pull.setName}</p>

        {/* Price + delta */}
        <div className="flex items-end justify-between gap-2">
          {pull.fmv !== null ? (
            <p className="text-num font-semibold text-[var(--color-ink)]">
              ${formatUiNumber(pull.fmv, '', { defaultDecimals: 2 })}
            </p>
          ) : (
            <p className="text-num text-[var(--color-ink-subtle)]">—</p>
          )}
          {delta !== 0 && <DeltaBadge delta={delta} />}
        </div>

        {safeHref && (
          <p className="text-caption text-[var(--color-accent)] mt-2">View details →</p>
        )}
      </div>
    </article>
  )

  if (safeHref) {
    return (
      <Link
        to={safeHref}
        className="block focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3 focus-visible:outline rounded-[var(--radius-lg)]"
      >
        {inner}
      </Link>
    )
  }

  return inner
}

// ─── Main page ────────────────────────────────────────────────────────────────

function FeaturedPage() {
  const reduced = useReducedMotion()
  const search = useSearch({ from: '/featured' })
  const navigate = useNavigate({ from: '/featured' })

  const activeGame: GameFilter = (search.game as GameFilter | undefined) ?? 'all'

  const setGame = (game: GameFilter) => {
    void navigate({ search: { game }, replace: true })
  }

  const { data: featuredRes, isLoading, isError, error } = useQuery({
    queryKey: ['featured', 24, activeGame],
    queryFn: () => getFeatured(24),
    staleTime: 60_000,
    retry: false,
  })

  const allPulls: Array<Pull> = featuredRes?.data ?? []
  const warnings = featuredRes?.warnings ?? []

  // Client-side filter by game field
  const filtered =
    activeGame === 'all'
      ? allPulls
      : allPulls.filter(
          (p) =>
            p.game?.toLowerCase().replace(/\s+/g, '-') === activeGame,
        )

  // Batch reveal on scroll
  useEffect(() => {
    if (reduced) return

    const ctx = gsap.context(() => {
      ScrollTrigger.batch('.reveal-on-scroll', {
        start: 'top 85%',
        onEnter: (els) => {
          gsap.fromTo(
            els,
            { opacity: 0, y: 24 },
            { opacity: 1, y: 0, ease: 'power2.out', duration: 0.6, stagger: 0.05 },
          )
        },
        once: true,
      })
    })

    return () => ctx.revert()
  }, [reduced, filtered])

  return (
    <main id="main" className="min-h-screen bg-[var(--color-bg)] pt-28 pb-24">
      <div className="max-w-[1200px] mx-auto px-5 sm:px-8">
        {/* Hero */}
        <section className="mb-10">
          <h1 className="text-h1 text-[var(--color-ink)] mb-3">What's moving</h1>
          <p className="text-body-l text-[var(--color-ink-muted)]">
            Top-mover cards across Pokemon, One Piece, and Sports. Powered by Renaiss OS Index.
          </p>
        </section>

        <WarningBanner warnings={warnings} />

        {/* Filter chips */}
        <section aria-label="Filter by game" className="mb-8">
          <div className="flex flex-wrap gap-2" role="listbox" aria-label="Game filter">
            {FILTERS.map((game) => (
              <button
                key={game}
                type="button"
                role="option"
                aria-selected={activeGame === game}
                onClick={() => setGame(game)}
                className={cnm(
                  'text-body-s font-medium px-4 py-2 rounded-[var(--radius-pill)] transition-colors duration-200',
                  activeGame === game
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                    : 'bg-[var(--color-bg-alt)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                )}
              >
                {FILTER_LABELS[game]}
              </button>
            ))}
          </div>
        </section>

        {/* Grid */}
        <section aria-labelledby="featured-grid-heading">
          <h2 id="featured-grid-heading" className="sr-only">
            Featured cards
          </h2>

          {isLoading && (
            <div
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5"
              aria-busy="true"
              aria-live="polite"
            >
              {Array.from({ length: 12 }, (_, i) => (
                <div
                  key={i}
                  className="skeleton skeleton-animate aspect-[3/5] rounded-[var(--radius-lg)]"
                  aria-hidden="true"
                />
              ))}
            </div>
          )}

          {isError && (() => {
            const msg = friendlyUpstreamMessage(
              error,
              'Could not load featured cards. Check back soon.',
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

          {!isLoading && !isError && filtered.length === 0 && (
            <div className="text-center py-20">
              <p className="text-body text-[var(--color-ink-muted)]">
                No featured cards for{' '}
                <strong className="text-[var(--color-ink)]">{FILTER_LABELS[activeGame]}</strong>{' '}
                right now.
              </p>
            </div>
          )}

          {!isLoading && !isError && filtered.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {filtered.map((pull) => (
                <CardTile key={pull.id} pull={pull} />
              ))}
            </div>
          )}
        </section>

        {/* Source footer */}
        <footer className="mt-16 pt-6 border-t border-[var(--color-border)]">
          <p className="text-caption text-[var(--color-ink-subtle)]">
            Data: Renaiss OS Index (beta) · Renaiss main API (beta). Not financial advice.
          </p>
        </footer>
      </div>
    </main>
  )
}
