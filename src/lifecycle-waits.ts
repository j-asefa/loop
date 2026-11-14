/** Deadlines shared by CLI and connection lifecycle operations. */
export type LifecycleWaits = {
  stop: number;
  stopGrace: number;
  connection: number;
  connectionStart: number;
};

/** Existing process fixtures shorten these at their launch boundary. */
export function lifecycleWaits(
  env: NodeJS.ProcessEnv = process.env,
): LifecycleWaits {
  const read = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return {
    stop: read("LOOP_TEST_STOP_WAIT_MS", 20000),
    stopGrace: read("LOOP_TEST_STOP_GRACE_MS", 5000),
    connection: read("LOOP_TEST_CONNECTION_WAIT_MS", 180000),
    connectionStart: read("LOOP_TEST_CONNECTION_START_MS", 120000),
  };
}
