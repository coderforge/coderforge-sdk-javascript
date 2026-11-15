/** CloudBuilder capabilities. The host supplies a request-scoped transport. */
import { nativeTransport } from './native.js';
import { SdkError } from './errors.js';
export { SdkError } from './errors.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type CapabilityRequest = { version: 1; operation: string; arguments: Record<string, Json> };
export type Transport = (request: CapabilityRequest) => Promise<unknown>;
export function jsonTransport(bridge: (request: string) => Promise<string>): Transport {
  return async (request) => {
    const raw = await bridge(JSON.stringify(request));
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 256 * 1024) {
      throw new SdkError('PROTOCOL_ERROR', 'Invalid JSON bridge response');
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new SdkError('PROTOCOL_ERROR', 'Invalid JSON bridge response');
    }
  };
}
export class Secret {
  #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return 'Secret([REDACTED])';
  }
  toJSON(): string {
    return '[REDACTED]';
  }
}
function rid(value: string, kind: string): void {
  if (
    typeof value !== 'string' ||
    // region:zone:kind:number; region and zone are lowercase letters, digits, dots and dashes
    !new RegExp(`^[a-z0-9][a-z0-9.-]*:[a-z0-9][a-z0-9.-]*:${kind}:[0-9]+$`).test(value)
  )
    throw new TypeError(`A canonical ${kind} RID is required`);
}
function jsonCopy(value: unknown): Json {
  const seen = new Set<object>();
  function validate(item: unknown): void {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (
      typeof item !== 'object' ||
      item === null ||
      seen.has(item) ||
      (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)
    )
      throw new TypeError('SDK messages must contain only JSON values');
    seen.add(item);
    for (const child of Object.values(item)) validate(child);
    seen.delete(item);
  }
  validate(value);
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).length > 256 * 1024)
    throw new RangeError('SDK message exceeds 256 KiB');
  return JSON.parse(encoded) as Json;
}
export class Client {
  private readonly transport: Transport | undefined;
  constructor(transport?: Transport) {
    this.transport = transport ?? nativeTransport();
  }
  private async request(operation: string, args: Record<string, Json>): Promise<Json> {
    if (!this.transport)
      throw new SdkError('CAPABILITY_UNAVAILABLE', 'The runtime has not supplied an SDK transport');
    const request = jsonCopy({ version: 1, operation, arguments: args }) as CapabilityRequest;
    const result = await this.transport(request);
    if (
      !result ||
      typeof result !== 'object' ||
      !('ok' in result) ||
      typeof result.ok !== 'boolean'
    )
      throw new SdkError('PROTOCOL_ERROR', 'Invalid capability response');
    if (result.ok) {
      if (!('value' in result))
        throw new SdkError('PROTOCOL_ERROR', 'Missing capability response value');
      return jsonCopy(result.value);
    }
    const error = 'error' in result ? result.error : null;
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      typeof error.code !== 'string' ||
      !('message' in error) ||
      typeof error.message !== 'string'
    )
      throw new SdkError('PROTOCOL_ERROR', 'Invalid capability error');
    throw new SdkError(error.code, error.message, 'retryable' in error && error.retryable === true);
  }
  readonly functions = {
    invoke: async (
      target: string,
      event: Json,
      options: { timeoutMs?: number } = {},
    ): Promise<Json> => {
      rid(target, 'fnc');
      const timeout = options.timeoutMs ?? 30000;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000)
        throw new RangeError('timeoutMs must be an integer between 1 and 300000');
      return this.request('functions.invoke', { rid: target, event, timeout_ms: timeout });
    },
  };
  readonly messaging = {
    publish: async (
      topic: string,
      value: Json,
      options: { key?: string; idempotencyKey?: string } = {},
    ): Promise<Json> => {
      if (
        typeof topic !== 'string' ||
        !/^[A-Za-z0-9._-]{1,249}$/.test(topic) ||
        topic === '.' ||
        topic === '..'
      )
        throw new TypeError('Invalid Kafka topic');
      if (options.key !== undefined && typeof options.key !== 'string')
        throw new TypeError('key must be a string');
      if (
        options.idempotencyKey !== undefined &&
        (typeof options.idempotencyKey !== 'string' ||
          new TextEncoder().encode(options.idempotencyKey).length < 1 ||
          new TextEncoder().encode(options.idempotencyKey).length > 128)
      )
        throw new TypeError('idempotencyKey must contain 1 to 128 UTF-8 bytes');
      return this.request('messaging.publish', {
        topic,
        value,
        key: options.key ?? null,
        idempotency_key: options.idempotencyKey ?? null,
      });
    },
  };
  readonly secrets = {
    get: async (target: string, key: string): Promise<Secret> => {
      rid(target, 'secret');
      if (
        typeof key !== 'string' ||
        new TextEncoder().encode(key).length < 1 ||
        new TextEncoder().encode(key).length > 256
      )
        throw new TypeError('A secret key with 1 to 256 UTF-8 bytes is required');
      const value = await this.request('secrets.get', { rid: target, key });
      if (typeof value !== 'string')
        throw new SdkError('PROTOCOL_ERROR', 'Secret response must be a string');
      return new Secret(value);
    },
  };
}
export { Router, HttpError, readJson } from './http.js';
export { fetchHandler, staticFiles, decodeBody } from './fetch.js';
