import { Service, type Context } from 'cordis'
import type { Database } from '@cordisjs/plugin-database'
import type { TimerService } from '@cordisjs/plugin-timer'
import z from 'schemastery'
import type { MediaSync } from '@lfvs/core'

export interface Config {
  intervalMs?: number
  batchSize?: number
  concurrency?: number
  runImmediately?: boolean
}

export const Config = z.object({
  intervalMs: z.natural().default(60 * 60 * 1000).role('ms'),
  batchSize: z.natural().default(250),
  concurrency: z.natural().default(4),
  runImmediately: z.boolean().default(true),
})

const DEFAULT_CONFIG = {
  intervalMs: 60 * 60 * 1000,
  batchSize: 250,
  concurrency: 4,
} as const

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
  private readonly intervalMs: number
  private readonly batchSize: number
  private readonly concurrency: number
  private readonly runImmediately: boolean
  private running = false

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'bilibiliVideoUpdater')
    this.intervalMs = positiveInteger(config.intervalMs, DEFAULT_CONFIG.intervalMs, 'intervalMs')
    this.batchSize = positiveInteger(config.batchSize, DEFAULT_CONFIG.batchSize, 'batchSize')
    this.concurrency = positiveInteger(config.concurrency, DEFAULT_CONFIG.concurrency, 'concurrency')
    this.runImmediately = config.runImmediately ?? true
  }

  async [Service.init]() {
    await this.ctx.mediaSync.registerUpdaterFields('updater-bilibili-video', fields)
    await (this.ctx.database as Database).prepared()
    this.ctx.interval(() => void this.trigger(), this.intervalMs)
    if (this.runImmediately) void this.trigger()
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
    const worker = async () => {
      while (nextBatch < batches.length) {
        const batch = batches[nextBatch++]
        const resources = await adapter.getResources!({ ids: batch })
        for (const resource of resources) {
          await this.ctx.mediaSync.resourceStore.saveResource(resource)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(batches.length, 1)) }, worker))
  }

  private async trigger() {
    if (this.running) return
    this.running = true
    try {
      await this.runOnce()
    } catch (error) {
      this.ctx.logger('updater-bilibili-video').error(error)
    } finally {
      this.running = false
    }
  }
}

export const inject = ['mediaSync', 'database', 'timer']

export function apply(ctx: Context, config: Config) {
  const updater = new BilibiliVideoUpdater(ctx, config)
  return updater[Service.init]()
}

export default { apply, inject, Config }
