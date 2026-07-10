interface AppConfig {
  appName: string
  appDescription: string
  links: {
    discord: string
    github: string
    twitter: string
    backend: string
  }
  contracts: Record<string, never>
}

export const config: AppConfig = {
  appName: 'PullCast',
  appDescription: 'Discord-native pull-bragging bot for Renaiss collectors.',

  links: {
    discord: 'https://discord.com/oauth2/authorize?client_id=pullcast',
    github: 'https://github.com/pullcast-xyz/pullcast',
    twitter: 'https://x.com/pullcastxyz',
    backend: 'https://api.pullcast.xyz',
  },

  contracts: {},
}

export type Config = AppConfig

