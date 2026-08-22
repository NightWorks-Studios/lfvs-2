import type { Database } from '@cordisjs/plugin-database'
import type { ResourceModelService } from './model.js'
import type {
  Author,
  NormalizedAuthor,
  NormalizedResource,
  NormalizedResourceAuthorRef,
  Resource,
} from './types.js'

type TransactionDatabase = Database

function date(value: number) {
  return new Date(value)
}

function newer(value: Date | null | undefined, fallback: number) {
  return Math.max(value?.getTime() ?? 0, fallback)
}

function filterFields(fields: Record<string, unknown> | undefined, declared: Record<string, unknown>) {
  if (!fields) return {}
  return Object.fromEntries(Object.entries(fields).filter(([key]) => key in declared))
}

export class ResourceStore {
  constructor(
    private readonly database: Database,
    private readonly models: ResourceModelService,
  ) {}

  saveAuthor(author: NormalizedAuthor): Promise<Author> {
    return this.database.transact((db) => this.saveAuthorInTransaction(db, author, false))
  }

  saveResource(resource: NormalizedResource): Promise<Resource> {
    return this.saveResourceWithAuthors(resource)
  }

  saveResourceWithAuthors(resource: NormalizedResource, authors: NormalizedAuthor[] = []): Promise<Resource> {
    return this.database.transact(async (db) => {
      const savedAuthors = new Map<string, Author>()
      const relatedAuthors = new Map<string, NormalizedAuthor>()
      for (const author of [...resource.relatedAuthors ?? [], ...authors]) {
        if (author.core.platform !== resource.core.platform) {
          throw new Error(`author platform does not match resource platform: ${author.core.platform}/${resource.core.platform}`)
        }
        relatedAuthors.set(author.core.id, author)
      }
      for (const author of relatedAuthors.values()) {
        const saved = await this.saveAuthorInTransaction(db, author, false)
        savedAuthors.set(author.core.id, saved)
      }
      return this.saveResourceInTransaction(db, resource, savedAuthors)
    })
  }

  private async saveAuthorInTransaction(db: TransactionDatabase, author: NormalizedAuthor, placeholder: boolean) {
    const input = author.core
    const [current] = await db.get('authors', { platform: input.platform, id: input.id })
    const fetchedAt = date(input.fetchedAt)
    const canReplace = !current?.lastSyncedAt || input.fetchedAt >= current.lastSyncedAt.getTime()
    const extension = filterFields(author.extension, this.models.getAuthorExtensionFields())
    const base = {
      platform: input.platform,
      id: input.id,
      ...(canReplace ? {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(Object.keys(extension).length ? extension : {}),
        lastSyncedAt: fetchedAt,
      } : {}),
      lastSeenAt: date(newer(current?.lastSeenAt, input.fetchedAt)),
    }
    if (!current) {
      const row = {
        ...base,
        name: input.name ?? null,
        avatarUrl: input.avatarUrl ?? null,
        description: input.description ?? null,
        isPlaceholder: placeholder,
        firstSeenAt: fetchedAt,
      }
      return db.create('authors', row as any) as Promise<Author>
    }
    await db.set('authors', { pk: current.pk }, {
      ...base,
      isPlaceholder: placeholder ? current.isPlaceholder : canReplace ? false : current.isPlaceholder,
    } as any)
    const [updated] = await db.get('authors', { pk: current.pk })
    return updated
  }

  private async saveResourceInTransaction(
    db: TransactionDatabase,
    resource: NormalizedResource,
    savedAuthors = new Map<string, Author>(),
  ) {
    const input = resource.core
    const [current] = await db.get('resources', { platform: input.platform, kind: input.kind, id: input.id })
    const fetchedAt = date(input.fetchedAt)
    const canReplace = !current?.lastSyncedAt || input.fetchedAt >= current.lastSyncedAt.getTime()
    const extension = filterFields(resource.extension?.resources, this.models.getResourceExtensionFields())
    const currentFields = canReplace ? {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.coverUrl !== undefined ? { coverUrl: input.coverUrl } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.publishTime !== undefined ? { publishTime: input.publishTime === null ? null : date(input.publishTime) } : {}),
      ...(input.duration !== undefined ? { duration: input.duration } : {}),
      ...(Object.keys(extension).length ? extension : {}),
      lastSyncedAt: fetchedAt,
    } : {}
    const base = {
      platform: input.platform,
      kind: input.kind,
      id: input.id,
      ...currentFields,
      lastSeenAt: date(newer(current?.lastSeenAt, input.fetchedAt)),
    }
    let saved: Resource
    if (!current) {
      saved = await db.create('resources', {
        ...base,
        title: input.title,
        coverUrl: input.coverUrl ?? null,
        description: input.description ?? null,
        publishTime: input.publishTime === undefined || input.publishTime === null ? null : date(input.publishTime),
        duration: input.duration ?? null,
        firstSeenAt: fetchedAt,
      } as any) as Resource
    } else {
      await db.set('resources', { pk: current.pk }, base as any)
      const [updated] = await db.get('resources', { pk: current.pk })
      saved = updated
    }

    if (input.authors !== undefined) {
      await this.syncAuthors(db, saved, input.authors, input.authorsMode ?? 'unknown', savedAuthors, input.fetchedAt)
    }
    await this.saveHistory(db, saved, resource)
    return saved
  }

  private async syncAuthors(
    db: TransactionDatabase,
    resource: Resource,
    refs: NormalizedResourceAuthorRef[],
    mode: 'unknown' | 'snapshot',
    savedAuthors: Map<string, Author>,
    fetchedAt: number,
  ) {
    const resolved = []
    const resolvedAuthorPks = new Set<number>()
    for (const ref of refs) {
      const author = savedAuthors.get(ref.id) ?? await this.ensurePlaceholder(db, resource.platform, ref.id, fetchedAt)
      if (resolvedAuthorPks.has(author.pk)) continue
      resolvedAuthorPks.add(author.pk)
      resolved.push({ ref, author })
    }
    const existing = await db.get('resource_authors', { resourcePk: resource.pk })
    const existingByAuthor = new Map(existing.map((row) => [row.authorPk, row]))
    if (mode === 'snapshot') {
      const keep = new Set(resolved.map(({ author }) => author.pk))
      for (const row of existing) {
        if (!keep.has(row.authorPk)) await db.remove('resource_authors', { pk: row.pk })
      }
    }
    const now = date(fetchedAt)
    for (const { ref, author } of resolved) {
      const previous = existingByAuthor.get(author.pk)
      const values = {
        resourcePk: resource.pk,
        authorPk: author.pk,
        isPrimary: ref.isPrimary ?? null,
        sortOrder: ref.sortOrder ?? null,
        role: ref.role ?? null,
        updatedAt: now,
      }
      if (previous) await db.set('resource_authors', { pk: previous.pk }, values as any)
      else await db.create('resource_authors', { ...values, createdAt: now } as any)
    }
  }

  private async ensurePlaceholder(db: TransactionDatabase, platform: string, id: string, fetchedAt: number) {
    const [current] = await db.get('authors', { platform, id })
    if (current) {
      await db.set('authors', { pk: current.pk }, { lastSeenAt: date(newer(current.lastSeenAt, fetchedAt)) })
      return current
    }
    return db.create('authors', {
      platform,
      id,
      name: null,
      avatarUrl: null,
      description: null,
      isPlaceholder: true,
      firstSeenAt: date(fetchedAt),
      lastSeenAt: date(fetchedAt),
      lastSyncedAt: null,
    }) as Promise<Author>
  }

  private async saveHistory(db: TransactionDatabase, resource: Resource, input: NormalizedResource) {
    const capturedAt = date(input.history.capturedAt)
    const [existing] = await db.get('resource_histories', { resourcePk: resource.pk, capturedAt })
    if (existing) return
    const extension = filterFields(input.extension?.resourceHistories, this.models.getResourceHistoryExtensionFields())
    await db.create('resource_histories', {
      resourcePk: resource.pk,
      platform: resource.platform,
      kind: resource.kind,
      id: resource.id,
      capturedAt,
      playCount: input.history.playCount ?? null,
      likeCount: input.history.likeCount ?? null,
      commentCount: input.history.commentCount ?? null,
      shareCount: input.history.shareCount ?? null,
      favoriteCount: input.history.favoriteCount ?? null,
      ...extension,
    } as any)
  }
}
