/** Native guest bridge. Browser imports never load Node modules or perform I/O. */
import { SdkError } from './errors.js';
import type { CapabilityRequest, Transport } from './index.js';

type Environment = Record<string, string | undefined>;
type Invocation = { token: string | null };
type ContextStorage = {
  getStore(): Invocation | undefined;
  run<T>(context: Invocation, callback: () => T): T;
};
let storage: Promise<ContextStorage> | undefined;

function environment(): Environment {
  return (globalThis as unknown as { process?: { env?: Environment } }).process?.env ?? {};
}

async function invocationStorage(): Promise<ContextStorage> {
  if (!storage) {
    // A computed import is intentionally deferred until native guest execution.
    const load = (name: string): Promise<unknown> => import(name);
    storage = load('node:async_hooks').then((module) => {
      const Constructor = (module as { AsyncLocalStorage: new () => ContextStorage })
        .AsyncLocalStorage;
      return new Constructor();
    });
  }
  try {
    return await storage;
  } catch {
    throw new SdkError('CAPABILITY_UNAVAILABLE', 'Native invocation context is unavailable');
  }
}

export async function invocationContext<T>(
  headers: Headers,
  callback: () => Promise<T>,
): Promise<T> {
  if (environment().CODERFORGE_RUNTIME !== 'mini-x64') return callback();
  const captured = { token: headers.get('X-CoderForge-Invocation-Token') };
  const context = await invocationStorage();
  let result: T;
  try {
    result = await context.run(captured, callback);
  } catch (error) {
    captured.token = null;
    throw error;
  }
  if (!(result instanceof Response) || !result.body) {
    captured.token = null;
    return result;
  }
  // The server may consume a response after app.fetch returns. Bind each lazy
  // read/cancel as well, without prefetching or collecting its body.
  const reader = result.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        return context.run(captured, async () => {
          try {
            const { value, done } = await reader.read();
            if (done) {
              captured.token = null;
              reader.releaseLock();
              controller.close();
            } else controller.enqueue(value);
          } catch (error) {
            captured.token = null;
            reader.releaseLock();
            controller.error(error);
          }
        });
      },
      cancel(reason) {
        return context.run(captured, async () => {
          try {
            await reader.cancel(reason);
          } finally {
            captured.token = null;
            reader.releaseLock();
          }
        });
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  }) as T;
}

export function nativeTransport(): Transport | undefined {
  const env = environment();
  if (env.CODERFORGE_RUNTIME !== 'mini-x64') return undefined;
  const endpoint = env.CODERFORGE_SDK_URL ?? '';
  try {
    const parsed = new URL(endpoint);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      endpoint.length > 2048 ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      /[\x00-\x20\x7f]/.test(endpoint)
    )
      throw new Error();
  } catch {
    throw new SdkError('CAPABILITY_UNAVAILABLE', 'Invalid mini-x64 SDK endpoint');
  }

  return async (request: CapabilityRequest): Promise<unknown> => {
    const fallback = environment().CODERFORGE_INVOCATION_TOKEN;
    const context = (await invocationStorage()).getStore();
    const token = context ? context.token : fallback;
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~+/-]{1,8192}=*$/.test(token))
      throw new SdkError('CAPABILITY_UNAVAILABLE', 'Missing or invalid invocation token');
    const body = JSON.stringify(request);
    if (new TextEncoder().encode(body).length > 256 * 1024)
      throw new RangeError('SDK message exceeds 256 KiB');
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          accept: 'application/json',
          'X-CoderForge-Request-Id': crypto.randomUUID(),
        },
        body,
        signal: AbortSignal.timeout(
          Math.max(30000, Number(request.arguments.timeout_ms ?? 0) + 5000),
        ),
      });
    } catch {
      throw new SdkError('TRANSPORT_ERROR', 'Native SDK request failed');
    }
    const reader = response.body?.getReader();
    const pieces: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 256 * 1024) {
            await reader.cancel();
            throw new SdkError('PROTOCOL_ERROR', 'Native SDK response exceeds 256 KiB');
          }
          pieces.push(value);
        }
      } catch (error) {
        if (error instanceof SdkError) throw error;
        throw new SdkError('TRANSPORT_ERROR', 'Native SDK request failed');
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const piece of pieces) {
      bytes.set(piece, offset);
      offset += piece.length;
    }
    let result: unknown;
    try {
      result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new SdkError('PROTOCOL_ERROR', 'Invalid native SDK response');
    }
    if (
      !response.ok &&
      !(result && typeof result === 'object' && 'ok' in result && result.ok === false)
    )
      throw new SdkError('TRANSPORT_ERROR', 'Native SDK request failed');
    return result;
  };
}
