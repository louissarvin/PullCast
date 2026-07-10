/**
 * Route: /$address
 * Public wallet gallery — shows all pulls for a given Renaiss wallet address.
 *
 * Sections:
 *  1. Header — address chip + meta stats
 *  2. Filter bar — grader chips + sort dropdown
 *  3. Infinite-scroll pull grid
 *
 * SSR: loader prefetches wallet summary for OG meta tags.
 * Infinite scroll: TanStack Query useInfiniteQuery with cursor keyset pagination.
 * DESIGN.md §5 `/$address` route spec.
 */

import { createFileRoute } from '@tanstack/react-router'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { ChevronDown, Copy, ExternalLink, Package } from 'lucide-react'
import type { Pull } from '@/lib/api/client'
import { ShareCard } from '@/components/share-card/ShareCard'
import { Chip } from '@/components/ui/Chip'
import { Skeleton } from '@/components/ui/Skeleton'
import { getPullsForAddress, getWalletSummary } from '@/lib/api/client'
import { env } from '@/env'
import { useReducedMotion } from '@/lib/motion/reduced-motion'
import { cnm } from '@/utils/style'

gsap.registerPlugin(ScrollTrigger)

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

// ─── Route definition ─────────────────────────────────────────────────────────

export const Route = createFileRoute('/$address')({
  loader: async ({ params }) => {
    // Server-side: fetch wallet summary for OG meta.
    // Guard against non-address paths (e.g. /fonts, /product) that the catch-all route picks up.
    if (!EVM_ADDRESS_RE.test(params.address)) {
      return { summary: null, address: params.address }
    }
    try {
      const result = await getWalletSummary(params.address)
      return { summary: result.data, address: params.address }
    } catch {
      return { summary: null, address: params.address }
    }
  },
  head: ({ loaderData }) => {
    const { address, summary } = loaderData ?? {}
    const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Wallet'
    const count = summary?.totalPulls ?? 0
    const title = `Pulls by ${short} · PullCast`
    const description = `${count} pull${count !== 1 ? 's' : ''} tracked · Powered by Renaiss OS Index`
    const ogImage = `${env.VITE_API_URL}/og/wallet/${address ?? ''}`

    return {
      meta: [
        { title },
        { name: 'description', content: description },
        { property: 'og:title', content: title },
        { property: 'og:description', content: description },
        { property: 'og:image', content: ogImage },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '630' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: title },
        { name: 'twitter:description', content: description },
        { name: 'twitter:image', content: ogImage },
      ],
    }
  },
  component: AddressPage,
})

// ─── Filter / sort state ──────────────────────────────────────────────────────

type GraderFilter = 'all' | 'PSA' | 'BGS' | 'CGC' | 'SGC' | 'RAW'
type SortOption = 'recent' | 'fmv_desc' | 'fmv_asc'

const GRADER_FILTERS: Array<{ label: string; value: GraderFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'PSA', value: 'PSA' },
  { label: 'BGS', value: 'BGS' },
  { label: 'CGC', value: 'CGC' },
  { label: 'SGC', value: 'SGC' },
  { label: 'Raw', value: 'RAW' },
]

const SORT_OPTIONS: Array<{ label: string; value: SortOption }> = [
  { label: 'Most recent', value: 'recent' },
  { label: 'FMV: high to low', value: 'fmv_desc' },
  { label: 'FMV: low to high', value: 'fmv_asc' },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortAddress(addr: string) {
  if (addr.length < 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function copyToClipboard(text: string) {
  void navigator.clipboard.writeText(text)
}

// ─── Header section ───────────────────────────────────────────────────────────

function WalletHeader({ address }: { address: string }) {
  const { data: summaryResult, isLoading } = useQuery({
    queryKey: ['wallet', 'summary', address],
    queryFn: () => getWalletSummary(address),
    staleTime: 30_000,
  })

  const summary = summaryResult?.data

  return (
    <header className="pt-28 pb-10 px-5 sm:px-8 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
      <div className="max-w-[1200px] mx-auto">
        {/* Address + copy */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <span
            className="inline-flex items-center gap-2 h-9 px-4 rounded-[var(--radius-pill)] bg-[var(--color-bg-alt)] border border-[var(--color-border)] text-mono text-sm text-[var(--color-ink-muted)]"
            aria-label={`Wallet address: ${address}`}
            title={address}
          >
            {shortAddress(address)}
          </span>
          <button
            type="button"
            aria-label="Copy wallet address"
            onClick={() => copyToClipboard(address)}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[var(--radius-pill)] bg-[var(--color-surface)] border border-[var(--color-border-strong)] text-xs font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
          >
            <Copy size={13} aria-hidden="true" />
            Copy address
          </button>
          <a
            href={`https://bscscan.com/address/${address}`}
            rel="noopener noreferrer"
            target="_blank"
            aria-label="View on BscScan"
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[var(--radius-pill)] bg-[var(--color-surface)] border border-[var(--color-border-strong)] text-xs font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
          >
            <ExternalLink size={13} aria-hidden="true" />
            BscScan
          </a>
          <button
            type="button"
            aria-label="Share this gallery"
            onClick={() => copyToClipboard(window.location.href)}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[var(--radius-pill)] bg-[var(--color-accent-soft)] text-xs font-medium text-[var(--color-accent)] hover:opacity-80 transition-opacity duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
          >
            Share this gallery
          </button>
        </div>

        {/* Meta stats */}
        {isLoading ? (
          <div className="flex gap-3" aria-busy="true">
            <Skeleton radius="pill" width="w-24" height="h-7" />
            <Skeleton radius="pill" width="w-32" height="h-7" />
          </div>
        ) : summary ? (
          <div className="flex flex-wrap items-center gap-2">
            <Chip variant="default">
              Total pulls: {summary.totalPulls.toLocaleString()}
            </Chip>
            {summary.totalFmv != null && (
              <Chip variant="accent">
                Total FMV: ${summary.totalFmv.toFixed(2)}
              </Chip>
            )}
            {summary.firstSeenAt && (
              <Chip variant="default">
                First seen: {new Date(summary.firstSeenAt).toLocaleDateString()}
              </Chip>
            )}
          </div>
        ) : null}
      </div>
    </header>
  )
}

// ─── Filter bar ───────────────────────────────────────────────────────────────

interface FilterBarProps {
  activeFilter: GraderFilter
  activeSort: SortOption
  onFilterChange: (f: GraderFilter) => void
  onSortChange: (s: SortOption) => void
}

function FilterBar({ activeFilter, activeSort, onFilterChange, onSortChange }: FilterBarProps) {
  const [sortOpen, setSortOpen] = useState(false)
  const sortRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  const activeSortLabel = SORT_OPTIONS.find((s) => s.value === activeSort)?.label ?? 'Sort'

  return (
    <div className="sticky top-16 sm:top-20 z-30 bg-[var(--color-bg)]/90 backdrop-blur-sm border-b border-[var(--color-border)] px-5 sm:px-8 py-3">
      <div className="max-w-[1200px] mx-auto flex items-center justify-between gap-4">
        {/* Grader filter chips — horizontally scrollable on mobile */}
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none flex-1 min-w-0">
          {GRADER_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => onFilterChange(f.value)}
              className={cnm(
                'inline-flex items-center h-7 px-3 rounded-[var(--radius-pill)] text-xs font-medium whitespace-nowrap flex-shrink-0 transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline',
                activeFilter === f.value
                  ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                  : 'bg-[var(--color-bg-alt)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Sort dropdown */}
        <div ref={sortRef} className="relative flex-shrink-0">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={sortOpen}
            onClick={() => setSortOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 h-7 px-3 rounded-[var(--radius-pill)] bg-[var(--color-bg-alt)] text-xs font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
          >
            {activeSortLabel}
            <ChevronDown size={12} aria-hidden="true" className={cnm('transition-transform duration-200', sortOpen && 'rotate-180')} />
          </button>

          {sortOpen && (
            <ul
              role="listbox"
              aria-label="Sort options"
              className="absolute right-0 top-full mt-1 min-w-[160px] bg-[var(--color-surface)] border border-[var(--color-border-strong)] rounded-[var(--radius-sm)] overflow-hidden z-40"
            >
              {SORT_OPTIONS.map((opt) => (
                <li key={opt.value} role="option" aria-selected={activeSort === opt.value}>
                  <button
                    type="button"
                    onClick={() => {
                      onSortChange(opt.value)
                      setSortOpen(false)
                    }}
                    className={cnm(
                      'w-full text-left px-4 py-2.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline',
                      activeSort === opt.value
                        ? 'text-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                        : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-bg-alt)] hover:text-[var(--color-ink)]'
                    )}
                  >
                    {opt.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ reduced }: { reduced: boolean }) {
  const iconRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (reduced || !iconRef.current) return
    const tween = gsap.to(iconRef.current, {
      y: -8,
      ease: 'power1.inOut',
      duration: 1.4,
      yoyo: true,
      repeat: -1,
    })
    return () => {
      tween.kill()
    }
  }, [reduced])

  return (
    <div className="py-24 flex flex-col items-center gap-5 text-center">
      <div ref={iconRef} className="text-[var(--color-ink-subtle)]">
        <Package size={48} strokeWidth={1.5} aria-hidden="true" />
      </div>
      <p className="text-body text-[var(--color-ink-muted)] max-w-[320px]">
        No pulls yet. Once this wallet opens a Renaiss pack, PullCast will post it here.
      </p>
    </div>
  )
}

// ─── Pull grid with infinite scroll ──────────────────────────────────────────

function PullGrid({
  address,
  filter,
  sort,
  reduced,
}: {
  address: string
  filter: GraderFilter
  sort: SortOption
  reduced: boolean
}) {
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Flat listing today (no server-side cursor). We treat the whole result as one page.
  // TODO: switch to real cursor pagination when the backend adds it to /api/wallets/:address/pulls.
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError, refetch } =
    useInfiniteQuery({
      queryKey: ['wallet', 'pulls', address, filter, sort],
      queryFn: () => getPullsForAddress(address),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: () => undefined,
      staleTime: 30_000,
    })

  // Intersection observer for sentinel-based infinite scroll
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasNextPage || isFetchingNextPage) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void fetchNextPage()
        }
      },
      { rootMargin: '200px' }
    )

    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  // Section reveal via ScrollTrigger
  useEffect(() => {
    if (reduced) return
    const ctx = gsap.context(() => {
      ScrollTrigger.batch('.reveal-on-scroll', {
        start: 'top 85%',
        onEnter: (elements) => {
          gsap.fromTo(
            elements,
            { opacity: 0, y: 24 },
            { opacity: 1, y: 0, ease: 'power2.out', duration: 0.6 }
          )
        },
        once: true,
      })
    })
    return () => {
      ctx.revert()
    }
  }, [reduced, data])

  const allPulls: Array<Pull> = data?.pages.flatMap((p) => p.data) ?? []

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5" aria-busy="true" aria-live="polite">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} radius="lg" height="h-[420px]" />
        ))}
      </div>
    )
  }

  if (isError) {
    return (
      <div className="py-16 flex flex-col items-center gap-4 text-center">
        <p className="text-[var(--color-danger)] text-sm max-w-[360px]">
          Failed to load pulls from Renaiss main API (beta). Data may be temporarily unavailable.
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="inline-flex items-center h-9 px-4 text-sm font-medium rounded-[var(--radius-md)] bg-[var(--color-surface)] text-[var(--color-ink)] border border-[var(--color-border-strong)] hover:bg-[var(--color-bg-alt)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
        >
          Retry
        </button>
        <p className="text-xs text-[var(--color-ink-subtle)]">Source: Renaiss main API (beta)</p>
      </div>
    )
  }

  if (allPulls.length === 0) {
    return <EmptyState reduced={reduced} />
  }

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {allPulls.map((pull) => (
          <div key={pull.id} className="reveal-on-scroll">
            <ShareCard pull={pull} />
          </div>
        ))}
      </div>

      {/* Infinite scroll sentinel */}
      <div ref={sentinelRef} aria-hidden="true" />

      {isFetchingNextPage && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 mt-5" aria-busy="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} radius="lg" height="h-[420px]" />
          ))}
        </div>
      )}

      {!hasNextPage && allPulls.length > 0 && (
        <p className="text-center text-xs text-[var(--color-ink-subtle)] mt-10">
          All pulls loaded · Source: Renaiss main API (beta)
        </p>
      )}
    </>
  )
}

// ─── 404 for non-address paths ────────────────────────────────────────────────

function InvalidAddressPage({ address }: { address: string }) {
  return (
    <main id="main" className="min-h-screen bg-[var(--color-bg)] pt-28 pb-24 flex items-start justify-center">
      <div className="max-w-[480px] mx-auto px-5 sm:px-8 pt-16 text-center">
        <p className="text-caption text-[var(--color-ink-subtle)] uppercase tracking-wide mb-4">404</p>
        <h1 className="text-h2 text-[var(--color-ink)] mb-3">Wallet not found</h1>
        <p className="text-body text-[var(--color-ink-muted)]">
          Expected a 0x wallet address, got:{' '}
          <code className="text-sm text-[var(--color-ink-subtle)] bg-[var(--color-bg-alt)] px-1.5 py-0.5 rounded-[var(--radius-xs)]">
            {address}
          </code>
        </p>
      </div>
    </main>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function AddressPage() {
  const { address } = Route.useParams()
  const reduced = useReducedMotion()
  const [filter, setFilter] = useState<GraderFilter>('all')
  const [sort, setSort] = useState<SortOption>('recent')

  const handleFilterChange = useCallback((f: GraderFilter) => setFilter(f), [])
  const handleSortChange = useCallback((s: SortOption) => setSort(s), [])

  if (!EVM_ADDRESS_RE.test(address)) {
    return <InvalidAddressPage address={address} />
  }

  return (
    <main id="main" className="min-h-screen bg-[var(--color-bg)]">
      <WalletHeader address={address} />
        <FilterBar
          activeFilter={filter}
          activeSort={sort}
          onFilterChange={handleFilterChange}
          onSortChange={handleSortChange}
        />
        <section className="px-5 sm:px-8 py-10">
          <div className="max-w-[1200px] mx-auto">
            <PullGrid address={address} filter={filter} sort={sort} reduced={reduced} />
          </div>
        </section>
    </main>
  )
}
