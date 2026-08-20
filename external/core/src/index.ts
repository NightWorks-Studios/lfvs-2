import { Service, type Context } from 'cordis'
import type { Database } from '@cordisjs/plugin-database'
import { CheckpointStore } from './checkpoint.js'
import { ResourceModelService } from './model.js'
import { SyncQueryService } from './query.js'
import { AdapterRegistry } from './registry.js'
import { ResourceStore } from './store.js'
import type { UpdaterFieldExtension } from './model.js'
import type { ResourceAdapter } from './types.js'

export * from './checkpoint.js'
export * from './model.js'
export * from './query.js'
export * from './registry.js'
export * from './store.js'
export * from './types.js'

export const inject = ['database']

declare module 'cordis' {
  interface Context {
    mediaSync: MediaSync
  }
}

export class MediaSync extends Service {
  readonly adapterRegistry: AdapterRegistry
  readonly resourceModel: ResourceModelService
  readonly checkpointStore: CheckpointStore
  readonly syncQuery: SyncQueryService
  readonly resourceStore: ResourceStore

  constructor(ctx: Context) {
    super(ctx, 'mediaSync')
    const database = ctx.database as Database
    this.adapterRegistry = new AdapterRegistry()
    this.resourceModel = new ResourceModelService(database)
    this.checkpointStore = new CheckpointStore(database)
    this.syncQuery = new SyncQueryService(database)
    this.resourceStore = new ResourceStore(database, this.resourceModel)
  }

  registerAdapter(adapter: ResourceAdapter) {
    return this.adapterRegistry.register(adapter)
  }

  registerUpdaterFields(owner: string, fields: UpdaterFieldExtension) {
    return this.resourceModel.extend(owner, fields)
  }

  async [Service.init]() {
    await (this.ctx.database as Database).prepared()
  }
}

export function apply(ctx: Context) {
  const service = new MediaSync(ctx)
  return service[Service.init]()
}

export default { apply, inject }
