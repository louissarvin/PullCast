import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, ExternalLink } from 'lucide-react'
import { z } from 'zod'
import type { ApiWarning, MarketplaceItem } from '@/lib/api/client'
import { searchMarketplace } from '@/lib/api/client'
import { IndexAttribution } from '@/components/index/IndexAttribution'
import { cnm } from '@/utils/style'
import { formatUiNumber } from '@/utils/format'

const browseSchema = z.object({
  search: z.string().optional().default(''),
  category: z.string().optional(),
  grading: z.string().optional(),
  listed: z.boolean().optional(),
})

export const Route = createFileRoute('/browse')({
  validateSearch: browseSchema,
  component: BrowsePage,
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

/** Convert an 18-decimal wei string to a USD display string. Returns "—" on null/invalid. */
function formatUsdFromWei(wei: string | null | undefined): string {
  if (wei == null || wei === '') return '—'
  try {
    // Divide by 10^12 using BigInt, then divide remainder by 10^6 as float for 6-decimal precision
    const micro = Number(BigInt(wei) / BigInt(10 ** 12))
    const usd = micro / 10 ** 6
    return usd.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2,
    })
  } catch {
    return '—'
  }
}

/**
 * Extract a compact card name by stripping grading, year, and set prefixes
 * from the verbose Renaiss `item.name` field. Falls back to full name.
 */
function shortCardName(item: MarketplaceItem): string {
  const raw = item.name.trim()
  // Common Renaiss format: "PSA 10 Gem Mint 2025 <setName> #<num> <cardName>"
  // Strip the leading grading+year+set clause, then strip any leading #num
  const setIdx = raw.toLowerCase().indexOf(item.setName.toLowerCase())
  if (setIdx >= 0) {
    let tail = raw.slice(setIdx + item.setName.length).trim()
    // strip leading "#123" or "123" cardNumber reference
    tail = tail.replace(new RegExp(`^#?${item.cardNumber}\\b`, 'i'), '').trim()
    if (tail.length > 0) return tail
  }
  return raw
}

function ListingRow({ item }: { item: MarketplaceItem }) {
  const ask =
    item.askPriceInUSDT != null && item.askPriceInUSDT !== ''
      ? formatUsdFromWei(item.askPriceInUSDT)
      : null
  const fmv =
    item.fmvPriceInUSD != null && item.fmvPriceInUSD !== ''
      ? `$${formatUiNumber(Number(item.fmvPriceInUSD), '', { defaultDecimals: 2 })}`
      : '—'
  const isListed = ask !== null
  const cardName = shortCardName(item)
  const shortToken = `${item.tokenId.slice(0, 6)}…${item.tokenId.slice(-4)}`

  return (
    <article
      className={cnm(
        'group bg-[var(--color-surface)] border border-[var(--color-border)]',
        'rounded-[var(--radius-lg)] p-5 transition-[border-color,transform] duration-200 ease-out',
        'hover:-translate-y-0.5 hover:border-[var(--color-border-strong)]',
      )}
    >
      <div className="flex items-start gap-4">
        {/* Thumbnail placeholder — grading badge on a soft accent tile */}
        <div
          className={cnm(
            'flex-shrink-0 w-14 h-20 rounded-[var(--radius-sm)]',
            'bg-[var(--color-bg-alt)] border border-[var(--color-border)]',
            'flex flex-col items-center justify-center text-center px-1',
          )}
          aria-hidden="true"
        >
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink-muted)] leading-none">
            {item.gradingCompany}
          </span>
          <span className="text-[18px] font-semibold text-[var(--color-ink)] leading-none mt-1 tabular-nums">
            {item.grade}
          </span>
        </div>

        {/* Meta column */}
        <div className="min-w-0 flex-1">
          <h2 className="text-body font-medium text-[var(--color-ink)] line-clamp-2">
            {cardName}
          </h2>
          <p className="text-caption text-[var(--color-ink-muted)] mt-1 truncate">
            {item.setName} · #{item.cardNumber} · {item.year}
          </p>
          <p className="text-[11px] text-[var(--color-ink-subtle)] mt-1 font-mono">
            {shortToken}
          </p>
        </div>

        {/* Price column */}
        <div className="text-right flex-shrink-0 min-w-[92px]">
          <p className="text-[10px] uppercase tracking-wide text-[var(--color-ink-subtle)]">
            FMV
          </p>
          <p className="text-body font-semibold tabular-nums text-[var(--color-ink)] leading-tight">
            {fmv}
          </p>
          {isListed ? (
            <div className="mt-2 inline-flex flex-col items-end">
              <p className="text-[10px] uppercase tracking-wide text-[var(--color-accent)]">
                Ask
              </p>
              <p className="text-body-s font-medium tabular-nums text-[var(--color-accent)] leading-tight">
                {ask}
              </p>
            </div>
          ) : (
            <p className="mt-2 text-[10px] uppercase tracking-wide text-[var(--color-ink-subtle)]">
              Unlisted
            </p>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between gap-3 mt-4 pt-3 border-t border-[var(--color-border)]">
        <Link
          to="/price"
          className="text-caption font-medium text-[var(--color-accent)] hover:underline"
        >
          Card Lens →
        </Link>
        <a
          href={`https://renaiss.xyz/card/${item.tokenId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-caption text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] transition-colors duration-200"
        >
          View on Renaiss
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>
    </article>
  )
}

function BrowsePage() {
  const navigate = useNavigate({ from: Route.fullPath })
  const { search, category, grading, listed } = Route.useSearch()

  const trimmed = search.trim()
  const canQuery = trimmed.length === 0 || trimmed.length >= 3

  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ['marketplace', trimmed, category, grading, listed],
    queryFn: () =>
      searchMarketplace({
        ...(trimmed.length >= 3 ? { search: trimmed } : {}),
        ...(category ? { categoryFilter: category } : {}),
        ...(grading ? { gradingCompanyFilter: grading } : {}),
        ...(listed ? { listedOnly: true } : {}),
        sortBy: 'listDate',
        sortOrder: 'desc',
        limit: 12,
      }),
    enabled: canQuery,
    staleTime: 60_000,
  })

  const collection = data?.data.collection ?? []
  const total = data?.data.pagination?.total ?? collection.length
  const warnings = data?.warnings ?? []

  return (
    <main id="main" className="min-h-screen bg-[var(--color-bg)] pt-28 pb-24">
      <div className="max-w-[800px] mx-auto px-5 sm:px-8">
        <header className="mb-10">
          <p className="text-caption text-[var(--color-accent)] uppercase tracking-wide mb-2">
            Renaiss main API
          </p>
          <h1 className="text-h1 text-[var(--color-ink)] mb-3">Marketplace</h1>
          <p className="text-body-l text-[var(--color-ink-muted)]">
            Browse live vault listings via GET /v0/marketplace — mirrors{' '}
            <code className="text-sm">npx renaiss marketplace</code> and{' '}
            <code className="text-sm">pullcast marketplace</code>.
          </p>
        </header>

        <form
          className="grid sm:grid-cols-2 gap-3 mb-8"
          onSubmit={(e) => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget)
            navigate({
              search: {
                search: String(fd.get('search') ?? ''),
                category: String(fd.get('category') ?? '') || undefined,
                grading: String(fd.get('grading') ?? '') || undefined,
                listed: fd.get('listed') === 'on',
              },
            })
          }}
        >
          <input
            name="search"
            type="search"
            defaultValue={search}
            placeholder="Search collectibles (min 3 chars)…"
            className={cnm(
              'sm:col-span-2 h-12 px-4 bg-[var(--color-surface)] border border-[var(--color-border)]',
              'rounded-[var(--radius-md)] text-body text-[var(--color-ink)]',
              'focus:border-[var(--color-accent)] focus:outline-2 focus:outline-[var(--color-accent)]',
            )}
          />
          <select
            name="category"
            defaultValue={category ?? ''}
            className="h-12 px-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-md)] text-body"
          >
            <option value="">All categories</option>
            <option value="POKEMON">Pokémon</option>
            <option value="ONE_PIECE">One Piece</option>
          </select>
          <select
            name="grading"
            defaultValue={grading ?? ''}
            className="h-12 px-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-md)] text-body"
          >
            <option value="">All graders</option>
            <option value="PSA">PSA</option>
            <option value="BGS">BGS</option>
            <option value="CGC">CGC</option>
            <option value="SGC">SGC</option>
          </select>
          <label className="flex items-center gap-2 text-body text-[var(--color-ink-muted)] sm:col-span-2">
            <input name="listed" type="checkbox" defaultChecked={listed} className="rounded" />
            Listed only (has ask price)
          </label>
          <button
            type="submit"
            className="sm:col-span-2 h-12 rounded-[var(--radius-md)] bg-[var(--color-accent)] text-white font-medium hover:opacity-90"
          >
            Browse
          </button>
        </form>

        <WarningBanner warnings={warnings} />

        {!canQuery && (
          <p className="text-body text-[var(--color-ink-muted)]">
            Search must be empty or at least 3 characters (matches Renaiss API).
          </p>
        )}

        {canQuery && (isLoading || isFetching) && (
          <div className="space-y-3" aria-busy="true">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton skeleton-animate h-28 rounded-[var(--radius-lg)]" />
            ))}
          </div>
        )}

        {canQuery && isError && (
          <p className="text-[var(--color-danger)] text-sm">Marketplace request failed.</p>
        )}

        {canQuery && !isLoading && !isError && (
          <div className="space-y-3">
            <p className="text-caption text-[var(--color-ink-muted)] mb-4">
              {total} listing{total === 1 ? '' : 's'}
              {trimmed ? ` matching “${trimmed}”` : ''}
            </p>
            {collection.map((item) => (
              <ListingRow key={item.tokenId} item={item} />
            ))}
            {collection.length === 0 && (
              <p className="text-body text-[var(--color-ink-muted)]">No listings matched.</p>
            )}
          </div>
        )}

        <footer className="mt-16 pt-6 border-t border-[var(--color-border)]">
          <p className="text-caption text-[var(--color-ink-subtle)] mb-2">
            To buy or list, use the official CLI:{' '}
            <code className="text-xs">npx renaiss@0.0.3-beta.2 marketplace</code>
          </p>
          <IndexAttribution />
        </footer>
      </div>
    </main>
  )
}

