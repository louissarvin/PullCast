import { createContext, useContext, useEffect, useRef } from 'react'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import type { ReactNode } from 'react'

const GsapContext = createContext<typeof gsap | null>(null)

export function useGsap() {
  return useContext(GsapContext)
}

export function GsapProvider({ children }: { children: ReactNode }) {
  const registered = useRef(false)

  useEffect(() => {
    if (registered.current) return
    gsap.registerPlugin(ScrollTrigger)
    registered.current = true

    return () => {
      ScrollTrigger.getAll().forEach((t) => t.kill())
    }
  }, [])

  return <GsapContext.Provider value={gsap}>{children}</GsapContext.Provider>
}
