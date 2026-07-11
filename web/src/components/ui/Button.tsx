import { forwardRef } from 'react'
import { cnm } from '@/utils/style'

type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'icon'
  | 'success'
  | 'destructive'
type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  children?: React.ReactNode
  asChild?: boolean
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--color-accent)] text-[var(--color-accent-ink)] border-transparent hover:opacity-90',
  secondary:
    'bg-[var(--color-surface)] text-[var(--color-ink)] border border-[var(--color-border-strong)] hover:bg-[var(--color-bg-alt)]',
  ghost:
    'bg-transparent text-[var(--color-ink)] border-transparent hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]',
  icon: 'bg-transparent text-[var(--color-ink-muted)] border-transparent hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]',
  success:
    'bg-[var(--color-success)] text-white border-transparent hover:opacity-90',
  destructive:
    'bg-[var(--color-danger)] text-white border-transparent hover:opacity-90',
}

const sizeClasses: Record<ButtonSize, string> = {
  // DESIGN.md §4.2: sm h-32px px-14px fs-13px radius-16px
  sm: 'h-8 px-3.5 text-[13px] rounded-[16px]',
  // md h-40px px-20px fs-14px radius-20px (default)
  md: 'h-10 px-5 text-[14px] rounded-[var(--radius-md)]',
  // lg h-48px px-28px fs-15px radius-24px
  lg: 'h-12 px-7 text-[15px] rounded-[24px]',
}

const iconSizeClasses: Record<ButtonSize, string> = {
  sm: 'h-8 w-8 px-0 rounded-[var(--radius-pill)]',
  md: 'h-10 w-10 px-0 rounded-[var(--radius-pill)]',
  lg: 'h-12 w-12 px-0 rounded-[var(--radius-pill)]',
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      className,
      disabled,
      children,
      ...props
    },
    ref,
  ) => {
    const isIcon = variant === 'icon'
    return (
      <button
        ref={ref}
        disabled={disabled}
        className={cnm(
          // Base
          'inline-flex items-center justify-center font-medium select-none',
          'transition-all duration-[180ms] ease-out',
          'focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline',
          // Active state — translate down on press
          'active:translate-y-px',
          // Disabled
          disabled && 'opacity-40 cursor-not-allowed pointer-events-none',
          // Variant
          variantClasses[variant],
          // Size (icon gets square sizing)
          isIcon ? iconSizeClasses[size] : sizeClasses[size],
          className,
        )}
        {...props}
      >
        {children}
      </button>
    )
  },
)

Button.displayName = 'Button'

export { Button }
export type { ButtonProps, ButtonVariant, ButtonSize }
