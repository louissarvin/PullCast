import { forwardRef } from 'react'
import { cnm } from '@/utils/style'

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  interactive?: boolean
}

const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ interactive = false, className, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cnm(
          'bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-lg)] p-6',
          interactive && [
            'cursor-pointer transition-all duration-200 ease-out',
            'hover:-translate-y-0.5 hover:border-[var(--color-border-strong)]',
            // Reduced motion: only border shifts, no translate
            'motion-reduce:hover:translate-y-0',
          ],
          className,
        )}
        {...props}
      >
        {children}
      </div>
    )
  },
)

Card.displayName = 'Card'

interface CardSectionProps extends React.HTMLAttributes<HTMLDivElement> {}

const CardHeader = forwardRef<HTMLDivElement, CardSectionProps>(
  ({ className, children, ...props }, ref) => (
    <div ref={ref} className={cnm('mb-4', className)} {...props}>
      {children}
    </div>
  ),
)
CardHeader.displayName = 'Card.Header'

const CardBody = forwardRef<HTMLDivElement, CardSectionProps>(
  ({ className, children, ...props }, ref) => (
    <div ref={ref} className={cnm('flex-1', className)} {...props}>
      {children}
    </div>
  ),
)
CardBody.displayName = 'Card.Body'

const CardFooter = forwardRef<HTMLDivElement, CardSectionProps>(
  ({ className, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cnm(
        'mt-4 pt-4 border-t border-[var(--color-border)] flex items-center justify-between gap-3',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  ),
)
CardFooter.displayName = 'Card.Footer'

// Attach compound components
const CardCompound = Object.assign(Card, {
  Header: CardHeader,
  Body: CardBody,
  Footer: CardFooter,
})

export { CardCompound as Card }
export type { CardProps }
