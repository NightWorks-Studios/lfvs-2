export type ReplayConsumeResult = 'accepted' | 'replayed' | 'full'

export class ReplayCache {
  private readonly used = new Map<string, number>()

  constructor(private readonly maxSize: number) {}

  consume(id: string, expiresAt: number, now = Date.now()): ReplayConsumeResult {
    const previous = this.used.get(id)
    if (previous !== undefined && previous > now) return 'replayed'
    if (previous !== undefined) this.used.delete(id)
    if (this.used.size >= this.maxSize) this.sweep(now)
    if (this.used.size >= this.maxSize) return 'full'
    this.used.set(id, expiresAt)
    return 'accepted'
  }

  sweep(now = Date.now()) {
    for (const [id, expiresAt] of this.used) {
      if (expiresAt <= now) this.used.delete(id)
    }
  }

  get size() {
    return this.used.size
  }
}

export class CooldownCache {
  private readonly entries = new Map<string, number>()

  constructor(private readonly maxSize: number) {}

  get(key: string, now = Date.now()) {
    const expiresAt = this.entries.get(key)
    if (expiresAt === undefined || expiresAt <= now) {
      if (expiresAt !== undefined) this.entries.delete(key)
      return undefined
    }
    return expiresAt
  }

  canAccept(now = Date.now()) {
    if (this.entries.size >= this.maxSize) this.sweep(now)
    return this.entries.size < this.maxSize
  }

  activate(key: string, expiresAt: number) {
    if (this.entries.has(key) || this.entries.size >= this.maxSize) return false
    this.entries.set(key, expiresAt)
    return true
  }

  sweep(now = Date.now()) {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key)
    }
  }

  get size() {
    return this.entries.size
  }
}

interface Bucket {
  tokens: number
  updatedAt: number
  lastSeenAt: number
}

export class ChallengeRateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly refillPerSecond: number,
    private readonly burst: number,
    private readonly maxClients: number,
  ) {}

  take(key: string, now = Date.now()) {
    let bucket = this.buckets.get(key)
    if (!bucket) {
      if (this.buckets.size >= this.maxClients) this.sweep(now)
      if (this.buckets.size >= this.maxClients) return false
      bucket = { tokens: this.burst, updatedAt: now, lastSeenAt: now }
      this.buckets.set(key, bucket)
    }
    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000
    bucket.tokens = Math.min(this.burst, bucket.tokens + elapsedSeconds * this.refillPerSecond)
    bucket.updatedAt = now
    bucket.lastSeenAt = now
    if (bucket.tokens < 1) return false
    bucket.tokens--
    return true
  }

  sweep(now = Date.now()) {
    const idleMs = Math.max(60_000, this.burst / this.refillPerSecond * 2000)
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastSeenAt >= idleMs) this.buckets.delete(key)
    }
  }

  get size() {
    return this.buckets.size
  }
}
