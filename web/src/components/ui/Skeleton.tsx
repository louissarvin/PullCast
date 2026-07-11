import { useEffect } from 'react'
import { cnm } from '@/utils/style'

// Inject the keyframe once into the document head.
// Self-contained to avoid touching styles.css (Agent A's territory).
const KEYFRAME_ID = 'pullcast-skeleton-pulse'

function injectKeyframe() {
  if (typeof document === 'undefined') return
  if (document.getElementById(KEYFRAME_ID)) return
  const style = document.createElement('style')
  style.id = KEYFRAME_ID
  // Pulse between bg-alt and a 2% deeper warm tone — no shimmer per DESIGN.md §4.7
  style.textContent = `
    @keyframes skeleton-pulse {
      from { background-color: var(--color-bg-alt, #F5F1EA); }
      to   { background-color: #EFE9DF; }
    }
  `
  document.head.appendChild(style)
}

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Match the border-radius of the target element. */
  radius?: 'pill' | 'lg' | 'md' | 'sm' | 'xs' | 'none'
  /**
   * Width Tailwind class (e.g. 'w-24', 'w-full').
   * Passed as a className string, not CSS pixels.
   */
  width?: string
  /**
   * Height Tailwind class (e.g. 'h-4', 'h-24').
   * Passed as a className string, not CSS pixels.
   */
  height?: string
}

const radiusClasses: Record<NonNullable<SkeletonProps['radius']>, string> = {
  pill: 'rounded-[var(--radius-pill)]',
  lg: 'rounded-[var(--radius-lg)]',
  md: 'rounded-[var(--radius-md)]',
  sm: 'rounded-[var(--radius-sm)]',
  xs: 'rounded-[var(--radius-xs)]',
  none: 'rounded-none',
}

export function Skeleton({
  radius = 'md',
  width,
  height,
  className,
  ...props
}: SkeletonProps) {
  useEffect(() => {
    injectKeyframe()
  }, [])

  return (
    <div
      aria-hidden="true"
      className={cnm(
        'bg-[var(--color-bg-alt)]',
        // Pulse only if user hasn't opted out of motion
        'motion-safe:[animation:skeleton-pulse_1.2s_ease-in-out_infinite_alternate]',
        radiusClasses[radius],
        width ?? 'w-full',
        height ?? 'h-4',
        className,
      )}
      {...props}
    />
  )
}

/**
 * Wraps skeleton scaffolding with ARIA busy state for screen readers.
 */
export function SkeletonGroup({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={cnm('flex flex-col gap-3', className)}
      {...props}
    >
      {children}
    </div>
  )
}

