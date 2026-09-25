import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

const serverFnFaultRedaction = createMiddleware({ type: "function" }).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (isRedirect(error) || isNotFound(error)) {
      throw error;
    }

    let request: Request | undefined;

    try {
      request = getRequest();
    } catch {
      request = undefined;
    }

    const { redactServerFnFault } = await import("./lib/server/serverfn-fault");

    throw await redactServerFnFault(error, request);
  }
});

const csrfMiddleware = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" });

export const startInstance = createStart(() => ({
  functionMiddleware: [serverFnFaultRedaction],
  requestMiddleware: [csrfMiddleware],
}));
