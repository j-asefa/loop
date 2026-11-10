// Keep production callers on the same deadline; fixtures may shorten waits
// without selecting a different lifecycle or recovery path.
const waits = {
  LOOP_TEST_STOP_WAIT_MS: 20000,
  LOOP_TEST_STOP_GRACE_MS: 5000,
  LOOP_TEST_CONNECTION_WAIT_MS: 180000,
  LOOP_TEST_CONNECTION_START_MS: 120000,
};

export function testWait(name: keyof typeof waits) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : waits[name];
}
