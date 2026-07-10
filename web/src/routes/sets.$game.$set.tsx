import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle } from 'lucide-react'
import type { ApiWarning, SetListingCard } from '@/lib/api/client'
import { getSet } from '@/lib/api/client'
import { IndexAttribution } from '@/components/index/IndexAttribution'
import { indexCardGalleryPath } from '@/lib/index-href'
import { cnm } from '@/utils/style'
import { formatUiNumber } from '@/utils/format'

export const Route = createFileRoute('/sets/$game/$set')({
  component: SetListingPage,
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

function CardRow({ card }: { card: SetListingCard }) {
  const price =
    typeof card.priceUsdCents === 'number'
      ? `$${formatUiNumber(card.priceUsdCents / 100, '', { defaultDecimals: 2 })}`
      : '—'
  const grade = card.gradeLabel ?? (card.company && card.grade ? `${card.company} ${card.grade}` : '—')
  const galleryPath = indexCardGalleryPath(card.href ?? null)

  const inner = (
    <article className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-4 flex gap-4">
      {card.imageUrl ? (
        <img
          src={card.imageUrl}
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
        <h2 className="text-body font-medium text-[var(--color-ink)] truncate">{card.name}</h2>
        <p className="text-caption text-[var(--color-ink-muted)] mt-1">
          {grade}
          {card.cardNumber ? ` · #${card.cardNumber}` : ''}
        </p>
        <p className="text-num text-[var(--color-ink)] font-medium mt-2 tabular-nums">{price}</p>
      </div>
    </article>
  )

  if (galleryPath) {
    return (
      <Link to={galleryPath} className="block hover:opacity-95 transition-opacity">
        {inner}
      </Link>
    )
  }
  return inner
}

function SetListingPage() {
  const { game, set } = Route.useParams()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['sets', game, set],
    queryFn: () => getSet(game, set),
    staleTime: 5 * 60_000,
  })

  const detail = data?.data
  const warnings = data?.warnings ?? []
  const title = detail?.setName ?? detail?.setCode ?? set.replace(/-/g, ' ')

  return (
    <main id="main" className="min-h-screen bg-[var(--color-bg)] pt-28 pb-24">
      <div className="max-w-[900px] mx-auto px-5 sm:px-8">
        <header className="mb-10">
          <p className="text-caption text-[var(--color-ink-subtle)] uppercase tracking-wide mb-2">
            {game}
            {detail?.language ? ` · ${detail.language}` : ''}
          </p>
          <h1 className="text-h1 text-[var(--color-ink)] mb-3 capitalize">{title}</h1>
          <p className="text-body-l text-[var(--color-ink-muted)] max-w-[560px]">
            {typeof detail?.cardCount === 'number'
              ? `${detail.cardCount} graded listings from Renaiss OS Index.`
              : 'Set listing from Renaiss OS Index GET /v1/sets/{game}/{set}.'}
          </p>
        </header>

        <WarningBanner warnings={warnings} />

        {isLoading && (
          <div className="space-y-3" aria-busy="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="skeleton skeleton-animate h-24 rounded-[var(--radius-lg)]"
              />
            ))}
          </div>
        )}

        {isError && (
          <p className="text-[var(--color-danger)] text-sm">
            Failed to load set listing. Check game and set slugs match Index API paths.
          </p>
        )}

        {!isLoading && !isError && detail && (
          <div className="space-y-3">
            {detail.cards.map((card, i) => (
              <CardRow key={card.href ?? `${card.name}-${i}`} card={card} />
            ))}
            {detail.cards.length === 0 && (
              <p className="text-body text-[var(--color-ink-muted)]">
                No cards returned for this set.
              </p>
            )}
          </div>
        )}

        <footer className="mt-16 pt-6 border-t border-[var(--color-border)]">
          <IndexAttribution />
          <p className="text-caption text-[var(--color-ink-subtle)] mt-2">
            GET /v1/sets/{'{game}'}/{'{set}'} via PullCast /api/sets
          </p>
        </footer>
      </div>
    </main>
  )
}
