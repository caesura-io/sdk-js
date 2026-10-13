import { packageIdentity } from './package-identity.js';
import type { SdkIdentity } from './contracts.js';
export function sdkIdentity(
  transport: SdkIdentity['transport'],
  integration?: SdkIdentity['integration'],
): SdkIdentity {
  return {
    language: 'javascript',
    core: { ...packageIdentity },
    integration: integration && { ...integration },
    transport,
    runtime:
      typeof process !== 'undefined' && process.versions?.node
        ? { name: 'node', version: process.versions.node }
        : undefined,
  };
}
/** Diagnostic headers only. Caller metadata is never serialized. */
export function sdkHeaders(sdk: SdkIdentity): Record<string, string> {
  return {
    'x-caesura-sdk-language': sdk.language,
    'x-caesura-sdk-core-name': sdk.core.name,
    'x-caesura-sdk-core-version': sdk.core.version,
    'x-caesura-sdk-transport': sdk.transport,
    ...(sdk.integration
      ? {
          'x-caesura-sdk-integration-name': sdk.integration.name,
          'x-caesura-sdk-integration-version': sdk.integration.version,
        }
      : {}),
    ...(sdk.runtime
      ? {
          'x-caesura-sdk-runtime-name': sdk.runtime.name,
          'x-caesura-sdk-runtime-version': sdk.runtime.version,
        }
      : {}),
  };
}
