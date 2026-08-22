import { Field, type Database, type Model } from '@cordisjs/plugin-database'
import type { FieldDef } from './types.js'

export interface UpdaterFieldExtension {
  authors?: Record<string, FieldDef>
  resources?: Record<string, FieldDef>
  resourceHistories?: Record<string, FieldDef>
}

export interface UpdaterFieldRegistration {
  owner: string
  platform: string
  kind: string
  fields: UpdaterFieldExtension
}

export interface ActiveUpdaterFieldRegistration extends UpdaterFieldRegistration {
  registeredAt: number
}

/** @deprecated Extension fields are owned by updater instances. */
export type AdapterFieldExtension = UpdaterFieldExtension

type FieldOwner = 'authors' | 'resources' | 'resourceHistories'

const tableNames: Record<FieldOwner, string> = {
  authors: 'authors',
  resources: 'resources',
  resourceHistories: 'resource_histories',
}

const coreFields: Record<FieldOwner, Record<string, FieldDef>> = {
  authors: {
    pk: 'unsigned(8)', platform: 'string(64)', id: 'string(255)', name: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true }, description: { type: 'text', nullable: true },
    isPlaceholder: { type: 'boolean', initial: false }, firstSeenAt: 'timestamp', lastSeenAt: 'timestamp',
    lastSyncedAt: { type: 'timestamp', nullable: true },
  },
  resources: {
    pk: 'unsigned(8)', platform: 'string(64)', kind: 'string(64)', id: 'string(255)', title: 'string',
    coverUrl: { type: 'string', nullable: true }, description: { type: 'text', nullable: true },
    publishTime: { type: 'timestamp', nullable: true }, duration: { type: 'integer', nullable: true },
    firstSeenAt: 'timestamp', lastSeenAt: 'timestamp', lastSyncedAt: { type: 'timestamp', nullable: true },
  },
  resourceHistories: {
    pk: 'unsigned(8)', resourcePk: 'unsigned(8)', platform: 'string(64)', kind: 'string(64)', id: 'string(255)',
    capturedAt: 'timestamp', playCount: { type: 'bigint', nullable: true }, likeCount: { type: 'bigint', nullable: true },
    commentCount: { type: 'bigint', nullable: true }, shareCount: { type: 'bigint', nullable: true },
    favoriteCount: { type: 'bigint', nullable: true },
  },
}

function fieldSignature(def: FieldDef) {
  const field = Field.parse(def as any)
  return JSON.stringify({
    type: field.deftype,
    nullable: field.nullable ?? true,
    initial: field.initial ?? null,
    length: field.length,
    precision: field.precision,
    scale: field.scale,
    indexed: typeof def === 'object' && !!def.indexed,
  })
}

function cloneFields(fields: Record<string, FieldDef>) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === 'object' ? { ...value } : value]))
}

export class ResourceModelService {
  private readonly extensions: Record<FieldOwner, Record<string, FieldDef>> = {
    authors: {}, resources: {}, resourceHistories: {},
  }
  private readonly activeExtensions = new Map<string, ActiveUpdaterFieldRegistration>()
  private registrationQueue = Promise.resolve()

  constructor(private readonly database: Database) {
    this.extendCoreModels()
  }

  registerUpdaterFields(input: UpdaterFieldRegistration): Promise<() => void> {
    const registration = {
      owner: input.owner.trim(),
      platform: input.platform.trim(),
      kind: input.kind.trim(),
      fields: cloneExtension(input.fields),
    }
    const task = this.registrationQueue.then(() => this.applyUpdaterFields(registration))
    this.registrationQueue = task.then(() => undefined, () => undefined)
    return task
  }

  listUpdaterFieldExtensions(filter: { platform?: string; kind?: string } = {}) {
    return [...this.activeExtensions.values()]
      .filter((item) => !filter.platform || item.platform === filter.platform)
      .filter((item) => !filter.kind || item.kind === filter.kind)
      .sort((a, b) => a.owner.localeCompare(b.owner) || a.platform.localeCompare(b.platform) || a.kind.localeCompare(b.kind))
      .map(cloneRegistration)
  }

  resolveUpdaterFields(platform: string, kind: string): UpdaterFieldExtension {
    const result: UpdaterFieldExtension = {}
    for (const registration of this.listUpdaterFieldExtensions({ platform, kind })) {
      for (const key of Object.keys(tableNames) as FieldOwner[]) {
        const fields = registration.fields[key]
        if (!fields) continue
        Object.assign(result[key] ??= {}, cloneFields(fields))
      }
    }
    return result
  }

  private async applyUpdaterFields(input: UpdaterFieldRegistration) {
    if (!input.owner) throw new TypeError('field owner must not be empty')
    if (!input.platform) throw new TypeError('field platform must not be empty')
    if (!input.kind) throw new TypeError('field kind must not be empty')
    const registrationKey = this.registrationKey(input)
    if (this.activeExtensions.has(registrationKey)) {
      throw new Error(`updater fields already registered for ${input.owner} (${input.platform}/${input.kind})`)
    }

    const pendingIndexes: Array<{ table: string; indexes: string[][] }> = []
    for (const [key, entries] of Object.entries(input.fields) as [FieldOwner, Record<string, FieldDef> | undefined][]) {
      if (!entries) continue
      if (!Object.hasOwn(tableNames, key)) throw new Error(`unsupported field owner: ${key}`)
      for (const [fieldName, definition] of Object.entries(entries)) {
        if (!/^[a-z][A-Za-z0-9]*$/.test(fieldName)) throw new TypeError(`invalid extension field name: ${fieldName}`)
        if (fieldName in coreFields[key]) throw new Error(`extension field cannot override core field: ${key}.${fieldName}`)
        const previous = this.extensions[key][fieldName]
        if (previous && fieldSignature(previous) !== fieldSignature(definition)) {
          throw new Error(`conflicting field definition for ${key}.${fieldName} (owner: ${input.owner})`)
        }
      }
    }

    let schemaChanged = false
    for (const [key, entries] of Object.entries(input.fields) as [FieldOwner, Record<string, FieldDef> | undefined][]) {
      if (!entries) continue
      const newEntries = Object.fromEntries(
        Object.entries(entries).filter(([fieldName]) => !(fieldName in this.extensions[key])),
      ) as Record<string, FieldDef>
      if (!Object.keys(newEntries).length) continue
      const indexes = Object.entries(newEntries)
        .filter(([, definition]) => typeof definition === 'object' && !!definition.indexed)
        .map(([fieldName]) => [fieldName])
      this.database.extend(tableNames[key] as any, newEntries as any)
      schemaChanged = true
      if (indexes.length) pendingIndexes.push({ table: tableNames[key], indexes })
    }
    if (schemaChanged) await this.database.prepared()
    for (const { table, indexes } of pendingIndexes) {
      this.database.extend(table as any, {}, { indexes } as any)
    }
    if (pendingIndexes.length) await this.database.prepared()

    for (const [key, entries] of Object.entries(input.fields) as [FieldOwner, Record<string, FieldDef> | undefined][]) {
      if (entries) Object.assign(this.extensions[key], cloneFields(entries))
    }
    const active: ActiveUpdaterFieldRegistration = { ...input, fields: cloneExtension(input.fields), registeredAt: Date.now() }
    this.activeExtensions.set(registrationKey, active)
    return () => {
      if (this.activeExtensions.get(registrationKey) === active) this.activeExtensions.delete(registrationKey)
    }
  }

  getAuthorsFields() {
    return { ...cloneFields(coreFields.authors), ...cloneFields(this.extensions.authors) }
  }

  getAuthorExtensionFields() {
    return cloneFields(this.extensions.authors)
  }

  getResourcesFields() {
    return { ...cloneFields(coreFields.resources), ...cloneFields(this.extensions.resources) }
  }

  getResourceExtensionFields() {
    return cloneFields(this.extensions.resources)
  }

  getResourceHistoriesFields() {
    return { ...cloneFields(coreFields.resourceHistories), ...cloneFields(this.extensions.resourceHistories) }
  }

  getResourceHistoryExtensionFields() {
    return cloneFields(this.extensions.resourceHistories)
  }

  private extendCoreModels() {
    this.database.extend('authors', coreFields.authors as any, {
      autoInc: true,
      primary: 'pk',
      unique: [['platform', 'id']],
      indexes: [['platform', 'lastSyncedAt']],
    })
    this.database.extend('resources', coreFields.resources as any, {
      autoInc: true,
      primary: 'pk',
      unique: [['platform', 'kind', 'id']],
      indexes: [['platform', 'kind', 'publishTime'], ['platform', 'kind', 'lastSyncedAt']],
    })
    this.database.extend('resource_authors', {
      pk: 'unsigned(8)', resourcePk: 'unsigned(8)', authorPk: 'unsigned(8)',
      isPrimary: { type: 'boolean', nullable: true }, sortOrder: { type: 'integer', nullable: true },
      role: { type: 'string', nullable: true }, createdAt: 'timestamp', updatedAt: 'timestamp',
    } as any, {
      autoInc: true,
      primary: 'pk',
      unique: [['resourcePk', 'authorPk']],
      indexes: [['authorPk', 'resourcePk'], ['resourcePk', 'sortOrder']],
      foreign: {
        resourcePk: ['resources', 'pk'],
        authorPk: ['authors', 'pk'],
      },
    })
    this.database.extend('resource_histories', coreFields.resourceHistories as any, {
      autoInc: true,
      primary: 'pk',
      unique: [['resourcePk', 'capturedAt']],
      indexes: [
        { name: 'resource_histories:resourcePk+capturedAt', keys: { resourcePk: 'asc', capturedAt: 'desc' } },
        { name: 'resource_histories:business-key+capturedAt', keys: { platform: 'asc', kind: 'asc', id: 'asc', capturedAt: 'desc' } },
      ],
      foreign: { resourcePk: ['resources', 'pk'] },
    })
    this.database.extend('checkpoints', {
      pk: 'unsigned(8)', updater: 'string(255)', platform: 'string(64)', kind: 'string(64)',
      scopeType: 'string(64)', scopeId: 'string(255)', cursor: { type: 'text', nullable: true },
      page: { type: 'integer', nullable: true }, watermark: { type: 'timestamp', nullable: true },
      extra: { type: 'text', nullable: true }, updatedAt: 'timestamp',
    } as any, {
      autoInc: true,
      primary: 'pk',
      unique: [['updater', 'platform', 'kind', 'scopeType', 'scopeId']],
      indexes: [['updater', 'updatedAt'], ['platform', 'kind', 'updatedAt']],
    })
  }

  private registrationKey(input: Pick<UpdaterFieldRegistration, 'owner' | 'platform' | 'kind'>) {
    return `${input.owner}\0${input.platform}\0${input.kind}`
  }
}

function cloneExtension(fields: UpdaterFieldExtension): UpdaterFieldExtension {
  return {
    ...(fields.authors ? { authors: cloneFields(fields.authors) } : {}),
    ...(fields.resources ? { resources: cloneFields(fields.resources) } : {}),
    ...(fields.resourceHistories ? { resourceHistories: cloneFields(fields.resourceHistories) } : {}),
  }
}

function cloneRegistration(input: ActiveUpdaterFieldRegistration): ActiveUpdaterFieldRegistration {
  return { ...input, fields: cloneExtension(input.fields) }
}

export type CoreModel = Model
