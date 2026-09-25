type ApiHandlerContext = {
  params: Record<string, string>;
  request: Request;
};

type ApiHandler = (context: ApiHandlerContext) => Promise<Response> | Response;

export type ApiHandlers = Partial<
  Record<"DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT", ApiHandler>
>;

export function aliasHandlers<T>(handlers: T): never {
  return handlers as never;
}
