import { isLocalDatabaseUrl } from "./local-database-url.js";

// The isolated Ask Relay demo database: loopback only, named relay_demo.
export const DEMO_DATABASE_NAME = "relay_demo";

export class DemoDatabaseError extends Error {
  constructor() {
    super(
      "Ask Relay demo tools connect only to a loopback database named relay_demo.",
    );
    this.name = "DemoDatabaseError";
  }
}

// Returns the URL unchanged when it can only reach the local demo database.
// Both the URL text and the host and database pg would actually use are
// checked, so query parameters such as ?host= cannot redirect the connection.
export function requireDemoDatabaseUrl(value: string | undefined): string {
  if (!isLocalDatabaseUrl(value, DEMO_DATABASE_NAME))
    throw new DemoDatabaseError();
  return value;
}
