import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Search as SearchIcon } from 'lucide-react'
import { z } from 'zod'
import type { ApiWarning, IndexSearchHit } from '@/lib/api/client'
import { searchIndex } from '@/lib/api/client'
import { IndexAttribution } from '@/components/index/IndexAttribution'
import { indexCardGalleryPath } from '@/lib/index-href'
import { cnm } from '@/utils/style'
import { formatUiNumber } from '@/utils/format'

const searchSchema = z.object({
  q: z.string().optional().default(''),
})

export const Route = createFileRoute('/search')({
  validateSearch: searchSchema,
  component: SearchPage,
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

function ResultRow({ hit }: { hit: IndexSearchHit }) {
  const price =
    typeof hit.priceUsdCents === 'number'
      ? `$${formatUiNumber(hit.priceUsdCents / 100, '', { defaultDecimals: 2 })}`
      : '—'
  const path = indexCardGalleryPath(hit.href ?? null)

  const inner = (
    <article className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-4 flex gap-4">
      {hit.imageUrl ? (
        <img
          src={hit.imageUrl}
          alt=""
          className="w-14 h-[78px] object-cover rounded-[var(--radius-sm)] border border-[var(--color-border)] flex-shrink-0"
          loading="lazy"
        />
      ) : (
        <div
          className="w-14 h-[78px] rounded-[var(--radius-sm)] bg-[var(--color-bg-alt)] border border-[var(--color-border)] flex-shrink-0"
          aria-hidden="true"
        />
      )}
      <div className="min-w-0 flex-1">
        <h2 className="text-body font-medium text-[var(--color-ink)] truncate">
          {hit.name ?? 'Unknown'}
        </h2>
        <p className="text-caption text-[var(--color-ink-muted)] mt-1">
          {hit.gradeLabel ?? '—'}
          {hit.setName ? ` · ${hit.setName}` : ''}
          {hit.cardNumber ? ` #${hit.cardNumber}` : ''}
        </p>
        <p className="text-num text-[var(--color-ink)] font-medium mt-2 tabular-nums">{price}</p>
        {hit.confidence && (
          <p className="text-caption text-[var(--color-ink-subtle)] mt-1 capitalize">
            {hit.confidence} confidence
          </p>
        )}
      </div>
    </article>
  )

  if (path) {
    return (
      <Link to={path} className="block hover:opacity-95 transition-opacity">
        {inner}
      </Link>
    )
  }
  return inner
}

function SearchPage() {
  const navigate = useNavigate({ from: Route.fullPath })
  const { q: query } = Route.useSearch()
  const [input, setInput] = useState(query)

  const trimmed = query.trim()
  const canSearch = trimmed.length >= 2

  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ['search', 'index', trimmed],
    queryFn: () => searchIndex(trimmed, 16),
    enabled: canSearch,
    staleTime: 60_000,
  })

  const results = data?.data ?? []
  const warnings = data?.warnings ?? []

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const next = input.trim()
    navigate({ search: { q: next } })
  }

  return (
    <main id="main" className="min-h-screen bg-[var(--color-bg)] pt-28 pb-24">
      <div className="max-w-[720px] mx-auto px-5 sm:px-8">
        <header className="mb-10">
          <h1 className="text-h1 text-[var(--color-ink)] mb-3">Search Index</h1>
          <p className="text-body-l text-[var(--color-ink-muted)]">
            Free-text search across Renaiss OS Index graded cards — GET /v1/search via PullCast.
          </p>
        </header>

        <form onSubmit={onSubmit} className="relative mb-8">
          <SearchIcon
            size={20}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-ink-subtle)]"
            aria-hidden="true"
          />
          <input
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Charizard, PSA73628064, Pokémon 151…"
            minLength={2}
            className={cnm(
              'w-full h-14 pl-12 pr-28 bg-[var(--color-surface)] border border-[var(--color-border)]',
              'rounded-[var(--radius-lg)] text-body text-[var(--color-ink)]',
              'placeholder:text-[var(--color-ink-subtle)]',
              'focus:border-[var(--color-accent)] focus:outline-2 focus:outline-[var(--color-accent)] focus:outline-offset-2',
            )}
            aria-label="Search Renaiss OS Index"
          />
          <button
            type="submit"
            className="absolute right-2 top-1/2 -translate-y-1/2 h-10 px-5 rounded-[var(--radius-md)] bg-[var(--color-accent)] text-white text-sm font-medium hover:opacity-90"
          >
            Search
          </button>
        </form>

        <WarningBanner warnings={warnings} />

        {!canSearch && trimmed.length > 0 && (
          <p className="text-body text-[var(--color-ink-muted)]">
            Enter at least 2 characters to search the Index API.
          </p>
        )}

        {canSearch && (isLoading || isFetching) && (
          <div className="space-y-3" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton skeleton-animate h-24 rounded-[var(--radius-lg)]" />
            ))}
          </div>
        )}

        {canSearch && isError && (
          <p className="text-[var(--color-danger)] text-sm">Search failed. Try again shortly.</p>
        )}

        {canSearch && !isLoading && !isError && (
          <div className="space-y-3">
            <p className="text-caption text-[var(--color-ink-muted)] mb-4">
              {results.length} result{results.length === 1 ? '' : 's'} for &ldquo;{trimmed}&rdquo;
            </p>
            {results.map((hit, i) => (
              <ResultRow key={hit.href ?? `${hit.name}-${i}`} hit={hit} />
            ))}
            {results.length === 0 && (
              <p className="text-body text-[var(--color-ink-muted)]">No cards matched.</p>
            )}
          </div>
        )}

        <footer className="mt-16 pt-6 border-t border-[var(--color-border)]">
          <IndexAttribution />
          <p className="text-caption text-[var(--color-ink-subtle)] mt-2">
            Also try{' '}
            <Link to="/price" className="text-[var(--color-accent)] hover:underline">
              Card Lens
            </Link>{' '}
            for tokenId / cert cross-source pricing.
          </p>
        </footer>
      </div>
    </main>
  )
}
