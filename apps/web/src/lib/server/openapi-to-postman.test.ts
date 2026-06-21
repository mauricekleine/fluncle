import { describe, expect, it } from "vitest";
import openapi from "../../../public/openapi.json";
import { openApiToPostman } from "./openapi-to-postman";

describe("openApiToPostman", () => {
  const collection = openApiToPostman(openapi);

  it("emits a Postman v2.1 collection shaped from the spec info", () => {
    expect(collection.info.schema).toBe(
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    );
    expect(collection.info.name).toBe("Fluncle API");
    expect(collection.info.version).toBe("1.0.0");
  });

  it("sets baseUrl to the first server", () => {
    expect(collection.variable).toContainEqual({
      key: "baseUrl",
      value: "https://www.fluncle.com/api/v1",
    });
  });

  it("covers every operation in the spec across its folders", () => {
    const specOperationCount = Object.values(openapi.paths).reduce(
      (total, pathItem) =>
        total +
        Object.keys(pathItem).filter((key) =>
          ["get", "post", "put", "patch", "delete"].includes(key),
        ).length,
      0,
    );
    const itemCount = collection.item.reduce((total, folder) => total + folder.item.length, 0);
    expect(itemCount).toBe(specOperationCount);
  });

  it("groups operations into folders by first path segment", () => {
    const folderNames = collection.item.map((folder) => folder.name);
    expect(folderNames).toContain("tracks");
    expect(folderNames).toContain("me");
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
    const listTracks = tracks?.item.find((item) => item.name.startsWith("List certified"));
    const limit = listTracks?.request.url.query?.find((q) => q.key === "limit");
    expect(limit?.disabled).toBe(true);

    const search = collection.item.find((folder) => folder.name === "search");
    const searchTracks = search?.item[0];
    const q = searchTracks?.request.url.query?.find((param) => param.key === "q");
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
    expect(body.source).toBe("web");
    expect(typeof body.spotifyTrackId).toBe("string");
    expect(Array.isArray(body.artists)).toBe(true);
  });

  it("produces only JSON-serialisable output", () => {
    expect(() => JSON.parse(JSON.stringify(collection))).not.toThrow();
  });
});
