import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { HeroUIProvider } from '@heroui/react'
import type { QueryClient } from '@tanstack/react-query'

import ErrorPage from '@/components/ErrorPage'
import Footer from '@/components/layout/Footer'
import PillNavbar from '@/components/nav/PillNavbar'
import TanStackQueryDevtools from '@/integrations/tanstack-query/devtools'
import { env } from '@/env'
import { QueryProvider } from '@/lib/api/query'
import { GsapProvider } from '@/lib/motion/gsap'
import { LenisProvider } from '@/lib/motion/lenis'
import appCss from '@/styles.css?url'

interface MyRouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  errorComponent: ({ error, reset }) => (
    <ErrorPage error={error} reset={reset} />
  ),
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'theme-color', content: '#FAF8F5' },
      { title: env.VITE_APP_TITLE },
      {
        name: 'description',
        content:
          'Discord-native pull-bragging bot for Renaiss collectors. Every pack opening becomes a permanent share card.',
      },
      { property: 'og:site_name', content: 'PullCast' },
      { property: 'og:type', content: 'website' },
      { name: 'twitter:card', content: 'summary_large_image' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/assets/logo-index.svg' },
      { rel: 'icon', href: '/favicon.ico', sizes: 'any' },
      { rel: 'apple-touch-icon', href: '/assets/logo-index.svg' },
    ],
  }),

  shellComponent: RootDocument,
})

function RootDocument(_props: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="bg-[var(--color-bg)] text-[var(--color-ink)] font-sans antialiased">
        <QueryProvider>
          <HeroUIProvider>
            <LenisProvider>
              <GsapProvider>
                <PillNavbar />
                <main id="main" className="min-h-screen pt-24 pb-32">
                  <Outlet />
                </main>
                <Footer />
                <TanStackDevtools
                  config={{ position: 'bottom-right' }}
                  plugins={[
                    {
                      name: 'Tanstack Router',
                      render: <TanStackRouterDevtoolsPanel />,
                    },
                    TanStackQueryDevtools,
                  ]}
                />
              </GsapProvider>
            </LenisProvider>
          </HeroUIProvider>
        </QueryProvider>
        <Scripts />
      </body>
    </html>
  )
}
