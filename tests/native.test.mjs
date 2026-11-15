import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Client, SdkError, fetchHandler } from '../dist/index.js';

test('native bridge preserves wire, bounded replies and concurrent request identity', async () => {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push({ headers: request.headers, body });
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/bridge' }).end();
      return;
    }
    if (request.url === '/large') {
      response.end(' '.repeat(256 * 1024 + 1));
      return;
    }
    if (body.operation === 'secrets.get') {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'Refused' } }));
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, value: body.arguments }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const saved = { ...process.env };
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  process.env.CODERFORGE_RUNTIME = 'mini-x64';
  process.env.CODERFORGE_SDK_URL = endpoint + '/bridge';
  process.env.CODERFORGE_INVOCATION_TOKEN = 'single-job';
  try {
    const sdk = new Client();
    const handler = fetchHandler({
      async fetch(request) {
        const token = request.headers.get('X-CoderForge-Invocation-Token');
        await new Promise((resolve) => setTimeout(resolve, token === 'first' ? 10 : 1));
        await sdk.messaging.publish('orders', { token });
        return Response.json({ ok: true });
      },
    });
    const responses = await Promise.all(
      ['first', 'second'].map((token) =>
        handler(
          new Request('http://guest/', {
            headers: { 'X-CoderForge-Invocation-Token': token },
          }),
          null,
        ),
      ),
    );
    assert.ok(responses.every((response) => response instanceof Response));
    assert.equal(calls.length, 2);
    for (const { headers, body } of calls) {
      assert.deepEqual(Object.keys(body).sort(), ['arguments', 'operation', 'version']);
      assert.equal(body.version, 1);
      assert.equal(headers.authorization, 'Bearer ' + body.arguments.value.token);
      assert.match(headers['x-coderforge-request-id'], /^[0-9a-f-]{36}$/);
    }
    assert.notEqual(
      calls[0].headers['x-coderforge-request-id'],
      calls[1].headers['x-coderforge-request-id'],
    );
    const event = await handler(
      { headers: { 'x-coderforge-invocation-token': 'event-job' } },
      null,
    );
    assert.equal(event.statusCode, 200);
    assert.equal(calls.at(-1).headers.authorization, 'Bearer event-job');
    await assert.rejects(
      handler(new Request('http://guest/'), null),
      (error) => error.code === 'CAPABILITY_UNAVAILABLE',
    );
    assert.equal(calls.length, 3);
    let pulls = 0;
    const streaming = fetchHandler({
      fetch() {
        return new Response(
          new ReadableStream(
            {
              async pull(controller) {
                pulls++;
                await sdk.messaging.publish('orders', { streamed: true });
                controller.enqueue(new TextEncoder().encode('streamed'));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        );
      },
    });
    const lazy = await streaming(
      new Request('http://guest/', {
        headers: { 'X-CoderForge-Invocation-Token': 'stream-job' },
      }),
    );
    assert.equal(pulls, 0);
    assert.equal(await lazy.text(), 'streamed');
    assert.equal(calls.at(-1).headers.authorization, 'Bearer stream-job');
    await sdk.functions.invoke('c-ita-x1:s1:fnc:1', { value: 1 });
    assert.equal(calls.at(-1).headers.authorization, 'Bearer single-job');
    await assert.rejects(
      sdk.secrets.get('c-ita-x1:s1:secret:1', 'key'),
      (error) => error instanceof SdkError && error.code === 'FORBIDDEN',
    );
    for (const suffix of ['/redirect', '/large']) {
      process.env.CODERFORGE_SDK_URL = endpoint + suffix;
      const before = calls.length;
      await assert.rejects(new Client().messaging.publish('orders', {}), SdkError);
      assert.equal(calls.length, before + 1);
    }
    process.env.CODERFORGE_SDK_URL = 'file:///bad';
    assert.throws(
      () => new Client(),
      (error) => error.code === 'CAPABILITY_UNAVAILABLE',
    );
    const callback = new Client(async (request) => ({ ok: true, value: request.version }));
    assert.equal(await callback.messaging.publish('orders', {}), 1);
    process.env.CODERFORGE_RUNTIME = 'browser';
    await assert.rejects(
      new Client().messaging.publish('orders', {}),
      (error) => error.code === 'CAPABILITY_UNAVAILABLE',
    );
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
