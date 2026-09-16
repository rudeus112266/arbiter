const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';
const TOKEN_KEY = 'arbiter-admin-token';

function truncateAddress(id) {
  if (!id || id.length <= 16 || !id.startsWith('G')) return id || '—';
  return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

function formatRatio(ratio) {
  return ratio === null || ratio === undefined ? '—' : `${(ratio * 100).toFixed(1)}%`;
}

async function fetchAdmin(path) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    showLogin('That token was rejected — try again.');
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(`backend returned ${res.status}`);
  return res.json();
}

function showLogin(message = '') {
  document.getElementById('panel-login').classList.remove('hidden');
  document.getElementById('admin-shell').classList.add('hidden');
  document.getElementById('admin-login-status').textContent = message;
}

function showShell() {
  document.getElementById('panel-login').classList.add('hidden');
  document.getElementById('admin-shell').classList.remove('hidden');
}

// ---------------------------------------------------------------------
// Per-view renderers. Each is loaded lazily the first time its nav item
// is selected, so opening the console doesn't fire five requests at once.
// ---------------------------------------------------------------------

const loaded = new Set();

async function renderOverview() {
  const [{ resolvedCount, totalFeeRevenue }, treasury, workers, payers] = await Promise.all([
    fetchAdmin('/admin/fees'),
    fetchAdmin('/admin/treasury'),
    fetchAdmin('/admin/workers'),
    fetchAdmin('/admin/payers'),
  ]);
  document.getElementById('ov-fees').textContent = `${totalFeeRevenue} USDC (${resolvedCount})`;
  document.getElementById('ov-treasury-usdc').textContent = treasury.configured ? `${treasury.usdcBalance}` : 'not configured';
  document.getElementById('ov-treasury-xlm').textContent = treasury.configured ? `${treasury.xlmBalance}` : 'not configured';
  document.getElementById('ov-workers').textContent = workers.workers.length;
  document.getElementById('ov-payers').textContent = payers.payers.length;
}

async function renderTransactions() {
  const tbody = document.getElementById('tx-body');
  const { transactions } = await fetchAdmin('/admin/transactions?limit=100');
  if (transactions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted small">No transactions yet.</td></tr>';
    return;
  }
  tbody.innerHTML = transactions
    .map(
      (t) => `
    <tr>
      <td title="${t.questionId}">${truncateAddress(String(t.questionId))}</td>
      <td title="${t.payer || ''}">${truncateAddress(t.payer)}</td>
      <td>${t.amountStroops ? (Number(t.amountStroops) / 1e7).toFixed(2) : '—'} USDC</td>
      <td><span class="badge badge-${t.status === 'settled' ? 'resolved' : 'pending'}">${t.status || '—'}</span></td>
      <td>${t.outcome || '—'}</td>
      <td class="muted small">${t.createdAt ? new Date(t.createdAt).toLocaleString() : '—'}</td>
    </tr>`,
    )
    .join('');
}

async function renderWorkers() {
  const tbody = document.getElementById('workers-body');
  const { workers } = await fetchAdmin('/admin/workers');
  if (workers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted small">No workers recorded yet.</td></tr>';
    return;
  }
  tbody.innerHTML = workers
    .map(
      (w) => `
    <tr>
      <td title="${w.workerId}">${truncateAddress(w.workerId)}</td>
      <td>${formatRatio(w.matchRatio)}</td>
      <td>${w.totalAnswers}</td>
      <td>${w.established ? 'yes' : 'no'}</td>
      <td>${w.stake} USDC</td>
      <td>${w.owed} USDC</td>
    </tr>`,
    )
    .join('');
}

async function renderPayers() {
  const tbody = document.getElementById('payers-body');
  const { payers } = await fetchAdmin('/admin/payers');
  if (payers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted small">No payers recorded yet.</td></tr>';
    return;
  }
  tbody.innerHTML = payers
    .map(
      (p) => `
    <tr>
      <td title="${p.payerAddress}">${truncateAddress(p.payerAddress)}</td>
      <td>${p.totalSpend} USDC</td>
      <td>${p.totalTracked}</td>
      <td>${p.settled}</td>
      <td>${formatRatio(p.successRate)}</td>
    </tr>`,
    )
    .join('');
}

async function renderFees() {
  const { resolvedCount, totalFeeRevenue } = await fetchAdmin('/admin/fees');
  document.getElementById('fees-count').textContent = resolvedCount;
  document.getElementById('fees-total').textContent = totalFeeRevenue;
}

async function renderTreasury() {
  const panel = document.getElementById('treasury-panel');
  const treasury = await fetchAdmin('/admin/treasury');
  if (!treasury.configured) {
    panel.innerHTML = '<p class="muted small">PLATFORM_ADDRESS is not configured on the backend.</p>';
    return;
  }
  panel.innerHTML = `
    <p>Platform address: <span title="${treasury.platformAddress}">${truncateAddress(treasury.platformAddress)}</span></p>
    <p>USDC balance: <strong>${treasury.usdcBalance}</strong></p>
    <p>XLM balance: <strong>${treasury.xlmBalance}</strong> (network fee reserve)</p>
    <p class="muted small">Read live from Horizon — this is where resolve() sends its platform fee cut directly, so it's independently verifiable on-chain.</p>
    ${
      treasury.fiatPool
        ? `<hr />
    <p>Fiat pool address: <span title="${treasury.fiatPool.address}">${truncateAddress(treasury.fiatPool.address)}</span></p>
    <p>USDC balance: <strong>${treasury.fiatPool.usdcBalance}</strong></p>
    <p class="muted small">Backs every API-key/Stripe question (billing.js) — watch this for low-float 503s before customers hit them.</p>`
        : '<hr /><p class="muted small">Fiat pool not configured (FIAT_POOL_ADDRESS unset) — the API-key onramp is disabled.</p>'
    }
  `;
}

function renderBlockchain() {
  const panel = document.getElementById('blockchain-panel');
  panel.innerHTML = `
    <p class="muted small">Static config this backend was started with — not a live query.</p>
    <p>Backend: <span class="muted small">${BACKEND_URL}</span></p>
  `;
}

async function renderFraud() {
  const tbody = document.getElementById('fraud-body');
  const { workers } = await fetchAdmin('/admin/workers');
  const flagged = workers
    .filter((w) => w.established && w.matchRatio !== null)
    .sort((a, b) => a.matchRatio - b.matchRatio);
  if (flagged.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted small">No established workers yet.</td></tr>';
    return;
  }
  tbody.innerHTML = flagged
    .map(
      (w) => `
    <tr>
      <td title="${w.workerId}">${truncateAddress(w.workerId)}</td>
      <td>${formatRatio(w.matchRatio)}</td>
      <td>${w.totalAnswers}</td>
      <td>${w.stake} USDC</td>
    </tr>`,
    )
    .join('');
}

async function renderKyc() {
  const tbody = document.getElementById('kyc-body');
  const { customers } = await fetchAdmin('/admin/kyc');
  if (customers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted small">No self-reported KYC status yet.</td></tr>';
    return;
  }
  tbody.innerHTML = customers
    .map(
      (c) => `
    <tr>
      <td title="${c.address}">${truncateAddress(c.address)}</td>
      <td>${c.status || '—'}</td>
      <td>${c.tier || '—'}</td>
      <td class="muted small">${new Date(c.reportedAt).toLocaleString()}</td>
    </tr>`,
    )
    .join('');
}

async function renderPayouts() {
  const tbody = document.getElementById('payouts-body');
  const { payouts } = await fetchAdmin('/admin/payouts');
  if (payouts.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted small">No self-reported payouts yet.</td></tr>';
    return;
  }
  tbody.innerHTML = payouts
    .map(
      (p) => `
    <tr>
      <td title="${p.address}">${truncateAddress(p.address)}</td>
      <td>${p.amount || '—'} ${p.assetCode || ''}</td>
      <td>${p.status || '—'}</td>
      <td class="muted small">${new Date(p.reportedAt).toLocaleString()}</td>
    </tr>`,
    )
    .join('');
}

const VIEWS = {
  overview: renderOverview,
  transactions: renderTransactions,
  workers: renderWorkers,
  payers: renderPayers,
  fees: renderFees,
  treasury: renderTreasury,
  kyc: renderKyc,
  payouts: renderPayouts,
  blockchain: renderBlockchain,
  fraud: renderFraud,
};

async function selectView(name) {
  document.querySelectorAll('.admin-nav-link[data-view]').forEach((el) => el.classList.toggle('active', el.dataset.view === name));
  document.querySelectorAll('.admin-view').forEach((el) => el.classList.toggle('active', el.id === `view-${name}`));

  if (!loaded.has(name)) {
    loaded.add(name);
    try {
      await VIEWS[name]();
    } catch (err) {
      if (err.message !== 'unauthorized') console.error(`failed to load ${name}:`, err);
      loaded.delete(name);
    }
  }
}

document.querySelectorAll('.admin-nav-link[data-view]').forEach((el) => {
  el.addEventListener('click', () => selectView(el.dataset.view));
});

document.getElementById('btn-admin-login').addEventListener('click', () => {
  const token = document.getElementById('admin-token-input').value.trim();
  if (!token) return;
  localStorage.setItem(TOKEN_KEY, token);
  showShell();
  selectView('overview');
});

if (localStorage.getItem(TOKEN_KEY)) {
  showShell();
  selectView('overview');
} else {
  showLogin();
}
