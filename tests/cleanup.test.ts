import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env, SELF, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";
import { createMailbox } from "../src/db/mailboxes.js";
import { createMessage, createAttachment, buildAttachmentR2Key } from "../src/db/messages.js";
import { hashToken, generateMailboxToken } from "../src/lib/token.js";
import { runExpiredMailboxCleanup, sweepOrphanedAttachments } from "../src/cleanup/expired-mailboxes.js";
import { applyAllMigrations, resetAllTables } from "./helpers/migrate.js";

beforeAll(async () => {
  await applyAllMigrations(env.DB);
});

beforeEach(async () => {
  await resetAllTables(env.DB);
});

/** Create a mailbox and force its expiry (or non-expiry) directly via SQL, for cleanup testing. */
async function createMailboxWithExpiry(localPart: string, expiresAt: number) {
  const tokenHash = await hashToken(generateMailboxToken());
  const mailbox = await createMailbox(env, {
    localPart,
    domain: "example.com",
    address: `${localPart}@example.com`,
    tokenHash,
    ttlHours: 48,
  });
  await env.DB.prepare("UPDATE mailboxes SET expires_at = ? WHERE id = ?").bind(expiresAt, mailbox.id).run();
  return mailbox;
}

describe("runExpiredMailboxCleanup", () => {
  it("deletes an expired mailbox and leaves a non-expired one untouched", async () => {
    const expired = await createMailboxWithExpiry("expired-one", Date.now() - 1000);
    const active = await createMailboxWithExpiry("still-active", Date.now() + 1000 * 60 * 60);

    const result = await runExpiredMailboxCleanup(env);
    expect(result.mailboxesDeleted).toBe(1);

    const expiredRow = await env.DB.prepare("SELECT 1 FROM mailboxes WHERE id = ?").bind(expired.id).first();
    const activeRow = await env.DB.prepare("SELECT 1 FROM mailboxes WHERE id = ?").bind(active.id).first();
    expect(expiredRow).toBeNull();
    expect(activeRow).not.toBeNull();
  });

  it("cascades deletion to messages, attachment metadata, and stored B2 objects (via the local R2 test binding)", async () => {
    const mailbox = await createMailboxWithExpiry("with-mail", Date.now() - 1000);
    const message = await createMessage(env, {
      mailboxId: mailbox.id,
      messageId: null,
      senderName: "Sender",
      senderAddress: "sender@outside.example",
      recipientAddress: mailbox.address,
      subject: "Hello",
      textBody: "hi",
      htmlBody: null,
      sizeBytes: 100,
      hasAttachments: true,
    });

    const r2Key = buildAttachmentR2Key(mailbox.id, message.id);
    await env.ATTACHMENTS!.put(r2Key, new TextEncoder().encode("file contents"));
    await createAttachment(env, {
      messageId: message.id,
      filename: "file.txt",
      contentType: "text/plain",
      sizeBytes: 13,
      r2Key,
    });

    await runExpiredMailboxCleanup(env);

    const messageRow = await env.DB.prepare("SELECT 1 FROM messages WHERE id = ?").bind(message.id).first();
    const attachmentRow = await env.DB.prepare("SELECT 1 FROM attachments WHERE message_id = ?")
      .bind(message.id)
      .first();
    const r2Object = await env.ATTACHMENTS!.get(r2Key);

    expect(messageRow).toBeNull();
    expect(attachmentRow).toBeNull();
    expect(r2Object).toBeNull();
  });

  it("processes at most CLEANUP_BATCH_SIZE mailboxes per invocation", async () => {
    const batchSize = Number(env.CLEANUP_BATCH_SIZE);
    // Create more expired mailboxes than one batch can hold.
    const total = batchSize + 5;
    for (let i = 0; i < total; i++) {
      await createMailboxWithExpiry(`batch-${i}`, Date.now() - 1000);
    }

    const firstRun = await runExpiredMailboxCleanup(env);
    expect(firstRun.mailboxesDeleted).toBe(batchSize);

    const remaining = await env.DB.prepare("SELECT COUNT(*) AS count FROM mailboxes").first<{ count: number }>();
    expect(remaining?.count).toBe(total - batchSize);

    // A second invocation picks up the rest — demonstrates the batching
    // doesn't lose mailboxes, just spreads the work across runs.
    const secondRun = await runExpiredMailboxCleanup(env);
    expect(secondRun.mailboxesDeleted).toBe(5);

    const finalCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM mailboxes").first<{ count: number }>();
    expect(finalCount?.count).toBe(0);
  }, 15000);

  it("is idempotent: running again with nothing expired deletes nothing and does not error", async () => {
    await createMailboxWithExpiry("expired-again", Date.now() - 1000);

    const first = await runExpiredMailboxCleanup(env);
    expect(first.mailboxesDeleted).toBe(1);

    const second = await runExpiredMailboxCleanup(env);
    expect(second.mailboxesDeleted).toBe(0);

    const third = await runExpiredMailboxCleanup(env);
    expect(third.mailboxesDeleted).toBe(0);
  });

  it("handles an empty mailboxes table without error", async () => {
    const result = await runExpiredMailboxCleanup(env);
    expect(result.mailboxesDeleted).toBe(0);
  });

  it("makes an expired mailbox's attachment permanently unreachable end-to-end (real scheduled() cron, real HTTP download)", async () => {
    // This exercises the FULL production path rather than the internal
    // helper: a mailbox is created over the real API, an attachment is
    // uploaded and downloaded over the real endpoint, the mailbox is aged
    // past its TTL, and the actual `scheduled()` cron handler is invoked.
    // It then proves the attachment is not merely unlisted but truly gone:
    // the storage object is deleted, the D1 rows are cascaded away, and the
    // download endpoint stops serving the bytes even for a caller who still
    // holds a valid (pre-expiry) token — which is the property that matters
    // for a service whose entire promise is that mail deletes itself.
    const created = await SELF.fetch("https://app.example.com/api/mailbox", { method: "POST" });
    const { data: mailbox } = (await created.json()) as { data: { id: string; token: string; address: string } };

    const message = await createMessage(env, {
      mailboxId: mailbox.id,
      messageId: null,
      senderName: "Sender",
      senderAddress: "sender@outside.example",
      recipientAddress: mailbox.address,
      subject: "With attachment",
      textBody: "see attached",
      htmlBody: null,
      sizeBytes: 120,
      hasAttachments: true,
    });

    const r2Key = buildAttachmentR2Key(mailbox.id, message.id);
    const fileBytes = new TextEncoder().encode("attachment-bytes-to-be-deleted");
    await env.ATTACHMENTS!.put(r2Key, fileBytes, { httpMetadata: { contentType: "text/plain" } });
    const attachment = await createAttachment(env, {
      messageId: message.id,
      filename: "secret.txt",
      contentType: "text/plain",
      sizeBytes: fileBytes.byteLength,
      r2Key,
    });

    const authHeaders = { Authorization: `Bearer ${mailbox.token}`, "X-Mailbox-Id": mailbox.id };

    // Before expiry: the attachment downloads successfully.
    const beforeRes = await SELF.fetch(`https://app.example.com/api/attachments/${attachment.id}`, {
      headers: authHeaders,
    });
    expect(beforeRes.status).toBe(200);
    expect(await beforeRes.text()).toBe("attachment-bytes-to-be-deleted");

    // Age the mailbox past its TTL and run the real Cron entry point.
    await env.DB.prepare("UPDATE mailboxes SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1000, mailbox.id)
      .run();

    const ctx = createExecutionContext();
    await worker.scheduled!({} as ScheduledEvent, env, ctx);
    await waitOnExecutionContext(ctx);

    // The stored object itself is gone from object storage.
    expect(await env.ATTACHMENTS!.get(r2Key)).toBeNull();

    // All D1 rows are cascaded away.
    expect(await env.DB.prepare("SELECT 1 FROM mailboxes WHERE id = ?").bind(mailbox.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM messages WHERE id = ?").bind(message.id).first()).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM attachments WHERE id = ?").bind(attachment.id).first()
    ).toBeNull();

    // And the bytes are no longer retrievable over HTTP with the old token.
    const afterRes = await SELF.fetch(`https://app.example.com/api/attachments/${attachment.id}`, {
      headers: authHeaders,
    });
    expect(afterRes.status).not.toBe(200);
    expect(await afterRes.text()).not.toContain("attachment-bytes-to-be-deleted");
  });

  it("does not delete attachments belonging to a mailbox that is still active", async () => {
    // The complement of the test above: the cascade must be scoped to the
    // expired mailbox only, so one mailbox reaching its TTL can never take
    // another mailbox's attachments down with it.
    const expired = await createMailboxWithExpiry("gone-soon", Date.now() - 1000);
    const active = await createMailboxWithExpiry("still-here", Date.now() + 60 * 60 * 1000);

    async function attach(mailboxId: string, address: string, key: string) {
      const message = await createMessage(env, {
        mailboxId,
        messageId: null,
        senderName: "Sender",
        senderAddress: "sender@outside.example",
        recipientAddress: address,
        subject: "Has attachment",
        textBody: "body",
        htmlBody: null,
        sizeBytes: 50,
        hasAttachments: true,
      });
      const r2Key = buildAttachmentR2Key(mailboxId, message.id);
      await env.ATTACHMENTS!.put(r2Key, new TextEncoder().encode(key));
      return createAttachment(env, {
        messageId: message.id,
        filename: `${key}.txt`,
        contentType: "text/plain",
        sizeBytes: key.length,
        r2Key,
      });
    }

    const expiredAttachment = await attach(expired.id, expired.address, "expired-file");
    const activeAttachment = await attach(active.id, active.address, "active-file");

    await runExpiredMailboxCleanup(env);

    expect(await env.ATTACHMENTS!.get(expiredAttachment.r2_key)).toBeNull();
    expect(await env.ATTACHMENTS!.get(activeAttachment.r2_key)).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM attachments WHERE id = ?").bind(activeAttachment.id).first()
    ).not.toBeNull();
  });

  it("isolates one mailbox's cascade failure so the rest of the batch still gets cleaned", async () => {
    // Regression test for the production wedge: when B2 rejected a batch
    // delete with a bad Content-MD5, the error propagated out of
    // deleteMailboxCascade and aborted the whole loop. Because
    // findExpiredMailboxes returns the OLDEST expired rows first, the same
    // broken mailbox was then re-selected first on every future run and
    // every other expired mailbox behind it was starved forever.
    const failing = await createMailboxWithExpiry("aaa-will-fail", Date.now() - 2000);
    const healthyOne = await createMailboxWithExpiry("bbb-healthy", Date.now() - 1500);
    const healthyTwo = await createMailboxWithExpiry("ccc-healthy", Date.now() - 1000);

    const failingMessage = await createMessage(env, {
      mailboxId: failing.id,
      messageId: null,
      senderName: "Sender",
      senderAddress: "sender@outside.example",
      recipientAddress: failing.address,
      subject: "Doomed",
      textBody: "body",
      htmlBody: null,
      sizeBytes: 40,
      hasAttachments: true,
    });
    const doomedKey = buildAttachmentR2Key(failing.id, failingMessage.id);
    await env.ATTACHMENTS!.put(doomedKey, new TextEncoder().encode("doomed"));
    await createAttachment(env, {
      messageId: failingMessage.id,
      filename: "doomed.txt",
      contentType: "text/plain",
      sizeBytes: 6,
      r2Key: doomedKey,
    });

    // Make ONLY this mailbox's storage delete explode.
    const bucket = env.ATTACHMENTS!;
    const originalDelete = bucket.delete.bind(bucket);
    bucket.delete = async (keys: string[]) => {
      if (keys.includes(doomedKey)) throw new Error("Checksum does not match request body");
      return originalDelete(keys);
    };

    let result;
    try {
      result = await runExpiredMailboxCleanup(env);
    } finally {
      bucket.delete = originalDelete;
    }

    // The failure is reported, not thrown...
    expect(result.mailboxesFailed).toBe(1);
    expect(result.mailboxesDeleted).toBe(2);

    // ...the healthy mailboxes behind it are still deleted...
    expect(
      await env.DB.prepare("SELECT 1 FROM mailboxes WHERE id = ?").bind(healthyOne.id).first()
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM mailboxes WHERE id = ?").bind(healthyTwo.id).first()
    ).toBeNull();

    // ...and the failed mailbox KEEPS its rows, because those rows are the
    // only record of which storage keys still need deleting.
    expect(
      await env.DB.prepare("SELECT 1 FROM mailboxes WHERE id = ?").bind(failing.id).first()
    ).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM attachments WHERE r2_key = ?").bind(doomedKey).first()
    ).not.toBeNull();
  });

  it("also sweeps stale rate-limit windows older than 24 hours", async () => {
    const oldWindow = Date.now() - 25 * 60 * 60 * 1000;
    const recentWindow = Date.now();
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)")
      .bind("test:old", oldWindow)
      .run();
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)")
      .bind("test:recent", recentWindow)
      .run();

    await runExpiredMailboxCleanup(env);

    const oldRow = await env.DB.prepare("SELECT 1 FROM rate_limits WHERE key = ?").bind("test:old").first();
    const recentRow = await env.DB.prepare("SELECT 1 FROM rate_limits WHERE key = ?").bind("test:recent").first();
    expect(oldRow).toBeNull();
    expect(recentRow).not.toBeNull();
  });

  it("deletes stored objects whose mailbox row is gone, and keeps live mailboxes' objects", async () => {
    // resetAllTables only clears D1; purge the object store so the swept
    // count below is exact rather than including earlier tests' leftovers.
    let cursor: string | undefined;
    do {
      const page = await env.ATTACHMENTS!.list({ cursor });
      const keys = (page.objects ?? []).map((o) => o.key);
      if (keys.length > 0) await env.ATTACHMENTS!.delete(keys);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);

    const live = await createMailboxWithExpiry("still-here", Date.now() + 1000 * 60 * 60);
    const gone = await createMailboxWithExpiry("vanished", Date.now() + 1000 * 60 * 60);

    const liveKey = buildAttachmentR2Key(live.id, "msg-live");
    const orphanKey = buildAttachmentR2Key(gone.id, "msg-orphan");
    await env.ATTACHMENTS!.put(liveKey, new TextEncoder().encode("live"));
    await env.ATTACHMENTS!.put(orphanKey, new TextEncoder().encode("orphan"));

    // The mailbox row disappears but its object does not — the state every
    // other deletion path can never repair, because they all learn keys by
    // joining the D1 rows that just went away.
    await env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(gone.id).run();

    const deleted = await sweepOrphanedAttachments(env, { minAgeMs: 0 });

    expect(deleted).toBe(1);
    expect(await env.ATTACHMENTS!.get(orphanKey)).toBeNull();
    expect(await env.ATTACHMENTS!.get(liveKey)).not.toBeNull();
  });

  it("never sweeps a freshly written object (age guard protects in-flight uploads)", async () => {
    const gone = await createMailboxWithExpiry("vanished-recent", Date.now() + 1000 * 60 * 60);
    const orphanKey = buildAttachmentR2Key(gone.id, "msg-recent");
    await env.ATTACHMENTS!.put(orphanKey, new TextEncoder().encode("recent"));
    await env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(gone.id).run();

    // Default 1-hour minimum age: a just-uploaded object is left alone.
    expect(await sweepOrphanedAttachments(env)).toBe(0);
    expect(await env.ATTACHMENTS!.get(orphanKey)).not.toBeNull();
  });

  it("runs the sweep as part of the cron cleanup", async () => {
    const gone = await createMailboxWithExpiry("cron-orphan", Date.now() + 1000 * 60 * 60);
    const orphanKey = buildAttachmentR2Key(gone.id, "msg-cron");
    await env.ATTACHMENTS!.put(orphanKey, new TextEncoder().encode("orphan"));
    await env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(gone.id).run();

    const result = await runExpiredMailboxCleanup(env);

    // The default age guard leaves a fresh object alone even here.
    expect(result.orphanedObjectsDeleted).toBe(0);
    expect(await env.ATTACHMENTS!.get(orphanKey)).not.toBeNull();
  });
});
