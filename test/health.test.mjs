import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.mjs';

test('健康检查返回可用状态', async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
