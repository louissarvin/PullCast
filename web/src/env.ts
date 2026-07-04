import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const env = createEnv({
  clientPrefix: 'VITE_',

  client: {
    VITE_API_URL: z.string().url().optional().default('http://localhost:3700'),
    VITE_APP_TITLE: z
      .string()
      .min(1)
      .optional()
      .default('PullCast — Pull, Brag, Repeat'),
    VITE_APP_URL: z.string().url().optional().default('http://localhost:3200'),
  },

  runtimeEnv: import.meta.env,
  emptyStringAsUndefined: true,
})
