import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { AlertCircle, ExternalLink, Package, X } from 'lucide-react'
import type { ApiWarning, OddsEntry, Pack } from '@/lib/api/client'
import { cnm } from '@/utils/style'
import { formatUiNumber } from '@/utils/format'
import { getOdds, getPacks } from '@/lib/api/client'

gsap.registerPlugin(ScrollTrigger)

export const Route = createFileRoute('/packs')({
  component: PacksPage,
})

// ─── URL safety ───────────────────────────────────────────────────────────────

const ALLOWED_IMAGE_SCHEMES = ['https:', 'http:']

function sanitizeImageUrl(url: string | null): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (!ALLOWED_IMAGE_SCHEMES.includes(parsed.protocol)) return null
    return url
  } catch {
    return null
  }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** Format wei (18-decimal) to USD display string */
function formatWei(wei: number): string {
  const usdt = wei / 1e18
  return formatUiNumber(usdt, '', { defaultDecimals: 2 })
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

// ─── Odds modal ───────────────────────────────────────────────────────────────

function OddsModal({
  packId,
  packName,
  onClose,
  reduced,
}: {
  packId: string
  packName: string
  onClose: () => void
  reduced: boolean | null
}) {
  const { data: oddsRes, isLoading, isError } = useQuery({
    queryKey: ['odds', packId],
    queryFn: () => getOdds(packId),
    staleTime: 300_000,
  })

  const odds: Array<OddsEntry> = oddsRes?.data ?? []

  // Keyboard close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <>
      {/* Scrim */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-40 bg-[rgba(23,20,18,0.45)]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Dialog */}
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="odds-modal-title"
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
        transition={
          reduced ? { duration: 0.1 } : { type: 'spring', stiffness: 260, damping: 26 }
        }
        className="fixed inset-0 z-50 flex items-center justify-center p-5 pointer-events-none"
      >
        <div className="w-full max-w-[520px] max-h-[80vh] overflow-y-auto bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-xl)] p-8 pointer-events-auto">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 id="odds-modal-title" className="text-h3 text-[var(--color-ink)]">
                Pack odds
              </h2>
              <p className="text-body-s text-[var(--color-ink-muted)] mt-0.5">{packName}</p>
            </div>
            <button
              type="button"
              aria-label="Close dialog"
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-[var(--radius-md)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:bg-[var(--color-accent-soft)] transition-colors duration-200"
            >
              <X size={16} />
            </button>
          </div>

          {isLoading && (
            <div className="flex flex-col gap-3" aria-busy="true" aria-live="polite">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="skeleton skeleton-animate h-10 rounded-[var(--radius-sm)]"
                  aria-hidden="true"
                />
              ))}
            </div>
          )}

          {isError && (
            <p className="text-body-s text-[var(--color-danger)] flex items-center gap-2">
              <AlertCircle size={14} aria-hidden="true" />
              Could not load odds for this pack.
            </p>
          )}

          {!isLoading && !isError && odds.length === 0 && (
            <p className="text-body-s text-[var(--color-ink-muted)]">
              No odds data available for this pack.
            </p>
          )}

          {!isLoading && odds.length > 0 && (
            <div className="flex flex-col gap-0">
              <div className="grid grid-cols-3 gap-4 py-2 border-b border-[var(--color-border)]">
                <span className="text-caption text-[var(--color-ink-subtle)]">Rarity</span>
                <span className="text-caption text-[var(--color-ink-subtle)] text-right">
                  Upstream
                </span>
                <span className="text-caption text-[var(--color-ink-subtle)] text-right">
                  Empirical 90d
                </span>
              </div>
              {odds.map((entry) => {
                const upstreamPct = (entry.probability * 100).toFixed(3)
                const empirical90d = entry.empirical_90d as number | undefined
                const empiricalVal = empirical90d ?? entry.probability
                const empiricalPct = (empiricalVal * 100).toFixed(3)
                const hasDivergence = Math.abs(entry.probability - empiricalVal) > 0.01

                return (
                  <div
                    key={entry.rarity}
                    className={cnm(
                      'grid grid-cols-3 gap-4 py-3 border-b border-[var(--color-border)]',
                      hasDivergence &&
                        'bg-[var(--color-warn-soft)] -mx-2 px-2 rounded-[var(--radius-xs)]',
                    )}
                  >
                    <span className="text-body-s text-[var(--color-ink)] font-medium">
                      {entry.rarity}
                    </span>
                    <span className="text-num text-[var(--color-ink)] text-right tabular-nums">
                      {upstreamPct}%
                    </span>
                    <span
                      className={cnm(
                        'text-num text-right tabular-nums',
                        hasDivergence
                          ? 'text-[var(--color-warn)] font-medium'
                          : 'text-[var(--color-ink)]',
                      )}
                    >
                      {empiricalPct}%
                      {hasDivergence && (
                        <span className="ml-1 text-[10px]" aria-label="divergence detected">
                          ⚠
                        </span>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          <p className="text-caption text-[var(--color-ink-subtle)] mt-4">
            Upstream = pack publisher stated odds. Empirical 90d = observed pulls over last 90
            days. Beta data.
          </p>
        </div>
      </motion.div>
    </>
  )
}

// ─── Pack card ────────────────────────────────────────────────────────────────

function PackCard({
  pack,
  onViewOdds,
}: {
  pack: Pack
  onViewOdds: (packId: string, packName: string) => void
}) {
  const safeUrl = sanitizeImageUrl(pack.coverUrl)
  const priceIsWei = pack.price > 1e15 // heuristic: if > 10^15, likely wei-denominated
  const priceDisplay = priceIsWei
    ? formatWei(pack.price)
    : formatUiNumber(pack.price, '', { defaultDecimals: 2 })

  const recentOpens = pack.recentOpenedPacks ?? []
  const packType = pack.packType
  const stage = pack.stage
  const expectedValue = pack.expectedValue
  const buyUrl = pack.buyUrl

  return (
    <article className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] overflow-hidden transition-[border-color,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-[var(--color-border-strong)] reveal-on-scroll">
      {/* Cover art */}
      {safeUrl ? (
        <img
          src={safeUrl}
          alt={pack.name}
          className="w-full aspect-[16/9] object-cover border-b border-[var(--color-border)]"
          loading="lazy"
        />
      ) : (
        <div
          className="w-full aspect-[16/9] bg-[var(--color-bg-alt)] border-b border-[var(--color-border)] flex items-center justify-center"
          aria-hidden="true"
        >
          <Package size={32} className="text-[var(--color-ink-subtle)]" />
        </div>
      )}

      <div className="p-5">
        {/* Pack type chips */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          {packType && (
            <span className="text-caption bg-[var(--color-accent-soft)] text-[var(--color-accent)] px-2.5 py-0.5 rounded-[var(--radius-pill)]">
              {packType}
            </span>
          )}
          {stage && (
            <span className="text-caption bg-[var(--color-bg-alt)] text-[var(--color-ink-muted)] px-2.5 py-0.5 rounded-[var(--radius-pill)]">
              {stage}
            </span>
          )}
          {!pack.isActive && (
            <span className="text-caption bg-[rgba(214,69,69,0.1)] text-[var(--color-danger)] px-2.5 py-0.5 rounded-[var(--radius-pill)]">
              Archived
            </span>
          )}
        </div>

        <h3 className="text-h3 text-[var(--color-ink)] mb-3">{pack.name}</h3>

        {/* Metrics row */}
        <div className="flex items-center gap-6 mb-4 flex-wrap">
          <div>
            <p className="text-caption text-[var(--color-ink-subtle)] mb-0.5">Price</p>
            <p className="text-num font-semibold text-[var(--color-ink)]">
              ${priceDisplay} USDT
            </p>
          </div>
          {expectedValue !== undefined && (
            <div>
              <p className="text-caption text-[var(--color-ink-subtle)] mb-0.5">Expected value</p>
              <p className="text-num font-semibold text-[var(--color-success)]">
                ${formatUiNumber(expectedValue ?? 0, '', { defaultDecimals: 2 })}
              </p>
            </div>
          )}
          {pack.remainingSupply !== null && (
            <div>
              <p className="text-caption text-[var(--color-ink-subtle)] mb-0.5">Remaining</p>
              <p className="text-num text-[var(--color-ink)]">
                {formatUiNumber(pack.remainingSupply, '', { defaultDecimals: 0 })}
              </p>
            </div>
          )}
        </div>

        {/* Recent activity */}
        {recentOpens.length > 0 && (
          <div className="mb-4">
            <p className="text-caption text-[var(--color-ink-subtle)] mb-2">Recent activity</p>
            <div className="flex flex-col gap-1.5">
              {recentOpens.slice(0, 3).map((open, i) => (
                <div
                  key={i}
                  className="text-body-s text-[var(--color-ink-muted)] bg-[var(--color-bg-alt)] px-3 py-1.5 rounded-[var(--radius-sm)]"
                >
                  {typeof open === 'object' && open !== null && 'cardName' in open
                    ? String((open as { cardName: string }).cardName)
                    : JSON.stringify(open)}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => onViewOdds(pack.id, pack.name)}
            className="h-10 px-5 rounded-[var(--radius-md)] bg-[var(--color-accent)] text-[var(--color-accent-ink)] text-sm font-semibold hover:opacity-90 transition-all duration-200 active:translate-y-px"
          >
            View odds
          </button>
          {buyUrl && (
            <a
              href={buyUrl}
              rel="noopener noreferrer"
              target="_blank"
              className="h-10 px-5 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-ink)] text-sm font-medium hover:bg-[var(--color-bg-alt)] transition-all duration-200 inline-flex items-center gap-1.5"
            >
              Buy on Renaiss
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          )}
        </div>
      </div>
    </article>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

function PacksPage() {
  const reduced = useReducedMotion()
  const [includeInactive, setIncludeInactive] = useState(false)
  const [oddsTarget, setOddsTarget] = useState<{ id: string; name: string } | null>(null)

  const { data: packsRes, isLoading, isError } = useQuery({
    queryKey: ['packs', includeInactive],
    queryFn: () => getPacks(includeInactive),
    staleTime: 60_000,
  })

  const packs: Array<Pack> = packsRes?.data ?? []
  const warnings = packsRes?.warnings ?? []

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
            { opacity: 1, y: 0, ease: 'power2.out', duration: 0.6, stagger: 0.08 },
          )
        },
        once: true,
      })
    })

    return () => ctx.revert()
  }, [reduced, packs])

  // Lock body scroll when odds modal is open
  useEffect(() => {
    document.body.style.overflow = oddsTarget ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [oddsTarget])

  return (
    <main id="main" className="min-h-screen bg-[var(--color-bg)] pt-28 pb-24">
      <div className="max-w-[1200px] mx-auto px-5 sm:px-8">
        {/* Hero */}
        <section className="mb-10">
          <h1 className="text-h1 text-[var(--color-ink)] mb-4">Live packs</h1>
          <p className="text-body-l text-[var(--color-ink-muted)]">
            Open packs. Track pulls. Watch the odds. Every Renaiss pack, live.
          </p>
        </section>

        <WarningBanner warnings={warnings} />

        {/* Toggle */}
        <div className="flex items-center gap-3 mb-8">
          <button
            type="button"
            role="switch"
            aria-checked={includeInactive}
            onClick={() => setIncludeInactive((v) => !v)}
            className={cnm(
              'text-body-s font-medium px-4 py-2 rounded-[var(--radius-pill)] transition-colors duration-200',
              includeInactive
                ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                : 'bg-[var(--color-bg-alt)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
            )}
          >
            Show archived packs
          </button>
        </div>

        {/* Loading */}
        {isLoading && (
          <div
            className="grid grid-cols-1 sm:grid-cols-2 gap-5"
            aria-busy="true"
            aria-live="polite"
          >
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="skeleton skeleton-animate h-80 rounded-[var(--radius-lg)]"
                aria-hidden="true"
              />
            ))}
          </div>
        )}

        {/* Error */}
        {isError && (
          <div
            role="alert"
            className="flex items-start gap-3 bg-[var(--color-bg-alt)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-6"
          >
            <AlertCircle
              size={18}
              className="text-[var(--color-danger)] flex-shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <p className="text-body text-[var(--color-ink-muted)]">
              Could not load packs. Check back soon.
            </p>
          </div>
        )}

        {/* Empty */}
        {!isLoading && !isError && packs.length === 0 && (
          <div className="text-center py-20">
            <Package size={40} className="mx-auto mb-4 text-[var(--color-ink-subtle)]" aria-hidden="true" />
            <p className="text-body text-[var(--color-ink-muted)]">
              {includeInactive ? 'No packs found.' : 'No active packs right now.'}
            </p>
            {!includeInactive && (
              <button
                type="button"
                onClick={() => setIncludeInactive(true)}
                className="mt-3 text-body-s text-[var(--color-accent)] hover:underline"
              >
                Show archived packs
              </button>
            )}
          </div>
        )}

        {/* Pack grid */}
        {!isLoading && !isError && packs.length > 0 && (
          <section aria-labelledby="packs-grid-heading">
            <h2 id="packs-grid-heading" className="sr-only">
              {includeInactive ? 'All packs' : 'Active packs'}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              {packs.map((pack) => (
                <PackCard
                  key={pack.id}
                  pack={pack}
                  onViewOdds={(id, name) => setOddsTarget({ id, name })}
                />
              ))}
            </div>
          </section>
        )}

        {/* Source footer */}
        <footer className="mt-16 pt-6 border-t border-[var(--color-border)]">
          <p className="text-caption text-[var(--color-ink-subtle)]">
            Data: Renaiss main API (beta) · Renaiss OS Index (beta). Not financial advice.
          </p>
        </footer>
      </div>

      {/* Odds modal */}
      <AnimatePresence>
        {oddsTarget && (
          <OddsModal
            packId={oddsTarget.id}
            packName={oddsTarget.name}
            onClose={() => setOddsTarget(null)}
            reduced={reduced}
          />
        )}
      </AnimatePresence>
    </main>
  )
}
