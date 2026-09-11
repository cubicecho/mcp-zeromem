/** An error carrying an HTTP status code; rendered by the API error middleware as { error, detail? }. */
export class HttpError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(status: number, message: string, detail?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HttpError';
    this.status = status;
    this.detail = detail;
  }
}

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Like errorMessage, but appends an HttpError's detail — the manager puts the
 * actual diagnostics (e.g. a child's stderr tail) there, while the message is
 * a generic one-liner like `Failed to connect to server "x"`.
 */
export function errorDetailMessage(err: unknown): string {
  if (err instanceof HttpError && err.detail) {
    return `${err.message}: ${err.detail}`;
  }
  return errorMessage(err);
}

/**
 * Like {@link errorMessage}, but unwraps a `cause` chain, so an engine failure
 * wrapped by the façade still names the SQLite error underneath it.
 */
export function errorChainMessage(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  while (current !== undefined && current !== null && parts.length < 5) {
    const message = errorMessage(current);
    // A wrapper often quotes its own cause already; appending it again stutters.
    if (!parts.some((part) => part.includes(message))) {
      parts.push(message);
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(': ');
}
