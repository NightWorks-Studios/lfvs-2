# 多平台资源采集系统设计

## 1. 目标

本系统用于定期采集特定平台上的资源数据，并将数据持久化到本地，供后续查询与分析使用。

当前阶段先聚焦以下能力：

- 支持多平台接入。
- 支持多种资源类型，当前以 `video` 为主，后续可扩展到 `music`。
- 支持周期性同步。
- 支持通用字段复用。
- 支持平台私有字段扩展。
- 适配器不直接操作数据库。
- 更新逻辑不直接耦合具体适配器实现。
- 调度状态仅保存在内存中，不落库。

API 设计不在本文范围内。

## 2. 核心决策

本设计基于以下明确决策：

1. 使用 `platform + kind` 路由适配器。
2. 暂时禁止重复注册相同 `platform + kind` 的适配器。
3. 数据库不存储 `adapter`，只存储业务语义字段。
4. `id` 必须作为核心复用字段存在，表示平台内业务唯一标识。
5. 作者、资源元信息、资源作者关系、资源历史记录分表。
6. 使用外键维护 `authors <- resource_authors -> resources -> resource_histories` 的一致性。
7. 不在表中存储“历史记录数组”或“作者作品数组”，只通过关系表达。
8. 更新器注册时必须声明扩展字段归属：`authors`、`resources`、`resourceHistories`。
9. 不引入任务表、运行表等系统表，但引入一张所有 updater 共享的 `checkpoints` 表。
10. 更新器与调度器合并，由更新器自己决定何时更新。

## 3. 设计原则

### 3.1 职责边界

- `core` 插件负责注册、字段模型、存储封装和通用能力。
- `adapter-*` 插件只负责访问平台并返回标准化结果。
- `updater-*` 插件负责更新时机和更新流程。
- `database` 由 `core` 依赖，其他插件不直接面向底层数据库表结构。

### 3.2 数据模型

- 通用字段尽可能复用，避免同义字段重复定义。
- 平台私有字段允许扩展，但必须显式声明归属。
- 当前状态和历史记录分表存储。

### 3.3 运行时状态

- 调度和执行状态仅保存在进程内存中。
- 业务同步进度通过共享 `checkpoints` 表持久化。
- 进程重启后，由插件配置重新构建更新器状态，并从 `checkpoints` 恢复同步进度。
- 对于周期性扫描型 updater，`checkpoint.cursor` / `checkpoint.page` 表示“当前轮次尚未完成时的分页进度”。
- `checkpoint.watermark` 表示“最近一轮已完整完成时的业务水位”，用于下一轮重新扫描时判定停止边界。
- 一轮同步完成后，应清空当前轮次使用的 `cursor` / `page`，并推进 `watermark`；下一轮再从起点重新开始。

### 3.4 Schema 生命周期

- 字段模型由 `updater-*` 在运行时注册。
- `core` 在启动阶段汇总字段模型并校验数据库实际 schema。
- 对于缺失的表、列、索引，允许执行加法式扩展。
- 不允许运行时自动删除列、重命名列或修改既有列类型。
- 如果字段定义与数据库现状不兼容，启动直接失败并报错。
- 启动顺序必须先完成所有 `updater-*` 的字段注册，再进入 schema 校验与 prepare 阶段。
- 在 `SchemaService.prepare()` 和底层 `database` 的表准备完成之前，不得启动任何 `updater-*`。
- 如果运行中新增了依赖新字段模型的插件，必须先重新执行 schema 校验与 prepare，再启动相关 updater。

## 4. 插件拆分

系统按插件拆分，不将所有能力放在一个插件内。

### 4.1 `core` 插件

`core` 提供所有通用服务，并依赖 `database` 服务。

职责：

- 注册和发现适配器。
- 收集并校验扩展字段定义。
- 统一维护运行时 schema 校验与扩展。
- 提供统一的数据写入接口。
- 提供统一的本地查询接口，供 updater 从库中选取待刷新的作者和资源。
- 提供共享 checkpoint 读写接口。
- 统一处理作者、资源、资源作者关系、历史记录的落库规则。
- 为 updater 和外部导入器提供一致的写入语义。

### 4.2 `adapter-*` 插件

一个适配器插件只负责一种 `platform + kind` 能力，例如：

- `adapter-bilibili-video`
- `adapter-youtube-video`
- `adapter-netease-music`

职责：

- 声明 `platform`
- 声明 `kind`
- 声明能力
- 实现平台抓取逻辑
- 注册到 `core`

### 4.3 `updater-*` 插件

更新器按策略拆分插件，而不是做成一个巨型统一更新器。

建议第一版至少存在以下插件：

- `updater-author-resources`
- `updater-resource-detail`
- `updater-author-detail`

每个 `updater-*` 插件内部同时承担：

- 决定何时更新
- 决定如何分批更新
- 调用适配器抓取数据
- 调用 `core` 提供的存储服务写库

### 4.4 插件依赖与加载顺序

建议依赖关系如下：

- `core` 依赖 `database`
- `adapter-*` 依赖 `core`
- `updater-*` 依赖 `core`

建议加载顺序如下：

1. `database`
2. `core`
3. `adapter-*`
4. `updater-*`

原因：

- `core` 启动时需要拿到数据库服务。
- `updater-*` 启动时需要向 `core` 注册扩展字段并获取已注册的适配器。
- `updater-*` 启动时需要从 `core` 获取已注册的适配器。

## 5. 总体架构

```text
adapter-* -----> core <----- updater-*
                    |
                    v
                 database
```

更细的运行链路：

```text
updater-* -> AdapterRegistry -> adapter-* -> ResourceStore -> database
```

说明：

- `updater-*` 不直接 import 具体适配器类。
- `updater-*` 通过 `core.AdapterRegistry` 按 `platform + kind` 获取适配器。
- `adapter-*` 不直接操作数据库。
- `core.ResourceStore` 负责统一落库规则。

## 6. 核心概念

### 6.1 platform

资源所属平台，例如：

- `bilibili`
- `youtube`
- `netease`

### 6.2 kind

资源类型，例如：

- `video`
- `music`

`kind` 必须入库，因为同一平台未来可能同时存在多种资源类型。

### 6.3 id

`id` 是资源或作者在目标平台内的业务唯一标识。

这里的 `id` 不是数据库主键。

- 数据库内部主键统一命名为 `pk`
- 平台业务标识统一命名为 `id`

### 6.4 资源与作者

- 作者单独建表。
- 资源元信息与作者之间通过 `resource_authors` 关联表表达多作者关系。
- 历史记录表通过外键关联资源元信息。

“作者拥有作品列表”和“资源拥有历史记录列表”只表示关系，不表示在表中实际存储数组字段。

## 7. 适配器模型

### 7.1 注册规则

适配器注册到 `core` 后方可被更新器使用。

每个适配器必须声明：

- `platform`
- `kind`
- 标准能力
- 是否支持批量查询

约束：

- 同一个 `platform + kind` 只允许一个适配器注册。
- 重复注册直接报错并拒绝加载。

### 7.2 标准能力

标准能力只保留通用且稳定的能力。

建议第一版至少支持：

- 获取单个资源详情
- 批量获取资源详情（可选）
- 获取单个作者详情
- 批量获取作者详情（可选）
- 列举某个作者的资源列表（可选）

示例接口：

```ts
interface ResourceAdapter {
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
```

### 7.3 能力声明

适配器需要显式声明自己支持哪些能力，尤其是批量能力。

```ts
interface AdapterCapabilities {
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
```

更新器根据能力声明决定是否走批量同步。

### 7.4 私有能力

平台特有能力放在 `adapter.internal` 下，不进入标准接口。

标准更新流程不得依赖 `internal`，只有明确的平台定制逻辑才允许访问。

### 7.5 列表结果模型

涉及分页拉取时，适配器返回统一的列表结果。

```ts
interface ListResult<T> {
  items: T[]
  nextCursor?: string
  nextPage?: number
  hasMore: boolean
}
```

约束：

- `cursor` 和 `page` 可以同时只实现一种。
- `hasMore` 必须显式返回，不能由调用方猜测。
- 更新器只依赖标准分页结果，不依赖平台原始分页结构。

## 8. 字段模型

### 8.1 核心字段

所有适配器尽可能复用以下字段语义。

#### 作者核心字段

- `platform`
- `id`
- `name`
- `avatarUrl`
- `description`
- `firstSeenAt`
- `lastSeenAt`
- `lastSyncedAt`

#### 资源元信息核心字段

- `platform`
- `kind`
- `id`
- `title`
- `coverUrl`
- `description`
- `publishTime`
- `duration`
- `firstSeenAt`
- `lastSeenAt`
- `lastSyncedAt`

#### 资源历史核心字段

- `resourcePk`
- `platform`
- `kind`
- `id`
- `capturedAt`
- `playCount`
- `likeCount`
- `commentCount`
- `shareCount`
- `favoriteCount`

说明：

- `favoriteCount` 作为统一收藏语义字段。
- 不再单独定义 `collectCount`，避免和收藏语义重复。

### 8.2 扩展字段

通用字段无法覆盖的平台私有字段，由具体更新器扩展声明。

扩展字段必须显式声明归属表，只允许扩展以下三个模型：

- `authors`
- `resources`
- `resourceHistories`

示例：

```ts
interface FieldDef {
  type: 'string' | 'text' | 'integer' | 'bigint' | 'float' | 'boolean' | 'datetime'
  nullable?: boolean
  initial?: unknown
  indexed?: boolean
}

interface UpdaterFieldExtension {
  authors?: Record<string, FieldDef>
  resources?: Record<string, FieldDef>
  resourceHistories?: Record<string, FieldDef>
}
```

例如某视频平台可以声明：

```ts
const fields = {
  resources: {
    bilibiliBvid: { type: 'string', indexed: true },
    bilibiliCids: { type: 'json' },
  },
  resourceHistories: {
    danmakuCount: { type: 'integer' },
    coinCount: { type: 'integer' },
  },
}
```

### 8.3 字段注册约束

`core` 需要提供字段模型注册服务，负责收集和校验扩展字段。

约束：

- 不允许覆盖核心字段定义。
- 相同字段名如果重复声明，类型必须一致。
- 不同更新器扩展同名字段时，必须确认语义一致。
- 字段命名统一使用 `camelCase`。
- 扩展字段不允许声明 `unique`。
- 平台私有字段推荐使用带平台前缀的命名，例如 `bilibiliCids`。
- 共享业务表上的扩展字段如果不是所有记录都具备，则必须允许为空或提供稳定的 `initial` 默认值。

## 9. 数据库模型

本系统使用四张核心业务表和一张共享系统表：

- `authors`
- `resources`
- `resource_authors`
- `resource_histories`
- `checkpoints`

不引入任务表、运行表等系统表。

### 9.1 authors

用于存储作者当前元信息。

建议字段：

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| `pk` | bigint / integer | 数据库主键 |
| `platform` | string | 平台标识 |
| `id` | string | 作者在平台内的唯一 id |
| `name` | string nullable | 作者名称，占位作者允许为空 |
| `avatarUrl` | string nullable | 作者头像 |
| `description` | text nullable | 作者简介 |
| `isPlaceholder` | boolean | 是否为仅用于建立关系的占位作者 |
| `firstSeenAt` | datetime | 首次发现时间 |
| `lastSeenAt` | datetime | 最近发现时间 |
| `lastSyncedAt` | datetime | 最近同步时间 |

约束：

- `unique(platform, id)`

说明：

- 当资源只给出作者 id 而没有作者详情时，`ResourceStore` 可以先创建 `isPlaceholder = true` 的占位作者并建立关系。
- 后续作者详情同步或导入写入成功后，应补全作者字段并清除占位标记。

### 9.2 resources

用于存储资源当前元信息。

建议字段：

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| `pk` | bigint / integer | 数据库主键 |
| `platform` | string | 平台标识 |
| `kind` | string | 资源类型 |
| `id` | string | 资源在平台内的唯一 id |
| `title` | string | 标题 |
| `coverUrl` | string nullable | 封面 |
| `description` | text nullable | 简介 |
| `publishTime` | datetime nullable | 发布时间 |
| `duration` | integer nullable | 时长，单位由实现约定，建议秒 |
| `firstSeenAt` | datetime | 首次发现时间 |
| `lastSeenAt` | datetime | 最近发现时间 |
| `lastSyncedAt` | datetime | 最近同步时间 |

约束：

- `unique(platform, kind, id)`

说明：

- 查询资源元信息时默认只查 `resources`。
- 不会因为存在外键而自动加载作者或历史记录。

### 9.3 resource_authors

用于存储资源与作者之间的绑定关系，一条记录只表示一个资源与一个作者之间的一次绑定。

建议字段：

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| `pk` | bigint / integer | 数据库主键 |
| `resourcePk` | bigint / integer | 资源外键 |
| `authorPk` | bigint / integer | 作者外键 |
| `isPrimary` | boolean nullable | 是否主作者 |
| `sortOrder` | integer nullable | 作者顺序，越小越靠前 |
| `role` | string nullable | 角色标记，例如 singer / uploader / publisher |
| `createdAt` | datetime | 首次建立绑定时间 |
| `updatedAt` | datetime | 最近一次确认绑定时间 |

约束：

- `foreign key(resourcePk) references resources(pk)`
- `foreign key(authorPk) references authors(pk)`
- `unique(resourcePk, authorPk)`

说明：

- `resource_authors` 只表达关系，不承载作者元信息或资源元信息。
- 如果平台只存在单作者资源，也统一通过该表表达关系。

### 9.4 resource_histories

用于存储资源历史记录，每次更新写入一条或多条时点数据。

建议字段：

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| `pk` | bigint / integer | 数据库主键 |
| `resourcePk` | bigint / integer | 资源外键 |
| `platform` | string | 平台标识，冗余存储 |
| `kind` | string | 资源类型，冗余存储 |
| `id` | string | 资源平台 id，冗余存储 |
| `capturedAt` | datetime | 本次采集时间 |
| `playCount` | bigint nullable | 播放/收听量 |
| `likeCount` | bigint nullable | 点赞量 |
| `commentCount` | bigint nullable | 评论量 |
| `shareCount` | bigint nullable | 分享量 |
| `favoriteCount` | bigint nullable | 收藏量 |

约束：

- `foreign key(resourcePk) references resources(pk)`
- `unique(resourcePk, capturedAt)`

说明：

- 保留 `platform + kind + id` 冗余字段，便于排查、导出和按业务键分析。
- 历史记录不在资源表内存数组字段，通过外键关系反查。

### 9.5 checkpoints

用于存储所有 updater 共享的业务同步进度。

建议字段：

| 字段名 | 类型 | 说明 |
| --- | --- | --- |
| `pk` | bigint / integer | 数据库主键 |
| `updater` | string | updater 实例标识，需在配置维度稳定唯一 |
| `platform` | string | 平台标识 |
| `kind` | string | 资源类型 |
| `scopeType` | string | 进度作用域类型，例如 `author`、`resource` |
| `scopeId` | string | 进度作用域业务 id |
| `cursor` | string nullable | 基于 cursor 的分页进度 |
| `page` | integer nullable | 基于页码的分页进度 |
| `watermark` | datetime nullable | 基于时间水位的进度 |
| `extra` | text nullable | 额外扩展状态，必要时使用 JSON 编码 |
| `updatedAt` | datetime | 最近更新时间 |

约束：

- `unique(updater, platform, kind, scopeType, scopeId)`

说明：

- `checkpoint` 只保存业务同步进度，不保存调度器是否运行、线程数等运行时状态。
- 不同 updater 共用同一张表，但通过唯一键隔离各自进度。
- `cursor` / `page` 用于恢复当前尚未完成的一轮同步。
- `watermark` 用于记录最近一轮完整完成时的业务边界。

### 9.6 推荐索引

#### authors

- `unique(platform, id)`

#### resources

- `unique(platform, kind, id)`
- `index(platform, kind, publishTime)`
- `index(platform, kind, lastSyncedAt)`

#### resource_authors

- `unique(resourcePk, authorPk)`
- `index(authorPk, resourcePk)`
- `index(resourcePk, sortOrder)`

#### resource_histories

- `unique(resourcePk, capturedAt)`
- `index(resourcePk, capturedAt desc)`
- `index(platform, kind, id, capturedAt desc)`

#### checkpoints

- `unique(updater, platform, kind, scopeType, scopeId)`
- `index(updater, updatedAt desc)`
- `index(platform, kind, updatedAt desc)`

## 10. 标准化结果模型

适配器返回的数据必须是标准化结果，而不是数据库写入逻辑本身。

### 10.1 作者标准化结果

```ts
type NormalizedCompleteness = 'partial' | 'full'

interface NormalizedAuthor {
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
```

### 10.2 资源标准化结果

```ts
type NormalizedAuthorsMode = 'unknown' | 'snapshot'

interface NormalizedResourceAuthorRef {
  id: string
  isPrimary?: boolean
  sortOrder?: number
  role?: string
}

interface NormalizedResource {
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
    playCount?: number | null
    likeCount?: number | null
    commentCount?: number | null
    shareCount?: number | null
    favoriteCount?: number | null
  }
  relatedAuthors?: NormalizedAuthor[]
  extension?: {
    resources?: Record<string, unknown>
    resourceHistories?: Record<string, unknown>
  }
}
```

说明：

- 作者和资源的 `id` 都是平台业务 id。
- `authors` 中的 `id` 在标准化阶段仍是平台作者 id，由 `ResourceStore` 解析成 `authorPk`。
- `relatedAuthors` 用于携带资源详情接口同时返回的作者基础信息，`ResourceStore` 会与资源在同一事务中更新。
- `extension` 只是中间态，不代表数据库一定使用 JSON 存储。

### 10.3 字段缺失与完整度语义

- 所有时间字段统一使用 Unix 毫秒时间戳，语义上按 UTC 处理。
- `undefined` 表示“未获取 / 未返回 / 当前不打算更新该字段”，写入时不得覆盖数据库已有值。
- `null` 表示“平台明确返回空值或不存在”，写入时应落为数据库 `NULL`。
- `completeness = 'partial'` 表示当前结果只覆盖部分字段，`ResourceStore` 只更新显式提供的字段。
- `completeness = 'full'` 表示当前结果是该适配器在本轮可提供的完整快照，但字段清空仍必须显式传 `null`，不能依赖字段缺失来推断删除。
- `authors === undefined` 表示本次没有拿到作者关系，不得修改既有 `resource_authors`。
- `relatedAuthors === undefined` 表示本次没有拿到作者详情，不得覆盖已有作者基础信息。
- `authorsMode = 'unknown'` 表示即使返回了部分作者引用，也不能据此删除旧关系。
- `authorsMode = 'snapshot'` 表示 `authors` 是该资源当前作者关系的完整快照，此时允许以该集合为准同步 `resource_authors`，包括删除已失效关系。

## 11. core 插件服务

### 11.1 AdapterRegistry

负责适配器注册和路由。

```ts
interface AdapterRegistry {
  register(adapter: ResourceAdapter): void
  unregister(platform: string, kind: string): void
  get(platform: string, kind: string): ResourceAdapter | undefined
  list(): ResourceAdapter[]
}
```

注册时需要完成：

- `platform + kind` 冲突校验
- 标准能力完整性校验
- 能力声明与实际实现一致性校验
- 扩展字段定义校验

### 11.2 ResourceModelService

负责维护三张可扩展业务表的字段模型。

```ts
interface ResourceModelService {
  extend(owner: string, fields: UpdaterFieldExtension): void
  getAuthorsFields(): Record<string, FieldDef>
  getResourcesFields(): Record<string, FieldDef>
  getResourceHistoriesFields(): Record<string, FieldDef>
}
```

`owner` 一般为更新器实例标识，仅用于注册来源追踪，不进入业务数据表。

说明：

- `resource_authors` 和 `checkpoints` 使用固定结构，不接受更新器扩展字段。

### 11.3 SchemaService

负责根据 `ResourceModelService` 汇总的模型，在启动阶段校验并扩展数据库 schema。

```ts
interface SchemaService {
  prepare(): Promise<void>
}
```

规则：

- 自动创建缺失的核心表、固定关系表和共享 `checkpoints` 表。
- 自动补齐缺失列与索引。
- 只允许加法式变更。
- 遇到不兼容 schema 时直接失败。
- `prepare()` 必须先完成兼容性校验，再调用底层数据库的自动建表/补列逻辑。
- 如果需要通过删列、改列类型、重命名列才能满足当前模型，`prepare()` 必须直接报错，不得继续执行自动迁移。
- 所有依赖业务表的 updater 都必须在 `prepare()` 成功后才允许启动。

### 11.4 CheckpointStore

负责封装所有 updater 共用的 `checkpoints` 表读写逻辑。

```ts
interface Checkpoint {
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

type CheckpointInput = Omit<Checkpoint, 'updatedAt'> & {
  updatedAt?: number
}

interface CheckpointStore {
  get(input: {
    updater: string
    platform: string
    kind: string
    scopeType: string
    scopeId: string
  }): Promise<Checkpoint | null>

  set(input: CheckpointInput): Promise<void>
  remove(input: {
    updater: string
    platform: string
    kind: string
    scopeType: string
    scopeId: string
  }): Promise<void>
}
```

### 11.5 SyncQueryService

负责为 updater 从本地库中选择待同步对象，而不是要求所有目标都通过静态配置维护。

```ts
interface SyncQueryService {
  listResourcesForSync(input: {
    platform: string
    kind: string
    limit: number
  }): Promise<Array<{
    pk: number
    id: string
    lastSyncedAt?: number
  }>>

  listAuthorsForSync(input: {
    platform: string
    limit: number
  }): Promise<Array<{
    pk: number
    id: string
    lastSyncedAt?: number
  }>>
}
```

### 11.6 ResourceStore

`ResourceStore` 是 `core` 内部的轻量存储服务，由它依赖 `database` 并封装统一写库规则。

它不是独立数据库实现，也不是平台逻辑层，而是对四张业务表写入规则的统一封装。

主要职责：

- 根据标准化作者数据写入 `authors`
- 根据标准化资源数据写入 `resources`
- 根据资源作者关系写入 `resource_authors`
- 根据历史数据写入 `resource_histories`
- 根据模型服务已注册字段处理扩展列
- 负责作者关系解析和资源唯一键更新逻辑

示例接口：

```ts
interface ResourceStore {
  saveAuthor(author: NormalizedAuthor): Promise<void>
  saveResource(resource: NormalizedResource): Promise<void>
  saveResourceWithAuthors(resource: NormalizedResource, authors?: NormalizedAuthor[]): Promise<void>
}
```

#### 写入规则

`ResourceStore` 至少需要遵守以下写入规则：

##### `saveAuthor()`

- 按 `authors(platform, id)` 做唯一定位。
- 不存在则插入。
- 已存在则更新作者当前元信息。
- 如果已存在占位作者，则本次成功写入后需要补全字段并清除 `isPlaceholder`。
- `firstSeenAt` 只在首次插入时写入。
- `lastSeenAt` 在每次成功确认该作者存在时更新。
- `lastSyncedAt` 只允许向前推进，不得因旧快照写入而回退。
- 当异常重入或外部导入与 updater 并发写入时，只有不早于当前 `lastSyncedAt` 的 `fetchedAt` 才能覆盖当前态字段。

##### `saveResource()`

- 按 `resources(platform, kind, id)` 做唯一定位。
- 不存在则插入资源元信息。
- 已存在则更新当前元信息。
- 写入当前态时，`undefined` 字段不得覆盖旧值，显式 `null` 才表示清空字段。
- `lastSeenAt` 在每次成功确认该资源存在时更新。
- `lastSyncedAt` 只允许向前推进，不得因旧快照写入而回退。
- 当异常重入或外部导入与 updater 并发写入时，只有不早于当前 `lastSyncedAt` 的 `fetchedAt` 才能覆盖当前态字段。
- 如果 `authors` 存在，则需要根据 `authorsMode` 同步 `resource_authors`。
- 当作者只给出引用 id 而没有完整详情时，应先创建占位作者，再建立 `resource_authors` 关系。
- 当 `authorsMode = 'snapshot'` 时，资源与作者关系应以本次快照为准，允许删除已失效的旧关系。
- 当 `authorsMode = 'unknown'` 或 `authors` 缺失时，不得据此删除旧关系。
- 每次成功写入资源元信息后，再插入一条历史记录。

##### `saveResourceWithAuthors()`

- 先写作者，再写资源。
- 资源写入后，使用已落库作者的 `authorPk` 同步 `resource_authors`。
- 资源元信息、作者写入、资源作者关系写入和历史记录写入应放在同一事务内提交。
- 该方法既可供 updater 使用，也可供导入器 / 控制器复用。

##### 历史记录写入

- 按 `resource_histories(resourcePk, capturedAt)` 去重。
- 如果同一资源在同一时间点重复写入，由实现决定忽略或覆盖，但行为必须固定。
- 推荐第一版使用“重复则忽略”策略，避免误覆盖已有历史点。

##### 扩展字段写入

- `authors` 扩展字段只写 `authors` 表。
- `resources` 扩展字段只写 `resources` 表。
- `resourceHistories` 扩展字段只写 `resource_histories` 表。
- 未声明的扩展字段不得落库。

注意：

- `ResourceStore` 知道表结构和 upsert 规则。
- `updater-*` 不直接拼接字段写库。
- `adapter-*` 不直接操作数据库。

### 11.7 ResourceStore 与 database 的关系

- `database` 是底层数据库服务。
- `ResourceStore` 是 `core` 内部基于 `database` 的业务写入封装。
- `updater-*` 与导入器 / 控制器都面向 `ResourceStore`，而不是直接面向底层表结构。

这样做的目的不是再包一层抽象，而是把以下规则集中到一处维护：

- 唯一键 upsert
- 作者关系解析
- 历史记录插入策略
- 扩展字段列映射

## 12. updater 插件模型

更新器和调度器合并，由更新器自己负责“什么时候更新”和“如何更新”。

### 12.1 基本思路

- 一个适配器实例可以被多个更新器插件复用。
- 一个更新器插件只聚焦一种更新策略。
- 更新器运行状态只存在于内存中。
- 更新器业务同步进度通过共享 `checkpoints` 表恢复。
- 对于同一类资源当前态的周期刷新，应明确由一个 updater 实例负责，避免多个 updater 长期并发刷新同一批资源。
- 导入器 / 控制器属于外部触发写入入口，不承担周期调度职责，但写入仍复用同一套 `ResourceStore` 规则。

例如：

- `updater-author-resources` 负责定时拉作者作品列表。
- `updater-resource-detail` 负责定时刷新作品详情。
- `updater-author-detail` 负责定时刷新作者资料。

### 12.2 更新器职责

每个 `updater-*` 插件内部同时承担：

- 维护 `interval` 或 `cron`
- 维护当前是否执行中
- 控制批量大小与并发
- 从 `AdapterRegistry` 获取适配器
- 读取和更新 `checkpoint`
- 调用 `ResourceStore` 落库

### 12.3 推荐接口

```ts
interface Updater {
  start(): void
  stop(): void
  runOnce(): Promise<void>
}
```

如果需要更细的内部结构，建议在实现中拆出方法，而不是拆成独立插件服务：

- `scheduleNext()`
- `trigger()`
- `runBatch()`
- `runOnce()`

这样后续即使要重新拆分调度和执行，也不会推倒重来。

### 12.4 更新器配置

```ts
interface UpdaterConfig {
  platform: string
  kind: string
  mode: 'interval' | 'cron'
  intervalMs?: number
  cron?: string
  batch?: {
    enabled: boolean
    size: number
    concurrency: number
  }
}
```

不同 updater 插件可以在此基础上增加自己的策略字段。

建议各 updater 插件在基础配置外，再加各自的策略配置。

#### `updater-author-resources`

```ts
interface AuthorResourcesUpdaterConfig extends UpdaterConfig {
  authorIds: string[]
  pageSize?: number
}
```

#### `updater-resource-detail`

```ts
interface ResourceDetailUpdaterConfig extends UpdaterConfig {
  resourceIds?: string[]
}
```

#### `updater-author-detail`

```ts
interface AuthorDetailUpdaterConfig extends UpdaterConfig {
  authorIds?: string[]
}
```

说明：

- `resourceIds` / `authorIds` 适合固定白名单场景。
- 对于由其他同步流程持续发现的新资源和新作者，相关 updater 应优先通过 `SyncQueryService` 从本地库中选取待刷新目标，而不是要求人工维护完整 id 列表。

### 12.5 批量策略

当适配器声明支持批量能力时，更新器可根据配置进行批量调用。

规则：

- 更新器配置开启 `batch`
- 适配器声明对应能力 `supported = true`
- 实际批量大小不得超过适配器声明的 `maxBatchSize`

批量分组和并发控制由更新器负责。

### 12.6 Checkpoint 使用约定

- `checkpoint` 只保存业务进度，例如 `cursor`、`page`、时间水位。
- `checkpoint` 不保存“当前是否执行中”“下一次触发时间”等调度状态。
- `updater` 字段必须表示稳定的 updater 实例标识，而不只是插件类型名。
- 每个 updater 负责定义自己的 `scopeType + scopeId` 语义，但必须保持稳定。
- 周期性扫描型 updater 中，`cursor` / `page` 表示当前轮次的进行中位置，`watermark` 表示最近一轮完整完成时的停止边界。
- 当一次批次成功提交后，再推进对应 `checkpoint` 的当前轮次进度。
- 当一整轮同步完成后，应清空 `cursor` / `page` 并推进 `watermark`，等待下一轮重新开始。
- 如果数据源分页稳定且可恢复，则可从现有 `cursor` / `page` 继续；如果分页不稳定，则允许整轮从头重扫，但写入链路必须保持幂等。

## 13. 典型流程

### 13.1 作品详情更新

```text
updater-resource-detail
  -> AdapterRegistry.get(platform, kind)
  -> adapter.getResource() / adapter.getResources()
  -> ResourceStore.saveResource()
```

### 13.2 作者作品列表更新

```text
updater-author-resources
  -> AdapterRegistry.get(platform, kind)
  -> adapter.listAuthorResources()
  -> ResourceStore.saveAuthor()
  -> ResourceStore.saveResourceWithAuthors()
```

当资源列表结果中未携带完整作者信息时，可以先写资源并建立占位作者关系，再延后由 `updater-author-detail` 补作者详情并补齐未完成的字段。

更具体地说：

- 如果列表结果只给出作者 id，`ResourceStore` 应先创建占位作者并建立 `resource_authors` 关系。
- 后续由 `updater-author-detail` 或外部导入器补齐作者详情，并清除占位标记。

### 13.3 作者详情更新

```text
updater-author-detail
  -> AdapterRegistry.get(platform, kind)
  -> adapter.getAuthor() / adapter.getAuthors()
  -> ResourceStore.saveAuthor()
```

### 13.4 手动导入 / 控制器导入

```text
importer / controller
  -> AdapterRegistry.get(platform, kind)
  -> adapter.getResource() / adapter.getAuthor()
  -> ResourceStore.saveResourceWithAuthors()
```

说明：

- 导入器不直接拼接表结构或操作关系表，而是复用 `ResourceStore`。
- 未获取或未知的字段传 `undefined`，明确不存在的字段传 `null`。

## 14. 数据一致性与查询约定

### 14.1 外键策略

数据库层启用外键约束：

- `resource_authors.resourcePk -> resources.pk`
- `resource_authors.authorPk -> authors.pk`
- `resource_histories.resourcePk -> resources.pk`

外键只用于约束一致性，不代表查询时自动加载关联数据。

### 14.2 查询约定

- 查询资源元信息时默认只查 `resources`
- 查询作者信息时默认只查 `authors`
- 查询资源历史时显式查询 `resource_histories`

是否联表、是否带历史，完全由调用方决定。

## 15. 当前阶段不做的事

当前阶段明确不做以下内容：

- 任务表
- 运行日志表
- 持久化调度状态
- 将适配器标识写入业务表

这些能力后续如果确实有需要，再单独设计。

## 16. 后续工作

建议按以下顺序继续推进：

1. 将本文中的四张业务表和 `checkpoints` 表转换为实际数据库 schema。
2. 定义 `core` 插件中的 `AdapterRegistry`、`ResourceModelService`、`SchemaService`、`CheckpointStore`、`ResourceStore` 类型。
3. 定义各 `updater-*` 插件的配置结构、checkpoint 作用域和生命周期接口。
4. 为第一个实际适配器补全标准化逻辑和多作者映射，为对应更新器补全扩展字段声明。
5. 最后再进入 API 查询与分析接口设计。
