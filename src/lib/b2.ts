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

/** The operations the attachment pipeline needs from object storage. */
interface AttachmentStorage {
  put(key: string, content: Uint8Array, contentType: string | null): Promise<void>;
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; contentType: string | null } | null>;
  deleteMany(keys: string[]): Promise<void>;
  /** List objects under `prefix`, following pagination, capped at `maxKeys`. */
  list(prefix: string, maxKeys: number): Promise<StoredObjectEntry[]>;
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
 * Delete any number of keys (chunked at the 1000-keys-per-call limit both
 * R2's batch delete and B2's DeleteObjects accept). Deleting a key that
 * doesn't exist is a no-op, so cleanup is idempotent.
 */
export async function deleteStoredObjects(env: Env, keys: string[]): Promise<void> {
  await resolveAttachmentStorage(env).deleteMany(keys);
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
