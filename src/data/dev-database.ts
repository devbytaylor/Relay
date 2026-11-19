import { isLocalDatabaseUrl } from "./local-database-url.js";

export const DEV_DATABASE_NAME = "relay_dev";

/** Reject URL overrides (including libpq query parameters) before connecting. */
export function requireDevDatabaseUrl(value: string | undefined): string {
  if (!isLocalDatabaseUrl(value, DEV_DATABASE_NAME)) {
    throw new Error(
      "Dev dashboard requires a loopback PostgreSQL URL for relay_dev.",
    );
  }
  return value;
}
