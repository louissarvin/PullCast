/**
 * Route: /card/$tx
 * Single pull share card detail page.
 *
 * The `$tx` param is the pullId (internal ID). The "tx" label is for shareability.
 *
 * Layout (desktop): 60/40 split — ShareCard on left, metadata panel on right.
 * SSR: loader fetches pull data for OG meta tag injection.
 *
 * OG meta tags are critical for X / Discord / Telegram link previews.
 * DESIGN.md §5 `/card/$tx` route spec.
 */

import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { AlertTriangle, ChevronRight, Copy, ExternalLink, Share2, X } from 'lucide-react'
import type { ApiSource, ApiWarning, Pull } from '@/lib/api/client'
import PillNavbar from '@/components/nav/PillNavbar'
import Footer from '@/components/layout/Footer'
import { ShareCard } from '@/components/share-card/ShareCard'
import { GradeBadge } from '@/components/ui/GradeBadge'
import { Chip } from '@/components/ui/Chip'
import { Skeleton } from '@/components/ui/Skeleton'
import { getPullById, getPullsForAddress, submitReport } from '@/lib/api/client'
import { env } from '@/env'
import { useReducedMotion } from '@/lib/motion/reduced-motion'
import { cnm } from '@/utils/style'

// ─── Route definition ─────────────────────────────────────────────────────────

export const Route = createFileRoute('/card/$tx')({
  loader: async ({ params }) => {
    try {
      const result = await getPullById(params.tx)
      return {
        pull: result.data,
        sources: result.sources,
        warnings: result.warnings,
      }
    } catch {
      return {
        pull: null as Pull | null,
        sources: [] as Array<ApiSource>,
        warnings: [] as Array<ApiWarning>,
      }
    }
  },
  head: ({ loaderData }) => {
    const { pull } = loaderData ?? {}

    if (!pull) {
      return {
        meta: [
          { title: 'Pull not found · PullCast' },
          { name: 'robots', content: 'noindex' },
        ],
      }
    }

    const short = pull.address
      ? `${pull.address.slice(0, 6)}…${pull.address.slice(-4)}`
      : 'Unknown'

    const title = `${pull.cardName} · $${pull.fmv?.toFixed(2) ?? '?'} · PullCast`
    const description = `Pulled by ${short} · ${pull.grader} ${pull.grade} · Renaiss OS Index FMV`
    const ogImage = `${env.VITE_API_URL}/og/${pull.id}`

    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { property: 'og:title', content: title },
        { property: 'og:description', content: description },
        { property: 'og:image', content: ogImage },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '630' },
        { property: 'og:type', content: 'article' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: title },
        { name: 'twitter:description', content: description },
        { name: 'twitter:image', content: ogImage },
      ],
    }
  },
  component: CardDetailPage,
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortAddress(addr: string) {
  if (addr.length < 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function relativeTime(isoStr: string) {
  try {
    const ms = Date.now() - new Date(isoStr).getTime()
    const mins = Math.floor(ms / 60_000)
    if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''} ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`
    const days = Math.floor(hrs / 24)
    return `${days} day${days !== 1 ? 's' : ''} ago`
  } catch {
    return ''
  }
}

function buildTwitterIntent(pull: Pull, appUrl: string) {
  const text = `Just pulled ${pull.cardName} valued at $${pull.fmv?.toFixed(2) ?? '?'} via PullCast`
  const url = `${appUrl}/card/${pull.id}`
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
}

// ─── Report modal ─────────────────────────────────────────────────────────────

interface ReportModalProps {
  pullId: string
  onClose: () => void
}

function ReportModal({ pullId, onClose }: ReportModalProps) {
  const reduced = useReducedMotion()
  const [issue, setIssue] = useState('')
  const [contact, setContact] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!issue.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await submitReport({
        pullId,
        reason: issue.trim(),
        details: contact.trim() || undefined,
      })
      setSubmitted(true)
    } catch {
      setError('Failed to submit report. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const modalVariants = reduced
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, scale: 0.96, y: 8 },
        animate: { opacity: 1, scale: 1, y: 0 },
        exit: { opacity: 0, scale: 0.96, y: 8 },
      }

  const modalTransition = reduced
    ? { duration: 0.1 }
    : { type: 'spring' as const, stiffness: 260, damping: 26 }

  return (
    <AnimatePresence>
      {/* Scrim */}
      <motion.div
        key="scrim"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-50 bg-[rgba(23,20,18,0.45)]"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Modal */}
      <motion.div
        key="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-modal-title"
        {...modalVariants}
        transition={modalTransition}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
      >
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-xl)] max-w-[520px] w-full p-8 pointer-events-auto">
          <div className="flex items-center justify-between mb-6">
            <h2 id="report-modal-title" className="text-h3 text-[var(--color-ink)]">
              Report data issue
            </h2>
            <button
              type="button"
              aria-label="Close report modal"
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-[var(--radius-pill)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:bg-[var(--color-bg-alt)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          {submitted ? (
            <div className="text-center py-6">
              <p className="text-[var(--color-success)] font-medium mb-2">Report submitted.</p>
              <p className="text-[var(--color-ink-muted)] text-sm">
                We'll review the data and fix it within 24 hours.
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-6 inline-flex items-center h-9 px-4 text-sm font-medium rounded-[var(--radius-md)] bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:opacity-90 transition-opacity duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
              >
                Done
              </button>
            </div>
          ) : (
            <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
              <div>
                <label htmlFor="report-issue" className="block text-sm font-medium text-[var(--color-ink)] mb-1.5">
                  What's wrong?
                </label>
                <textarea
                  id="report-issue"
                  required
                  rows={3}
                  maxLength={500}
                  value={issue}
                  onChange={(e) => setIssue(e.target.value)}
                  placeholder="e.g. FMV is incorrect, wrong card image, grader mismatch…"
                  className="w-full bg-[var(--color-bg-alt)] border border-transparent rounded-[var(--radius-md)] px-4 py-3 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-2 focus:outline-[var(--color-accent)] focus:outline-offset-[3px] focus:outline transition-all duration-[180ms] resize-none"
                />
              </div>
              <div>
                <label htmlFor="report-contact" className="block text-sm font-medium text-[var(--color-ink)] mb-1.5">
                  Contact (optional)
                </label>
                <input
                  id="report-contact"
                  type="text"
                  maxLength={200}
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder="Discord tag or email"
                  className="w-full bg-[var(--color-bg-alt)] border border-transparent rounded-[var(--radius-md)] px-4 py-3 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-2 focus:outline-[var(--color-accent)] focus:outline-offset-[3px] focus:outline transition-all duration-[180ms]"
                />
              </div>
              {error && (
                <p className="text-[var(--color-danger)] text-sm">{error}</p>
              )}
              <div className="flex items-center justify-end gap-3 mt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex items-center h-9 px-4 text-sm font-medium rounded-[var(--radius-md)] bg-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting || !issue.trim()}
                  className="inline-flex items-center h-9 px-5 text-sm font-semibold rounded-[var(--radius-md)] bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-[180ms] active:translate-y-px focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
                >
                  {submitting ? 'Submitting…' : 'Submit report'}
                </button>
              </div>
            </form>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}

// ─── Sources row ──────────────────────────────────────────────────────────────

function SourcesRow({ sources }: { sources: Array<ApiSource> }) {
  if (!sources.length) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      {sources.map((s) => (
        <a
          key={s.label + s.url}
          href={s.url}
          rel="noopener noreferrer"
          target="_blank"
          className="inline-flex items-center gap-1 h-6 px-2.5 rounded-[var(--radius-xs)] bg-[var(--color-bg-alt)] text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
        >
          {s.label}
          <ExternalLink size={10} aria-hidden="true" />
        </a>
      ))}
    </div>
  )
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function CardDetailSkeleton() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-10 lg:gap-16 pt-28 pb-16 px-5 sm:px-8 max-w-[1200px] mx-auto">
      {/* Left */}
      <Skeleton radius="lg" height="h-[560px]" />
      {/* Right */}
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton radius="pill" width="w-20" height="h-5" />
        <Skeleton radius="md" width="w-3/4" height="h-10" />
        <Skeleton radius="md" width="w-1/2" height="h-6" />
        <Skeleton radius="md" height="h-24" />
        <Skeleton radius="md" width="w-1/3" height="h-5" />
        <div className="flex gap-3 mt-4">
          <Skeleton radius="md" width="w-36" height="h-10" />
          <Skeleton radius="md" width="w-32" height="h-10" />
        </div>
      </div>
    </div>
  )
}

// ─── 404 / not found state ────────────────────────────────────────────────────

function NotFoundState() {
  return (
    <div className="flex flex-col items-center justify-center py-32 px-5 text-center">
      <p className="text-[var(--color-ink-subtle)] text-display-l mb-4" aria-hidden="true">404</p>
      <h1 className="text-h2 text-[var(--color-ink)] mb-3">Pull not found</h1>
      <p className="text-body text-[var(--color-ink-muted)] max-w-[320px] mb-8">
        This pull ID doesn't exist or the data hasn't been indexed yet.
      </p>
      <Link
        to="/"
        className="inline-flex items-center gap-2 h-10 px-5 text-sm font-medium rounded-[var(--radius-md)] bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:opacity-90 transition-opacity duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
      >
        Browse the gallery
      </Link>
    </div>
  )
}

// ─── Also by this wallet carousel ─────────────────────────────────────────────

function AlsoByWallet({ address, currentPullId }: { address: string; currentPullId: string }) {
  const { data } = useQuery({
    queryKey: ['wallet', 'pulls', address, 'preview'],
    queryFn: () => getPullsForAddress(address),
    staleTime: 60_000,
  })

  const pulls = (data?.data ?? [])
    .filter((p: Pull) => p.id !== currentPullId)
    .slice(0, 6)
  if (!pulls.length) return null

  return (
    <section className="bg-[var(--color-bg-alt)] py-16 px-5 sm:px-8">
      <div className="max-w-[1200px] mx-auto">
        <div className="flex items-center justify-between gap-4 mb-8">
          <h2 className="text-h3 text-[var(--color-ink)]">Also by this wallet</h2>
          <Link
            to="/$address"
            params={{ address }}
            className="inline-flex items-center gap-1 text-sm font-medium text-[var(--color-accent)] hover:opacity-80 transition-opacity duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline rounded-[var(--radius-xs)]"
          >
            See all pulls by {shortAddress(address)}
            <ChevronRight size={14} aria-hidden="true" />
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {pulls.map((pull) => (
            <ShareCard key={pull.id} pull={pull} />
          ))}
        </div>
      </div>
    </section>
  )
}

// ─── Main detail panel ────────────────────────────────────────────────────────

function PullDetailPanel({
  pull,
  sources,
  onReport,
}: {
  pull: Pull
  sources: Array<ApiSource>
  onReport: () => void
}) {
  const appUrl = env.VITE_APP_URL
  const twitterUrl = buildTwitterIntent(pull, appUrl)

  const netGain = pull.fmv != null && pull.packCost != null ? pull.fmv - pull.packCost : null
  const netPositive = netGain != null && netGain >= 0
  const netLabel = netGain != null ? `${netPositive ? '+' : ''}$${Math.abs(netGain).toFixed(2)}` : null

  return (
    <div className="flex flex-col gap-6">
      {/* Grade badge */}
      <GradeBadge grader={pull.grader} grade={pull.grade} />

      {/* Card name + set */}
      <div>
        <h1 className="text-h1 text-[var(--color-ink)] mb-1">{pull.cardName}</h1>
        <p className="text-body-l text-[var(--color-ink-muted)]">{pull.setName}</p>
      </div>

      {/* FMV panel */}
      <div className="bg-[var(--color-bg-alt)] rounded-[var(--radius-lg)] p-5 flex flex-col gap-4">
        <p className="text-caption text-[var(--color-ink-muted)]">Fair Market Value</p>
        <div className="text-display-l text-[var(--color-ink)] tabular-nums leading-none">
          {pull.fmv != null ? `$${pull.fmv.toFixed(2)}` : 'N/A'}
        </div>

        <SourcesRow sources={sources} />

        <p className="text-xs text-[var(--color-ink-subtle)]">
          Source: Renaiss OS Index (beta) · FMV is informational, not financial advice.
        </p>
      </div>

      {/* Pack + net */}
      <div className="flex items-center gap-6">
        {pull.packCost != null && (
          <div>
            <p className="text-caption text-[var(--color-ink-muted)] mb-0.5">Pack pulled</p>
            <p className="text-body font-medium text-[var(--color-ink)] tabular-nums">
              ${pull.packCost.toFixed(2)}
            </p>
          </div>
        )}
        {netLabel && (
          <div>
            <p className="text-caption text-[var(--color-ink-muted)] mb-0.5">Net gain / loss</p>
            <p
              className={cnm(
                'text-body font-semibold tabular-nums',
                netPositive ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'
              )}
            >
              {netLabel}
            </p>
          </div>
        )}
      </div>

      {/* Puller + timestamp */}
      <div className="flex flex-wrap items-center gap-3">
        <Chip variant="default">
          <span
            className="text-mono"
            aria-label={`Pulled by ${pull.address}`}
            title={pull.address}
          >
            {shortAddress(pull.address)}
          </span>
        </Chip>
        {pull.pulledAt && (
          <span className="text-body-s text-[var(--color-ink-muted)]">
            Pulled {relativeTime(pull.pulledAt)}
          </span>
        )}
      </div>

      {/* CTAs */}
      <div className="flex flex-wrap items-center gap-3">
        <a
          href={twitterUrl}
          rel="noopener noreferrer"
          target="_blank"
          className="inline-flex items-center gap-2 h-10 px-5 text-[14px] font-semibold rounded-[var(--radius-md)] bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:opacity-90 transition-opacity duration-200 active:translate-y-px focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
        >
          <Share2 size={15} aria-hidden="true" />
          Share to X
        </a>

        {pull.txHash && (
          <a
            href={`https://bscscan.com/tx/${pull.txHash}`}
            rel="noopener noreferrer"
            target="_blank"
            className="inline-flex items-center gap-2 h-10 px-5 text-[14px] font-medium rounded-[var(--radius-md)] bg-[var(--color-surface)] text-[var(--color-ink)] border border-[var(--color-border-strong)] hover:bg-[var(--color-bg-alt)] transition-colors duration-200 active:translate-y-px focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
          >
            View on BscScan
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        )}

        <a
          href={`https://renaiss.xyz/collectibles/${pull.txHash}`}
          rel="noopener noreferrer"
          target="_blank"
          className="inline-flex items-center gap-2 h-10 px-5 text-[14px] font-medium rounded-[var(--radius-md)] bg-[var(--color-surface)] text-[var(--color-ink)] border border-[var(--color-border-strong)] hover:bg-[var(--color-bg-alt)] transition-colors duration-200 active:translate-y-px focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
        >
          View on Renaiss
          <ExternalLink size={13} aria-hidden="true" />
        </a>

        <button
          type="button"
          aria-label="Copy link to this pull"
          onClick={() => void navigator.clipboard.writeText(`${appUrl}/card/${pull.id}`)}
          className="inline-flex items-center gap-2 h-10 px-4 text-[14px] font-medium rounded-[var(--radius-md)] bg-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:bg-[var(--color-accent-soft)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
        >
          <Copy size={14} aria-hidden="true" />
          Copy link
        </button>
      </div>

      {/* Report data issue */}
      <div className="pt-4 border-t border-[var(--color-border)]">
        <button
          type="button"
          onClick={onReport}
          className="inline-flex items-center gap-1.5 text-xs text-[var(--color-ink-subtle)] hover:text-[var(--color-warn)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline rounded-[var(--radius-xs)]"
        >
          <AlertTriangle size={12} aria-hidden="true" />
          Report data issue
        </button>
      </div>
    </div>
  )
}

// ─── Provenance panel ─────────────────────────────────────────────────────────

function ProvenancePanel({ pull, sources }: { pull: Pull; sources: Array<ApiSource> }) {
  return (
    <section className="bg-[var(--color-bg-alt)] py-16 px-5 sm:px-8">
      <div className="max-w-[1200px] mx-auto">
        <h2 className="text-h3 text-[var(--color-ink)] mb-6">Provenance</h2>

        <div className="flex flex-wrap gap-3 mb-6">
          {pull.txHash && (
            <a
              href={`https://bscscan.com/tx/${pull.txHash}`}
              rel="noopener noreferrer"
              target="_blank"
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded-[var(--radius-xs)] bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-xs font-mono text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
            >
              TX: {shortAddress(pull.txHash)}
              <ExternalLink size={10} aria-hidden="true" />
            </a>
          )}
          {pull.id && (
            <span className="inline-flex items-center h-7 px-3 rounded-[var(--radius-xs)] bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-xs font-mono text-[var(--color-ink-muted)]">
              Pull ID: {pull.id}
            </span>
          )}
        </div>

        {/* Sources */}
        {sources.length > 0 && (
          <div>
            <p className="text-caption text-[var(--color-ink-muted)] mb-3">Data sources</p>
            <SourcesRow sources={sources} />
          </div>
        )}

        {/* Beta warning */}
        <div className="mt-6 inline-flex items-start gap-1.5 bg-[var(--color-warn-soft)] text-[var(--color-warn)] text-xs font-medium px-3 py-2 rounded-[var(--radius-sm)] leading-relaxed" data-testid="beta-notice-banner">
          <span aria-hidden="true" className="flex-shrink-0 mt-0.5">⚠</span>
          <span>
            PullCast is beta software. FMV data is informational only — not financial advice. Every number cites its source.
          </span>
        </div>
      </div>
    </section>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function CardDetailPage() {
  const { tx: pullId } = Route.useParams()
  const loaderData = Route.useLoaderData()
  const reduced = useReducedMotion()
  const [reportOpen, setReportOpen] = useState(false)

  // Client-side query that reuses whatever the SSR loader already put in cache
  const { data: queryResult, isLoading, isError } = useQuery({
    queryKey: ['pull', pullId],
    queryFn: () => getPullById(pullId),
    staleTime: 60_000,
    // Hydrate initial data from the SSR loader so there's no client waterfall
    initialData: loaderData.pull
      ? {
          data: loaderData.pull,
          sources: loaderData.sources,
          warnings: loaderData.warnings,
          generatedAt: new Date().toISOString(),
        }
      : undefined,
  })

  const pull = queryResult?.data
  const sources = queryResult?.sources ?? []

  if (isLoading && !pull) {
    return (
      <>
        <PillNavbar />
        <main id="main">
          <CardDetailSkeleton />
        </main>
        <Footer />
      </>
    )
  }

  if ((isError && !pull) || (!isLoading && !pull)) {
    return (
      <>
        <PillNavbar />
        <main id="main" className="min-h-screen bg-[var(--color-bg)]">
          <NotFoundState />
        </main>
        <Footer />
      </>
    )
  }

  return (
    <>
      <PillNavbar />
      <main id="main" className="bg-[var(--color-bg)]">
        {/* Hero split */}
        <section className="pt-28 pb-16 px-5 sm:px-8">
          <div className="max-w-[1200px] mx-auto">
            <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-10 lg:gap-16 items-start">
              {/* Left — ShareCard at full size */}
              <div className="flex justify-center lg:justify-start">
                {pull && <ShareCard pull={pull} size="large" linkable={false} />}
              </div>

              {/* Right — metadata panel */}
              <motion.div
                layout
                transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 220, damping: 28 }}
              >
                {pull && (
                  <PullDetailPanel
                    pull={pull}
                    sources={sources}
                    onReport={() => setReportOpen(true)}
                  />
                )}
              </motion.div>
            </div>
          </div>
        </section>

        {/* Provenance panel */}
        {pull && <ProvenancePanel pull={pull} sources={sources} />}

        {/* Also by this wallet */}
        {pull?.address && (
          <AlsoByWallet address={pull.address} currentPullId={pull.id} />
        )}
      </main>

      <Footer />

      {/* Report modal — rendered via AnimatePresence inside ReportModal */}
      {reportOpen && (
        <ReportModal pullId={pullId} onClose={() => setReportOpen(false)} />
      )}
    </>
  )
}
