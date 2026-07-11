/**
 * Returns true if the user has requested reduced motion via OS settings.
 * Evaluated synchronously — safe to call at module level or in render.
 * Framer Motion also exports useReducedMotion from 'motion/react' for
 * reactive component use. This hook is for imperative GSAP checks.
 */
export function useReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
