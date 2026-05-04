export const RATE_LIMITS = {
  API: {
    perUserPerMinute: 60,
    perIPPerMinute: 120,
  },
  PACK_PURCHASE: {
    perUserPerMinute: 3,
    perUserPerHour: 10,
    perUserPerDay: 20,
    perIPPerMinute: 10,
    perIPPerHour: 30,
  },
  AUTH: {
    perIPPerMinute: 5,
    perIPPerHour: 20,
  },
  MARKETPLACE: {
    perUserPerHour: 20,
    perIPPerHour: 40,
  },
} as const;

export const FAIRNESS_CONFIG = {
  inventoryThreshold: 0.20,
  fairnessWindowSeconds: 30,
  maxProcessingTimeSeconds: 10,
} as const;

export const BOT_DETECTION = {
  minHumanRequestInterval: 200,
  maxBotTimingVariance: 50,
  maxAccountsPerIP: 5,
  minAccountAgeSeconds: 3600,
  botScoreThreshold: 0.7,
  suspiciousActivityThreshold: 3,
  suspiciousUserAgents: [
    'bot', 'crawler', 'spider', 'scraper',
    'curl', 'wget', 'python-requests',
    'go-http-client', 'java',
  ],
} as const;

export const ACCOUNT_LIMITS = {
  maxPacksPerDrop: 5,
  maxPacksPerHour: 10,
  maxPacksPerDay: 20,
  minAccountAgeSeconds: 3600,
} as const;

export type RateLimitType = keyof typeof RATE_LIMITS;
export type BotScore = number;
export type FairnessStatus = 'NORMAL' | 'FAIRNESS_MODE' | 'PROCESSING';
