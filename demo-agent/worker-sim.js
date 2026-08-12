import 'dotenv/config';
import { Agent } from 'undici';
import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { env, buildSignedStakeXdr, buildSignedWithdrawXdr, sleep } from './lib/stellar.js';

/**
 * The SSE connection (`GET /app/events`) is deliberately never fully
 * consumed — that's the whole point of a dispatch channel, it stays open
 * for the life of the process. Node's global fetch dispatcher pools
 * connections per origin, and a real, reproduced bug against a real hosted
 * deployment (Railway) showed that a permanently-open streaming GET can
 * starve a same-origin POST issued later from the SAME process — the
 * answer request never even reached the server, confirmed via server-side
 * logs showing zero incoming requests for it, while the SSE stream stayed
 * healthy. Giving the SSE connection its own isolated Agent (its own
 * connection pool) means every other fetch() in this file — session,
 * answer, stake, withdraw — keeps using the default dispatcher and can
 * never be blocked behind it, regardless of how the origin's proxy
 * layer handles long-lived streams.
 */
const sseAgent = new Agent();

// If WORKER_SECRET is set, this worker signs with a real Stellar keypair
// (its address becomes the workerId), which unlocks the optional
// staking/auto-withdraw demonstration below. Without it, workerId is just
// an arbitrary string, matching the original simpler usage — fine for
// exercising dispatch/reconciliation, but staking/withdraw need a real
// signable address since they're on-chain, worker-authorized calls.
const workerKeypair = process.env.WORKER_SECRET ? Keypair.fromSecret(process.env.WORKER_SECRET) : null;
const workerId = workerKeypair ? workerKeypair.publicKey() : process.env.WORKER_ID || `demo-worker-${Date.now()}`;
const fixedAnswer = process.env.WORKER_ANSWER || '42';
const categories = (process.env.WORKER_CATEGORIES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const doStake = process.env.DO_STAKE === 'true';
const stakeAmountStroops = BigInt(process.env.STAKE_AMOUNT_STROOPS || '1000000');
const autoWithdraw = process.env.AUTO_WITHDRAW === 'true';
const withdrawIntervalMs = Number(process.env.WITHDRAW_INTERVAL_MS || 30_000);

/** Reproduces exactly what the browser app does at the protocol level
 * without a browser: fetch() the SSE endpoint and manually parse the
 * `event:`/`data:` frame format out of the streamed body. There is no
 * EventSource client here on purpose — this proves the wire protocol works
 * for any HTTP client, not just browsers with EventSource support. */
async function* sseFrames(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const rawFrame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      yield parseFrame(rawFrame);
    }
  }
}

function parseFrame(rawFrame) {
  let event = 'message';
  const dataLines = [];
  for (const line of rawFrame.split('\n')) {
    if (line.startsWith(':')) continue; // keep-alive comment
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  return { event, data: dataLines.join('\n') };
}

/** Cached bearer session — see workerAuth.js on the backend. A real
 * address workerId now REQUIRES this for both /app/events and
 * /app/answer; the plain test-string workerId convenience (no
 * WORKER_SECRET) still needs no auth at all. */
let sessionToken = null;

async function ensureSession() {
  if (!workerKeypair) return null; // plain test-string id — no auth required or possible
  if (sessionToken) return sessionToken;

  const challengeRes = await fetch(`${env.backendUrl}/workers/${workerId}/session/challenge`, { method: 'POST' });
  if (!challengeRes.ok) throw new Error(`session challenge failed: ${challengeRes.status} ${await challengeRes.text()}`);
  const { xdr } = await challengeRes.json();

  const tx = new Transaction(xdr, env.networkPassphrase);
  tx.sign(workerKeypair);

  const sessionRes = await fetch(`${env.backendUrl}/workers/${workerId}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedXdr: tx.toXDR() }),
  });
  if (!sessionRes.ok) throw new Error(`session establish failed: ${sessionRes.status} ${await sessionRes.text()}`);
  const { token } = await sessionRes.json();
  sessionToken = token;
  console.log(`[${workerId}] session established (proved control of this address)`);
  return token;
}

async function answerQuestion(payload) {
  const { questionId, question } = JSON.parse(payload);
  console.log(`[${workerId}] question ${questionId}: "${question}" — answering "${fixedAnswer}"`);

  const res = await fetch(`${env.backendUrl}/app/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId, workerId, answer: fixedAnswer, token: sessionToken }),
  });

  if (res.status === 409) {
    console.log(`[${workerId}] question ${questionId} was already closed/expired by the time we answered`);
  } else if (!res.ok) {
    console.error(`[${workerId}] answer submission failed: ${res.status} ${await res.text()}`);
  } else {
    console.log(`[${workerId}] answer accepted for question ${questionId}`);
  }
}

/** Optional credibility bond, staked via the sponsored fee-bump relay so
 * this worker never needs to hold XLM. Purely a demonstration of the
 * staking flow — answering and getting paid work identically whether or
 * not a worker has staked. */
async function stakeIfRequested() {
  if (!doStake) return;
  if (!workerKeypair) throw new Error('DO_STAKE=true requires WORKER_SECRET to be set (staking needs a signable address)');

  console.log(`[${workerId}] staking ${stakeAmountStroops} stroops…`);
  const xdr = await buildSignedStakeXdr(workerKeypair, stakeAmountStroops);
  const res = await fetch(`${env.backendUrl}/sponsor/stake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xdr, workerAddress: workerId, amountStroops: stakeAmountStroops.toString() }),
  });
  if (!res.ok) throw new Error(`stake failed: ${res.status} ${await res.text()}`);
  const { hash } = await res.json();
  console.log(`[${workerId}] staked (tx ${hash})`);
}

/**
 * Demonstrates the "streaming settlement" model end to end: rather than
 * being paid the instant an answer matches consensus, this worker's share
 * accrues in the contract's Owed balance across every resolved question,
 * and gets swept into a single withdraw() transaction periodically — one
 * network fee for however many questions were answered in between, instead
 * of one per question.
 */
async function autoWithdrawLoop() {
  if (!autoWithdraw) return;
  if (!workerKeypair) throw new Error('AUTO_WITHDRAW=true requires WORKER_SECRET to be set (withdraw needs a signable address)');

  for (;;) {
    await sleep(withdrawIntervalMs);
    try {
      const owedRes = await fetch(`${env.backendUrl}/workers/${workerId}/owed`);
      const { owedStroops, owed } = await owedRes.json();
      if (BigInt(owedStroops) <= 0n) continue;

      console.log(`[${workerId}] ${owed} USDC accrued — withdrawing…`);
      const xdr = await buildSignedWithdrawXdr(workerKeypair);
      const res = await fetch(`${env.backendUrl}/sponsor/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ xdr, workerAddress: workerId }),
      });
      if (!res.ok) throw new Error(`withdraw failed: ${res.status} ${await res.text()}`);
      const { hash } = await res.json();
      console.log(`[${workerId}] withdrew ${owed} USDC (tx ${hash})`);
    } catch (err) {
      console.error(`[${workerId}] auto-withdraw check failed:`, err.message);
    }
  }
}

async function main() {
  const token = await ensureSession();
  await stakeIfRequested();
  autoWithdrawLoop().catch((err) => console.error(`[${workerId}] auto-withdraw loop crashed:`, err.message));

  const qs = new URLSearchParams({ worker: workerId });
  if (categories.length) qs.set('categories', categories.join(','));
  if (token) qs.set('token', token);

  console.log(`[${workerId}] connecting to ${env.backendUrl}/app/events?${qs} …`);
  const response = await fetch(`${env.backendUrl}/app/events?${qs.toString()}`, { dispatcher: sseAgent });
  if (!response.ok) throw new Error(`SSE connect failed: ${response.status}`);

  for await (const frame of sseFrames(response)) {
    if (frame.event === 'connected') {
      console.log(`[${workerId}] connected — dispatch channel live`);
    } else if (frame.event === 'question') {
      answerQuestion(frame.data).catch((err) => console.error(`[${workerId}] error answering:`, err.message));
    }
  }

  console.log(`[${workerId}] dispatch channel closed`);
}

main().catch((err) => {
  console.error('worker-sim.js failed:', err.message);
  process.exit(1);
});
