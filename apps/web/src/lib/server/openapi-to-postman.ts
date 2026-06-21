// A tiny, dependency-free OpenAPI 3.1 -> Postman Collection v2.1 converter,
// scoped to exactly the constructs the Fluncle spec uses (public/openapi.json):
// query/path parameters, JSON request bodies, local $ref schemas, and one
// server. It runs at request time over the live spec, so the collection is
// always byte-faithful to the spec it was generated from and needs no separate
// maintenance. It deliberately does not implement the whole OpenAPI surface;
// anything outside what the Fluncle spec exercises is skipped, not guessed.

type Json = unknown;
type JsonObject = Record<string, Json>;

type OpenApiSpec = {
  info?: { title?: string; description?: string; summary?: string; version?: string };
  servers?: { url?: string }[];
  paths?: Record<string, JsonObject>;
  components?: { schemas?: Record<string, JsonObject> };
};

const httpMethods = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

type PostmanUrl = {
  raw: string;
  host: string[];
  path: string[];
  query?: { key: string; value: string; description?: string; disabled?: boolean }[];
  variable?: { key: string; value: string; description?: string }[];
};

type PostmanRequest = {
  method: string;
  description?: string;
  header: { key: string; value: string }[];
  url: PostmanUrl;
  body?: { mode: "raw"; raw: string; options: { raw: { language: "json" } } };
};

type PostmanItem = {
  name: string;
  request: PostmanRequest;
};

type PostmanFolder = {
  name: string;
  item: PostmanItem[];
};

export type PostmanCollection = {
  info: {
    name: string;
    description?: string;
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";
    version?: string;
  };
  variable: { key: string; value: string }[];
  item: PostmanFolder[];
};

function isObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Resolve a local "#/components/schemas/Name" pointer against the spec. Only the
// shapes the Fluncle spec uses appear, so a missing target yields undefined and
// the caller falls back gracefully rather than throwing.
function resolveRef(spec: OpenApiSpec, ref: string): JsonObject | undefined {
  const prefix = "#/components/schemas/";
  if (!ref.startsWith(prefix)) {
    return undefined;
  }
  return spec.components?.schemas?.[ref.slice(prefix.length)];
}

// Build a representative JSON example from a schema, following local $refs and
// honouring const/enum/default/format so request bodies are runnable, not blank.
// Guards against recursive schemas via a seen-set on resolved ref names.
function exampleForSchema(spec: OpenApiSpec, schema: Json, seen: Set<string> = new Set()): Json {
  if (!isObject(schema)) {
    return null;
  }

  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace("#/components/schemas/", "");
    if (seen.has(name)) {
      return null;
    }
    const target = resolveRef(spec, schema.$ref);
    if (!target) {
      return null;
    }
    return exampleForSchema(spec, target, new Set([...seen, name]));
  }

  if ("const" in schema) {
    return schema.const;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  if ("default" in schema) {
    return schema.default;
  }

  // oneOf/anyOf: pick the first non-null branch so the example is useful.
  const union = (schema.oneOf ?? schema.anyOf) as Json;
  if (Array.isArray(union)) {
    const branch = union.find((b) => !(isObject(b) && b.type === "null")) ?? union[0];
    return exampleForSchema(spec, branch, seen);
  }

  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;

  switch (type) {
    case "object": {
      const out: JsonObject = {};
      const properties = isObject(schema.properties) ? schema.properties : {};
      for (const [key, propSchema] of Object.entries(properties)) {
        out[key] = exampleForSchema(spec, propSchema, seen);
      }
      return out;
    }
    case "array":
      return [exampleForSchema(spec, schema.items, seen)];
    case "boolean":
      return true;
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 0;
    case "string":
      return exampleString(schema);
    default:
      return null;
  }
}

function exampleString(schema: JsonObject): string {
  switch (schema.format) {
    case "date-time":
      return "1970-01-01T00:00:00.000Z";
    case "email":
      return "you@example.com";
    case "uri":
      return "https://open.spotify.com/track/0000000000000000000000";
    case "uuid":
      return "00000000-0000-0000-0000-000000000000";
    default:
      return "string";
  }
}

function splitServer(serverUrl: string): { host: string[]; basePath: string[] } {
  try {
    const url = new URL(serverUrl);
    const host = [`${url.protocol}//${url.host}`];
    const basePath = url.pathname.split("/").filter(Boolean);
    return { basePath, host };
  } catch {
    return { basePath: [], host: [serverUrl] };
  }
}

// Convert OpenAPI path templating ("{id}") into Postman path segments, mapping
// "{id}" to ":id" (Postman's path-variable form).
function pathSegments(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/^\{(.+)\}$/, ":$1"));
}

function operationName(operation: JsonObject, method: string, path: string): string {
  if (typeof operation.summary === "string" && operation.summary.length > 0) {
    return operation.summary;
  }
  if (typeof operation.operationId === "string" && operation.operationId.length > 0) {
    return operation.operationId;
  }
  return `${method.toUpperCase()} ${path}`;
}

// Group operations into folders by their first non-variable path segment, so
// "/me/*" lands under "me" and bare "/tracks" under "tracks". Keeps the
// collection navigable without inventing structure the spec doesn't carry.
function folderNameForPath(path: string): string {
  const first = path.split("/").filter(Boolean)[0] ?? "";
  return first.replace(/^\{(.+)\}$/, "$1") || "root";
}

export function openApiToPostman(input: Json): PostmanCollection {
  const spec = (isObject(input) ? input : {}) as OpenApiSpec;
  const serverUrl = spec.servers?.[0]?.url ?? "/";
  const { host, basePath } = splitServer(serverUrl);

  const folders = new Map<string, PostmanFolder>();
  const order: string[] = [];

  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!isObject(pathItem)) {
      continue;
    }

    for (const method of httpMethods) {
      const operation = pathItem[method];
      if (!isObject(operation)) {
        continue;
      }

      const segments = pathSegments(path);
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];

      const query: NonNullable<PostmanUrl["query"]> = [];
      const variable: NonNullable<PostmanUrl["variable"]> = [];
      for (const rawParam of parameters) {
        if (!isObject(rawParam)) {
          continue;
        }
        const key = typeof rawParam.name === "string" ? rawParam.name : "";
        if (!key) {
          continue;
        }
        const description =
          typeof rawParam.description === "string" ? rawParam.description : undefined;
        if (rawParam.in === "query") {
          query.push({
            description,
            disabled: rawParam.required !== true,
            key,
            value: "",
          });
        } else if (rawParam.in === "path") {
          variable.push({ description, key, value: "" });
        }
      }

      const rawUrl = `{{baseUrl}}/${segments.join("/")}`;
      const url: PostmanUrl = {
        host: ["{{baseUrl}}"],
        path: segments,
        raw: query.length > 0 ? `${rawUrl}?${query.map((q) => `${q.key}=`).join("&")}` : rawUrl,
      };
      if (query.length > 0) {
        url.query = query;
      }
      if (variable.length > 0) {
        url.variable = variable;
      }

      const header: PostmanRequest["header"] = [];
      const request: PostmanRequest = {
        header,
        method: method.toUpperCase(),
        url,
      };

      const description =
        typeof operation.description === "string" ? operation.description : undefined;
      if (description) {
        request.description = description;
      }

      const jsonSchema = jsonBodySchema(operation);
      if (jsonSchema !== undefined) {
        header.push({ key: "Content-Type", value: "application/json" });
        request.body = {
          mode: "raw",
          options: { raw: { language: "json" } },
          raw: JSON.stringify(exampleForSchema(spec, jsonSchema), null, 2),
        };
      }

      const item: PostmanItem = { name: operationName(operation, method, path), request };

      const folderName = folderNameForPath(path);
      let folder = folders.get(folderName);
      if (!folder) {
        folder = { item: [], name: folderName };
        folders.set(folderName, folder);
        order.push(folderName);
      }
      folder.item.push(item);
    }
  }

  const description = spec.info?.description ?? spec.info?.summary;

  return {
    info: {
      name: spec.info?.title ?? "API",
      ...(description ? { description } : {}),
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      ...(spec.info?.version ? { version: spec.info.version } : {}),
    },
    item: order.map((name) => folders.get(name)!),
    variable: [
      { key: "baseUrl", value: host[0] + (basePath.length > 0 ? `/${basePath.join("/")}` : "") },
    ],
  };
}

function jsonBodySchema(operation: JsonObject): Json {
  const requestBody = operation.requestBody;
  if (!isObject(requestBody)) {
    return undefined;
  }
  const content = requestBody.content;
  if (!isObject(content)) {
    return undefined;
  }
  const json = content["application/json"];
  if (!isObject(json)) {
    return undefined;
  }
  return json.schema;
}
