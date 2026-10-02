export class AppError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}
export function requireValue(condition, message, status = 400) { if (!condition) throw new AppError(message, status); }
