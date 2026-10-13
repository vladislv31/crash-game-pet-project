import type { ErrorCode } from '@crash/contracts';

export class BettingError extends Error {
  override readonly name = 'BettingError';

  constructor(
    readonly code: ErrorCode,
    readonly errors?: Record<string, string>,
  ) {
    super(code);
  }
}
