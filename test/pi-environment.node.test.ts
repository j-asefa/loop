import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { piExistingEnvironment } from '../src/native-auth/account-policy';

test('Pi retains native homes but excludes ambient credentials and injected code', () => {
  const source = { HOME: '/native', PATH: '/bin', PI_CODING_AGENT_DIR: '/native/pi',
    OPENAI_API_KEY: 'secret', ANTHROPIC_BASE_URL: 'https://example.invalid',
    FUTURE_PROVIDER_API_KEY: 'secret', NODE_OPTIONS: '--import injected',
    LOOP_SESSION_TOKEN: 'secret', CLI_API_TOKEN: 'secret' };
  assert.deepEqual(piExistingEnvironment(source), { HOME: '/native', PATH: '/bin', PI_CODING_AGENT_DIR: '/native/pi' });
  assert.equal(source.OPENAI_API_KEY, 'secret');
  assert.throws(() => piExistingEnvironment({ HOME: 'relative' }), /home/);
  assert.throws(() => piExistingEnvironment({ HOME: '/native', PI_CODING_AGENT_DIR: 'relative' }), /absolute/);
});
