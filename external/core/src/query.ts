import type { Database } from '@cordisjs/plugin-database'
import type { SyncAuthorTarget, SyncResourceTarget } from './types.js'

export class SyncQueryService {
  constructor(private readonly database: Database) {}

  async listResourcesForSync(input: {
    platform: string
    kind: string
    limit?: number
    afterPk?: number
  }): Promise<SyncResourceTarget[]> {
    const cursor: Record<string, unknown> = {
      fields: ['pk', 'id', 'lastSyncedAt'],
      // A primary-key cursor is stable while an update changes lastSyncedAt.
      sort: { pk: 'asc' },
    }
    if (input.limit !== undefined) cursor.limit = input.limit
    const rows = await this.database.get('resources', {
      platform: input.platform,
      kind: input.kind,
      ...(input.afterPk === undefined ? {} : { pk: { $gt: input.afterPk } }),
    }, cursor as any)
    return rows.map((row) => ({
      pk: row.pk,
      id: row.id,
      ...(row.lastSyncedAt ? { lastSyncedAt: row.lastSyncedAt.getTime() } : {}),
    }))
  }

  async listExistingResourceIds(input: {
    platform: string
    kind: string
    ids: string[]
  }): Promise<string[]> {
    if (!input.ids.length) return []
    const rows = await this.database.get('resources', {
      platform: input.platform,
      kind: input.kind,
      id: input.ids,
    }, {
      fields: ['id'],
    } as any)
    return rows.map((row) => row.id)
  }

  async listAuthorsForSync(input: {
    platform: string
    limit: number
  }): Promise<SyncAuthorTarget[]> {
    const rows = await this.database.get('authors', {
      platform: input.platform,
    }, {
      limit: input.limit,
      fields: ['pk', 'id', 'lastSyncedAt'],
      sort: { lastSyncedAt: 'asc' },
    } as any)
    return rows.map((row) => ({
      pk: row.pk,
      id: row.id,
      ...(row.lastSyncedAt ? { lastSyncedAt: row.lastSyncedAt.getTime() } : {}),
    }))
  }
}
