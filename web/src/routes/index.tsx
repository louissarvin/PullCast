/**
 * Route: /
 * Landing page for PullCast.
 *
 * Sections:
 *  1. Hero — headline reveal, fan of share cards, two CTAs
 *  2. How it works — 3-step horizontal
 *  3. Recent pulls grid
 *  4. Stats stripe — GSAP counter numbers
 *  5. Install CTA band — full-bleed accent
 *
 * Data: GET /api/pulls?limit=12&order=recent, GET /api/stats/summary
 * DESIGN.md §5 `/` route spec.
 */

import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { ArrowRight, BadgeCheck, LineChart, ListFilter, Search, ShoppingBag, TrendingUp, Zap } from 'lucide-react'
import { ShareCard } from '@/components/share-card/ShareCard'
import { Skeleton } from '@/components/ui/Skeleton'
import { getLeaderboardDaily, getPulls, getStats } from '@/lib/api/client'
import { useReducedMotion } from '@/lib/motion/reduced-motion'
import { cnm } from '@/utils/style'
import { config } from '@/config'

gsap.registerPlugin(ScrollTrigger)

export const Route = createFileRoute('/')({
  head: () => ({
    meta: [
      { title: 'PullCast — Pull. Brag. Repeat.' },
      {
        name: 'description',
        content:
          'Discord-native pull-bragging for Renaiss collectors. Every pack becomes a permanent share card.',
      },
      { property: 'og:title', content: 'PullCast — Pull. Brag. Repeat.' },
      {
        property: 'og:description',
        content:
          'Discord-native pull-bragging for Renaiss collectors. Every pack becomes a permanent share card.',
      },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
  }),
  component: IndexPage,
})

// ─── Query factories ──────────────────────────────────────────────────────────

const recentPullsQuery = {
  queryKey: ['pulls', 'recent', 12] as const,
  queryFn: () => getPulls(undefined, 12),
  staleTime: 60_000,
}

const statsQuery = {
  queryKey: ['stats', 'summary'] as const,
  queryFn: () => getStats(),
  staleTime: 60_000,
}

const leaderboardQuery = {
  queryKey: ['leaderboard', 'daily'] as const,
  queryFn: () => getLeaderboardDaily(),
  staleTime: 60_000,
}

// ─── Headline word-stagger reveal ─────────────────────────────────────────────

function HeroSection() {
  const reduced = useReducedMotion()
  const headlineRef = useRef<HTMLDivElement>(null)
  const cardFanRef = useRef<HTMLDivElement>(null)
  const [fanHovered, setFanHovered] = useState(false)

  const { data: pullsResult, isLoading } = useQuery(recentPullsQuery)
  const heroCards = pullsResult?.data.slice(0, 3) ?? []

  useEffect(() => {
    const el = headlineRef.current
    if (!el) return
    const words = el.querySelectorAll<HTMLSpanElement>('[data-word]')
    if (!words.length) return

    if (reduced) {
      gsap.set(Array.from(words), { opacity: 1, y: 0, filter: 'blur(0px)' })
      return
    }

    const tween = gsap.fromTo(
      Array.from(words),
      { opacity: 0, y: 40, filter: 'blur(8px)' },
      {
        opacity: 1,
        y: 0,
        filter: 'blur(0px)',
        ease: 'expo.out',
        duration: 1.2,
        stagger: 0.06,
        delay: 0.1,
      }
    )

    return () => {
      tween.kill()
    }
  }, [reduced])

  useEffect(() => {
    const el = cardFanRef.current
    if (!el || reduced || heroCards.length === 0) return

    const cards = el.querySelectorAll<HTMLDivElement>('[data-fan-card]')
    if (!cards.length) return

    const tween = gsap.fromTo(
      Array.from(cards),
      { opacity: 0, y: 32, scale: 0.96 },
      {
        opacity: 1,
        y: 0,
        scale: 1,
        ease: 'expo.out',
        duration: 1.0,
        stagger: 0.12,
        delay: 0.5,
      }
    )

    return () => {
      tween.kill()
    }
  }, [reduced, heroCards.length])

  return (
    <section className="min-h-[90vh] flex items-center pt-24 pb-16 px-5 sm:px-8 bg-[var(--color-bg)]">
      <div className="max-w-[1200px] mx-auto w-full">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-16 items-center">
          {/* Left — copy */}
          <div>
            <p className="text-caption text-[var(--color-ink-muted)] mb-5">
              Discord + Web · Renaiss TCG
            </p>

            {/* Headline — each word wrapped for GSAP stagger */}
            <div
              ref={headlineRef}
              className="text-display-l text-[var(--color-ink)] mb-6"
              aria-label="Your pulls, worth bragging about."
            >
              {['Your', 'pulls,', 'worth', 'bragging', 'about.'].map((word) => (
                <span
                  key={word}
                  data-word
                  className="inline-block mr-[0.25em] last:mr-0"
                  style={{ willChange: 'transform, opacity, filter' }}
                >
                  {word}
                </span>
              ))}
            </div>

            <p className="text-body-l text-[var(--color-ink-muted)] mb-10 max-w-[480px]">
              PullCast auto-posts a share card in your Renaiss Discord every time you open a pack. Every pull becomes a permanent artifact.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <a
                href={config.links.discord || 'https://discord.com'}
                rel="noopener noreferrer"
                target="_blank"
                className="inline-flex items-center gap-2 h-12 px-7 text-[15px] font-semibold rounded-[24px] bg-[var(--color-accent)] text-[var(--color-accent-ink)] transition-all duration-[180ms] ease-out hover:opacity-90 active:translate-y-px focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
              >
                Install to Discord
              </a>
              <a
                href="#recent-pulls"
                className="inline-flex items-center gap-2 h-12 px-7 text-[15px] font-medium rounded-[24px] bg-[var(--color-surface)] text-[var(--color-ink)] border border-[var(--color-border-strong)] transition-all duration-[180ms] ease-out hover:bg-[var(--color-bg-alt)] active:translate-y-px focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
              >
                See recent pulls
                <ArrowRight size={15} aria-hidden="true" />
              </a>
            </div>
          </div>

          {/* Right — fan of 3 share cards (desktop only).
              Hover anywhere on the fan → cards spread apart with 3D depth.
              Each card rotates further from center + shifts horizontally,
              revealing the cards behind. Perspective on parent gives depth. */}
          <div
            ref={cardFanRef}
            className="relative hidden lg:flex items-center justify-center h-[480px]"
            style={{ perspective: '1200px' }}
            onMouseEnter={reduced ? undefined : () => setFanHovered(true)}
            onMouseLeave={reduced ? undefined : () => setFanHovered(false)}
            aria-hidden="true"
          >
            {isLoading ? (
              <div className="relative w-[280px] h-[380px]">
                {([-6, 0, 6] as const).map((deg, i) => (
                  <div
                    key={deg}
                    className="absolute inset-0 rounded-[var(--radius-lg)] bg-[var(--color-bg-alt)] border border-[var(--color-border)] skeleton-animate"
                    style={{ transform: `rotate(${deg}deg)`, transformOrigin: 'bottom center', zIndex: i + 1 }}
                  />
                ))}
              </div>
            ) : (
              <div className="relative w-[280px] h-[380px]">
                {heroCards.length > 0
                  ? heroCards.map((pull, i) => {
                      // Rest state: subtle stagger. Hover state: cards
                      // spread horizontally + tilt back slightly (subtle 3D
                      // rotateY) so the whole fan looks like a hand of cards
                      // being drawn open. All 3 cards animate together.
                      const restStates = [
                        { rot: -6, x: 0, y: 0 },
                        { rot: 0, x: 0, y: -8 },
                        { rot: 6, x: 0, y: 0 },
                      ]
                      const hoverStates = [
                        { rot: -20, x: -110, y: -18, ry: -10 },
                        { rot: 0, x: 0, y: -32, ry: 0 },
                        { rot: 20, x: 110, y: -18, ry: 10 },
                      ]
                      const rest = restStates[i] ?? { rot: 0, x: 0, y: 0 }
                      const hover = hoverStates[i] ?? {
                        rot: 0,
                        x: 0,
                        y: 0,
                        ry: 0,
                      }
                      const s = fanHovered ? hover : rest
                      const zIndexes = [1, 3, 2] as const
                      return (
                        <div
                          key={pull.id}
                          data-fan-card
                          className="absolute inset-0 will-change-transform motion-reduce:transition-none"
                          style={{
                            transformOrigin: 'bottom center',
                            zIndex: zIndexes[i] ?? 1,
                            transform: `translate3d(${s.x}px, ${s.y}px, 0) rotate(${s.rot}deg) rotateY(${'ry' in s ? s.ry : 0}deg)`,
                            transition:
                              'transform 550ms cubic-bezier(0.22, 1, 0.36, 1)',
                          }}
                        >
                          <ShareCard pull={pull} linkable={false} />
                        </div>
                      )
                    })
                  : ([-6, 0, 6] as const).map((deg, i) => (
                      <div
                        key={deg}
                        className="absolute inset-0 rounded-[var(--radius-lg)] bg-[var(--color-bg-alt)] border border-[var(--color-border)] skeleton-animate"
                        style={{ transform: `rotate(${deg}deg)`, transformOrigin: 'bottom center', zIndex: i + 1 }}
                      />
                    ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function HowItWorksSection() {
  const reduced = useReducedMotion()

  const steps = [
    {
      title: 'Add the bot to your Discord server.',
      body: 'One click. Authorize PullCast in your Renaiss Discord channel and you\'re live in seconds.',
    },
    {
      title: 'Link the Renaiss wallets you want to brag about.',
      body: 'Type a wallet address in Discord. PullCast watches it on-chain and via the Renaiss OS Index.',
    },
    {
      title: 'Open a pack. PullCast posts the artifact.',
      body: 'Every pull gets a polished share card with FMV, grade, and cert-bridge data — instantly.',
    },
  ] as const

  return (
    <section className="bg-[var(--color-bg)] py-[clamp(96px,12vw,160px)] px-5 sm:px-8">
      <div className="max-w-[1200px] mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
          {steps.map((step, i) => (
            <div key={step.title} className="reveal-on-scroll h-full">
              <div
                className={cnm(
                  'group relative overflow-hidden bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-8 h-full flex flex-col gap-4 transition-[border-color] duration-300 ease-out hover:border-[var(--color-border-strong)]',
                  reduced && 'transition-colors hover:bg-[var(--color-accent-soft)]',
                )}
              >
                {!reduced && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-8 top-8 z-0 size-8 rounded-full bg-[var(--color-accent-soft)] origin-center scale-0 transition-transform duration-[700ms] ease-[var(--ease-out-expo)] group-hover:scale-[32]"
                  />
                )}
                <span className="relative z-10 inline-flex items-center justify-center w-8 h-8 rounded-[var(--radius-pill)] bg-[var(--color-accent-soft)] text-[var(--color-accent)] text-sm font-semibold flex-shrink-0">
                  {i + 1}
                </span>
                <h3 className="relative z-10 text-h3 text-[var(--color-ink)]">{step.title}</h3>
                <p className="relative z-10 text-body text-[var(--color-ink-muted)]">{step.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Pull of the Day (top 3 net-gain leaderboard on homepage) ────────────────

const RANK_MEDAL_HOME: Record<number, { emoji: string; ring: string; glow: string }> = {
  1: {
    emoji: '🥇',
    ring: 'ring-2 ring-[rgba(245,158,11,0.45)]',
    glow: 'shadow-[0_0_0_6px_rgba(245,158,11,0.08)]',
  },
  2: {
    emoji: '🥈',
    ring: 'ring-2 ring-[rgba(148,163,184,0.45)]',
    glow: 'shadow-[0_0_0_6px_rgba(148,163,184,0.10)]',
  },
  3: {
    emoji: '🥉',
    ring: 'ring-2 ring-[rgba(180,83,9,0.45)]',
    glow: 'shadow-[0_0_0_6px_rgba(180,83,9,0.10)]',
  },
}

function PullOfTheDaySection() {
  const { data: result, isLoading, isError } = useQuery(leaderboardQuery)
  const entries = result?.data?.entries ?? []
  const top3 = entries.slice(0, 3)

  // Hide the section entirely on empty state so the homepage stays tight until
  // there's at least one qualifying pull. The /stats page has the empty state.
  if (!isLoading && !isError && top3.length === 0) return null

  const formatFmv = (cents: number | null): string => {
    if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—'
    const usd = cents / 100
    if (Math.abs(usd) >= 1000) {
      return `$${usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    }
    return `$${usd.toFixed(0)}`
  }
  const formatGain = (cents: number): string => {
    const abs = Math.abs(cents) / 100
    const val = abs >= 1000 ? abs.toLocaleString('en-US', { maximumFractionDigits: 0 }) : abs.toFixed(0)
    return `${cents >= 0 ? '+' : '-'}$${val}`
  }

  return (
    <section
      id="pull-of-the-day"
      className="bg-[var(--color-bg)] py-[clamp(88px,11vw,144px)] px-5 sm:px-8"
    >
      <div className="max-w-[1200px] mx-auto">
        <div className="reveal-on-scroll mb-10 flex items-end justify-between flex-wrap gap-4">
          <div>
            <span className="inline-flex items-center gap-1.5 text-caption text-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 py-1 rounded-[var(--radius-pill)] mb-3 font-semibold uppercase tracking-wide">
              Live · Last 24h
            </span>
            <h2 className="text-h2 text-[var(--color-ink)] mb-2">Pull of the Day</h2>
            <p className="text-body-s text-[var(--color-ink-muted)] max-w-[560px]">
              Top net-gain pulls across every subscribed channel, recomputed
              hourly from PullCast leaderboard snapshots.
            </p>
          </div>
          <Link
            to="/stats"
            className="inline-flex items-center gap-1.5 text-body-s text-[var(--color-accent)] font-medium hover:opacity-80 transition-opacity focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3 focus-visible:outline rounded-[var(--radius-xs)]"
          >
            Full leaderboard
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>

        {isLoading && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5" aria-busy="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} radius="lg" height="h-[220px]" />
            ))}
          </div>
        )}

        {!isLoading && !isError && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
            {top3.map((entry) => {
              const medal = RANK_MEDAL_HOME[entry.rank]
              const gain = entry.netGainUsdCents
              const gainPositive = gain >= 0
              const pullRecord = entry.pull as {
                cardName?: string | null
                packSlug?: string | null
                tokenId?: string | null
                collectibleTokenId?: string | null
                address?: string | null
                buyerAddress?: string | null
              }
              const displayName =
                pullRecord.cardName && pullRecord.cardName.length > 0
                  ? pullRecord.cardName
                  : pullRecord.packSlug
                    ? `${pullRecord.packSlug.replace(/-/g, ' ')} pull`
                    : 'Untitled pull'
              const wallet = pullRecord.address ?? pullRecord.buyerAddress
              const shortAddr = wallet
                ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}`
                : null
              const tokenId = pullRecord.tokenId ?? pullRecord.collectibleTokenId
              const shortToken = tokenId
                ? `${tokenId.slice(0, 6)}…${tokenId.slice(-4)}`
                : null

              // Tier-based gradient for the hero card art (indexer usually doesn't
              // resolve card images for on-chain pulls, so we surface a colored
              // "collectible" tile as a fallback that reads as intentional rather
              // than broken).
              const tier = (entry.pull as { tier?: string | null }).tier
              const tierKey = (tier ?? 'common').toLowerCase()
              const heroGradient =
                tierKey === 'legendary' || tierKey === 'mythic'
                  ? 'linear-gradient(135deg, #FFE066 0%, #F5A623 55%, #B45309 100%)'
                  : tierKey === 'epic' || tierKey === 'rare'
                    ? 'linear-gradient(135deg, #E9D5FF 0%, #9333EA 55%, #4C1D95 100%)'
                    : tierKey === 'uncommon'
                      ? 'linear-gradient(135deg, #BFDBFE 0%, #3B82F6 55%, #1E3A8A 100%)'
                      : 'linear-gradient(135deg, #E5E7EB 0%, #9CA3AF 55%, #4B5563 100%)'

              return (
                <article
                  key={entry.rank}
                  className="reveal-on-scroll group relative bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-6 transition-[border-color,transform] duration-200 ease-out hover:-translate-y-1 hover:border-[var(--color-border-strong)] overflow-hidden"
                >
                  {/* Hero art tile — always renders, gradient fallback per tier.
                      The rank medal now sits INSIDE the tile so it can't be
                      clipped by the parent card boundary. */}
                  <div
                    className="w-full aspect-[16/9] rounded-[var(--radius-md)] mb-5 relative overflow-hidden border border-[var(--color-border)]"
                    style={{ background: heroGradient }}
                  >
                    <div
                      className="absolute inset-0 pointer-events-none"
                      style={{
                        background:
                          'radial-gradient(circle at 78% 22%, rgba(255,255,255,0.35) 0%, transparent 55%)',
                      }}
                      aria-hidden="true"
                    />

                    {/* Rank medal inside the hero art, top-right */}
                    {medal ? (
                      <span
                        className={cnm(
                          'absolute top-3 right-3 inline-flex items-center justify-center w-11 h-11 rounded-full bg-[rgba(255,255,255,0.95)] transition-transform duration-200 group-hover:scale-110 backdrop-blur-sm',
                          medal.ring,
                        )}
                        aria-label={`Rank ${entry.rank}`}
                      >
                        <span className="text-[22px] leading-none">
                          {medal.emoji}
                        </span>
                      </span>
                    ) : null}

                    {tier ? (
                      <span className="absolute bottom-3 left-3 inline-flex px-2 py-0.5 rounded-[var(--radius-pill)] bg-[rgba(255,255,255,0.92)] text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink)] backdrop-blur-sm">
                        {tier}
                      </span>
                    ) : null}
                  </div>

                  <p className="text-caption text-[var(--color-ink-subtle)] uppercase tracking-wide mb-2">
                    Rank #{entry.rank}
                  </p>
                  <h3 className="text-body font-semibold text-[var(--color-ink)] capitalize leading-tight mb-4 line-clamp-2 min-h-[2.75em]">
                    {displayName}
                  </h3>

                  <div className="grid grid-cols-2 gap-3 mb-5">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-[var(--color-ink-subtle)] mb-0.5">
                        FMV
                      </p>
                      <p className="text-num font-semibold text-[var(--color-ink)] tabular-nums leading-tight">
                        {formatFmv(entry.fmvUsdCents)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-[var(--color-ink-subtle)] mb-0.5">
                        Net gain
                      </p>
                      <p
                        className={cnm(
                          'text-num font-semibold tabular-nums leading-tight',
                          gainPositive
                            ? 'text-[var(--color-success)]'
                            : 'text-[var(--color-danger)]',
                        )}
                      >
                        {formatGain(gain)}
                      </p>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-[var(--color-border)] flex items-center gap-2 text-[11px] text-[var(--color-ink-subtle)] font-mono">
                    {shortToken ? <span>{shortToken}</span> : null}
                    {shortToken && shortAddr ? <span>·</span> : null}
                    {shortAddr ? <span>{shortAddr}</span> : null}
                    {!shortToken && !shortAddr ? (
                      <span className="italic">Pull metadata pending indexer</span>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

function RecentPullsSection() {
  const { data: result, isLoading, isError, refetch } = useQuery(recentPullsQuery)
  const pulls = result?.data ?? []

  return (
    <section id="recent-pulls" className="bg-[var(--color-bg)] py-[clamp(96px,12vw,160px)] px-5 sm:px-8">
      <div className="max-w-[1200px] mx-auto">
        <div className="reveal-on-scroll mb-10">
          <h2 className="text-h2 text-[var(--color-ink)] mb-2">Recent pulls</h2>
          <p className="text-body-s text-[var(--color-ink-muted)]">
            The last 12 pulls posted by PullCast across all opted-in servers.
          </p>
        </div>

        {isLoading && (
          <div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5"
            aria-busy="true"
            aria-live="polite"
          >
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} radius="lg" height="h-[380px]" />
            ))}
          </div>
        )}

        {isError && (
          <div className="py-12 text-center flex flex-col items-center gap-4">
            <p className="text-[var(--color-danger)] text-sm">
              Failed to load recent pulls from Renaiss main API (beta).
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="inline-flex items-center h-9 px-4 text-sm font-medium rounded-[var(--radius-md)] bg-[var(--color-surface)] text-[var(--color-ink)] border border-[var(--color-border-strong)] hover:bg-[var(--color-bg-alt)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
            >
              Retry
            </button>
          </div>
        )}

        {!isLoading && !isError && pulls.length === 0 && (
          <div className="py-16 text-center flex flex-col items-center gap-5">
            <p className="text-[var(--color-ink-muted)] text-body">
              No pulls in the last 24h. Be the first — install the bot.
            </p>
            <a
              href={config.links.discord || 'https://discord.com'}
              rel="noopener noreferrer"
              target="_blank"
              className="inline-flex items-center gap-2 h-10 px-5 text-[14px] font-semibold rounded-[var(--radius-md)] bg-[var(--color-accent)] text-[var(--color-accent-ink)] transition-all duration-[180ms] ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
            >
              Install to Discord
            </a>
          </div>
        )}

        {!isLoading && !isError && pulls.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {pulls.slice(0, 12).map((pull) => (
              <div key={pull.id} className="reveal-on-scroll">
                <ShareCard pull={pull} />
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-[var(--color-ink-subtle)] mt-6">
          Data: Renaiss main API (beta)
        </p>

        <div className="mt-8 flex justify-center">
          <Link
            to="/featured"
            className="inline-flex items-center gap-2 text-[var(--color-accent)] text-sm font-medium hover:opacity-80 transition-opacity duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline rounded-[var(--radius-xs)]"
          >
            View full gallery
            <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </div>
    </section>
  )
}

function StatsSection() {
  const reduced = useReducedMotion()
  const { data: result } = useQuery(statsQuery)
  const stats = result?.data
  const containerRef = useRef<HTMLDivElement>(null)
  const animated = useRef(false)

  useEffect(() => {
    if (!stats || animated.current) return

    const els = containerRef.current?.querySelectorAll<HTMLSpanElement>('[data-counter-target]')
    if (!els?.length) return

    const targets = [stats.cardsShared, stats.walletsTracked, stats.discordServers]

    if (reduced) {
      els.forEach((el, i) => {
        el.textContent = (targets[i] ?? 0).toLocaleString()
      })
      animated.current = true
      return
    }

    const trigger = ScrollTrigger.create({
      trigger: containerRef.current,
      start: 'top 80%',
      once: true,
      onEnter: () => {
        if (animated.current) return
        animated.current = true
        els.forEach((el, i) => {
          const target = targets[i] ?? 0
          const proxy = { val: 0 }
          gsap.to(proxy, {
            val: target,
            duration: 1.6,
            ease: 'power2.out',
            snap: { val: 1 },
            onUpdate: () => {
              el.textContent = Math.round(proxy.val).toLocaleString()
            },
          })
        })
      },
    })

    return () => {
      trigger.kill()
    }
  }, [stats, reduced])

  const counterLabels = [
    { label: 'Cards shared', key: 'cards' },
    { label: 'Wallets tracked', key: 'wallets' },
    { label: 'Discord servers', key: 'servers' },
  ] as const

  return (
    <section className="bg-[var(--color-bg)] py-[clamp(96px,12vw,160px)] px-5 sm:px-8">
      <div className="max-w-[1200px] mx-auto">
        <div className="reveal-on-scroll mb-10 flex items-baseline gap-4 flex-wrap">
          <h2 className="text-h2 text-[var(--color-ink)]">By the numbers</h2>
          <p className="text-body-s text-[var(--color-ink-muted)]">Live. Updated every minute.</p>
        </div>

        <div ref={containerRef} className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {counterLabels.map((c) => (
            <div
              key={c.key}
              className="reveal-on-scroll bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-8 flex flex-col gap-2"
            >
              <span
                data-counter-target
                className="text-display-l text-[var(--color-ink)] tabular-nums leading-none"
              >
                {reduced && stats
                  ? c.key === 'cards'
                    ? stats.cardsShared.toLocaleString()
                    : c.key === 'wallets'
                    ? stats.walletsTracked.toLocaleString()
                    : stats.discordServers.toLocaleString()
                  : '0'}
              </span>
              <span className="text-body-s text-[var(--color-ink-muted)]">{c.label}</span>
            </div>
          ))}
        </div>

        <div className="mt-8 flex items-center gap-4 flex-wrap">
          <p className="text-xs text-[var(--color-ink-subtle)]">
            Data: Renaiss OS Index (beta) · /api/stats/summary
          </p>
          <Link
            to="/stats"
            className="text-[var(--color-accent)] text-xs font-medium hover:opacity-80 transition-opacity duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline rounded-[var(--radius-xs)]"
          >
            Full stats →
          </Link>
        </div>
      </div>
    </section>
  )
}

function InstallCtaSection() {
  return (
    <section className="bg-[var(--color-bg)] py-[clamp(96px,12vw,160px)] px-5 sm:px-8">
      <div className="max-w-[1200px] mx-auto">
        <div className="reveal-on-scroll relative overflow-hidden rounded-[var(--radius-xl)] border border-transparent bg-[var(--color-accent)] px-6 py-16 sm:px-12 sm:py-20 lg:px-20 lg:py-24 text-center">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{ backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.12) 1px, transparent 1px)', backgroundSize: '24px 24px' }}
          />
          <div className="relative">
            <p className="text-caption text-white/80 mb-4 uppercase tracking-wide">Ready when you are</p>
            <h2 className="text-display-l text-white mb-5">
              Ready to brag?
            </h2>
            <p className="text-body-l text-white/85 mb-10 max-w-[480px] mx-auto">
              Add PullCast in 30 seconds. Zero config required.
            </p>
            <a
              href={config.links.discord || 'https://discord.com'}
              rel="noopener noreferrer"
              target="_blank"
              className="inline-flex items-center gap-2 h-12 px-8 text-[15px] font-semibold rounded-[24px] bg-white text-[var(--color-accent)] transition-all duration-[180ms] ease-out hover:opacity-90 active:translate-y-px focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-[3px] focus-visible:outline"
            >
              Install to Discord
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── Renaiss OS Index hub ─────────────────────────────────────────────────────

const INDEX_LINKS = [
  {
    label: 'Live trades',
    desc: 'Cross-market graded sales indexed by Renaiss OS',
    href: '/trades' as const,
    icon: TrendingUp,
  },
  {
    label: 'Marketplace',
    desc: 'Vault listings from GET /v0/marketplace',
    href: '/browse' as const,
    icon: ShoppingBag,
  },
  {
    label: 'Featured movers',
    desc: 'Top cards from GET /v1/cards/featured',
    href: '/featured' as const,
    icon: Zap,
  },
  {
    label: 'Market indices',
    desc: 'Pokemon · One Piece · Sports basket tiles',
    href: '/market' as const,
    icon: LineChart,
  },
  {
    label: 'Card Lens',
    desc: 'Cert Bridge — tokenId or PSA cert to Index FMV',
    href: '/price' as const,
    icon: Search,
  },
  {
    label: 'Search Index',
    desc: 'Free-text GET /v1/search across graded cards',
    href: '/search' as const,
    icon: ListFilter,
  },
  {
    label: 'Ecosystem map',
    desc: 'Judge-facing Renaiss integration matrix',
    href: '/ecosystem' as const,
    icon: BadgeCheck,
  },
] as const

function EcosystemIndexSection() {
  return (
    <section className="py-[clamp(72px,10vw,120px)] px-5 sm:px-8 bg-[var(--color-bg)]">
      <div className="max-w-[1200px] mx-auto">
        <div className="reveal-on-scroll mb-10 max-w-[560px]">
          <p className="text-caption text-[var(--color-accent)] uppercase tracking-wide mb-2">
            Renaiss OS Index (beta)
          </p>
          <h2 className="text-h2 text-[var(--color-ink)] mb-3">
            Every Index surface, one gallery
          </h2>
          <p className="text-body text-[var(--color-ink-muted)]">
            PullCast is the first community client wiring Renaiss main API, Index API, and CLI
            together — trades, featured movers, indices, cert lookup, and set listings.
          </p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 reveal-on-scroll">
          {INDEX_LINKS.map(({ label, desc, href, icon: Icon }) => (
            <Link
              key={href}
              to={href}
              className="group bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-5 hover:border-[var(--color-border-strong)] hover:-translate-y-0.5 transition-all duration-200"
            >
              <Icon
                size={20}
                className="text-[var(--color-accent)] mb-3"
                aria-hidden="true"
              />
              <p className="text-body font-medium text-[var(--color-ink)] mb-1">{label}</p>
              <p className="text-caption text-[var(--color-ink-muted)]">{desc}</p>
              <p className="text-caption text-[var(--color-accent)] mt-3 group-hover:underline">
                Explore →
              </p>
            </Link>
          ))}
        </div>
        <p className="text-caption text-[var(--color-ink-subtle)] mt-8 reveal-on-scroll">
          Example set:{' '}
          <Link
            to="/sets/pokemon/pokemon-japanese-sv2a-pokemon-151"
            className="text-[var(--color-accent)] hover:underline"
          >
            Pokémon 151 (JP)
          </Link>
          {' · '}
          <Link to="/ecosystem" className="text-[var(--color-accent)] hover:underline">
            Full ecosystem map
          </Link>
          {' · '}
          Attribution to Renaiss OS Index required on all public price displays.
        </p>
      </div>
    </section>
  )
}

// ─── Section reveal batch ─────────────────────────────────────────────────────

function useScrollReveal(reduced: boolean) {
  useEffect(() => {
    if (reduced) return

    const ctx = gsap.context(() => {
      ScrollTrigger.batch('.reveal-on-scroll', {
        start: 'top 85%',
        onEnter: (elements) => {
          gsap.fromTo(
            elements,
            { opacity: 0, y: 24 },
            { opacity: 1, y: 0, ease: 'power2.out', duration: 0.6, stagger: 0 }
          )
        },
        once: true,
      })
    })

    return () => {
      ctx.revert()
    }
  }, [reduced])
}

// ─── Page component ───────────────────────────────────────────────────────────

function IndexPage() {
  const reduced = useReducedMotion()
  useScrollReveal(reduced)

  return (
    <>
      <HeroSection />
      <HowItWorksSection />
      <PullOfTheDaySection />
      <RecentPullsSection />
      <EcosystemIndexSection />
      <StatsSection />
      <InstallCtaSection />
    </>
  )
}

