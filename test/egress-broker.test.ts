import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startReviewedEgressBroker, validateReviewedEgressUrl } from "../src/egress-broker";
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

async function post(socketPath: string, payload: object): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request({
      socketPath,
      path: "/fetch",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.once("error", reject);
    request.end(body);
  });
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
    const socketPath = path.join(directory, "broker.sock");
    const reviewRequest = vi.fn(async () => ({ approved: true, reason: "Relevant public service status." }));
    const requestUrl = vi.fn(async () => ({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      contentType: "application/json",
      body: Buffer.from('{"ok":true}'),
      redirect: null,
    }));
    const broker = await startReviewedEgressBroker({
      socketPath,
      issue: issueFixture,
      provider: provider(),
      maxRequests: 2,
      maxResponseBytes: 1024,
    }, { reviewRequest, requestUrl });

    const result = await post(socketPath, { method: "GET", url: "https://api.example.com/status" });
    expect(result.status).toBe(200);
    expect(Buffer.from(result.body.body_base64, "base64").toString("utf8")).toBe('{"ok":true}');
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
    const socketPath = path.join(directory, "broker.sock");
    const requestUrl = vi.fn();
    const broker = await startReviewedEgressBroker({
      socketPath,
      issue: issueFixture,
      provider: provider(),
      maxRequests: 1,
      maxResponseBytes: 1024,
    }, {
      reviewRequest: async () => ({ approved: false, reason: "Unrelated target." }),
      requestUrl,
    });

    const result = await post(socketPath, { method: "GET", url: "https://example.com/track" });
    expect(result.status).toBe(403);
    expect(result.body.approved).toBe(false);
    expect(requestUrl).not.toHaveBeenCalled();
    expect(broker.audits).toMatchObject([{ approved: false, statusCode: null, bytes: 0 }]);
    await broker.close();
  });
});
