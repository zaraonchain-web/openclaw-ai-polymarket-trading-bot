let lastSnapshot = null;
let marketRemainingSec = null;

const RING_C = 2 * Math.PI * 42;

const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");
const snapshotEl = document.getElementById("snapshot");
const historyEl = document.getElementById("history");
const statsEl = document.getElementById("stats");
const accuracyValueEl = document.getElementById("accuracyValue");
const accuracyArcEl = document.getElementById("accuracyArc");
const whaleStatsEl = document.getElementById("whaleStats");
const whalesEl = document.getElementById("whales");
const entryEl = document.getElementById("entryYes");
const delayEl = document.getElementById("delaySec");
const pendingWrap = document.getElementById("pendingWrap");
const pendingIdle = document.getElementById("pendingIdle");
const pendingInfoEl = document.getElementById("pendingInfo");
const pendingFill = document.getElementById("pendingFill");

const history = JSON.parse(localStorage.getItem("pm_compare_history") || "[]");
let pending = JSON.parse(localStorage.getItem("pm_compare_pending") || "null");

function sideFromProb(p) {
  return p >= 0.5 ? "YES" : "NO";
}
function fmt(n, d = 4) {
  return Number(n).toFixed(d);
}
function fmtCountdown(sec) {
  const s = Math.max(0, Number(sec || 0));
  const mm = String(Math.floor(s / 60)).padStart(1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function badge(side) {
  if (side === "YES") return `<span class="badge badge--yes">YES</span>`;
  if (side === "NO") return `<span class="badge badge--no">NO</span>`;
  return `<span class="badge badge--neutral">${side}</span>`;
}

function setStatus(loading) {
  if (loading) {
    statusEl.textContent = "Loading";
    statusEl.className = "status-pill status-pill--loading";
    refreshBtn.classList.add("is-loading");
  } else {
    statusEl.textContent = "Ready";
    statusEl.className = "status-pill status-pill--ready";
    refreshBtn.classList.remove("is-loading");
  }
}

async function refreshPrediction() {
  setStatus(true);
  try {
    const res = await fetch("/api/prediction");
    const data = await res.json();
    lastSnapshot = data;

    const p5 = data.prediction.pUp5m;
    const side = sideFromProb(p5);
    const sideClass = side === "YES" ? "stat-tile__value--yes" : "stat-tile__value--no";

    const meta = data.marketMeta || {};
    const remain = Number(meta.remainingSec ?? -1);
    marketRemainingSec = remain >= 0 ? remain : null;
    const remainText = remain >= 0 ? fmtCountdown(remain) : "—";

    snapshotEl.innerHTML = `
      <div class="stat-tile stat-tile--wide">
        <div class="stat-tile__label">Market</div>
        <div class="stat-tile__value">${escapeHtml(data.marketId)}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile__label">Current YES</div>
        <div class="stat-tile__value stat-tile__value--prob">${fmt(data.currentYes)}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile__label">Pred (5m)</div>
        <div class="stat-tile__value ${sideClass}">${side}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile__label">P(UP)</div>
        <div class="stat-tile__value stat-tile__value--prob">${fmt(p5, 3)}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile__label">Confidence</div>
        <div class="stat-tile__value">${fmt(data.prediction.confidence, 2)}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile__label">Slug</div>
        <div class="stat-tile__value" style="font-size:0.75rem">${escapeHtml(meta.slug || "—")}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-tile__label">Ends in</div>
        <div class="stat-tile__value"><span id="remainTimer">${remainText}</span></div>
      </div>
      <div class="stat-tile stat-tile--wide">
        <div class="stat-tile__label">Question</div>
        <div class="stat-tile__value" style="font-size:0.8rem;font-weight:500">${escapeHtml(meta.question || "—")}</div>
      </div>
    `;

    const whale = data.whale || {};
    whaleStatsEl.textContent = `Net YES $${fmt(whale.netYesNotional || 0, 2)} · Gross $${fmt(whale.grossNotional || 0, 2)} · ${whale.tradeCount || 0} trades`;
    const wallets = whale.topWallets || [];
    whalesEl.innerHTML =
      wallets
        .map((w) => {
          const bias = w.netYes > 0 ? "YES" : w.netYes < 0 ? "NO" : "—";
          const b = bias === "YES" ? "badge--yes" : bias === "NO" ? "badge--no" : "badge--neutral";
          return `<tr><td>${w.wallet.slice(0, 6)}…${w.wallet.slice(-4)}</td><td>$${fmt(w.netYes, 2)}</td><td>$${fmt(w.gross, 2)}</td><td><span class="badge ${b}">${bias}</span></td></tr>`;
        })
        .join("") ||
      '<tr><td colspan="4" class="empty-cell">No whale wallets in this sample.</td></tr>';

    entryEl.value = fmt(data.currentYes);
  } finally {
    setStatus(false);
  }
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function renderHistory() {
  const total = history.length;
  historyEl.innerHTML = total
    ? history
        .slice()
        .reverse()
        .map(
          (x) => `
    <tr class="${x.correct ? "row--win" : "row--lose"}">
      <td>${new Date(x.ts).toLocaleString()}</td>
      <td>${escapeHtml(String(x.marketId))}</td>
      <td>${badge(x.predSide)}</td>
      <td>${fmt(x.entryYes)}</td>
      <td>${fmt(x.exitYes)}</td>
      <td>${badge(x.actualSide)}</td>
      <td>${x.correct ? "✓ Hit" : "✗ Miss"}</td>
    </tr>
  `
        )
        .join("")
    : '<tr><td colspan="7" class="empty-cell">No compares yet — run <strong>Auto compare</strong> after fetching a prediction.</td></tr>';
  const win = history.filter((x) => x.correct).length;
  const acc = total ? (win / total) * 100 : 0;

  if (accuracyArcEl) {
    accuracyArcEl.style.strokeDasharray = String(RING_C);
    accuracyArcEl.style.strokeDashoffset = total ? String(RING_C * (1 - acc / 100)) : String(RING_C);
  }
  accuracyValueEl.textContent = total ? `${acc.toFixed(1)}%` : "—";
  statsEl.innerHTML = `<strong style="color:var(--text)">${total}</strong> runs · <strong style="color:var(--success)">${win}</strong> correct`;
}

document.getElementById("refresh").addEventListener("click", () => refreshPrediction().catch(console.error));

document.getElementById("startAuto").addEventListener("click", () => {
  if (!lastSnapshot) return alert("Get prediction first");
  if (pending) return alert("An auto-compare is already pending");

  const entryYes = Number(entryEl.value);
  const delaySec = Number(delayEl.value || 300);
  if (Number.isNaN(entryYes) || entryYes <= 0 || entryYes >= 1) return alert("Invalid entry YES price");
  if (Number.isNaN(delaySec) || delaySec < 10) return alert("Delay must be at least 10 seconds");

  pending = {
    marketId: lastSnapshot.marketId,
    predSide: sideFromProb(lastSnapshot.prediction.pUp5m),
    entryYes,
    startedAt: Date.now(),
    settleAt: Date.now() + delaySec * 1000
  };
  localStorage.setItem("pm_compare_pending", JSON.stringify(pending));
  renderPending();
});

async function settlePendingIfReady() {
  if (!pending) return;
  if (Date.now() < pending.settleAt) {
    renderPending();
    return;
  }

  try {
    const res = await fetch("/api/prediction");
    const data = await res.json();
    const exitYes = Number(data.currentYes);

    const actualSide = exitYes >= pending.entryYes ? "YES" : "NO";
    const row = {
      ts: Date.now(),
      marketId: pending.marketId,
      predSide: pending.predSide,
      actualSide,
      entryYes: pending.entryYes,
      exitYes,
      correct: pending.predSide === actualSide
    };

    history.push(row);
    localStorage.setItem("pm_compare_history", JSON.stringify(history));
    pending = null;
    localStorage.removeItem("pm_compare_pending");
    renderHistory();
    renderPending();
    await refreshPrediction();
  } catch (e) {
    console.error("auto settle error", e);
  }
}

function renderPending() {
  if (!pending) {
    pendingWrap.hidden = true;
    pendingIdle.hidden = false;
    pendingIdle.textContent = "No pending auto-compare.";
    pendingFill.style.width = "0%";
    return;
  }
  pendingWrap.hidden = false;
  pendingIdle.hidden = true;
  const totalSec = Math.max(1, (pending.settleAt - pending.startedAt) / 1000);
  const left = Math.max(0, Math.ceil((pending.settleAt - Date.now()) / 1000));
  const pct = Math.min(100, ((totalSec - left) / totalSec) * 100);
  pendingFill.style.width = `${pct}%`;
  pendingInfoEl.textContent = `${escapeHtml(pending.marketId)} · Pred ${pending.predSide} · Entry ${fmt(pending.entryYes)} · ${left}s left`;
}

function tickMarketTimer() {
  if (marketRemainingSec == null) return;
  marketRemainingSec = Math.max(0, marketRemainingSec - 1);
  const el = document.getElementById("remainTimer");
  if (el) el.textContent = fmtCountdown(marketRemainingSec);

  if (marketRemainingSec === 0) {
    refreshPrediction().catch(() => {});
  }
}

renderHistory();
renderPending();
refreshPrediction().catch(console.error);
setInterval(settlePendingIfReady, 3000);
setInterval(renderPending, 1000);
setInterval(tickMarketTimer, 1000);
