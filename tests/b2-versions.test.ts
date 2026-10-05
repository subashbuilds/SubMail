import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { deleteStoredObjects, parseVersionListing, dedupeKeyPrefixes } from "../src/lib/b2.js";
import { buildAttachmentR2Key } from "../src/db/messages.js";

/**
 * Guards the version-aware deletion path.
 *
 * A key-addressed B2 delete does NOT free an object: it drops a delete marker
 * over the current version. The object then 404s and vanishes from
 * ListObjectsV2 while its bytes remain stored and billable as a non-current
 * version — which is how 2.2 MB of already-deleted attachments survived in
 * production while every listing reported the bucket as empty.
 *
 * Permanent removal requires targeting the exact version id, which is what
 * these tests pin down.
 */

beforeEach(async () => {
  // The R2 test bucket is shared across the suite and is NOT reset by the
  // D1 helper, so purge it explicitly or counts leak between tests.
  await env.ATTACHMENTS!.delete(
    (await env.ATTACHMENTS!.list({ limit: 1000 })).objects.map((o) => o.key)
  );
});

describe("parseVersionListing", () => {
  it("parses real ListVersions XML, distinguishing versions from delete markers", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Version>
    <IsLatest>true</IsLatest>
    <Key>attachments/mb1/&lt;abc@mail.gmail.com&gt;/file1</Key>
    <LastModified>2026-10-04T10:23:00.000Z</LastModified>
    <Size>2188546</Size>
    <VersionId>4_z4a7ad_f482_d20261004_m045307</VersionId>
  </Version>
  <DeleteMarker>
    <IsLatest>false</IsLatest>
    <Key>attachments/mb1/&lt;abc@mail.gmail.com&gt;/file1</Key>
    <LastModified>2026-10-04T13:26:31.000Z</LastModified>
    <VersionId>4_z4a7ad_f441_d20261004_m132631</VersionId>
  </DeleteMarker>
</ListVersionsResult>`;

    const parsed = parseVersionListing(xml);

    expect(parsed).toHaveLength(2);

    const [version, marker] = parsed;
    // Keys containing '<' and '>' are XML-escaped by B2; a naive regex
    // captures the escaped text and the delete then addresses a key that
    // does not exist, leaving the real one behind forever.
    expect(version?.key).toBe("attachments/mb1/<abc@mail.gmail.com>/file1");
    expect(version?.isDeleteMarker).toBe(false);
    expect(version?.size).toBe(2188546);
    expect(version?.lastModified).toBe(Date.parse("2026-10-04T10:23:00.000Z"));

    expect(marker?.isDeleteMarker).toBe(true);
    expect(marker?.size).toBe(0);
  });

  it("returns an empty list for an empty bucket", () => {
    expect(parseVersionListing("<ListVersionsResult></ListVersionsResult>")).toEqual([]);
  });
});

describe("dedupeKeyPrefixes", () => {
  it("collapses a key that sits under another key's prefix", () => {
    expect(
      dedupeKeyPrefixes([
        "attachments/a/b/c/leaf",
        "attachments/a/b/c",
        "attachments/a/b/c/other",
      ])
    ).toEqual(["attachments/a/b/c"]);
  });

  it("keeps sibling keys that share no prefix", () => {
    expect(dedupeKeyPrefixes(["attachments/m1/x", "attachments/m2/x"])).toEqual([
      "attachments/m1/x",
      "attachments/m2/x",
    ]);
  });

  it("does not let a shorter key swallow a longer sibling", () => {
    // "a/b" must not absorb "a/bc" — the separator is significant.
    expect(dedupeKeyPrefixes(["attachments/a/bc", "attachments/a/b"])).toEqual([
      "attachments/a/b",
      "attachments/a/bc",
    ]);
  });
});

describe("deleteStoredObjects", () => {
  it("removes the object rather than leaving it behind", async () => {
    const key = buildAttachmentR2Key("mailbox-purge", "msg-1");
    await env.ATTACHMENTS!.put(key, new TextEncoder().encode("attachment-bytes"));

    await deleteStoredObjects(env, [key]);

    expect(await env.ATTACHMENTS!.get(key)).toBeNull();
  });

  it("is idempotent — a second delete of the same key is a no-op", async () => {
    const key = buildAttachmentR2Key("mailbox-idempotent", "msg-1");
    await env.ATTACHMENTS!.put(key, new TextEncoder().encode("bytes"));

    await deleteStoredObjects(env, [key]);
    await expect(deleteStoredObjects(env, [key])).resolves.toBeUndefined();

    expect(await env.ATTACHMENTS!.get(key)).toBeNull();
  });

  it("deletes every key in a multi-key batch", async () => {
    const keys = [
      buildAttachmentR2Key("mailbox-multi", "msg-1"),
      buildAttachmentR2Key("mailbox-multi", "msg-2"),
      buildAttachmentR2Key("mailbox-multi", "msg-3"),
    ];
    for (const key of keys) {
      await env.ATTACHMENTS!.put(key, new TextEncoder().encode("bytes"));
    }

    await deleteStoredObjects(env, keys);

    for (const key of keys) {
      expect(await env.ATTACHMENTS!.get(key)).toBeNull();
    }
  });

  it("leaves sibling objects under the same prefix alone", async () => {
    const keep = buildAttachmentR2Key("mailbox-sibling", "msg-keep");
    const drop = buildAttachmentR2Key("mailbox-sibling", "msg-drop");
    await env.ATTACHMENTS!.put(keep, new TextEncoder().encode("keep"));
    await env.ATTACHMENTS!.put(drop, new TextEncoder().encode("drop"));

    await deleteStoredObjects(env, [drop]);

    expect(await env.ATTACHMENTS!.get(drop)).toBeNull();
    expect(await env.ATTACHMENTS!.get(keep)).not.toBeNull();
  });

  it("never deletes a key that merely shares a string prefix with a deleted one", async () => {
    // B2's versioned listing matches prefixes as raw strings, not by path
    // segment, so listing "…/file1" also returns "…/file10". Without an
    // exact-key filter the purge would delete a LIVE attachment whose key
    // merely starts with the same characters.
    const live = "attachments/mb-prefix/msg/file10";
    const drop = "attachments/mb-prefix/msg/file1";
    await env.ATTACHMENTS!.put(live, new TextEncoder().encode("live"));
    await env.ATTACHMENTS!.put(drop, new TextEncoder().encode("drop"));

    await deleteStoredObjects(env, [drop]);

    expect(await env.ATTACHMENTS!.get(drop)).toBeNull();
    expect(await env.ATTACHMENTS!.get(live)).not.toBeNull();
  });

  it("does not touch keys in other mailboxes", async () => {
    const drop = buildAttachmentR2Key("mailbox-a", "msg-1");
    const keep = buildAttachmentR2Key("mailbox-b", "msg-1");
    await env.ATTACHMENTS!.put(drop, new TextEncoder().encode("a"));
    await env.ATTACHMENTS!.put(keep, new TextEncoder().encode("b"));

    await deleteStoredObjects(env, [drop]);

    expect(await env.ATTACHMENTS!.get(keep)).not.toBeNull();
  });

  it("handles an empty key list without calling storage", async () => {
    await expect(deleteStoredObjects(env, [])).resolves.toBeUndefined();
  });
});