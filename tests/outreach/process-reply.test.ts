import "dotenv/config";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { processLatestReply } from "../../src/outreach/process-reply.js";
import { monitorReplies } from "../../src/outreach/reply-monitor.js";
import { responseBodyWithSignature } from "../../src/outreach/reply-context.js";
import { getResponseReview } from "../../src/outreach/response-review.js";
import { replyDecision, rawReply } from "../helpers/reply-fixtures.js";

test(
  "Reply processing: durable classification and review-only response drafting",
  { skip: !process.env.RELAY_DRAFT_TEST_DATABASE_URL },
  async (t) => {
    const connectionString = process.env.RELAY_DRAFT_TEST_DATABASE_URL!;
    const schema = `response_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString });
    const database = new Pool({
      connectionString,
      options: `-c search_path=${schema}`,
    });
    await admin.query(`CREATE SCHEMA ${schema}`);
    t.after(async () => {
      await database.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    const directory = new URL("../../migrations/", import.meta.url);
    const migrationFiles = (await readdir(directory))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const thread = (replyId = "reply") => ({
      id: "thread",
      messages: [
        {
          id: "outbound",
          threadId: "thread",
          internalDate: "1000",
          labelIds: ["SENT"],
        },
        {
          id: replyId,
          threadId: "thread",
          internalDate: replyId === "reply" ? "2000" : "3000",
          labelIds: ["INBOX"],
        },
      ],
    });
    const seed = async () => {
      // Reset this test-owned schema; audit rows cannot be deleted individually.
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.query(`CREATE SCHEMA ${schema}`);
      for (const file of migrationFiles)
        await database.query(await readFile(new URL(file, directory), "utf8"));
      const id = randomUUID();
      await database.query(
        `INSERT INTO prospects (id,company_name,contact_email,stage,cold_outreach_blocked)
      VALUES ($1,'Test','person@example.com','replied',true)`,
        [id],
      );
      await database.query(
        `INSERT INTO message_drafts
      (prospect_id,recipient_email,subject,body,gmail_thread_id,send_status,sent_message_id,sent_at)
      VALUES ($1,'person@example.com','Hello','Original outreach','thread','sent','outbound',now())`,
        [id],
      );
      await database.query(
        `INSERT INTO prospect_replies
      (prospect_id,gmail_message_id,gmail_thread_id,received_at,sender,subject,snippet)
      VALUES ($1,'reply','thread',to_timestamp(2),'person@example.com','Re: Hello','Preview only')`,
        [id],
      );
      return id;
    };
    const newer = async (id: string) =>
      database.query(
        `INSERT INTO prospect_replies
    (prospect_id,gmail_message_id,gmail_thread_id,received_at,sender,subject,snippet)
    VALUES ($1,'newer','thread',to_timestamp(3),'person@example.com','Re: Hello','New reply')`,
        [id],
      );
    const dependencies = () => ({
      database,
      readThread: async () => thread(),
      readMessage: async () => ({
        id: "reply",
        threadId: "thread",
        raw: rawReply(),
        labelIds: ["INBOX"],
      }),
      classify: async () => ({ ...replyDecision }),
      createGmailDraft: async (_raw: string, _threadId?: string) => ({
        draftId: String(randomUUID()),
        messageId: String(randomUUID()),
        threadId: "thread",
      }),
    });
    const request = async (id: string) =>
      (
        await database.query(
          "SELECT * FROM reply_processing_requests WHERE prospect_id=$1",
          [id],
        )
      ).rows[0];
    const responseCount = async () =>
      Number(
        (
          await database.query(
            "SELECT count(*) FROM message_drafts WHERE draft_type='response'",
          )
        ).rows[0].count,
      );

    await t.test(
      "reserves before AI and Gmail, creates an exact-parent unapproved draft, never queues work",
      async () => {
        const id = await seed();
        const deps = dependencies();
        deps.classify = async () => {
          assert.equal((await request(id)).status, "classifying");
          return replyDecision;
        };
        deps.createGmailDraft = async (raw, threadId) => {
          assert.equal((await request(id)).status, "creating");
          assert.equal(threadId, "thread");
          assert.match(
            Buffer.from(raw, "base64url").toString(),
            /In-Reply-To: <reply@example.com>/,
          );
          return {
            draftId: "created-draft",
            messageId: "created-message",
            threadId: "thread",
          };
        };
        const result = await processLatestReply(id, deps);
        assert.equal(result.status, "created");
        const row = (
          await database.query("SELECT * FROM message_drafts WHERE id=$1", [
            result.draftId,
          ])
        ).rows[0];
        assert.equal(row.source_reply_message_id, "reply");
        assert.equal(row.review_status, "needs_review");
        assert.equal(row.send_status, "pending");
        assert.equal(
          row.body,
          responseBodyWithSignature(replyDecision.suggestedResponse),
        );
        assert.equal(row.recipient_email, "person@example.com");
        assert.equal(row.gmail_thread_id, "thread");
        assert.equal(row.response_parent_rfc_message_id, "<reply@example.com>");
        assert.equal(
          (await request(id)).classification.classification,
          "Interested",
        );
        assert.equal(
          (await database.query("SELECT count(*) FROM outreach_jobs")).rows[0]
            .count,
          "0",
        );
        assert.equal(
          (await database.query("SELECT cold_outreach_blocked FROM prospects"))
            .rows[0].cold_outreach_blocked,
          true,
        );
      },
    );
    await t.test("exact review reads draft, creation journal, reply and current attempt without writes", async () => {
      const id = await seed();
      const created = await processLatestReply(id, dependencies());
      const identity = { prospectId: id, draftId: created.draftId!, requestId: created.requestId, replyId: "reply" };
      const before = await database.query("SELECT updated_at FROM message_drafts WHERE id=$1", [created.draftId]);
      const review = await getResponseReview(database, identity);
      assert.equal(review.body, responseBodyWithSignature(replyDecision.suggestedResponse));
      assert.equal(review.requestStatus, "created");
      assert.equal(review.replyId, "reply");
      assert.equal(review.replyParentRfcMessageId, "<reply@example.com>");
      assert.equal(review.replyParentIdentityStatus, "recorded");
      assert.equal(review.attemptStatus, null);
      for (const change of [
        { prospectId: randomUUID() }, { draftId: randomUUID() },
        { requestId: randomUUID() }, { replyId: "other" },
      ]) await assert.rejects(getResponseReview(database, { ...identity, ...change }));
      assert.deepEqual((await database.query("SELECT updated_at FROM message_drafts WHERE id=$1", [created.draftId])).rows, before.rows);
      assert.equal((await database.query("SELECT count(*) FROM response_send_attempts")).rows[0].count, "0");
    });
    await t.test("response approval and attempt claims remain disabled", async () => {
      const id = await seed();
      const created = await processLatestReply(id, dependencies());
      const hash = "a".repeat(64);
      assert.equal((await database.query("SELECT count(*) FROM reply_processing_requests WHERE prospect_id=$1", [id])).rows[0].count, "1");
      await assert.rejects(database.query("UPDATE message_drafts SET review_status='approved' WHERE id=$1", [created.draftId]));
      await assert.rejects(database.query("UPDATE message_drafts SET response_approval_hash=$2 WHERE id=$1", [created.draftId, hash]));
      await assert.rejects(database.query("UPDATE message_drafts SET review_status='approved',response_approval_hash=$2,response_approved_snapshot=$3 WHERE id=$1", [created.draftId, hash, JSON.stringify({ recipientEmail: "person@example.com" })]));
      await assert.rejects(database.query("INSERT INTO response_send_attempts (draft_id,status,approved_content_hash,approved_snapshot) VALUES ($1,'sent',$2,'{}')", [created.draftId, hash]));
      await assert.rejects(database.query("INSERT INTO response_send_attempts (draft_id,status,approved_content_hash,approved_snapshot) VALUES ($1,'preflight',$2,$3)", [created.draftId, hash, JSON.stringify({ recipientEmail: "person@example.com" })]));
      await assert.rejects(database.query("INSERT INTO response_send_attempts (draft_id,status,approved_content_hash,approved_snapshot) VALUES ($1,'preflight',$2,'{}')", [created.draftId, hash]));
      assert.equal((await database.query("UPDATE response_send_attempts SET status='invoking' WHERE draft_id=$1", [created.draftId])).rowCount, 0);
      assert.equal((await database.query("UPDATE response_send_attempts SET status='needs_reconciliation' WHERE draft_id=$1", [created.draftId])).rowCount, 0);
      await assert.rejects(database.query("UPDATE message_drafts SET send_status='sending' WHERE id=$1", [created.draftId]));
      assert.equal((await database.query("SELECT send_status FROM message_drafts WHERE id=$1", [created.draftId])).rows[0].send_status, "pending");
      const review = await getResponseReview(database, { prospectId: id, draftId: created.draftId!, requestId: created.requestId, replyId: "reply" });
      assert.equal(review.attemptStatus, null);
      const outreach = (await database.query("SELECT id FROM message_drafts WHERE prospect_id=$1 AND draft_type='outreach'", [id])).rows[0].id;
      await assert.rejects(database.query("INSERT INTO response_send_attempts (draft_id,status,approved_content_hash,approved_snapshot) VALUES ($1,'preflight',$2,'{}')", [outreach, hash]));
    });
    await t.test(
      "concurrent and repeated processing cannot duplicate AI calls or Gmail drafts",
      async () => {
        const id = await seed();
        let ai = 0,
          gmail = 0;
        const deps = {
          ...dependencies(),
          classify: async () => {
            ai++;
            return replyDecision;
          },
          createGmailDraft: async () => {
            gmail++;
            return { draftId: "one", messageId: "message", threadId: "thread" };
          },
        };
        const results = await Promise.allSettled([
          processLatestReply(id, deps),
          processLatestReply(id, deps),
        ]);
        assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
        await assert.rejects(processLatestReply(id, deps));
        assert.equal(ai, 1);
        assert.equal(gmail, 1);
        assert.equal(await responseCount(), 1);
      },
    );
    await t.test(
      "invalid AI output fails before Gmail and leaves a durable retry block",
      async () => {
        const id = await seed();
        await assert.rejects(
          processLatestReply(id, {
            ...dependencies(),
            classify: async () => ({ ...replyDecision, confidence: "Low" }),
            createGmailDraft: async () => {
              assert.fail("Gmail must not be called");
            },
          }),
        );
        assert.equal((await request(id)).status, "failed");
        assert.equal(await responseCount(), 0);
        await assert.rejects(processLatestReply(id, dependencies()));
      },
    );
    await t.test(
      "negative, OOO, unclear and referral decisions create no response reference",
      async () => {
        for (const [classification, nextAction] of [
          ["Not Interested", "Stop Outreach"],
          ["Out of Office", "Wait"],
          ["Unclear", "Manual Review"],
          ["Referral / Wrong Contact", "Contact Referral"],
        ]) {
          const id = await seed();
          const result = await processLatestReply(id, {
            ...dependencies(),
            classify: async () => ({
              ...replyDecision,
              classification,
              nextAction,
              shouldDraftResponse: false,
              responseGoal: "",
              suggestedResponse: "",
            }),
            createGmailDraft: async () => {
              assert.fail("No draft for this classification");
            },
          });
          assert.equal(result.status, "no_draft");
          assert.equal(result.draftId, null);
          assert.equal((await request(id)).gmail_draft_id, null);
          assert.equal(await responseCount(), 0);
        }
      },
    );
    await t.test(
      "explicit or previously recorded opt-outs skip AI and Gmail and remain durable",
      async () => {
        for (const existing of [false, true]) {
          const id = await seed();
          if (existing)
            await database.query(
              "UPDATE prospects SET communication_opted_out=true WHERE id=$1",
              [id],
            );
          await processLatestReply(id, {
            ...dependencies(),
            readMessage: async () => ({
              id: "reply",
              threadId: "thread",
              raw: rawReply(
                existing ? "Interested now" : "Please unsubscribe me",
              ),
            }),
            classify: async () => {
              assert.fail("Local opt-out policy precedes the model");
            },
            createGmailDraft: async () => {
              assert.fail("No opt-out response");
            },
          });
          assert.equal(
            (await request(id)).classification.classification,
            "Opt Out",
          );
          assert.equal(
            (
              await database.query(
                "SELECT communication_opted_out FROM prospects",
              )
            ).rows[0].communication_opted_out,
            true,
          );
        }
      },
    );
    await t.test(
      "model-classified opt-outs persist suppression, automatic messages never generate drafts",
      async () => {
        let id = await seed();
        await processLatestReply(id, {
          ...dependencies(),
          classify: async () => ({
            ...replyDecision,
            classification: "Opt Out",
            nextAction: "Stop Outreach",
            shouldDraftResponse: false,
            responseGoal: "",
            suggestedResponse: "",
          }),
        });
        assert.equal(
          (
            await database.query(
              "SELECT communication_opted_out FROM prospects",
            )
          ).rows[0].communication_opted_out,
          true,
        );
        id = await seed();
        await processLatestReply(id, {
          ...dependencies(),
          readMessage: async () => ({
            id: "reply",
            threadId: "thread",
            raw: rawReply("Automatic reply", ["Auto-Submitted: auto-replied"]),
          }),
          classify: async () => {
            assert.fail("Do not feed automatic reply into drafting");
          },
          createGmailDraft: async () => {
            assert.fail("Do not reply to automatic messages");
          },
        });
        assert.equal((await request(id)).status, "no_draft");
      },
    );
    await t.test(
      "unknown reply routing and live unrecorded newer replies stop before AI or Gmail",
      async () => {
        for (const mode of ["routing", "newer"]) {
          const id = await seed();
          await assert.rejects(
            processLatestReply(id, {
              ...dependencies(),
              readThread: async () =>
                mode === "newer" ? thread("newer") : thread(),
              readMessage: async () => ({
                id: "reply",
                threadId: "thread",
                raw: rawReply("Body", ["Reply-To: other@example.com"]),
              }),
              classify: async () => {
                assert.fail("Do not classify mismatched reply/routing");
              },
              createGmailDraft: async () => {
                assert.fail("Do not create a stale or misrouted response");
              },
            }),
          );
          assert.equal((await request(id)).status, "failed");
        }
      },
    );
    await t.test(
      "newer recorded reply or opt-out during classification stops before Gmail creation",
      async () => {
        for (const mode of ["newer", "opt-out"]) {
          const id = await seed();
          await assert.rejects(
            processLatestReply(id, {
              ...dependencies(),
              classify: async () => {
                if (mode === "newer") await newer(id);
                else
                  await database.query(
                    "UPDATE prospects SET communication_opted_out=true WHERE id=$1",
                    [id],
                  );
                return replyDecision;
              },
              createGmailDraft: async () => {
                assert.fail("Do not create after state changed");
              },
            }),
          );
          assert.equal(await responseCount(), 0);
        }
      },
    );
    await t.test(
      "uncertain Gmail creation and wrong-thread responses retain recovery evidence without retry",
      async () => {
        for (const mode of ["lost", "wrong-thread"]) {
          const id = await seed();
          let calls = 0;
          const deps = {
            ...dependencies(),
            createGmailDraft: async () => {
              calls++;
              if (mode === "lost") throw new Error("lost creation response");
              return {
                draftId: "wrong-thread-draft",
                messageId: "wrong-message",
                threadId: "other-thread",
              };
            },
          };
          await assert.rejects(processLatestReply(id, deps));
          const journal = await request(id);
          assert.equal(journal.status, "needs_reconciliation");
          if (mode === "wrong-thread")
            assert.equal(journal.gmail_draft_id, "wrong-thread-draft");
          await assert.rejects(processLatestReply(id, deps));
          assert.equal(calls, 1);
          assert.equal(await responseCount(), 0);
        }
      },
    );
    await t.test(
      "newer live reply or contact change during creation keeps IDs and withholds a reviewable response",
      async () => {
        for (const mode of ["newer", "contact"]) {
          const id = await seed();
          let created = false;
          await assert.rejects(
            processLatestReply(id, {
              ...dependencies(),
              readThread: async () =>
                created && mode === "newer" ? thread("newer") : thread(),
              createGmailDraft: async () => {
                created = true;
                if (mode === "contact")
                  await database.query(
                    "UPDATE prospects SET contact_email='changed@example.com' WHERE id=$1",
                    [id],
                  );
                return {
                  draftId: "needs-recovery",
                  messageId: "external-message",
                  threadId: "thread",
                };
              },
            }),
          );
          assert.equal((await request(id)).status, "needs_reconciliation");
          assert.equal((await request(id)).gmail_draft_id, "needs-recovery");
          assert.equal(await responseCount(), 0);
        }
      },
    );
    await t.test(
      "monitor superseding an in-progress creation makes its journal reconciliation-required",
      async () => {
        const id = await seed();
        await assert.rejects(
          processLatestReply(id, {
            ...dependencies(),
            createGmailDraft: async () => {
              assert.equal((await request(id)).status, "creating");
              await monitorReplies(database, async () => thread("newer"));
              assert.equal((await request(id)).status, "needs_reconciliation");
              return {
                draftId: "superseded-external-draft",
                messageId: "external-message",
                threadId: "thread",
              };
            },
          }),
        );
        assert.equal((await request(id)).status, "needs_reconciliation");
        assert.equal(
          (await request(id)).gmail_draft_id,
          "superseded-external-draft",
        );
        assert.equal(await responseCount(), 0);
      },
    );
    await t.test(
      "database finalization conflict rolls back draft state and retains returned IDs",
      async () => {
        const id = await seed();
        await database.query(
          `INSERT INTO message_drafts (prospect_id,recipient_email,subject,body,gmail_draft_id)
      VALUES ($1,'person@example.com','Other','Body','duplicate-gmail-id')`,
          [id],
        );
        await assert.rejects(
          processLatestReply(id, {
            ...dependencies(),
            createGmailDraft: async () => ({
              draftId: "duplicate-gmail-id",
              messageId: "created-message",
              threadId: "thread",
            }),
          }),
        );
        assert.equal((await request(id)).status, "needs_reconciliation");
        assert.equal(await responseCount(), 0);
        assert.equal((await request(id)).gmail_draft_id, "duplicate-gmail-id");
      },
    );
    await t.test(
      "database outage after Gmail leaves a creating reservation that blocks duplicate creation",
      async () => {
        const id = await seed();
        let offline = false;
        const unavailable = new Proxy(database, {
          get(target, key) {
            if (key === "connect")
              return async () => {
                if (offline) throw new Error("offline");
                return target.connect();
              };
            if (key === "query")
              return async (...args: unknown[]) => {
                if (offline) throw new Error("offline");
                return Reflect.apply(target.query, target, args);
              };
            return Reflect.get(target, key);
          },
        });
        await assert.rejects(
          processLatestReply(id, {
            ...dependencies(),
            database: unavailable,
            createGmailDraft: async () => {
              offline = true;
              return {
                draftId: "unrecorded",
                messageId: "unrecorded-message",
                threadId: "thread",
              };
            },
          }),
        );
        assert.equal((await request(id)).status, "creating");
        await assert.rejects(processLatestReply(id, dependencies()));
      },
    );
    await t.test(
      "lost final commit acknowledgement preserves a successfully created draft instead of enabling retry",
      async () => {
        const id = await seed();
        let commits = 0;
        const lostAck = new Proxy(database, {
          get(target, key) {
            if (key === "query") return target.query.bind(target);
            if (key === "connect")
              return async () => {
                const client = await target.connect();
                return new Proxy(client, {
                  get(connection, property) {
                    if (property === "query")
                      return async (...args: unknown[]) => {
                        const result = await Reflect.apply(
                          connection.query,
                          connection,
                          args,
                        );
                        if (args[0] === "COMMIT" && ++commits === 3)
                          throw new Error("lost commit acknowledgement");
                        return result;
                      };
                    const value = Reflect.get(connection, property);
                    return typeof value === "function"
                      ? value.bind(connection)
                      : value;
                  },
                });
              };
            return Reflect.get(target, key);
          },
        });
        await assert.rejects(
          processLatestReply(id, { ...dependencies(), database: lostAck }),
        );
        assert.equal((await request(id)).status, "created");
        assert.equal(await responseCount(), 1);
        await assert.rejects(processLatestReply(id, dependencies()));
      },
    );
    await t.test(
      "monitor revokes a pending response without creating an attempt",
      async () => {
        const id = await seed();
        const result = await processLatestReply(id, dependencies());
        await monitorReplies(database, async () => thread("newer"));
        const draft = (await database.query("SELECT review_status,send_status FROM message_drafts WHERE id=$1", [result.draftId])).rows[0];
        assert.equal(draft.review_status, "rejected");
        assert.equal(draft.send_status, "pending");
        assert.equal((await request(id)).status, "stale");
        assert.equal((await database.query("SELECT count(*) FROM response_send_attempts WHERE draft_id=$1", [result.draftId])).rows[0].count, "0");
      },
    );
  },
);
