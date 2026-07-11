import { forwardRef } from 'react'
import { Search } from 'lucide-react'
import { cnm } from '@/utils/style'

type InputVariant = 'default' | 'search'

interface InputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'size'
> {
  variant?: InputVariant
  error?: boolean
  errorMessage?: string
  label?: string
  id?: string
  hint?: string
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  (
    {
      variant = 'default',
      error = false,
      errorMessage,
      label,
      id,
      hint,
      className,
      disabled,
      ...props
    },
    ref,
  ) => {
    const inputId =
      id ?? (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined)

    return (
      <div className="flex flex-col gap-1.5 w-full">
        {label && (
          <label
            htmlFor={inputId}
            className="text-[var(--color-ink)] text-sm font-medium"
          >
            {label}
          </label>
        )}

        <div className="relative w-full">
          {variant === 'search' && (
            <Search
              size={16}
              className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-ink-muted)] pointer-events-none"
              aria-hidden="true"
            />
          )}

          <input
            ref={ref}
            id={inputId}
            disabled={disabled}
            aria-invalid={error ? 'true' : undefined}
            aria-describedby={
              errorMessage
                ? `${inputId}-error`
                : hint
                  ? `${inputId}-hint`
                  : undefined
            }
            className={cnm(
              // Base
              'w-full bg-[var(--color-bg-alt)] text-[var(--color-ink)] rounded-[var(--radius-md)] px-4',
              'border border-transparent',
              'text-[16px] leading-[1.6]',
              'placeholder:text-[var(--color-ink-subtle)]',
              'transition-all duration-[180ms] ease-out',
              // Focus
              'focus:outline-2 focus:outline-[var(--color-accent)] focus:outline-offset-[3px] focus:outline',
              'focus:border-[var(--color-accent)] focus:bg-[var(--color-surface)]',
              // Error
              error &&
                'border-[var(--color-danger)] focus:outline-[var(--color-danger)]',
              // Disabled
              disabled && 'opacity-50 cursor-not-allowed',
              // Size variants
              variant === 'search' ? 'h-14 pl-11 pr-4' : 'h-11',
              // Optional search hint on right — reserve space
              variant === 'search' && 'pr-16',
              className,
            )}
            {...props}
          />

          {/* ⌘K hint on search variant */}
          {variant === 'search' && (
            <kbd
              className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex items-center h-6 px-2 rounded-[var(--radius-xs)] bg-[var(--color-border)] text-[var(--color-ink-muted)] text-[11px] font-medium pointer-events-none select-none"
              aria-hidden="true"
            >
              ⌘K
            </kbd>
          )}
        </div>

        {hint && !error && (
          <p
            id={`${inputId}-hint`}
            className="text-[var(--color-ink-muted)] text-xs"
          >
            {hint}
          </p>
        )}

        {error && errorMessage && (
          <p
            id={`${inputId}-error`}
            role="alert"
            className="text-[var(--color-danger)] text-xs"
          >
            {errorMessage}
          </p>
        )}
      </div>
    )
  },
)

Input.displayName = 'Input'

export { Input }
export type { InputProps, InputVariant }
