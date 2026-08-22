import { $, Field, type Database } from '@cordisjs/plugin-database'
import type { WebUI } from '@cordisjs/plugin-webui'
import { type Context } from 'cordis'
import type { ActiveUpdaterFieldRegistration, FieldDef, MediaSync } from '@lfvs/core'

export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface AuthorSummary {
  platform: string
  id: string
  name: string | null
  avatarUrl: string | null
  isPlaceholder: boolean
  role?: string | null
  isPrimary?: boolean | null
}

export interface ResourceRow {
  platform: string
  kind: string
  id: string
  title: string
  coverUrl: string | null
  publishTime: number | null
  duration: number | null
  lastSyncedAt: number | null
  authors: AuthorSummary[]
}

export interface AuthorRow extends AuthorSummary {
  description?: string | null
  firstSeenAt: number
  lastSeenAt: number
  lastSyncedAt: number | null
  resourceCount: number
}

export interface ResourceDetail extends ResourceRow {
  description: string | null
  firstSeenAt: number
  lastSeenAt: number
  extension: Record<string, unknown>
}

export interface AuthorDetail extends AuthorRow {
  extension: Record<string, unknown>
}

export interface FieldInfo {
  name: string
  label: string
  type: string
  nullable: boolean
  indexed: boolean
  owner?: string
}

export interface HistoryPoint {
  capturedAt: number
  values: Record<string, string | number | null>
}

export interface HistoryResult {
  fields: FieldInfo[]
  points: HistoryPoint[]
  truncated: boolean
}

export interface Overview {
  authors: number
  resources: number
  histories: number
  adapters: number
  updaters: number
  lastResourceSyncAt: number | null
  lastHistoryAt: number | null
  breakdown: Array<{ platform: string; kind: string; resources: number; histories: number }>
}

export interface RuntimeInfo {
  adapters: Array<{
    platform: string
    kind: string
    registeredAt: number
    capabilities: {
      resourceBatch?: { supported: boolean; maxBatchSize?: number; recommendedBatchSize?: number }
      authorBatch?: { supported: boolean; maxBatchSize?: number; recommendedBatchSize?: number }
      listAuthorResources?: boolean
    }
  }>
  updaters: Array<{
    id: string
    label: string
    platform: string
    kind: string
    cron?: string
    manualTrigger: boolean
    registeredAt: number
    running: boolean
    lastSource?: string
    lastStartedAt?: number
    lastFinishedAt?: number
    lastResult?: Record<string, string | number | boolean | null>
    lastError?: string
  }>
  fields: Array<FieldInfo & { platform: string; kind: string; table: string; owner: string }>
}

export interface Data {
  overview(): Promise<Overview>
  runtime(): Promise<RuntimeInfo>
  triggerUpdater(id: string): Promise<{ started: boolean; reason?: string }>
  searchResources(input: {
    name?: string
    authorName?: string
    platform?: string
    kind?: string
    page?: number
    pageSize?: number
  }): Promise<Page<ResourceRow>>
  getResource(input: { platform: string; kind: string; id: string }): Promise<ResourceDetail | null>
  getResourceHistory(input: {
    platform: string
    kind: string
    id: string
    range?: '24h' | '7d' | '30d' | 'all'
  }): Promise<HistoryResult>
  searchAuthors(input: {
    name?: string
    platform?: string
    kind?: string
    includePlaceholders?: boolean
    page?: number
    pageSize?: number
  }): Promise<Page<AuthorRow>>
  getAuthor(input: { platform: string; id: string; kind?: string }): Promise<AuthorDetail | null>
  getAuthorResources(input: {
    platform: string
    id: string
    kind?: string
    page?: number
    pageSize?: number
  }): Promise<Page<ResourceRow>>
}

export const name = 'lfvs-webui'
export const inject = ['mediaSync', 'database', 'webui']

const coreHistoryFields: FieldInfo[] = [
  { name: 'playCount', label: '播放', type: 'bigint', nullable: true, indexed: false },
  { name: 'likeCount', label: '点赞', type: 'bigint', nullable: true, indexed: false },
  { name: 'commentCount', label: '评论', type: 'bigint', nullable: true, indexed: false },
  { name: 'shareCount', label: '分享', type: 'bigint', nullable: true, indexed: false },
  { name: 'favoriteCount', label: '收藏', type: 'bigint', nullable: true, indexed: false },
]

const fieldLabels: Record<string, string> = {
  bilibiliDanmakuCount: '弹幕',
  bilibiliCoinCount: '投币',
}

function dateMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.getTime()
  const time = new Date(value as any).getTime()
  return Number.isFinite(time) ? time : null
}

function jsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.getTime()
  if (Array.isArray(value)) return value.map(jsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]))
  }
  return value
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function textFilter(value?: string) {
  const text = value?.trim()
  return text ? { $regex: { source: escapeRegex(text), flags: 'i' } } : undefined
}

function pagination(page?: number, pageSize?: number) {
  const normalizedPage = Number.isSafeInteger(page) && page! > 0 ? page! : 1
  const normalizedSize = Number.isSafeInteger(pageSize) && pageSize! > 0 ? Math.min(pageSize!, 100) : 25
  return { page: normalizedPage, pageSize: normalizedSize, offset: (normalizedPage - 1) * normalizedSize }
}

function fieldInfo(name: string, definition: FieldDef, owner?: string): FieldInfo {
  const field = Field.parse(definition as any)
  return {
    name,
    label: fieldLabels[name] ?? name,
    type: String(field.deftype ?? field.type ?? 'unknown'),
    nullable: field.nullable ?? true,
    indexed: typeof definition === 'object' && !!definition.indexed,
    ...(owner ? { owner } : {}),
  }
}

export function apply(ctx: Context) {
  const database = ctx.database as Database
  const mediaSync = ctx.mediaSync as MediaSync

  const count = (table: string, query: Record<string, unknown> = {}) => {
    return (database.eval as any)(table, (row: any) => $.count(row.pk), query) as Promise<number>
  }

  const activeFields = (platform: string, kind: string) => mediaSync.resolveUpdaterFields(platform, kind)

  async function authorMapForResources(resourcePks: number[]) {
    const result = new Map<number, AuthorSummary[]>()
    if (!resourcePks.length) return result
    const links = await database.get('resource_authors', { resourcePk: resourcePks }, {
      sort: { resourcePk: 'asc', sortOrder: 'asc' },
    } as any)
    const authorPks = [...new Set(links.map((link) => link.authorPk))]
    const authors = authorPks.length ? await database.get('authors', { pk: authorPks }) : []
    const authorsByPk = new Map(authors.map((author) => [author.pk, author]))
    for (const link of links) {
      const author = authorsByPk.get(link.authorPk)
      if (!author) continue
      const list = result.get(link.resourcePk) ?? []
      list.push({
        platform: author.platform,
        id: author.id,
        name: author.name,
        avatarUrl: author.avatarUrl,
        isPlaceholder: author.isPlaceholder,
        role: link.role,
        isPrimary: link.isPrimary,
      })
      result.set(link.resourcePk, list)
    }
    return result
  }

  async function resourceRows(rows: any[]): Promise<ResourceRow[]> {
    const authors = await authorMapForResources(rows.map((row) => row.pk))
    return rows.map((row) => ({
      platform: row.platform,
      kind: row.kind,
      id: row.id,
      title: row.title,
      coverUrl: row.coverUrl,
      publishTime: dateMillis(row.publishTime),
      duration: row.duration,
      lastSyncedAt: dateMillis(row.lastSyncedAt),
      authors: authors.get(row.pk) ?? [],
    }))
  }

  async function resourcePksForAuthorName(name: string, platform?: string) {
    const query: Record<string, unknown> = { name: textFilter(name) }
    if (platform) query.platform = platform
    const authors = await database.get('authors', query as any, { fields: ['pk'] } as any)
    if (!authors.length) return []
    const links = await database.get('resource_authors', { authorPk: authors.map((author) => author.pk) }, { fields: ['resourcePk'] } as any)
    return [...new Set(links.map((link) => link.resourcePk))]
  }

  async function searchResources(input: Parameters<Data['searchResources']>[0]): Promise<Page<ResourceRow>> {
    const page = pagination(input.page, input.pageSize)
    const query: Record<string, unknown> = {}
    if (input.platform?.trim()) query.platform = input.platform.trim()
    if (input.kind?.trim()) query.kind = input.kind.trim()
    if (input.name?.trim()) query.title = textFilter(input.name)
    if (input.authorName?.trim()) {
      const pks = await resourcePksForAuthorName(input.authorName, input.platform?.trim())
      if (!pks.length) return { items: [], total: 0, page: page.page, pageSize: page.pageSize }
      query.pk = pks
    }
    const [total, rows] = await Promise.all([
      count('resources', query),
      database.get('resources', query as any, {
        limit: page.pageSize,
        offset: page.offset,
        sort: { lastSyncedAt: 'desc', pk: 'desc' },
      } as any),
    ])
    return { items: await resourceRows(rows), total, page: page.page, pageSize: page.pageSize }
  }

  async function getResource(input: Parameters<Data['getResource']>[0]): Promise<ResourceDetail | null> {
    const [row] = await database.get('resources', input)
    if (!row) return null
    const [base] = await resourceRows([row])
    const fields = activeFields(input.platform, input.kind).resources ?? {}
    const extension = Object.fromEntries(Object.keys(fields).map((key) => [key, jsonValue((row as any)[key])]))
    return {
      ...base,
      description: row.description,
      firstSeenAt: dateMillis(row.firstSeenAt)!,
      lastSeenAt: dateMillis(row.lastSeenAt)!,
      extension,
    }
  }

  async function getResourceHistory(input: Parameters<Data['getResourceHistory']>[0]): Promise<HistoryResult> {
    const [resource] = await database.get('resources', { platform: input.platform, kind: input.kind, id: input.id }, { fields: ['pk'] } as any)
    if (!resource) return { fields: coreHistoryFields, points: [], truncated: false }
    const extensionDefs = activeFields(input.platform, input.kind).resourceHistories ?? {}
    const fields = [
      ...coreHistoryFields,
      ...Object.entries(extensionDefs).map(([name, definition]) => fieldInfo(name, definition)),
    ]
    const query: Record<string, unknown> = { resourcePk: resource.pk }
    const rangeMs = input.range === '24h' ? 86_400_000 : input.range === '7d' ? 604_800_000 : input.range === '30d' ? 2_592_000_000 : 0
    if (rangeMs) query.capturedAt = { $gte: new Date(Date.now() - rangeMs) }
    const rows = await database.get('resource_histories', query as any, {
      limit: 5001,
      sort: { capturedAt: 'desc' },
    } as any)
    const truncated = rows.length > 5000
    const points = rows.slice(0, 5000).reverse().map((row) => ({
      capturedAt: dateMillis(row.capturedAt)!,
      values: Object.fromEntries(fields.map(({ name }) => {
        const value = jsonValue((row as any)[name])
        return [name, value === undefined ? null : value as string | number | null]
      })),
    }))
    return { fields, points, truncated }
  }

  async function authorPksForKind(kind: string, platform?: string) {
    const query: Record<string, unknown> = { kind }
    if (platform) query.platform = platform
    const resources = await database.get('resources', query as any, { fields: ['pk'] } as any)
    if (!resources.length) return []
    const links = await database.get('resource_authors', { resourcePk: resources.map((resource) => resource.pk) }, { fields: ['authorPk'] } as any)
    return [...new Set(links.map((link) => link.authorPk))]
  }

  async function authorRows(rows: any[]): Promise<AuthorRow[]> {
    const pks = rows.map((row) => row.pk)
    const links = pks.length ? await database.get('resource_authors', { authorPk: pks }, { fields: ['authorPk'] } as any) : []
    const counts = new Map<number, number>()
    for (const link of links) counts.set(link.authorPk, (counts.get(link.authorPk) ?? 0) + 1)
    return rows.map((row) => ({
      platform: row.platform,
      id: row.id,
      name: row.name,
      avatarUrl: row.avatarUrl,
      description: row.description,
      isPlaceholder: row.isPlaceholder,
      firstSeenAt: dateMillis(row.firstSeenAt)!,
      lastSeenAt: dateMillis(row.lastSeenAt)!,
      lastSyncedAt: dateMillis(row.lastSyncedAt),
      resourceCount: counts.get(row.pk) ?? 0,
    }))
  }

  async function searchAuthors(input: Parameters<Data['searchAuthors']>[0]): Promise<Page<AuthorRow>> {
    const page = pagination(input.page, input.pageSize)
    const query: Record<string, unknown> = {}
    if (input.platform?.trim()) query.platform = input.platform.trim()
    if (input.name?.trim()) query.name = textFilter(input.name)
    if (!input.includePlaceholders) query.isPlaceholder = false
    if (input.kind?.trim()) {
      const pks = await authorPksForKind(input.kind.trim(), input.platform?.trim())
      if (!pks.length) return { items: [], total: 0, page: page.page, pageSize: page.pageSize }
      query.pk = pks
    }
    const [total, rows] = await Promise.all([
      count('authors', query),
      database.get('authors', query as any, {
        limit: page.pageSize,
        offset: page.offset,
        sort: { lastSyncedAt: 'desc', pk: 'desc' },
      } as any),
    ])
    return { items: await authorRows(rows), total, page: page.page, pageSize: page.pageSize }
  }

  function activeAuthorFieldDefinitions(platform: string, kind?: string) {
    const registrations = mediaSync.listUpdaterFieldExtensions({ platform, ...(kind ? { kind } : {}) })
    return Object.assign({}, ...registrations.map((registration) => registration.fields.authors ?? {})) as Record<string, FieldDef>
  }

  async function getAuthor(input: Parameters<Data['getAuthor']>[0]): Promise<AuthorDetail | null> {
    const [row] = await database.get('authors', { platform: input.platform, id: input.id })
    if (!row) return null
    const [base] = await authorRows([row])
    const fields = activeAuthorFieldDefinitions(input.platform, input.kind)
    return {
      ...base,
      extension: Object.fromEntries(Object.keys(fields).map((key) => [key, jsonValue((row as any)[key])])),
    }
  }

  async function getAuthorResources(input: Parameters<Data['getAuthorResources']>[0]): Promise<Page<ResourceRow>> {
    const page = pagination(input.page, input.pageSize)
    const [author] = await database.get('authors', { platform: input.platform, id: input.id }, { fields: ['pk'] } as any)
    if (!author) return { items: [], total: 0, page: page.page, pageSize: page.pageSize }
    const links = await database.get('resource_authors', { authorPk: author.pk }, { fields: ['resourcePk'] } as any)
    const pks = links.map((link) => link.resourcePk)
    if (!pks.length) return { items: [], total: 0, page: page.page, pageSize: page.pageSize }
    const query: Record<string, unknown> = { pk: pks, platform: input.platform }
    if (input.kind?.trim()) query.kind = input.kind.trim()
    const [total, rows] = await Promise.all([
      count('resources', query),
      database.get('resources', query as any, {
        limit: page.pageSize,
        offset: page.offset,
        sort: { publishTime: 'desc', pk: 'desc' },
      } as any),
    ])
    return { items: await resourceRows(rows), total, page: page.page, pageSize: page.pageSize }
  }

  async function breakdown() {
    const resourceGroups = await database.select('resources').groupBy(['platform', 'kind'], (row) => ({ count: $.count(row.pk) })).execute()
    const historyGroups = await database.select('resource_histories').groupBy(['platform', 'kind'], (row) => ({ count: $.count(row.pk) })).execute()
    const result = new Map<string, { platform: string; kind: string; resources: number; histories: number }>()
    for (const row of resourceGroups as any[]) {
      result.set(`${row.platform}\0${row.kind}`, { platform: row.platform, kind: row.kind, resources: row.count, histories: 0 })
    }
    for (const row of historyGroups as any[]) {
      const key = `${row.platform}\0${row.kind}`
      const item = result.get(key) ?? { platform: row.platform, kind: row.kind, resources: 0, histories: 0 }
      item.histories = row.count
      result.set(key, item)
    }
    return [...result.values()].sort((a, b) => a.platform.localeCompare(b.platform) || a.kind.localeCompare(b.kind))
  }

  async function overview(): Promise<Overview> {
    const stats = await database.stats()
    const [latestResource] = await database.get('resources', { lastSyncedAt: { $ne: null } }, { limit: 1, fields: ['lastSyncedAt'], sort: { lastSyncedAt: 'desc' } } as any)
    const [latestHistory] = await database.get('resource_histories', {}, { limit: 1, fields: ['capturedAt'], sort: { capturedAt: 'desc' } } as any)
    return {
      authors: stats.tables?.authors?.count ?? await count('authors'),
      resources: stats.tables?.resources?.count ?? await count('resources'),
      histories: stats.tables?.resource_histories?.count ?? await count('resource_histories'),
      adapters: mediaSync.adapterRegistry.describe().length,
      updaters: mediaSync.updaterRegistry.list().length,
      lastResourceSyncAt: dateMillis(latestResource?.lastSyncedAt),
      lastHistoryAt: dateMillis(latestHistory?.capturedAt),
      breakdown: await breakdown(),
    }
  }

  function flattenFields(registrations: ActiveUpdaterFieldRegistration[]) {
    return registrations.flatMap((registration) => Object.entries(registration.fields).flatMap(([table, fields]) => {
      return (Object.entries(fields ?? {}) as [string, FieldDef][]).map(([name, definition]) => ({
        ...fieldInfo(name, definition, registration.owner),
        platform: registration.platform,
        kind: registration.kind,
        table,
        owner: registration.owner,
      }))
    }))
  }

  function runtime(): RuntimeInfo {
    return {
      adapters: mediaSync.adapterRegistry.describe(),
      updaters: mediaSync.updaterRegistry.list(),
      fields: flattenFields(mediaSync.listUpdaterFieldExtensions()),
    }
  }

  function triggerUpdater(id: string) {
    const updater = mediaSync.updaterRegistry.get(id)
    if (!updater) throw new Error(`更新器不在线：${id}`)
    if (!updater.manualTrigger) throw new Error(`更新器不允许手动执行：${id}`)
    if (updater.running) return { started: false, reason: 'running' }
    void mediaSync.runUpdater(id, 'manual').catch((error) => ctx.logger('lfvs-webui').error(error))
    return { started: true }
  }

  ctx.webui.addEntry<Data>({
    modulePath: 'lfvs-webui',
    baseUrl: import.meta.url,
    source: '../client/index.ts',
    manifest: '../dist/manifest.json',
    routes: ['/lfvs{/*path}'],
  }, {
    overview,
    runtime: async () => runtime(),
    triggerUpdater: async (id) => triggerUpdater(id),
    searchResources,
    getResource,
    getResourceHistory,
    searchAuthors,
    getAuthor,
    getAuthorResources,
  })
}

export default { apply, inject }
