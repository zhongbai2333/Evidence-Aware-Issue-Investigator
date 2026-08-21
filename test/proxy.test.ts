import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startCredentialProxy, type CredentialProxyHandle } from "../src/proxy";

const servers: http.Server[] = [];
const proxies: CredentialProxyHandle[] = [];

afterEach(async () => {
  delete process.env.TEST_PROVIDER_KEY;
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("credential proxy", () => {
  it("keeps the real provider key in the controller and injects it only upstream", async () => {
    let receivedAuthorization = "";
    let receivedPath = "";
    const upstream = http.createServer(async (request, response) => {
      receivedAuthorization = String(request.headers.authorization ?? "");
      receivedPath = request.url ?? "";
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
    });
    servers.push(upstream);
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream did not bind");

    process.env.TEST_PROVIDER_KEY = "real-provider-secret";
    const proxy = await startCredentialProxy({
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      sourceEnv: "TEST_PROVIDER_KEY",
      protocol: "responses",
      maxRequests: 4,
      headersFromEnv: {},
    });
    proxies.push(proxy);

    const response = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
      body: '{"model":"test"}',
    });
    expect(response.status).toBe(200);
    expect(receivedAuthorization).toBe("Bearer real-provider-secret");
    expect(receivedAuthorization).not.toContain(proxy.token);
    expect(receivedPath).toBe("/v1/responses");

    expect((await fetch(`${proxy.baseUrl}/v1/responses`)).status).toBe(401);
    expect((await fetch(`${proxy.baseUrl}/admin`, {
      headers: { authorization: `Bearer ${proxy.token}` },
    })).status).toBe(404);
  });
});
