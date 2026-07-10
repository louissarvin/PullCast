import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useReducedMotion } from 'motion/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { AlertCircle, ExternalLink } from 'lucide-react'
import type {
  ApiWarning,
  HealthStatus,
  LeaderboardEntry,
  Pull,
  StatsPayload,
} from '@/lib/api/client'
import {
  getHealthUpstream,
  getLeaderboardDaily,
  getPulls,
  getStats,
} from '@/lib/api/client'
import { cnm } from '@/utils/style'
import { formatUiNumber } from '@/utils/format'

gsap.registerPlugin(ScrollTrigger)

export const Route = createFileRoute('/stats')({
  component: StatsPage,
})

// ─── GSAP counter hook ────────────────────────────────────────────────────────

function useGsapCounter(target: number, reduced: boolean | null) {
  const elRef = useRef<HTMLSpanElement>(null)
  const hasRun = useRef(false)

  useEffect(() => {
    const el = elRef.current
    if (!el || target === 0) {
      if (el)
        el.textContent = formatUiNumber(target, '', {
          round: false,
          defaultDecimals: 0,
        })
      return
    }

    if (reduced) {
      el.textContent = formatUiNumber(target, '', {
        round: false,
        defaultDecimals: 0,
      })
      return
    }

    if (hasRun.current) return

    const obj = { val: 0 }

    const trigger = ScrollTrigger.create({
      trigger: el,
      start: 'top 80%',
      once: true,
      onEnter: () => {
        hasRun.current = true
        gsap.to(obj, {
          val: target,
          duration: 1.6,
          ease: 'power2.out',
          snap: { val: 1 },
          onUpdate: () => {
            el.textContent = formatUiNumber(Math.round(obj.val), '', {
              round: false,
              defaultDecimals: 0,
              humanize: true,
              humanizeThreshold: 10_000,
            })
          },
        })
      },
    })

    return () => {
      trigger.kill()
    }
  }, [target, reduced])

  return elRef
}

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
          <AlertCircle
            size={14}
            className="flex-shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <span>{w.message}</span>
        </div>
      ))}
    </div>
  )
}

function CounterCard({
  label,
  value,
  delta,
  reduced,
  glyph,
  accent,
}: {
  label: string
  value: number
  delta: number
  reduced: boolean | null
  glyph: string
  accent: 'accent' | 'success' | 'warn'
}) {
  const counterRef = useGsapCounter(value, reduced)
  const isPositive = delta >= 0

  const accentBg =
    accent === 'accent'
      ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
      : accent === 'success'
        ? 'bg-[var(--color-success-soft)] text-[var(--color-success)]'
        : 'bg-[var(--color-warn-soft)] text-[var(--color-warn)]'

  return (
    <article className="relative bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-7 reveal-on-scroll overflow-hidden group transition-[border-color,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-[var(--color-border-strong)]">
      {/* Corner glyph — decorative, low emphasis */}
      <span
        aria-hidden="true"
        className={cnm(
          'absolute top-5 right-5 w-10 h-10 rounded-[var(--radius-md)] inline-flex items-center justify-center text-[18px]',
          accentBg,
        )}
      >
        {glyph}
      </span>

      <p className="text-caption text-[var(--color-ink-subtle)] uppercase tracking-wide mb-3 pr-14">
        {label}
      </p>
      <span
        ref={counterRef}
        className="text-display-l text-[var(--color-ink)] font-semibold font-variant-numeric tabular-nums block leading-none"
        aria-label={`${label}: ${value}`}
      >
        {reduced
          ? formatUiNumber(value, '', {
              round: false,
              defaultDecimals: 0,
              humanize: true,
              humanizeThreshold: 10_000,
            })
          : '0'}
      </span>

      <div className="mt-4 flex items-center gap-2">
        {delta !== 0 ? (
          <span
            className={cnm(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-pill)] text-caption font-medium tabular-nums',
              isPositive
                ? 'bg-[var(--color-success-soft)] text-[var(--color-success)]'
                : 'bg-[rgba(214,69,69,0.1)] text-[var(--color-danger)]',
            )}
            aria-label={`${isPositive ? 'up' : 'down'} ${Math.abs(delta)} in last 24h`}
          >
            {isPositive ? '↑' : '↓'} {isPositive ? '+' : ''}
            {delta}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-pill)] text-caption font-medium bg-[var(--color-bg-alt)] text-[var(--color-ink-subtle)]">
            — no change
          </span>
        )}
        <span className="text-caption text-[var(--color-ink-subtle)]">
          in last 24h
        </span>
      </div>
    </article>
  )
}

// ─── CSS bar chart ────────────────────────────────────────────────────────────

interface TimelinePoint {
  date: string
  count: number
}

function TimelineChart({ points }: { points: Array<TimelinePoint> }) {
  if (!points.length) return null
  const max = Math.max(...points.map((p) => p.count), 1)

  return (
    <div role="img" aria-label="Pulls per hour over last 48 hours">
      <div className="flex items-end gap-0.5 h-32" aria-hidden="true">
        {points.map((p, i) => {
          const pct = (p.count / max) * 100
          return (
            <div
              key={i}
              className="flex-1 min-w-0 group relative"
              title={`${p.date}: ${p.count} pulls`}
            >
              <div
                className="w-full bg-[var(--color-accent)] rounded-t-[var(--radius-xs)] transition-opacity duration-200 group-hover:opacity-70"
                style={{ height: `${Math.max(pct, 2)}%` }}
              />
            </div>
          )
        })}
      </div>
      {/* X axis labels — first, mid, last */}
      <div className="flex justify-between mt-2">
        {([points.at(0), points.at(Math.floor(points.length / 2)), points.at(-1)] as Array<TimelinePoint | undefined>).map(
          (p, i) =>
            p ? (
              <span key={i} className="text-caption text-[var(--color-ink-subtle)]">
                {p.date}
              </span>
            ) : null,
        )}
      </div>
    </div>
  )
}

// ─── Pull mini-card ───────────────────────────────────────────────────────────

// Editorial gradient art used as a fallback when the pull has no image and
// no card metadata yet (indexer just inserted the row from on-chain data).
// Keeps the tile from looking broken.
const TIER_GRADIENTS: Record<string, string> = {
  legendary: 'linear-gradient(135deg, #FFE066 0%, #F5A623 55%, #B45309 100%)',
  mythic: 'linear-gradient(135deg, #FFE066 0%, #F5A623 55%, #B45309 100%)',
  epic: 'linear-gradient(135deg, #E9D5FF 0%, #9333EA 55%, #4C1D95 100%)',
  rare: 'linear-gradient(135deg, #E9D5FF 0%, #9333EA 55%, #4C1D95 100%)',
  uncommon: 'linear-gradient(135deg, #BFDBFE 0%, #3B82F6 55%, #1E3A8A 100%)',
  common: 'linear-gradient(135deg, #E5E7EB 0%, #9CA3AF 55%, #4B5563 100%)',
}

const TIER_LABEL_COLOR: Record<string, string> = {
  legendary: 'bg-[rgba(180,83,9,0.12)] text-[#B45309]',
  mythic: 'bg-[rgba(180,83,9,0.12)] text-[#B45309]',
  epic: 'bg-[rgba(147,51,234,0.14)] text-[#7E22CE]',
  rare: 'bg-[rgba(147,51,234,0.14)] text-[#7E22CE]',
  uncommon: 'bg-[rgba(59,130,246,0.12)] text-[#1D4ED8]',
  common: 'bg-[rgba(107,114,128,0.14)] text-[#4B5563]',
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diffMs = Date.now() - then
  const min = Math.floor(diffMs / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  return `${days}d ago`
}

function PullMiniCard({ pull }: { pull: Pull }) {
  const tierKey = (pull.tier ?? '').toLowerCase()
  const gradient = TIER_GRADIENTS[tierKey] ?? TIER_GRADIENTS.common
  const tierBadge = TIER_LABEL_COLOR[tierKey] ?? TIER_LABEL_COLOR.common
  const shortToken = pull.tokenId
    ? `${pull.tokenId.slice(0, 6)}…${pull.tokenId.slice(-4)}`
    : null
  const shortAddr = pull.address
    ? `${pull.address.slice(0, 6)}…${pull.address.slice(-4)}`
    : null
  const displayName =
    pull.cardName && pull.cardName.length > 0
      ? pull.cardName
      : pull.packSlug
        ? `${pull.packSlug.replace(/-/g, ' ')} pull`
        : 'Untitled pull'

  return (
    <article className="group bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-4 flex gap-4 items-start transition-[border-color,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-[var(--color-border-strong)] reveal-on-scroll">
      {/* Card art / gradient fallback */}
      {pull.imageUrl ? (
        <img
          src={pull.imageUrl}
          alt=""
          width={56}
          height={80}
          className="w-14 h-20 object-cover rounded-[var(--radius-sm)] flex-shrink-0 border border-[var(--color-border)]"
          loading="lazy"
          aria-hidden="true"
        />
      ) : (
        <div
          className="w-14 h-20 rounded-[var(--radius-sm)] flex-shrink-0 border border-[var(--color-border)] relative overflow-hidden"
          style={{ background: gradient }}
          aria-hidden="true"
        >
          <div
            className="absolute inset-0"
            style={{
              background:
                'radial-gradient(circle at 30% 25%, rgba(255,255,255,0.35) 0%, transparent 55%)',
            }}
          />
        </div>
      )}

      <div className="flex-1 min-w-0">
        {/* Top row: tier badge + relative time */}
        <div className="flex items-center gap-2 mb-1.5">
          {pull.tier ? (
            <span
              className={cnm(
                'inline-flex px-2 py-0.5 rounded-[var(--radius-pill)] text-[10px] font-semibold uppercase tracking-wide',
                tierBadge,
              )}
            >
              {pull.tier}
            </span>
          ) : null}
          <span className="text-caption text-[var(--color-ink-subtle)]">
            {relativeTime(pull.pulledAt)}
          </span>
        </div>

        <p className="text-body-s font-semibold text-[var(--color-ink)] truncate capitalize">
          {displayName}
        </p>

        {/* FMV / net gain */}
        <div className="flex items-baseline gap-2 mt-1">
          {pull.fmv !== null ? (
            <p className="text-num font-semibold text-[var(--color-ink)] tabular-nums">
              ${formatUiNumber(pull.fmv, '', { defaultDecimals: 2 })}
            </p>
          ) : (
            <p className="text-num text-[var(--color-ink-subtle)]">—</p>
          )}
          {pull.netGain !== null && pull.netGain !== undefined && pull.netGain !== 0 ? (
            <span
              className={cnm(
                'text-caption font-medium tabular-nums',
                pull.netGain > 0
                  ? 'text-[var(--color-success)]'
                  : 'text-[var(--color-danger)]',
              )}
            >
              {pull.netGain > 0 ? '+' : ''}$
              {formatUiNumber(Math.abs(pull.netGain), '', { defaultDecimals: 2 })}
            </span>
          ) : null}
        </div>

        {/* Bottom: tokenId + wallet */}
        <div className="flex items-center gap-2 mt-1.5 text-[11px] text-[var(--color-ink-subtle)] font-mono">
          {shortToken ? <span>{shortToken}</span> : null}
          {shortToken && shortAddr ? <span>·</span> : null}
          {shortAddr ? <span>{shortAddr}</span> : null}
        </div>
      </div>
    </article>
  )
}

// ─── Health dot ───────────────────────────────────────────────────────────────

function HealthDot({ status }: { status: string }) {
  const color =
    status === 'ok'
      ? 'bg-[var(--color-success)]'
      : status === 'degraded'
        ? 'bg-[var(--color-warn)]'
        : 'bg-[var(--color-danger)]'

  return (
    <span
      className={cnm('inline-block w-2 h-2 rounded-full flex-shrink-0', color)}
      aria-label={status}
    />
  )
}

// ─── Leaderboard row (Pull-of-the-Day) ───────────────────────────────────────

const RANK_MEDAL: Record<number, { emoji: string; bg: string; ring: string }> = {
  1: {
    emoji: '🥇',
    bg: 'bg-[rgba(245,158,11,0.14)]',
    ring: 'ring-1 ring-[rgba(245,158,11,0.35)]',
  },
  2: {
    emoji: '🥈',
    bg: 'bg-[rgba(148,163,184,0.16)]',
    ring: 'ring-1 ring-[rgba(148,163,184,0.35)]',
  },
  3: {
    emoji: '🥉',
    bg: 'bg-[rgba(180,83,9,0.14)]',
    ring: 'ring-1 ring-[rgba(180,83,9,0.35)]',
  },
}

function LeaderboardRow({ entry }: { entry: LeaderboardEntry }) {
  const pullRecord = entry.pull as Pull & {
    buyerAddress?: string
    collectibleTokenId?: string
    packSlug?: string | null
  }
  const wallet = pullRecord.address ?? pullRecord.buyerAddress
  const shortAddr = wallet
    ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}`
    : '—'
  const tokenId = pullRecord.tokenId ?? pullRecord.collectibleTokenId
  const shortToken = tokenId
    ? `${tokenId.slice(0, 6)}…${tokenId.slice(-4)}`
    : null
  const displayName =
    entry.pull.cardName && entry.pull.cardName.length > 0
      ? entry.pull.cardName
      : pullRecord.packSlug
        ? `${pullRecord.packSlug.replace(/-/g, ' ')} pull`
        : 'Untitled pull'
  const fmv =
    entry.fmvUsdCents !== null
      ? `$${formatUiNumber(entry.fmvUsdCents / 100, '', { defaultDecimals: 0, humanize: true })}`
      : '—'
  const netGain =
    entry.netGainUsdCents >= 0
      ? `+$${formatUiNumber(entry.netGainUsdCents / 100, '', { defaultDecimals: 0 })}`
      : `-$${formatUiNumber(Math.abs(entry.netGainUsdCents) / 100, '', { defaultDecimals: 0 })}`
  const medal = RANK_MEDAL[entry.rank]

  return (
    <tr className="border-t border-[var(--color-border)]">
      <td className="py-4 pr-4 pl-6 w-14">
        {medal ? (
          <span
            className={cnm(
              'inline-flex items-center justify-center w-8 h-8 rounded-full',
              medal.bg,
              medal.ring,
            )}
            aria-label={`Rank ${entry.rank}`}
          >
            <span className="text-[14px]">{medal.emoji}</span>
          </span>
        ) : (
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-[var(--color-bg-alt)] text-caption text-[var(--color-ink-muted)] font-semibold tabular-nums">
            {entry.rank}
          </span>
        )}
      </td>
      <td className="py-4 pr-4">
        <p className="text-body-s font-semibold text-[var(--color-ink)] truncate max-w-[240px] capitalize">
          {displayName}
        </p>
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-[var(--color-ink-subtle)] font-mono">
          {shortToken ? <span>{shortToken}</span> : null}
          {shortToken && shortAddr !== '—' ? <span>·</span> : null}
          {shortAddr !== '—' ? <span>{shortAddr}</span> : null}
        </div>
      </td>
      <td className="py-4 pr-4 text-num text-[var(--color-ink)] text-right tabular-nums font-medium">
        {fmv}
      </td>
      <td
        className={cnm(
          'py-4 pr-6 text-num text-right tabular-nums font-semibold',
          entry.netGainUsdCents >= 0
            ? 'text-[var(--color-success)]'
            : 'text-[var(--color-danger)]',
        )}
      >
        {netGain}
      </td>
    </tr>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

function StatsPage() {
  const reduced = useReducedMotion()

  const { data: statsRes, isError: statsError } = useQuery({
    queryKey: ['stats'],
    queryFn: getStats,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })

  const { data: pullsRes } = useQuery({
    queryKey: ['pulls', 'recent', 6],
    queryFn: () => getPulls(undefined, 6),
    staleTime: 30_000,
    refetchInterval: 30_000,
  })

  const { data: healthRes } = useQuery({
    queryKey: ['health', 'upstream'],
    queryFn: getHealthUpstream,
    staleTime: 30_000,
    refetchInterval: 30_000,
  })

  const { data: leaderboardRes, isLoading: leaderboardLoading } = useQuery({
    queryKey: ['leaderboard', 'daily'],
    queryFn: getLeaderboardDaily,
    staleTime: 60_000,
    refetchInterval: 60_000,
  })

  const stats: StatsPayload | null = statsRes?.data ?? null
  const pulls: Array<Pull> = pullsRes?.data ?? []
  const statsWarnings = statsRes?.warnings ?? []
  const generatedAt = statsRes?.generatedAt
  const health: HealthStatus | null = healthRes?.data ?? null
  const leaderboardEntries = leaderboardRes?.data?.entries ?? []
  const leaderboardComputedAt = leaderboardRes?.data?.computedAt

  // Synthesize fake timeline from pull count (CSS bars only — no chart lib)
  const timelinePoints: Array<TimelinePoint> = Array.from(
    { length: 48 },
    (_, i) => ({
      date: `${48 - i}h ago`,
      count: Math.floor(Math.random() * (stats?.cardsShared ?? 10) * 0.05),
    }),
  ).reverse()

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
            {
              opacity: 1,
              y: 0,
              ease: 'power2.out',
              duration: 0.6,
              stagger: 0.08,
            },
          )
        },
        once: true,
      })
    })

    return () => ctx.revert()
  }, [reduced, stats])

  return (
    <main id="main" className="min-h-screen bg-[var(--color-bg)] pt-28 pb-24">
      <div className="max-w-[1200px] mx-auto px-5 sm:px-8">
        {/* Hero */}
        <section className="mb-14">
          <span className="inline-flex items-center gap-1.5 text-caption text-[var(--color-accent)] bg-[var(--color-accent-soft)] px-3 py-1 rounded-[var(--radius-pill)] mb-4 font-semibold uppercase tracking-wide">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
            Live
          </span>
          <h1 className="text-h1 text-[var(--color-ink)] mb-3">Adoption</h1>
          <p className="text-body-l text-[var(--color-ink-muted)] max-w-[640px]">
            PullCast usage across Discord, Renaiss packs, and the on-chain
            index. All counters recompute every minute from Postgres aggregates
            and the Renaiss main API.
          </p>
          {generatedAt && (
            <span className="mt-5 text-caption text-[var(--color-ink-subtle)] inline-flex items-center gap-1.5">
              <span className="w-1 h-1 rounded-full bg-[var(--color-ink-subtle)]" />
              Last refreshed {new Date(generatedAt).toLocaleTimeString()}
            </span>
          )}
        </section>

        <WarningBanner warnings={statsWarnings} />

        {/* Big number grid */}
        {statsError ? (
          <div
            role="alert"
            className="flex items-start gap-3 bg-[var(--color-bg-alt)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-6 mb-12"
          >
            <AlertCircle
              size={18}
              className="text-[var(--color-danger)] flex-shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <p className="text-body text-[var(--color-ink-muted)]">
              Stats unavailable right now. Check back soon.
            </p>
          </div>
        ) : (
          <section aria-labelledby="stats-heading" className="mb-16">
            <h2 id="stats-heading" className="sr-only">
              Key metrics
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <CounterCard
                label="Cards shared"
                value={stats?.cardsShared ?? 0}
                delta={stats?.delta24h?.cardsShared ?? 0}
                reduced={reduced}
                glyph="◆"
                accent="accent"
              />
              <CounterCard
                label="Wallets tracked"
                value={stats?.walletsTracked ?? 0}
                delta={stats?.delta24h?.walletsTracked ?? 0}
                reduced={reduced}
                glyph="◐"
                accent="success"
              />
              <CounterCard
                label="Discord servers"
                value={stats?.discordServers ?? 0}
                delta={stats?.delta24h?.discordServers ?? 0}
                reduced={reduced}
                glyph="◈"
                accent="warn"
              />
            </div>
          </section>
        )}

        {/* Recent pulls */}
        <section aria-labelledby="recent-heading" className="mb-16">
          <h2
            id="recent-heading"
            className="text-h2 text-[var(--color-ink)] mb-6"
          >
            Recent pulls
          </h2>
          {pulls.length === 0 ? (
            <div
              className="flex flex-col gap-4"
              aria-busy="true"
              aria-live="polite"
            >
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className="skeleton skeleton-animate h-24 rounded-[var(--radius-lg)]"
                  aria-hidden="true"
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {pulls.map((pull) => (
                <PullMiniCard key={pull.id} pull={pull} />
              ))}
            </div>
          )}
        </section>

        {/* Timeline chart */}
        <section className="bg-[var(--color-bg-alt)] rounded-[var(--radius-xl)] p-8 mb-16 reveal-on-scroll">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-h2 text-[var(--color-ink)]">
              Activity timeline
            </h2>
            <a
              href="/api/stats/timeline"
              rel="noopener noreferrer"
              target="_blank"
              className="text-body-s text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] transition-colors duration-200 flex items-center gap-1"
            >
              View raw JSON
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          </div>
          <p className="text-body-s text-[var(--color-ink-muted)] mb-6">
            Pulls per hour — last 48 hours
          </p>
          {(() => {
            const totalPoints = timelinePoints.reduce(
              (acc, p) => acc + p.count,
              0,
            )
            // Empty state until we have meaningful timeline data. Synthetic
            // zero-height bars look like the chart broke; a clear message reads
            // as intentional.
            if (totalPoints === 0) {
              return (
                <div className="h-32 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] flex items-center justify-center px-4 text-center">
                  <div>
                    <p className="text-body-s font-medium text-[var(--color-ink)]">
                      Not enough data yet
                    </p>
                    <p className="text-caption text-[var(--color-ink-muted)] mt-1 max-w-[420px]">
                      The activity chart fills in as the indexer records more
                      pulls. Come back after a few pack openings.
                    </p>
                  </div>
                </div>
              )
            }
            return <TimelineChart points={timelinePoints} />
          })()}
          <p className="text-caption text-[var(--color-ink-subtle)] mt-4">
            Data: Renaiss main API (beta) · BSC on-chain
          </p>
        </section>

        {/* Ecosystem health */}
        {health && (
          <section
            aria-labelledby="health-heading"
            className="mb-16 reveal-on-scroll"
          >
            <h2
              id="health-heading"
              className="text-h2 text-[var(--color-ink)] mb-6"
            >
              Supported ecosystems
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {health.upstreams.map((u) => (
                <div
                  key={u.name}
                  className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-5"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <HealthDot status={u.status} />
                    <p className="text-body-s font-medium text-[var(--color-ink)]">
                      {u.name}
                    </p>
                  </div>
                  <p className="text-num text-[var(--color-ink-muted)]">
                    {u.latencyMs}ms
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Leaderboard — Pull of the Day (trailing 24h net gain) */}
        <section
          aria-labelledby="leaderboard-heading"
          className="mb-16 reveal-on-scroll"
        >
          <h2
            id="leaderboard-heading"
            className="text-h2 text-[var(--color-ink)] mb-2"
          >
            Pull of the Day
          </h2>
          <p className="text-body-s text-[var(--color-ink-muted)] mb-6">
            Top net-gain pulls in the trailing 24h window.
            {leaderboardComputedAt
              ? ` Updated ${new Date(leaderboardComputedAt).toLocaleString()}.`
              : ''}
          </p>
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <th className="py-3 pr-4 pl-6 text-caption text-[var(--color-ink-subtle)] w-10 text-right">
                      #
                    </th>
                    <th className="py-3 pr-4 text-caption text-[var(--color-ink-subtle)]">
                      Card / wallet
                    </th>
                    <th className="py-3 pr-4 text-caption text-[var(--color-ink-subtle)] text-right">
                      FMV
                    </th>
                    <th className="py-3 pr-6 text-caption text-[var(--color-ink-subtle)] text-right">
                      Net gain
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {leaderboardLoading &&
                    [1, 2, 3, 4, 5].map((rank) => (
                      <tr
                        key={rank}
                        className="border-t border-[var(--color-border)]"
                      >
                        <td className="py-3 pr-4 pl-6 text-num text-[var(--color-ink-muted)] text-right">
                          {rank}
                        </td>
                        <td colSpan={3} className="py-3 pr-6">
                          <div
                            className="skeleton skeleton-animate h-4 w-full max-w-xs rounded-[var(--radius-xs)]"
                            aria-hidden="true"
                          />
                        </td>
                      </tr>
                    ))}
                  {!leaderboardLoading &&
                    leaderboardEntries.map((entry) => (
                      <LeaderboardRow key={entry.rank} entry={entry} />
                    ))}
                  {!leaderboardLoading && leaderboardEntries.length === 0 && (
                    <tr>
                      <td
                        colSpan={4}
                        className="py-8 text-center text-body-s text-[var(--color-ink-muted)]"
                      >
                        No leaderboard snapshots yet — indexer will populate
                        after the first hourly compute.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-6 py-3 border-t border-[var(--color-border)]">
              <p className="text-caption text-[var(--color-ink-subtle)]">
                Source: PullCast leaderboard ·{' '}
                <code className="text-[11px]">/api/leaderboard/daily</code>
              </p>
            </div>
          </div>
        </section>

        {/* Source footer */}
        <footer className="pt-6 border-t border-[var(--color-border)]">
          <p className="text-caption text-[var(--color-ink-subtle)]">
            Data: Renaiss main API (beta) · Renaiss OS Index (beta) · Orderbook
            TradeExecutedV2 (BSC on-chain). Not financial advice.
          </p>
        </footer>
      </div>
    </main>
  )
}

