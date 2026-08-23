import { randomBytes, randomUUID } from 'node:crypto'
import type { Request, Response } from '@cordisjs/plugin-server'
import { Service, type Context } from 'cordis'
import { match } from 'path-to-regexp-typed'
import z from 'schemastery'
import { ChallengeRateLimiter, CooldownCache, ReplayCache } from './cache.js'
import {
  addressBinding,
  hmacBase64Url,
  parseAndVerifyChallenge,
  randomId,
  requestAddress,
  requestHash,
  signChallenge,
  verifyWork,
  type ChallengePayload,
  type IpBinding,
  type PowProfile,
} from './crypto.js'

export * from './cache.js'
export * from './crypto.js'

const defaultLightPaths = [
  '/targets',
  '/targets/:platform/:kind/schema',
]

const defaultNormalPaths = [
  '/targets/:platform/:kind/resources',
  '/targets/:platform/:kind/resources/batch',
  '/targets/:platform/:kind/resources/:id/history',
  '/targets/:platform/:kind/resources/:id',
  '/targets/:platform/:kind/authors',
  '/targets/:platform/:kind/authors/:id/resources',
  '/targets/:platform/:kind/authors/:id',
]

const defaultBulkPaths = [
  '/targets/:platform/:kind/resources/snapshot',
]

export interface Config {
  enabled?: boolean
  basePath?: string
  lightPaths?: string[]
  normalPaths?: string[]
  bulkPaths?: string[]
  corsOrigins?: string[]
  secret?: string
  challengeTtlMs?: number
  clockSkewMs?: number
  ipBinding?: IpBinding
  trustProxy?: boolean
  ipv4Prefix?: number
  ipv6Prefix?: number
  replayCacheSize?: number
  clientCacheSize?: number
  cleanupIntervalMs?: number
  challengeRatePerSecond?: number
  challengeBurst?: number
  lightDifficulty?: number
  normalDifficulty?: number
  bulkDifficulty?: number
  bulkConcurrency?: number
  bulkCooldownMs?: number
  bulkClientCacheSize?: number
}

export const Config = z.object({
  enabled: z.boolean().default(true).description('是否启用 PoW 验证；关闭后已注册的路径会直接放行。'),
  basePath: z.string().default('/api/v1').description('受保护路由的基础路径；下面的路径均相对此路径配置。'),
  lightPaths: z.array(z.string()).default(defaultLightPaths).description('使用 light 难度的相对路由；语法与 Cordis server 路由一致。'),
  normalPaths: z.array(z.string()).default(defaultNormalPaths).description('使用 normal 难度的相对路由；语法与 Cordis server 路由一致。'),
  bulkPaths: z.array(z.string()).default(defaultBulkPaths).description('使用 bulk 难度和并发限制的相对路由；语法与 Cordis server 路由一致。'),
  corsOrigins: z.array(z.string()).default(['*']).description('PoW 错误响应允许的跨域来源，应与受保护 API 的 CORS 配置一致。'),
  secret: z.string().default('').role('secret').description('Challenge HMAC 密钥；留空会在每次启动时随机生成。生产环境建议至少 32 字节。'),
  challengeTtlMs: z.natural().default(60000).role('ms').description('Challenge 有效时间。'),
  clockSkewMs: z.natural().default(5000).role('ms').description('验证签发时间时允许的时钟偏差。'),
  ipBinding: z.union(['exact', 'prefix', 'none']).default('exact').description('Challenge 与客户端地址的绑定方式。'),
  trustProxy: z.boolean().default(false).description('是否信任 X-Forwarded-For；只应在服务仅能通过可信反向代理访问时开启。'),
  ipv4Prefix: z.natural().default(24).description('prefix 模式使用的 IPv4 前缀长度。'),
  ipv6Prefix: z.natural().default(56).description('prefix 模式使用的 IPv6 前缀长度。'),
  replayCacheSize: z.natural().default(100000).description('已消费 Challenge 内存缓存的最大条目数。'),
  clientCacheSize: z.natural().default(10000).description('Challenge 签发限速缓存的最大客户端数量。'),
  cleanupIntervalMs: z.natural().default(30000).role('ms').description('过期缓存清理周期。'),
  challengeRatePerSecond: z.number().default(2).description('每个客户端每秒恢复的 Challenge 签发额度。'),
  challengeBurst: z.natural().default(10).description('每个客户端允许的 Challenge 突发数量。'),
  lightDifficulty: z.natural().default(18).description('light 路由要求的 SHA-256 前导零位数。'),
  normalDifficulty: z.natural().default(20).description('normal 路由要求的 SHA-256 前导零位数。'),
  bulkDifficulty: z.natural().default(22).description('bulk 路由要求的 SHA-256 前导零位数。'),
  bulkConcurrency: z.natural().default(1).description('通过 PoW 后允许同时执行的 bulk 请求数量。'),
  bulkCooldownMs: z.natural().default(300000).role('ms').description('同一客户端的 bulk PoW 验证通过后的最短间隔。'),
  bulkClientCacheSize: z.natural().default(10000).description('bulk 客户端冷却缓存的最大条目数。'),
})

export const name = 'lfvs-http-pow'
export const inject = ['server']

declare module 'cordis' {
  interface Context {
    httpPow: HttpPow
  }
}

interface NormalizedConfig {
  enabled: boolean
  basePath: string
  lightPaths: string[]
  normalPaths: string[]
  bulkPaths: string[]
  corsOrigins: string[]
  challengeTtlMs: number
  clockSkewMs: number
  ipBinding: IpBinding
  trustProxy: boolean
  ipv4Prefix: number
  ipv6Prefix: number
  cleanupIntervalMs: number
  lightDifficulty: number
  normalDifficulty: number
  bulkDifficulty: number
  bulkConcurrency: number
  bulkCooldownMs: number
}

export interface HttpPowStatus {
  enabled: boolean
  bootId: string
  replayCacheSize: number
  clientCacheSize: number
  bulkCooldownSize: number
  activeBulkRequests: number
  difficulties: Record<PowProfile, number>
}

interface ProtectedPath {
  profile: PowProfile
  path: string
  matches: ReturnType<typeof match>
}

export class HttpPow extends Service {
  private readonly config: NormalizedConfig
  private readonly secret: Buffer
  private readonly bootId = randomId()
  private readonly replayCache: ReplayCache
  private readonly challengeLimiter: ChallengeRateLimiter
  private readonly bulkCooldown: CooldownCache
  private readonly protectedPaths: ProtectedPath[]
  private activeBulkRequests = 0

  constructor(ctx: Context, input: Config = {}) {
    super(ctx, 'httpPow')
    this.config = normalizeConfig(input)
    this.secret = input.secret ? Buffer.from(input.secret) : randomBytes(32)
    if (!input.secret) ctx.logger('lfvs-http-pow').warn('未配置 secret，已生成仅在本次进程内有效的随机 PoW 密钥')
    if (input.secret && this.secret.length < 32) throw new TypeError('secret must contain at least 32 bytes')
    this.replayCache = new ReplayCache(positive(input.replayCacheSize, 100000, 'replayCacheSize'))
    this.challengeLimiter = new ChallengeRateLimiter(
      positiveNumber(input.challengeRatePerSecond, 2, 'challengeRatePerSecond'),
      positive(input.challengeBurst, 10, 'challengeBurst'),
      positive(input.clientCacheSize, 10000, 'clientCacheSize'),
    )
    this.bulkCooldown = new CooldownCache(positive(input.bulkClientCacheSize, 10000, 'bulkClientCacheSize'))

    const routes: Array<[PowProfile, string[]]> = [
      ['bulk', this.config.bulkPaths],
      ['light', this.config.lightPaths],
      ['normal', this.config.normalPaths],
    ]
    const registered = new Set<string>()
    this.protectedPaths = []
    for (const [profile, paths] of routes) {
      for (const path of paths) {
        const routePath = joinRoutePath(this.config.basePath, path)
        if (registered.has(routePath)) throw new TypeError(`duplicate PoW route: ${routePath}`)
        registered.add(routePath)
        this.protectedPaths.push({ profile, path: routePath, matches: match(routePath) })
      }
    }
    ctx.server.use(async (req, res, next) => {
      const protectedPath = this.protectedPaths.find((route) => route.matches(req.path))
      if (!protectedPath) return next()
      await this.handle(req, res, protectedPath.profile, next)
    })
    const timer = setInterval(() => {
      this.replayCache.sweep()
      this.challengeLimiter.sweep()
      this.bulkCooldown.sweep()
    }, this.config.cleanupIntervalMs)
    timer.unref()
    ctx.effect(() => () => clearInterval(timer), 'lfvs http pow cache cleanup')
  }

  status(): HttpPowStatus {
    return {
      enabled: this.config.enabled,
      bootId: this.bootId,
      replayCacheSize: this.replayCache.size,
      clientCacheSize: this.challengeLimiter.size,
      bulkCooldownSize: this.bulkCooldown.size,
      activeBulkRequests: this.activeBulkRequests,
      difficulties: {
        light: this.config.lightDifficulty,
        normal: this.config.normalDifficulty,
        bulk: this.config.bulkDifficulty,
      },
    }
  }

  private async handle(
    req: Request,
    res: Response,
    profile: PowProfile,
    next: () => Promise<globalThis.Response | void>,
  ) {
    if (!this.config.enabled || req.method === 'OPTIONS') return next()
    const difficulty = this.difficulty(profile)
    const address = requestAddress(req, this.config.trustProxy)
    const binding = addressBinding(
      address,
      this.config.ipBinding,
      this.config.ipv4Prefix,
      this.config.ipv6Prefix,
    )
    const clientHash = hmacBase64Url(this.secret, `client:${binding}`)
    const challenge = req.headers.get('x-lfvs-pow-challenge')
    const nonce = req.headers.get('x-lfvs-pow-nonce')
    if (!challenge && !nonce) return this.requireProof(req, res, profile, difficulty, clientHash, address)
    if (!challenge || !nonce) return this.error(req, res, 400, 'POW_MALFORMED', 'both PoW headers are required')

    const payload = parseAndVerifyChallenge(this.secret, challenge)
    if (!payload || !validPayload(payload)) return this.error(req, res, 403, 'POW_INVALID', 'challenge signature or payload is invalid')
    const now = Date.now()
    if (payload.expiresAt < now) return this.error(req, res, 410, 'POW_EXPIRED', 'challenge has expired')
    if (payload.issuedAt > now + this.config.clockSkewMs
      || payload.expiresAt <= payload.issuedAt
      || payload.expiresAt - payload.issuedAt > this.config.challengeTtlMs + this.config.clockSkewMs) {
      return this.error(req, res, 403, 'POW_INVALID', 'challenge time window is invalid')
    }
    if (payload.bootId !== this.bootId
      || payload.method !== req.method.toUpperCase()
      || payload.requestHash !== requestHash(req)
      || payload.clientHash !== clientHash
      || payload.profile !== profile
      || payload.difficulty !== difficulty) {
      return this.error(req, res, 403, 'POW_INVALID', 'challenge does not match this request')
    }
    if (!verifyWork(challenge, nonce, difficulty)) {
      return this.error(req, res, 403, 'POW_INVALID', 'proof of work does not satisfy the required difficulty')
    }
    if (profile === 'bulk') {
      const retryAt = this.bulkCooldown.get(clientHash, now)
      if (retryAt !== undefined) {
        res.headers.set('retry-after', String(Math.max(1, Math.ceil((retryAt - now) / 1000))))
        return this.error(req, res, 429, 'POW_BULK_COOLDOWN', 'bulk requests are temporarily limited for this client')
      }
      if (!this.bulkCooldown.canAccept(now)) {
        return this.error(req, res, 503, 'POW_BULK_CACHE_FULL', 'bulk client cooldown cache is full')
      }
      if (this.activeBulkRequests >= this.config.bulkConcurrency) {
        res.headers.set('retry-after', '1')
        return this.error(req, res, 503, 'POW_CAPACITY_EXCEEDED', 'bulk request capacity is currently exhausted')
      }
    }
    const consumed = this.replayCache.consume(payload.id, payload.expiresAt, now)
    if (consumed === 'replayed') return this.error(req, res, 409, 'POW_REPLAYED', 'challenge has already been used')
    if (consumed === 'full') return this.error(req, res, 503, 'POW_CACHE_FULL', 'proof replay cache is full')

    if (profile === 'bulk') {
      // There is no async boundary since canAccept(), so this cannot race another request.
      if (!this.bulkCooldown.activate(clientHash, now + this.config.bulkCooldownMs)) {
        return this.error(req, res, 503, 'POW_BULK_CACHE_FULL', 'bulk client cooldown cache is full')
      }
      this.activeBulkRequests++
    }
    try {
      return await next()
    } finally {
      if (profile === 'bulk') this.activeBulkRequests--
    }
  }

  private requireProof(
    req: Request,
    res: Response,
    profile: PowProfile,
    difficulty: number,
    clientHash: string,
    address: string,
  ) {
    this.applyCors(req, res)
    const rateKey = hmacBase64Url(this.secret, `rate:${address}`)
    if (!this.challengeLimiter.take(rateKey)) {
      res.headers.set('retry-after', '1')
      return this.error(req, res, 429, 'POW_RATE_LIMITED', 'challenge issuance rate limit exceeded')
    }
    const now = Date.now()
    const payload: ChallengePayload = {
      version: 1,
      id: randomId(),
      bootId: this.bootId,
      issuedAt: now,
      expiresAt: now + this.config.challengeTtlMs,
      method: req.method.toUpperCase(),
      requestHash: requestHash(req),
      clientHash,
      difficulty,
      profile,
    }
    const challenge = signChallenge(this.secret, payload)
    res.status = 428
    res.headers.set('www-authenticate', 'LFVS-PoW')
    res.headers.set('cache-control', 'no-store')
    res.json({
      error: {
        code: 'POW_REQUIRED',
        message: 'proof of work is required',
        requestId: requestId(req, res),
      },
      pow: {
        algorithm: 'sha256',
        challenge,
        difficulty,
        expiresAt: new Date(payload.expiresAt).toISOString(),
      },
    })
  }

  private error(req: Request, res: Response, status: number, code: string, message: string) {
    this.applyCors(req, res)
    res.status = status
    res.headers.set('cache-control', 'no-store')
    res.json({ error: { code, message, requestId: requestId(req, res) } })
  }

  private difficulty(profile: PowProfile) {
    if (profile === 'light') return this.config.lightDifficulty
    if (profile === 'bulk') return this.config.bulkDifficulty
    return this.config.normalDifficulty
  }

  private applyCors(req: Request, res: Response) {
    const origin = req.headers.get('origin')
    if (!origin) return
    if (this.config.corsOrigins.includes('*')) {
      res.headers.set('access-control-allow-origin', '*')
    } else if (this.config.corsOrigins.includes(origin)) {
      res.headers.set('access-control-allow-origin', origin)
      res.headers.append('vary', 'Origin')
    }
  }
}

function requestId(req: Request, res: Response) {
  const value = req.headers.get('x-request-id')?.slice(0, 128) || randomUUID()
  res.headers.set('x-request-id', value)
  return value
}

function validPayload(value: ChallengePayload) {
  return value.version === 1
    && typeof value.id === 'string' && /^[A-Za-z0-9_-]{20,32}$/.test(value.id)
    && typeof value.bootId === 'string'
    && Number.isSafeInteger(value.issuedAt)
    && Number.isSafeInteger(value.expiresAt)
    && typeof value.method === 'string'
    && typeof value.requestHash === 'string'
    && typeof value.clientHash === 'string'
    && Number.isSafeInteger(value.difficulty)
    && (value.profile === 'light' || value.profile === 'normal' || value.profile === 'bulk')
}

function normalizeConfig(input: Config): NormalizedConfig {
  const config: NormalizedConfig = {
    enabled: input.enabled ?? true,
    basePath: normalizeBasePath(input.basePath),
    lightPaths: normalizePaths(input.lightPaths, defaultLightPaths, 'lightPaths'),
    normalPaths: normalizePaths(input.normalPaths, defaultNormalPaths, 'normalPaths'),
    bulkPaths: normalizePaths(input.bulkPaths, defaultBulkPaths, 'bulkPaths'),
    corsOrigins: input.corsOrigins?.map((origin) => origin.trim()).filter(Boolean) ?? ['*'],
    challengeTtlMs: positive(input.challengeTtlMs, 60000, 'challengeTtlMs'),
    clockSkewMs: nonNegative(input.clockSkewMs, 5000, 'clockSkewMs'),
    ipBinding: input.ipBinding ?? 'exact',
    trustProxy: input.trustProxy ?? false,
    ipv4Prefix: nonNegative(input.ipv4Prefix, 24, 'ipv4Prefix'),
    ipv6Prefix: nonNegative(input.ipv6Prefix, 56, 'ipv6Prefix'),
    cleanupIntervalMs: positive(input.cleanupIntervalMs, 30000, 'cleanupIntervalMs'),
    lightDifficulty: nonNegative(input.lightDifficulty, 18, 'lightDifficulty'),
    normalDifficulty: nonNegative(input.normalDifficulty, 20, 'normalDifficulty'),
    bulkDifficulty: nonNegative(input.bulkDifficulty, 22, 'bulkDifficulty'),
    bulkConcurrency: positive(input.bulkConcurrency, 1, 'bulkConcurrency'),
    bulkCooldownMs: positive(input.bulkCooldownMs, 300000, 'bulkCooldownMs'),
  }
  if (config.ipv4Prefix > 32) throw new TypeError('ipv4Prefix must not exceed 32')
  if (config.ipv6Prefix > 128) throw new TypeError('ipv6Prefix must not exceed 128')
  validateDifficulty(config.lightDifficulty, 'lightDifficulty')
  validateDifficulty(config.normalDifficulty, 'normalDifficulty')
  validateDifficulty(config.bulkDifficulty, 'bulkDifficulty')
  return config
}

function normalizeBasePath(value: string | undefined) {
  const path = value?.trim() || '/api/v1'
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new TypeError('basePath must be an absolute URL path')
  }
  return path === '/' ? '' : path.replace(/\/+$/, '')
}

function normalizePaths(value: string[] | undefined, fallback: string[], name: string) {
  const paths = value ?? fallback
  for (const path of paths) {
    if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
      throw new TypeError(`${name} must contain relative route paths beginning with /`)
    }
  }
  return [...new Set(paths)]
}

function joinRoutePath(basePath: string, path: string) {
  return `${basePath}${path}` || '/'
}

function validateDifficulty(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 30) throw new TypeError(`${name} must be between 0 and 30`)
}

function positive(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive integer`)
  return result
}

function positiveNumber(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isFinite(result) || result <= 0) throw new TypeError(`${name} must be a positive number`)
  return result
}

function nonNegative(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError(`${name} must be a non-negative integer`)
  return result
}

export function apply(ctx: Context, config: Config) {
  return new HttpPow(ctx, config)
}

export default { apply, inject, Config }
