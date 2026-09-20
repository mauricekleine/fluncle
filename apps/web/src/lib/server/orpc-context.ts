/** The request passed by the Worker to every public and authenticated oRPC operation. */
export type OrpcContext = {
  request: Request;
};
