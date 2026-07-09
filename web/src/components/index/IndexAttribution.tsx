/**
 * Required attribution when displaying Renaiss OS Index prices publicly.
 * @see https://index.renaissos.com/api-docs
 */

import { ExternalLink } from 'lucide-react'
import { cnm } from '@/utils/style'

export function IndexAttribution({ className }: { className?: string }) {
  return (
    <p
      className={cnm(
        'text-caption text-[var(--color-ink-subtle)]',
        className,
      )}
    >
      Price data from{' '}
      <a
        href="https://index.renaissos.com"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-0.5 text-[var(--color-accent)] hover:underline"
      >
        Renaiss OS Index
        <ExternalLink size={10} aria-hidden="true" />
      </a>
      {' '}(beta). Informational only — not financial advice.
    </p>
  )
}
