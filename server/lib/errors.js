export class AppError extends Error {
  constructor(code, message, { status = 500, retryAfter, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const unavailable = (code = 'WARMING_UP') =>
  new AppError(code, code === 'WARMING_UP'
    ? 'Live tracking is warming up. Basic map information is available.'
    : 'Live tracking is unavailable. This does not mean no buses are running.',
  { status: 503, retryAfter: 5 });
