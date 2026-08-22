import { Service, type Context } from 'cordis'
import type { Http } from '@cordisjs/plugin-http'
import type { WebUI } from '@cordisjs/plugin-webui'
import type { Cron } from 'cordis-plugin-cron'
import z from 'schemastery'
import type { CheckpointKey, MediaSync } from '@lfvs/core'

declare module 'cordis' {
  interface Context {
    vocabiliImporter: VocabiliImporter
  }
}

export interface Config {
  apiBase?: string
  boardName?: string
  proxyAgent?: string
  cron?: string
  pageSize?: number
  batchSize?: number
  concurrency?: number
  runImmediately?: boolean
}

export const Config = z.object({
  apiBase: z.string().default('https://api.vocabili.top').description('Vocabili API 基础地址。'),
  boardName: z.string().default('vocaloid-daily').description('需要导入的 Vocabili 排行榜名称。'),
  proxyAgent: z.string().default('').description('Vocabili 请求使用的 HTTP 代理地址；留空表示直连。'),
  cron: z.string().default('0 * * * *').description('自动检查并导入最新一期的 CRON 表达式；默认每小时整点执行。'),
  pageSize: z.natural().default(20).description('每次向 Vocabili 请求的榜单条目数量。'),
  batchSize: z.natural().default(250).description('每次向 Bilibili 适配器提交的 BVID 数量。'),
  concurrency: z.natural().default(4).description('同时执行的 Bilibili 适配器批量请求数量。'),
  runImmediately: z.boolean().default(true).description('插件启动后是否立即检查一次最新期数。'),
})

interface ImportState {
  username?: string
  accessToken?: string
  accessTokenExp?: number
  refreshToken?: string
  refreshTokenExp?: number
  lastIssue?: number
}

interface Progress {
  running: boolean
  issue: number
  page: number
  totalPages: number
  discovered: number
  missing: number
  imported: number
}

interface RankingResponse {
  issue?: number
  total?: number
  data?: Array<{ bvid?: string }>
}

const DEFAULTS = {
  apiBase: 'https://api.vocabili.top',
  boardName: 'vocaloid-daily',
  cron: '0 * * * *',
  pageSize: 20,
  batchSize: 250,
  concurrency: 4,
} as const

const checkpointKey: CheckpointKey = {
  updater: 'importer-vocabili',
  platform: 'bilibili',
  kind: 'video',
  scopeType: 'source',
  scopeId: 'vocabili',
}

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive integer`)
  return result
}

function parseIssue(payload: unknown) {
  if (typeof payload === 'number' && payload > 0) return payload
  if (typeof (payload as any)?.data === 'number' && (payload as any).data > 0) return (payload as any).data as number
  throw new Error('Vocabili did not return a valid issue number')
}

function parseCookies(headers: Headers) {
  const values = typeof (headers as any).getSetCookie === 'function'
    ? (headers as any).getSetCookie() as string[]
    : [headers.get('set-cookie') ?? '']
  const cookies: Record<string, string> = {}
  for (const value of values) {
    for (const part of value.split(/,(?=\s*\w+=)/)) {
      const match = /^\s*([^=;]+)=([^;]*)/.exec(part)
      if (match) cookies[match[1]] = match[2]
    }
  }
  return cookies
}

export class VocabiliImporter extends Service {
  private readonly apiBase: string
  private readonly boardName: string
  private readonly proxyAgent?: string
  private readonly cronExpression: string
  private readonly pageSize: number
  private readonly batchSize: number
  private readonly concurrency: number
  private readonly runImmediately: boolean
  private progress: Progress = { running: false, issue: 0, page: 0, totalPages: 0, discovered: 0, missing: 0, imported: 0 }

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'vocabiliImporter')
    this.apiBase = (config.apiBase ?? DEFAULTS.apiBase).replace(/\/$/, '')
    this.boardName = config.boardName?.trim() || DEFAULTS.boardName
    this.proxyAgent = config.proxyAgent?.trim() || undefined
    this.cronExpression = config.cron?.trim() || DEFAULTS.cron
    this.pageSize = positiveInteger(config.pageSize, DEFAULTS.pageSize, 'pageSize')
    this.batchSize = positiveInteger(config.batchSize, DEFAULTS.batchSize, 'batchSize')
    this.concurrency = positiveInteger(config.concurrency, DEFAULTS.concurrency, 'concurrency')
    this.runImmediately = config.runImmediately ?? true
  }

  async [Service.init]() {
    this.registerWebUI()
    this.ctx.cron(this.cronExpression, () => this.trigger(false), { protect: true })
    if (this.runImmediately) void this.trigger(false)
  }

  async getStatus() {
    const state = await this.getState()
    return {
      loggedIn: !!state.accessToken,
      username: state.username ?? '',
      lastIssue: state.lastIssue ?? 0,
      needsReauth: !!state.accessToken && (state.refreshTokenExp ?? 0) <= Date.now(),
      progress: { ...this.progress },
    }
  }

  async getCaptcha() {
    const payload = await this.get<any>(`${this.apiBase}/v2/auth/captcha`)
    return { codeId: payload.code_id, image: payload.image }
  }

  async login(input: { username?: string; password?: string; codeId?: string; codeAnswer?: string }) {
    if (!input.username?.trim() || !input.password?.trim()) throw new Error('用户名和密码不能为空')
    if (!input.codeId || !input.codeAnswer) throw new Error('验证码不能为空')
    const response = await this.ctx.http(`${this.apiBase}/v2/auth/login`, {
      method: 'POST',
      data: {
        username: input.username,
        password: input.password,
        code_id: input.codeId,
        code_answer: input.codeAnswer,
      },
      headers: { 'content-type': 'application/json' },
      validateStatus: () => true,
      ...this.requestOptions(),
    })
    const payload = await response.json().catch(() => ({})) as any
    if (response.status !== 200) throw new Error(payload?.detail ?? `登录失败 (${response.status})`)
    const cookies = parseCookies(response.headers)
    if (!cookies.access_token) throw new Error('登录响应缺少 access_token')
    const current = await this.getState()
    await this.saveState({
      ...current,
      username: input.username,
      accessToken: cookies.access_token,
      accessTokenExp: Date.now() + 2 * 60 * 60 * 1000,
      refreshToken: cookies.refresh_token ?? current.refreshToken,
      refreshTokenExp: cookies.refresh_token ? Date.now() + 30 * 24 * 60 * 60 * 1000 : current.refreshTokenExp,
    })
  }

  async logout() {
    const state = await this.getState()
    await this.saveState({ lastIssue: state.lastIssue })
  }

  async runOnce(force = true) {
    if (this.progress.running) throw new Error('当前已有 Vocabili 导入任务正在运行')
    const state = await this.getState()
    if (!state.accessToken) throw new Error('请先登录 Vocabili')
    const issue = parseIssue(await this.get(`${this.apiBase}/v3/ranking/${this.boardName}/latest_issue`))
    if (!force && issue <= (state.lastIssue ?? 0)) return

    this.progress = { running: true, issue, page: 1, totalPages: 1, discovered: 0, missing: 0, imported: 0 }
    try {
      const token = await this.ensureAccessToken(state)
      const ids = await this.collectBvids(issue, token)
      this.progress.discovered = ids.length
      const existing = new Set<string>()
      for (let offset = 0; offset < ids.length; offset += 500) {
        const found = await this.ctx.mediaSync.syncQuery.listExistingResourceIds({
          platform: 'bilibili',
          kind: 'video',
          ids: ids.slice(offset, offset + 500),
        })
        found.forEach((id) => existing.add(id))
      }
      const missing = ids.filter((id) => !existing.has(id))
      this.progress.missing = missing.length
      await this.importMissing(missing)
      await this.saveState({ ...await this.getState(), lastIssue: issue })
    } finally {
      this.progress.running = false
    }
  }

  private async trigger(force: boolean) {
    try {
      const state = await this.getState()
      if (!state.accessToken) return
      await this.runOnce(force)
    } catch (error) {
      this.ctx.logger('importer-vocabili').error(error)
    }
  }

  private async collectBvids(issue: number, token: string) {
    const ids = new Set<string>()
    let page = 1
    while (true) {
      this.progress.page = page
      const payload = await this.get<RankingResponse>(`${this.apiBase}/v3/ranking/${this.boardName}/main/${issue}`, {
        page_size: this.pageSize,
        page,
        order_type: 'point',
        seperate: 'false',
      }, { Authorization: `Bearer ${token}` })
      if (payload.issue !== undefined && payload.issue !== issue) throw new Error(`Vocabili issue changed: ${payload.issue} != ${issue}`)
      const list = Array.isArray(payload.data) ? payload.data : []
      for (const item of list) {
        if (typeof item.bvid === 'string' && item.bvid) ids.add(item.bvid)
      }
      const total = payload.total ?? list.length
      this.progress.totalPages = Math.max(1, Math.ceil(total / this.pageSize))
      if (!list.length || page * this.pageSize >= total) break
      page++
    }
    return [...ids]
  }

  private async importMissing(ids: string[]) {
    const adapter = this.ctx.mediaSync.adapterRegistry.get('bilibili', 'video')
    if (!adapter?.getResources || !adapter.capabilities.resourceBatch?.supported) {
      throw new Error('Bilibili video adapter with batch support is required')
    }
    const size = Math.min(this.batchSize, adapter.capabilities.resourceBatch.maxBatchSize ?? this.batchSize)
    const batches: string[][] = []
    for (let offset = 0; offset < ids.length; offset += size) batches.push(ids.slice(offset, offset + size))
    let next = 0
    const worker = async () => {
      while (next < batches.length) {
        const resources = await adapter.getResources!({ ids: batches[next++] })
        for (const resource of resources) {
          await this.ctx.mediaSync.resourceStore.saveResource(resource)
          this.progress.imported++
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, batches.length)) }, worker))
  }

  private async ensureAccessToken(state: ImportState) {
    if (state.accessToken && (state.accessTokenExp ?? 0) > Date.now() + 60_000) return state.accessToken
    if (!state.refreshToken || (state.refreshTokenExp ?? 0) <= Date.now()) throw new Error('Vocabili 登录已过期，请重新登录')
    const response = await this.ctx.http(`${this.apiBase}/v2/auth/refresh`, {
      method: 'POST',
      headers: { cookie: `refresh_token=${state.refreshToken}` },
      validateStatus: () => true,
      ...this.requestOptions(),
    })
    if (response.status !== 200) throw new Error(`刷新 Vocabili Token 失败 (${response.status})`)
    const cookies = parseCookies(response.headers)
    if (!cookies.access_token) throw new Error('刷新响应缺少 access_token')
    const next = {
      ...state,
      accessToken: cookies.access_token,
      accessTokenExp: Date.now() + 2 * 60 * 60 * 1000,
      refreshToken: cookies.refresh_token ?? state.refreshToken,
      refreshTokenExp: cookies.refresh_token ? Date.now() + 30 * 24 * 60 * 60 * 1000 : state.refreshTokenExp,
    }
    await this.saveState(next)
    return next.accessToken
  }

  private requestOptions() {
    return this.proxyAgent ? { proxyAgent: this.proxyAgent } : {}
  }

  private get<T = unknown>(url: string, params?: Record<string, unknown>, headers?: Record<string, string>) {
    return this.ctx.http.get<T>(url, { params, headers, ...this.requestOptions() })
  }

  private async getState(): Promise<ImportState> {
    const checkpoint = await this.ctx.mediaSync.checkpointStore.get(checkpointKey)
    if (!checkpoint?.extra) return {}
    try {
      return JSON.parse(checkpoint.extra)
    } catch {
      return {}
    }
  }

  private saveState(state: ImportState) {
    return this.ctx.mediaSync.checkpointStore.set({ ...checkpointKey, extra: JSON.stringify(state) })
  }

  private registerWebUI() {
    this.ctx.webui.addEntry({
      modulePath: 'lfvs-importer-vocabili',
      baseUrl: import.meta.url,
      source: '../client/index.ts',
      manifest: '../dist/manifest.json',
    }, {
      status: () => this.getStatus(),
      captcha: () => this.getCaptcha(),
      login: (input: any) => this.login(input),
      logout: () => this.logout(),
      forceImport: () => this.runOnce(true),
    })
  }
}

export const inject = ['mediaSync', 'http', 'cron', 'webui']

export function apply(ctx: Context, config: Config) {
  const importer = new VocabiliImporter(ctx, config)
  return importer[Service.init]()
}

export default { apply, inject, Config }
