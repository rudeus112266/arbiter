import {
  StellarWalletsKit,
  WalletNetwork,
  FreighterModule,
  LobstrModule,
  xBullModule,
  HanaModule,
  AlbedoModule,
  HotWalletModule,
} from '@creit.tech/stellar-wallets-kit';
import { createOrLoadLocalWallet } from './localWallet.js';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

// Same hand-picked module list as the worker console — see main.js.
const kit = new StellarWalletsKit({
  network: WalletNetwork.TESTNET,
  modules: [new FreighterModule(), new LobstrModule(), new xBullModule(), new HanaModule(), new AlbedoModule(), new HotWalletModule()],
});

const el = {
  connect: document.getElementById('panel-connect'),
  dashboard: document.getElementById('panel-dashboard'),
  btnConnect: document.getElementById('btn-connect'),
  btnQuickStart: document.getElementById('btn-quick-start'),
  btnRefresh: document.getElementById('btn-refresh'),
  payerAddress: document.getElementById('payer-address'),
  statSpend: document.getElementById('stat-spend'),
  statCount: document.getElementById('stat-count'),
  statSuccess: document.getElementById('stat-success'),
  questionList: document.getElementById('question-list'),
  log: document.getElementById('log'),
};

const state = { address: null };

function log(message) {
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  el.log.prepend(li);
}

function setConnectButtonsBusy(busy) {
  el.btnConnect.disabled = busy;
  el.btnQuickStart.disabled = busy;
}

el.btnConnect.addEventListener('click', async () => {
  setConnectButtonsBusy(true);
  try {
    await kit.openModal({
      onWalletSelected: async (option) => {
        kit.setWallet(option.id);
        const { address } = await kit.getAddress();
        await activate(address);
      },
      onClosed: (err) => {
        setConnectButtonsBusy(false);
        if (err) log(`Wallet selection closed: ${err.message}`);
      },
    });
  } catch (err) {
    setConnectButtonsBusy(false);
    log(`Wallet connect failed: ${err.message}`);
  }
});

el.btnQuickStart.addEventListener('click', async () => {
  setConnectButtonsBusy(true);
  try {
    const { address } = await createOrLoadLocalWallet().getAddress();
    await activate(address);
  } catch (err) {
    setConnectButtonsBusy(false);
    log(`Quick start failed: ${err.message}`);
  }
});

async function activate(address) {
  state.address = address;
  el.payerAddress.textContent = address;
  el.connect.classList.add('hidden');
  el.dashboard.classList.remove('hidden');
  log(`Connected ${address}`);
  await loadQuestions();
  setConnectButtonsBusy(false);
}

el.btnRefresh.addEventListener('click', loadQuestions);

async function loadQuestions() {
  if (!state.address) return;
  el.btnRefresh.disabled = true;
  try {
    const res = await fetch(`${BACKEND_URL}/payers/${state.address}/questions`);
    if (!res.ok) throw new Error(`unexpected status ${res.status}`);
    const data = await res.json();
    render(data);
    log(`Loaded ${data.questions.length} question(s) — this address has asked ${data.totalTracked} total.`);
  } catch (err) {
    log(`Could not load questions: ${err.message}`);
  } finally {
    el.btnRefresh.disabled = false;
  }
}

function render(data) {
  el.statSpend.textContent = `${data.totalSpend} USDC`;
  el.statCount.textContent = String(data.totalTracked);
  el.statSuccess.textContent = data.successRate === null ? '—' : `${Math.round(data.successRate * 100)}%`;

  el.questionList.innerHTML = '';
  if (data.questions.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted small';
    li.textContent = 'No questions yet.';
    el.questionList.appendChild(li);
    return;
  }

  for (const q of data.questions) {
    el.questionList.appendChild(renderQuestionItem(q));
  }
}

function renderQuestionItem(q) {
  const li = document.createElement('li');
  li.className = 'question-item';

  const row = document.createElement('div');
  row.className = 'row';

  const left = document.createElement('div');
  const qText = document.createElement('p');
  qText.className = 'q-text';
  qText.textContent = q.question || q.questionId;
  const qMeta = document.createElement('div');
  qMeta.className = 'q-meta';
  const parts = [q.tier, q.amount ? `${q.amount} USDC` : null];
  if (q.status === 'settled' && q.outcome === 'resolved') parts.push(`confidence ${q.confidence}`);
  qMeta.textContent = parts.filter(Boolean).join(' · ');
  left.append(qText, qMeta);

  const badge = document.createElement('span');
  const { label, cls } = describeStatus(q);
  badge.className = `badge ${cls}`;
  badge.textContent = label;

  row.append(left, badge);
  li.appendChild(row);
  return li;
}

function describeStatus(q) {
  if (q.status !== 'settled') return { label: 'in progress', cls: 'badge-pending' };
  if (q.outcome === 'resolved') return { label: 'resolved', cls: 'badge-resolved' };
  return { label: 'refunded', cls: 'badge-refunded' };
}
