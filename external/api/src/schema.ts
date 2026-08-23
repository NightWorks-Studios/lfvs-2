import { Field } from '@cordisjs/plugin-database'
import type { FieldDef, MediaSync, UpdaterFieldExtension } from '@lfvs/core'

const coreFields = {
  authors: {
    platform: { type: 'string', length: 64, nullable: false }, id: { type: 'string', length: 255, nullable: false },
    name: { type: 'string', nullable: true },
    avatarUrl: { type: 'string', nullable: true }, description: { type: 'text', nullable: true },
    isPlaceholder: { type: 'boolean', nullable: false }, firstSeenAt: { type: 'timestamp', nullable: false },
    lastSeenAt: { type: 'timestamp', nullable: false },
    lastSyncedAt: { type: 'timestamp', nullable: true },
  },
  resources: {
    platform: { type: 'string', length: 64, nullable: false }, kind: { type: 'string', length: 64, nullable: false },
    id: { type: 'string', length: 255, nullable: false }, title: { type: 'string', nullable: false },
    coverUrl: { type: 'string', nullable: true }, description: { type: 'text', nullable: true },
    publishTime: { type: 'timestamp', nullable: true }, duration: { type: 'integer', nullable: true },
    firstSeenAt: { type: 'timestamp', nullable: false }, lastSeenAt: { type: 'timestamp', nullable: false },
    lastSyncedAt: { type: 'timestamp', nullable: true },
    authors: 'json',
  },
  resourceHistories: {
    capturedAt: { type: 'timestamp', nullable: false }, playCount: { type: 'bigint', nullable: true },
    likeCount: { type: 'bigint', nullable: true }, commentCount: { type: 'bigint', nullable: true },
    shareCount: { type: 'bigint', nullable: true }, favoriteCount: { type: 'bigint', nullable: true },
  },
} satisfies Record<string, Record<string, FieldDef>>

function describeField(definition: FieldDef, owners: string[] = []) {
  if (definition === 'json') {
    return { type: 'json', jsonType: 'object', nullable: false, ...(owners.length ? { owners } : {}) }
  }
  const field = Field.parse(definition as any)
  const type = String(field.deftype ?? field.type ?? 'unknown')
  const jsonType = type === 'bigint' ? 'string'
    : type === 'timestamp' || type === 'date' || type === 'time' ? 'string'
      : type === 'boolean' ? 'boolean'
        : type === 'integer' || type === 'unsigned' || type === 'float' || type === 'double' || type === 'decimal' ? 'number'
          : type === 'json' ? 'any'
            : 'string'
  return {
    type,
    jsonType,
    nullable: field.nullable ?? true,
    indexed: typeof definition === 'object' && !!definition.indexed,
    ...(owners.length ? { owners } : {}),
  }
}

function extensionSchema(
  mediaSync: MediaSync,
  platform: string,
  kind: string,
  section: keyof UpdaterFieldExtension,
) {
  const registrations = mediaSync.listUpdaterFieldExtensions({ platform, kind })
  const fields = mediaSync.resolveUpdaterFields(platform, kind)[section] ?? {}
  return Object.fromEntries(Object.entries(fields).map(([name, definition]) => {
    const owners = registrations
      .filter((registration) => Object.hasOwn(registration.fields[section] ?? {}, name))
      .map((registration) => registration.owner)
    return [name, describeField(definition, owners)]
  }))
}

export function targetSchema(mediaSync: MediaSync, platform: string, kind: string) {
  return {
    platform,
    kind,
    authors: {
      core: Object.fromEntries(Object.entries(coreFields.authors).map(([name, definition]) => [name, describeField(definition)])),
      extensions: extensionSchema(mediaSync, platform, kind, 'authors'),
    },
    resources: {
      core: Object.fromEntries(Object.entries(coreFields.resources).map(([name, definition]) => [
        name,
        name === 'authors'
          ? { type: 'json', jsonType: 'array', nullable: false, indexed: false }
          : describeField(definition),
      ])),
      extensions: extensionSchema(mediaSync, platform, kind, 'resources'),
    },
    resourceHistories: {
      core: Object.fromEntries(Object.entries(coreFields.resourceHistories).map(([name, definition]) => [name, describeField(definition)])),
      extensions: extensionSchema(mediaSync, platform, kind, 'resourceHistories'),
    },
  }
}

export const historyCoreFields = ['playCount', 'likeCount', 'commentCount', 'shareCount', 'favoriteCount'] as const
