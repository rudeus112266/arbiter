import 'dotenv/config';
import { env, sleep } from './lib/stellar.js';

/**
 * The zero-setup version of ask.js: no DEMO_PAYER_SECRET, no testnet USDC,
 * no chain interaction at all. Proves the sandbox flow end to end and
 * doubles as a copy-paste starting point for someone evaluating the API
 * before they've decided to set up a real wallet.
 */
const question = process.argv.slice(2).join(' ') || 'What is the capital of France?';
const simulate = process.env.SANDBOX_SIMULATE; // 'resolved' | 'disagreement' | 'no-answers'

async function pollJob(jobId, { intervalMs = 300, timeoutMs = 15_000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${env.backendUrl}/oracle/${jobId}`);
    const job = await res.json();
    if (job.status === 'settled') return job;
    process.stdout.write(`  … status=${job.status}\r`);
    await sleep(intervalMs);
  }
  throw new Error(`job ${jobId} did not settle within ${timeoutMs}ms`);
}

async function main() {
  console.log(`Asking (sandbox — free, no wallet, no chain): "${question}"`);

  const res = await fetch(`${env.backendUrl}/oracle/sandbox`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, simulate }),
  });
  if (res.status !== 202) {
    throw new Error(`expected 202, got ${res.status}: ${JSON.stringify(await res.json())}`);
  }
  const { jobId, statusUrl } = await res.json();
  console.log(`✓ Sandbox job started: ${jobId} (poll ${statusUrl})`);

  const job = await pollJob(jobId);
  console.log();

  if (job.outcome === 'resolved') {
    console.log(`✓ RESOLVED (sandbox) — answer: "${job.answer}" (confidence ${job.confidence})`);
    console.log(`  Fake payout tx: ${job.payoutTx}`);
  } else {
    console.log(`✓ REFUNDED (sandbox) — reason: ${job.reason}`);
    console.log(`  Fake refund tx: ${job.refundTx}`);
  }
  console.log('\nNothing here touched real funds or a real chain. Set DEMO_PAYER_SECRET and');
  console.log('run ask.js instead once you\'re ready to try the real, on-chain flow.');
}

main().catch((err) => {
  console.error('\nsandbox-ask.js failed:', err.message);
  process.exit(1);
});
