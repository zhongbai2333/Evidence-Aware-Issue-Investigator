import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "../src/schema";
import { extractPublicAttachmentCandidates, reviewAndDownloadAttachments } from "../src/network-review";
import { issueFixture } from "./fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TEST_REVIEW_KEY;
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

describe("controller network review", () => {
  it("extracts only exact public GitHub user attachments", () => {
    const candidates = extractPublicAttachmentCandidates([
      "[log](https://github.com/user-attachments/files/123/log.zip)",
      "https://example.test/private.zip",
      "https://github.com/user-attachments/assets/not-allowed",
    ].join("\n"));
    expect(candidates).toEqual([{
      id: "attachment-1",
      url: "https://github.com/user-attachments/files/123/log.zip",
      filename: "log.zip",
    }]);
  });

  it("uses the configured Provider reviewer and supplies only its approved attachment", async () => {
    process.env.TEST_REVIEW_KEY = "secret";
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://provider.example/v1/responses") {
        expect(init?.headers).toMatchObject({ authorization: "Bearer secret" });
        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            schema_version: 1,
            decisions: [{ id: "attachment-1", approved: true, reason: "Relevant diagnostic log." }],
            summary: "Approved one read-only diagnostic download.",
          }),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://github.com/user-attachments/files/123/log.zip") {
        return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/download-token" } });
      }
      if (url === "https://objects.githubusercontent.com/download-token") {
        return new Response(Buffer.from("zip-bytes"), { status: 200, headers: { "content-length": "9" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const review = await reviewAndDownloadAttachments({
      ...issueFixture,
      body: "[log](https://github.com/user-attachments/files/123/log.zip)",
    }, provider());

    expect(review.status).toBe("completed");
    expect(review.attachments).toHaveLength(1);
    expect(review.attachments[0]).toMatchObject({
      path: ".issue-investigator/attachments/attachment-1-log.zip",
      bytes: 9,
    });
    expect(review.attachments[0]!.content.toString("utf8")).toBe("zip-bytes");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the Reviewer Provider is unavailable", async () => {
    process.env.TEST_REVIEW_KEY = "secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const review = await reviewAndDownloadAttachments({
      ...issueFixture,
      body: "https://github.com/user-attachments/files/123/log.zip",
    }, provider());
    expect(review.status).toBe("failed");
    expect(review.attachments).toEqual([]);
    expect(review.summary).toContain("HTTP 503");
  });
});
