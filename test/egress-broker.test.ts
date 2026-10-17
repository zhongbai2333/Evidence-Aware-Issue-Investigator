import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEWED_EGRESS_CLIENT, startReviewedEgressBroker, validateReviewedEgressUrl } from "../src/egress-broker";
import { configSchema } from "../src/schema";
import { issueFixture } from "./fixtures";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function provider() {
  return configSchema.parse({
    providers: {
      test: {
        kind: "compatible",
        baseUrl: "https://provider.example/v1",
        protocol: "responses",
        model: "reviewer",
        auth: { mode: "environment", env: "TEST_REVIEW_KEY" },
      },
    },
  }).providers.test!;
}

async function exchange(queueDirectory: string, requestId: string, payload: object): Promise<any> {
  const temporary = path.join(queueDirectory, "requests", `.${requestId}.tmp`);
  const requestPath = path.join(queueDirectory, "requests", `${requestId}.json`);
  const responsePath = path.join(queueDirectory, "responses", `${requestId}.json`);
  await writeFile(temporary, JSON.stringify(payload), "utf8");
  await rename(temporary, requestPath);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(responsePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Timed out waiting for broker response");
}

describe("reviewed egress broker", () => {
  it("blocks non-HTTPS, credentialed, local, IP-literal, and nonstandard-port targets", () => {
    expect(() => validateReviewedEgressUrl("http://example.com/data")).toThrow("HTTPS");
    expect(() => validateReviewedEgressUrl("https://user:pass@example.com/data")).toThrow("credentials");
    expect(() => validateReviewedEgressUrl("https://localhost/data")).toThrow("local");
    expect(() => validateReviewedEgressUrl("https://127.0.0.1/data")).toThrow("DNS hostname");
    expect(() => validateReviewedEgressUrl("https://example.com:8443/data")).toThrow("port 443");
    expect(validateReviewedEgressUrl("https://api.example.com/status").hostname).toBe("api.example.com");
  });

  it("reviews an exact request and returns a bounded controller-fetched response", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "reviewed-egress-"));
    tempDirectories.push(directory);
    const queueDirectory = path.join(directory, "queue");
    const reviewRequest = vi.fn(async () => ({ approved: true, reason: "Relevant public service status." }));
    const requestUrl = vi.fn(async () => ({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      contentType: "application/json",
      body: Buffer.from('{"ok":true}'),
      redirect: null,
    }));
    const broker = await startReviewedEgressBroker({
      queueDirectory,
      issue: issueFixture,
      provider: provider(),
      maxRequests: 2,
      maxResponseBytes: 1024,
    }, { reviewRequest, requestUrl });

    const result = await exchange(queueDirectory, "00000000-0000-4000-8000-000000000001", { method: "GET", url: "https://api.example.com/status" });
    expect(Buffer.from(result.body_base64, "base64").toString("utf8")).toBe('{"ok":true}');
    expect(reviewRequest).toHaveBeenCalledWith(issueFixture, expect.anything(), {
      method: "GET",
      url: "https://api.example.com/status",
    });
    expect(broker.audits).toMatchObject([{ approved: true, statusCode: 200, bytes: 11 }]);
    await broker.close();
  });

  it("fails closed without contacting the target when the Reviewer denies", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "reviewed-egress-"));
    tempDirectories.push(directory);
    const queueDirectory = path.join(directory, "queue");
    const requestUrl = vi.fn();
    const broker = await startReviewedEgressBroker({
      queueDirectory,
      issue: issueFixture,
      provider: provider(),
      maxRequests: 1,
      maxResponseBytes: 1024,
    }, {
      reviewRequest: async () => ({ approved: false, reason: "Unrelated target." }),
      requestUrl,
    });

    const result = await exchange(queueDirectory, "00000000-0000-4000-8000-000000000002", { method: "GET", url: "https://example.com/track" });
    expect(result.approved).toBe(false);
    expect(requestUrl).not.toHaveBeenCalled();
    expect(broker.audits).toMatchObject([{ approved: false, statusCode: null, bytes: 0 }]);
    await broker.close();
  });

  it("serves the injected client over the filesystem queue", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "reviewed-egress-client-"));
    tempDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const queueDirectory = path.join(workspace, ".issue-investigator/reviewed-egress");
    const clientPath = path.join(workspace, ".issue-investigator/bin/eai-fetch.mjs");
    await mkdir(path.dirname(clientPath), { recursive: true });
    await writeFile(clientPath, REVIEWED_EGRESS_CLIENT, { encoding: "utf8", mode: 0o700 });
    const broker = await startReviewedEgressBroker({
      queueDirectory,
      issue: issueFixture,
      provider: provider(),
      maxRequests: 1,
      maxResponseBytes: 1024,
    }, {
      reviewRequest: async () => ({ approved: true, reason: "Required public package metadata." }),
      requestUrl: async () => ({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        contentType: "application/json",
        body: Buffer.from('{"package":"ok"}'),
        redirect: null,
      }),
    });

    const child = spawn(process.execPath, [clientPath, "--url", "https://api.example.com/package"], {
      cwd: workspace,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });

    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ approved: true, status: 200, body_text: '{"package":"ok"}' });
    expect(broker.audits).toHaveLength(1);
    await broker.close();
  });
});
