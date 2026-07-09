// No box-shadow anywhere per DESIGN.md §2.5.
import { Link } from '@tanstack/react-router'
import { Copy, ExternalLink, Share2 } from 'lucide-react'
import type { Pull } from '@/lib/api/client'
import type { Grader } from '@/components/ui/GradeBadge'
import { GradeBadge } from '@/components/ui/GradeBadge'
import { cnm } from '@/utils/style'

interface ShareCardProps {
  pull: Pull
  /** When true, renders as a standalone page card (larger). */
  size?: 'default' | 'large'
  /** Link-wrapped to /card/$tx when true. */
  linkable?: boolean
  className?: string
  /** Slight rotation for the landing hero fan effect. */
  rotate?: number
  /**
   * Show grader glow — only for graded >= PSA 10 / BGS 10 / CGC 10.
   * Rendered as a 2px CSS outline. Never a box-shadow.
   */
  showGraderGlow?: boolean
}

// Grader glow colors — share-card-only per DESIGN.md §2.1
const graderGlowColors: Partial<Record<Grader, string>> = {
  PSA: '#D91E24',
  BGS: '#C0A15B',
  CGC: '#1D6BB4',
  SGC: '#F2C94C',
}

// Tier-based gradient art used when the pull has no imageUrl. Reads as an
// editorial "collectible tile" rather than a broken image placeholder.
const TIER_GRADIENT: Record<string, string> = {
  legendary: 'linear-gradient(135deg, #FFE066 0%, #F5A623 50%, #B45309 100%)',
  mythic: 'linear-gradient(135deg, #FFE066 0%, #F5A623 50%, #B45309 100%)',
  epic: 'linear-gradient(135deg, #E9D5FF 0%, #9333EA 55%, #4C1D95 100%)',
  rare: 'linear-gradient(135deg, #E9D5FF 0%, #9333EA 55%, #4C1D95 100%)',
  uncommon: 'linear-gradient(135deg, #BFDBFE 0%, #3B82F6 55%, #1E3A8A 100%)',
  common: 'linear-gradient(135deg, #E5E7EB 0%, #9CA3AF 55%, #4B5563 100%)',
}

const TIER_ACCENT_GLYPH: Record<string, string> = {
  legendary: '♛',
  mythic: '♛',
  epic: '◆',
  rare: '◆',
  uncommon: '◈',
  common: '◇',
}

function fmvFormat(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function formatNet(net: number): string {
  const sign = net >= 0 ? '+' : '−'
  return `${sign}${fmvFormat(Math.abs(net))}`
}

function shortAddress(addr: string): string {
  if (addr.length <= 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function ShareCard({
  pull,
  size = 'default',
  linkable = true,
  className,
  rotate,
  showGraderGlow = false,
}: ShareCardProps) {
  const isLarge = size === 'large'
  const net =
    pull.fmv != null && pull.packCost != null ? pull.fmv - pull.packCost : null
  const netPositive = net != null ? net >= 0 : null
  const grader = pull.grader as Grader | undefined
  const glowColor = grader ? graderGlowColors[grader] : undefined

  const combinedStyle: React.CSSProperties = {
    ...(rotate != null ? { transform: `rotate(${rotate}deg)` } : {}),
    ...(showGraderGlow && glowColor
      ? { outline: `2px solid ${glowColor}`, outlineOffset: '0px' }
      : {}),
  }

  const tierKey = (pull.tier ?? '').toLowerCase()
  const tierGradient = TIER_GRADIENT[tierKey] ?? TIER_GRADIENT.common
  const tierGlyph = TIER_ACCENT_GLYPH[tierKey] ?? TIER_ACCENT_GLYPH.common

  // Display name falls back to a humanised pack slug when the indexer hasn't
  // resolved the card metadata yet. This is the common case for freshly-minted
  // on-chain pulls.
  const displayName =
    pull.cardName && pull.cardName.length > 0
      ? pull.cardName
      : pull.packSlug
        ? `${pull.packSlug.replace(/-/g, ' ')} pull`
        : 'Untitled pull'

  const inner = (
    <article
      className={cnm(
        'bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-5 flex flex-col gap-4',
        'transition-[border-color,transform] duration-200 ease-out',
        linkable &&
          'group cursor-pointer hover:-translate-y-1 hover:border-[var(--color-border-strong)] motion-reduce:hover:translate-y-0',
        isLarge ? 'max-w-[480px] w-full' : 'w-full',
        className,
      )}
      style={Object.keys(combinedStyle).length > 0 ? combinedStyle : undefined}
    >
      {/* Card image / hero tile — 3:4 aspect per DESIGN.md §4.3 */}
      <div
        className="relative w-full aspect-[3/4] rounded-[var(--radius-md)] overflow-hidden border border-[var(--color-border)]"
        style={pull.imageUrl ? undefined : { background: tierGradient }}
      >
        {pull.imageUrl ? (
          <img
            src={pull.imageUrl}
            alt=""
            className="w-full h-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03]"
            loading="lazy"
            decoding="async"
            aria-hidden="true"
          />
        ) : (
          <>
            {/* Soft radial highlight top-right for depth */}
            <div
              className="absolute inset-0"
              style={{
                background:
                  'radial-gradient(circle at 78% 22%, rgba(255,255,255,0.35) 0%, transparent 55%)',
              }}
              aria-hidden="true"
            />
            {/* Big tier glyph, lower-right, low-opacity, transitions on hover */}
            <span
              aria-hidden="true"
              className="absolute right-3 bottom-2 text-[80px] leading-none text-white opacity-25 select-none transition-transform duration-300 ease-out group-hover:scale-105"
            >
              {tierGlyph}
            </span>
            {/* Centered display name over the gradient */}
            <div className="absolute inset-0 flex items-center justify-center px-4">
              <p className="text-white text-center font-semibold text-lg leading-tight capitalize drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)] line-clamp-3">
                {displayName}
              </p>
            </div>
          </>
        )}

        {/* Grade strip — top overlay, scoped colors per DESIGN.md §2.1 */}
        {grader && pull.grade != null && (
          <div className="absolute top-0 inset-x-0 h-8 flex items-center px-3 gap-2 bg-gradient-to-b from-black/25 to-transparent">
            <GradeBadge grader={grader} grade={pull.grade} />
          </div>
        )}

        {/* Tier badge — bottom-left pill; hidden when we have a real image
            so it doesn't fight with the card art */}
        {!pull.imageUrl && pull.tier ? (
          <span className="absolute top-3 right-3 inline-flex px-2 py-0.5 rounded-[var(--radius-pill)] bg-[rgba(255,255,255,0.92)] text-[10px] font-semibold uppercase tracking-wide text-[var(--color-ink)] backdrop-blur-sm">
            {pull.tier}
          </span>
        ) : null}
      </div>

      {/* Card name + set (only when we have real card metadata) */}
      {pull.cardName && pull.cardName.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          <p
            className={cnm(
              'text-[var(--color-ink)] font-semibold leading-snug',
              isLarge ? 'text-lg' : 'text-base',
            )}
          >
            {pull.cardName}
          </p>
          {pull.setName && (
            <p className="text-[var(--color-ink-muted)] text-sm">{pull.setName}</p>
          )}
        </div>
      ) : null}

      {/* FMV + net + pack cost */}
      {(pull.fmv != null || net != null || pull.packCost != null) && (
        <div className="flex flex-col gap-1 pt-1 border-t border-[var(--color-border)]">
          {pull.fmv != null && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[var(--color-ink-muted)] text-xs">FMV</span>
              <span className="text-[var(--color-ink)] text-sm font-semibold tabular-nums">
                {fmvFormat(pull.fmv)}
              </span>
            </div>
          )}
          {net != null && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[var(--color-ink-muted)] text-xs">Net</span>
              <span
                className={cnm(
                  'text-sm font-medium tabular-nums',
                  netPositive
                    ? 'text-[var(--color-success)]'
                    : 'text-[var(--color-danger)]',
                )}
              >
                {formatNet(net)}
              </span>
            </div>
          )}
          {pull.packCost != null && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[var(--color-ink-muted)] text-xs">Pack</span>
              <span className="text-[var(--color-ink-muted)] text-sm tabular-nums">
                {fmvFormat(pull.packCost)}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Puller + action buttons */}
      <div className="flex items-center justify-between gap-2">
        {pull.address && (
          <span
            className="text-[var(--color-ink-subtle)] text-xs font-medium"
            aria-label={`Pulled by ${pull.address}`}
            title={pull.address}
          >
            {shortAddress(pull.address)}
          </span>
        )}

        <div className="flex items-center gap-1 ml-auto">
          <button
            type="button"
            aria-label="Share to X"
            onClick={(e) => e.stopPropagation()}
            className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-pill)] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
          >
            <Share2 size={13} />
          </button>
          <a
            href={`https://renaiss.xyz/collectibles/${pull.txHash}`}
            rel="noopener noreferrer"
            target="_blank"
            aria-label="View on Renaiss (opens in new tab)"
            onClick={(e) => e.stopPropagation()}
            className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-pill)] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
          >
            <ExternalLink size={13} />
          </a>
          <button
            type="button"
            aria-label="Copy card link to clipboard"
            onClick={(e) => {
              e.stopPropagation()
              void navigator.clipboard.writeText(
                `${window.location.origin}/card/${pull.id}`,
              )
            }}
            className="w-7 h-7 flex items-center justify-center rounded-[var(--radius-pill)] text-[var(--color-ink-muted)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline"
          >
            <Copy size={13} />
          </button>
        </div>
      </div>

      {/* Beta watermark footer — always present per DESIGN.md spec */}
      <div className="border-t border-[var(--color-border)] pt-2 mt-auto">
        <p className="text-[var(--color-ink-subtle)] text-[10px] leading-tight">
          Data: Renaiss OS Index (beta) · pullcast.xyz
        </p>
      </div>
    </article>
  )

  if (!linkable) return inner

  return (
    <Link
      to="/card/$tx"
      params={{ tx: pull.id }}
      className="block focus-visible:outline-none"
    >
      {inner}
    </Link>
  )
}
