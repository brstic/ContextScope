import { CONTEXTSCOPE_VERSION } from '@contextscope/shared';
const endpoints = [
  ['health', 'HealthResponse'],
  ['overview', 'OverviewResponse'],
  ['filters', 'FiltersResponse'],
  ['requests', 'Page<RequestSummary>'],
  ['requests/{id}', 'RequestDetail'],
  ['requests/{id}/context', 'RequestContext'],
  ['requests/{id}/findings', 'Finding[]'],
  ['requests/{id}/content', 'ContentResponse'],
  ['sessions', 'Page<SessionSummary>'],
  ['sessions/{id}', 'SessionDetail'],
  ['cache/summary', 'CacheSummary'],
  ['cache/trends', 'TimeBucket[]'],
  ['costs/summary', 'CostSummary'],
  ['costs/trends', 'TimeBucket[]'],
  ['optimizations', 'Finding[]'],
  ['compare', 'CompareResponse'],
  ['providers', 'ProviderInfo[]'],
  ['settings', 'SettingsResponse'],
  ['export', 'ExportFile'],
  ['events', 'LiveEvent SSE'],
  ['openapi.json', 'OpenAPI document'],
] as const;
const paths: Record<string, unknown> = {};
for (const [path, response] of endpoints)
  paths[`/api/${path}`] = {
    get: {
      summary: response,
      parameters: path.includes('{id}')
        ? [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
        : [],
      responses: {
        '200': {
          description: response,
          content: { [path === 'events' ? 'text/event-stream' : 'application/json']: { schema: {} } },
        },
        '400': { description: 'Invalid request' },
        '401': { description: 'Bearer token required' },
        '404': { description: 'Not found or content unavailable' },
      },
    },
  };
paths['/api/settings'] = {
  ...(paths['/api/settings'] as object),
  put: {
    summary: 'Update capture, retention and pricing overrides',
    parameters: [{ name: 'x-contextscope-csrf', in: 'header', required: true, schema: { const: '1' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              captureMode: { enum: ['metadata', 'deep_memory', 'deep_persistent'] },
              contentRetentionHours: { type: 'number', exclusiveMinimum: 0, maximum: 8760 },
              metadataRetentionDays: { type: 'integer', minimum: 0 },
              pricingOverrides: { type: 'array', items: { type: 'object' } },
            },
          },
        },
      },
    },
    responses: {
      '200': { description: 'SettingsResponse' },
      '400': { description: 'Invalid settings' },
      '403': { description: 'CSRF rejected' },
    },
  },
};
paths['/api/import'] = {
  post: {
    summary: 'Import contextscope.trace JSON or JSONL, maximum 50 MiB',
    requestBody: {
      required: true,
      content: {
        'application/json': { schema: { type: 'object' } },
        'text/plain': { schema: { type: 'string' } },
        'application/x-ndjson': { schema: { type: 'string' } },
      },
    },
    responses: {
      '200': { description: 'ImportResult' },
      '400': { description: 'Invalid input' },
      '403': { description: 'CSRF rejected' },
      '413': { description: 'Body too large' },
    },
  },
};
/** OpenAPI 3.1 endpoint inventory. DTO names refer to packages/shared/src/api.ts. */
export const openapi = {
  openapi: '3.1.0',
  info: { title: 'ContextScope dashboard API', version: CONTEXTSCOPE_VERSION },
  security: [{ bearerAuth: [] }],
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
  paths,
};
