/**
 * Remote API for browser memory status and preview/confirmed import. Descriptors
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
    if (typeof value.projectRoot !== 'string' || !isObj(value.share) || typeof value.share.active !== 'boolean' || ![null, 'global', 'project', 'directory'].includes(value.share.via)) fail('status sharing');
    if (!isObj(value.claude) || typeof value.claude.dir !== 'string' || typeof value.claude.exists !== 'boolean' || !Number.isInteger(value.claude.count) || value.claude.count < 0) fail('status source');
    return value;
  },
};

/** Import requires an explicit preview/commit choice. */
export const importRequestSchema = {
  parse(value) {
    if (!isObj(value) || typeof value.dryRun !== 'boolean') fail('import request');
    return { ...statusRequestSchema.parse(value), dryRun: value.dryRun };
  },
};

export const importResponseSchema = {
  parse(value) {
    if (!isObj(value) || !['projectRoot', 'from', 'to'].every(key => typeof value[key] === 'string') || typeof value.dryRun !== 'boolean') fail('import response');
    if (!['copied', 'identical', 'conflicts'].every(key => Array.isArray(value[key]) && value[key].every(item => typeof item === 'string'))) fail('import files');
    if (!Number.isInteger(value.indexAdded) || value.indexAdded < 0) fail('import indexAdded');
    if (value.refused !== undefined && !['shared', 'no-source', 'memory-off'].includes(value.refused)) fail('import refusal');
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

export const importDescriptor = {
  ...statusDescriptor,
  id: `${PACKAGE}#${SERVICE}/import`,
  method: 'import',
  parameters: [{ name: 'request', wire: 'request', source: 'json', codec: strict('ImportRequest', importRequestSchema) }],
  result: strict('ImportResponse', importResponseSchema),
};

/** Host contribution exported as `./typert`. */
export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [
    { name: 'StatusRequest', create: () => statusRequestSchema },
    { name: 'StatusResponse', create: () => statusResponseSchema },
    { name: 'ImportRequest', create: () => importRequestSchema },
    { name: 'ImportResponse', create: () => importResponseSchema },
  ],
  model: { services: [], events: [], objects: [] },
  invocations: [statusDescriptor, importDescriptor],
};
export default TYPERT;

/**
 * Create and mount the Remote service.
 * @param ctx - plugin context.
 * @param handlers - status and import callbacks `(request, signal) => Promise<response>`.
 * @returns a promise settling when the service plugin is mounted.
 */
export async function mountRemote(ctx, { status, import: importFn }) {
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
      // Equivalent of the Remote decorators on both methods below.
      for (const name of ['status', 'import']) {
        Remote(name)(this[name], {
          kind: 'method', name, private: false, static: false,
          addInitializer: init => init.call(this),
        });
      }
    }
    async import(request, signal) {
      return importFn(importRequestSchema.parse(request), signal);
    }
    async status(request, signal) {
      return status(statusRequestSchema.parse(request), signal);
    }
  }
  return ctx.plugin(RecollectRemote);
}
