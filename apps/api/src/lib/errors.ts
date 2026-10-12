export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (code: string, message: string, details?: unknown) => new HttpError(400, code, message, details);
export const conflict = (code: string, message: string, details?: unknown) => new HttpError(409, code, message, details);

/** Maps Postgres constraint errors to HTTP errors so they never surface as 500s. */
export function fromPgError(err: any): HttpError | null {
  switch (err?.code) {
    case '23505':
      return conflict('duplicate', 'A record with that value already exists', { constraint: err.constraint });
    case '23503':
      return badRequest('invalid_reference', 'Referenced record does not exist or is still in use', { constraint: err.constraint });
    case '23514':
      return badRequest('check_violation', 'A value is outside the allowed range', { constraint: err.constraint });
    case '22P02':
      return badRequest('invalid_input', 'Malformed value (for example, an invalid id)');
    case '22003':
      return badRequest('out_of_range', 'A number is too large');
    case '23502':
      return badRequest('missing_value', 'A required value is missing', { column: err.column });
    default:
      return null;
  }
}
