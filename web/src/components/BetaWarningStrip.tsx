import { config } from '@/config'

/**
 * Thin site-wide beta notice strip.
 * DESIGN.md §4.10: bg-surface-2, border-b, text-xs, text-muted, text-center.
 * Mount above the main content area, below the PillNavbar if not inside the nav.
 */
export function BetaWarningStrip() {
  return (
    <div
      data-testid="beta-warning-strip"
      className="bg-[var(--color-bg-alt)] border-b border-[var(--color-border)] text-xs text-[var(--color-ink-muted)] text-center py-2 px-4"
      role="banner"
      aria-label="Beta software notice"
    >
      <p>
        PullCast is beta. Price data is informational, not financial advice.
        Every number cites its source.{' '}
        {config.links.github ? (
          <a
            href={config.links.github}
            rel="noopener noreferrer"
            target="_blank"
            className="underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-2 focus-visible:outline rounded-sm"
          >
            Report bugs on GitHub.
          </a>
        ) : (
          'Report bugs on GitHub.'
        )}
      </p>
    </div>
  )
}
