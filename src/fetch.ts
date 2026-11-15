/** Standard Fetch API adapter, compatible with Hono and plain fetch handlers. */
import { invocationContext } from './native.js';
export interface FunctionEvent {
  rawPath?: string;
  path?: string;
  rawQueryString?: string;
  requestContext?: { http?: { method?: string } };
  httpMethod?: string;
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}
export function decodeBody(event: FunctionEvent): Uint8Array {
  return event.isBase64Encoded
    ? Uint8Array.from(atob(event.body || ''), (character) => character.charCodeAt(0))
    : new TextEncoder().encode(event.body || '');
}
export function fetchHandler<C>(app: {
  fetch(request: Request, context: C): Response | Promise<Response>;
}): {
  (
    event: FunctionEvent,
    context: C,
  ): Promise<{
    statusCode: number;
    headers: Record<string, string>;
    cookies: string[];
    body: string;
    isBase64Encoded: boolean;
  }>;
  (request: Request, context?: C): Promise<Response>;
} {
  async function handler(event: FunctionEvent, context: C) {
    const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
    const headers = new Headers(event.headers);
    const url = new URL(
      event.rawPath || event.path || '/',
      'https://' + (headers.get('host') || 'function.local'),
    );
    url.search = event.rawQueryString || '';
    const body = decodeBody(event);
    if (body.length > 25 * 1024 * 1024)
      throw new RangeError('Fetch request exceeds its worker limit');
    const request = new Request(url, {
      method,
      headers,
      ...(method !== 'GET' && method !== 'HEAD' ? { body } : {}),
    });
    const response = await app.fetch(request, context);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 64 * 1024 * 1024) {
            await reader.cancel();
            throw new RangeError('Fetch response exceeds its worker limit');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const encoded = [];
    for (let index = 0; index < bytes.length; index += 24576)
      encoded.push(btoa(String.fromCharCode(...bytes.subarray(index, index + 24576))));
    const outgoing: Record<string, string> = {};
    for (const [name, value] of response.headers)
      if (!['set-cookie', 'content-length', 'transfer-encoding', 'connection'].includes(name))
        outgoing[name] = value;
    return {
      statusCode: response.status,
      headers: outgoing,
      cookies: response.headers.getSetCookie(),
      body: encoded.join(''),
      isBase64Encoded: true,
    };
  }
  return (async (event: FunctionEvent | Request, context?: C) => {
    // Capture the header before awaiting; a warm Client reads this request's
    // AsyncLocalStorage scope instead of retaining a token in its constructor.
    if (event instanceof Request)
      return invocationContext(event.headers, async () => app.fetch(event, context as C));
    return invocationContext(new Headers(event.headers), async () => handler(event, context as C));
  }) as {
    (event: FunctionEvent, context: C): ReturnType<typeof handler>;
    (request: Request, context?: C): Promise<Response>;
  };
}

/** Read-only bundle hosting. The reader is explicitly supplied by the runtime. */
export function staticFiles(read: (path: string) => Uint8Array, root = 'public_html') {
  return (request: Request): Response => {
    const path = decodeURIComponent(new URL(request.url).pathname);
    if (path.includes('\\') || path.includes('\0') || path.split('/').includes('..'))
      return new Response('Invalid path', { status: 400 });
    const name = path.endsWith('/') ? path + 'index.html' : path;
    try {
      const body = read(root + name);
      const extension = name.split('.').pop();
      const types: Record<string, string> = {
        html: 'text/html; charset=utf-8',
        css: 'text/css; charset=utf-8',
        js: 'text/javascript; charset=utf-8',
        json: 'application/json',
        txt: 'text/plain; charset=utf-8',
        svg: 'image/svg+xml',
        png: 'image/png',
      };
      return new Response(body, {
        headers: {
          'content-type': types[extension || ''] || 'application/octet-stream',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  };
}
