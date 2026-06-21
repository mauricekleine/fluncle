import { describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "./orpc";
import { openApiToPostman } from "./openapi-to-postman";

// A self-contained OpenAPI 3.1 fixture exercising the converter's full surface —
// a $ref request body with typed fields, a REQUIRED query param next to an
// OPTIONAL one, a path param, and two server-grouped folders. The live generated
// spec (below) is looser (all-optional query params, inline `unknown` bodies), so
// it would leave these converter paths untested; this fixture keeps them covered.
const FIXTURE = {
  components: {
    schemas: {
      SubmissionInput: {
        properties: {
          artists: { items: { type: "string" }, type: "array" },
          source: { enum: ["web"], type: "string" },
          spotifyTrackId: { type: "string" },
        },
        required: ["spotifyTrackId", "source"],
        type: "object",
      },
    },
  },
  info: { title: "Fixture API", version: "9.9.9" },
  openapi: "3.1.0",
  paths: {
    "/search": {
      get: {
        operationId: "searchTracks",
        parameters: [{ in: "query", name: "q", required: true, schema: { type: "string" } }],
        responses: { 200: { description: "ok" } },
        summary: "Search tracks",
      },
    },
    "/submissions": {
      post: {
        operationId: "submitTrack",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SubmissionInput" },
            },
          },
          required: true,
        },
        responses: { 200: { description: "ok" } },
        summary: "Submit a track",
      },
    },
    "/tracks": {
      get: {
        operationId: "listTracks",
        parameters: [{ in: "query", name: "limit", required: false, schema: { type: "integer" } }],
        responses: { 200: { description: "ok" } },
        summary: "List tracks",
      },
    },
  },
  servers: [{ url: "https://example.com/api/v1" }],
};

describe("openApiToPostman — converter surface (inline fixture)", () => {
  const collection = openApiToPostman(FIXTURE);

  it("emits a Postman v2.1 collection shaped from the spec info", () => {
    expect(collection.info.schema).toBe(
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    );
    expect(collection.info.name).toBe("Fixture API");
    expect(collection.info.version).toBe("9.9.9");
  });

  it("sets baseUrl to the first server", () => {
    expect(collection.variable).toContainEqual({
      key: "baseUrl",
      value: "https://example.com/api/v1",
    });
  });

  it("groups operations into folders by first path segment", () => {
    const folderNames = collection.item.map((folder) => folder.name);
    expect(folderNames).toContain("tracks");
    expect(folderNames).toContain("search");
    expect(folderNames).toContain("submissions");
  });

  it("templates each request URL off the baseUrl variable", () => {
    for (const folder of collection.item) {
      for (const item of folder.item) {
        expect(item.request.url.host).toEqual(["{{baseUrl}}"]);
        expect(item.request.url.raw.startsWith("{{baseUrl}}/")).toBe(true);
      }
    }
  });

  it("carries the required query param enabled and optional ones disabled", () => {
    const tracks = collection.item.find((folder) => folder.name === "tracks");
    const limit = tracks?.item[0]?.request.url.query?.find((q) => q.key === "limit");
    expect(limit?.disabled).toBe(true);

    const search = collection.item.find((folder) => folder.name === "search");
    const q = search?.item[0]?.request.url.query?.find((param) => param.key === "q");
    expect(q?.disabled).toBe(false);
  });

  it("builds a runnable JSON body example from a $ref request schema", () => {
    const submissions = collection.item.find((folder) => folder.name === "submissions");
    const submit = submissions?.item[0];
    expect(submit?.request.method).toBe("POST");
    expect(submit?.request.header).toContainEqual({
      key: "Content-Type",
      value: "application/json",
    });
    const body = JSON.parse(submit?.request.body?.raw ?? "{}");
    expect(typeof body.spotifyTrackId).toBe("string");
    expect(body.source).toBe("web");
    expect(Array.isArray(body.artists)).toBe(true);
  });

  it("produces only JSON-serialisable output", () => {
    expect(() => JSON.parse(JSON.stringify(collection))).not.toThrow();
  });
});

// The route at /api/v1/postman.json builds the collection from the GENERATED public
// spec at request time. This is the real end-to-end check the spec flip needs: the
// converter must run cleanly over the actual generated document and cover every
// public op (Postman shows the whole public surface, nothing dropped).
describe("openApiToPostman — over the generated public spec", () => {
  it("converts the live generated spec into a v2.1 collection covering every op", async () => {
    const document = (await generateOpenApiDocument()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const collection = openApiToPostman(document);

    expect(collection.info.name).toBe("Fluncle API");
    expect(collection.variable).toContainEqual({
      key: "baseUrl",
      value: "https://www.fluncle.com/api/v1",
    });

    const specOperationCount = Object.values(document.paths).reduce(
      (total, pathItem) =>
        total +
        Object.keys(pathItem).filter((key) =>
          ["get", "post", "put", "patch", "delete"].includes(key),
        ).length,
      0,
    );
    const itemCount = collection.item.reduce((total, folder) => total + folder.item.length, 0);
    expect(itemCount).toBe(specOperationCount);

    // No admin folder/items leak through (admin is filtered out of the public spec).
    expect(collection.item.map((folder) => folder.name)).not.toContain("admin");

    expect(() => JSON.parse(JSON.stringify(collection))).not.toThrow();
  });
});
