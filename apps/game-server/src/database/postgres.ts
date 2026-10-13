import Decimal from 'decimal.js';
import { EntityManager, QueryFailedError } from 'typeorm';

const UNIQUE_VIOLATION = '23505';

/** `numeric(40,18)` comes back as "100.000000000000000000"; the API uses "100". */
export function fromNumeric(value: string): string {
  return new Decimal(value).toFixed();
}

/** Runs `UPDATE … RETURNING`; the Postgres driver returns UPDATE results as `[rows, rowCount]`. */
export async function updateReturning<T>(
  manager: EntityManager,
  sql: string,
  parameters: unknown[],
): Promise<T[]> {
  const [rows] = await manager.query<[T[], number]>(sql, parameters);

  return rows;
}

/** Name of the unique constraint the error violated, or null for any other error. */
export function violatedUniqueConstraint(error: unknown): string | null {
  if (!(error instanceof QueryFailedError)) {
    return null;
  }

  const driverError = error.driverError as { code?: string; constraint?: string };

  return driverError.code === UNIQUE_VIOLATION ? (driverError.constraint ?? null) : null;
}
