# CoderForge Cloud SDK for JavaScript and TypeScript

Standard Functions share the framework's [asynchronous VFS file pool](function-vfs-cache.md)
with PHP and Python. TypeScript compiles ahead of time and uses the same runtime.
Warm non-writing requests do not wait on VFS; source updates invalidate the module
graph between invocations. Writes retain version-checked, acknowledged atomic commits.
See the contract for freshness and conflicts.

Version 1.0.0 API; protocol v1. MIT, copyright 2026 CoderForge.org Ltd.
Package: `@coderforge/cloud-sdk`. Typed ES modules, zero runtime dependencies,
modern browser Fetch/Streams APIs or Node >=20. TypeScript compiles ahead of time.

Historical integration validation: the unchanged `SdkError` class now lives in
`errors.ts`; `index.ts` preserves its public re-export. `native.ts` imports that
same value and imports only types from `index.ts`, removing the runtime cycle.
The SDK build and all 10 existing tests (nine core and one native) passed.
The original unbundled PHP/Python/JavaScript parity scenario also passed against
the tested PHP 8.3.36 package.

Historical deployment record: Manager/node1.5.5 was deployed; official node installer job prefix `f562d783`
succeeded. Retained PHP Functions 0028 and 0032 were migrated to 8.3.36. Remote
worker reload passed 2/2 with zero manual reloads. The live PHP catalog exposes
only 8.3.36; retired 8.3.35/8.3.33 asset URLs return HTTP 404. Live phpBB native
HTTP login, topic, reply, multipart upload/download SHA-256 and independent
session checks passed. The standard PHP scenario passed 11 Manager invocations
in 65.3 seconds, covering Kafka SDK, direct Function calls, files, CLI rollback
and internet access. Full root-stack and application-stack Terraform plans
are empty. SDK 0.1.0 remains unpublished; JavaScript stage 2 remains deferred.
See the [PHP security upgrade runbook](../../../cloud-builder-manager/docs/php-security-upgrade-2026-10-22.md).

```typescript
import { Client, Router, readJson } from '@coderforge/cloud-sdk';

const app = new Router();
app.route('GET', '/health', () => Response.json({ status: 'ok' }));
app.route('POST', '/echo', async request => Response.json(await readJson(request)));

const response = await app.fetch(new Request('https://local/health'), null);
```

Router passes Request.body and Response.body through without collecting them.
readJson explicitly collects at most 256 KiB by default. Middleware receives
`(request, {params, context}, next)` and may call next once. Route paths use
`/documents/{id}`. Errors propagate unless they are explicit HttpError values.

Capability calls require `new Client(hostTransport)` with an async protocol v1
callback provided by the runtime; the SDK does not invent an HTTP endpoint:

```typescript
await sdk.functions.invoke('c-ita-x1:s1:fnc:0021', { action: 'inspect' });
await sdk.messaging.publish('documents.ready', { id: 'demo' }, { key: 'demo' });
const secret = await sdk.secrets.get('c-ita-x1:s1:secret:0001', 'API_KEY');
const value = secret.reveal();
```

`sdk` above is a Client supplied with that host transport. CloudBuilder Manager
1.2.x and protocol 2 execute bundled JavaScript and inject context.sdk_bridge;
adapt it with jsonTransport. Missing transport fails with CAPABILITY_UNAVAILABLE
outside a configured mini-x64 guest.
SDK unit tests use explicit fixtures; live acceptance is a separate Terraform suite. Errors contain code/retryable; no operation retries
automatically. Secret JSON/string output is redacted, but the worker owner can
inspect its memory. Browser execution does not load native Node APIs, Kafka clients,
credentials or WASM runtimes. See source protocol.md for integration requirements.

`jsonTransport(hostBridge)` adapts an explicitly supplied async callback that
exchanges JSON text. It performs no network access and bounds bridge responses.

Use `fetchHandler(app)` for Hono
or another standard Fetch application. `staticFiles(files)` serves packaged
public_html assets with path validation. The explicit event adapter collects
bounded bodies in the browser; it does not change server transport streaming.

## Native mini-x64 guests

The same `new Client()` selects native HTTP only when the runtime sets
`CODERFORGE_RUNTIME=mini-x64` and `CODERFORGE_SDK_URL`. Invalid URLs fail closed;
explicit browser transports retain their existing behavior. Native calls POST
the unchanged `{version:1,operation,arguments}` body, authenticate with
`Authorization: Bearer <invocation token>`, and identify each call with a fresh
UUID in `X-CoderForge-Request-Id`. Responses keep the existing `{ok,value}` or
`{ok,error}` shape. Both directions are limited to 256 KiB, without redirects
or automatic retries.

Wrap a standard Fetch/Hono application with `fetchHandler(app)` and use the
returned function as the native server's Fetch handler. A native `Request`
returns a native `Response` with its body stream intact; the existing Function
event overload still returns its event response. The adapter captures
`X-CoderForge-Invocation-Token` before application code runs and isolates it
with Node AsyncLocalStorage, including concurrent requests sharing one warm
Client. A missing request token fails instead of using an environment token.
`CODERFORGE_INVOCATION_TOKEN` is reserved for non-HTTP single-process jobs.
Node context support is loaded only inside a configured native guest.

The bundle's `boot.sh` starts the application's standard server on `PORT`
(default 8080). The runtime forwards original HTTP requests; JSON Function
events arrive as POSTed event envelopes. The SDK starts no listener and stores
no platform credentials. The runtime supplies only the bridge endpoint and an
invocation-scoped token.

Run `node --test javascript/tests/native.test.mjs` after the TypeScript build
to test the native client against a loopback HTTP fixture.
