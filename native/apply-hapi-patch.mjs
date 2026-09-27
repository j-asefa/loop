import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const root = process.argv[2];
if (
  !root ||
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim() !== "0239edf38e2da653d662f31039e24ccea04c7837"
)
  throw new Error("Requires exact HAPI 0.30.7 source commit");
const changes = new Map();
function edit(path, from, to, all = false) {
  const source =
    changes.get(path) ??
    execFileSync("git", ["show", "HEAD:" + path], {
      cwd: root,
      encoding: "utf8",
    });
  if (!source.includes(from))
    throw new Error(
      "HAPI patch context missing: " + path + " " + from.slice(0, 80),
    );
  changes.set(
    path,
    all ? source.replaceAll(from, to) : source.replace(from, to),
  );
}
function imp(path) {
  edit(
    path,
    "import ",
    "import { managedLaunch, managedBinding, managedCodexArgs, managedThread, managedGuard, managedClaude } from '@/loopManaged';\nimport ",
  );
}
copyFileSync(
  new URL("./loopManaged.ts", import.meta.url),
  join(root, "cli/src/loopManaged.ts"),
);
edit(
  "shared/src/apiTypes.ts",
  "export const SpawnSessionRequestSchema = z.object({",
  "export const SpawnSessionRequestSchema = z.object({\n    loopLaunchId: z.string().uuid().optional(),",
);
edit(
  "shared/src/schemas.ts",
  "export const MetadataSchema = z.object({",
  "export const MetadataSchema = z.object({\n    loopLaunchId: z.string().optional(),",
);
edit(
  "hub/src/web/routes/machines.ts",
  "            startingMode\n        )",
  "            startingMode,\n            parsed.data.loopLaunchId\n        )",
);
edit(
  "hub/src/sync/syncEngine.ts",
  "startingMode?: 'remote' | 'pty'\n    ): ReturnType<RpcGateway['spawnSession']>",
  "startingMode?: 'remote' | 'pty',\n        loopLaunchId?: string\n    ): ReturnType<RpcGateway['spawnSession']>",
);
edit(
  "hub/src/sync/syncEngine.ts",
  "            startingMode\n        )",
  "            startingMode,\n            undefined,\n            loopLaunchId\n        )",
);
edit(
  "hub/src/sync/rpcGateway.ts",
  "        forkSession?: boolean\n",
  "        forkSession?: boolean,\n        loopLaunchId?: string\n",
);
edit(
  "hub/src/sync/rpcGateway.ts",
  "type: 'spawn-in-directory',",
  "type: 'spawn-in-directory',\n                    loopLaunchId,",
);
edit(
  "cli/src/modules/common/rpcTypes.ts",
  "export interface SpawnSessionOptions {",
  "export interface SpawnSessionOptions {\n    loopLaunchId?: string",
);
edit(
  "cli/src/api/apiMachine.ts",
  "const { directory, sessionId, existingSessionId,",
  "const { loopLaunchId, directory, sessionId, existingSessionId,",
);
edit(
  "cli/src/api/apiMachine.ts",
  "const result = await spawnSession({",
  "const result = await spawnSession({\n                loopLaunchId,",
);
imp("cli/src/runner/run.ts");
edit(
  "cli/src/runner/run.ts",
  "const args = buildCliArgs(agent, options, yolo);",
  "Object.assign(extraEnv, managedLaunch(options.loopLaunchId, spawnDirectory));\n        delete extraEnv.LOOP_CODEX_APP_SERVER_TOKEN;\n        delete extraEnv.LOOP_CODEX_APP_SERVER_ENDPOINT;\n        const args = buildCliArgs(agent, options, yolo);",
);
imp("cli/src/agent/sessionFactory.ts");
edit(
  "cli/src/agent/sessionFactory.ts",
  "        ...options.metadataOverrides",
  "        ...(process.env.LOOP_LAUNCH_ID ? {loopLaunchId:process.env.LOOP_LAUNCH_ID} : {}),\n        ...options.metadataOverrides",
);
imp("cli/src/codex/shared/launch.ts");
edit(
  "cli/src/codex/shared/launch.ts",
  "cwd: directory, serverArgs, tuiArgs,",
  "cwd: directory, serverArgs: managedCodexArgs(serverArgs), tuiArgs,",
);
edit(
  "cli/src/codex/shared/launch.ts",
  "threadParams: {\n            ...(model",
  "threadParams: managedThread({\n            ...(model",
);
edit(
  "cli/src/codex/shared/launch.ts",
  "developerInstructions: getCodexSystemPrompt()\n        }",
  "developerInstructions: getCodexSystemPrompt()\n        })",
);
imp("cli/src/codex/codexAppServerClient.ts");
edit(
  "cli/src/codex/codexAppServerClient.ts",
  "async request<T = unknown>(method: string, params?: unknown): Promise<T> {",
  "async request<T = unknown>(method: string, params?: unknown): Promise<T> {\n        await managedGuard((m,p)=>this.sendRequest(m,p,{timeoutMs:20000}),method,params);",
);
imp("cli/src/codex/shared/runtime.ts");
// The managed worker owns one subscription-authenticated Codex app-server.
// Every per-session HAPI runtime keeps its own isolated Loop gateway but
// multiplexes its native thread over that shared app-server connection.
edit(
  "cli/src/codex/shared/runtime.ts",
  "const upstream = process.platform === 'win32' ? `ws://127.0.0.1:${await freePort()}` : `unix://${join(sockets, 'engine.sock')}`;\n    const upstreamToken = process.platform === 'win32' ? randomBytes(32).toString('hex') : undefined;",
  "const upstream = process.env.LOOP_CODEX_APP_SERVER_ENDPOINT || (process.platform === 'win32' ? `ws://127.0.0.1:${await freePort()}` : `unix://${join(sockets, 'engine.sock')}`);\n    const upstreamToken = process.env.LOOP_CODEX_APP_SERVER_TOKEN || (process.platform === 'win32' ? randomBytes(32).toString('hex') : undefined);\n    const ownsServer = !process.env.LOOP_CODEX_APP_SERVER_ENDPOINT;\n    if (!ownsServer && !upstreamToken) throw new Error('Managed shared Codex app-server token is missing');",
);
edit(
  "cli/src/codex/shared/runtime.ts",
  "            if (server && server.exitCode === null && server.signalCode === null) {",
  "            if (ownsServer && server && server.exitCode === null && server.signalCode === null) {",
);
edit(
  "cli/src/codex/shared/runtime.ts",
  "        server = spawn(command.command, [...command.args, 'app-server', ...launch.serverArgs, '--listen', upstream,\n            ...(upstreamToken ? ['--ws-auth', 'capability-token', '--ws-token-sha256', createHash('sha256').update(upstreamToken).digest('hex')] : [])],\n            { cwd: launch.cwd, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });\n        server.stderr?.on('data', data => logger.debug('[Codex shared] app-server', data.toString()));\n        server.once('error', error => { void shutdown(error); });\n        server.once('exit', (code, sig) => { void shutdown(new Error(`app-server exited (${code}, ${sig})`)); });\n        runtime.serverPid = server.pid;\n        runtime.serverMarker = server.pid ? getProcessStartMarker(server.pid) ?? undefined : undefined;\n        if (!runtime.serverPid || !runtime.serverMarker) throw new Error('Cannot verify app-server generation');\n        await persist();",
  "        if (ownsServer) {\n            server = spawn(command.command, [...command.args, 'app-server', ...launch.serverArgs, '--listen', upstream,\n                ...(upstreamToken ? ['--ws-auth', 'capability-token', '--ws-token-sha256', createHash('sha256').update(upstreamToken).digest('hex')] : [])],\n                { cwd: launch.cwd, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });\n            server.stderr?.on('data', data => logger.debug('[Codex shared] app-server', data.toString()));\n            server.once('error', error => { void shutdown(error); });\n            server.once('exit', (code, sig) => { void shutdown(new Error(`app-server exited (${code}, ${sig})`)); });\n            runtime.serverPid = server.pid;\n            runtime.serverMarker = server.pid ? getProcessStartMarker(server.pid) ?? undefined : undefined;\n            if (!runtime.serverPid || !runtime.serverMarker) throw new Error('Cannot verify app-server generation');\n            await persist();\n        } else if (!upstream.startsWith('ws://127.0.0.1:')) {\n            throw new Error('Managed shared Codex app-server must use the worker-local authenticated WebSocket');\n        }",
);
edit(
  "cli/src/codex/shared/runtime.ts",
  "        if (ownsServer) {",
  "        if (!ownsServer) {\n            const config = record(launch.threadParams.config);\n            for (let index = 0; index < launch.serverArgs.length; index += 2) {\n                const override = launch.serverArgs[index + 1] || '';\n                const equals = override.indexOf('=');\n                let value: unknown;\n                try { value = JSON.parse(override.slice(equals + 1)); } catch { throw new Error('Shared Codex server overrides must be applied as thread settings'); }\n                const key = override.slice(0, equals);\n                if (launch.serverArgs[index] !== '-c' || equals < 1 || !Object.hasOwn(config, key) || JSON.stringify(config[key]) !== JSON.stringify(value))\n                    throw new Error('This setting cannot be applied to the laptop shared Codex app-server');\n            }\n        }\n        if (ownsServer) {",
);
edit(
  "cli/src/codex/shared/runtime.ts",
  "const params = record(request.params);",
  'await managedGuard((m,p)=>control.request(m,p),request.method || "",request.params);\n        const params = record(request.params);',
);
edit(
  "cli/src/codex/shared/projection.ts",
  "    private readonly turns = new Map<string, string>();",
  "    private readonly turns = new Map<string, string>();\n    private readonly loopOutputs = new Map<string, Map<string,string>>();",
);
edit(
  "cli/src/codex/shared/projection.ts",
  "            if (event.type === 'agent_message') this.send({ type: 'message', message: event.message }, key);",
  "            if (event.type === 'agent_message') { if (turnId && itemId) { if(!this.loopOutputs.has(turnId))this.loopOutputs.set(turnId,new Map()); this.loopOutputs.get(turnId)!.set(itemId,String(event.message||'')); } this.send({ type: 'message', message: event.message, loop:{turnId} }, key); }",
);
edit(
  "cli/src/codex/shared/projection.ts",
  "                if (turnId) this.turns.set(id, turnId);",
  "                if (turnId) { this.turns.set(id, turnId); this.send({type:'loop-turn',localId:id,threadId:this.threadId,turnId,status:'running'}, 'loop-start:'+turnId+':'+id); }",
);
// Project lifecycle with native turn and accepted localId; never infer completion from liveness.
edit(
  "cli/src/codex/shared/projection.ts",
  "        const events = this.converter.handleNotification(method, params);",
  `        if (!this.parentThreadId && method === 'turn/completed' && turnId) {
            for (const [localId, mappedTurn] of this.turns) if (mappedTurn === turnId) {
                const turn = record(p.turn);
                this.send({type:'loop-turn',localId,threadId:this.threadId,turnId,status:turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'cancelled' : 'failed',output:Array.isArray(turn.items) && turn.items.length ? turn.items.filter((x:any)=>x.type==='agentMessage').at(-1)?.text||'' : Array.from(this.loopOutputs.get(turnId)?.values()||[]).at(-1)||''}, 'loop-complete:'+turnId+':'+localId);
            }
        }
        const events = this.converter.handleNotification(method, params);`,
);
imp("cli/src/claude/claudeRemote.ts");
edit(
  "cli/src/claude/claudeRemote.ts",
  "    const response = query({",
  "    managedClaude(sdkOptions);\n    const response = query({",
);
edit(
  "cli/src/claude/claudeRemoteLauncher.ts",
  "                        onMessage,",
  `                        onMessage: (message) => {
                            onMessage(message);
                            if (message.type === 'result' && inFlightMessage) {
                                for (const item of inFlightMessage.items) if (item.localId) session.client.sendAgentMessage({type:'loop-turn',localId:item.localId,threadId:session.sessionId,turnId:message.uuid,status:message.is_error ? 'failed' : 'completed',output:'result' in message ? message.result : ''},'loop-result:'+message.uuid+':'+item.localId);
                            }
                        },`,
);
edit(
  "hub/src/socket/server.ts",
  "            socket.data.userId = parsed.data.uid",
  "            if (socket.handshake.headers['x-loop-namespace']) return next(new Error('Worker terminal control is unavailable'));\n            socket.data.userId = parsed.data.uid",
);
// Managed Claude cannot replay a prompt after its native delivery became uncertain.
edit(
  "cli/src/claude/claudeRemoteLauncher.ts",
  "                    logger.debug('[remote]: launch error', e);",
  `                    logger.debug('[remote]: launch error', e);
                    if (process.env.LOOP_MANAGED === '1' && deliveredMessageThisAttempt && inFlightMessage) {
                        for (const item of inFlightMessage.items) if(item.localId) session.client.sendAgentMessage({type:'loop-delivery-unknown',localId:item.localId,threadId:session.sessionId}, 'loop-unknown:'+item.localId);
                        inFlightMessage=null;
                        await this.respawnBackoff(getRespawnBackoffMs(),controller.signal);
                        continue;
                    }`,
);
edit(
  "cli/src/claude/claudeRemoteLauncher.ts",
  "                    if (!this.exitReason && controller.signal.aborted) {",
  `                    if (!this.exitReason && controller.signal.aborted) {
                        for (const item of inFlightMessage?.items||[]) if(item.localId) session.client.sendAgentMessage({type:'loop-interrupted',localId:item.localId,threadId:session.sessionId}, 'loop-interrupted:'+item.localId);`,
);
// All proxy traffic carries a trusted namespace from verified environment mTLS.
edit(
  "hub/src/socket/server.ts",
  "        socket.data.namespace = parsedToken.namespace",
  "        if (socket.handshake.headers['x-loop-namespace'] && socket.handshake.headers['x-loop-namespace'] !== parsedToken.namespace) return next(new Error('Environment namespace mismatch'));\n        socket.data.namespace = parsedToken.namespace",
);
edit(
  "hub/src/web/routes/auth.ts",
  "        const token = await new SignJWT",
  "        if (c.req.header('x-loop-namespace') && c.req.header('x-loop-namespace') !== namespace) return c.json({error:'Environment namespace mismatch'},403);\n        const token = await new SignJWT",
);
edit(
  "hub/src/web/middleware/auth.ts",
  "            c.set('namespace', parsed.data.ns)",
  "            if (c.req.header('x-loop-namespace') && c.req.header('x-loop-namespace') !== parsed.data.ns) return c.json({error:'Environment namespace mismatch'},403);\n            c.set('namespace', parsed.data.ns)",
);
edit(
  "hub/src/web/routes/cli.ts",
  "        c.set('namespace', parsedToken.namespace)",
  "        if (c.req.header('x-loop-namespace') && c.req.header('x-loop-namespace') !== parsedToken.namespace) return c.json({error:'Environment namespace mismatch'},403);\n        c.set('namespace', parsedToken.namespace)",
);
edit(
  "hub/src/sync/syncEngine.ts",
  "                resumedStartingMode\n            )",
  "                resumedStartingMode,\n                undefined,\n                session.metadata?.loopLaunchId\n            )",
);
// Peer tools cannot bypass Loop memory scope. This also covers CLI peer commands.
edit(
  "cli/src/modules/pingPeer/pingPeer.ts",
  "    const apiUrl = resolveApiUrl(options.apiUrl)",
  "    if (process.env.LOOP_MANAGED === '1') throw new Error('Use the scoped Loop gateway for shared memory and delegation');\n    const apiUrl = resolveApiUrl(options.apiUrl)",
  true,
);
// Reconstruct completion from actual native history on a cold observer restart.
edit(
  "cli/src/codex/shared/projection.ts",
  "        // Repair sessions created while remote title projection was missing.",
  "        for (const value of turns) { const turn = record(value); if (turn.status && turn.status !== 'inProgress') await this.project('turn/completed',{threadId:this.threadId,turn}); }\n        // Repair sessions created while remote title projection was missing.",
);
// Loop uses cloudflared; exclude HAPI's optional relay binary on every target.
for (const [variable, suffix, executable] of [
  ["X64Linux", "x64-linux", "tunwg"],
  ["Arm64Linux", "arm64-linux", "tunwg"],
  ["X64Darwin", "x64-darwin", "tunwg"],
  ["Arm64Darwin", "arm64-darwin", "tunwg"],
  ["X64Win32", "x64-win32.exe", "tunwg.exe"],
]) {
  edit(
    "cli/src/runtime/embeddedAssets.bun.ts",
    `,\n            { default: tunwg${variable} }`,
    "",
  );
  edit(
    "cli/src/runtime/embeddedAssets.bun.ts",
    `,\n            import('../../../shared/tools/tunwg/tunwg-${suffix}', { assert: { type: 'file' } })`,
    "",
  );
  edit(
    "cli/src/runtime/embeddedAssets.bun.ts",
    `,\n            asset('tools/tunwg/${executable}', tunwg${variable})`,
    "",
  );
}
// Managed sessions belong to Loop's owned process group. Standalone HAPI
// keeps its existing detached-session semantics.
edit(
  "cli/src/runner/run.ts",
  "detached: true,  // Sessions stay alive when runner stops",
  "detached: process.env.LOOP_MANAGED !== '1',  // Loop owns managed process lifetime",
);
// HAPI needs its Hub credential; the provider and its shell commands do not.
edit(
  "cli/src/claude/sdk/query.ts",
  "const spawnEnv = withBunRuntimeEnv(process.env, { allowBunBeBun: false })",
  "const spawnEnv = withBunRuntimeEnv(process.env, { allowBunBeBun: false })\n    if (process.env.LOOP_MANAGED === '1') {\n      delete spawnEnv.CLI_API_TOKEN\n      for (const key of Object.keys(spawnEnv)) {\n        if (key.startsWith('LOOP_') && key !== 'LOOP_SESSION_TOKEN') delete spawnEnv[key]\n      }\n      delete spawnEnv.LOOP_CODEX_APP_SERVER_TOKEN\n      delete spawnEnv.LOOP_CODEX_APP_SERVER_ENDPOINT\n    }",
);
// Enforce ownership at the shared spawn boundary too, including cold resume
// and any future managed launch path that supplies detached: true.
edit(
  "cli/src/utils/spawnHappyCLI.ts",
  "const finalOptions: SpawnOptions = { ...options };",
  "const finalOptions: SpawnOptions = { ...options };\n  if (process.env.LOOP_MANAGED === '1') finalOptions.detached = false;",
);
for (const [path, source] of changes) writeFileSync(join(root, path), source);
console.log(
  "Applied Loop managed-launch, auth, lifecycle and namespace seams to pinned HAPI",
);
