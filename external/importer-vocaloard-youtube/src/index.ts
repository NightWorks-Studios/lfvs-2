import { createHash } from 'node:crypto'
import { load } from 'cheerio'
import type { Http } from '@cordisjs/plugin-http'
import type { WebUI } from '@cordisjs/plugin-webui'
import { Service, type Context } from 'cordis'
import type { Cron } from 'cordis-plugin-cron'
import z from 'schemastery'
import type { CheckpointKey, MediaSync } from '@lfvs/core'

declare module 'cordis' {
  interface Context {
    vocaloardYouTubeImporter: VocaloardYouTubeImporter
  }
}

export type SourceMode = 'daily' | 'new-original'

export interface Config {
  sourceBase?: string
  proxyAgent?: string
  cron?: string
  autoModes?: SourceMode[]
  sourceConcurrency?: number
  sourceRequestIntervalMs?: number
  adapterBatchSize?: number
  adapterConcurrency?: number
  runImmediately?: boolean
}

export const Config = z.object({
  sourceBase: z.string().default('https://vocaloard.injpok.tokyo/').description('Vocaloard 网站基础地址。'),
  proxyAgent: z.string().default('').description('Vocaloard 请求使用的 HTTP 或 SOCKS 代理地址；留空表示直连。'),
  cron: z.string().default('0 * * * *').description('检查最新 Vocaloard 榜单的 CRON 表达式；默认每小时整点执行。'),
  autoModes: z.array(z.string()).default(['daily', 'new-original']).description('自动检查并导入的榜单模式：daily（普通日榜）、new-original（新着原创曲日榜）。'),
  sourceConcurrency: z.natural().default(1).description('同时请求 Vocaloard HTML 页面的最大数量。'),
  sourceRequestIntervalMs: z.natural().default(500).role('ms').description('两次 Vocaloard HTML 请求开始时间之间的最小间隔。'),
  adapterBatchSize: z.natural().default(50).description('每次交给 YouTube 适配器的视频 ID 数量；不会超过适配器声明的上限。'),
  adapterConcurrency: z.natural().default(4).description('同时执行的 YouTube 适配器批次数量。'),
  runImmediately: z.boolean().default(true).description('插件启动后是否立即检查最新榜单；默认开启。'),
})

const MODES: SourceMode[] = ['daily', 'new-original']
const IMPORTER_ID = 'importer-vocaloard-youtube'
const PLATFORM = 'youtube'
const KIND = 'video'

const stateCheckpoint: CheckpointKey = {
  updater: IMPORTER_ID,
  platform: PLATFORM,
  kind: KIND,
  scopeType: 'source',
  scopeId: 'vocaloard',
}

interface LatestRecord {
  date: string
  digest: string
  pages: number
  importedAt: number
  imported: number
}

interface ImporterState {
  latest?: Partial<Record<SourceMode, LatestRecord>>
}

interface RankingPage {
  date?: string
  pages: number
  ids: string[]
}

interface DateImportResult {
  skipped: boolean
  pages: number
  discovered: number
  missing: number
  imported: number
}

interface Progress {
  running: boolean
  task: 'auto' | 'range' | ''
  mode: SourceMode | ''
  date: string
  from: string
  to: string
  page: number
  totalPages: number
  datesCompleted: number
  datesTotal: number
  pagesFetched: number
  discovered: number
  missing: number
  imported: number
  skippedDates: number
  lastError: string
}

const emptyProgress = (): Progress => ({
  running: false,
  task: '',
  mode: '',
  date: '',
  from: '',
  to: '',
  page: 0,
  totalPages: 0,
  datesCompleted: 0,
  datesTotal: 0,
  pagesFetched: 0,
  discovered: 0,
  missing: 0,
  imported: 0,
  skippedDates: 0,
  lastError: '',
})

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive integer`)
  return result
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError(`${name} must be a non-negative integer`)
  return result
}

function normalizeModes(values: readonly string[] | undefined) {
  return [...new Set((values ?? MODES).filter((value): value is SourceMode => MODES.includes(value as SourceMode)))]
}

function isDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function countDays(from: string, to: string) {
  return Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
}

function digest(ids: string[]) {
  return createHash('sha256').update(ids.join('\n')).digest('hex')
}

function modeLabel(mode: SourceMode) {
  return mode === 'daily' ? '普通日榜' : '新着原创曲日榜'
}

function rangeCheckpoint(mode: SourceMode, from: string, to: string): CheckpointKey {
  return {
    updater: IMPORTER_ID,
    platform: PLATFORM,
    kind: KIND,
    scopeType: 'range',
    scopeId: `${mode}:${from}:${to}`,
  }
}

async function mapLimit<T, R>(items: T[], limit: number, callback: (item: T) => Promise<R>) {
  const results: R[] = []
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await callback(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, worker))
  return results
}

export class VocaloardYouTubeImporter extends Service {
  private readonly sourceBase: string
  private readonly proxyAgent?: string
  private readonly cronExpression: string
  private readonly autoModes: SourceMode[]
  private readonly sourceConcurrency: number
  private readonly sourceRequestIntervalMs: number
  private readonly adapterBatchSize: number
  private readonly adapterConcurrency: number
  private readonly runImmediately: boolean
  private nextSourceRequestAt = 0
  private progress = emptyProgress()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'vocaloardYouTubeImporter')
    this.sourceBase = config.sourceBase?.trim() || 'https://vocaloard.injpok.tokyo/'
    this.proxyAgent = config.proxyAgent?.trim() || undefined
    this.cronExpression = config.cron?.trim() || '0 * * * *'
    this.autoModes = normalizeModes(config.autoModes)
    this.sourceConcurrency = positiveInteger(config.sourceConcurrency, 1, 'sourceConcurrency')
    this.sourceRequestIntervalMs = nonNegativeInteger(config.sourceRequestIntervalMs, 500, 'sourceRequestIntervalMs')
    this.adapterBatchSize = positiveInteger(config.adapterBatchSize, 50, 'adapterBatchSize')
    this.adapterConcurrency = positiveInteger(config.adapterConcurrency, 4, 'adapterConcurrency')
    this.runImmediately = config.runImmediately ?? true
  }

  async [Service.init]() {
    this.registerWebUI()
    this.ctx.cron(this.cronExpression, () => this.triggerAuto(), { protect: true })
    if (this.runImmediately) void this.triggerAuto()
  }

  async getStatus() {
    const state = await this.getState()
    return {
      modes: this.autoModes,
      latest: state.latest ?? {},
      progress: { ...this.progress },
    }
  }

  async importRange(input: { mode?: SourceMode; from?: string; to?: string }) {
    const mode = input.mode
    const from = input.from?.trim() ?? ''
    const to = input.to?.trim() ?? ''
    if (!mode || !MODES.includes(mode)) throw new Error('请选择有效的导入模式')
    if (!isDate(from) || !isDate(to) || from > to) throw new Error('请输入有效的起始和结束日期')
    return this.runExclusive('range', async () => {
      const checkpointKey = rangeCheckpoint(mode, from, to)
      const checkpoint = await this.ctx.mediaSync.checkpointStore.get(checkpointKey)
      const start = checkpoint?.cursor && isDate(checkpoint.cursor) && checkpoint.cursor >= from && checkpoint.cursor <= to
        ? checkpoint.cursor
        : from
      this.progress = {
        ...emptyProgress(),
        running: true,
        task: 'range',
        mode,
        date: start,
        from,
        to,
        datesTotal: countDays(from, to),
        datesCompleted: countDays(from, addDays(start, -1)),
      }
      for (let date = start; date <= to; date = addDays(date, 1)) {
        this.progress.date = date
        await this.ctx.mediaSync.checkpointStore.set({
          ...checkpointKey,
          cursor: date,
          extra: JSON.stringify({ mode, from, to }),
        })
        const result = await this.importDate(mode, date)
        if (result.skipped) this.progress.skippedDates++
        this.progress.datesCompleted++
        const next = addDays(date, 1)
        await this.ctx.mediaSync.checkpointStore.set({
          ...checkpointKey,
          cursor: next <= to ? next : null,
          extra: next <= to ? JSON.stringify({ mode, from, to }) : null,
        })
      }
      await this.ctx.mediaSync.checkpointStore.remove(checkpointKey)
    })
  }

  private async triggerAuto() {
    if (this.progress.running) return
    try {
      await this.runExclusive('auto', async () => {
        this.progress = { ...emptyProgress(), running: true, task: 'auto' }
        for (const mode of this.autoModes) await this.importLatest(mode)
      })
    } catch (error) {
      this.ctx.logger('importer-vocaloard-youtube').error(error)
    }
  }

  private async runExclusive(task: 'auto' | 'range', callback: () => Promise<void>) {
    if (this.progress.running) throw new Error('当前已有 Vocaloard 导入任务正在运行')
    try {
      await callback()
    } catch (error) {
      this.progress.lastError = error instanceof Error ? error.message : String(error)
      throw error
    } finally {
      this.progress.running = false
      this.progress.task = ''
    }
  }

  private async importLatest(mode: SourceMode) {
    this.progress.mode = mode
    const first = await this.fetchPage(mode)
    if (!first) return
    if (!first.date) throw new Error(`${modeLabel(mode)}页面缺少榜单日期`)
    const currentDigest = digest(first.ids)
    const state = await this.getState()
    const previous = state.latest?.[mode]
    if (previous?.date === first.date && previous.digest === currentDigest && previous.pages === first.pages) return
    const result = await this.importDate(mode, first.date, first)
    const next: ImporterState = {
      ...state,
      latest: {
        ...state.latest,
        [mode]: {
          date: first.date,
          digest: currentDigest,
          pages: first.pages,
          importedAt: Date.now(),
          imported: result.imported,
        },
      },
    }
    await this.saveState(next)
  }

  private async importDate(mode: SourceMode, date: string, firstPage?: RankingPage): Promise<DateImportResult> {
    this.progress.mode = mode
    this.progress.date = date
    const first = firstPage ?? await this.fetchPage(mode, date, 1)
    if (!first) return { skipped: true, pages: 0, discovered: 0, missing: 0, imported: 0 }
    if (first.date && first.date !== date) throw new Error(`${modeLabel(mode)}返回日期异常：${first.date}，预期 ${date}`)
    this.progress.page = 1
    this.progress.totalPages = first.pages
    this.progress.pagesFetched++
    const pageNumbers = Array.from({ length: Math.max(0, first.pages - 1) }, (_, index) => index + 2)
    const pages = await mapLimit(pageNumbers, this.sourceConcurrency, async (page) => {
      const result = await this.fetchPage(mode, date, page)
      if (!result) throw new Error(`${modeLabel(mode)} ${date} 第 ${page} 页不存在`)
      if (result.date && result.date !== date) throw new Error(`${modeLabel(mode)}第 ${page} 页日期异常：${result.date}`)
      this.progress.page = page
      this.progress.pagesFetched++
      return result
    })
    const ids = [...new Set([first, ...pages].flatMap((page) => page.ids))]
    this.progress.discovered += ids.length
    const missing = await this.findMissing(ids)
    this.progress.missing += missing.length
    const imported = await this.importMissing(missing)
    this.progress.imported += imported
    return { skipped: false, pages: first.pages, discovered: ids.length, missing: missing.length, imported }
  }

  private async findMissing(ids: string[]) {
    const existing = new Set<string>()
    for (let offset = 0; offset < ids.length; offset += 500) {
      const found = await this.ctx.mediaSync.syncQuery.listExistingResourceIds({
        platform: PLATFORM,
        kind: KIND,
        ids: ids.slice(offset, offset + 500),
      })
      found.forEach((id) => existing.add(id))
    }
    return ids.filter((id) => !existing.has(id))
  }

  private async importMissing(ids: string[]) {
    if (!ids.length) return 0
    const adapter = this.ctx.mediaSync.adapterRegistry.get(PLATFORM, KIND)
    if (!adapter?.getResources || !adapter.capabilities.resourceBatch?.supported) {
      throw new Error('需要已加载且支持批量查询的 YouTube 视频适配器')
    }
    const batchSize = Math.min(this.adapterBatchSize, adapter.capabilities.resourceBatch.maxBatchSize ?? this.adapterBatchSize)
    const batches: string[][] = []
    for (let offset = 0; offset < ids.length; offset += batchSize) batches.push(ids.slice(offset, offset + batchSize))
    let imported = 0
    await mapLimit(batches, this.adapterConcurrency, async (batch) => {
      const resources = await adapter.getResources!({ ids: batch })
      for (const resource of resources) {
        await this.ctx.mediaSync.resourceStore.saveResource(resource)
        imported++
      }
      if (adapter.getAuthors && adapter.capabilities.authorBatch?.supported) {
        const authorIds = [...new Set(resources.flatMap((resource) => resource.core.authors?.map((author) => author.id) ?? []))]
        if (authorIds.length) {
          const authors = await adapter.getAuthors({ ids: authorIds })
          for (const author of authors) await this.ctx.mediaSync.resourceStore.saveAuthor(author)
        }
      }
    })
    return imported
  }

  private async fetchPage(mode: SourceMode, date?: string, page = 1): Promise<RankingPage | null> {
    await this.reserveSourceRequest()
    const url = this.sourceUrl(mode, date, page)
    const response = await (this.ctx.http as any)(url, {
      validateStatus: () => true,
      responseType: 'text',
      ...(this.proxyAgent ? { proxyAgent: this.proxyAgent } : {}),
    })
    const status = Number(response?.status ?? 200)
    const html = typeof response?.data === 'string'
      ? response.data
      : typeof response?.text === 'function'
        ? await response.text()
        : ''
    if (status === 404) return null
    if (status < 200 || status >= 300) {
      const detail = html.replace(/\s+/g, ' ').trim()
      const summary = detail.slice(0, 500)
      this.ctx.logger('importer-vocaloard-youtube').error(
        'Vocaloard request failed: %s %s\nresponse: %s',
        status,
        url,
        detail.slice(0, 4000) || '(empty response body)',
      )
      throw new Error(`Vocaloard 请求失败：HTTP ${status}${summary ? `；${summary}` : ''}`)
    }
    return this.parsePage(html)
  }

  private sourceUrl(mode: SourceMode, date?: string, page = 1) {
    const url = new URL(this.sourceBase)
    if (date) url.searchParams.set('d', date)
    if (mode === 'new-original') {
      url.searchParams.set('s', '1')
      url.searchParams.set('t', '1')
    }
    if (page > 1) url.searchParams.set('g', String(page))
    return url.toString()
  }

  private parsePage(html: string): RankingPage | null {
    const $ = load(html)
    const title = $('title').text().replace(/\s+/g, ' ').trim()
    const match = /(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(title)
    const date = match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : undefined
    const ids = new Set<string>()
    $('.RankingItem[id]').each((_, element) => {
      const item = $(element)
      const id = item.attr('id')
      const href = item.find('a[href*="youtube.com/watch"]').first().attr('href')
      if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id) || !href) return
      const videoId = new URL(href, this.sourceBase).searchParams.get('v')
      if (videoId !== id) throw new Error(`Vocaloard 视频 ID 不一致：${id}`)
      ids.add(id)
    })
    if (!ids.size) {
      if (/No Data|Invalid in the Calendar/i.test($.text())) return null
      throw new Error('Vocaloard 页面未包含可识别的排行榜条目')
    }
    let pages = 1
    $('.RankingPagenation a[href*="g="]').each((_, element) => {
      const page = Number(new URL($(element).attr('href')!, this.sourceBase).searchParams.get('g'))
      if (Number.isSafeInteger(page) && page > pages) pages = page
    })
    return { date, pages, ids: [...ids] }
  }

  private async reserveSourceRequest() {
    const now = Date.now()
    const scheduledAt = Math.max(now, this.nextSourceRequestAt)
    this.nextSourceRequestAt = scheduledAt + this.sourceRequestIntervalMs
    if (scheduledAt > now) await new Promise((resolve) => setTimeout(resolve, scheduledAt - now))
  }

  private async getState(): Promise<ImporterState> {
    const checkpoint = await this.ctx.mediaSync.checkpointStore.get(stateCheckpoint)
    if (!checkpoint?.extra) return {}
    try {
      return JSON.parse(checkpoint.extra) as ImporterState
    } catch {
      return {}
    }
  }

  private saveState(state: ImporterState) {
    return this.ctx.mediaSync.checkpointStore.set({ ...stateCheckpoint, extra: JSON.stringify(state) })
  }

  private registerWebUI() {
    this.ctx.webui.addEntry({
      modulePath: 'lfvs-importer-vocaloard-youtube',
      baseUrl: import.meta.url,
      source: '../client/index.ts',
      manifest: '../dist/manifest.json',
    }, {
      status: () => this.getStatus(),
      importRange: (input: { mode?: SourceMode; from?: string; to?: string }) => this.importRange(input),
      checkLatest: () => this.triggerAuto(),
    })
  }
}

export const inject = ['mediaSync', 'http', 'cron', 'webui']

export function apply(ctx: Context, config: Config) {
  const importer = new VocaloardYouTubeImporter(ctx, config)
  return importer[Service.init]()
}

export default { apply, inject, Config }
