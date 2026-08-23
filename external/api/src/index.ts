import type { Database } from '@cordisjs/plugin-database'
import type { Request, Response } from '@cordisjs/plugin-server'
import type { MediaSync } from '@lfvs/core'
import { type Context } from 'cordis'
import z from 'schemastery'
import { ApiError, apiHandler, corsHeaders, requiredId, requiredTarget } from './http.js'
import { openApiDocument } from './openapi.js'
import { LfvsApiService, type ApiLimits } from './service.js'

export interface Config {
  basePath?: string
  defaultLimit?: number
  maxLimit?: number
  maxBatchSize?: number
  maxHistoryPoints?: number
  corsOrigins?: string[]
}

export const Config = z.object({
  basePath: z.string().default('/api/v1').description('API 路由前缀，必须以 / 开头。'),
  defaultLimit: z.natural().default(50).description('列表接口默认返回数量。'),
  maxLimit: z.natural().default(250).description('资源和作者列表接口允许的最大返回数量。'),
  maxBatchSize: z.natural().default(250).description('批量资源接口单次允许提交的最大 ID 数量。'),
  maxHistoryPoints: z.natural().default(5000).description('历史记录接口单次允许返回的最大快照数量。'),
  corsOrigins: z.array(z.string()).default(['*']).description('允许跨域访问 API 的来源；使用 * 表示允许所有来源。'),
})

export const name = 'lfvs-api'
export const inject = ['mediaSync', 'database', 'server']

function normalizeBasePath(value: string | undefined) {
  const path = value?.trim() || '/api/v1'
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new TypeError('basePath must be an absolute URL path')
  }
  return path === '/' ? '' : path.replace(/\/+$/, '')
}

function positive(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result <= 0) throw new TypeError(`${name} must be a positive integer`)
  return result
}

async function requestJson(req: Request) {
  try {
    return await req.json()
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'request body must be valid JSON')
  }
}

export function apply(ctx: Context, config: Config) {
  const basePath = normalizeBasePath(config.basePath)
  const limits: ApiLimits = {
    defaultLimit: positive(config.defaultLimit, 50, 'defaultLimit'),
    maxLimit: positive(config.maxLimit, 250, 'maxLimit'),
    maxBatchSize: positive(config.maxBatchSize, 250, 'maxBatchSize'),
    maxHistoryPoints: positive(config.maxHistoryPoints, 5000, 'maxHistoryPoints'),
  }
  if (limits.defaultLimit > limits.maxLimit) throw new TypeError('defaultLimit must not exceed maxLimit')
  const origins = config.corsOrigins?.map((origin) => origin.trim()).filter(Boolean) ?? ['*']
  const logger = ctx.logger('lfvs-api')
  const service = new LfvsApiService(ctx.database as Database, ctx.mediaSync as MediaSync, limits)
  const targetPath = `${basePath}/targets/:platform/:kind`

  ctx.server.all(`${basePath}{/*path}`, async (req, res, next) => {
    corsHeaders(req, res, origins)
    if (req.method === 'OPTIONS') {
      res.status = 204
      return
    }
    return next()
  })

  const route = (
    callback: (req: Request & { params: Record<string, string> }, res: Response) => Promise<unknown>,
  ) => apiHandler(origins, logger, callback)
  const target = (params: Record<string, string>) => ({
    platform: requiredTarget(params.platform, 'platform'),
    kind: requiredTarget(params.kind, 'kind'),
  })

  ctx.server.get(basePath || '/', route(async () => service.root()))
  ctx.server.get(`${basePath}/health`, route(async () => service.health()))
  ctx.server.get(`${basePath}/openapi.json`, route(async () => openApiDocument(basePath, limits)))
  ctx.server.get(`${basePath}/targets`, route(async () => service.targets()))
  ctx.server.get(`${targetPath}/schema`, route(async (req) => {
    const { platform, kind } = target(req.params)
    return service.schema(platform, kind)
  }))
  ctx.server.get(`${targetPath}/resources`, route(async (req) => {
    const { platform, kind } = target(req.params)
    return service.listResources(platform, kind, req.query)
  }))
  ctx.server.get(`${targetPath}/resources/snapshot`, route(async (req) => {
    const { platform, kind } = target(req.params)
    return service.resourceSnapshot(platform, kind, req.query)
  }))
  ctx.server.post(`${targetPath}/resources/batch`, route(async (req) => {
    const { platform, kind } = target(req.params)
    return service.batchResources(platform, kind, await requestJson(req))
  }))
  ctx.server.get(`${targetPath}/resources/:id/history`, route(async (req) => {
    const { platform, kind } = target(req.params)
    return service.history(platform, kind, requiredId(req.params.id), req.query)
  }))
  ctx.server.get(`${targetPath}/resources/:id`, route(async (req) => {
    const { platform, kind } = target(req.params)
    return service.getResource(platform, kind, requiredId(req.params.id))
  }))
  ctx.server.get(`${targetPath}/authors`, route(async (req) => {
    const { platform, kind } = target(req.params)
    return service.listAuthors(platform, kind, req.query)
  }))
  ctx.server.get(`${targetPath}/authors/:id/resources`, route(async (req) => {
    const { platform, kind } = target(req.params)
    return service.authorResources(platform, kind, requiredId(req.params.id), req.query)
  }))
  ctx.server.get(`${targetPath}/authors/:id`, route(async (req) => {
    const { platform, kind } = target(req.params)
    return service.getAuthor(platform, kind, requiredId(req.params.id))
  }))
  ctx.server.all(`${basePath}{/*path}`, route(async () => {
    throw new ApiError(404, 'ROUTE_NOT_FOUND', 'API route was not found')
  }))
}

export default { apply, inject, Config }
