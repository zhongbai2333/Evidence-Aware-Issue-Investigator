import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../src/runner";
import { configSchema } from "../src/schema";
import type { AgentInvocationPlan } from "../src/contracts";
import { planAgentInvocation } from "../src/adapters";

const image = process.env.EAI_CONTAINER_IMAGE;
const enabled = process.platform === "linux" && !!image;

describe.skipIf(!enabled)("real Linux container boundary", () => {
  it("allows public networking while denying host access, credentials, privilege changes and source mutation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "eai-boundary-source-"));
    const hostSecret = path.join(os.tmpdir(), "eai-host-secret-" + Date.now());
    let upstreamKey = "", upstreamTokens = 0, hostHits = 0;
    let streamingReport: object | null = null;
    let unstructured = false;
    let realCliToolTypes: string[] = [];
    const upstream = http.createServer(async (req, res) => {
      upstreamKey = String(req.headers.authorization);
      let body = ""; for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body);
      upstreamTokens = payload.max_output_tokens;
      if (streamingReport) {
        if (payload.stream === false) {
          res.setHeader("content-type","application/json");
          res.end(JSON.stringify({output_text:JSON.stringify(streamingReport)})); return;
        }
        realCliToolTypes = (payload.tools ?? []).map((tool: {type:string}) => tool.type);
        const text = unstructured ? "The source inspection was completed. Runtime reproduction remains inconclusive. No host data was accessed." : JSON.stringify(streamingReport);
        const item = { id: "msg_eai", type: "message", status: "completed", role: "assistant", content: [{type:"output_text",text,annotations:[]}] };
        const response = { id: "resp_eai", object: "response", created_at: Math.floor(Date.now()/1000), status: "completed", model: "test-model", output:[item], usage:{input_tokens:1,output_tokens:1,total_tokens:2} };
        const events = [
          {type:"response.created",response:{...response,status:"in_progress",output:[]}},
          {type:"response.output_item.added",output_index:0,item:{...item,status:"in_progress",content:[]}},
          {type:"response.content_part.added",item_id:item.id,output_index:0,content_index:0,part:{type:"output_text",text:"",annotations:[]}},
          {type:"response.output_text.delta",item_id:item.id,output_index:0,content_index:0,delta:text},
          {type:"response.output_text.done",item_id:item.id,output_index:0,content_index:0,text},
          {type:"response.content_part.done",item_id:item.id,output_index:0,content_index:0,part:item.content[0]},
          {type:"response.output_item.done",output_index:0,item},
          {type:"response.completed",response},
        ];
        res.setHeader("content-type","text/event-stream");
        for (const [sequence_number,event] of events.entries()) res.write(`event: ${event.type}\ndata: ${JSON.stringify({...event,sequence_number})}\n\n`);
        res.end(); return;
      }
      res.end('{"ok":true}');
    });
    const hostOnly = http.createServer((req, res) => { hostHits++; res.end("HOST_SECRET"); });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => hostOnly.listen(0, "0.0.0.0", resolve));
    const upstreamAddress = upstream.address(), hostAddress = hostOnly.address();
    if (!upstreamAddress || typeof upstreamAddress === "string" || !hostAddress || typeof hostAddress === "string") throw new Error("no test server");
    process.env.TEST_CONTAINER_KEY = "controller-secret-not-for-agent";
    process.env.GITHUB_TOKEN = "github-controller-secret-not-for-agent";
    try {
      await writeFile(hostSecret, "HOST_SECRET");
      await writeFile(path.join(workspace, "baseline.txt"), "original");
      const report = {
        schema_version: 1, issue: { repository: "example/project", number: 1, title: "Isolation test", url: "https://github.com/example/project/issues/1" },
        agent: { engine: "codex", provider: "mock", model: "test-model" },
        investigation: { status: "completed", summary: "Real container isolation assertions passed", code_path_identified: true, test_attempted: true, environment_match: "partial" },
        reproduction: { status: "inconclusive", requested_probe: null, user_steps: [], proposed_steps: [], verified_steps: [] },
        evidence: { commands: [], code_locations: [], observations: ["Public HTTPS, model proxy, host/metadata denial, read-only root and zero capabilities checked"] },
        assessment: { type: "question", disposition: "none", duplicate_of: null, priority: "low", risk_flags: [], needs_info: false, suggested_title: null, questions: [], confidence: 0.7, limitations: [] },
      };
      await writeFile(path.join(workspace, "probe.mjs"), [
        "import fs from 'node:fs'; import assert from 'node:assert/strict'; import {spawnSync} from 'node:child_process';",
        "assert.equal(process.getuid(),1000); assert.equal(process.env.TEST_CONTAINER_KEY,undefined); assert.equal(process.env.GITHUB_TOKEN,undefined);",
        `assert.equal(fs.existsSync(${JSON.stringify(hostSecret)}),false); assert.equal(fs.existsSync('/var/run/docker.sock'),false);`,
        "assert.match(fs.readFileSync('/proc/self/status','utf8'),/CapEff:\\s+0+\\n/); assert.match(fs.readFileSync('/proc/self/status','utf8'),/NoNewPrivs:\\s+1/);",
        "assert.throws(()=>fs.writeFileSync('/etc/host-escape','x')); assert.notEqual(spawnSync('iptables',['-P','OUTPUT','ACCEPT']).status,0);",
        "assert.equal(fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),'256');",
        "const publicResponse=await fetch('https://example.com',{signal:AbortSignal.timeout(20000)}); assert.equal(publicResponse.status,200);",
        "const gateway=new URL(process.env.PROXY_URL).hostname;",
        `await assert.rejects(fetch('http://'+gateway+':${hostAddress.port}',{signal:AbortSignal.timeout(1500)}));`,
        "await assert.rejects(fetch('http://169.254.169.254/latest/meta-data/',{signal:AbortSignal.timeout(1500)}));",
        "const response=await fetch(process.env.PROXY_URL+'/responses',{method:'POST',headers:{authorization:'Bearer '+process.env.PROXY_TOKEN,'content-type':'application/json'},body:JSON.stringify({model:'test-model',max_output_tokens:999999})}); assert.equal(response.status,200);",
        "fs.writeFileSync('baseline.txt','container-only change');",
        `fs.writeFileSync(process.argv[2],${JSON.stringify(JSON.stringify(report))});`,
      ].join("\n"));
      const isolation = configSchema.parse({ investigation: { engine: "codex", network: true, isolation: { executor: "container", image } } }).investigation.isolation;
      const plan: AgentInvocationPlan = {
        engine: "codex", provider: "mock", model: "test-model", command: "/usr/local/bin/node",
        args: ["{workspace}/probe.mjs", "{outputPath}"], cwd: workspace,
        environment: { PROXY_URL: { value: "{proxyBaseUrl}", sensitive: false }, PROXY_TOKEN: { value: "{proxyToken}", sensitive: true } },
        generatedFiles: {}, outputFormat: "jsonl", timeoutMs: 45_000,
        versionCheck: { command: "codex", args: ["--version"], expectedVersion: "0.163.0" }, isolation,
        credentialProxy: { upstreamBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`, sourceEnv: "TEST_CONTAINER_KEY", protocol: "responses", maxRequests: 4, headersFromEnv: {} },
      };
      const result = await runAgent(plan);
      expect(result.report.investigation.status).toBe("completed");
      expect(upstreamKey).toBe("Bearer controller-secret-not-for-agent");
      expect(upstreamTokens).toBe(8192);
      expect(hostHits).toBe(0);
      expect(await readFile(path.join(workspace, "baseline.txt"), "utf8")).toBe("original");
      streamingReport = report;
      const config = configSchema.parse({
        cli: {install:"preinstalled",versions:{codex:"0.163.0"}},
        providers: {mock:{model:"test-model",baseUrl:`http://127.0.0.1:${upstreamAddress.port}`,auth:{mode:"environment",env:"TEST_CONTAINER_KEY"}}},
        investigation:{engine:"codex",provider:"mock",mode:"execute",network:true,isolation:{executor:"container",image}},
      });
      const realCliResult = await runAgent(planAgentInvocation({config,providerName:"mock",provider:config.providers.mock!,
        prompt:"Return a short investigation report in the requested JSON schema for this mock test. Do not call tools.",workspace}));
      expect(realCliResult.report.investigation.status).toBe("completed");
      expect(realCliToolTypes.length).toBeGreaterThan(0);
      unstructured=true;
      const repaired=await runAgent(planAgentInvocation({config,providerName:"mock",provider:config.providers.mock!,
        prompt:"Return the requested mock report without tools.",workspace}));
      expect(repaired.report.reproduction.status).toBe("inconclusive");
      expect(repaired.report.assessment.confidence).toBeLessThanOrEqual(0.7);
      expect(repaired.report.assessment.limitations.join(" ")).toContain("reformatted an unstructured executor answer");
      await expect(runAgent({ ...plan, command: "/usr/local/bin/node", args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 500 })).rejects.toThrow("time budget");
      expect(execFileSync("docker", ["ps", "-aq", "--filter", "name=eai-"], { encoding: "utf8" }).trim()).toBe("");
      expect(execFileSync("docker", ["network", "ls", "--format", "{{.Name}}", "--filter", "name=eai-"], { encoding: "utf8" }).trim()).toBe("");
    } finally {
      delete process.env.TEST_CONTAINER_KEY; delete process.env.GITHUB_TOKEN;
      await Promise.all([rm(workspace,{recursive:true,force:true}),rm(hostSecret,{force:true})]);
      await Promise.all([upstream,hostOnly].map((server)=>new Promise<void>((resolve)=>server.close(()=>resolve()))));
    }
  }, 120_000);
});
