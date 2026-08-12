const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000';

function truncateAddress(id) {
  if (id.length <= 16 || !id.startsWith('G')) return id;
  return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

function formatRatio(ratio) {
  return ratio === null ? '—' : `${(ratio * 100).toFixed(1)}%`;
}

function renderRow(row, rank) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${rank}</td>
    <td title="${row.workerId}">${truncateAddress(row.workerId)}</td>
    <td>${formatRatio(row.matchRatio)} <span class="muted small">(${row.matched}/${row.totalAnswers})</span></td>
    <td>${row.totalAnswers}</td>
    <td>${row.stake} USDC</td>
  `;
  return tr;
}

async function loadLeaderboard() {
  const tbody = document.getElementById('leaderboard-body');
  tbody.innerHTML = '<tr><td colspan="5" class="muted small">Loading…</td></tr>';

  try {
    const res = await fetch(`${BACKEND_URL}/leaderboard`);
    if (!res.ok) throw new Error(`backend returned ${res.status}`);
    const { leaderboard } = await res.json();

    if (leaderboard.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted small">No established workers yet.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    leaderboard.forEach((row, i) => tbody.appendChild(renderRow(row, i + 1)));
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted small">Failed to load: ${err.message}</td></tr>`;
  }
}

document.getElementById('btn-refresh').addEventListener('click', loadLeaderboard);
loadLeaderboard();
