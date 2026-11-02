const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

export class ApiError extends Error {
  name = 'ApiError';
  status: number;
  code: string;
  requestId: string | null;
  details: unknown;
  // Server-requested wait (from Retry-After), when present.
  retryAfterMs: number | null;

  constructor(status: number, code: string, message: string, requestId: string | null, details?: unknown, retryAfterMs: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
  }

  get retryable(): boolean {
    return isRetryableStatus(this.status);
  }

  static fromResponse(status: number, body: unknown, requestId: string | null, retryAfterMs: number | null = null): ApiError {
    const err = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined)?.error;
    const code = typeof err?.code === 'string' ? err.code : `http_${status}`;
    const message = typeof err?.message === 'string' ? err.message : `Request failed with status ${status}`;
    return new ApiError(status, code, message, requestId, err?.details, retryAfterMs);
  }
}

export class NetworkError extends Error {
  name = 'NetworkError';
  requestId: string;

  constructor(message: string, requestId: string) {
    super(message);
    this.requestId = requestId;
  }

  get retryable(): boolean {
    return true;
  }
}

export class TimeoutError extends NetworkError {
  name = 'TimeoutError';
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof ApiError) return error.retryable;
  return error instanceof NetworkError;
}

// Errors that will fail the same way if retried, so queued work should stop retrying.
export function isPermanentError(error: unknown): boolean {
  return error instanceof ApiError && !error.retryable;
}
