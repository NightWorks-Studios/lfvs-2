import type { Http } from '@cordisjs/plugin-http'
import type { Context } from 'cordis'
import z from 'schemastery'
import type { NormalizedResource, ResourceAdapter } from '@lfvs/core'

export interface Config {
  endpoint: string
  maxBatchSize?: number
  requestTimeoutMs?: number
}

export const Config = z.object({
  endpoint: z.string().required().description('bilibili-rs-gateway 批量视频详情接口：https://github.com/Roberta001/bilibili-rs-gateway'),
  maxBatchSize: z.natural().default(250).description('单次请求最多提交的 BVID 数量；超过时适配器会自动切片。'),
  requestTimeoutMs: z.natural().default(30000).role('ms').description('单次网关请求的超时时间。'),
})

export interface BilibiliHttpClient {
  post<T = unknown>(url: string, data?: unknown, config?: { timeout?: number }): Promise<T>
}

interface ViewData {
  aid?: number
  bvid?: string
  title?: string
  cover?: string | null
  desc?: string | null
  author_mid?: number | string | null
  up?: {
    mid?: number | string | null
    name?: string | null
    face?: string | null
  } | null
  duration?: number | null
  pubdate?: number | null
  page_count?: number | null
  pages?: Array<{ cid?: number | string | null; duration?: number | null }>
  copyright?: number | null
  stat?: {
    view?: number | null
    like?: number | null
    reply?: number | null
    share?: number | null
    fav?: number | null
    danmaku?: number | null
    coin?: number | null
  }
}

interface ViewItem {
  ok?: boolean
  input?: { bvid?: string }
  data?: ViewData | null
}

interface ViewBatchResponse {
  items?: ViewItem[]
}

const DEFAULT_CONFIG = {
  maxBatchSize: 250,
  requestTimeoutMs: 30000,
} as const

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive integer`)
  return result
}

function asFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asNullableNumber(value: unknown) {
  return value === null ? null : asFiniteNumber(value)
}

function asCid(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const result = Number(value)
    if (Number.isSafeInteger(result)) return result
  }
}

function normalize(data: ViewData, now: number): NormalizedResource | null {
  if (typeof data.bvid !== 'string' || !data.bvid || typeof data.title !== 'string') return null

  const authorId = data.author_mid === null || data.author_mid === undefined ? undefined : String(data.author_mid)
  const uploaderId = data.up?.mid === null || data.up?.mid === undefined ? authorId : String(data.up.mid)
  if (authorId && uploaderId && authorId !== uploaderId) {
    throw new Error(`Bilibili uploader MID mismatch: ${authorId} != ${uploaderId}`)
  }
  const publishedAt = asFiniteNumber(data.pubdate)
  const stats = data.stat ?? {}
  const pageCount = asNullableNumber(data.page_count) ?? (data.pages ? data.pages.length : undefined)
  const cids = data.pages?.flatMap((page) => {
    const cid = asCid(page.cid)
    return cid === undefined ? [] : [cid]
  })

  return {
    core: {
      platform: 'bilibili',
      kind: 'video',
      id: data.bvid,
      title: data.title,
      coverUrl: data.cover ?? null,
      description: data.desc ?? null,
      ...(publishedAt === undefined ? {} : { publishTime: publishedAt * 1000 }),
      duration: asNullableNumber(data.duration) ?? null,
      ...(uploaderId ? {
        authors: [{ id: uploaderId, isPrimary: true, sortOrder: 0, role: 'uploader' }],
        authorsMode: 'snapshot' as const,
      } : {}),
      fetchedAt: now,
      completeness: 'full',
    },
    history: {
      capturedAt: now,
      playCount: asNullableNumber(stats.view) ?? null,
      likeCount: asNullableNumber(stats.like) ?? null,
      commentCount: asNullableNumber(stats.reply) ?? null,
      shareCount: asNullableNumber(stats.share) ?? null,
      favoriteCount: asNullableNumber(stats.fav) ?? null,
    },
    ...(uploaderId && data.up ? {
      relatedAuthors: [{
        core: {
          platform: 'bilibili',
          id: uploaderId,
          ...(data.up.name !== undefined ? { name: data.up.name } : {}),
          ...(data.up.face !== undefined ? { avatarUrl: data.up.face } : {}),
          fetchedAt: now,
          completeness: 'partial',
        },
      }],
    } : {}),
    extension: {
      resources: {
        bilibiliAid: asNullableNumber(data.aid) ?? null,
        bilibiliCids: cids ?? null,
        bilibiliCopyright: asNullableNumber(data.copyright) ?? null,
        bilibiliPageCount: pageCount ?? null,
      },
      resourceHistories: {
        bilibiliDanmakuCount: asNullableNumber(stats.danmaku) ?? null,
        bilibiliCoinCount: asNullableNumber(stats.coin) ?? null,
      },
    },
  }
}

export class BilibiliVideoAdapter implements ResourceAdapter {
  readonly platform = 'bilibili'
  readonly kind = 'video'
  readonly capabilities
  private readonly endpoint: string
  private readonly maxBatchSize: number
  private readonly requestTimeoutMs: number

  constructor(private readonly http: BilibiliHttpClient, config: Partial<Config> = {}) {
    if (!config.endpoint?.trim()) throw new TypeError('endpoint must be configured for bilibili-rs-gateway')
    this.endpoint = config.endpoint
    this.maxBatchSize = positiveInteger(config.maxBatchSize, DEFAULT_CONFIG.maxBatchSize, 'maxBatchSize')
    this.requestTimeoutMs = positiveInteger(config.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 'requestTimeoutMs')
    this.capabilities = {
      resourceBatch: {
        supported: true,
        maxBatchSize: this.maxBatchSize,
        recommendedBatchSize: this.maxBatchSize,
      },
      authorBatch: { supported: false },
      listAuthorResources: false,
    }
  }

  async getResource(input: { id: string }) {
    const resources = await this.getResources({ ids: [input.id] })
    return resources.find((resource) => resource.core.id === input.id) ?? null
  }

  async getResources(input: { ids: string[] }) {
    const ids = input.ids.map((id) => id.trim()).filter(Boolean)
    if (!ids.length) return []

    const result: NormalizedResource[] = []
    for (let offset = 0; offset < ids.length; offset += this.maxBatchSize) {
      const batch = ids.slice(offset, offset + this.maxBatchSize)
      const response = await this.http.post<ViewBatchResponse>(this.endpoint, { bvid: batch }, {
        timeout: this.requestTimeoutMs,
      })
      if (!response || !Array.isArray(response.items)) throw new Error('invalid Bilibili batch response')
      const now = Date.now()
      const requested = new Set(batch)
      for (const item of response.items) {
        if (item.ok === false || !item.data) continue
        const resource = normalize(item.data, now)
        if (!resource) continue
        const responseId = resource.core.id
        if (!requested.has(responseId) || item.input?.bvid && item.input.bvid !== responseId) {
          throw new Error(`Bilibili response BVID case mismatch: ${item.input?.bvid ?? responseId} -> ${responseId}`)
        }
        result.push(resource)
      }
    }
    return result
  }

  async getAuthor() {
    return null
  }
}

export const inject = ['mediaSync', 'http']

export function apply(ctx: Context, config: Config) {
  const adapter = new BilibiliVideoAdapter(ctx.http as unknown as Http, config)
  ctx.effect(() => ctx.mediaSync.registerAdapter(adapter), 'bilibili video adapter')
}

export default { apply, inject, Config }
