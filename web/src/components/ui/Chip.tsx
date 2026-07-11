import { forwardRef } from 'react'
import { cnm } from '@/utils/style'

export type ChipVariant = 'default' | 'accent' | 'success' | 'warn' | 'danger'

interface BaseChipProps {
  variant?: ChipVariant
  className?: string
  children?: React.ReactNode
}

export interface ChipProps extends BaseChipProps, React.HTMLAttributes<HTMLSpanElement> {
  as?: 'span'
}

export interface ChipButtonProps extends BaseChipProps, React.ButtonHTMLAttributes<HTMLButtonElement> {
  as: 'button'
}

const variantClasses: Record<ChipVariant, string> = {
  default:
    'bg-[var(--color-bg-alt)] text-[var(--color-ink-muted)] border border-[var(--color-border)]',
  accent:
    'bg-[var(--color-accent-soft)] text-[var(--color-accent)] border-transparent',
  success:
    'bg-[var(--color-success-soft)] text-[var(--color-success)] border-transparent',
  warn:
    'bg-[var(--color-warn-soft)] text-[var(--color-warn)] border-transparent',
  danger:
    'bg-[#FDE8E8] text-[var(--color-danger)] border-transparent',
}

const baseClasses =
  'inline-flex items-center h-7 px-3 rounded-[var(--radius-pill)] text-xs font-medium'

// span variant
const ChipSpan = forwardRef<HTMLSpanElement, ChipProps>(
  ({ variant = 'default', className, children, as: _as, ...props }, ref) => (
    <span
      ref={ref}
      className={cnm(baseClasses, variantClasses[variant], className)}
      {...props}
    >
      {children}
    </span>
  )
)
ChipSpan.displayName = 'Chip'

// button variant
const ChipButton = forwardRef<HTMLButtonElement, ChipButtonProps>(
  ({ variant = 'default', className, children, as: _as, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cnm(
        baseClasses,
        variantClasses[variant],
        'cursor-pointer transition-colors duration-200',
        'focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
)
ChipButton.displayName = 'Chip.Button'

// Unified Chip — delegates to span or button based on `as` prop
function Chip(props: ChipProps): React.ReactElement
function Chip(props: ChipButtonProps): React.ReactElement
function Chip(props: ChipProps | ChipButtonProps): React.ReactElement {
  if (props.as === 'button') {
    const { as: _as, ...rest } = props
    return <ChipButton {...(rest as ChipButtonProps)} />
  }
  const { as: _as, ...rest } = props
  return <ChipSpan {...(rest as ChipProps)} />
}

export { Chip }

