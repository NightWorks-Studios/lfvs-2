import { $, type Database } from '@cordisjs/plugin-database'
import type { FieldDef, MediaSync } from '@lfvs/core'
import {
  ApiError,
  booleanQuery,
  nextCursor,
  nonNegativeInteger,
  optionalText,
  parseDate,
  parsePagination,
  querySignature,
  requiredId,
  textFilter,
  type Pagination,
} from './http.js'
import { historyCoreFields, targetSchema } from './schema.js'

export interface ApiLimits {
  defaultLimit: number
  maxLimit: number
  maxBatchSize: number
  maxHistoryPoints: number
}

type Row = Record<string, any>

function dateIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value as any)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function extensionValues(row: Row, definitions: Record<string, FieldDef>) {
  return Object.fromEntries(Object.keys(definitions).map((name) => [name, row[name] ?? null]))
}

function split<T>(values: T[], size = 500) {
  const chunks: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) chunks.push(values.slice(offset, offset + size))
  return chunks
}

function pageResult<T>(items: T[], page: Pagination) {
  const hasMore = items.length > page.limit
  return {
    data: items.slice(0, page.limit),
    pagination: {
      nextCursor: nextCursor(page, hasMore),
      hasMore,
    },
  }
}

export class LfvsApiService {
  constructor(
    private readonly database: Database,
    private readonly mediaSync: MediaSync,
    private readonly limits: ApiLimits,
  ) {}

  root() {
    return {
      data: {
        name: 'LFVS API',
        version: 'v1',
        readOnly: true,
      },
    }
  }

  async targets() {
    const [resourceGroups, historyGroups] = await Promise.all([
      this.database.select('resources').groupBy(['platform', 'kind'], (row) => ({ count: $.count(row.pk) })).execute(),
      this.database.select('resource_histories').groupBy(['platform', 'kind'], (row) => ({ count: $.count(row.pk) })).execute(),
    ])
    const result = new Map<string, Row>()
    const ensure = (platform: string, kind: string) => {
      const key = `${platform}\0${kind}`
      const current = result.get(key) ?? {
        platform,
        kind,
        resourceCount: 0,
        historyCount: 0,
        adapterOnline: false,
        updaterOnline: false,
      }
      result.set(key, current)
      return current
    }
    for (const row of resourceGroups as Row[]) ensure(row.platform, row.kind).resourceCount = Number(row.count)
    for (const row of historyGroups as Row[]) ensure(row.platform, row.kind).historyCount = Number(row.count)
    for (const adapter of this.mediaSync.adapterRegistry.describe()) {
      ensure(adapter.platform, adapter.kind).adapterOnline = true
    }
    for (const updater of this.mediaSync.updaterRegistry.list()) {
      ensure(updater.platform, updater.kind).updaterOnline = true
    }
    return {
      data: [...result.values()].sort((a, b) => {
        return a.platform.localeCompare(b.platform) || a.kind.localeCompare(b.kind)
      }),
    }
  }

  schema(platform: string, kind: string) {
    return { data: targetSchema(this.mediaSync, platform, kind) }
  }

  async listResources(platform: string, kind: string, query: URLSearchParams) {
    const title = optionalText(query.get('q'), 'q')
    const rawAuthorId = query.get('authorId')
    const authorId = rawAuthorId === null ? undefined : requiredId(rawAuthorId, 'authorId')
    const authorName = optionalText(query.get('authorName'), 'authorName')
    const publishedAfter = parseDate(query.get('publishedAfter'), 'publishedAfter')
    const publishedBefore = parseDate(query.get('publishedBefore'), 'publishedBefore')
    if (publishedAfter && publishedBefore && publishedAfter > publishedBefore) {
      throw new ApiError(400, 'INVALID_DATE_RANGE', 'publishedAfter must not be later than publishedBefore')
    }
    const signature = querySignature('resources', {
      platform, kind, title, authorId, authorName,
      publishedAfter: publishedAfter?.toISOString(),
      publishedBefore: publishedBefore?.toISOString(),
    })
    const page = parsePagination(query, signature, this.limits.defaultLimit, this.limits.maxLimit)
    const filter: Row = { platform, kind }
    if (title) filter.title = textFilter(title)
    if (publishedAfter || publishedBefore) {
      filter.publishTime = {
        ...(publishedAfter ? { $gte: publishedAfter } : {}),
        ...(publishedBefore ? { $lte: publishedBefore } : {}),
      }
    }
    if (authorId || authorName) {
      const resourcePks = await this.resourcePksForAuthor(platform, authorId, authorName)
      if (!resourcePks.length) return pageResult([], page)
      filter.pk = resourcePks
    }
    const rows = await this.database.get('resources', filter as any, {
      limit: page.limit + 1,
      offset: page.offset,
      sort: { lastSyncedAt: 'desc', pk: 'desc' },
    } as any)
    return pageResult(await this.serializeResources(rows as Row[], platform, kind), page)
  }

  async getResource(platform: string, kind: string, id: string) {
    const [row] = await this.database.get('resources', { platform, kind, id })
    if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'resource was not found')
    const [data] = await this.serializeResources([row as Row], platform, kind)
    return { data }
  }

  async batchResources(platform: string, kind: string, body: unknown) {
    if (!body || typeof body !== 'object' || !Array.isArray((body as Row).ids)) {
      throw new ApiError(400, 'INVALID_BODY', 'body must contain an ids array')
    }
    const ids: string[] = (body as Row).ids.map((value: unknown, index: number) => {
      if (typeof value !== 'string') throw new ApiError(400, 'INVALID_ID', `ids[${index}] must be a string`)
      return requiredId(value, `ids[${index}]`)
    })
    if (!ids.length) throw new ApiError(400, 'INVALID_BODY', 'ids must not be empty')
    if (ids.length > this.limits.maxBatchSize) {
      throw new ApiError(400, 'BATCH_TOO_LARGE', `ids must not contain more than ${this.limits.maxBatchSize} items`)
    }
    const uniqueIds = [...new Set(ids)]
    const rows = await this.database.get('resources', { platform, kind, id: uniqueIds })
    const serialized = await this.serializeResources(rows as Row[], platform, kind)
    const byId = new Map(serialized.map((resource) => [resource.id, resource]))
    return {
      data: ids.map((id) => ({ id, resource: byId.get(id) ?? null })),
    }
  }

  async resourceSnapshot(platform: string, kind: string, query: URLSearchParams) {
    const at = parseDate(query.get('at'), 'at')
    if (!at) throw new ApiError(400, 'MISSING_PARAMETER', 'at is required')
    const includeMissing = booleanQuery(query.get('includeMissing'), 'includeMissing', true)
    const publishedBeforeAt = booleanQuery(query.get('publishedBeforeAt'), 'publishedBeforeAt')
    const rawMaxDistance = query.get('maxDistanceMs')
    const maxDistanceMs = rawMaxDistance === null ? undefined : nonNegativeInteger(rawMaxDistance, 'maxDistanceMs')

    const activeFields = this.mediaSync.resolveUpdaterFields(platform, kind)
    const resourceDefinitions = activeFields.resources ?? {}
    const historyDefinitions = activeFields.resourceHistories ?? {}
    const availableMetrics = new Set<string>([...historyCoreFields, ...Object.keys(historyDefinitions)])
    const requested = optionalText(query.get('metrics'), 'metrics', 1000)?.split(',').map((item) => item.trim()).filter(Boolean)
    const metrics = requested?.length ? [...new Set(requested)] : [...availableMetrics]
    const invalidMetrics = metrics.filter((metric) => !availableMetrics.has(metric))
    if (invalidMetrics.length) {
      throw new ApiError(400, 'INVALID_METRIC', 'one or more metrics are not available', { metrics: invalidMetrics })
    }

    const generatedAt = new Date()
    const result = await this.database.transact(async (database) => {
      const resourceFilter: Row = { platform, kind }
      if (publishedBeforeAt) resourceFilter.publishTime = { $lte: at }
      const resourceFields = [
        'pk', 'platform', 'kind', 'id', 'title', 'publishTime', 'duration',
        ...Object.keys(resourceDefinitions),
      ]
      const historyFields = ['resourcePk', 'capturedAt', ...metrics]
      const resources = await database.get('resources', resourceFilter as any, {
        fields: resourceFields,
        sort: { pk: 'asc' },
      } as any)
      const histories = await database.get('resource_histories', { platform, kind }, {
        fields: historyFields,
        sort: { resourcePk: 'asc', capturedAt: 'asc' },
      } as any)

      const targetTime = at.getTime()
      const resourcePks = new Set(resources.map((resource) => resource.pk))
      const nearest = new Map<number, Row>()
      for (const history of histories as Row[]) {
        if (!resourcePks.has(history.resourcePk)) continue
        const capturedTime = new Date(history.capturedAt).getTime()
        const distance = Math.abs(capturedTime - targetTime)
        const current = nearest.get(history.resourcePk)
        if (!current) {
          nearest.set(history.resourcePk, { row: history, capturedTime, distance })
          continue
        }
        if (distance < current.distance || distance === current.distance && capturedTime < current.capturedTime) {
          nearest.set(history.resourcePk, { row: history, capturedTime, distance })
        }
      }

      let matchedCount = 0
      let missingCount = 0
      let outsideToleranceCount = 0
      const data = []
      const coreMetrics = new Set(historyCoreFields)
      for (const resource of resources as Row[]) {
        const selected = nearest.get(resource.pk)
        let match: Row
        let history: Row | null = null
        if (!selected) {
          missingCount++
          match = { status: 'missing', requestedAt: at }
        } else if (maxDistanceMs !== undefined && selected.distance > maxDistanceMs) {
          outsideToleranceCount++
          match = {
            status: 'outsideTolerance',
            requestedAt: at,
            capturedAt: selected.row.capturedAt,
            distanceMs: selected.distance,
            direction: direction(selected.capturedTime, targetTime),
          }
        } else {
          matchedCount++
          match = {
            status: 'matched',
            requestedAt: at,
            capturedAt: selected.row.capturedAt,
            distanceMs: selected.distance,
            direction: direction(selected.capturedTime, targetTime),
          }
          history = {
            ...Object.fromEntries(metrics.filter((name) => coreMetrics.has(name as any)).map((name) => [name, selected.row[name] ?? null])),
            extensions: Object.fromEntries(metrics.filter((name) => !coreMetrics.has(name as any)).map((name) => [name, selected.row[name] ?? null])),
          }
        }
        if (!includeMissing && !history) continue
        data.push({
          resource: {
            platform: resource.platform,
            kind: resource.kind,
            id: resource.id,
            title: resource.title,
            publishTime: dateIso(resource.publishTime),
            duration: resource.duration,
            extensions: extensionValues(resource, resourceDefinitions),
          },
          match,
          history,
        })
      }
      return {
        data,
        summary: {
          platform,
          kind,
          requestedAt: at,
          generatedAt,
          resourceCount: resources.length,
          matchedCount,
          missingCount,
          outsideToleranceCount,
        },
      }
    })
    return result
  }

  async history(platform: string, kind: string, id: string, query: URLSearchParams) {
    const [resource] = await this.database.get('resources', { platform, kind, id }, { fields: ['pk'] } as any)
    if (!resource) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'resource was not found')
    const activeDefinitions = this.mediaSync.resolveUpdaterFields(platform, kind).resourceHistories ?? {}
    const available = new Set<string>([...historyCoreFields, ...Object.keys(activeDefinitions)])
    const requested = optionalText(query.get('metrics'), 'metrics', 1000)?.split(',').map((item) => item.trim()).filter(Boolean)
    const metrics = requested?.length ? [...new Set(requested)] : [...available]
    const invalidMetrics = metrics.filter((metric) => !available.has(metric))
    if (invalidMetrics.length) {
      throw new ApiError(400, 'INVALID_METRIC', 'one or more metrics are not available', { metrics: invalidMetrics })
    }
    const from = parseDate(query.get('from'), 'from')
    const to = parseDate(query.get('to'), 'to')
    if (from && to && from > to) throw new ApiError(400, 'INVALID_DATE_RANGE', 'from must not be later than to')
    const orderValue = query.get('order') ?? 'asc'
    if (orderValue !== 'asc' && orderValue !== 'desc') {
      throw new ApiError(400, 'INVALID_ORDER', 'order must be asc or desc')
    }
    const signature = querySignature('history', {
      platform, kind, id, metrics, from: from?.toISOString(), to: to?.toISOString(), order: orderValue,
    })
    const page = parsePagination(query, signature, Math.min(1000, this.limits.maxHistoryPoints), this.limits.maxHistoryPoints)
    const filter: Row = { resourcePk: resource.pk }
    if (from || to) {
      filter.capturedAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) }
    }
    const rows = await this.database.get('resource_histories', filter as any, {
      limit: page.limit + 1,
      offset: page.offset,
      sort: { capturedAt: orderValue, pk: orderValue },
    } as any)
    const coreMetrics = new Set(historyCoreFields)
    const data = (rows as Row[]).map((row) => ({
      capturedAt: dateIso(row.capturedAt),
      ...Object.fromEntries(metrics.filter((name) => coreMetrics.has(name as any)).map((name) => [name, row[name] ?? null])),
      extensions: Object.fromEntries(metrics.filter((name) => !coreMetrics.has(name as any)).map((name) => [name, row[name] ?? null])),
    }))
    return pageResult(data, page)
  }

  async listAuthors(platform: string, kind: string, query: URLSearchParams) {
    const name = optionalText(query.get('q'), 'q')
    const includePlaceholders = booleanQuery(query.get('includePlaceholders'), 'includePlaceholders')
    const signature = querySignature('authors', { platform, kind, name, includePlaceholders })
    const page = parsePagination(query, signature, this.limits.defaultLimit, this.limits.maxLimit)
    const target = await this.targetAuthorLinks(platform, kind)
    const authorPks = [...target.authorPks]
    if (!authorPks.length) return pageResult([], page)
    const filter: Row = { platform, pk: authorPks }
    if (name) filter.name = textFilter(name)
    if (!includePlaceholders) filter.isPlaceholder = false
    const rows = await this.database.get('authors', filter as any, {
      limit: page.limit + 1,
      offset: page.offset,
      sort: { lastSyncedAt: 'desc', pk: 'desc' },
    } as any)
    const data = (rows as Row[]).map((row) => this.serializeAuthor(
      row,
      platform,
      kind,
      target.counts.get(row.pk) ?? 0,
    ))
    return pageResult(data, page)
  }

  async getAuthor(platform: string, kind: string, id: string) {
    const [row] = await this.database.get('authors', { platform, id })
    if (!row) throw new ApiError(404, 'AUTHOR_NOT_FOUND', 'author was not found')
    const resourcePks = await this.resourcePksForAuthorId(row.pk, platform, kind)
    return { data: this.serializeAuthor(row as Row, platform, kind, resourcePks.length) }
  }

  async authorResources(platform: string, kind: string, id: string, query: URLSearchParams) {
    const [author] = await this.database.get('authors', { platform, id }, { fields: ['pk'] } as any)
    if (!author) throw new ApiError(404, 'AUTHOR_NOT_FOUND', 'author was not found')
    const signature = querySignature('author-resources', { platform, kind, id })
    const page = parsePagination(query, signature, this.limits.defaultLimit, this.limits.maxLimit)
    const resourcePks = await this.resourcePksForAuthorId(author.pk, platform, kind)
    if (!resourcePks.length) return pageResult([], page)
    const rows = await this.database.get('resources', { pk: resourcePks, platform, kind }, {
      limit: page.limit + 1,
      offset: page.offset,
      sort: { publishTime: 'desc', pk: 'desc' },
    } as any)
    return pageResult(await this.serializeResources(rows as Row[], platform, kind), page)
  }

  async health() {
    try {
      await this.database.stats()
      return { data: { status: 'ok', database: 'ready' } }
    } catch {
      throw new ApiError(503, 'DATABASE_NOT_READY', 'database is not ready')
    }
  }

  private async serializeResources(rows: Row[], platform: string, kind: string) {
    const resourceDefinitions = this.mediaSync.resolveUpdaterFields(platform, kind).resources ?? {}
    const authors = await this.authorMapForResources(rows.map((row) => row.pk), platform, kind)
    return rows.map((row) => ({
      platform: row.platform,
      kind: row.kind,
      id: row.id,
      title: row.title,
      coverUrl: row.coverUrl,
      description: row.description,
      publishTime: dateIso(row.publishTime),
      duration: row.duration,
      firstSeenAt: dateIso(row.firstSeenAt),
      lastSeenAt: dateIso(row.lastSeenAt),
      lastSyncedAt: dateIso(row.lastSyncedAt),
      authors: authors.get(row.pk) ?? [],
      extensions: extensionValues(row, resourceDefinitions),
    }))
  }

  private serializeAuthor(row: Row, platform: string, kind: string, resourceCount?: number, relation?: Row) {
    const definitions = this.mediaSync.resolveUpdaterFields(platform, kind).authors ?? {}
    return {
      platform: row.platform,
      id: row.id,
      name: row.name,
      avatarUrl: row.avatarUrl,
      description: row.description,
      isPlaceholder: row.isPlaceholder,
      firstSeenAt: dateIso(row.firstSeenAt),
      lastSeenAt: dateIso(row.lastSeenAt),
      lastSyncedAt: dateIso(row.lastSyncedAt),
      ...(resourceCount === undefined ? {} : { resourceCount }),
      ...(relation ? {
        relation: {
          isPrimary: relation.isPrimary,
          sortOrder: relation.sortOrder,
          role: relation.role,
        },
      } : {}),
      extensions: extensionValues(row, definitions),
    }
  }

  private async authorMapForResources(resourcePks: number[], platform: string, kind: string) {
    const result = new Map<number, Row[]>()
    if (!resourcePks.length) return result
    const links = await this.linksForResourcePks(resourcePks)
    const authorPks = [...new Set(links.map((link) => link.authorPk))]
    const authorRows: Row[] = []
    for (const chunk of split(authorPks)) {
      authorRows.push(...await this.database.get('authors', { pk: chunk }) as Row[])
    }
    const byPk = new Map(authorRows.map((author) => [author.pk, author]))
    links.sort((a, b) => {
      return (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
        || a.pk - b.pk
    })
    for (const link of links) {
      const author = byPk.get(link.authorPk)
      if (!author) continue
      const values = result.get(link.resourcePk) ?? []
      values.push(this.serializeAuthor(author, platform, kind, undefined, link))
      result.set(link.resourcePk, values)
    }
    return result
  }

  private async resourcePksForAuthor(platform: string, id?: string, name?: string) {
    const authorFilter: Row = { platform }
    if (id) authorFilter.id = id
    if (name) authorFilter.name = textFilter(name)
    const authors = await this.database.get('authors', authorFilter as any, { fields: ['pk'] } as any)
    if (!authors.length) return []
    const resourcePks = new Set<number>()
    for (const chunk of split(authors.map((author) => author.pk))) {
      const links = await this.database.get('resource_authors', { authorPk: chunk }, { fields: ['resourcePk'] } as any)
      for (const link of links) resourcePks.add(link.resourcePk)
    }
    return [...resourcePks]
  }

  private async targetAuthorLinks(platform: string, kind: string) {
    const resources = await this.database.get('resources', { platform, kind }, { fields: ['pk'] } as any)
    const links = await this.linksForResourcePks(resources.map((resource) => resource.pk))
    const authorPks = new Set<number>()
    const counts = new Map<number, number>()
    for (const link of links) {
      authorPks.add(link.authorPk)
      counts.set(link.authorPk, (counts.get(link.authorPk) ?? 0) + 1)
    }
    return { authorPks, counts }
  }

  private async resourcePksForAuthorId(authorPk: number, platform: string, kind: string) {
    const links = await this.database.get('resource_authors', { authorPk }, { fields: ['resourcePk'] } as any)
    if (!links.length) return []
    const result: number[] = []
    for (const chunk of split(links.map((link) => link.resourcePk))) {
      const rows = await this.database.get('resources', { pk: chunk, platform, kind }, { fields: ['pk'] } as any)
      result.push(...rows.map((row) => row.pk))
    }
    return result
  }

  private async linksForResourcePks(resourcePks: number[]) {
    const links: Row[] = []
    for (const chunk of split(resourcePks)) {
      links.push(...await this.database.get('resource_authors', { resourcePk: chunk }) as Row[])
    }
    return links
  }
}

function direction(capturedTime: number, targetTime: number) {
  if (capturedTime < targetTime) return 'before'
  if (capturedTime > targetTime) return 'after'
  return 'exact'
}
