import type { ResourceAdapter } from './types.js'

function assertNonEmpty(value: string, name: string) {
  if (!value || !value.trim()) throw new TypeError(`${name} must not be empty`)
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, ResourceAdapter>()

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
    this.adapters.set(key, adapter)
    return () => this.unregister(adapter.platform, adapter.kind)
  }

  unregister(platform: string, kind: string) {
    this.adapters.delete(this.key(platform, kind))
  }

  get(platform: string, kind: string) {
    return this.adapters.get(this.key(platform, kind))
  }

  list() {
    return [...this.adapters.values()]
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
