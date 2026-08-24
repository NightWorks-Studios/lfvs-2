import type { Database } from '@cordisjs/plugin-database'
import type { Checkpoint, CheckpointInput, CheckpointKey, CheckpointRow } from './types.js'

function toMillis(value: Date | null | undefined) {
  return value ? value.getTime() : undefined
}

function toDate(value: number | null | undefined) {
  return value === undefined || value === null ? value : new Date(value)
}

export class CheckpointStore {
  constructor(private readonly database: Database) {}

  async get(key: CheckpointKey): Promise<Checkpoint | null> {
    const [row] = await this.database.get('checkpoints', key)
    if (!row) return null
    return this.toCheckpoint(row)
  }

  async list(filter: Partial<CheckpointKey> = {}): Promise<Checkpoint[]> {
    const rows = await this.database.get('checkpoints', filter)
    return rows.map((row) => this.toCheckpoint(row))
  }

  async set(input: CheckpointInput): Promise<void> {
    const now = input.updatedAt ?? Date.now()
    const key: CheckpointKey = {
      updater: input.updater,
      platform: input.platform,
      kind: input.kind,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
    }
    const [currentRow] = await this.database.get('checkpoints', key)
    const current = currentRow ? this.toCheckpoint(currentRow) : null
    const has = (field: keyof CheckpointInput) => Object.hasOwn(input, field)
    const row = {
      ...key,
      cursor: has('cursor') ? input.cursor ?? null : current?.cursor ?? null,
      page: has('page') ? input.page ?? null : current?.page ?? null,
      watermark: has('watermark') ? toDate(input.watermark) : toDate(current?.watermark),
      extra: has('extra') ? input.extra ?? null : current?.extra ?? null,
      updatedAt: new Date(now),
    }
    if (current) {
      await this.database.set('checkpoints', { pk: currentRow.pk }, row as any)
    } else {
      await this.database.create('checkpoints', row as any)
    }
  }

  async remove(key: CheckpointKey) {
    await this.database.remove('checkpoints', key)
  }

  private toCheckpoint(row: CheckpointRow): Checkpoint {
    return {
      updater: row.updater,
      platform: row.platform,
      kind: row.kind,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      ...(row.cursor === null ? {} : { cursor: row.cursor }),
      ...(row.page === null ? {} : { page: row.page }),
      ...(toMillis(row.watermark) === undefined ? {} : { watermark: toMillis(row.watermark) }),
      ...(row.extra === null ? {} : { extra: row.extra }),
      updatedAt: row.updatedAt.getTime(),
    }
  }
}
