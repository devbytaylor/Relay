import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DemoDatabaseError,
  requireDemoDatabaseUrl,
} from "../../src/data/demo-database.js";
import {
  DEV_DATABASE_NAME,
  requireDevDatabaseUrl,
} from "../../src/data/dev-database.js";

test("demo and dev guards accept only their own loopback PostgreSQL database", () => {
  for (const [name, requireUrl] of [
    ["relay_demo", requireDemoDatabaseUrl],
    [DEV_DATABASE_NAME, requireDevDatabaseUrl],
  ] as const) {
    for (const url of [
      `postgresql://operator:secret@127.0.0.1:5432/${name}`,
      `postgres://operator@localhost/${name}`,
      `postgresql://operator@[::1]:5432/${name}`,
    ])
      assert.equal(requireUrl(url), url);
  }
});

test("demo and dev guards reject redirects and preserve their error contracts", () => {
  for (const [name, otherName, requireUrl, expectedError] of [
    ["relay_demo", DEV_DATABASE_NAME, requireDemoDatabaseUrl, DemoDatabaseError],
    [DEV_DATABASE_NAME, "relay_demo", requireDevDatabaseUrl, Error],
  ] as const) {
    for (const url of [
      undefined,
      "",
      "not a url",
      `postgresql://operator@remote.example/${name}`,
      `postgresql://operator@127.0.0.1/${otherName}`,
      `postgresql://operator@127.0.0.1/${name}?host=remote.example`,
      `postgresql://operator@127.0.0.1/${name}?host=/var/run/postgresql`,
      `mysql://operator@127.0.0.1/${name}`,
    ])
      assert.throws(() => requireUrl(url), expectedError);
  }
});
