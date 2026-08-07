import 'dotenv/config';
import { Keypair, TransactionBuilder, Contract, Address, nativeToScVal, rpc } from '@stellar/stellar-sdk';

export const env = {
  backendUrl: process.env.BACKEND_URL || 'http://localhost:4000',
  sorobanRpcUrl: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
  horizonUrl: process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',
  networkPassphrase: process.env.NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  contractId: process.env.ORACLE_CONTRACT_ID || '',
  usdcCode: process.env.USDC_ASSET_CODE || 'USDC',
  usdcIssuer: process.env.USDC_ASSET_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  timeoutLedgers: Number(process.env.TIMEOUT_LEDGERS || 100),
};

let server = null;
export function getServer() {
  if (!server) server = new rpc.Server(env.sorobanRpcUrl, { allowHttp: env.sorobanRpcUrl.startsWith('http://') });
  return server;
}

export function explorerTxLink(hash) {
  const net = env.networkPassphrase.includes('Public') ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${net}/tx/${hash}`;
}

export function u64Arg(value) {
  return nativeToScVal(BigInt(value), { type: 'u64' });
}

export function i128Arg(value) {
  return nativeToScVal(BigInt(value), { type: 'i128' });
}

export function addressArg(address) {
  return new Address(address).toScVal();
}

/** Signs and submits a submit(payer, questionId, amountStroops) call directly
 * from the payer's own key (no fee sponsorship) — used by ask.js, which
 * simulates a funded browser wallet. */
export async function submitPaymentDirect(payerKeypair, questionId, amountStroops) {
  const srv = getServer();
  const account = await srv.getAccount(payerKeypair.publicKey());
  const contract = new Contract(env.contractId);

  const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: env.networkPassphrase })
    .addOperation(
      contract.call('submit', addressArg(payerKeypair.publicKey()), u64Arg(questionId), i128Arg(amountStroops)),
    )
    .setTimeout(60)
    .build();

  const prepared = await srv.prepareTransaction(tx);
  prepared.sign(payerKeypair);

  const sendResult = await srv.sendTransaction(prepared);
  if (sendResult.status === 'ERROR') {
    throw new Error(`submit() failed to send: ${JSON.stringify(sendResult.errorResult ?? sendResult)}`);
  }
  const final = await srv.pollTransaction(sendResult.hash);
  if (final.status !== 'SUCCESS') {
    throw new Error(`submit() transaction ${sendResult.hash} did not succeed: ${final.status}`);
  }
  return sendResult.hash;
}

/** Builds a signed-but-not-submitted submit() transaction XDR for a payer
 * with zero XLM — the network fee is paid by the backend via /sponsor/pay's
 * fee-bump, so this transaction is built with a nominal fee that the payer
 * never actually spends. */
export async function buildSignedSubmitXdr(payerKeypair, questionId, amountStroops) {
  const srv = getServer();
  const account = await srv.getAccount(payerKeypair.publicKey());
  const contract = new Contract(env.contractId);

  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: env.networkPassphrase })
    .addOperation(
      contract.call('submit', addressArg(payerKeypair.publicKey()), u64Arg(questionId), i128Arg(amountStroops)),
    )
    .setTimeout(60)
    .build();

  const prepared = await srv.prepareTransaction(tx);
  prepared.sign(payerKeypair);
  return prepared.toXDR();
}

/** Builds a signed-but-not-submitted stake(worker, amountStroops) transaction
 * XDR — relayed through /sponsor/stake so a zero-XLM worker can stake. */
export async function buildSignedStakeXdr(workerKeypair, amountStroops) {
  const srv = getServer();
  const account = await srv.getAccount(workerKeypair.publicKey());
  const contract = new Contract(env.contractId);

  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: env.networkPassphrase })
    .addOperation(contract.call('stake', addressArg(workerKeypair.publicKey()), i128Arg(amountStroops)))
    .setTimeout(60)
    .build();

  const prepared = await srv.prepareTransaction(tx);
  prepared.sign(workerKeypair);
  return prepared.toXDR();
}

/** Builds a signed-but-not-submitted withdraw(worker) transaction XDR —
 * relayed through /sponsor/withdraw so a zero-XLM worker can collect their
 * accrued earnings without ever holding a stroop of XLM. */
export async function buildSignedWithdrawXdr(workerKeypair) {
  const srv = getServer();
  const account = await srv.getAccount(workerKeypair.publicKey());
  const contract = new Contract(env.contractId);

  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: env.networkPassphrase })
    .addOperation(contract.call('withdraw', addressArg(workerKeypair.publicKey())))
    .setTimeout(60)
    .build();

  const prepared = await srv.prepareTransaction(tx);
  prepared.sign(workerKeypair);
  return prepared.toXDR();
}

/** Directly invokes the contract's permissionless refund_timeout(question_id)
 * — no signature required at all, proving anyone can call it. Used as the
 * fallback path when a payer doesn't want to (or can't) trust the backend to
 * ever call refund() on their behalf. */
export async function callRefundTimeoutPermissionless(questionId) {
  const srv = getServer();
  // Any funded account can be the fee-paying source of this call; it does
  // NOT need to be the original payer, and require_auth() is never invoked
  // by the contract for this method — that's the entire point.
  const callerKeypair = Keypair.fromSecret(process.env.DEMO_PAYER_SECRET);
  const account = await srv.getAccount(callerKeypair.publicKey());
  const contract = new Contract(env.contractId);

  const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: env.networkPassphrase })
    .addOperation(contract.call('refund_timeout', u64Arg(questionId)))
    .setTimeout(60)
    .build();

  const prepared = await srv.prepareTransaction(tx);
  prepared.sign(callerKeypair); // signs to pay the fee, NOT as required auth for the contract call
  const sendResult = await srv.sendTransaction(prepared);
  if (sendResult.status === 'ERROR') {
    throw new Error(`refund_timeout() failed to send: ${JSON.stringify(sendResult.errorResult ?? sendResult)}`);
  }
  const final = await srv.pollTransaction(sendResult.hash);
  if (final.status !== 'SUCCESS') {
    throw new Error(`refund_timeout() transaction did not succeed: ${final.status}`);
  }
  return sendResult.hash;
}

export async function getLatestLedgerSequence() {
  const info = await getServer().getLatestLedger();
  return info.sequence;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
