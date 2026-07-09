import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useCallback, useRef, useState } from 'react'
import {
  AlertCircle,
  ChevronRight,
  ExternalLink,
  Search,
  Upload,
  X,
} from 'lucide-react'
import type {ApiResult, ApiSource, ApiWarning, PriceResult} from '@/lib/api/client';
import { cnm } from '@/utils/style'
import { env } from '@/env'
import { formatUiNumber } from '@/utils/format'
import {
  
  
  
  
  getPriceForCert,
  getPriceForToken,
  searchPrice,
  submitReport
} from '@/lib/api/client'

export const Route = createFileRoute('/price')({
  component: PricePage,
})

// ─── Auto-detect query type ───────────────────────────────────────────────────

type QueryKind = 'token' | 'cert' | 'search'

const CERT_RE = /^(PSA|BGS|CGC|SGC)\d+$/i

function detectQueryKind(q: string): QueryKind {
  const trimmed = q.trim()
  if (/^\d+$/.test(trimmed) && trimmed.length >= 20) return 'token'
  if (CERT_RE.test(trimmed.replace(/\s+/g, ''))) return 'cert'
  return 'search'
}

function runPriceQuery(
  q: string,
): Promise<ApiResult<PriceResult | Array<PriceResult>>> {
  const trimmed = q.trim()
  const kind = detectQueryKind(trimmed)
  if (kind === 'token') return getPriceForToken(trimmed)
  if (kind === 'cert')
    return getPriceForCert(trimmed.replace(/\s+/g, '').toUpperCase())
  return searchPrice(trimmed)
}

// ─── SSE stage types ──────────────────────────────────────────────────────────

const SSE_STAGES = [
  { id: 'cert_lookup', label: 'Cert lookup' },
  { id: 'identify', label: 'Identifying card' },
  { id: 'enrich', label: 'Enriching metadata' },
  { id: 'find_item', label: 'Finding listings' },
  { id: 'cache_check', label: 'Cache check' },
  { id: 'match', label: 'Matching records' },
  { id: 'crawl', label: 'Crawling sources' },
  { id: 'fmv', label: 'Calculating FMV' },
  { id: 'done', label: 'Done' },
] as const

type StageId = (typeof SSE_STAGES)[number]['id']

// ─── Example queries ──────────────────────────────────────────────────────────

const EXAMPLES = [
  { label: 'Charizard Base Set', query: 'Charizard Base Set PSA 10' },
  { label: 'PSA cert', query: 'PSA12345678' },
  { label: 'One Piece Luffy', query: 'Monkey D. Luffy OP01-120' },
]

// ─── Sub-components ───────────────────────────────────────────────────────────

function ConfidenceDot({
  level,
}: {
  level: 'high' | 'medium' | 'low' | undefined
}) {
  const colors: Record<string, string> = {
    high: 'bg-[var(--color-success)]',
    medium: 'bg-[var(--color-warn)]',
    low: 'bg-[var(--color-ink-subtle)]',
  }
  return (
    <span
      className={cnm(
        'inline-block w-2 h-2 rounded-full flex-shrink-0',
        colors[level ?? 'low'],
      )}
      aria-label={`Confidence: ${level ?? 'low'}`}
    />
  )
}

function GradeBadge({
  grader,
  grade,
}: {
  grader: string
  grade: number | null
}) {
  const g = grader.toUpperCase()
  const label = grade !== null ? `${g} ${grade}` : g || 'Raw'

  const classes: Record<string, string> = {
    PSA: 'bg-[#D91E24] text-white',
    BGS: 'text-[#C0A15B] border border-[#C0A15B]',
    CGC: 'bg-[#1D6BB4] text-white',
    SGC: 'bg-[#F2C94C] text-[#171412]',
  }

  const bgsStyle =
    g === 'BGS'
      ? { background: 'linear-gradient(180deg,#000 0%,#1A1A1A 100%)' }
      : {}

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

function FmvSource({
  label,
  value,
  confidence,
}: {
  label: string
  value: number | null
  confidence?: 'high' | 'medium' | 'low'
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="text-caption text-[var(--color-ink-subtle)]">
          {label}
        </span>
        {confidence && <ConfidenceDot level={confidence} />}
      </div>
      <span className="text-num font-semibold text-[var(--color-ink)]">
        {value !== null
          ? `$${formatUiNumber(value, '', { defaultDecimals: 2 })}`
          : '—'}
      </span>
    </div>
  )
}

function SourceChips({ sources }: { sources: Array<ApiSource> }) {
  if (!sources.length) return null
  return (
    <div className="flex flex-wrap gap-1.5 mt-3">
      {sources.map((s) => (
        <a
          key={s.label}
          href={s.url}
          rel="noopener noreferrer"
          target="_blank"
          className="inline-flex items-center gap-1 text-caption text-[var(--color-ink-muted)] bg-[var(--color-bg-alt)] hover:text-[var(--color-accent)] px-2.5 py-1 rounded-[var(--radius-pill)] transition-colors duration-200"
        >
          {s.label}
          <ExternalLink size={10} aria-hidden="true" />
        </a>
      ))}
    </div>
  )
}

function WarningBanner({ warnings }: { warnings: Array<ApiWarning> }) {
  if (!warnings.length) return null
  return (
    <div className="flex flex-col gap-2 mb-4">
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

function ResultCard({
  result,
  sources,
  onReport,
}: {
  result: PriceResult
  sources: Array<ApiSource>
  onReport: () => void
}) {
  return (
    <article className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-6 transition-[border-color,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-[var(--color-border-strong)]">
      <div className="flex items-start gap-4">
        {/* Thumbnail */}
        {result.imageUrl ? (
          <img
            src={result.imageUrl}
            alt={result.cardName}
            width={80}
            height={112}
            className="rounded-[var(--radius-sm)] object-cover flex-shrink-0 border border-[var(--color-border)]"
            loading="lazy"
          />
        ) : (
          <div
            className="w-20 h-28 rounded-[var(--radius-sm)] bg-[var(--color-bg-alt)] border border-[var(--color-border)] flex-shrink-0"
            aria-hidden="true"
          />
        )}

        {/* Details */}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <GradeBadge grader={result.grader} grade={result.grade} />
          </div>
          <h3 className="text-h3 text-[var(--color-ink)] truncate">
            {result.cardName}
          </h3>
          <p className="text-body-s text-[var(--color-ink-muted)] mb-4">
            {result.setName}
          </p>

          {/* FMV grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3">
            <FmvSource label="Renaiss floor" value={result.renaiissFloor} />
            <FmvSource
              label="Last sale"
              value={result.lastSale}
              confidence="high"
            />
            <FmvSource
              label="On-chain"
              value={result.lastSale}
              confidence="medium"
            />
            <FmvSource label="PriceCharting" value={result.priceCharting} />
            <FmvSource label="SNKRDUNK" value={result.snkrdunk} />
            <FmvSource label="Grading premium" value={result.gradingPremium} />
          </div>

          <SourceChips sources={sources} />

          <div className="flex items-center gap-3 mt-4">
            <button
              type="button"
              onClick={onReport}
              className="text-body-s text-[var(--color-ink-muted)] hover:text-[var(--color-danger)] transition-colors duration-200 underline underline-offset-2"
            >
              Report data issue
            </button>
          </div>
        </div>
      </div>
    </article>
  )
}

// ─── Photo upload with SSE ────────────────────────────────────────────────────

function PhotoUpload({ reduced }: { reduced: boolean | null }) {
  const [stage, setStage] = useState<StageId | null>(null)
  const [result, setResult] = useState<PriceResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const currentStageIndex = stage
    ? SSE_STAGES.findIndex((s) => s.id === stage)
    : -1
  const progress = stage
    ? ((currentStageIndex + 1) / SSE_STAGES.length) * 100
    : 0

  const handleFile = useCallback(async (file: File) => {
    setResult(null)
    setError(null)
    setStage('cert_lookup')

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const form = new FormData()
      form.append('photo', file)

      // SSE via fetch streaming — backend sends event: stage\ndata: {stage}\n\n
      const res = await fetch(
        `${env.VITE_API_URL.replace(/\/$/, '')}/api/valuate/photo`,
        {
          method: 'POST',
          body: form,
          signal: controller.signal,
        },
      )

      if (!res.ok) throw new Error('Upload failed')
      if (!res.body) throw new Error('No response stream')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('data:')) {
            try {
              const payload = JSON.parse(line.slice(5).trim())
              if (payload.stage) setStage(payload.stage as StageId)
              if (payload.result) {
                setResult(payload.result as PriceResult)
                setStage('done')
              }
            } catch {
              // partial JSON — ignore
            }
          }
        }
      }
    } catch (err) {
      const e = err as Error
      if (e.name !== 'AbortError') {
        setError(e.message || 'Upload failed.')
      }
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const file = e.dataTransfer.files.item(0)
      if (file) handleFile(file)
    },
    [handleFile],
  )

  return (
    <section className="mt-12 pt-10 border-t border-[var(--color-border)]">
      <p className="text-body-s text-[var(--color-ink-muted)] mb-4 flex items-center gap-2">
        <Upload size={14} aria-hidden="true" />
        Or drop a slab photo to auto-identify and price
      </p>

      <div
        role="region"
        aria-label="Photo upload"
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={cnm(
          'border-2 border-dashed rounded-[var(--radius-lg)] p-8 text-center transition-colors duration-200 cursor-pointer',
          isDragging
            ? 'border-[var(--color-accent)] bg-[var(--color-accent-soft)]'
            : 'border-[var(--color-border-strong)] hover:border-[var(--color-accent)]',
        )}
        onClick={() => fileRef.current?.click()}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label="Upload slab photo"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file)
            e.target.value = ''
          }}
        />
        <Upload
          size={24}
          className="mx-auto mb-2 text-[var(--color-ink-subtle)]"
          aria-hidden="true"
        />
        <p className="text-body-s text-[var(--color-ink-muted)]">
          Drag a slab photo here, or{' '}
          <span className="text-[var(--color-accent)]">browse</span>
        </p>
        <p className="text-caption text-[var(--color-ink-subtle)] mt-1">
          JPG, PNG, WEBP up to 10 MB
        </p>
      </div>

      {/* Progress */}
      <AnimatePresence>
        {stage && stage !== 'done' && (
          <motion.div
            initial={reduced ? { opacity: 1 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.25 }}
            className="mt-4"
          >
            {reduced ? (
              <div className="h-1.5 rounded-[var(--radius-pill)] bg-[var(--color-bg-alt)] overflow-hidden">
                <div
                  className="h-full bg-[var(--color-accent)] transition-[width] duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-caption text-[var(--color-ink-muted)]">
                    {SSE_STAGES.find((s) => s.id === stage)?.label}
                  </span>
                  <span className="text-caption text-[var(--color-ink-subtle)]">
                    {Math.round(progress)}%
                  </span>
                </div>
                <div className="h-1.5 rounded-[var(--radius-pill)] bg-[var(--color-bg-alt)] overflow-hidden">
                  <motion.div
                    className="h-full bg-[var(--color-accent)] rounded-[var(--radius-pill)]"
                    style={{ width: `${progress}%` }}
                    transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                  />
                </div>
                <div className="flex gap-1 mt-1 flex-wrap">
                  {SSE_STAGES.map((s, i) => (
                    <span
                      key={s.id}
                      className={cnm(
                        'text-[10px] font-medium px-2 py-0.5 rounded-[var(--radius-pill)] transition-colors duration-200',
                        i < currentStageIndex
                          ? 'bg-[var(--color-success-soft)] text-[var(--color-success)]'
                          : i === currentStageIndex
                            ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                            : 'bg-[var(--color-bg-alt)] text-[var(--color-ink-subtle)]',
                      )}
                    >
                      {s.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Photo result */}
      {result && stage === 'done' && (
        <div className="mt-4">
          <ResultCard result={result} sources={[]} onReport={() => {}} />
        </div>
      )}

      {error && (
        <p className="mt-3 text-body-s text-[var(--color-danger)] flex items-center gap-1.5">
          <AlertCircle size={14} aria-hidden="true" />
          {error}
        </p>
      )}
    </section>
  )
}

// ─── Report Modal ─────────────────────────────────────────────────────────────

function ReportModal({
  onClose,
  reduced,
}: {
  onClose: () => void
  reduced: boolean | null
}) {
  const [reason, setReason] = useState('')
  const [details, setDetails] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) return
    setBusy(true)
    try {
      await submitReport({
        reason: reason.trim(),
        details: details.trim() || undefined,
      })
      setSubmitted(true)
    } catch {
      // fail silently — user sees no error (backend stub)
    } finally {
      setBusy(false)
    }
  }

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
        aria-labelledby="report-modal-title"
        initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
        transition={
          reduced
            ? { duration: 0.1 }
            : { type: 'spring', stiffness: 260, damping: 26 }
        }
        className="fixed inset-0 z-50 flex items-center justify-center p-5 pointer-events-none"
      >
        <div className="w-full max-w-[520px] bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-xl)] p-8 pointer-events-auto">
          <div className="flex items-center justify-between mb-6">
            <h2
              id="report-modal-title"
              className="text-h3 text-[var(--color-ink)]"
            >
              Report data issue
            </h2>
            <button
              type="button"
              aria-label="Close dialog"
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-[var(--radius-md)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:bg-[var(--color-accent-soft)] transition-colors duration-200"
            >
              <X size={16} />
            </button>
          </div>

          {submitted ? (
            <p className="text-body text-[var(--color-success)]">
              Report submitted. Thank you.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label
                  htmlFor="report-reason"
                  className="block text-body-s font-medium text-[var(--color-ink)] mb-1.5"
                >
                  Reason <span aria-hidden="true">*</span>
                </label>
                <input
                  id="report-reason"
                  type="text"
                  required
                  maxLength={200}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Price seems off, wrong card matched"
                  className="w-full h-11 bg-[var(--color-bg-alt)] border border-transparent rounded-[var(--radius-md)] px-4 text-body text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-2 focus:outline-[var(--color-accent)] focus:outline-offset-3 transition-all duration-200"
                />
              </div>
              <div>
                <label
                  htmlFor="report-details"
                  className="block text-body-s font-medium text-[var(--color-ink)] mb-1.5"
                >
                  Additional details
                </label>
                <textarea
                  id="report-details"
                  maxLength={1000}
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  rows={3}
                  placeholder="Any extra context helps us fix it faster"
                  className="w-full bg-[var(--color-bg-alt)] border border-transparent rounded-[var(--radius-md)] px-4 py-3 text-body text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-2 focus:outline-[var(--color-accent)] focus:outline-offset-3 resize-none transition-all duration-200"
                />
              </div>
              <button
                type="submit"
                disabled={busy || !reason.trim()}
                className="h-10 px-5 rounded-[var(--radius-md)] bg-[var(--color-accent)] text-[var(--color-accent-ink)] text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-all duration-200 active:translate-y-px"
              >
                {busy ? 'Submitting…' : 'Submit report'}
              </button>
            </form>
          )}
        </div>
      </motion.div>
    </>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

function PricePage() {
  const reduced = useReducedMotion()
  const [inputValue, setInputValue] = useState('')
  const [committedQuery, setCommittedQuery] = useState('')
  const [reportOpen, setReportOpen] = useState(false)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['price', committedQuery],
    queryFn: () => runPriceQuery(committedQuery),
    enabled: committedQuery.length > 0,
    staleTime: 60_000,
    retry: 1,
  })

  const handleSearch = () => {
    const q = inputValue.trim()
    if (q.length < 2) return
    setCommittedQuery(q)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSearch()
  }

  const handleExample = (query: string) => {
    setInputValue(query)
    setCommittedQuery(query)
  }

  // Normalize result to array
  const results: Array<PriceResult> = data
    ? Array.isArray(data.data)
      ? data.data
      : [data.data]
    : []

  const sources = data?.sources ?? []
  const warnings = data?.warnings ?? []
  const generatedAt = data?.generatedAt

  return (
    <main id="main" className="min-h-screen bg-[var(--color-bg)] pt-28 pb-24">
      <div className="max-w-[1200px] mx-auto px-5 sm:px-8">
        {/* Hero */}
        <section className="max-w-[640px] mb-10">
          <h1 className="text-h1 text-[var(--color-ink)] mb-3">Card Lens</h1>
          <p className="text-body-l text-[var(--color-ink-muted)] mb-2">
            Search any Renaiss card by name, tokenId, or cert number.
            Cross-source FMV from Renaiss main API, Renaiss OS Index, and
            on-chain last sale.
          </p>
          <p className="text-caption text-[var(--color-warn)] bg-[var(--color-warn-soft)] inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[var(--radius-xs)]">
            Beta data. Not financial advice.
          </p>
        </section>

        {/* Search */}
        <section aria-label="Card search">
          <div className="relative max-w-[720px]">
            <Search
              size={18}
              className="absolute left-5 top-1/2 -translate-y-1/2 text-[var(--color-ink-muted)] pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="search"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Paste tokenId, cert (PSA123…), or card name"
              autoComplete="off"
              aria-label="Search cards"
              className="w-full h-16 pl-12 pr-28 bg-[var(--color-bg-alt)] border border-transparent rounded-[var(--radius-md)] text-lg text-[var(--color-ink)] placeholder:text-[var(--color-ink-subtle)] focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)] focus:outline-2 focus:outline-[var(--color-accent)] focus:outline-offset-3 transition-all duration-200"
            />
            <button
              type="button"
              onClick={handleSearch}
              disabled={inputValue.trim().length < 2}
              aria-label="Search"
              className="absolute right-3 top-1/2 -translate-y-1/2 h-10 px-5 rounded-[var(--radius-md)] bg-[var(--color-accent)] text-[var(--color-accent-ink)] text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-all duration-200 active:translate-y-px"
            >
              Search
            </button>
          </div>

          {/* Examples */}
          {!committedQuery && (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <span className="text-body-s text-[var(--color-ink-subtle)]">
                Try:
              </span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.query}
                  type="button"
                  onClick={() => handleExample(ex.query)}
                  className="text-body-s text-[var(--color-ink-muted)] bg-[var(--color-bg-alt)] hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)] px-3 py-1.5 rounded-[var(--radius-pill)] transition-colors duration-200 flex items-center gap-1"
                >
                  {ex.label}
                  <ChevronRight size={12} aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Results */}
        <section aria-label="Search results" className="mt-10">
          {/* Last refreshed */}
          {generatedAt && (
            <p className="text-caption text-[var(--color-ink-subtle)] mb-4">
              Last refreshed {new Date(generatedAt).toLocaleTimeString()}
            </p>
          )}

          {/* Warnings */}
          <WarningBanner warnings={warnings} />

          {/* Loading */}
          {isLoading && committedQuery && (
            <div
              className="flex flex-col gap-4"
              aria-busy="true"
              aria-live="polite"
            >
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="skeleton skeleton-animate h-44 rounded-[var(--radius-lg)]"
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
              <div>
                <p className="text-body font-medium text-[var(--color-ink)]">
                  Something went wrong
                </p>
                <p className="text-body-s text-[var(--color-ink-muted)] mt-1">
                  {(error as Error | null)?.message ?? 'Could not fetch price data.'}
                </p>
              </div>
            </div>
          )}

          {/* Results */}
          {!isLoading && results.length > 0 && (
            <div className="flex flex-col gap-4">
              {results.map((r, i) => (
                <ResultCard
                  key={`${r.cardName}-${i}`}
                  result={r}
                  sources={sources}
                  onReport={() => setReportOpen(true)}
                />
              ))}
            </div>
          )}

          {/* Empty */}
          {!isLoading &&
            !isError &&
            committedQuery.length > 0 &&
            results.length === 0 && (
              <div className="text-center py-16">
                <p className="text-body text-[var(--color-ink-muted)]">
                  No matches for{' '}
                  <strong className="text-[var(--color-ink)]">
                    "{committedQuery}"
                  </strong>
                  .
                </p>
                <p className="text-body-s text-[var(--color-ink-subtle)] mt-1">
                  Try a different card name, cert format, or tokenId.
                </p>
              </div>
            )}
        </section>

        {/* Photo upload */}
        <PhotoUpload reduced={reduced} />

        {/* Source citation footer */}
        <footer className="mt-16 pt-6 border-t border-[var(--color-border)]">
          <p className="text-caption text-[var(--color-ink-subtle)]">
            Data sources: Renaiss main API (beta) · Renaiss OS Index (beta) ·
            Orderbook TradeExecutedV2 (BSC on-chain). Every number cites its
            source.
          </p>
        </footer>
      </div>

      {/* Report modal */}
      <AnimatePresence>
        {reportOpen && (
          <ReportModal onClose={() => setReportOpen(false)} reduced={reduced} />
        )}
      </AnimatePresence>
    </main>
  )
}
