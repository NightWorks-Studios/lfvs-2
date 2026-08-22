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
  cron: z.string().default('0 * * * *').description('视频全量更新的 CRON 表达式；默认每小时整点执行一次。'),
  batchSize: z.natural().default(250).description('每次调用适配器时提交的 BVID 数量；不会超过适配器声明的最大批量。'),
  concurrency: z.natural().default(4).description('同时执行的适配器批量请求数量。'),
  runImmediately: z.boolean().default(true).description('插件启动后是否立即执行一次全量更新，而不等待首次 CRON 触发。'),
})

const DEFAULT_CONFIG = {
  cron: '0 * * * *',
  batchSize: 250,
  concurrency: 4,
} as const

const UPDATER_ID = 'updater-bilibili-video'

const fields = {
  resources: {
    bilibiliAid: { type: 'bigint', nullable: true, indexed: true },
    bilibiliCids: { type: 'json', nullable: true },
    bilibiliCopyright: { type: 'integer', nullable: true },
    bilibiliPageCount: { type: 'integer', nullable: true },
  },
  resourceHistories: {
    bilibiliDanmakuCount: { type: 'bigint', nullable: true },
    bilibiliCoinCount: { type: 'bigint', nullable: true },
  },
} as const

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive integer`)
  return result
}

export class BilibiliVideoUpdater extends Service {
  private readonly cronExpression: string
  private readonly batchSize: number
  private readonly concurrency: number
  private readonly runImmediately: boolean

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'bilibiliVideoUpdater')
    this.cronExpression = config.cron?.trim() || DEFAULT_CONFIG.cron
    this.batchSize = positiveInteger(config.batchSize, DEFAULT_CONFIG.batchSize, 'batchSize')
    this.concurrency = positiveInteger(config.concurrency, DEFAULT_CONFIG.concurrency, 'concurrency')
    this.runImmediately = config.runImmediately ?? true
  }

  async [Service.init]() {
    await this.ctx.effect(() => this.ctx.mediaSync.registerUpdaterFields({
      owner: UPDATER_ID,
      platform: 'bilibili',
      kind: 'video',
      fields,
    }), 'Bilibili video updater fields')
    this.ctx.effect(() => this.ctx.mediaSync.registerUpdater({
      id: UPDATER_ID,
      label: 'Bilibili 视频更新器',
      platform: 'bilibili',
      kind: 'video',
      cron: this.cronExpression,
      manualTrigger: true,
      run: () => this.execute(),
    }), 'Bilibili video updater')
    this.ctx.cron(this.cronExpression, async () => {
      await this.ctx.mediaSync.runUpdater(UPDATER_ID, 'schedule')
    }, { protect: true })
    if (this.runImmediately) void this.ctx.mediaSync.runUpdater(UPDATER_ID, 'startup').catch(() => {})
  }

  async runOnce() {
    const adapter = this.ctx.mediaSync.adapterRegistry.get('bilibili', 'video')
    if (!adapter) throw new Error('Bilibili video adapter is not registered')
    if (!adapter.getResources || !adapter.capabilities.resourceBatch?.supported) {
      throw new Error('Bilibili video adapter does not support resource batches')
    }

    const targets = await this.ctx.mediaSync.syncQuery.listResourcesForSync({
      platform: 'bilibili',
      kind: 'video',
    })
    const maxBatchSize = adapter.capabilities.resourceBatch.maxBatchSize
    const batchSize = Math.min(this.batchSize, maxBatchSize ?? this.batchSize)
    const batches = []
    for (let offset = 0; offset < targets.length; offset += batchSize) {
      batches.push(targets.slice(offset, offset + batchSize).map((target) => target.id))
    }

    let nextBatch = 0
    let updated = 0
    const logger = this.ctx.logger('updater-bilibili-video')
    const worker = async () => {
      while (nextBatch < batches.length) {
        const batchIndex = nextBatch++
        const batch = batches[batchIndex]
        const resources = await adapter.getResources!({ ids: batch })
        let batchUpdated = 0
        for (const resource of resources) {
          await this.ctx.mediaSync.resourceStore.saveResource(resource)
          updated++
          batchUpdated++
        }
        logger.info(
          'Bilibili 视频更新批次 %d/%d 完成：请求 %d 个，写入 %d 个，累计写入 %d 个',
          batchIndex + 1,
          batches.length,
          batch.length,
          batchUpdated,
          updated,
        )
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(batches.length, 1)) }, worker))
    return { targets: targets.length, batches: batches.length, updated }
  }

  private async execute() {
    const logger = this.ctx.logger('updater-bilibili-video')
    const startedAt = Date.now()
    logger.info('开始更新 Bilibili 视频')
    try {
      const result = await this.runOnce()
      logger.info('Bilibili 视频更新完成：目标 %d 个，批次 %d 个，写入 %d 个，耗时 %d ms', result.targets, result.batches, result.updated, Date.now() - startedAt)
      return result
    } catch (error) {
      logger.error(error)
      throw error
    }
  }
}

export const inject = ['mediaSync', 'cron']

export function apply(ctx: Context, config: Config) {
  const updater = new BilibiliVideoUpdater(ctx, config)
  return updater[Service.init]()
}

export default { apply, inject, Config }
