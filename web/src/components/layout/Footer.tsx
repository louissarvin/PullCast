import { Link } from '@tanstack/react-router'
import { config } from '@/config'

type FooterRoute = '/market' | '/packs' | '/featured' | '/price' | '/stats'

const PRODUCT_LINKS: Array<{ label: string; to: FooterRoute }> = [
  { label: 'Market', to: '/market' },
  { label: 'Packs', to: '/packs' },
  { label: 'Featured', to: '/featured' },
  { label: 'Card Lens', to: '/price' },
  { label: 'Stats', to: '/stats' },
]

const DATA_LINKS = [
  { label: 'Renaiss main API (beta)', href: '#', external: true },
  { label: 'Renaiss OS Index (beta)', href: '#', external: true },
  { label: 'BSC on-chain', href: '#', external: true },
] as const

const COMMUNITY_LINKS = [
  { label: 'Discord', href: config.links.discord, external: true },
  { label: 'GitHub', href: config.links.github, external: true },
  { label: 'Twitter / X', href: config.links.twitter, external: true },
] as const

const BUILD_HASH =
  typeof import.meta.env.VITE_COMMIT_SHA === 'string'
    ? import.meta.env.VITE_COMMIT_SHA.slice(0, 7)
    : 'dev'

export default function Footer() {
  return (
    <footer className="bg-[var(--color-bg)] px-3 sm:px-5 pb-3 sm:pb-5">
      <div className="max-w-[1240px] mx-auto rounded-t-[var(--radius-xl)] bg-[var(--color-bg-alt)] px-6 sm:px-12 lg:px-16 pt-16 sm:pt-20 pb-8">
        {/* Main columns */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-12">
          {/* Brand col */}
          <div className="lg:col-span-1">
            <Link
              to="/"
              aria-label="PullCast home"
              className="inline-flex items-center focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3 focus-visible:outline rounded-[var(--radius-xs)]"
            >
              <img
                src="/assets/logo.svg"
                alt="PullCast"
                width={192}
                height={54}
                className="h-12 w-auto"
              />
            </Link>
          </div>

          {/* Product links */}
          <div>
            <h3 className="text-[var(--color-ink)] text-sm font-semibold mb-5">
              Product
            </h3>
            <ul className="flex flex-col gap-3" role="list">
              {PRODUCT_LINKS.map((link) => (
                <li key={link.to}>
                  <Link
                    to={link.to}
                    className="text-[var(--color-ink-muted)] text-sm hover:text-[var(--color-ink)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3 focus-visible:outline rounded-sm"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Data links */}
          <div>
            <h3 className="text-[var(--color-ink)] text-sm font-semibold mb-5">
              Data
            </h3>
            <ul className="flex flex-col gap-3" role="list">
              {DATA_LINKS.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    rel="noopener noreferrer"
                    target="_blank"
                    className="text-[var(--color-ink-muted)] text-sm hover:text-[var(--color-ink)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3 focus-visible:outline rounded-sm"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Community links */}
          <div>
            <h3 className="text-[var(--color-ink)] text-sm font-semibold mb-5">
              Community
            </h3>
            <ul className="flex flex-col gap-3" role="list">
              {COMMUNITY_LINKS.map((link) => (
                <li key={link.label}>
                  <a
                    href={link.href}
                    rel="noopener noreferrer"
                    target="_blank"
                    className="text-[var(--color-ink-muted)] text-sm hover:text-[var(--color-ink)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3 focus-visible:outline rounded-sm"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Beta warning — subtle, sits between columns and copyright */}
        <div className="mt-16 max-w-[640px]">
          <div
            data-testid="beta-warning"
            className="inline-flex items-start gap-1.5 text-[var(--color-ink-subtle)] text-xs leading-relaxed"
          >
            <span aria-hidden="true" className="flex-shrink-0 mt-0.5 text-[var(--color-warn)]">
              ⚠
            </span>
            <span>
              PullCast is beta. Price data is informational, not financial
              advice. Every number cites its source.{' '}
              {config.links.github ? (
                <a
                  href={config.links.github}
                  rel="noopener noreferrer"
                  target="_blank"
                  className="underline underline-offset-2 hover:text-[var(--color-ink)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3 focus-visible:outline rounded-sm"
                >
                  Report bugs on GitHub.
                </a>
              ) : (
                'Report bugs on GitHub.'
              )}
            </span>
          </div>
        </div>

        {/* Copyright — pivy pattern: just top padding, no border */}
        <div className="mt-12 pt-2">
          <p className="text-[var(--color-ink-subtle)] text-xs">
            &copy;{new Date().getFullYear()} PullCast
            {BUILD_HASH !== 'dev' && (
              <span className="ml-2 opacity-50">#{BUILD_HASH}</span>
            )}
          </p>
        </div>
      </div>
    </footer>
  )
}

