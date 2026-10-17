import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { IssueSnapshot } from "./contracts";
import { reviewExactNetworkRequest } from "./network-review";
import type { ProviderConfig } from "./schema";

const MAX_REQUEST_MESSAGE_BYTES = 32 * 1024;
const MAX_REDIRECTS = 5;

const brokerRequestSchema = z.object({
  method: z.enum(["GET", "HEAD"]).default("GET"),
  url: z.string().max(2048),
}).strict();

export interface ReviewedEgressAudit {
  id: string;
  method: "GET" | "HEAD";
  approved: boolean;
  reason: string;
  statusCode: number | null;
  bytes: number;
}

export interface ReviewedEgressBrokerConfig {
  queueDirectory: string;
  issue: IssueSnapshot;
  provider: ProviderConfig;
  maxRequests: number;
  maxResponseBytes: number;
}

export interface ReviewedEgressBrokerHandle {
  audits: ReviewedEgressAudit[];
  close(): Promise<void>;
}

export interface ReviewedEgressBrokerDependencies {
  reviewRequest?: typeof reviewExactNetworkRequest;
  requestUrl?: typeof requestPublicUrl;
}

function redactUrls(value: string): string {
  return value.replace(/https?:\/\/\S+/gi, "[redacted-url]").slice(0, 1000);
}

function isPublicIp(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b, c] = parts;
    if (a === undefined || b === undefined || c === undefined) return false;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPublicIp(normalized.slice(7));
    if (normalized === "::" || normalized === "::1") return false;
    if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff")) return false;
    if (normalized.startsWith("2001:db8")) return false;
    return normalized.startsWith("2") || normalized.startsWith("3");
  }
  return false;
}

export function validateReviewedEgressUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("Reviewed egress requires HTTPS");
  if (url.username || url.password) throw new Error("Reviewed egress URLs cannot contain credentials");
  if (url.port && url.port !== "443") throw new Error("Reviewed egress permits only HTTPS port 443");
  if (url.hash) throw new Error("Reviewed egress URLs cannot contain fragments");
  if (net.isIP(url.hostname)) throw new Error("Reviewed egress requires a public DNS hostname");
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal"
  ) {
    throw new Error("Reviewed egress blocks local and metadata hostnames");
  }
  return url;
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => !isPublicIp(entry.address))) {
    throw new Error("Reviewed egress DNS did not resolve exclusively to public addresses");
  }
  const selected = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
  return { address: selected.address, family: selected.family as 4 | 6 };
}

interface PublicResponse {
  statusCode: number;
  headers: Record<string, string>;
  contentType: string;
  body: Buffer;
  redirect: string | null;
}

async function requestPublicUrl(
  url: URL,
  method: "GET" | "HEAD",
  accept: string,
  maxResponseBytes: number,
): Promise<PublicResponse> {
  const resolved = await resolvePublicAddress(url.hostname);
  return await new Promise<PublicResponse>((resolve, reject) => {
    const request = https.request({
      hostname: resolved.address,
      family: resolved.family,
      port: 443,
      method,
      path: `${url.pathname}${url.search}`,
      servername: url.hostname,
      rejectUnauthorized: true,
      headers: {
        host: url.hostname,
        accept,
        "accept-encoding": "identity",
        "user-agent": "evidence-aware-issue-investigator/0.1",
      },
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const redirect = statusCode >= 300 && statusCode < 400
        ? (typeof response.headers.location === "string" ? response.headers.location : null)
        : null;
      const declared = Number(response.headers["content-length"] ?? "0");
      if (declared > maxResponseBytes) {
        response.destroy();
        reject(new Error("Reviewed egress response exceeds the byte limit"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > maxResponseBytes) {
          response.destroy(new Error("Reviewed egress response exceeds the byte limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => resolve({
        statusCode,
        headers: Object.fromEntries(
          ["content-type", "content-length", "etag", "last-modified", "cache-control"]
            .flatMap((name) => typeof response.headers[name] === "string" ? [[name, response.headers[name]!]] : []),
        ),
        contentType: String(response.headers["content-type"] ?? "application/octet-stream"),
        body: Buffer.concat(chunks),
        redirect,
      }));
    });
    request.setTimeout(30_000, () => request.destroy(new Error("Reviewed egress request timed out")));
    request.once("error", reject);
    request.end();
  });
}

export async function startReviewedEgressBroker(
  config: ReviewedEgressBrokerConfig,
  dependencies: ReviewedEgressBrokerDependencies = {},
): Promise<ReviewedEgressBrokerHandle> {
  const reviewRequest = dependencies.reviewRequest ?? reviewExactNetworkRequest;
  const requestUrl = dependencies.requestUrl ?? requestPublicUrl;
  let requestCount = 0;
  const audits: ReviewedEgressAudit[] = [];
  const requestsDirectory = path.join(config.queueDirectory, "requests");
  const processingDirectory = path.join(config.queueDirectory, "processing");
  const responsesDirectory = path.join(config.queueDirectory, "responses");
  await rm(config.queueDirectory, { recursive: true, force: true });
  await Promise.all([
    mkdir(requestsDirectory, { recursive: true, mode: 0o700 }),
    mkdir(processingDirectory, { recursive: true, mode: 0o700 }),
    mkdir(responsesDirectory, { recursive: true, mode: 0o700 }),
  ]);

  async function writeResponse(requestId: string, body: object): Promise<void> {
    const temporary = path.join(responsesDirectory, `.${requestId}.${process.pid}.tmp`);
    const destination = path.join(responsesDirectory, `${requestId}.json`);
    await writeFile(temporary, JSON.stringify(body), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, destination);
  }

  async function processRequest(requestId: string, requestPath: string): Promise<void> {
    const id = `network-${requestCount + 1}`;
    try {
      const metadata = await lstat(requestPath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Reviewed egress request is not a regular file");
      if (metadata.size > MAX_REQUEST_MESSAGE_BYTES) throw new Error("Reviewed egress request message is too large");
      requestCount += 1;
      if (requestCount > config.maxRequests) {
        await writeResponse(requestId, { approved: false, error: "reviewed-egress-request-limit" });
        return;
      }
      const proposed = brokerRequestSchema.parse(JSON.parse(await readFile(requestPath, "utf8")));
      let current = validateReviewedEgressUrl(proposed.url);
      const audit: ReviewedEgressAudit = {
        id,
        method: proposed.method,
        approved: false,
        reason: "Review not completed.",
        statusCode: null,
        bytes: 0,
      };
      audits.push(audit);
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        const review = await reviewRequest(config.issue, config.provider, {
          method: proposed.method,
          url: current.toString(),
        });
        audit.reason = review.reason;
        if (!review.approved) {
          process.stdout.write(`Controller Auto-review denied ${id}: ${redactUrls(review.reason)}\n`);
          await writeResponse(requestId, { id, approved: false, reason: review.reason });
          return;
        }
        audit.approved = true;
        const upstream = await requestUrl(
          current,
          proposed.method,
          "application/json, text/plain;q=0.9, */*;q=0.1",
          config.maxResponseBytes,
        );
        if (upstream.redirect) {
          current = validateReviewedEgressUrl(new URL(upstream.redirect, current).toString());
          continue;
        }
        audit.statusCode = upstream.statusCode;
        audit.bytes = upstream.body.byteLength;
        process.stdout.write(`Controller Auto-review approved ${id}; upstream status=${upstream.statusCode}; response_bytes=${upstream.body.byteLength}\n`);
        await writeResponse(requestId, {
          id,
          approved: true,
          reason: review.reason,
          status: upstream.statusCode,
          headers: upstream.headers,
          content_type: upstream.contentType,
          body_base64: upstream.body.toString("base64"),
        });
        return;
      }
      throw new Error("Reviewed egress exceeded the redirect limit");
    } catch (error) {
      const message = redactUrls(error instanceof Error ? error.message : String(error));
      process.stdout.write(`Controller reviewed egress ${id} failed closed: ${message}\n`);
      await writeResponse(requestId, { id, approved: false, error: message });
    } finally {
      await rm(requestPath, { force: true });
    }
  }

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let currentScan = Promise.resolve();
  const scan = async (): Promise<void> => {
    const names = (await readdir(requestsDirectory)).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).sort();
    for (const name of names) {
      const requestId = name.slice(0, -5);
      const source = path.join(requestsDirectory, name);
      const claimed = path.join(processingDirectory, name);
      try {
        await rename(source, claimed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      await processRequest(requestId, claimed);
    }
  };
  const schedule = (): void => {
    timer = setTimeout(() => {
      currentScan = scan()
        .catch((error) => {
          process.stdout.write(`Controller reviewed egress queue scan failed closed: ${redactUrls(error instanceof Error ? error.message : String(error))}\n`);
        })
        .finally(() => { if (!stopped) schedule(); });
    }, 50);
  };
  schedule();
  return {
    audits,
    async close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await currentScan;
      await rm(config.queueDirectory, { recursive: true, force: true });
    },
  };
}

export const REVIEWED_EGRESS_CLIENT = String.raw`#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const take = (name) => {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return null;
  return args[index + 1];
};
const url = take("--url");
const method = (take("--method") || "GET").toUpperCase();
const output = take("--output");
if (!url || !["GET", "HEAD"].includes(method)) {
  process.stderr.write("Usage: node .issue-investigator/bin/eai-fetch.mjs --url <https-url> [--method GET|HEAD] [--output relative-path]\n");
  process.exit(2);
}
const queueDirectory = path.resolve(".issue-investigator/reviewed-egress");
const requestsDirectory = path.join(queueDirectory, "requests");
const responsesDirectory = path.join(queueDirectory, "responses");
const requestId = randomUUID();
const requestPath = path.join(requestsDirectory, requestId + ".json");
const temporaryPath = path.join(requestsDirectory, "." + requestId + ".tmp");
const responsePath = path.join(responsesDirectory, requestId + ".json");
const payload = JSON.stringify({ method, url });
await mkdir(requestsDirectory, { recursive: true });
await writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
await rename(temporaryPath, requestPath);
let result = null;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  try {
    result = JSON.parse(await readFile(responsePath, "utf8"));
    await rm(responsePath, { force: true });
    break;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
if (!result) throw new Error("Reviewed egress controller response timed out");
if (!result.approved) {
  process.stderr.write(JSON.stringify(result) + "\n");
  process.exit(3);
}
const body = Buffer.from(result.body_base64 || "", "base64");
delete result.body_base64;
if (output) {
  const absolute = path.resolve(output);
  const relative = path.relative(process.cwd(), absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Output path escapes the disposable workspace");
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, body);
  result.saved_to = relative;
} else if (/^(text\/|application\/(json|xml|javascript)|[^;]+\+json)/i.test(result.content_type || "")) {
  result.body_text = body.toString("utf8");
} else if (body.length) {
  result.note = "Binary response omitted; repeat with --output <relative-path>.";
}
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
`;
