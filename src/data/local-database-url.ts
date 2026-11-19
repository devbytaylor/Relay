import { Client } from "pg";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Check both URL text and pg's resolved target before any connection is made. */
export function isLocalDatabaseUrl(
  value: string | undefined,
  databaseName: string,
): value is string {
  try {
    const url = new URL(value ?? "");
    const client = new Client({ connectionString: value });
    return (
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      decodeURIComponent(url.pathname) === `/${databaseName}` &&
      LOOPBACK_HOSTS.has(client.host) &&
      client.database === databaseName
    );
  } catch {
    return false;
  }
}
