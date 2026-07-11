import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { AlertTriangle, Check, Info, X } from 'lucide-react'
import { cnm } from '@/utils/style'

type ToastVariant = 'default' | 'success' | 'warn' | 'error'

interface ToastItem {
  id: string
  message: string
  variant: ToastVariant
  duration: number
}

interface ToastContextValue {
  toast: (
    message: string,
    options?: { variant?: ToastVariant; duration?: number },
  ) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

function useToastContext() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <Toaster>')
  return ctx
}

export function useToast() {
  return useToastContext()
}

const ICONS: Record<ToastVariant, React.ReactNode> = {
  default: <Info size={14} aria-hidden="true" />,
  success: <Check size={14} aria-hidden="true" />,
  warn: <AlertTriangle size={14} aria-hidden="true" />,
  error: <X size={14} aria-hidden="true" />,
}

const TOAST_SPRING = { type: 'spring' as const, stiffness: 300, damping: 30 }

interface SingleToastProps {
  item: ToastItem
  onDismiss: (id: string) => void
}

function SingleToast({ item, onDismiss }: SingleToastProps) {
  const prefersReduced = useReducedMotion()
  const toastId = useId()

  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), item.duration)
    return () => clearTimeout(timer)
  }, [item.id, item.duration, onDismiss])

  const isAlert = item.variant === 'error' || item.variant === 'warn'

  return (
    <motion.div
      key={item.id}
      layout
      initial={prefersReduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
      animate={prefersReduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
      exit={prefersReduced ? { opacity: 0 } : { opacity: 0, y: 16 }}
      transition={prefersReduced ? { duration: 0.1 } : TOAST_SPRING}
      role={isAlert ? 'alert' : 'status'}
      aria-live={isAlert ? 'assertive' : 'polite'}
      aria-atomic="true"
      aria-labelledby={toastId}
    >
      {/* DESIGN.md §4.9: bg-ink text-bg pill h-44px px-20px */}
      <div
        className={cnm(
          'flex items-center gap-2 h-11 px-5 rounded-[var(--radius-pill)]',
          'bg-[var(--color-ink)] text-[var(--color-bg)]',
          'text-sm font-medium select-none',
        )}
      >
        <span className="flex-shrink-0 opacity-80">{ICONS[item.variant]}</span>
        <span id={toastId}>{item.message}</span>
        <button
          type="button"
          onClick={() => onDismiss(item.id)}
          aria-label="Dismiss notification"
          className={cnm(
            'ml-1 -mr-1 flex-shrink-0 w-5 h-5 flex items-center justify-center',
            'rounded-[var(--radius-pill)] opacity-60',
            'hover:opacity-100 transition-opacity duration-150',
            'focus-visible:outline-2 focus-visible:outline-[var(--color-bg)] focus-visible:outline-offset-2 focus-visible:outline',
          )}
        >
          <X size={12} />
        </button>
      </div>
    </motion.div>
  )
}

/**
 * Mount once in your app root (e.g., __root.tsx).
 * Children can call useToast() to trigger toasts.
 */
export function Toaster({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Array<ToastItem>>([])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback(
    (
      message: string,
      options?: { variant?: ToastVariant; duration?: number },
    ) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      setToasts((prev) => {
        // Cap at 3 visible toasts — remove oldest if needed
        const next = prev.length >= 3 ? prev.slice(1) : prev
        return [
          ...next,
          {
            id,
            message,
            variant: options?.variant ?? 'default',
            duration: options?.duration ?? 4000,
          },
        ]
      })
    },
    [],
  )

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}

      {/* Toast container — DESIGN.md §4.9: fixed bottom-right desktop, bottom-center mobile */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className={cnm(
          'fixed z-[70] flex flex-col gap-2 pointer-events-none',
          // Desktop: bottom-right
          'right-6 bottom-6',
          // Mobile: bottom-center
          'max-sm:right-auto max-sm:left-1/2 max-sm:-translate-x-1/2 max-sm:items-center',
        )}
      >
        <AnimatePresence mode="popLayout">
          {toasts.map((item) => (
            <div key={item.id} className="pointer-events-auto">
              <SingleToast item={item} onDismiss={dismiss} />
            </div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}
