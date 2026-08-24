import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Http } from '@cordisjs/plugin-http'
import type { Context } from 'cordis'
import z from 'schemastery'
import type { NormalizedAuthor, NormalizedResource, ResourceAdapter } from '@lfvs/core'

const API_MAX_BATCH_SIZE = 50
const CHECKPOINT_UPDATER = 'adapter-youtube-video'
const PACIFIC_TIME_ZONE = 'America/Los_Angeles'

export interface Config {
  endpoint?: string
  proxyAgent?: string
  keyFile?: string
  apiKeys?: string[]
  maxBatchSize?: number
  requestTimeoutMs?: number
  maxTransientRetries?: number
}

export const Config = z.object({
  endpoint: z.string().default('https://www.googleapis.com/youtube/v3').description('YouTube Data API v3 基础地址。'),
  proxyAgent: z.string().default('').description('可选的 HTTP 或 SOCKS 代理地址；SOCKS 代理需要加载 @cordisjs/plugin-http-socks。'),
  keyFile: z.string().default('./data/youtube-api-keys.txt').description('每行一个 YouTube Data API Key 的本地文件路径；默认位于 data 目录且不会被提交到 Git。'),
  apiKeys: z.array(z.string()).default([]).role('secret').description('额外的 YouTube Data API Key；与 keyFile 中的 Key 合并后自动轮询。'),
  maxBatchSize: z.natural().default(API_MAX_BATCH_SIZE).description('单次 videos.list 请求的视频 ID 数量；YouTube Data API v3 的上限为 50。'),
  requestTimeoutMs: z.natural().default(30000).role('ms').description('单次 YouTube Data API 请求的超时时间。'),
  maxTransientRetries: z.natural().default(3).description('遇到 429 或 5xx 临时错误时，换用其他 Key 重试的最大次数。'),
})

interface YouTubeHttpClient {
  get<T = unknown>(url: string, config?: { timeout?: number; proxyAgent?: string }): Promise<T>
}

interface YouTubeThumbnail {
  url?: string
}

interface YouTubeVideo {
  id?: string
  snippet?: {
    title?: string
    description?: string
    publishedAt?: string
    channelId?: string
    channelTitle?: string
    categoryId?: string
    liveBroadcastContent?: string
    thumbnails?: Record<string, YouTubeThumbnail | undefined>
  }
  contentDetails?: {
    duration?: string
    dimension?: string
    definition?: string
    caption?: string
    licensedContent?: boolean
  }
  statistics?: {
    viewCount?: string
    likeCount?: string
    commentCount?: string
  }
  status?: {
    privacyStatus?: string
    embeddable?: boolean
    madeForKids?: boolean
  }
}

interface YouTubeChannel {
  id?: string
  snippet?: {
    title?: string
    description?: string
    customUrl?: string
    publishedAt?: string
    thumbnails?: Record<string, YouTubeThumbnail | undefined>
  }
  statistics?: {
    subscriberCount?: string
    hiddenSubscriberCount?: boolean
  }
}

interface YouTubeListResponse<T> {
  items?: T[]
}

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive integer`)
  return result
}

function keyDigest(key: string) {
  return createHash('sha256').update(key).digest('hex')
}

function extractKeys(value: string) {
  return [...value.matchAll(/AIza[0-9A-Za-z_-]{20,}/g)].map((match) => match[0])
}

function parseBigInt(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  return BigInt(value)
}

function parseDate(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const result = Date.parse(value)
  return Number.isFinite(result) ? result : null
}

function parseDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value)
  if (!match) return null
  const days = Number(match[1] ?? 0)
  const hours = Number(match[2] ?? 0)
  const minutes = Number(match[3] ?? 0)
  const seconds = Number(match[4] ?? 0)
  const result = days * 86400 + hours * 3600 + minutes * 60 + seconds
  return Number.isFinite(result) && result >= 0 ? Math.floor(result) : null
}

function selectThumbnail(thumbnails: Record<string, YouTubeThumbnail | undefined> | undefined) {
  for (const key of ['maxres', 'standard', 'high', 'medium', 'default']) {
    const url = thumbnails?.[key]?.url
    if (typeof url === 'string' && url) return url
  }
  return null
}

function pacificParts(timestamp: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp))
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  return { year: value('year'), month: value('month'), day: value('day') }
}

function pacificOffsetMinutes(timestamp: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TIME_ZONE,
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(timestamp))
  const value = parts.find((part) => part.type === 'timeZoneName')?.value ?? ''
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(value)
  if (!match) throw new Error(`unable to resolve Pacific UTC offset: ${value}`)
  const offset = Number(match[2]) * 60 + Number(match[3] ?? 0)
  return match[1] === '+' ? offset : -offset
}

function nextPacificMidnight(now: number) {
  const current = pacificParts(now)
  const tomorrow = new Date(Date.UTC(current.year, current.month - 1, current.day + 1))
  const wallTime = Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate())
  return wallTime - pacificOffsetMinutes(wallTime) * 60_000
}

function responseStatus(error: any) {
  return Number(error?.response?.status)
}

function responseReason(error: any) {
  const data = error?.response?.data
  return data?.error?.errors?.[0]?.reason ?? data?.error?.status ?? ''
}

function isKeyFailure(status: number, reason: string) {
  return status === 403 && [
    'quotaExceeded',
    'dailyLimitExceeded',
    'accessNotConfigured',
    'keyInvalid',
    'API_KEY_INVALID',
    'ipRefererBlocked',
    'forbidden',
  ].includes(reason)
}

function normalizeVideo(video: YouTubeVideo, capturedAt: number): NormalizedResource | null {
  if (typeof video.id !== 'string' || !video.id || typeof video.snippet?.title !== 'string') return null
  const snippet = video.snippet
  const details = video.contentDetails
  const status = video.status
  const channelId = typeof snippet.channelId === 'string' && snippet.channelId ? snippet.channelId : undefined
  const publishedAt = parseDate(snippet.publishedAt)
  const duration = parseDuration(details?.duration)
  const relatedAuthors: NormalizedAuthor[] = []
  if (channelId && typeof snippet.channelTitle === 'string') {
    relatedAuthors.push({
      core: {
        platform: 'youtube',
        id: channelId,
        name: snippet.channelTitle,
        fetchedAt: capturedAt,
        completeness: 'partial',
      },
    })
  }
  return {
    core: {
      platform: 'youtube',
      kind: 'video',
      id: video.id,
      title: snippet.title,
      coverUrl: selectThumbnail(snippet.thumbnails),
      description: snippet.description ?? null,
      ...(publishedAt === null ? {} : { publishTime: publishedAt }),
      ...(duration === null ? {} : { duration }),
      ...(channelId ? {
        authors: [{ id: channelId, isPrimary: true, sortOrder: 0, role: 'uploader' }],
        authorsMode: 'snapshot',
      } : {}),
      fetchedAt: capturedAt,
      completeness: 'full',
    },
    history: {
      capturedAt,
      playCount: parseBigInt(video.statistics?.viewCount),
      likeCount: parseBigInt(video.statistics?.likeCount),
      commentCount: parseBigInt(video.statistics?.commentCount),
      shareCount: null,
      favoriteCount: null,
    },
    ...(relatedAuthors.length ? { relatedAuthors } : {}),
    extension: {
      resources: {
        youtubeChannelId: channelId ?? null,
        youtubeCategoryId: snippet.categoryId ?? null,
        youtubePrivacyStatus: status?.privacyStatus ?? null,
        youtubeMadeForKids: status?.madeForKids ?? null,
        youtubeEmbeddable: status?.embeddable ?? null,
        youtubeLicensedContent: details?.licensedContent ?? null,
        youtubeLiveBroadcastContent: snippet.liveBroadcastContent ?? null,
      },
    },
  }
}

function normalizeChannel(channel: YouTubeChannel, fetchedAt: number): NormalizedAuthor | null {
  if (typeof channel.id !== 'string' || !channel.id || typeof channel.snippet?.title !== 'string') return null
  const snippet = channel.snippet
  const publishedAt = parseDate(snippet.publishedAt)
  return {
    core: {
      platform: 'youtube',
      id: channel.id,
      name: snippet.title,
      avatarUrl: selectThumbnail(snippet.thumbnails),
      description: snippet.description ?? null,
      fetchedAt,
      completeness: 'full',
    },
    extension: {
      youtubeCustomUrl: snippet.customUrl ?? null,
      youtubePublishedAt: publishedAt === null ? null : new Date(publishedAt),
      youtubeSubscriberCount: parseBigInt(channel.statistics?.subscriberCount),
      youtubeHiddenSubscriberCount: channel.statistics?.hiddenSubscriberCount ?? null,
    },
  }
}

export class YouTubeVideoAdapter implements ResourceAdapter {
  readonly platform = 'youtube'
  readonly kind = 'video'
  readonly capabilities
  private readonly endpoint: string
  private readonly proxyAgent?: string
  private readonly keys: string[]
  private readonly maxBatchSize: number
  private readonly requestTimeoutMs: number
  private readonly maxTransientRetries: number
  private readonly cooldowns = new Map<string, number>()
  private cooldownsLoaded?: Promise<void>
  private resetTimer?: NodeJS.Timeout
  private nextKeyIndex = 0

  constructor(
    private readonly ctx: Context,
    private readonly http: YouTubeHttpClient,
    config: Partial<Config> = {},
  ) {
    this.endpoint = (config.endpoint?.trim() || 'https://www.googleapis.com/youtube/v3').replace(/\/+$/, '')
    this.proxyAgent = config.proxyAgent?.trim() || undefined
    this.maxBatchSize = positiveInteger(config.maxBatchSize, API_MAX_BATCH_SIZE, 'maxBatchSize')
    if (this.maxBatchSize > API_MAX_BATCH_SIZE) throw new RangeError(`maxBatchSize must not exceed YouTube API limit ${API_MAX_BATCH_SIZE}`)
    this.requestTimeoutMs = positiveInteger(config.requestTimeoutMs, 30000, 'requestTimeoutMs')
    this.maxTransientRetries = positiveInteger(config.maxTransientRetries, 3, 'maxTransientRetries')
    const fileKeys = config.keyFile === '' ? [] : extractKeys(readFileSync(resolve(config.keyFile ?? './data/youtube-api-keys.txt'), 'utf8'))
    this.keys = [...new Set([...fileKeys, ...(config.apiKeys ?? []).flatMap(extractKeys)])]
    if (!this.keys.length) throw new Error('no YouTube Data API keys are configured')
    this.capabilities = {
      resourceBatch: {
        supported: true,
        maxBatchSize: this.maxBatchSize,
        recommendedBatchSize: this.maxBatchSize,
      },
      authorBatch: {
        supported: true,
        maxBatchSize: this.maxBatchSize,
        recommendedBatchSize: this.maxBatchSize,
      },
      listAuthorResources: false,
    }
  }

  async getResource(input: { id: string }) {
    const resources = await this.getResources({ ids: [input.id] })
    return resources.find((resource) => resource.core.id === input.id) ?? null
  }

  async getResources(input: { ids: string[] }) {
    const ids = [...new Set(input.ids.map((id) => id.trim()).filter(Boolean))]
    const result: NormalizedResource[] = []
    for (let offset = 0; offset < ids.length; offset += this.maxBatchSize) {
      const batch = ids.slice(offset, offset + this.maxBatchSize)
      const response = await this.request<YouTubeListResponse<YouTubeVideo>>('videos', {
        part: 'snippet,contentDetails,statistics,status',
        id: batch.join(','),
      })
      const requested = new Set(batch)
      const capturedAt = Date.now()
      for (const item of response.items ?? []) {
        const resource = normalizeVideo(item, capturedAt)
        if (!resource) continue
        if (!requested.has(resource.core.id)) throw new Error(`YouTube response contains an unrequested video ID: ${resource.core.id}`)
        result.push(resource)
      }
    }
    return result
  }

  async getAuthor(input: { id: string }) {
    const authors = await this.getAuthors({ ids: [input.id] })
    return authors.find((author) => author.core.id === input.id) ?? null
  }

  async getAuthors(input: { ids: string[] }) {
    const ids = [...new Set(input.ids.map((id) => id.trim()).filter(Boolean))]
    const result: NormalizedAuthor[] = []
    for (let offset = 0; offset < ids.length; offset += this.maxBatchSize) {
      const batch = ids.slice(offset, offset + this.maxBatchSize)
      const response = await this.request<YouTubeListResponse<YouTubeChannel>>('channels', {
        part: 'snippet,statistics',
        id: batch.join(','),
      })
      const requested = new Set(batch)
      const fetchedAt = Date.now()
      for (const item of response.items ?? []) {
        const author = normalizeChannel(item, fetchedAt)
        if (!author) continue
        if (!requested.has(author.core.id)) throw new Error(`YouTube response contains an unrequested channel ID: ${author.core.id}`)
        result.push(author)
      }
    }
    return result
  }

  private async request<T>(path: string, params: Record<string, string>): Promise<T> {
    await this.loadCooldowns()
    const attempted = new Set<string>()
    let transientFailures = 0
    while (attempted.size < this.keys.length) {
      const key = await this.nextAvailableKey(attempted)
      if (!key) break
      attempted.add(key)
      const url = new URL(`${this.endpoint}/${path}`)
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
      url.searchParams.set('key', key)
      try {
        return await this.http.get<T>(url.toString(), {
          timeout: this.requestTimeoutMs,
          ...(this.proxyAgent ? { proxyAgent: this.proxyAgent } : {}),
        })
      } catch (error) {
        const status = responseStatus(error)
        const reason = responseReason(error)
        if (isKeyFailure(status, reason)) {
          await this.cooldownKey(key, reason || 'forbidden')
          continue
        }
        if (status === 429 || status >= 500) {
          transientFailures++
          if (transientFailures <= this.maxTransientRetries) continue
        }
        throw new Error(`YouTube Data API request failed: HTTP ${status || 'unknown'}${reason ? ` (${reason})` : ''}`)
      }
    }
    throw new Error('all configured YouTube Data API keys are cooling down or temporarily unavailable')
  }

  private async loadCooldowns() {
    if (this.cooldownsLoaded) return this.cooldownsLoaded
    this.cooldownsLoaded = (async () => {
      const now = Date.now()
      const checkpoints = await this.ctx.mediaSync.checkpointStore.list({
        updater: CHECKPOINT_UPDATER,
        platform: this.platform,
        kind: this.kind,
        scopeType: 'apiKey',
      })
      for (const checkpoint of checkpoints) {
        if (checkpoint.watermark && checkpoint.watermark > now) {
          this.cooldowns.set(checkpoint.scopeId, checkpoint.watermark)
        } else {
          await this.ctx.mediaSync.checkpointStore.remove(checkpoint)
        }
      }
      this.scheduleCooldownReset()
    })()
    return this.cooldownsLoaded
  }

  private async nextAvailableKey(attempted: Set<string>) {
    const now = Date.now()
    for (let offset = 0; offset < this.keys.length; offset++) {
      const index = (this.nextKeyIndex++ % this.keys.length)
      const key = this.keys[index]
      if (attempted.has(key)) continue
      const digest = keyDigest(key)
      const until = this.cooldowns.get(digest)
      if (!until || until <= now) {
        if (until) {
          this.cooldowns.delete(digest)
          await this.ctx.mediaSync.checkpointStore.remove({
            updater: CHECKPOINT_UPDATER,
            platform: this.platform,
            kind: this.kind,
            scopeType: 'apiKey',
            scopeId: digest,
          })
        }
        return key
      }
    }
  }

  private async cooldownKey(key: string, reason: string) {
    const digest = keyDigest(key)
    const until = nextPacificMidnight(Date.now())
    this.cooldowns.set(digest, until)
    await this.ctx.mediaSync.checkpointStore.set({
      updater: CHECKPOINT_UPDATER,
      platform: this.platform,
      kind: this.kind,
      scopeType: 'apiKey',
      scopeId: digest,
      watermark: until,
      extra: JSON.stringify({ reason }),
    })
    this.scheduleCooldownReset()
  }

  dispose() {
    if (this.resetTimer) clearTimeout(this.resetTimer)
    this.resetTimer = undefined
  }

  private scheduleCooldownReset() {
    if (this.resetTimer) clearTimeout(this.resetTimer)
    if (!this.cooldowns.size) {
      this.resetTimer = undefined
      return
    }
    const delay = Math.max(1, nextPacificMidnight(Date.now()) - Date.now())
    this.resetTimer = setTimeout(() => {
      this.resetTimer = undefined
      void this.clearExpiredCooldowns()
    }, delay)
    this.resetTimer.unref?.()
  }

  private async clearExpiredCooldowns() {
    const now = Date.now()
    for (const [digest, until] of this.cooldowns) {
      if (until > now) continue
      this.cooldowns.delete(digest)
      await this.ctx.mediaSync.checkpointStore.remove({
        updater: CHECKPOINT_UPDATER,
        platform: this.platform,
        kind: this.kind,
        scopeType: 'apiKey',
        scopeId: digest,
      })
    }
    this.scheduleCooldownReset()
  }
}

export const inject = ['mediaSync', 'http']

export function apply(ctx: Context, config: Config) {
  const adapter = new YouTubeVideoAdapter(ctx, ctx.http as unknown as Http, config)
  ctx.effect(() => {
    const unregister = ctx.mediaSync.registerAdapter(adapter)
    return () => {
      adapter.dispose()
      unregister()
    }
  }, 'youtube video adapter')
}

export default { apply, inject, Config }
