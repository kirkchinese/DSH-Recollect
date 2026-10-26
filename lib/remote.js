/**
 * Remote API for the browser settings section: one read-only `status` call
 * that reports what this plugin loads for a working directory. Descriptors
 * are hand-written in the shape the Typert compiler would generate; the
 * runtime schemas are small `parse` validators (no Zod dependency).
 * @module @kirkchinese/dsh-recollect/remote
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

export const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;
export const SERVICE = 'recollect';

const fail = what => {
  throw new TypeError(`invalid ${what}`);
};
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const optString = (v, what) => (v === undefined || typeof v === 'string' ? v : fail(what));

/** Request: `{ cwd?: string }`. */
export const statusRequestSchema = {
  parse(value) {
    if (value === undefined || value === null) return {};
    if (!isObj(value)) fail('status request');
    return { ...(value.cwd !== undefined ? { cwd: optString(value.cwd, 'cwd') } : {}) };
  },
};

/** Response: plain JSON describing the loaded state. */
export const statusResponseSchema = {
  parse(value) {
    if (!isObj(value) || typeof value.cwd !== 'string' || !Array.isArray(value.files) || !Array.isArray(value.memories)) fail('status response');
    return value;
  },
};

const strict = (name, schema) => ({ mode: 'strict', typeSymbol: `${PACKAGE}#${name}`, create: () => schema });

export const statusDescriptor = {
  id: `${PACKAGE}#${SERVICE}/status`,
  service: SERVICE,
  namespace: SERVICE,
  method: 'status',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: strict('StatusRequest', statusRequestSchema) }],
  cancellation: { parameter: 'signal' },
  result: strict('StatusResponse', statusResponseSchema),
  sourceLocation: { file: 'index.js', line: 1, column: 1 },
};

/** Host contribution exported as `./typert`. */
export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [
    { name: 'StatusRequest', create: () => statusRequestSchema },
    { name: 'StatusResponse', create: () => statusResponseSchema },
  ],
  model: { services: [], events: [], objects: [] },
  invocations: [statusDescriptor],
};
export default TYPERT;

/**
 * Create and mount the Remote service.
 * @param ctx - plugin context.
 * @param status - `(request, signal) => Promise<response>`.
 * @returns a promise settling when the service plugin is mounted.
 */
export async function mountRemote(ctx, status) {
  const require = createRequire(import.meta.url);
  let protocol;
  try {
    protocol = await import('@deepseek-ai/dsh-typert-protocol');
  } catch {
    protocol = require('@deepseek-ai/dsh-typert-protocol');
  }
  const { Remote, TypertRemoteService } = protocol;
  class RecollectRemote extends TypertRemoteService {
    constructor(scoped) {
      super(scoped, SERVICE);
      // Equivalent of `@Remote('status')` on the method below.
      Remote('status')(this.status, {
        kind: 'method', name: 'status', private: false, static: false,
        addInitializer: init => init.call(this),
      });
    }
    async status(request, signal) {
      return status(statusRequestSchema.parse(request), signal);
    }
  }
  return ctx.plugin(RecollectRemote);
}
