export class ServiceError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 413 | 415 | 422 | 500 | 502 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 4000) : "Unknown error";
}
