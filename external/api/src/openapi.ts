import type { ApiLimits } from './service.js'

const objectSchema = { type: 'object', additionalProperties: true }
const dateTime = { type: 'string', format: 'date-time' }

export function openApiDocument(basePath: string, limits: ApiLimits) {
  const targetParameters = [
    { name: 'platform', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' } },
    { name: 'kind', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' } },
  ]
  const idParameter = { name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1, maxLength: 255 } }
  const paging = [
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: limits.maxLimit, default: limits.defaultLimit } },
    { name: 'cursor', in: 'query', schema: { type: 'string', description: '由上一页 pagination.nextCursor 返回的不透明游标。' } },
  ]
  const powHeaders = [
    { name: 'X-LFVS-PoW-Challenge', in: 'header', required: false, schema: { type: 'string' }, description: 'PoW 中间件返回的 challenge。' },
    { name: 'X-LFVS-PoW-Nonce', in: 'header', required: false, schema: { type: 'string' }, description: '满足 SHA-256(challenge + "." + lowercaseHexNonce) 难度要求的 nonce。' },
  ]
  const errorRefs = {
    400: { $ref: '#/components/responses/BadRequest' },
    404: { $ref: '#/components/responses/NotFound' },
    409: { $ref: '#/components/responses/Conflict' },
    410: { $ref: '#/components/responses/Gone' },
    428: { $ref: '#/components/responses/PowRequired' },
    429: { $ref: '#/components/responses/TooManyRequests' },
    500: { $ref: '#/components/responses/InternalError' },
    503: { $ref: '#/components/responses/Unavailable' },
  }
  const responses = (schema: object, protectedRoute = false) => ({
    200: { description: 'Successful response', content: { 'application/json': { schema } } },
    ...(protectedRoute ? errorRefs : { 400: errorRefs[400], 404: errorRefs[404], 500: errorRefs[500] }),
  })
  const paged = (item: object) => ({
    type: 'object', required: ['data', 'pagination'],
    properties: { data: { type: 'array', items: item }, pagination: { $ref: '#/components/schemas/Pagination' } },
  })
  const protect = (operation: Record<string, any>) => ({
    ...operation,
    parameters: [...(operation.parameters ?? []), ...powHeaders],
    security: [{ powChallenge: [], powNonce: [] }],
  })
  const target = `${basePath}/targets/{platform}/{kind}`

  return {
    openapi: '3.1.0',
    info: {
      title: 'LFVS API', version: '1.1.0',
      description: 'Read-only LFVS API. Dynamic platform fields are described by each target schema endpoint.',
    },
    paths: {
      [basePath]: { get: { summary: 'API information', responses: responses({ $ref: '#/components/schemas/RootResponse' }) } },
      [`${basePath}/health`]: { get: { summary: 'Service health', responses: responses({ $ref: '#/components/schemas/HealthResponse' }) } },
      [`${basePath}/targets`]: { get: { summary: 'List available platform and kind targets', responses: responses({ $ref: '#/components/schemas/TargetsResponse' }) } },
      [`${target}/schema`]: { get: protect({ summary: 'Get the active field contract', parameters: targetParameters, responses: responses(objectSchema, true) }) },
      [`${target}/resources`]: { get: protect({
        summary: 'Search resources',
        parameters: [
          ...targetParameters,
          { name: 'q', in: 'query', schema: { type: 'string', maxLength: 100 }, description: '按资源标题搜索。' },
          { name: 'authorId', in: 'query', schema: { type: 'string', maxLength: 255 } },
          { name: 'authorName', in: 'query', schema: { type: 'string', maxLength: 100 } },
          { name: 'publishedAfter', in: 'query', schema: dateTime },
          { name: 'publishedBefore', in: 'query', schema: dateTime },
          ...paging,
        ],
        responses: responses(paged({ $ref: '#/components/schemas/Resource' }), true),
      }) },
      [`${target}/resources/batch`]: { post: protect({
        summary: 'Get resources in request order', parameters: targetParameters,
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['ids'], additionalProperties: false,
          properties: { ids: { type: 'array', minItems: 1, maxItems: limits.maxBatchSize, items: { type: 'string', minLength: 1, maxLength: 255 } } },
        } } } },
        responses: responses({ $ref: '#/components/schemas/BatchResourcesResponse' }, true),
      }) },
      [`${target}/resources/snapshot`]: { get: protect({
        summary: 'Get every resource with the history snapshot nearest to a requested time',
        parameters: [
          ...targetParameters,
          { name: 'at', in: 'query', required: true, schema: dateTime, description: '寻找距离此时间最近的一条历史记录。' },
          { name: 'metrics', in: 'query', schema: { type: 'string' }, description: '逗号分隔的历史字段；省略时返回当前在线更新器声明的全部字段。' },
          { name: 'maxDistanceMs', in: 'query', schema: { type: 'integer', minimum: 0 } },
          { name: 'includeMissing', in: 'query', schema: { type: 'boolean', default: true } },
          { name: 'publishedBeforeAt', in: 'query', schema: { type: 'boolean', default: false }, description: '只包含发布时间不晚于 at 的资源。' },
        ],
        responses: responses({ $ref: '#/components/schemas/SnapshotResponse' }, true),
      }) },
      [`${target}/resources/{id}`]: { get: protect({ summary: 'Get one resource with authors', parameters: [...targetParameters, idParameter], responses: responses({ $ref: '#/components/schemas/ResourceResponse' }, true) }) },
      [`${target}/resources/{id}/history`]: { get: protect({
        summary: 'Get resource history snapshots',
        parameters: [
          ...targetParameters, idParameter,
          { name: 'from', in: 'query', schema: dateTime }, { name: 'to', in: 'query', schema: dateTime },
          { name: 'metrics', in: 'query', schema: { type: 'string' }, description: '逗号分隔的历史字段。' },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: limits.maxHistoryPoints } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: responses(paged({ $ref: '#/components/schemas/HistoryPoint' }), true),
      }) },
      [`${target}/authors`]: { get: protect({
        summary: 'Search authors associated with the target',
        parameters: [...targetParameters, { name: 'q', in: 'query', schema: { type: 'string', maxLength: 100 }, description: '按作者名称搜索。' }, { name: 'includePlaceholders', in: 'query', schema: { type: 'boolean', default: false } }, ...paging],
        responses: responses(paged({ $ref: '#/components/schemas/Author' }), true),
      }) },
      [`${target}/authors/{id}`]: { get: protect({ summary: 'Get one author', parameters: [...targetParameters, idParameter], responses: responses({ $ref: '#/components/schemas/AuthorResponse' }, true) }) },
      [`${target}/authors/{id}/resources`]: { get: protect({ summary: 'Get resources associated with an author', parameters: [...targetParameters, idParameter, ...paging], responses: responses(paged({ $ref: '#/components/schemas/Resource' }), true) }) },
      [`${basePath}/openapi.json`]: { get: { summary: 'OpenAPI document', responses: responses(objectSchema) } },
    },
    components: {
      securitySchemes: {
        powChallenge: { type: 'apiKey', in: 'header', name: 'X-LFVS-PoW-Challenge', description: '未提供时受保护接口返回 428，并在 pow.challenge 中提供。' },
        powNonce: { type: 'apiKey', in: 'header', name: 'X-LFVS-PoW-Nonce', description: '与 challenge 一起提交。' },
      },
      responses: {
        BadRequest: { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        NotFound: { description: 'Entity not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        Conflict: { description: 'PoW challenge has already been used', headers: { 'Retry-After': { schema: { type: 'integer' } } }, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        Gone: { description: 'PoW challenge has expired', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        PowRequired: { description: 'Proof of work is required', headers: { 'WWW-Authenticate': { schema: { type: 'string', example: 'LFVS-PoW' } } }, content: { 'application/json': { schema: { $ref: '#/components/schemas/PowRequiredResponse' } } } },
        TooManyRequests: { description: 'Rate limited or bulk request is cooling down', headers: { 'Retry-After': { schema: { type: 'integer' } } }, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        InternalError: { description: 'Internal service error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        Unavailable: { description: 'Service or PoW capacity is temporarily unavailable', headers: { 'Retry-After': { schema: { type: 'integer' } } }, content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      },
      schemas: {
        RootResponse: { type: 'object', required: ['data'], properties: { data: { type: 'object', required: ['name', 'version', 'readOnly'], properties: { name: { type: 'string' }, version: { type: 'string' }, readOnly: { type: 'boolean' } } } } },
        HealthResponse: { type: 'object', required: ['data'], properties: { data: { type: 'object', required: ['status', 'database'], properties: { status: { type: 'string' }, database: { type: 'string' } } } } },
        Target: { type: 'object', required: ['platform', 'kind', 'resourceCount', 'historyCount', 'adapterOnline', 'updaterOnline'], properties: { platform: { type: 'string' }, kind: { type: 'string' }, resourceCount: { type: 'integer' }, historyCount: { type: 'integer' }, adapterOnline: { type: 'boolean' }, updaterOnline: { type: 'boolean' } } },
        TargetsResponse: { type: 'object', required: ['data'], properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Target' } } } },
        Pagination: { type: 'object', required: ['nextCursor', 'hasMore'], properties: { nextCursor: { type: ['string', 'null'] }, hasMore: { type: 'boolean' } } },
        Author: { type: 'object', required: ['platform', 'id', 'name', 'avatarUrl', 'description', 'isPlaceholder', 'firstSeenAt', 'lastSeenAt', 'lastSyncedAt', 'extensions'], properties: { platform: { type: 'string' }, id: { type: 'string' }, name: { type: ['string', 'null'] }, avatarUrl: { type: ['string', 'null'] }, description: { type: ['string', 'null'] }, isPlaceholder: { type: 'boolean' }, firstSeenAt: dateTime, lastSeenAt: dateTime, lastSyncedAt: { type: ['string', 'null'], format: 'date-time' }, resourceCount: { type: 'integer' }, relation: objectSchema, extensions: objectSchema } },
        Resource: { type: 'object', required: ['platform', 'kind', 'id', 'title', 'coverUrl', 'description', 'publishTime', 'duration', 'firstSeenAt', 'lastSeenAt', 'lastSyncedAt', 'authors', 'extensions'], properties: { platform: { type: 'string' }, kind: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' }, coverUrl: { type: ['string', 'null'] }, description: { type: ['string', 'null'] }, publishTime: { type: ['string', 'null'], format: 'date-time' }, duration: { type: ['integer', 'null'] }, firstSeenAt: dateTime, lastSeenAt: dateTime, lastSyncedAt: { type: ['string', 'null'], format: 'date-time' }, authors: { type: 'array', items: { $ref: '#/components/schemas/Author' } }, extensions: objectSchema } },
        ResourceResponse: { type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/Resource' } } },
        AuthorResponse: { type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/Author' } } },
        BatchResource: { type: 'object', required: ['id', 'resource'], properties: { id: { type: 'string' }, resource: { anyOf: [{ $ref: '#/components/schemas/Resource' }, { type: 'null' }] } } },
        BatchResourcesResponse: { type: 'object', required: ['data'], properties: { data: { type: 'array', items: { $ref: '#/components/schemas/BatchResource' } } } },
        HistoryPoint: { type: 'object', required: ['capturedAt', 'extensions'], properties: { capturedAt: dateTime, playCount: { type: ['string', 'null'] }, likeCount: { type: ['string', 'null'] }, commentCount: { type: ['string', 'null'] }, shareCount: { type: ['string', 'null'] }, favoriteCount: { type: ['string', 'null'] }, extensions: objectSchema } },
        SnapshotMatch: { type: 'object', required: ['status', 'requestedAt'], properties: { status: { type: 'string', enum: ['matched', 'missing', 'outsideTolerance'] }, requestedAt: dateTime, capturedAt: dateTime, distanceMs: { type: 'integer', minimum: 0 }, direction: { type: 'string', enum: ['before', 'after', 'exact'] } } },
        SnapshotResource: { type: 'object', required: ['platform', 'kind', 'id', 'title', 'publishTime', 'duration', 'extensions'], properties: { platform: { type: 'string' }, kind: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' }, publishTime: { type: ['string', 'null'], format: 'date-time' }, duration: { type: ['integer', 'null'] }, extensions: objectSchema } },
        SnapshotHistory: { type: 'object', required: ['extensions'], properties: { playCount: { type: ['string', 'null'] }, likeCount: { type: ['string', 'null'] }, commentCount: { type: ['string', 'null'] }, shareCount: { type: ['string', 'null'] }, favoriteCount: { type: ['string', 'null'] }, extensions: objectSchema } },
        SnapshotItem: { type: 'object', required: ['resource', 'match', 'history'], properties: { resource: { $ref: '#/components/schemas/SnapshotResource' }, match: { $ref: '#/components/schemas/SnapshotMatch' }, history: { anyOf: [{ $ref: '#/components/schemas/SnapshotHistory' }, { type: 'null' }] } } },
        SnapshotSummary: { type: 'object', required: ['platform', 'kind', 'requestedAt', 'generatedAt', 'resourceCount', 'matchedCount', 'missingCount', 'outsideToleranceCount'], properties: { platform: { type: 'string' }, kind: { type: 'string' }, requestedAt: dateTime, generatedAt: dateTime, resourceCount: { type: 'integer' }, matchedCount: { type: 'integer' }, missingCount: { type: 'integer' }, outsideToleranceCount: { type: 'integer' } } },
        SnapshotResponse: { type: 'object', required: ['data', 'summary'], properties: { data: { type: 'array', items: { $ref: '#/components/schemas/SnapshotItem' } }, summary: { $ref: '#/components/schemas/SnapshotSummary' } } },
        Error: { type: 'object', required: ['code', 'message', 'requestId'], properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, details: {} } },
        ErrorResponse: { type: 'object', required: ['error'], properties: { error: { $ref: '#/components/schemas/Error' } } },
        PowRequiredResponse: { type: 'object', required: ['error', 'pow'], properties: { error: { $ref: '#/components/schemas/Error' }, pow: { type: 'object', required: ['algorithm', 'challenge', 'difficulty', 'expiresAt'], properties: { algorithm: { type: 'string', enum: ['sha256'] }, challenge: { type: 'string' }, difficulty: { type: 'integer', minimum: 0 }, expiresAt: dateTime } } } },
      },
    },
  }
}
