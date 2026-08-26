import { Service, type Context } from 'cordis'
import type { Cron } from 'cordis-plugin-cron'
import z from 'schemastery'
import type { MediaSync } from '@lfvs/core'

export interface Config {
  cron?: string
  batchSize?: number
  concurrency?: number
  runImmediately?: boolean
}

export const Config = z.object({
  cron: z.string().default('0 * * * *').description('YouTube 视频全量更新的 CRON 表达式；默认每小时整点执行一次。'),
  batchSize: z.natural().default(50).description('每次调用适配器时提交的视频 ID 数量；不会超过 YouTube 适配器声明的最大批量。'),
  concurrency: z.natural().default(2).description('同时执行的适配器批量请求数量；请求会自动在可用 API Key 间轮询。'),
  runImmediately: z.boolean().default(false).description('插件启动后是否立即执行一次全量更新；默认关闭，仅等待 CRON 触发。'),
})

const DEFAULT_CONFIG = {
  cron: '0 * * * *',
  batchSize: 50,
  concurrency: 2,
  runImmediately: false,
} as const

const UPDATER_ID = 'updater-youtube-video'
const CHECKPOINT_KEY = {
  updater: UPDATER_ID,
  platform: 'youtube',
  kind: 'video',
  scopeType: 'fullSync',
  scopeId: 'resources',
} as const

const fields = {
  authors: {
    youtubeCustomUrl: { type: 'string', nullable: true },
    youtubePublishedAt: { type: 'timestamp', nullable: true },
    youtubeSubscriberCount: { type: 'bigint', nullable: true },
    youtubeHiddenSubscriberCount: { type: 'boolean', nullable: true },
  },
  resources: {
    youtubeChannelId: { type: 'string', nullable: true, indexed: true },
    youtubeCategoryId: { type: 'string', nullable: true },
    youtubePrivacyStatus: { type: 'string', nullable: true },
    youtubeMadeForKids: { type: 'boolean', nullable: true },
    youtubeEmbeddable: { type: 'boolean', nullable: true },
    youtubeLicensedContent: { type: 'boolean', nullable: true },
    youtubeLiveBroadcastContent: { type: 'string', nullable: true },
  },
} as const

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive integer`)
  return result
}

export class YouTubeVideoUpdater extends Service {
  private readonly cronExpression: string
  private readonly batchSize: number
  private readonly concurrency: number
  private readonly runImmediately: boolean

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'youtubeVideoUpdater')
    this.cronExpression = config.cron?.trim() || DEFAULT_CONFIG.cron
    this.batchSize = positiveInteger(config.batchSize, DEFAULT_CONFIG.batchSize, 'batchSize')
    this.concurrency = positiveInteger(config.concurrency, DEFAULT_CONFIG.concurrency, 'concurrency')
    this.runImmediately = config.runImmediately ?? DEFAULT_CONFIG.runImmediately
  }

  async [Service.init]() {
    await this.ctx.effect(() => this.ctx.mediaSync.registerUpdaterFields({
      owner: UPDATER_ID,
      platform: 'youtube',
      kind: 'video',
      fields,
    }), 'YouTube video updater fields')
    this.ctx.effect(() => this.ctx.mediaSync.registerUpdater({
      id: UPDATER_ID,
      label: 'YouTube 视频更新器',
      platform: 'youtube',
      kind: 'video',
      cron: this.cronExpression,
      manualTrigger: true,
      run: () => this.execute(),
    }), 'YouTube video updater')
    this.ctx.cron(this.cronExpression, async () => {
      await this.ctx.mediaSync.runUpdater(UPDATER_ID, 'schedule')
    }, { protect: true })
    const checkpoint = await this.ctx.mediaSync.checkpointStore.get(CHECKPOINT_KEY)
    if (checkpoint || this.runImmediately) void this.ctx.mediaSync.runUpdater(UPDATER_ID, 'startup').catch(() => {})
  }

  async runOnce() {
    const adapter = this.ctx.mediaSync.adapterRegistry.get('youtube', 'video')
    if (!adapter) throw new Error('YouTube video adapter is not registered')
    if (!adapter.getResources || !adapter.capabilities.resourceBatch?.supported) {
      throw new Error('YouTube video adapter does not support resource batches')
    }
    const checkpoint = await this.ctx.mediaSync.checkpointStore.get(CHECKPOINT_KEY)
    const afterPk = checkpoint?.page ?? 0
    const targets = await this.ctx.mediaSync.syncQuery.listResourcesForSync({
      platform: 'youtube',
      kind: 'video',
      afterPk,
    })
    const maxBatchSize = adapter.capabilities.resourceBatch.maxBatchSize
    const batchSize = Math.min(this.batchSize, maxBatchSize ?? this.batchSize)
    const batches: typeof targets[] = []
    for (let offset = 0; offset < targets.length; offset += batchSize) {
      batches.push(targets.slice(offset, offset + batchSize))
    }

    let updated = 0
    let authorsUpdated = 0
    let missing = 0
    const logger = this.ctx.logger('updater-youtube-video')
    if (checkpoint) logger.info('恢复 YouTube 视频更新：从资源 pk %d 后继续，共剩余 %d 个目标', afterPk, targets.length)
    for (let offset = 0; offset < batches.length; offset += this.concurrency) {
      const window = batches.slice(offset, offset + this.concurrency)
      const results = await Promise.all(window.map((batch) => adapter.getResources!({ ids: batch.map((target) => target.id) })))
      for (let index = 0; index < window.length; index++) {
        const batchIndex = offset + index
        const batch = window[index]
        const resources = results[index]
        for (const resource of resources) {
          await this.ctx.mediaSync.resourceStore.saveResource(resource)
          updated++
        }
        let batchAuthorsUpdated = 0
        if (adapter.getAuthors && adapter.capabilities.authorBatch?.supported) {
          const authorIds = [...new Set(resources.flatMap((resource) => resource.core.authors?.map((author) => author.id) ?? []))]
          const authors = authorIds.length ? await adapter.getAuthors({ ids: authorIds }) : []
          for (const author of authors) {
            await this.ctx.mediaSync.resourceStore.saveAuthor(author)
            authorsUpdated++
            batchAuthorsUpdated++
          }
        }
        const batchMissing = batch.length - resources.length
        missing += batchMissing
        logger.info(
          'YouTube 视频更新批次 %d/%d 完成：请求 %d 个，写入视频 %d 个，刷新作者 %d 个，未返回 %d 个，累计写入视频 %d 个',
          batchIndex + 1,
          batches.length,
          batch.length,
          resources.length,
          batchAuthorsUpdated,
          batchMissing,
          updated,
        )
        await this.ctx.mediaSync.checkpointStore.set({
          ...CHECKPOINT_KEY,
          page: batch.at(-1)!.pk,
        })
      }
    }
    await this.ctx.mediaSync.checkpointStore.remove(CHECKPOINT_KEY)
    return { targets: targets.length, batches: batches.length, updated, authorsUpdated, missing }
  }

  private async execute() {
    const logger = this.ctx.logger('updater-youtube-video')
    const startedAt = Date.now()
    logger.info('开始更新 YouTube 视频')
    try {
      const result = await this.runOnce()
      logger.info(
        'YouTube 视频更新完成：目标 %d 个，批次 %d 个，写入视频 %d 个，刷新作者 %d 个，未返回 %d 个，耗时 %d ms',
        result.targets,
        result.batches,
        result.updated,
        result.authorsUpdated,
        result.missing,
        Date.now() - startedAt,
      )
      return result
    } catch (error) {
      logger.error(error)
      throw error
    }
  }
}

export const inject = ['mediaSync', 'cron']

export function apply(ctx: Context, config: Config) {
  const updater = new YouTubeVideoUpdater(ctx, config)
  return updater[Service.init]()
}

export default { apply, inject, Config }
