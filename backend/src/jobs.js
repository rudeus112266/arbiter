import { store } from './store.js';
import { config } from './config.js';

const PREFIX = 'job:';

/**
 * Async job record for a paid question. Replaces v1's design of holding the
 * client's HTTP request open for up to QUORUM_TIMEOUT_MS while workers
 * answer — that's fragile against proxies, mobile networks, and
 * serverless/edge request timeouts. Instead POST /oracle's second step
 * returns 202 immediately once payment is confirmed, and the caller polls
 * GET /oracle/:jobId (or listens on its SSE stream) for the result.
 *
 * States: awaiting_workers -> reconciling -> settled
 * `settled` always carries an `outcome` of 'resolved' or 'refunded' — same
 * fail-closed guarantee as before, just observed asynchronously.
 */

export async function createJob(jobId, initial) {
  const record = {
    status: 'awaiting_workers',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...initial,
  };
  await store.set(PREFIX + jobId, record, config.jobResultTtlMs);
  return record;
}

export async function updateJob(jobId, patch) {
  const key = PREFIX + jobId;
  const current = (await store.get(key)) || {};
  const next = { ...current, ...patch, updatedAt: Date.now() };
  await store.set(key, next, config.jobResultTtlMs);
  return next;
}

export async function getJob(jobId) {
  return store.get(PREFIX + jobId);
}
