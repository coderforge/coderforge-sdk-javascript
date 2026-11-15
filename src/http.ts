/** Uses standard Fetch Request/Response objects; streams are never collected by routing. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function readJson(request: Request, limit = 256 * 1024): Promise<unknown> {
  if (!request.body) throw new HttpError(400, 'Invalid JSON body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, 'Request body exceeds its read limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}
export type RouteContext<C> = { params: Record<string, string>; context: C };
export type Handler<C> = (
  request: Request,
  context: RouteContext<C>,
) => Response | Promise<Response>;
export type Middleware<C> = (
  request: Request,
  context: RouteContext<C>,
  next: () => Promise<Response>,
) => Response | Promise<Response>;
export class Router<C = unknown> {
  private readonly routes: { method: string; pattern: RegExp; handler: Handler<C> }[] = [];
  private readonly middleware: Middleware<C>[] = [];
  route(method: string, path: string, handler: Handler<C>): this {
    if (!/^\/[A-Za-z0-9_./{}-]*$/.test(path))
      throw new TypeError('Routes must use absolute paths and {parameter} segments');
    const names = [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((match) => match[1]!);
    if (new Set(names).size !== names.length) throw new TypeError('Duplicate route parameter');
    let pattern = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const name of names) pattern = pattern.replace(`\\{${name}\\}`, `(?<${name}>[^/]+)`);
    if (pattern.includes('\\{') || pattern.includes('\\}'))
      throw new TypeError('Invalid route parameter');
    const verb = method.toUpperCase();
    const regex = new RegExp(`^${pattern}$`);
    if (
      !/^[A-Z]+$/.test(verb) ||
      this.routes.some((route) => route.method === verb && route.pattern.source === regex.source)
    )
      throw new TypeError('Invalid or duplicate route');
    this.routes.push({ method: verb, pattern: regex, handler });
    return this;
  }
  use(middleware: Middleware<C>): this {
    this.middleware.push(middleware);
    return this;
  }
  async fetch(request: Request, context: C): Promise<Response> {
    const path = new URL(request.url).pathname;
    const method = request.method.toUpperCase();
    const matches = this.routes.filter((route) => route.pattern.test(path));
    const allowed = new Set(matches.map((route) => route.method));
    if (allowed.has('GET')) allowed.add('HEAD');
    const selected =
      matches.find((route) => route.method === method) ??
      (method === 'HEAD' ? matches.find((route) => route.method === 'GET') : undefined);
    const routeContext: RouteContext<C> = {
      params: Object.create(null) as Record<string, string>,
      context,
    };
    const endpoint = async (): Promise<Response> => {
      if (!selected) {
        if (!matches.length) return Response.json({ error: 'Not found' }, { status: 404 });
        return new Response(null, {
          status: method === 'OPTIONS' ? 204 : 405,
          headers: { allow: [...allowed, 'OPTIONS'].sort().join(', ') },
        });
      }
      return selected.handler(request, routeContext);
    };
    const dispatch = async (index: number): Promise<Response> => {
      const middleware = this.middleware[index];
      if (!middleware) return endpoint();
      let called = false;
      return middleware(request, routeContext, async () => {
        if (called) throw new Error('Middleware next() can only be called once');
        called = true;
        return dispatch(index + 1);
      });
    };
    let response: Response;
    try {
      const groups = selected?.pattern.exec(path)?.groups ?? {};
      for (const [name, value] of Object.entries(groups))
        routeContext.params[name] = decodeURIComponent(value);
      response = await dispatch(0);
    } catch (error) {
      if (error instanceof HttpError)
        response = Response.json({ error: error.message }, { status: error.status });
      else if (error instanceof URIError)
        response = Response.json({ error: 'Invalid path encoding' }, { status: 400 });
      else throw error;
    }
    if (!(response instanceof Response)) throw new TypeError('A route must return a Response');
    if (method === 'HEAD') {
      await response.body?.cancel();
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  }
}
