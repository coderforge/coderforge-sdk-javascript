// Compile against the packed package, with no access to its TypeScript source.
import { Client, Router, type Transport, type Json } from '@coderforge/cloud-sdk';
import { readJson } from '@coderforge/cloud-sdk/http';

const transport: Transport = async (request) => ({ ok: true, value: request.arguments });
const sdk = new Client(transport);
const result: Json = await sdk.functions.invoke('c-ita-x1:s1:fnc:0021', { hello: 'world' });
const app = new Router<{ trace: string }>();
app.route('POST', '/documents/{id}', async (request, { params, context }) => {
  return Response.json({ id: params.id, trace: context.trace, value: await readJson(request) });
});
await app.fetch(
  new Request('https://example.test/documents/demo', { method: 'POST', body: '{}' }),
  { trace: 'test' },
);
void result;
