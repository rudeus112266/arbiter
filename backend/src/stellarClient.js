import { Keypair, TransactionBuilder, Contract, Account, Address, nativeToScVal, scValToNative, rpc } from '@stellar/stellar-sdk';
import { config } from './config.js';

let server = null;
export function getServer() {
  if (!server) {
    server = new rpc.Server(config.sorobanRpcUrl, { allowHttp: config.sorobanRpcUrl.startsWith('http://') });
  }
  return server;
}

let adminKeypair = null;
export function getAdminKeypair() {
  if (!config.platformSecret) throw new Error('PLATFORM_SECRET not configured');
  if (!adminKeypair) adminKeypair = Keypair.fromSecret(config.platformSecret);
  return adminKeypair;
}

export function u64Arg(value) {
  return nativeToScVal(BigInt(value), { type: 'u64' });
}

export function addressArg(address) {
  return new Address(address).toScVal();
}

export function vecOfAddresses(addresses) {
  return nativeToScVal(
    addresses.map((a) => new Address(a)),
    { type: 'Vec' },
  );
}

/** Builds, prepares (simulates + assembles auth/footprint), signs as the
 * platform admin, submits, and polls a contract call. Used ONLY for
 * resolve()/refund() — the backend never signs on behalf of a payer or
 * worker. */
async function invokeAsAdmin(method, scValArgs) {
  const srv = getServer();
  const admin = getAdminKeypair();
  const account = await srv.getAccount(admin.publicKey());
  const contract = new Contract(config.contractId);

  const tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: config.networkPassphrase })
    .addOperation(contract.call(method, ...scValArgs))
    .setTimeout(60)
    .build();

  const prepared = await srv.prepareTransaction(tx);
  prepared.sign(admin);

  const sendResult = await srv.sendTransaction(prepared);
  if (sendResult.status === 'ERROR') {
    throw new Error(`submit failed for ${method}: ${JSON.stringify(sendResult.errorResult ?? sendResult)}`);
  }

  const finalResult = await srv.pollTransaction(sendResult.hash);
  if (finalResult.status !== 'SUCCESS') {
    throw new Error(`${method} transaction ${sendResult.hash} did not succeed: ${finalResult.status}`);
  }
  return { hash: sendResult.hash, result: finalResult };
}

export async function resolveQuestion(questionId, matchingWorkerAddresses, losingWorkerAddresses = []) {
  return invokeAsAdmin('resolve', [
    u64Arg(questionId),
    vecOfAddresses(matchingWorkerAddresses),
    vecOfAddresses(losingWorkerAddresses),
  ]);
}

export async function refundQuestion(questionId) {
  return invokeAsAdmin('refund', [u64Arg(questionId)]);
}

function decodeStatus(raw) {
  // A data-less Rust enum variant decodes to a single-key object, e.g. { pending: true }.
  if (typeof raw === 'string') return raw.toLowerCase();
  if (raw && typeof raw === 'object') return Object.keys(raw)[0]?.toLowerCase();
  return String(raw).toLowerCase();
}

async function simulateReadOnly(method, scValArgs = []) {
  const srv = getServer();
  const contract = new Contract(config.contractId);
  // Simulation-only calls need a source account for a well-formed envelope
  // but never actually sign or submit, so any funded-looking public key works.
  const simSourceKey = config.platformAddress || Keypair.random().publicKey();
  const simSource = new Account(simSourceKey, '0');

  const tx = new TransactionBuilder(simSource, { fee: '100', networkPassphrase: config.networkPassphrase })
    .addOperation(contract.call(method, ...scValArgs))
    .setTimeout(30)
    .build();

  const sim = await srv.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    if (/QuestionNotFound|Error\(Contract, #5\)/.test(sim.error ?? '')) return null;
    throw new Error(`simulation of ${method} failed: ${sim.error}`);
  }
  if (!sim.result?.retval) return null;
  return scValToNative(sim.result.retval);
}

/** Zero-fee simulated read — checks payment state without needing a signature. */
export async function getQuestionOnChain(questionId) {
  const native = await simulateReadOnly('get_question', [u64Arg(questionId)]);
  if (!native) return null;
  return {
    payer: native.payer,
    amount: BigInt(native.amount),
    status: decodeStatus(native.status),
    createdAt: Number(native.created_at),
  };
}

export async function getTimeoutLedgersOnChain() {
  return simulateReadOnly('get_timeout_ledgers');
}

export async function getOwedOnChain(workerAddress) {
  const owed = await simulateReadOnly('get_owed', [addressArg(workerAddress)]);
  return BigInt(owed ?? 0);
}

export async function getStakeOnChain(workerAddress) {
  const stake = await simulateReadOnly('get_stake', [addressArg(workerAddress)]);
  return BigInt(stake ?? 0);
}
