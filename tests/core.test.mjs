import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client, SdkError, Router, readJson } from '../dist/index.js';
const fixture = JSON.parse(await readFile(new URL('./capabilities.json', import.meta.url)));

test('capability requests match the shared contract and secrets redact', async () => {
  const calls = [];
  const sdk = new Client(async (request) => {
    calls.push(request);
    return { ok: true, value: fixture.values[calls.length - 1] };
  });
  assert.deepEqual(
    await sdk.functions.invoke(
      fixture.function_rid,
      { message: 'hello', count: 2 },
      { timeoutMs: 1500 },
    ),
    { processed: true },
  );
  await sdk.messaging.publish(
    'documents.ready',
    { document: 'test.pdf' },
    { key: 'document-1', idempotencyKey: 'request-1' },
  );
  const secret = await sdk.secrets.get(fixture.secret_rid, 'API_KEY');
  assert.equal(secret.reveal(), 'test-only-secret');
  assert.equal(JSON.stringify(secret), '"[REDACTED]"');
  assert.equal(String(secret), 'Secret([REDACTED])');
  assert.deepEqual(calls, fixture.requests);
});
test('missing capability and denied operations fail without retries', async () => {
  await assert.rejects(
    new Client().functions.invoke(fixture.function_rid, null),
    (error) => error.code === 'CAPABILITY_UNAVAILABLE',
  );
  let calls = 0;
  const sdk = new Client(async () => {
    calls++;
    return fixture.denied;
  });
  await assert.rejects(
    sdk.messaging.publish('events', null),
    (error) => error instanceof SdkError && error.code === 'FORBIDDEN' && !error.retryable,
  );
  assert.equal(calls, 1);
});
test('invalid data, RIDs, topics and oversized messages never reach the host', async () => {
  const sdk = new Client(async () => assert.fail('Invalid request reached the host'));
  for (const event of [NaN, undefined, { x: undefined }, new Date(), 'x'.repeat(262144)])
    await assert.rejects(sdk.functions.invoke(fixture.function_rid, event));
  for (const rid of ['fnc:0021', '../fnc/21'])
    await assert.rejects(sdk.functions.invoke(rid, null));
  for (const topic of ['', '.', '..', 'bad/topic'])
    await assert.rejects(sdk.messaging.publish(topic, null));
});
test('malformed host responses cannot be mistaken for success', async () => {
  for (const response of [
    null,
    { ok: 1 },
    { ok: true },
    { ok: false, error: {} },
    { ok: true, value: [] },
  ]) {
    await assert.rejects(
      new Client(async () => response).secrets.get(fixture.secret_rid, 'key'),
      (error) => error.code === 'PROTOCOL_ERROR',
    );
  }
});
function router() {
  return new Router()
    .route('GET', '/users/{id}', (_request, { params, context }) =>
      Response.json({ id: params.id, context }),
    )
    .route('POST', '/echo', async (request) => Response.json(await readJson(request, 16)));
}
test('router extracts parameters, context and middleware', async () => {
  const app = router().use(async (_request, { context, params }, next) => {
    assert.equal(params.id, 'A B');
    const response = await next();
    response.headers.set('x-trace', context);
    return response;
  });
  const response = await app.fetch(new Request('https://local/users/A%20B'), 'trace');
  assert.deepEqual(await response.json(), { id: 'A B', context: 'trace' });
  assert.equal(response.headers.get('x-trace'), 'trace');
});
test('router handles 404, 405, HEAD and OPTIONS', async () => {
  const app = router();
  assert.equal((await app.fetch(new Request('https://local/missing'), null)).status, 404);
  const refused = await app.fetch(new Request('https://local/users/1', { method: 'POST' }), null);
  assert.equal(refused.status, 405);
  assert.equal(refused.headers.get('allow'), 'GET, HEAD, OPTIONS');
  assert.equal(
    (await app.fetch(new Request('https://local/users/1', { method: 'OPTIONS' }), null)).status,
    204,
  );
  assert.equal(
    await (await app.fetch(new Request('https://local/users/1', { method: 'HEAD' }), null)).text(),
    '',
  );
});
test('JSON reads reject malformed and oversized bodies', async () => {
  for (const [body, status] of [
    ['x'.repeat(17), 413],
    ['{bad', 400],
    ['{}', 200],
  ]) {
    assert.equal(
      (await router().fetch(new Request('https://local/echo', { method: 'POST', body }), null))
        .status,
      status,
    );
  }
});
test('stream routing preserves backpressure and single consumption', async () => {
  let reads = 0;
  const source = new ReadableStream(
    {
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array([reads]));
        if (reads === 3) controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const app = new Router().route('POST', '/stream', (request) => new Response(request.body));
  const request = new Request('https://local/stream', {
    method: 'POST',
    body: source,
    duplex: 'half',
  });
  const response = await app.fetch(request, null);
  assert.equal(reads, 0);
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([1]));
  assert.equal(reads, 1);
  await reader.cancel();
});
test('invalid routes, bad path encoding and double next are refused', async () => {
  for (const path of ['relative', '/{id}/{id}', '/{bad-name}'])
    assert.throws(() => new Router().route('GET', path, () => new Response()));
  assert.equal((await router().fetch(new Request('https://local/users/%ZZ'), null)).status, 400);
  const app = router().use(async (_request, _context, next) => {
    await next();
    return next();
  });
  await assert.rejects(
    app.fetch(new Request('https://local/users/1'), null),
    /only be called once/,
  );
});
