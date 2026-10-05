/**
 * Attachment object storage — Backblaze B2 (S3-Compatible API), with a
 * local-R2 test seam.
 *
 * Replaces the previous native R2 binding (`env.ATTACHMENTS`) as the
 * production storage backend with B2's S3-Compatible API, which Backblaze
 * documents at https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api:
 *
 *  - Endpoint format: `https://s3.<region>.backblazeb2.com` (HTTPS only),
 *    with the bucket specified in the path ("path-style" addressing), which
 *    B2 explicitly supports for direct HTTP calls.
 *  - Auth: AWS Signature V4 only. The B2 *application key* is the secret
 *    access key and the *keyID* is the access key ID. The master account
 *    key is NOT supported — a dedicated app key must be created (with at
 *    least the readFiles/writeFiles/deleteFiles capabilities).
 *  - Only three operations are needed (the exact set the old R2 binding
 *    served): Put Object, Get Object, and batch Delete Objects (POST
 *    `?delete`, up to 1000 keys per call — B2 follows the S3 DeleteObjects
 *    contract, including its REQUIRED Content-MD5 request header, which
 *    Web Crypto cannot produce since it has no MD5 — it comes from
 *    `node:crypto` instead; see the Content-MD5 section at the bottom).
 *
 * Requests are signed with `aws4fetch`, a ~2.5 kB gzipped signer built for
 * Workers' fetch + SubtleCrypto, with built-in exponential-backoff retries
 * for transient failures (mirroring the durability the native R2 binding
 * used to provide for free).
 *
 * Failure semantics are kept identical to the R2 version:
 *  - A missing object on read is a `null` return value, not an error (the
 *    attachment route maps it to ATTACHMENT_NOT_FOUND).
 *  - Deleting a key that doesn't exist is a successful no-op (S3/B2
 *    DeleteObjects treat absent keys as deleted), so cleanup remains
 *    idempotent.
 *  - Anything else (auth failure, network failure, 5xx after retries) is
 *    thrown so callers' existing transient-vs-permanent handling (propagate
 *    out of email() for retry vs. handle inline) keeps working unchanged.
 *
 * TEST SEAM: if the environment provides an R2-compatible `ATTACHMENTS`
 * binding (as the vitest-pool-workers suite does via a local Miniflare R2
 * bucket), it is used instead of B2. This keeps the test suite offline and
 * deterministic while exercising the exact same code paths — including
 * fault injection (`tests/transient-failures.test.ts` stubs
 * `ATTACHMENTS.put` to throw). In production the binding is absent and the
 * B2 path is always taken.
 *
 * Note: the D1 column holding object keys is still named `r2_key` (a purely
 * historical name kept to avoid a schema migration — it stores an opaque,
 * storage-agnostic key, and keys are randomly generated, never derived from
 * filenames or addresses).
 */

import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import type { Env } from "../types/index.js";

/** S3 DeleteObjects accepts at most 1000 keys per request (B2 follows this). */
const STORAGE_DELETE_BATCH_SIZE = 1000;

/** B2's Delete Objects requires Content-MD5 (an AWS S3 contract it follows). */
const S3_XML_NAMESPACE = "http://s3.amazonaws.com/doc/2006-03-01/";

/** One stored object, as reported by a listing. */
export interface StoredObjectEntry {
  key: string;
  /** Epoch millis of the last write, used to avoid racing in-flight uploads. */
  lastModified: number;
}

/**
 * One version of a stored object, as reported by a versioned listing.
 *
 * `versionId` is the only handle that can permanently remove the bytes: a
 * key-addressed delete can only ever hide the current version behind a
 * delete marker (see {@link deleteStoredObjects}).
 */
export interface StoredObjectVersion {
  key: string;
  versionId: string;
  /** Epoch millis of this version's upload. */
  lastModified: number;
  /** Byte size; delete markers are 0. */
  size: number;
  /** True for a delete marker rather than a real object version. */
  isDeleteMarker: boolean;
}

/** The operations the attachment pipeline needs from object storage. */
interface AttachmentStorage {
  put(key: string, content: Uint8Array, contentType: string | null): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null } | null>;
  deleteMany(keys: string[]): Promise<void>;
  /** List objects under `prefix`, following pagination, capped at `maxKeys`. */
  list(prefix: string, maxKeys: number): Promise<StoredObjectEntry[]>;
  /**
   * List every stored version under `prefix`, including non-current ones and
   * delete markers, capped at `maxKeys`.
   *
   * R2's test seam has no versioning, so it returns the same shape with the
   * object's own key as its version id — enough for the purge to be exercised
   * without a real B2 bucket.
   */
  listVersions(prefix: string, maxKeys: number): Promise<StoredObjectVersion[]>;
  /** Permanently delete one specific version by id. */
  deleteVersion(version: StoredObjectVersion): Promise<void>;
}

/**
 * Resolve the storage backend: the R2-compatible `ATTACHMENTS` binding if
 * the environment provides one (test/local), otherwise B2's S3-Compatible
 * API (production).
 */
function resolveAttachmentStorage(env: Env): AttachmentStorage {
  if (env.ATTACHMENTS) {
    return r2BindingStorage(env.ATTACHMENTS);
  }
  return b2S3Storage(env);
}

// ---------------------------------------------------------------------------
// R2-compatible adapter (test/local seam only)
// ---------------------------------------------------------------------------

function r2BindingStorage(bucket: NonNullable<Env["ATTACHMENTS"]>): AttachmentStorage {
  return {
    async put(key, content, contentType) {
      await bucket.put(key, content, {
        httpMetadata: contentType ? { contentType } : undefined,
      });
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;
      return {
        body: object.body,
        contentType: object.httpMetadata?.contentType ?? null,
      };
    },
    async deleteMany(keys) {
      if (keys.length > 0) {
        // R2 supports deleting up to 1000 keys per call, same as B2's
        // DeleteObjects; the caller already chunks at that size.
        await bucket.delete(keys);
      }
    },
    async listVersions(prefix, maxKeys) {
      const entries: StoredObjectVersion[] = [];
      let cursor: string | undefined;
      while (entries.length < maxKeys) {
        const page = await bucket.list({
          prefix: prefix || undefined,
          limit: Math.min(1000, maxKeys - entries.length),
          cursor,
        });
        for (const object of page.objects ?? []) {
          entries.push({
            key: object.key,
            // R2 exposes no version ids; the key is a unique handle here
            // because the R2 seam never accumulates non-current versions.
            versionId: object.key,
            lastModified:
              object.uploaded instanceof Date ? object.uploaded.getTime() : Date.now(),
            size: object.size,
            isDeleteMarker: false,
          });
        }
        if (!page.truncated || !page.cursor) break;
        cursor = page.cursor;
      }
      return entries.slice(0, maxKeys);
    },

    async deleteVersion(version) {
      // R2's delete is already unconditional — there is no hidden version
      // left behind — so the version-aware path collapses to a plain delete.
      await bucket.delete([version.key]);
    },

    async list(prefix, maxKeys) {
      const entries: StoredObjectEntry[] = [];
      let cursor: string | undefined;
      while (entries.length < maxKeys) {
        const page = await bucket.list({
          prefix: prefix || undefined,
          limit: Math.min(1000, maxKeys - entries.length),
          cursor,
        });
        for (const object of page.objects ?? []) {
          entries.push({
            key: object.key,
            lastModified:
              object.uploaded instanceof Date ? object.uploaded.getTime() : Date.now(),
          });
        }
        if (!page.truncated || !page.cursor) break;
        cursor = page.cursor;
      }
      return entries.slice(0, maxKeys);
    },
  };
}

// ---------------------------------------------------------------------------
// Backblaze B2 adapter (production backend)
// ---------------------------------------------------------------------------

function b2Client(env: Env): AwsClient {
  return new AwsClient({
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APPLICATION_KEY,
    // B2's S3-Compatible API only accepts v4 signatures; the service string
    // and region must be pinned because B2 endpoints don't follow the AWS
    // `s3.<region>.amazonaws.com` hostname convention aws4fetch parses from.
    service: "s3",
    region: env.B2_REGION,
  });
}

function b2ObjectUrl(env: Env, key: string): string {
  // Path-style: https://s3.<region>.backblazeb2.com/<bucket>/<object-key>
  return `https://s3.${env.B2_REGION}.backblazeb2.com/${env.B2_BUCKET}/${encodeObjectKeyPath(key)}`;
}

/** Percent-encode each key segment (except `/` separators) for a URL path. */
function encodeObjectKeyPath(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function b2S3Storage(env: Env): AttachmentStorage {
  return {
    async put(key, content, contentType) {
      const client = b2Client(env);
      const response = await client.fetch(b2ObjectUrl(env, key), {
        method: "PUT",
        headers: { "Content-Type": contentType ?? "application/octet-stream" },
        body: content,
      });
      if (!response.ok) {
        throw new Error(`B2 PutObject failed for key ${key}: HTTP ${response.status}`);
      }
    },

    async get(key) {
      const client = b2Client(env);
      const response = await client.fetch(b2ObjectUrl(env, key), { method: "GET" });

      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`B2 GetObject failed for key ${key}: HTTP ${response.status}`);
      }
      if (!response.body) {
        throw new Error(`B2 GetObject returned no body for key ${key}`);
      }
      return { body: response.body, contentType: response.headers.get("content-type") };
    },

    async deleteMany(keys) {
      for (let i = 0; i < keys.length; i += STORAGE_DELETE_BATCH_SIZE) {
        await b2DeleteObjectsChunk(env, keys.slice(i, i + STORAGE_DELETE_BATCH_SIZE));
      }
    },

    async listVersions(prefix, maxKeys) {
      const entries: StoredObjectVersion[] = [];
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      while (entries.length < maxKeys) {
        const url = new URL(`https://s3.${env.B2_REGION}.backblazeb2.com/${env.B2_BUCKET}`);
        url.searchParams.set("versions", "");
        if (prefix) url.searchParams.set("prefix", prefix);
        if (keyMarker) url.searchParams.set("key-marker", keyMarker);
        if (versionIdMarker) url.searchParams.set("version-id-marker", versionIdMarker);

        const response = await b2Client(env).fetch(url.toString(), { method: "GET" });
        if (!response.ok) {
          throw new Error(`B2 ListVersions failed: HTTP ${response.status}`);
        }
        const xml = await response.text();
        for (const version of parseVersionListing(xml)) entries.push(version);
        if (entries.length >= maxKeys) break;
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
        const nextKey = xml.match(/<NextKeyMarker>([\s\S]*?)<\/NextKeyMarker>/)?.[1];
        if (nextKey === undefined) break;
        keyMarker = decodeXmlEntities(nextKey);
        versionIdMarker = xml.match(/<NextVersionIdMarker>([\s\S]*?)<\/NextVersionIdMarker>/)?.[1];
      }
      return entries.slice(0, maxKeys);
    },

    async deleteVersion(version) {
      // S3 DeleteObject WITH a version id permanently removes that version,
      // instead of dropping a delete marker over the current one. This is the
      // S3 equivalent of B2's native b2_delete_file_version(fileName, fileId).
      const response = await b2Client(env).fetch(
        `https://s3.${env.B2_REGION}.backblazeb2.com/${env.B2_BUCKET}/${encodeObjectKeyPath(version.key)}` +
          `?versionId=${encodeURIComponent(version.versionId)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        throw new Error(
          `B2 DeleteObject(version) failed for ${version.key}: HTTP ${response.status}`
        );
      }
    },

    async list(prefix, maxKeys) {
      const entries: StoredObjectEntry[] = [];
      let continuationToken: string | undefined;
      while (entries.length < maxKeys) {
        const url = new URL(
          `https://s3.${env.B2_REGION}.backblazeb2.com/${env.B2_BUCKET}`
        );
        url.searchParams.set("list-type", "2");
        if (prefix) url.searchParams.set("prefix", prefix);
        if (continuationToken) url.searchParams.set("continuation-token", continuationToken);

        const response = await b2Client(env).fetch(url.toString(), { method: "GET" });
        if (!response.ok) {
          throw new Error(`B2 ListObjectsV2 failed: HTTP ${response.status}`);
        }
        const xml = await response.text();
        for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const block = match[1];
          if (block === undefined) continue;
          const key = block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
          if (key === undefined) continue;
          const lastModified = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1];
          entries.push({
            key: decodeXmlEntities(key),
            lastModified: lastModified ? Date.parse(lastModified) : 0,
          });
        }
        const truncated = xml.includes("<IsTruncated>true</IsTruncated>");
        continuationToken = xml.match(
          /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/
        )?.[1];
        if (!truncated || !continuationToken) break;
      }
      return entries.slice(0, maxKeys);
    },
  };
}

/**
 * Parse a ListVersions XML document.
 *
 * Entries are either `<Version>` (a real object version) or `<DeleteMarker>`
 * (a tombstone left by a previous key-addressed delete). Both must be
 * returned: purging only the real versions would leave the markers behind,
 * which still count against the bucket's object quota.
 */
export function parseVersionListing(xml: string): StoredObjectVersion[] {
  const versions: StoredObjectVersion[] = [];
  for (const match of xml.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
    const isDeleteMarker = match[1] === "DeleteMarker";
    const block = match[2];
    if (block === undefined) continue;
    const key = block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
    const versionId = block.match(/<VersionId>([\s\S]*?)<\/VersionId>/)?.[1];
    if (key === undefined || versionId === undefined) continue;
    const lastModified = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1];
    const size = block.match(/<Size>(\d+)<\/Size>/)?.[1];
    versions.push({
      key: decodeXmlEntities(key),
      versionId: decodeXmlEntities(versionId),
      lastModified: lastModified ? Date.parse(lastModified) : 0,
      size: size ? Number(size) : 0,
      isDeleteMarker,
    });
  }
  return versions;
}

/**
 * Batch delete via B2's S3 DeleteObjects call. Deleting a nonexistent key
 * is a success (S3 semantics), so cleanup is idempotent.
 */
async function b2DeleteObjectsChunk(env: Env, keys: string[]): Promise<void> {
  if (keys.length === 0) return;

  const body = buildDeleteObjectsXml(keys);
  const client = b2Client(env);
  // Path-style bucket URL with the `?delete` subresource (DeleteObjects).
  const response = await client.fetch(
    `https://s3.${env.B2_REGION}.backblazeb2.com/${env.B2_BUCKET}?delete`,
    {
      method: "POST",
      headers: { "Content-MD5": md5Base64(body) },
      body,
    }
  );

  if (!response.ok) {
    throw new Error(`B2 DeleteObjects failed for ${keys.length} keys: HTTP ${response.status}`);
  }

  // A 200 response can still contain per-key <Error> elements (e.g. an
  // AccessDenied for one key). Quiet mode means any <Error> in the body is
  // a real per-key failure — surface it rather than pretending all keys
  // were deleted.
  const responseText = await response.text();
  if (responseText.includes("<Error>")) {
    throw new Error(`B2 DeleteObjects reported per-key errors for ${keys.length} keys`);
  }
}

function buildDeleteObjectsXml(keys: string[]): string {
  const objectElements = keys.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`).join("");
  // Quiet mode: the response only lists keys that FAILED to delete.
  return (
    `<Delete xmlns="${S3_XML_NAMESPACE}">` + objectElements + "<Quiet>true</Quiet></Delete>"
  );
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Inverse of {@link escapeXml}, for XML values read back out of a listing. */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// Public storage-agnostic API — the only surface the rest of the app uses.
// ---------------------------------------------------------------------------

/**
 * Store an object (attachment bytes). Equivalent to the old
 * `env.ATTACHMENTS.put(key, content, { httpMetadata: { contentType } })`.
 * Throws on failure — callers treat that as a transient storage error.
 */
export async function putStoredObject(
  env: Env,
  key: string,
  content: Uint8Array,
  contentType: string | null
): Promise<void> {
  await resolveAttachmentStorage(env).put(key, content, contentType);
}

/**
 * Fetch an object's streaming body, or `null` if it does not exist (the R2
 * binding's `get()` returned null for missing keys; B2 answers S3-style
 * `NoSuchKey`/404, mapped here to the same outcome). Any other non-OK
 * response throws so unexpected auth/outage conditions stay surfaced as
 * transient storage errors.
 */
export async function getStoredObject(
  env: Env,
  key: string
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null } | null> {
  return resolveAttachmentStorage(env).get(key);
}

/**
 * Delete any number of keys **and every stored version beneath them**.
 *
 * A plain key-addressed delete is NOT enough on B2. Per Backblaze's file
 * versioning rules, deleting an object without a version id only drops a
 * delete marker over the current version: the object disappears from
 * ListObjectsV2 and from HEAD, but the underlying bytes remain stored (and
 * billable) as a non-current version, visible in the B2 console. Nothing
 * else in the app can reach them afterwards, because every deletion path
 * learns keys from D1 rows that are already gone.
 *
 * So this does what `b2_delete_file_version` does — target the exact version
 * id — via the S3 equivalent (`DELETE ?versionId=`). Steps:
 *   1. key-addressed batch delete, so the key stops resolving at all (and so
 *      a brand-new key with no versions is still handled);
 *   2. versioned listing under each deleted key's prefix;
 *   3. a versioned DELETE for every entry found, real versions and delete
 *      markers alike.
 *
 * Idempotent: a key that has nothing left to remove contributes no versions,
 * so repeated cleanup is a no-op.
 */
export async function deleteStoredObjects(env: Env, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const storage = resolveAttachmentStorage(env);
  await storage.deleteMany(keys);
  await purgeAllVersionsOfKeys(storage, keys);
}

/**
 * Permanently remove every version (and delete marker) under the given keys.
 *
 * Keys are deduped by prefix first: versions are discovered by prefix rather
 * than by exact key, because B2's versioned listing has no "this exact key"
 * filter, and sibling objects under a shared prefix must survive.
 */
async function purgeAllVersionsOfKeys(storage: AttachmentStorage, keys: string[]): Promise<void> {
  // Versions can only be discovered by PREFIX, and B2's prefix match is a raw
  // string comparison — NOT path-segment aware. Listing "attachments/m/a/file1"
  // therefore also returns "attachments/m/a/file10" and "attachments/m/a/file11",
  // which may be live attachments belonging to a message that is still in the
  // inbox. So the exact key set is used as a filter and nothing outside it is
  // ever deleted.
  const targetKeys = new Set(keys);
  const prefixes = dedupeKeyPrefixes(keys);
  for (const prefix of prefixes) {
    // Bounded: each pass re-lists because deletions change what comes back.
    // The cap guarantees termination even if a listing keeps returning entries
    // that deletion does not actually remove (e.g. eventual consistency), which
    // would otherwise spin until the Worker's CPU budget is gone.
    for (let pass = 0; pass < VERSION_PURGE_MAX_PASSES; pass++) {
      const batch = await storage.listVersions(prefix, VERSION_PURGE_BATCH_SIZE);
      const targeted = batch.filter((version) => targetKeys.has(version.key));
      for (const version of targeted) {
        await storage.deleteVersion(version);
      }
      // Exhausted when the listing is empty, smaller than the page cap, or
      // contained nothing we were asked to remove.
      if (batch.length < VERSION_PURGE_BATCH_SIZE || targeted.length === 0) break;
    }
  }
}

/**
 * Hard cap on re-listing passes per prefix.
 *
 * A prefix can never hold more than {@link VERSION_PURGE_BATCH_SIZE} entries
 * in a single page, so one pass normally suffices; the extra passes only
 * matter for a pathological bucket. This exists so a stuck listing fails fast
 * instead of burning the Worker's CPU budget.
 */
const VERSION_PURGE_MAX_PASSES = 5;

/** Cap on versions examined per prefix per pass. */
const VERSION_PURGE_BATCH_SIZE = 1000;

/**
 * Reduce keys to the set of prefixes that can be listed.
 *
 * A key may itself be a prefix of another key in the same batch, and
 * listing both would visit the same versions twice. Keeping only prefixes
 * that no other key sits under collapses those duplicates while still
 * covering every affected key.
 */
export function dedupeKeyPrefixes(keys: string[]): string[] {
  const sorted = [...new Set(keys)].sort();
  const prefixes: string[] = [];
  for (const key of sorted) {
    const covered = prefixes.some(
      (prefix) => key === prefix || key.startsWith(`${prefix}/`)
    );
    if (!covered) prefixes.push(key);
  }
  return prefixes;
}

/**
 * List every stored version under `prefix` (at most `maxKeys`), including
 * non-current versions and delete markers.
 *
 * This is the only way to discover the storage an ordinary listing hides, so
 * the cleanup job's orphan sweep uses it: an object that a previous key-only
 * delete already hid is invisible to `listStoredObjects` yet still occupies
 * storage, and would otherwise never be reclaimed.
 */
export async function listStoredObjectVersions(
  env: Env,
  prefix: string,
  maxKeys: number
): Promise<StoredObjectVersion[]> {
  return resolveAttachmentStorage(env).listVersions(prefix, maxKeys);
}

/**
 * Permanently delete one specific version by id.
 *
 * This is the storage-agnostic equivalent of B2's native
 * `b2_delete_file_version(fileName, fileId)`, using the S3 `versionId`
 * parameter, which deletes that exact block of data without leaving a hide
 * marker behind.
 */
export async function deleteStoredObjectVersion(
  env: Env,
  version: StoredObjectVersion
): Promise<void> {
  await resolveAttachmentStorage(env).deleteVersion(version);
}

/**
 * List stored objects under `prefix` (at most `maxKeys`), following
 * pagination. Used by the cleanup job's orphan sweep: a storage object whose
 * owning mailbox no longer exists in D1 has no other way to be discovered,
 * because every other deletion path learns keys by joining D1 rows that are
 * gone by then.
 */
export async function listStoredObjects(
  env: Env,
  prefix: string,
  maxKeys: number
): Promise<StoredObjectEntry[]> {
  return resolveAttachmentStorage(env).list(prefix, maxKeys);
}

// ---------------------------------------------------------------------------
// Content-MD5
// ---------------------------------------------------------------------------

/**
 * Base64 MD5 of a small XML document, for the Content-MD5 header that the
 * S3/B2 DeleteObjects contract requires.
 *
 * This previously used a hand-rolled RFC 1321 implementation, because Web
 * Crypto offers no MD5. That implementation silently produced WRONG digests
 * for most inputs, so B2 rejected every batch delete with
 * `InvalidRequest: Checksum does not match request body`. Because the
 * failure was thrown from `deleteMailboxCascade`, one bad checksum aborted
 * the entire cleanup batch AND left the mailbox's D1 rows in place, so the
 * same expired mailbox was re-selected on every subsequent cron run —
 * wedging attachment deletion permanently.
 *
 * The Worker already enables `nodejs_compat` (see wrangler.toml), so
 * `node:crypto` supplies a correct, native MD5 and ~90 lines of
 * hand-written crypto (and its bug surface) can go away entirely.
 */
function md5Base64(text: string): string {
  const digest = createHash("md5").update(new TextEncoder().encode(text)).digest();
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}
