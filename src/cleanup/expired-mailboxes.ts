import type { Env } from "../types/index.js";
import { loadConfig } from "../types/index.js";
import { deleteMailboxCascade, findExpiredMailboxes } from "../db/mailboxes.js";
import { deleteStoredObjects, listStoredObjects } from "../lib/b2.js";
import { cleanupExpiredRateLimitWindows } from "../lib/rate-limit.js";

/** Every attachment key lives under this prefix; the next segment is the mailbox id. */
const ATTACHMENT_KEY_PREFIX = "attachments/";

/**
 * Only sweep objects older than this. A freshly uploaded object whose mailbox
 * row exists is protected by the mailbox check below anyway, but the age guard
 * means a sweep can never race a delivery that is mid-flight.
 */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/** Cap on objects examined per run, so a large backlog cannot blow the CPU budget. */
const ORPHAN_SCAN_LIMIT = 5000;

/** D1 caps bound parameters per statement; keep each IN () clause small. */
const D1_IN_CLAUSE_CHUNK = 50;

export interface CleanupResult {
  mailboxesDeleted: number;
  /** Mailboxes whose cascade failed this run; retried on the next run. */
  mailboxesFailed: number;
  rateLimitWindowsDeleted: number;
  /** Orphaned storage objects deleted this run. */
  orphanedObjectsDeleted: number;
}

/**
 * Delete attachment objects whose owning mailbox no longer exists in D1.
 *
 * Every other deletion path learns which keys to delete by joining D1 rows
 * (deleteMailboxCascade, single-message delete). Once those rows are gone —
 * deleted outright, or lost to a cascade whose storage delete failed — the
 * key is unreachable: no cron run, retry, or re-run of any kind can rediscover
 * it, so the object stays in B2 forever.
 *
 * This sweeps storage directly and cross-checks each key's mailbox id against
 * D1. Keys belonging to a mailbox that still exists are never touched, so live
 * attachments are safe.
 */
export async function sweepOrphanedAttachments(
  env: Env,
  options: { minAgeMs?: number } = {}
): Promise<number> {
  const minAgeMs = options.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const entries = await listStoredObjects(env, ATTACHMENT_KEY_PREFIX, ORPHAN_SCAN_LIMIT);
  if (entries.length === 0) return 0;

  const cutoff = Date.now() - minAgeMs;
  const keysByMailbox = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.lastModified > cutoff) continue;
    const mailboxId = entry.key.slice(ATTACHMENT_KEY_PREFIX.length).split("/")[0];
    if (!mailboxId) continue;
    const keys = keysByMailbox.get(mailboxId);
    if (keys) keys.push(entry.key);
    else keysByMailbox.set(mailboxId, [entry.key]);
  }
  if (keysByMailbox.size === 0) return 0;

  const mailboxIds = [...keysByMailbox.keys()];
  const liveMailboxIds = new Set<string>();
  for (let i = 0; i < mailboxIds.length; i += D1_IN_CLAUSE_CHUNK) {
    const chunk = mailboxIds.slice(i, i + D1_IN_CLAUSE_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT id FROM mailboxes WHERE id IN (${placeholders})`
    )
      .bind(...chunk)
      .all<{ id: string }>();
    for (const row of rows.results ?? []) liveMailboxIds.add(row.id);
  }

  const orphaned: string[] = [];
  for (const [mailboxId, keys] of keysByMailbox) {
    if (!liveMailboxIds.has(mailboxId)) orphaned.push(...keys);
  }
  if (orphaned.length === 0) return 0;

  await deleteStoredObjects(env, orphaned);
  return orphaned.length;
}

/**
 * Runs one bounded batch of expired-mailbox cleanup. Safe to invoke
 * repeatedly (idempotent): a mailbox that was already deleted simply won't
 * appear in the next `findExpiredMailboxes` batch, and deleting a storage
 * object key that no longer exists is a no-op rather than an error.
 *
 * Cloudflare Cron Triggers invoke this hourly (see wrangler.toml); a single
 * invocation only processes `CLEANUP_BATCH_SIZE` mailboxes so an unusually
 * large backlog cannot blow the Worker's CPU/time budget in one run — the
 * next scheduled run picks up where this one left off.
 *
 * A per-mailbox failure is isolated rather than allowed to abort the batch.
 * This matters a lot in practice: `findExpiredMailboxes` always returns the
 * OLDEST expired rows first, so a mailbox whose cascade keeps throwing (a
 * storage outage, a bad object key) would otherwise be re-selected first on
 * every single subsequent run, throwing again each time and permanently
 * starving every other expired mailbox behind it. On failure we log the
 * mailbox and move on — crucially we also do NOT delete its D1 rows, since
 * those rows are the only record of which storage keys still need removing;
 * dropping them would orphan the objects with no way left to find them.
 */
export async function runExpiredMailboxCleanup(env: Env): Promise<CleanupResult> {
  const config = loadConfig(env);
  const expired = await findExpiredMailboxes(env, config.cleanupBatchSize);

  let mailboxesDeleted = 0;
  let mailboxesFailed = 0;

  for (const mailbox of expired) {
    try {
      await deleteMailboxCascade(env, mailbox.id);
      mailboxesDeleted++;
    } catch (err) {
      mailboxesFailed++;
      console.error(
        JSON.stringify({
          level: "error",
          job: "cleanup",
          event: "mailbox-cascade-failed",
          mailboxId: mailbox.id,
          address: mailbox.address,
          message: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  // Opportunistic housekeeping for the rate-limit table; keep windows for a
  // day so short bursts of abuse remain visible for debugging, then sweep.
  const rateLimitWindowsDeleted = await cleanupExpiredRateLimitWindows(env, 24 * 60 * 60 * 1000);

  // Reclaim storage objects that no longer have an owning mailbox row. Run
  // last and isolate failures: a sweep problem must never undo the mailbox
  // deletions that already succeeded.
  let orphanedObjectsDeleted = 0;
  try {
    orphanedObjectsDeleted = await sweepOrphanedAttachments(env);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        job: "cleanup",
        event: "orphan-sweep-failed",
        message: err instanceof Error ? err.message : String(err),
      })
    );
  }

  return { mailboxesDeleted, mailboxesFailed, rateLimitWindowsDeleted, orphanedObjectsDeleted };
}