import { randomUUID } from 'node:crypto'
import type { Middleware, Request, Response } from '@cordisjs/plugin-server'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface Pagination {
  limit: number
  offset: number
  signature: string
}

interface CursorPayload {
  v: 1
  offset: number
  signature: string
}

export function jsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(jsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]))
  }
  return value
}

export function parsePagination(
  query: URLSearchParams,
  signature: string,
  defaultLimit: number,
  maxLimit: number,
): Pagination {
  const rawLimit = query.get('limit')
  const limit = rawLimit === null ? defaultLimit : positiveInteger(rawLimit, 'limit')
  if (limit > maxLimit) throw new ApiError(400, 'INVALID_LIMIT', `limit must not exceed ${maxLimit}`)
  const cursor = query.get('cursor')
  if (!cursor) return { limit, offset: 0, signature }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload
    if (parsed.v !== 1 || parsed.signature !== signature || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) {
      throw new Error('invalid cursor payload')
    }
    return { limit, offset: parsed.offset, signature }
  } catch {
    throw new ApiError(400, 'INVALID_CURSOR', 'cursor is invalid for this query')
  }
}

export function nextCursor(page: Pagination, hasMore: boolean) {
  if (!hasMore) return null
  const payload: CursorPayload = { v: 1, offset: page.offset + page.limit, signature: page.signature }
  return Buffer.from(JSON.stringify(payload)).toString('base64url')
}

export function querySignature(scope: string, values: Record<string, unknown>) {
  const normalized = Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .sort(([a], [b]) => a.localeCompare(b)),
  )
  return `${scope}:${JSON.stringify(normalized)}`
}

export function requiredTarget(value: string, name: 'platform' | 'kind') {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
    throw new ApiError(400, `INVALID_${name.toUpperCase()}`, `${name} is invalid`)
  }
  return value
}

export function requiredId(value: string, name = 'id') {
  if (!value || value.length > 255 || value.trim() !== value) {
    throw new ApiError(400, 'INVALID_ID', `${name} must be a non-empty value of at most 255 characters`)
  }
  return value
}

export function optionalText(value: string | null, name: string, maxLength = 100) {
  if (value === null) return undefined
  const text = value.trim()
  if (!text) return undefined
  if (text.length > maxLength) throw new ApiError(400, 'INVALID_QUERY', `${name} is too long`)
  return text
}

export function booleanQuery(value: string | null, name: string, fallback = false) {
  if (value === null) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new ApiError(400, 'INVALID_BOOLEAN', `${name} must be true or false`)
}

export function parseDate(value: string | null, name: string) {
  if (value === null) return undefined
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) throw new ApiError(400, 'INVALID_DATE', `${name} must be an ISO 8601 date`)
  return new Date(time)
}

export function positiveInteger(value: string, name: string) {
  if (!/^\d+$/.test(value)) throw new ApiError(400, 'INVALID_NUMBER', `${name} must be a positive integer`)
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new ApiError(400, 'INVALID_NUMBER', `${name} must be a positive integer`)
  }
  return result
}

export function nonNegativeInteger(value: string, name: string) {
  if (!/^\d+$/.test(value)) throw new ApiError(400, 'INVALID_NUMBER', `${name} must be a non-negative integer`)
  const result = Number(value)
  if (!Number.isSafeInteger(result)) {
    throw new ApiError(400, 'INVALID_NUMBER', `${name} must be a non-negative integer`)
  }
  return result
}

export function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function textFilter(value: string) {
  return { $regex: { source: escapeRegex(value), flags: 'i' } }
}

export function corsHeaders(req: Request, res: Response, origins: string[]) {
  const origin = req.headers.get('origin')
  if (!origin) return
  if (origins.includes('*')) {
    res.headers.set('access-control-allow-origin', '*')
  } else if (origins.includes(origin)) {
    res.headers.set('access-control-allow-origin', origin)
    res.headers.append('vary', 'Origin')
  } else {
    return
  }
  res.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.headers.set(
    'access-control-allow-headers',
    'Content-Type, X-Request-Id, X-LFVS-PoW-Challenge, X-LFVS-PoW-Nonce',
  )
  res.headers.set('access-control-expose-headers', 'X-Request-Id')
}

export function apiHandler(
  origins: string[],
  logger: { error(error: unknown): void },
  callback: (req: Request & { params: Record<string, string> }, res: Response) => Promise<unknown>,
): Middleware {
  return async (req, res) => {
    const requestId = req.headers.get('x-request-id')?.slice(0, 128) || randomUUID()
    res.headers.set('x-request-id', requestId)
    res.headers.set('cache-control', 'no-store')
    corsHeaders(req, res, origins)
    try {
      const result = await callback(req as Request & { params: Record<string, string> }, res)
      if (!res.claimed && result !== undefined) res.json(jsonValue(result))
    } catch (error) {
      const apiError = error instanceof ApiError
        ? error
        : new ApiError(500, 'INTERNAL_ERROR', 'an internal error occurred')
      if (!(error instanceof ApiError)) logger.error(error)
      res.status = apiError.status
      res.json(jsonValue({
        error: {
          code: apiError.code,
          message: apiError.message,
          requestId,
          ...(apiError.details === undefined ? {} : { details: apiError.details }),
        },
      }))
    }
  }
}
