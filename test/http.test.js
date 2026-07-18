import test from 'node:test';
import assert from 'node:assert/strict';

import { copyResponseHeaders } from '../packages/core/http.js';

test('copyResponseHeaders removes encoding and transport headers from decoded fetch bodies', () => {
  const source = new Headers({
    'content-type': 'application/json',
    'content-encoding': 'gzip',
    'content-length': '123',
    connection: 'keep-alive',
    'x-upstream': 'kept',
  });
  assert.deepEqual(copyResponseHeaders(source), {
    'content-type': 'application/json',
    'x-upstream': 'kept',
  });
  assert.deepEqual(copyResponseHeaders(source, { bodyLength: 7 }), {
    'content-type': 'application/json',
    'x-upstream': 'kept',
    'content-length': '7',
  });
});
