import { it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverOpencode,
  logoutOpencode,
} from "../src/native-auth/opencode-discovery";

it.each([false, true])(
  "discovers guarded models and rechecks sign-in after discovery (auth loss: %s)",
  async (loseAuth) => {
    const root = mkdtempSync(join(process.cwd(), ".discovery-"));
    try {
      mkdirSync(join(root, ".local/share/opencode"), { recursive: true });
      writeFileSync(
        join(root, ".local/share/opencode/auth.json"),
        JSON.stringify({
          openai: {
            type: "oauth",
            access: "fixture",
            refresh: "fixture",
            expires: 1,
          },
        }),
      );
      const executable = join(root, "opencode");
      writeFileSync(
        executable,
        `#!${process.execPath}
import http from 'node:http';
import fs from 'node:fs';
fs.writeFileSync('pid', String(process.pid));
if (process.env.OPENAI_API_KEY || process.env.NODE_OPTIONS || process.env.HOME !== process.cwd()) process.exit(2);
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
const server = http.createServer((req, res) => {
 if(req.headers.authorization !== 'Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64')) {res.writeHead(401);res.end();return;}
 const path = new URL(req.url, 'http://localhost').pathname;
 const value = path === '/global/health' ? {healthy:true, version:'1.18.32', loopExecutionGuard:{revision:'loop-subscription-v1',active:true}} : path === '/config' ? config : {providers:[{id:'openai',options:{baseURL:'loop-subscription-only://openai/v1',apiKey:'opencode-oauth-dummy-key',headerTimeout:300000},models:{'gpt-5.4':{id:'gpt-5.4',providerID:'openai',api:{id:'gpt-5.4',npm:'@ai-sdk/openai',url:''},headers:{}}}}],default:{openai:'gpt-5.4'}};
 if (${loseAuth} && path === '/config/providers') fs.writeFileSync('.local/share/opencode/auth.json', JSON.stringify({openai:{type:'api',key:'fixture-only'}}));
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));
});
server.listen(0,'127.0.0.1',()=>console.log('opencode server listening on http://127.0.0.1:'+server.address().port));
`,
        { mode: 0o700 },
      );
      const result = await discoverOpencode({
        executable,
        project: root,
        env: {
          HOME: root,
          PATH: process.env.PATH,
          OPENAI_API_KEY: "forbidden",
          NODE_OPTIONS: "forbidden",
        },
      });
      expect(result.authenticated).toBe(!loseAuth);
      if (loseAuth) expect(result.models).toEqual([]);
      else {
        expect(result.models[0].id).toBe("openai/gpt-5.4");
        expect(result).toHaveProperty("executionGuard", "loop-subscription-v1");
      }
      if (loseAuth) expect(result).not.toHaveProperty("executionGuard");
      expect(() =>
        process.kill(Number(readFileSync(join(root, "pid"), "utf8")), 0),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("does not spawn for absent native OAuth and sanitizes spawn failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "loop-discovery-"));
  try {
    const options = {
      executable: join(root, "missing"),
      project: root,
      env: { HOME: root },
    };
    expect((await discoverOpencode(options)).authenticated).toBe(false);
    mkdirSync(join(root, ".local/share/opencode"), { recursive: true });
    writeFileSync(
      join(root, ".local/share/opencode/auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "fixture",
          refresh: "fixture",
          expires: 1,
        },
      }),
    );
    await expect(discoverOpencode(options)).rejects.toThrow(
      "could not verify subscription configuration",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([true, false])(
  "native sign-out is scoped and reaps its child (accepted: %s)",
  async (accepted) => {
    const root = mkdtempSync(join(process.cwd(), ".logout-"));
    try {
      const executable = join(root, "opencode");
      writeFileSync(
        executable,
        `#!${process.execPath}
import http from 'node:http';
import fs from 'node:fs';
fs.writeFileSync('pid', String(process.pid));
const server = http.createServer((req,res) => {
 const authorized = req.headers.authorization === 'Basic '+Buffer.from('opencode:'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
 fs.writeFileSync('request', JSON.stringify({method:req.method,url:req.url,authorized}));
 res.writeHead(${accepted} ? 200 : 500, {'content-type':'application/json'});
 res.end(${accepted} ? 'true' : '"private native failure"');
});
server.listen(0,'127.0.0.1',()=>console.log('opencode server listening on http://127.0.0.1:'+server.address().port));
`,
        { mode: 0o700 },
      );
      const result = logoutOpencode({
        executable,
        project: root,
        env: { HOME: root, PATH: process.env.PATH },
      });
      if (accepted) await result;
      else
        await expect(result).rejects.toThrow(
          /^OpenCode sign-out could not be completed$/,
        );
      expect(JSON.parse(readFileSync(join(root, "request"), "utf8"))).toEqual({
        method: "DELETE",
        url: "/auth/openai",
        authorized: true,
      });
      expect(() =>
        process.kill(Number(readFileSync(join(root, "pid"), "utf8")), 0),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
