import { useEffect, useId } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { X } from 'lucide-react'
import { cnm } from '@/utils/style'

interface DrawerProps {
  open: boolean
  onClose: () => void
  title?: string
  description?: string
  children: React.ReactNode
  className?: string
  /**
   * 'bottom' — slides up from bottom (default, mobile-first).
   * 'right' — slides in from right (desktop side panel).
   */
  side?: 'bottom' | 'right'
}

// DESIGN.md §3.3: spring stiffness 300, damping 34
const DRAWER_SPRING = { type: 'spring' as const, stiffness: 300, damping: 34 }
const SCRIM_TRANSITION = { duration: 0.2 }

const sideVariants = {
  bottom: {
    initial: { y: '100%' },
    animate: { y: 0 },
    exit: { y: '100%' },
    className:
      'fixed bottom-0 left-0 right-0 max-h-[90dvh] rounded-t-[var(--radius-xl)] overflow-y-auto',
  },
  right: {
    initial: { x: '100%' },
    animate: { x: 0 },
    exit: { x: '100%' },
    className:
      'fixed top-0 right-0 bottom-0 w-full max-w-[400px] overflow-y-auto',
  },
} as const

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  className,
  side = 'bottom',
}: DrawerProps) {
  const titleId = useId()
  const descId = useId()
  const prefersReduced = useReducedMotion()
  const config = sideVariants[side]

  // Keyboard: Escape closes
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Lock body scroll while open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Scrim */}
          <motion.div
            key="drawer-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={SCRIM_TRANSITION}
            className="fixed inset-0 z-[60] bg-[rgba(23,20,18,0.45)]"
            aria-hidden="true"
            onClick={onClose}
          />

          {/* Panel */}
          <motion.div
            key="drawer-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-describedby={description ? descId : undefined}
            initial={prefersReduced ? { opacity: 0 } : config.initial}
            animate={prefersReduced ? { opacity: 1 } : config.animate}
            exit={prefersReduced ? { opacity: 0 } : config.exit}
            transition={prefersReduced ? { duration: 0 } : DRAWER_SPRING}
            className={cnm(
              'z-[61]',
              'bg-[var(--color-surface)] border border-[var(--color-border)]',
              config.className,
              className,
            )}
          >
            {/* Handle — bottom drawer only */}
            {side === 'bottom' && (
              <div className="flex justify-center pt-3 pb-1" aria-hidden="true">
                <div className="w-10 h-1 rounded-[var(--radius-pill)] bg-[var(--color-border-strong)]" />
              </div>
            )}

            {/* Header */}
            <div className="p-6 pb-4">
              {(title || description) && (
                <div className="mb-4 pr-8">
                  {title && (
                    <h2
                      id={titleId}
                      className="text-[var(--color-ink)] text-lg font-semibold"
                    >
                      {title}
                    </h2>
                  )}
                  {description && (
                    <p
                      id={descId}
                      className="mt-1 text-[var(--color-ink-muted)] text-sm"
                    >
                      {description}
                    </p>
                  )}
                </div>
              )}

              {/* Close button */}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className={cnm(
                  'absolute top-5 right-5 w-8 h-8 flex items-center justify-center',
                  'rounded-[var(--radius-pill)] text-[var(--color-ink-muted)]',
                  'hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)]',
                  'transition-colors duration-200',
                  'focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-[3px] focus-visible:outline',
                )}
              >
                <X size={16} />
              </button>
            </div>

            {/* Content */}
            <div className="px-6 pb-8">{children}</div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
