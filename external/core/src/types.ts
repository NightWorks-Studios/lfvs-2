import type { Database, Field } from '@cordisjs/plugin-database'

export type FieldDef = string | (Field.Definition<any> & { indexed?: boolean })

export interface AdapterCapabilities {
  resourceBatch?: {
    supported: boolean
    maxBatchSize?: number
    recommendedBatchSize?: number
  }
  authorBatch?: {
    supported: boolean
    maxBatchSize?: number
    recommendedBatchSize?: number
  }
  listAuthorResources?: boolean
}

export interface ListResult<T> {
  items: T[]
  nextCursor?: string
  nextPage?: number
  hasMore: boolean
}

export interface ResourceAdapter {
  platform: string
  kind: string
  capabilities: AdapterCapabilities

  getResource(input: { id: string }): Promise<NormalizedResource | null>
  getResources?(input: { ids: string[] }): Promise<NormalizedResource[]>

  getAuthor(input: { id: string }): Promise<NormalizedAuthor | null>
  getAuthors?(input: { ids: string[] }): Promise<NormalizedAuthor[]>

  listAuthorResources?(input: {
    authorId: string
    cursor?: string
    page?: number
    limit?: number
  }): Promise<ListResult<NormalizedResource>>

  internal?: Record<string, unknown>
}

export type NormalizedCompleteness = 'partial' | 'full'

export interface NormalizedAuthor {
  core: {
    platform: string
    id: string
    name?: string | null
    avatarUrl?: string | null
    description?: string | null
    fetchedAt: number
    completeness: NormalizedCompleteness
  }
  extension?: Record<string, unknown>
}

export type NormalizedAuthorsMode = 'unknown' | 'snapshot'

export interface NormalizedResourceAuthorRef {
  id: string
  isPrimary?: boolean
  sortOrder?: number
  role?: string | null
}

export interface NormalizedResource {
  core: {
    platform: string
    kind: string
    id: string
    title: string
    coverUrl?: string | null
    description?: string | null
    authors?: NormalizedResourceAuthorRef[]
    authorsMode?: NormalizedAuthorsMode
    publishTime?: number | null
    duration?: number | null
    fetchedAt: number
    completeness: NormalizedCompleteness
  }
  history: {
    capturedAt: number
    playCount?: number | bigint | null
    likeCount?: number | bigint | null
    commentCount?: number | bigint | null
    shareCount?: number | bigint | null
    favoriteCount?: number | bigint | null
  }
  extension?: {
    resources?: Record<string, unknown>
    resourceHistories?: Record<string, unknown>
  }
}

export interface Author {
  pk: number
  platform: string
  id: string
  name: string | null
  avatarUrl: string | null
  description: string | null
  isPlaceholder: boolean
  firstSeenAt: Date
  lastSeenAt: Date
  lastSyncedAt: Date | null
}

export interface Resource {
  pk: number
  platform: string
  kind: string
  id: string
  title: string
  coverUrl: string | null
  description: string | null
  publishTime: Date | null
  duration: number | null
  firstSeenAt: Date
  lastSeenAt: Date
  lastSyncedAt: Date | null
}

export interface ResourceAuthor {
  pk: number
  resourcePk: number
  authorPk: number
  isPrimary: boolean | null
  sortOrder: number | null
  role: string | null
  createdAt: Date
  updatedAt: Date
}

export interface ResourceHistory {
  pk: number
  resourcePk: number
  platform: string
  kind: string
  id: string
  capturedAt: Date
  playCount: number | bigint | null
  likeCount: number | bigint | null
  commentCount: number | bigint | null
  shareCount: number | bigint | null
  favoriteCount: number | bigint | null
}

export interface CheckpointRow {
  pk: number
  updater: string
  platform: string
  kind: string
  scopeType: string
  scopeId: string
  cursor: string | null
  page: number | null
  watermark: Date | null
  extra: string | null
  updatedAt: Date
}

export interface Checkpoint {
  updater: string
  platform: string
  kind: string
  scopeType: string
  scopeId: string
  cursor?: string
  page?: number
  watermark?: number
  extra?: string
  updatedAt: number
}

export type CheckpointInput = Omit<Checkpoint, 'updatedAt' | 'cursor' | 'page' | 'watermark' | 'extra'> & {
  cursor?: string | null
  page?: number | null
  watermark?: number | null
  extra?: string | null
  updatedAt?: number
}

export interface CheckpointKey {
  updater: string
  platform: string
  kind: string
  scopeType: string
  scopeId: string
}

export interface SyncResourceTarget {
  pk: number
  id: string
  lastSyncedAt?: number
}

export interface SyncAuthorTarget {
  pk: number
  id: string
  lastSyncedAt?: number
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    authors: Author
    resources: Resource
    resource_authors: ResourceAuthor
    resource_histories: ResourceHistory
    checkpoints: CheckpointRow
  }
}

export type CoreDatabase = Database
