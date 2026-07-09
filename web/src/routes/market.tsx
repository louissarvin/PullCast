import { useEffect, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useReducedMotion } from 'motion/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { AlertCircle, TrendingDown, TrendingUp } from 'lucide-react'
import type { ApiWarning, FeaturedCard, MarketSet, Pull } from '@/lib/api/client'
import { cnm } from '@/utils/style'
import { formatUiNumber } from '@/utils/format'
import { friendlyUpstreamMessage } from '@/utils/upstreamError'
import { getFeatured, getIndexConstituents, getMarket } from '@/lib/api/client'

gsap.registerPlugin(ScrollTrigger)

export const Route = createFileRoute('/market')({
  component: MarketPage,
})

// ─── Sparkline SVG ────────────────────────────────────────────────────────────

function Sparkline({ data }: { data: Array<number> }) {
  if (!data.length) return null

  const W = 120
  const H = 36
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * W
      const y = H - ((v - min) / range) * (H - 4) - 2
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden="true"
      className="overflow-visible"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ─── Delta badge ──────────────────────────────────────────────────────────────

function DeltaBadge({ pct }: { pct: number | null | undefined }) {
  const safe = typeof pct === 'number' && Number.isFinite(pct) ? pct : 0
  const isUp = safe >= 0
  const formatted = `${isUp ? '+' : ''}${safe.toFixed(2)}%`

  return (
    <span
      className={cnm(
        'inline-flex items-center gap-1 text-caption px-2 py-0.5 rounded-[var(--radius-pill)]',
        isUp
          ? 'bg-[var(--color-success-soft)] text-[var(--color-success)]'
          : 'bg-[rgba(214,69,69,0.1)] text-[var(--color-danger)]',
      )}
      aria-label={`${isUp ? 'up' : 'down'} ${Math.abs(safe).toFixed(2)} percent`}
    >
      {isUp ? (
        <TrendingUp size={10} aria-hidden="true" />
      ) : (
        <TrendingDown size={10} aria-hidden="true" />
      )}
      {formatted}
    </span>
  )
}

// ─── Market tile ──────────────────────────────────────────────────────────────

// Editorial game-specific gradient used as a fallback hero when no card image
// is available. Colors tuned to each franchise's visual identity.
const GAME_HERO: Record<string, { bg: string; accent: string; emoji: string }> = {
  pokemon: {
    bg: 'linear-gradient(135deg, #FEE39A 0%, #F5B84D 50%, #E24C4B 100%)',
    accent: '#B31E1A',
    emoji: '⚡',
  },
  'one-piece': {
    bg: 'linear-gradient(135deg, #FFD26B 0%, #F76F1E 50%, #B4370B 100%)',
    accent: '#8B2A05',
    emoji: '🏴‍☠️',
  },
  sports: {
    bg: 'linear-gradient(135deg, #6DD5FA 0%, #2980B9 50%, #1A365D 100%)',
    accent: '#0F2A44',
    emoji: '🏆',
  },
}

function TileHeroBackground({ game }: { game: string }) {
  const key = game.toLowerCase().replace(/\s+/g, '-')
  const theme = GAME_HERO[key] ?? {
    bg: 'linear-gradient(135deg, #E7DFD3 0%, #C6B7A0 100%)',
    accent: '#6B5A3F',
    emoji: '◆',
  }
  return (
    <div className="absolute inset-0" style={{ background: theme.bg }} aria-hidden="true">
      {/* Subtle radial highlight top-right */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 78% 22%, rgba(255,255,255,0.35) 0%, transparent 55%)',
        }}
      />
      {/* Oversized game glyph, low opacity, bottom-right corner */}
      <span
        className="absolute right-4 bottom-2 text-[92px] leading-none opacity-25 select-none"
        style={{ color: theme.accent }}
      >
        {theme.emoji}
      </span>
    </div>
  )
}

function MarketTile({
  set,
  heroImageUrl,
}: {
  set: MarketSet
  heroImageUrl: string | null
}) {
  // Fallback synthesized spark only when the API omits sparkline.
  const spark: Array<number> =
    set.spark ??
    Array.from({ length: 30 }, (_, i) =>
      Math.max(0, set.volume24h * (0.6 + 0.4 * Math.sin(i * 0.4 + (set.volume24h % 10)))),
    )

  const cover = set.coverUrl ?? heroImageUrl

  return (
    <article
      className="group bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] overflow-hidden transition-[border-color,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-[var(--color-border-strong)] reveal-on-scroll"
    >
      {/* Hero cover */}
      <div className="relative w-full aspect-[16/10] border-b border-[var(--color-border)] overflow-hidden">
        {cover ? (
          <>
            <img
              src={cover}
              alt=""
              className="w-full h-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03]"
              loading="lazy"
              aria-hidden="true"
            />
            {/* Soft top+bottom gradient so labels stay legible on any image */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background:
                  'linear-gradient(180deg, rgba(23,20,18,0.55) 0%, rgba(23,20,18,0) 45%, rgba(23,20,18,0) 55%, rgba(23,20,18,0.65) 100%)',
              }}
              aria-hidden="true"
            />
          </>
        ) : (
          <TileHeroBackground game={set.game} />
        )}
        {/* Game label pill top-left */}
        <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-pill)] bg-[rgba(255,255,255,0.92)] text-[11px] font-semibold text-[var(--color-ink)] uppercase tracking-wide backdrop-blur-sm">
          {set.game}
        </span>
        {/* "Index" badge top-right so it reads as a benchmark, not a set */}
        <span className="absolute top-3 right-3 inline-flex items-center px-2 py-0.5 rounded-[var(--radius-pill)] bg-[rgba(0,0,0,0.35)] text-[10px] font-semibold text-white uppercase tracking-wider backdrop-blur-sm">
          Index
        </span>
        {/* Bottom title */}
        <div className="absolute bottom-3 left-3 right-3">
          <p
            className={cnm(
              'text-[15px] font-semibold leading-tight',
              cover ? 'text-white drop-shadow-sm' : 'text-[var(--color-ink)]',
            )}
          >
            {set.setName}
          </p>
        </div>
      </div>

      <div className="p-5">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-caption text-[var(--color-ink-subtle)] mb-0.5">Index level</p>
            <p className="text-num font-semibold text-[var(--color-ink)]">
              {formatUiNumber(set.volume24h, '', { defaultDecimals: 2 })}
            </p>
            <p className="text-caption text-[var(--color-ink-subtle)] mt-1">
              {set.cardCount} constituents
            </p>
          </div>

          <div className="flex flex-col items-end gap-2">
            <DeltaBadge pct={set.delta24h} />
            <Sparkline data={spark} />
          </div>
        </div>
      </div>
    </article>
  )
}

// ─── Featured mover card (small) ─────────────────────────────────────────────

function MoverCard({ pull }: { pull: Pull }) {
  const delta = (pull.fmv ?? 0) - (pull.packCost ?? 0)
  const isUp = delta >= 0

  return (
    <article className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-4 flex gap-3 items-start transition-[border-color,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-[var(--color-border-strong)] reveal-on-scroll">
      {pull.imageUrl ? (
        <img
          src={pull.imageUrl}
          alt={pull.cardName}
          width={56}
          height={80}
          className="w-14 h-20 object-cover rounded-[var(--radius-sm)] flex-shrink-0 border border-[var(--color-border)]"
          loading="lazy"
        />
      ) : (
        <div
          className="w-14 h-20 rounded-[var(--radius-sm)] bg-[var(--color-bg-alt)] border border-[var(--color-border)] flex-shrink-0"
          aria-hidden="true"
        />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-body-s font-semibold text-[var(--color-ink)] truncate">{pull.cardName}</p>
        <p className="text-caption text-[var(--color-ink-muted)] truncate mb-2">{pull.setName}</p>
        {pull.fmv !== null && (
          <p className="text-num font-semibold text-[var(--color-ink)]">
            ${formatUiNumber(pull.fmv, '', { defaultDecimals: 2 })}
          </p>
        )}
        {delta !== 0 && (
          <p
            className={cnm(
              'text-num mt-0.5',
              isUp ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]',
            )}
          >
            {isUp ? '+' : ''}${formatUiNumber(Math.abs(delta), '', { defaultDecimals: 2 })}
          </p>
        )}
      </div>
    </article>
  )
}

// ─── Warning banner ───────────────────────────────────────────────────────────

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

// ─── Filter chips ─────────────────────────────────────────────────────────────

const GAMES = ['All', 'Pokemon', 'One Piece', 'Sports'] as const
type Game = (typeof GAMES)[number]

// ─── Index explainer (what is a Renaiss OS Index?) ───────────────────────────

function IndexExplainer() {
  const [open, setOpen] = useState(false)
  return (
    <section
      aria-label="What is a Renaiss OS Index?"
      className="mb-8 bg-[var(--color-bg-alt)] border border-[var(--color-border)] rounded-[var(--radius-lg)] overflow-hidden"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[-2px]"
      >
        <span className="flex items-center gap-3 min-w-0">
          <span
            aria-hidden="true"
            className="flex-shrink-0 w-8 h-8 rounded-[var(--radius-md)] bg-[var(--color-accent-soft)] text-[var(--color-accent)] inline-flex items-center justify-center text-[15px] font-semibold"
          >
            i
          </span>
          <span className="min-w-0">
            <span className="block text-body-s font-semibold text-[var(--color-ink)]">
              What is a Renaiss OS Index?
            </span>
            <span className="block text-caption text-[var(--color-ink-muted)] mt-0.5">
              Basket of top-50 most-traded graded cards, rebalanced monthly.
            </span>
          </span>
        </span>
        <span
          aria-hidden="true"
          className={cnm(
            'flex-shrink-0 text-[var(--color-ink-muted)] text-[13px] transition-transform duration-200',
            open ? 'rotate-180' : 'rotate-0',
          )}
        >
          ▼
        </span>
      </button>

      {open && (
        <div className="px-5 pb-5 pt-1 border-t border-[var(--color-border)] grid gap-4 sm:grid-cols-2">
          <div>
            <p className="text-caption text-[var(--color-ink-subtle)] uppercase tracking-wide mb-1">
              How it works
            </p>
            <p className="text-body-s text-[var(--color-ink)] leading-relaxed">
              Each index tracks the <strong>50 most-traded graded cards</strong> for a
              game (Pokémon, One Piece). The basket rebalances monthly so it always
              reflects what collectors are actually buying right now.
            </p>
          </div>
          <div>
            <p className="text-caption text-[var(--color-ink-subtle)] uppercase tracking-wide mb-1">
              Reading the numbers
            </p>
            <p className="text-body-s text-[var(--color-ink)] leading-relaxed">
              <strong>Index level</strong> starts at <span className="tabular-nums">10,000</span>{' '}
              at launch. A level of <span className="tabular-nums">12,282</span> means
              the basket is up 22.8% since inception.{' '}
              <strong>7d change</strong> is the delta over the last week.
            </p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-caption text-[var(--color-ink-subtle)]">
              Sourced from public sales, Renaiss-owned records, and partner shops
              (snkrdunk, etc). Informational only, not financial advice.
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

function MarketPage() {
  const reduced = useReducedMotion()
  const [activeGame, setActiveGame] = useState<Game>('All')

  const { data: marketRes, isLoading, isError, error } = useQuery({
    queryKey: ['market'],
    queryFn: getMarket,
    staleTime: 60_000,
    retry: false,
  })

  // Fetch a wider set (limit=24 max) so we're guaranteed at least one card
  // image per game (pokemon + one-piece) for the tile hero and the "movers"
  // row. Uses the same cache slot as /featured page so the network call is
  // typically warm.
  const { data: featuredRes } = useQuery({
    queryKey: ['featured', 24],
    queryFn: () => getFeatured(24),
    staleTime: 60_000,
    retry: false,
  })

  // Fallback source of hero images: the drill-down's `constituents[]` always
  // contains 50 cards WITH imageUrls for the matching game. This is used when
  // /featured happens to skew all-Pokemon and leaves the One-Piece tile blank.
  const { data: pokemonConstituents } = useQuery({
    queryKey: ['constituents', 'pokemon'],
    queryFn: () => getIndexConstituents('pokemon'),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const { data: onePieceConstituents } = useQuery({
    queryKey: ['constituents', 'one-piece'],
    queryFn: () => getIndexConstituents('one-piece'),
    staleTime: 5 * 60_000,
    retry: false,
  })

  const allSets: Array<MarketSet> = marketRes?.data ?? []
  const warnings = marketRes?.warnings ?? []

  // Normalize both sides so button label "One Piece" matches API game "one-piece".
  const normalizeGame = (g: string): string =>
    g.toLowerCase().replace(/\s+/g, '-')

  const filteredSets =
    activeGame === 'All'
      ? allSets
      : allSets.filter((s) => normalizeGame(s.game) === normalizeGame(activeGame))

  const movers: Array<FeaturedCard> = featuredRes?.data ?? []

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
            { opacity: 1, y: 0, ease: 'power2.out', duration: 0.6, stagger: 0.06 },
          )
        },
        once: true,
      })
    })

    return () => ctx.revert()
  }, [reduced, filteredSets])

  return (
    <main id="main" className="min-h-screen bg-[var(--color-bg)] pt-28 pb-24">
      <div className="max-w-[1200px] mx-auto px-5 sm:px-8">
        {/* Hero */}
        <section className="mb-10">
          <h1 className="text-h1 text-[var(--color-ink)] mb-3">Market</h1>
          <p className="text-body-l text-[var(--color-ink-muted)]">
            Renaiss OS Index for Pokemon, One Piece, and Sports. Real-time basket prices.
          </p>
        </section>

        <WarningBanner warnings={warnings} />

        {/* What is an Index? — explainer panel */}
        <IndexExplainer />

        {/* Game filter chips */}
        <section aria-label="Filter by game" className="mb-8">
          <div className="flex flex-wrap gap-2" role="listbox" aria-label="Game filter">
            {GAMES.map((game) => (
              <button
                key={game}
                type="button"
                role="option"
                aria-selected={activeGame === game}
                onClick={() => setActiveGame(game)}
                className={cnm(
                  'text-body-s font-medium px-4 py-2 rounded-[var(--radius-pill)] transition-colors duration-200',
                  activeGame === game
                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                    : 'bg-[var(--color-bg-alt)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                )}
              >
                {game}
              </button>
            ))}
          </div>
        </section>

        {/* Market grid */}
        <section aria-labelledby="market-grid-heading" className="mb-16">
          <h2 id="market-grid-heading" className="sr-only">
            Market sets
          </h2>

          {isLoading && (
            <div
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5"
              aria-busy="true"
              aria-live="polite"
            >
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className="skeleton skeleton-animate aspect-[4/5] rounded-[var(--radius-lg)]"
                  aria-hidden="true"
                />
              ))}
            </div>
          )}

          {isError && (() => {
            const msg = friendlyUpstreamMessage(
              error,
              'Market data unavailable. Check back soon.',
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

          {!isLoading && !isError && filteredSets.length === 0 && (
            <p className="text-body text-[var(--color-ink-muted)]">
              No sets found for {activeGame}.
            </p>
          )}

          {!isLoading && !isError && filteredSets.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredSets.map((set) => {
                const gameKey = normalizeGame(set.game)
                // Primary: pick a card image from /featured that matches
                // this tile's game.
                const heroFromMovers = movers.find(
                  (m) =>
                    typeof m.imageUrl === 'string' &&
                    m.imageUrl.length > 0 &&
                    normalizeGame(m.game ?? '') === gameKey,
                )
                // Fallback: use the first constituent (from the drill-down)
                // that carries an image. Guaranteed populated for every game
                // the API exposes.
                const constituents =
                  gameKey === 'pokemon'
                    ? (pokemonConstituents ?? [])
                    : gameKey === 'one-piece'
                      ? (onePieceConstituents ?? [])
                      : []
                const heroFromConstituent = constituents.find(
                  (c) => typeof c.imageUrl === 'string' && c.imageUrl.length > 0,
                )
                const hero =
                  heroFromMovers?.imageUrl ??
                  heroFromConstituent?.imageUrl ??
                  null
                return (
                  <MarketTile
                    key={`${set.game}-${set.setName}`}
                    set={set}
                    heroImageUrl={hero}
                  />
                )
              })}
            </div>
          )}
        </section>

        {/* Top movers crosslink with /featured */}
        {movers.length > 0 && (
          <section aria-labelledby="movers-heading" className="mb-16">
            <div className="flex items-center justify-between mb-6">
              <h2 id="movers-heading" className="text-h2 text-[var(--color-ink)]">
                Top movers
              </h2>
              <Link
                to="/featured"
                className="text-body-s text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] transition-colors duration-200"
              >
                View all featured →
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {movers.map((pull) => (
                <MoverCard key={pull.id} pull={pull} />
              ))}
            </div>
          </section>
        )}

        {/* Source footer */}
        <footer className="pt-6 border-t border-[var(--color-border)]">
          <p className="text-caption text-[var(--color-ink-subtle)]">
            Data: Renaiss OS Index (beta) · Renaiss main API (beta). Not financial advice.
          </p>
        </footer>
      </div>
    </main>
  )
}
