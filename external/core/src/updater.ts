function assertNonEmpty(value: string, name: string) {
  if (!value || !value.trim()) throw new TypeError(`${name} must not be empty`)
}

export type UpdaterRunSource = 'schedule' | 'manual' | 'startup'
export type UpdaterRunSummary = Record<string, string | number | boolean | null>

export interface UpdaterDefinition {
  id: string
  label?: string
  platform: string
  kind: string
  cron?: string
  manualTrigger?: boolean
  run(source: UpdaterRunSource): Promise<UpdaterRunSummary | void>
}

export interface UpdaterRuntimeInfo {
  id: string
  label: string
  platform: string
  kind: string
  cron?: string
  manualTrigger: boolean
  registeredAt: number
  running: boolean
  lastSource?: UpdaterRunSource
  lastStartedAt?: number
  lastFinishedAt?: number
  lastResult?: UpdaterRunSummary
  lastError?: string
}

export interface UpdaterRunResponse {
  started: boolean
  reason?: 'running'
  result?: UpdaterRunSummary
}

interface UpdaterEntry {
  definition: UpdaterDefinition
  runtime: UpdaterRuntimeInfo
}

export class UpdaterRegistry {
  private readonly entries = new Map<string, UpdaterEntry>()

  register(definition: UpdaterDefinition) {
    const normalized: UpdaterDefinition = {
      ...definition,
      id: definition.id.trim(),
      label: definition.label?.trim() || definition.id.trim(),
      platform: definition.platform.trim(),
      kind: definition.kind.trim(),
      cron: definition.cron?.trim() || undefined,
      manualTrigger: definition.manualTrigger ?? false,
    }
    assertNonEmpty(normalized.id, 'updater.id')
    assertNonEmpty(normalized.platform, 'updater.platform')
    assertNonEmpty(normalized.kind, 'updater.kind')
    if (typeof normalized.run !== 'function') throw new TypeError('updater.run must be a function')
    if (this.entries.has(normalized.id)) throw new Error(`updater already registered: ${normalized.id}`)

    const entry: UpdaterEntry = {
      definition: normalized,
      runtime: {
        id: normalized.id,
        label: normalized.label!,
        platform: normalized.platform,
        kind: normalized.kind,
        ...(normalized.cron ? { cron: normalized.cron } : {}),
        manualTrigger: normalized.manualTrigger!,
        registeredAt: Date.now(),
        running: false,
      },
    }
    this.entries.set(normalized.id, entry)
    return () => {
      if (this.entries.get(normalized.id) === entry) this.entries.delete(normalized.id)
    }
  }

  list(): UpdaterRuntimeInfo[] {
    return [...this.entries.values()]
      .map(({ runtime }) => cloneRuntime(runtime))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  get(id: string) {
    const runtime = this.entries.get(id)?.runtime
    return runtime ? cloneRuntime(runtime) : undefined
  }

  async run(id: string, source: UpdaterRunSource = 'schedule'): Promise<UpdaterRunResponse> {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`updater is not registered: ${id}`)
    if (source === 'manual' && !entry.definition.manualTrigger) {
      throw new Error(`updater does not allow manual triggering: ${id}`)
    }
    if (entry.runtime.running) return { started: false, reason: 'running' }

    entry.runtime.running = true
    entry.runtime.lastSource = source
    entry.runtime.lastStartedAt = Date.now()
    delete entry.runtime.lastFinishedAt
    delete entry.runtime.lastResult
    delete entry.runtime.lastError
    try {
      const result = await entry.definition.run(source)
      if (result) entry.runtime.lastResult = { ...result }
      return { started: true, ...(result ? { result: { ...result } } : {}) }
    } catch (error) {
      entry.runtime.lastError = errorMessage(error)
      throw error
    } finally {
      entry.runtime.running = false
      entry.runtime.lastFinishedAt = Date.now()
    }
  }
}

function cloneRuntime(runtime: UpdaterRuntimeInfo): UpdaterRuntimeInfo {
  return {
    ...runtime,
    ...(runtime.lastResult ? { lastResult: { ...runtime.lastResult } } : {}),
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}
