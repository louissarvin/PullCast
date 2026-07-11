import { useEffect, useRef, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ChevronDown, Menu, X } from 'lucide-react'
import { config } from '@/config'
import { cnm } from '@/utils/style'

type NavTo = '/' | '/market' | '/browse' | '/packs' | '/featured' | '/trades' | '/search' | '/price' | '/stats' | '/ecosystem'

type DropdownItem = { label: string; href: NavTo; exact: boolean; desc: string }
type NavEntry =
  | { kind: 'link'; label: string; href: NavTo; exact: boolean }
  | { kind: 'dropdown'; key: string; label: string; items: Array<DropdownItem> }

const NAV_ENTRIES: Array<NavEntry> = [
  { kind: 'link', label: 'Home', href: '/', exact: true },
  {
    kind: 'dropdown',
    key: 'discover',
    label: 'Discover',
    items: [
      { label: 'Market', href: '/market', exact: false, desc: 'Category tiles by 24h volume' },
      { label: 'Trades', href: '/trades', exact: false, desc: 'Live cross-market sales feed' },
      { label: 'Featured', href: '/featured', exact: false, desc: 'Top-mover cards right now' },
      { label: 'Browse', href: '/browse', exact: false, desc: 'Vault marketplace listings' },
    ],
  },
  {
    kind: 'dropdown',
    key: 'lookup',
    label: 'Lookup',
    items: [
      { label: 'Card Lens', href: '/price', exact: false, desc: 'Cert bridge and FMV lookup' },
      { label: 'Search', href: '/search', exact: false, desc: 'Free-text card search' },
    ],
  },
  { kind: 'link', label: 'Packs', href: '/packs', exact: false },
  {
    kind: 'dropdown',
    key: 'data',
    label: 'Data',
    items: [
      { label: 'Stats', href: '/stats', exact: false, desc: 'Adoption metrics (live)' },
      { label: 'Ecosystem', href: '/ecosystem', exact: false, desc: 'Renaiss integration map' },
    ],
  },
]


function useActiveRoute() {
  const routerState = useRouterState()
  const pathname = routerState.location.pathname

  return (href: string, exact: boolean): boolean => {
    if (exact) return pathname === href
    return pathname === href || pathname.startsWith(href + '/')
  }
}

function useScrolled() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return scrolled
}

// The pill spring config — DESIGN.md §3.3
const PILL_SPRING = { type: 'spring' as const, stiffness: 380, damping: 32 }

export default function PillNavbar() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [openDropdown, setOpenDropdown] = useState<string | null>(null)
  const dropdownContainerRef = useRef<HTMLDivElement>(null)
  const isActive = useActiveRoute()
  const scrolled = useScrolled()
  const prefersReduced = useReducedMotion()

  // Close drawer + dropdown on route change
  const routerState = useRouterState()
  useEffect(() => {
    setDrawerOpen(false)
    setOpenDropdown(null)
  }, [routerState.location.pathname])

  // Lock body scroll when drawer is open
  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [drawerOpen])

  // Close open dropdown on click outside + Escape
  useEffect(() => {
    if (!openDropdown) return
    const onClick = (e: MouseEvent) => {
      if (
        dropdownContainerRef.current &&
        !dropdownContainerRef.current.contains(e.target as Node)
      ) {
        setOpenDropdown(null)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenDropdown(null)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [openDropdown])

  const pillTransition = prefersReduced ? { duration: 0 } : PILL_SPRING

  return (
    <>
      {/* Skip link for keyboard nav */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-1/2 focus:-translate-x-1/2 focus:z-[100] focus:bg-[var(--color-surface)] focus:text-[var(--color-ink)] focus:px-4 focus:py-2 focus:rounded-[var(--radius-md)] focus:border focus:border-[var(--color-border-strong)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] focus:ring-offset-2 text-sm font-medium"
      >
        Skip to main content
      </a>

      <nav
        data-testid="pill-nav"
        aria-label="Primary"
        className="fixed top-4 sm:top-6 left-1/2 -translate-x-1/2 z-50 w-[92%] sm:w-auto"
      >
        <div
          className={cnm(
            'flex items-center gap-2 sm:gap-0 px-3 sm:pl-4 sm:pr-1.5 py-1.5 rounded-[var(--radius-pill)] border border-[var(--color-border-strong)] transition-colors duration-200 shadow-none',
            scrolled
              ? 'bg-[var(--color-surface)] backdrop-blur-xl'
              : 'bg-[var(--color-surface)]/95 backdrop-blur-xl',
          )}
        >
          {/* Logo */}
          <Link
            to="/"
            aria-label="PullCast home"
            className="flex-shrink-0 rounded-[var(--radius-sm)] focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3"
          >
            <img
              src="/assets/logo.svg"
              alt="PullCast"
              width={144}
              height={40}
              className="h-9 w-auto"
            />
          </Link>

          {/* Desktop: divider + nav links + divider + CTA */}
          <div className="hidden sm:flex items-center">
            {/* Divider */}
            <div
              className="w-px h-4 bg-[var(--color-border-strong)] mx-2.5 flex-shrink-0"
              aria-hidden="true"
            />

            {/* Nav entries — mix of links + grouped dropdowns */}
            <div ref={dropdownContainerRef} className="flex items-center" role="list">
              {NAV_ENTRIES.map((entry) => {
                if (entry.kind === 'link') {
                  const active = isActive(entry.href, entry.exact)
                  return (
                    <div key={entry.href} className="relative" role="listitem">
                      {active && (
                        <motion.div
                          layoutId="nav-active-pill"
                          data-layout-id="nav-active-pill"
                          className="absolute inset-0 rounded-[var(--radius-pill)] bg-[var(--color-accent-soft)]"
                          transition={pillTransition}
                          aria-hidden="true"
                        />
                      )}
                      <Link
                        to={entry.href}
                        aria-current={active ? 'page' : undefined}
                        className={cnm(
                          'relative z-10 block px-2.5 py-1.5 rounded-[var(--radius-pill)] text-[12.5px] font-medium whitespace-nowrap transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3 focus-visible:outline',
                          active
                            ? 'text-[var(--color-accent)]'
                            : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                        )}
                      >
                        {entry.label}
                      </Link>
                    </div>
                  )
                }

                // dropdown entry
                const groupActive = entry.items.some((item) => isActive(item.href, item.exact))
                const isOpen = openDropdown === entry.key
                return (
                  <div key={entry.key} className="relative" role="listitem">
                    <button
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={isOpen}
                      onClick={() => setOpenDropdown((cur) => (cur === entry.key ? null : entry.key))}
                      className={cnm(
                        'relative z-10 flex items-center gap-1 px-2.5 py-1.5 rounded-[var(--radius-pill)] text-[12.5px] font-medium whitespace-nowrap transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3 focus-visible:outline',
                        groupActive || isOpen
                          ? 'text-[var(--color-accent)] bg-[var(--color-accent-soft)]'
                          : 'text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]',
                      )}
                    >
                      {entry.label}
                      <ChevronDown
                        size={13}
                        aria-hidden="true"
                        className={cnm(
                          'transition-transform duration-200',
                          isOpen && 'rotate-180',
                        )}
                      />
                    </button>

                    <AnimatePresence>
                      {isOpen && (
                        <motion.div
                          role="menu"
                          initial={prefersReduced ? { opacity: 1 } : { opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={prefersReduced ? { opacity: 0 } : { opacity: 0, y: -4 }}
                          transition={{ duration: 0.15, ease: 'easeOut' }}
                          className="absolute left-0 top-full mt-2 w-64 rounded-[var(--radius-lg)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-1.5"
                        >
                          {entry.items.map((item) => {
                            const active = isActive(item.href, item.exact)
                            return (
                              <Link
                                key={item.href}
                                to={item.href}
                                role="menuitem"
                                onClick={() => setOpenDropdown(null)}
                                className={cnm(
                                  'block rounded-[var(--radius-md)] px-3 py-2 text-[13px] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-2 focus-visible:outline',
                                  active
                                    ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                                    : 'text-[var(--color-ink)] hover:bg-[var(--color-bg-alt)]',
                                )}
                              >
                                <div className="font-medium">{item.label}</div>
                                <div className="text-[11.5px] text-[var(--color-ink-muted)] mt-0.5">{item.desc}</div>
                              </Link>
                            )
                          })}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )
              })}
            </div>

            {/* CTA — sits flush inside the pill */}
            <a
              href={config.links.discord}
              rel="noopener noreferrer"
              target="_blank"
              className="flex-shrink-0 ml-1.5 rounded-[var(--radius-pill)] bg-[var(--color-accent)] text-[var(--color-accent-ink)] text-[12.5px] font-semibold px-3.5 py-1.5 transition-all duration-200 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3 focus-visible:outline"
            >
              Install Bot
            </a>
          </div>

          {/* Mobile: spacer + CTA + hamburger */}
          <div className="flex sm:hidden items-center gap-2 ml-auto">
            <a
              href={config.links.discord}
              rel="noopener noreferrer"
              target="_blank"
              className="rounded-[var(--radius-pill)] bg-[var(--color-accent)] text-[var(--color-accent-ink)] text-[13px] font-semibold px-4 py-1.5 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3 focus-visible:outline"
            >
              Install Bot
            </a>
            <button
              type="button"
              aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={drawerOpen}
              aria-controls="mobile-nav-drawer"
              onClick={() => setDrawerOpen((v) => !v)}
              className="w-9 h-9 flex items-center justify-center rounded-[var(--radius-md)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] hover:bg-[var(--color-accent-soft)] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3 focus-visible:outline"
            >
              {drawerOpen ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>
      </nav>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <motion.div
            id="mobile-nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            initial={prefersReduced ? { opacity: 0 } : { opacity: 0, y: -16 }}
            animate={prefersReduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={prefersReduced ? { opacity: 0 } : { opacity: 0, y: -16 }}
            transition={
              prefersReduced
                ? { duration: 0.1 }
                : { type: 'spring', stiffness: 320, damping: 30 }
            }
            className="fixed sm:hidden top-0 left-0 right-0 z-40 bg-[var(--color-surface)] border-b border-[var(--color-border)] rounded-b-[28px] pt-24 pb-6 px-5"
          >
            <nav aria-label="Mobile navigation">
              <ul className="flex flex-col gap-1" role="list">
                {NAV_ENTRIES.map((entry) => {
                  if (entry.kind === 'link') {
                    const active = isActive(entry.href, entry.exact)
                    return (
                      <li
                        key={entry.href}
                        className="relative"
                        role="listitem"
                      >
                        {active && (
                          <motion.div
                            layoutId="nav-active-pill-mobile"
                            className="absolute inset-0 rounded-[var(--radius-pill)] bg-[var(--color-accent-soft)]"
                            transition={pillTransition}
                            aria-hidden="true"
                          />
                        )}
                        <Link
                          to={entry.href}
                          aria-current={active ? 'page' : undefined}
                          className={cnm(
                            'relative z-10 flex items-center px-4 py-3 rounded-[var(--radius-pill)] text-[15px] font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3 focus-visible:outline',
                            active
                              ? 'text-[var(--color-accent)]'
                              : 'text-[var(--color-ink-muted)]',
                          )}
                        >
                          {entry.label}
                        </Link>
                      </li>
                    )
                  }
                  return (
                    <li key={entry.key} className="mt-2 first:mt-0" role="listitem">
                      <p className="px-4 pt-2 pb-1 text-[11px] uppercase tracking-wide text-[var(--color-ink-subtle)]">
                        {entry.label}
                      </p>
                      <ul className="flex flex-col gap-1" role="list">
                        {entry.items.map((sub) => {
                          const active = isActive(sub.href, sub.exact)
                          return (
                            <li
                              key={sub.href}
                              className="relative"
                              role="listitem"
                            >
                              {active && (
                                <motion.div
                                  layoutId="nav-active-pill-mobile"
                                  className="absolute inset-0 rounded-[var(--radius-pill)] bg-[var(--color-accent-soft)]"
                                  transition={pillTransition}
                                  aria-hidden="true"
                                />
                              )}
                              <Link
                                to={sub.href}
                                aria-current={active ? 'page' : undefined}
                                className={cnm(
                                  'relative z-10 flex items-center px-4 py-3 rounded-[var(--radius-pill)] text-[15px] font-medium transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-3 focus-visible:outline',
                                  active
                                    ? 'text-[var(--color-accent)]'
                                    : 'text-[var(--color-ink-muted)]',
                                )}
                              >
                                {sub.label}
                              </Link>
                            </li>
                          )
                        })}
                      </ul>
                    </li>
                  )
                })}
              </ul>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Backdrop for mobile drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed sm:hidden inset-0 z-30"
            aria-hidden="true"
            onClick={() => setDrawerOpen(false)}
          />
        )}
      </AnimatePresence>
    </>
  )
}

