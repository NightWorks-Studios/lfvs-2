import type { ResourceAdapter } from './types.js'

export interface AdapterRuntimeInfo {
  platform: string
  kind: string
  capabilities: ResourceAdapter['capabilities']
  registeredAt: number
}

interface AdapterEntry {
  adapter: ResourceAdapter
  registeredAt: number
}

function assertNonEmpty(value: string, name: string) {
  if (!value || !value.trim()) throw new TypeError(`${name} must not be empty`)
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, AdapterEntry>()

  register(adapter: ResourceAdapter) {
    assertNonEmpty(adapter.platform, 'adapter.platform')
    assertNonEmpty(adapter.kind, 'adapter.kind')
    if (typeof adapter.getResource !== 'function') throw new TypeError('adapter.getResource is required')
    if (typeof adapter.getAuthor !== 'function') throw new TypeError('adapter.getAuthor is required')

    const key = this.key(adapter.platform, adapter.kind)
    if (this.adapters.has(key)) {
      throw new Error(`adapter already registered for ${adapter.platform}/${adapter.kind}`)
    }

    this.assertCapabilities(adapter)
    this.adapters.set(key, { adapter, registeredAt: Date.now() })
    return () => this.unregister(adapter.platform, adapter.kind)
  }

  unregister(platform: string, kind: string) {
    this.adapters.delete(this.key(platform, kind))
  }

  get(platform: string, kind: string) {
    return this.adapters.get(this.key(platform, kind))?.adapter
  }

  list() {
    return [...this.adapters.values()].map(({ adapter }) => adapter)
  }

  describe(): AdapterRuntimeInfo[] {
    return [...this.adapters.values()]
      .map(({ adapter, registeredAt }) => ({
        platform: adapter.platform,
        kind: adapter.kind,
        capabilities: cloneCapabilities(adapter.capabilities),
        registeredAt,
      }))
      .sort((a, b) => a.platform.localeCompare(b.platform) || a.kind.localeCompare(b.kind))
  }

  private key(platform: string, kind: string) {
    return `${platform}\0${kind}`
  }

  private assertCapabilities(adapter: ResourceAdapter) {
    const { capabilities } = adapter
    if (capabilities.resourceBatch?.supported !== !!adapter.getResources) {
      throw new Error(`resourceBatch capability does not match getResources for ${adapter.platform}/${adapter.kind}`)
    }
    if (capabilities.authorBatch?.supported !== !!adapter.getAuthors) {
      throw new Error(`authorBatch capability does not match getAuthors for ${adapter.platform}/${adapter.kind}`)
    }
    if (!!capabilities.listAuthorResources !== !!adapter.listAuthorResources) {
      throw new Error(`listAuthorResources capability does not match adapter implementation for ${adapter.platform}/${adapter.kind}`)
    }
  }
}

function cloneCapabilities(capabilities: ResourceAdapter['capabilities']): ResourceAdapter['capabilities'] {
  return {
    ...(capabilities.resourceBatch ? { resourceBatch: { ...capabilities.resourceBatch } } : {}),
    ...(capabilities.authorBatch ? { authorBatch: { ...capabilities.authorBatch } } : {}),
    ...(capabilities.listAuthorResources !== undefined ? { listAuthorResources: capabilities.listAuthorResources } : {}),
  }
}
