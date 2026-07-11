import { useEffect, useId } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { X } from 'lucide-react'
import { cnm } from '@/utils/style'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  description?: string
  children: React.ReactNode
  className?: string
  /** Max width of the modal panel. Defaults to 'sm:max-w-[520px]' */
  maxWidth?: string
}

// DESIGN.md §3.3: spring stiffness 260, damping 26
const MODAL_SPRING = { type: 'spring' as const, stiffness: 260, damping: 26 }
const SCRIM_TRANSITION = { duration: 0.2 }

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
  maxWidth = 'sm:max-w-[520px]',
}: ModalProps) {
  const titleId = useId()
  const descId = useId()
  const prefersReduced = useReducedMotion()

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
          {/* Scrim — DESIGN.md §4.8: rgba(23,20,18,0.45), no blur */}
          <motion.div
            key="modal-scrim"
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
            key="modal-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-describedby={description ? descId : undefined}
            initial={
              prefersReduced
                ? { opacity: 0 }
                : { opacity: 0, scale: 0.96, y: 8 }
            }
            animate={
              prefersReduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }
            }
            exit={
              prefersReduced
                ? { opacity: 0 }
                : { opacity: 0, scale: 0.96, y: 8 }
            }
            transition={prefersReduced ? { duration: 0 } : MODAL_SPRING}
            className={cnm(
              'fixed inset-0 z-[61] flex items-center justify-center p-4 pointer-events-none',
            )}
          >
            <div
              className={cnm(
                'relative w-full pointer-events-auto',
                'bg-[var(--color-surface)] border border-[var(--color-border)]',
                'rounded-[var(--radius-xl)] p-8',
                maxWidth,
                className,
              )}
            >
              {/* Header */}
              {(title || description) && (
                <div className="mb-6 pr-8">
                  {title && (
                    <h2
                      id={titleId}
                      className="text-[var(--color-ink)] text-lg font-semibold leading-tight"
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
                aria-label="Close dialog"
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

              {/* Content */}
              {children}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
