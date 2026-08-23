import type { ApiLimits } from './service.js'

export function openApiDocument(basePath: string, limits: ApiLimits) {
  const targetParameters = [
    { name: 'platform', in: 'path', required: true, schema: { type: 'string' } },
    { name: 'kind', in: 'path', required: true, schema: { type: 'string' } },
  ]
  const idParameter = { name: 'id', in: 'path', required: true, schema: { type: 'string', maxLength: 255 } }
  const cursorParameters = [
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: limits.maxLimit, default: limits.defaultLimit } },
    { name: 'cursor', in: 'query', schema: { type: 'string' } },
  ]
  const response = (description = 'Successful response') => ({
    200: {
      description,
      content: { 'application/json': { schema: { type: 'object' } } },
    },
    400: { $ref: '#/components/responses/BadRequest' },
    404: { $ref: '#/components/responses/NotFound' },
    500: { $ref: '#/components/responses/InternalError' },
  })
  const target = `${basePath}/targets/{platform}/{kind}`
  return {
    openapi: '3.1.0',
    info: {
      title: 'LFVS API',
      version: '1.0.0',
      description: 'Read-only access to LFVS resources, authors, relationships, and history snapshots.',
    },
    paths: {
      [basePath]: {
        get: { summary: 'API information', responses: response() },
      },
      [`${basePath}/health`]: {
        get: { summary: 'Service health', responses: response() },
      },
      [`${basePath}/targets`]: {
        get: { summary: 'List available platform and kind targets', responses: response() },
      },
      [`${target}/schema`]: {
        get: { summary: 'Get the active field contract', parameters: targetParameters, responses: response() },
      },
      [`${target}/resources`]: {
        get: {
          summary: 'Search resources',
          parameters: [
            ...targetParameters,
            { name: 'q', in: 'query', schema: { type: 'string', maxLength: 100 } },
            { name: 'authorId', in: 'query', schema: { type: 'string', maxLength: 255 } },
            { name: 'authorName', in: 'query', schema: { type: 'string', maxLength: 100 } },
            { name: 'publishedAfter', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'publishedBefore', in: 'query', schema: { type: 'string', format: 'date-time' } },
            ...cursorParameters,
          ],
          responses: response(),
        },
      },
      [`${target}/resources/batch`]: {
        post: {
          summary: 'Get resources in request order',
          parameters: targetParameters,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['ids'],
                  properties: {
                    ids: { type: 'array', minItems: 1, maxItems: limits.maxBatchSize, items: { type: 'string', maxLength: 255 } },
                  },
                },
              },
            },
          },
          responses: response(),
        },
      },
      [`${target}/resources/snapshot`]: {
        get: {
          summary: 'Get every resource with the history snapshot nearest to a requested time',
          parameters: [
            ...targetParameters,
            { name: 'at', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
            { name: 'metrics', in: 'query', schema: { type: 'string' } },
            { name: 'maxDistanceMs', in: 'query', schema: { type: 'integer', minimum: 0 } },
            { name: 'includeMissing', in: 'query', schema: { type: 'boolean', default: true } },
            { name: 'publishedBeforeAt', in: 'query', schema: { type: 'boolean', default: false } },
          ],
          responses: response(),
        },
      },
      [`${target}/resources/{id}`]: {
        get: { summary: 'Get one resource with authors', parameters: [...targetParameters, idParameter], responses: response() },
      },
      [`${target}/resources/{id}/history`]: {
        get: {
          summary: 'Get resource history snapshots',
          parameters: [
            ...targetParameters,
            idParameter,
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'metrics', in: 'query', schema: { type: 'string' } },
            { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: limits.maxHistoryPoints } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: response(),
        },
      },
      [`${target}/authors`]: {
        get: {
          summary: 'Search authors associated with the target',
          parameters: [
            ...targetParameters,
            { name: 'q', in: 'query', schema: { type: 'string', maxLength: 100 } },
            { name: 'includePlaceholders', in: 'query', schema: { type: 'boolean', default: false } },
            ...cursorParameters,
          ],
          responses: response(),
        },
      },
      [`${target}/authors/{id}`]: {
        get: { summary: 'Get one author', parameters: [...targetParameters, idParameter], responses: response() },
      },
      [`${target}/authors/{id}/resources`]: {
        get: {
          summary: 'Get resources associated with an author',
          parameters: [...targetParameters, idParameter, ...cursorParameters],
          responses: response(),
        },
      },
      [`${basePath}/openapi.json`]: {
        get: { summary: 'OpenAPI document', responses: response() },
      },
    },
    components: {
      responses: {
        BadRequest: { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        NotFound: { description: 'Entity not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        InternalError: { description: 'Internal service error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                requestId: { type: 'string' },
                details: {},
              },
            },
          },
        },
      },
    },
  }
}
