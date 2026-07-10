import { Link, createFileRoute } from '@tanstack/react-router'
import { Check, ExternalLink, Minus } from 'lucide-react'
import { IndexAttribution } from '@/components/index/IndexAttribution'
import { cnm } from '@/utils/style'

export const Route = createFileRoute('/ecosystem')({
  component: EcosystemPage,
})

type Status = 'live' | 'partial' | 'blocked'

interface MatrixRow {
  surface: string
  endpoint: string
  pullcast: string
  href?: string
  status: Status
}

const MAIN_API: Array<MatrixRow> = [
  { surface: 'Main API', endpoint: 'GET /v0/health', pullcast: 'Stats upstream probe', href: '/stats', status: 'live' },
  { surface: 'Main API', endpoint: 'GET /v0/marketplace', pullcast: 'Web /browse · CLI marketplace · Discord /browse', href: '/browse', status: 'live' },
  { surface: 'Main API', endpoint: 'GET /v0/cards/{tokenId}', pullcast: 'Card Lens Cert Bridge', href: '/price', status: 'live' },
  { surface: 'Main API', endpoint: 'GET /v0/packs', pullcast: 'Web /packs · indexer · CLI gacha list', href: '/packs', status: 'live' },
  { surface: 'Main API', endpoint: 'GET /v0/users/{id}', pullcast: 'Discord /profile', status: 'live' },
]

const INDEX_API: Array<MatrixRow> = [
  { surface: 'Index API', endpoint: 'GET /v1/graded/{cert}', pullcast: 'Cert Bridge headline', href: '/price', status: 'live' },
  { surface: 'Index API', endpoint: 'POST /v1/graded/by-image', pullcast: 'Card Lens photo SSE', href: '/price', status: 'live' },
  { surface: 'Index API', endpoint: 'GET /v1/search', pullcast: 'Web /search · CLI · Discord', href: '/search', status: 'live' },
  { surface: 'Index API', endpoint: 'GET /v1/trades/recent', pullcast: 'Web /trades · Big Trade worker', href: '/trades', status: 'live' },
  { surface: 'Index API', endpoint: 'GET /v1/cards/featured', pullcast: 'Web /featured · Discord /featured', href: '/featured', status: 'live' },
  { surface: 'Index API', endpoint: 'GET /v1/indices*', pullcast: 'Web /market · Discord /market', href: '/market', status: 'live' },
  { surface: 'Index API', endpoint: 'GET /v1/sets/{game}/{set}', pullcast: 'Web /sets/$game/$set', href: '/sets/pokemon/pokemon-japanese-sv2a-pokemon-151', status: 'live' },
  { surface: 'Index API', endpoint: 'GET /v1/cards/{g}/{s}/{c}', pullcast: 'Web card gallery + overview + FMV', href: '/featured', status: 'live' },
  { surface: 'Index API', endpoint: 'GET /v1/cards/…/overview', pullcast: 'All-grade table on card detail', status: 'live' },
  { surface: 'Index API', endpoint: 'GET /v1/cards/…/fmv-series', pullcast: '30d sparkline on card detail', status: 'live' },
  { surface: 'Index API', endpoint: 'GET /v1/cards/…/trades', pullcast: 'Trades panel on card detail', status: 'live' },
  { surface: 'Index API', endpoint: 'POST /v1/report', pullcast: 'Discord /report · CLI report', status: 'live' },
  { surface: 'Index API', endpoint: 'GET /v1/index/item-by-no', pullcast: 'Tuple Bridge (search fallback)', status: 'partial' },
  { surface: 'Index API', endpoint: 'GET /v1/cards/by-renaiss-id/*', pullcast: 'Wired — blocked: no renaiss_item_id on main API', status: 'blocked' },
]

const CLI_ROWS: Array<MatrixRow> = [
  { surface: 'Renaiss CLI', endpoint: 'renaiss marketplace', pullcast: 'pullcast marketplace (flag parity)', status: 'live' },
  { surface: 'Renaiss CLI', endpoint: 'renaiss card', pullcast: 'pullcast card', status: 'live' },
  { surface: 'Renaiss CLI', endpoint: 'renaiss gacha list', pullcast: 'pullcast gacha list', status: 'live' },
  { surface: 'Renaiss CLI', endpoint: 'renaiss gacha pull', pullcast: 'Use official CLI (Safe signatures)', status: 'partial' },
]

const OFFICIAL_LINKS = [
  { label: 'Renaiss main API docs', url: 'https://api.renaiss.xyz/docs' },
  { label: 'Renaiss OS Index API', url: 'https://api.renaissos.com/docs' },
  { label: 'Index partner keys', url: 'https://index.renaissos.com/partners' },
  { label: 'Official Renaiss CLI', url: 'https://www.npmjs.com/package/renaiss' },
] as const

function StatusIcon({ status }: { status: Status }) {
  if (status === 'live') {
    return <Check size={14} className="text-[var(--color-success)] flex-shrink-0" aria-label="Live" />
  }
  if (status === 'blocked') {
    return <Minus size={14} className="text-[var(--color-danger)] flex-shrink-0" aria-label="Blocked upstream" />
  }
  return <Minus size={14} className="text-[var(--color-warn)] flex-shrink-0" aria-label="Partial" />
}

function MatrixTable({ title, rows }: { title: string; rows: Array<MatrixRow> }) {
  return (
    <section className="mb-12">
      <h2 className="text-h3 text-[var(--color-ink)] mb-4">{title}</h2>
      <div className="overflow-x-auto border border-[var(--color-border)] rounded-[var(--radius-lg)]">
        <table className="w-full text-left text-sm min-w-[640px]">
          <thead>
            <tr className="bg-[var(--color-bg-alt)] border-b border-[var(--color-border)]">
              <th className="px-4 py-3 font-medium text-[var(--color-ink-muted)]">Endpoint</th>
              <th className="px-4 py-3 font-medium text-[var(--color-ink-muted)]">PullCast</th>
              <th className="px-4 py-3 w-10" aria-hidden="true" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.endpoint}-${row.pullcast}`} className="border-b border-[var(--color-border)] last:border-0">
                <td className="px-4 py-3 font-mono text-xs text-[var(--color-ink)]">{row.endpoint}</td>
                <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                  {row.href ? (
                    <Link to={row.href} className="text-[var(--color-accent)] hover:underline">
                      {row.pullcast}
                    </Link>
                  ) : (
                    row.pullcast
                  )}
                </td>
                <td className="px-4 py-3">
                  <StatusIcon status={row.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function EcosystemPage() {
  return (
    <main id="main" className="min-h-screen bg-[var(--color-bg)] pt-28 pb-24">
      <div className="max-w-[960px] mx-auto px-5 sm:px-8">
        <header className="mb-12">
          <p className="text-caption text-[var(--color-accent)] uppercase tracking-wide mb-2">
            Hackathon S1 · Tool track
          </p>
          <h1 className="text-h1 text-[var(--color-ink)] mb-4">Renaiss ecosystem map</h1>
          <p className="text-body-l text-[var(--color-ink-muted)] max-w-[640px]">
            PullCast is the first community client composing Renaiss main API, OS Index API, and official CLI —
            read-only on top, write flows delegated to <code className="text-sm">npx renaiss</code>.
          </p>
        </header>

        <div className="grid sm:grid-cols-3 gap-4 mb-12">
          {[
            { n: '3', label: 'Renaiss surfaces', sub: 'Main · Index · CLI' },
            { n: '28', label: 'Index read endpoints', sub: 'All wired in backend' },
            { n: '5', label: 'Distribution channels', sub: 'Web · Discord · CLI · API · Skill' },
          ].map(({ n, label, sub }) => (
            <div
              key={label}
              className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-5"
            >
              <p className="text-[2rem] font-semibold text-[var(--color-ink)] tabular-nums">{n}</p>
              <p className="text-body font-medium text-[var(--color-ink)] mt-1">{label}</p>
              <p className="text-caption text-[var(--color-ink-muted)]">{sub}</p>
            </div>
          ))}
        </div>

        <MatrixTable title="Renaiss main API (api.renaiss.xyz/v0)" rows={MAIN_API} />
        <MatrixTable title="Renaiss OS Index (api.renaissos.com/v1)" rows={INDEX_API} />
        <MatrixTable title="Official CLI parity" rows={CLI_ROWS} />

        <section className="mb-12 p-6 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)]">
          <h2 className="text-h3 text-[var(--color-ink)] mb-3">Cert Bridge</h2>
          <p className="text-body text-[var(--color-ink-muted)] mb-4">
            tokenId → GET /v0/cards/{'{tokenId}'} → Serial attribute → GET /v1/graded/{'{cert}'} → authoritative FMV.
          </p>
          <Link
            to="/price"
            className={cnm(
              'inline-flex items-center gap-2 text-body text-[var(--color-accent)]',
              'hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]',
            )}
          >
            Try Card Lens
          </Link>
        </section>

        <section className="mb-12">
          <h2 className="text-h3 text-[var(--color-ink)] mb-4">Official docs</h2>
          <ul className="space-y-2">
            {OFFICIAL_LINKS.map(({ label, url }) => (
              <li key={url}>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-body text-[var(--color-accent)] hover:underline"
                >
                  {label}
                  <ExternalLink size={14} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </section>

        <section className="mb-12">
          <h2 className="text-h3 text-[var(--color-ink)] mb-4">Quick install</h2>
          <pre className="text-xs sm:text-sm bg-[var(--color-bg-alt)] border border-[var(--color-border)] rounded-[var(--radius-md)] p-4 overflow-x-auto text-[var(--color-ink)]">
{`npx renaiss@0.0.3-beta.2 --help    # official read + write
npx pullcast --help                 # community read layer
# Discord bot → README OAuth URL`}
          </pre>
        </section>

        <footer className="pt-6 border-t border-[var(--color-border)]">
          <IndexAttribution />
        </footer>
      </div>
    </main>
  )
}
