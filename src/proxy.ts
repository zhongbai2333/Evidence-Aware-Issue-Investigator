import { randomBytes } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import type { AgentInvocationPlan, ProviderProtocol } from "./contracts";

const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;
const ALLOWED_PATHS = [
  "/models",
  "/v1/models",
  "/responses",
  "/v1/responses",
  "/chat/completions",
  "/v1/chat/completions",
  "/messages",
  "/v1/messages",
];

export interface CredentialProxyHandle {
  baseUrl: string;
  token: string;
  close(): Promise<void>;
}

function upstreamUrl(baseUrl: string, requestUrl: string): URL {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const incoming = new URL(requestUrl, "http://proxy.invalid");
  let pathname = incoming.pathname;
  if (base.pathname.replace(/\/$/, "").endsWith("/v1") && pathname.startsWith("/v1/")) {
    pathname = pathname.slice(4);
  } else {
    pathname = pathname.replace(/^\//, "");
  }
  const target = new URL(pathname, base);
  target.search = incoming.search;
  return target;
}

function validProxyToken(request: http.IncomingMessage, token: string): boolean {
  const authorization = String(request.headers.authorization ?? "");
  const apiKey = String(request.headers["x-api-key"] ?? "");
  return authorization === `Bearer ${token}` || apiKey === token;
}

function injectedHeaders(
  request: http.IncomingMessage,
  protocol: ProviderProtocol,
  secret: string,
  additionalHeaders: Record<string, string>,
): Headers {
  const headers = new Headers();
  for (const [name, rawValue] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (["host", "authorization", "x-api-key", "content-length", "connection"].includes(lower)) continue;
    if (typeof rawValue === "string") headers.set(name, rawValue);
    else if (Array.isArray(rawValue)) headers.set(name, rawValue.join(", "));
  }
  if (protocol === "anthropic-messages") headers.set("x-api-key", secret);
  else headers.set("authorization", `Bearer ${secret}`);
  for (const [name, value] of Object.entries(additionalHeaders)) headers.set(name, value);
  return headers;
}

async function readBody(request: http.IncomingMessage): Promise<string | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("Proxy request body exceeds limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startCredentialProxy(
  spec: NonNullable<AgentInvocationPlan["credentialProxy"]>,
): Promise<CredentialProxyHandle> {
  const secret = process.env[spec.sourceEnv];
  if (!secret) throw new Error(`Required credential environment variable is missing: ${spec.sourceEnv}`);
  if (["GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"].includes(spec.sourceEnv)) {
    throw new Error(`Protected controller credential cannot be used as a model provider key: ${spec.sourceEnv}`);
  }
  const token = randomBytes(32).toString("base64url");
  let requests = 0;
  const additionalHeaders: Record<string, string> = {};
  for (const [header, envName] of Object.entries(spec.headersFromEnv)) {
    if (["GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"].includes(envName)) {
      throw new Error(`Protected controller credential cannot be used as a provider header: ${envName}`);
    }
    const value = process.env[envName];
    if (!value) throw new Error(`Required provider header environment variable is missing: ${envName}`);
    additionalHeaders[header] = value;
  }

  const server = http.createServer(async (request, response) => {
    try {
      requests += 1;
      if (requests > spec.maxRequests) {
        response.writeHead(429).end("Credential proxy request limit exceeded");
        return;
      }
      if (!validProxyToken(request, token)) {
        response.writeHead(401).end("Unauthorized");
        return;
      }
      const requestUrl = request.url ?? "/";
      const pathname = new URL(requestUrl, "http://proxy.invalid").pathname;
      if (!ALLOWED_PATHS.includes(pathname)) {
        response.writeHead(404).end("Endpoint is not allowed by credential proxy");
        return;
      }
      if (!["GET", "POST", "HEAD"].includes(request.method ?? "")) {
        response.writeHead(405).end("Method not allowed");
        return;
      }
      const upstream = await fetch(upstreamUrl(spec.upstreamBaseUrl, requestUrl), {
        method: request.method,
        headers: injectedHeaders(request, spec.protocol, secret, additionalHeaders),
        body: await readBody(request),
        redirect: "error",
      });
      response.statusCode = upstream.status;
      for (const name of ["content-type", "cache-control", "x-request-id", "request-id"]) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
      }
      if (upstream.body) {
        let total = 0;
        for await (const rawChunk of Readable.fromWeb(upstream.body as never)) {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) throw new Error("Provider response exceeds credential proxy limit");
          if (!response.write(chunk)) await once(response, "drain");
        }
      }
      response.end();
    } catch (error) {
      if (response.headersSent) response.destroy(error instanceof Error ? error : undefined);
      else response.writeHead(502).end(error instanceof Error ? error.message : "Credential proxy failure");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Credential proxy failed to bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    close: async () => await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
