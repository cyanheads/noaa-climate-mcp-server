/**
 * @fileoverview Server-specific configuration for noaa-climate-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const PaginationConfigSchema = z.object({
  clampLimits: z
    .stringbool({ truthy: ['true'], falsy: ['false'], case: 'sensitive' })
    .default(true)
    .describe('Clamp positive integer read limits to the supported page ceiling.'),
});

const ServerConfigSchema = z.object({
  ...PaginationConfigSchema.shape,
  token: z
    .string()
    .min(1)
    .describe(
      'NOAA CDO API token. Obtain free at https://www.ncdc.noaa.gov/cdo-web/token. Sent as `token` header on every request.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;
let paginationConfig: z.infer<typeof PaginationConfigSchema> | undefined;

/** Reads the process-wide pagination policy without requiring a CDO token. */
export function getPaginationConfig() {
  paginationConfig ??= parseEnvConfig(PaginationConfigSchema, {
    clampLimits: 'NOAA_CLAMP_LIMITS',
  });
  return paginationConfig;
}

export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    token: 'NOAA_CDO_TOKEN',
    clampLimits: 'NOAA_CLAMP_LIMITS',
  });
  return _config;
}
