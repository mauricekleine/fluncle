export class ApiError extends Error {
  code: string;
  status: number;
  until?: null | string;

  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}
