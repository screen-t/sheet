/* =========================================================================
   EQUITY LEDGER — script.js
   A points-based engine that decides how the TEAM equity pool is split.
   Pure client-side (no server, no network calls). Data lives in the
   browser's localStorage. Export/Import JSON regularly — see "Data & Backup".

   HOW TO RE-TUNE THE FORMULA
   The scoring weights live in the FORMULA and VESTING constants directly
   below. They are intentionally NOT exposed as a settings UI — if you want
   to change how much a "Critical" task is worth, or how long the vesting
   cliff is, edit the numbers here. Tab 2 ("How It Works") reads these same
   constants to build its explanation table, so the documentation can never
   drift out of sync with the real math.
   ========================================================================= */

"use strict";

/* -------------------------------------------------------------------------
   1. THE FORMULA — single source of truth for scoring
   ---------------------------------------------------------------------- */

const FORMULA = {
  // Base points for how important the work was. Spaced like planning-poker
  // story points (roughly doubling) so "Critical" dominates on purpose.
  priorityPoints: { Low: 5, Medium: 10, High: 20, Critical: 35 },

  // A Project (a self-contained deliverable, possibly bundling many tasks)
  // carries more inherent ownership/coordination load than a single Task.
  typeWeight: { Task: 1.0, Project: 1.5 },

  // Quality is rated 1–5 by whoever reviews the work. 3 = "met expectations"
  // is the neutral baseline (×1.0). Each star above/below shifts it by 0.3.
  qualityMultiplier: { 1: 0.4, 2: 0.7, 3: 1.0, 4: 1.3, 5: 1.6 },

  // Work nobody assigned — the person spotted a problem and fixed it
  // without being told to — earns a flat ownership bonus.
  initiativeMultiplier: { Assigned: 1.0, "Self-Initiated": 1.25 },

  // Estimated vs actual hours, deliberately capped BOTH ways. Speed is a
  // minor modifier, not the main thing — a wide-open efficiency score is
  // the easiest part of any system like this to game (rush the work, lie
  // about the estimate). Capping it at ±30% keeps it honest without ever
  // letting it dominate the score the way Quality and Priority do.
  efficiencyBounds: { min: 0.8, max: 1.3 },
};

// Standard early-stage vesting: nothing for the first 12 months (the
// "cliff" — protects the company if someone leaves almost immediately),
// then it accrues monthly in a straight line out to 48 months total.
const VESTING = { cliffMonths: 12, totalMonths: 48 };

// Preset deduction categories with a default point value. Note the
// asymmetry between the two "missed deadline" options — that's deliberate,
// see Tab 2. The founder can still type a fully custom reason + value.
const DEDUCTION_PRESETS = {
  deadline_flagged: { label: "Missed deadline — flagged in advance", points: 5 },
  deadline_silent: { label: "Missed deadline — no warning given", points: 15 },
  process: { label: "Did not follow agreed process / rules", points: 10 },
  rework: { label: "Required significant rework", points: 8 },
  unresponsive: { label: "Unresponsive during work hours", points: 12 },
  custom: { label: "", points: 5 },
};

const STORAGE_KEY = "equity_ledger_state_v1";

/* -------------------------------------------------------------------------
   2. STATE — load / save / defaults
   ---------------------------------------------------------------------- */

function defaultState() {
  return {
    settings: {
      companyName: "",
      founderName: "",
      founderPercent: 85,
      poolPercent: 15,
    },
    members: [],
    entries: [],
    deductions: [],
    agreements: [],
  };
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return defaultState();
  try {
    const parsed = JSON.parse(raw);
    // Shallow-merge so older saves missing a newer key don't crash the app.
    const d = defaultState();
    return {
      settings: { ...d.settings, ...(parsed.settings || {}) },
      members: Array.isArray(parsed.members) ? parsed.members : [],
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      deductions: Array.isArray(parsed.deductions) ? parsed.deductions : [],
      agreements: Array.isArray(parsed.agreements) ? parsed.agreements : [],
    };
  } catch (err) {
    console.warn("Saved data was corrupt, starting fresh.", err);
    return defaultState();
  }
}

let state = loadState();

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* -------------------------------------------------------------------------
   3. CALCULATION ENGINE (pure functions — no DOM access in this section)
   ---------------------------------------------------------------------- */

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function computeEfficiency(entry) {
  const est = Number(entry.estHours);
  const act = Number(entry.actualHours);
  if (!est || est <= 0 || !act || act <= 0) return 1; // no estimate given = neutral
  return clamp(est / act, FORMULA.efficiencyBounds.min, FORMULA.efficiencyBounds.max);
}

// Returns 0 until a quality rating is entered — unreviewed work never
// silently counts toward equity.
function computeEntryScore(entry) {
  if (entry.quality === null || entry.quality === undefined || entry.quality === "") return 0;
  const base = FORMULA.priorityPoints[entry.priority] ?? 0;
  const typeW = FORMULA.typeWeight[entry.type] ?? 1;
  const qualW = FORMULA.qualityMultiplier[Number(entry.quality)] ?? 1;
  const initW = FORMULA.initiativeMultiplier[entry.initiative] ?? 1;
  const effW = computeEfficiency(entry);
  return base * typeW * qualW * initW * effW;
}

// The breakdown used by the "View" dialog — same numbers, shown as steps.
function entryScoreBreakdown(entry) {
  const base = FORMULA.priorityPoints[entry.priority] ?? 0;
  const typeW = FORMULA.typeWeight[entry.type] ?? 1;
  const hasQuality = !(entry.quality === null || entry.quality === undefined || entry.quality === "");
  const qualW = hasQuality ? FORMULA.qualityMultiplier[Number(entry.quality)] ?? 1 : null;
  const initW = FORMULA.initiativeMultiplier[entry.initiative] ?? 1;
  const effW = computeEfficiency(entry);
  const total = hasQuality ? base * typeW * qualW * initW * effW : 0;
  return { base, typeW, qualW, initW, effW, total, hasQuality };
}

function getMemberGrossPoints(memberId) {
  return state.entries
    .filter((e) => e.memberId === memberId)
    .reduce((sum, e) => sum + computeEntryScore(e), 0);
}

function getMemberDeductionPoints(memberId) {
  return state.deductions
    .filter((d) => d.memberId === memberId)
    .reduce((sum, d) => sum + Number(d.points || 0), 0);
}

// The core output: for every member, net points -> share of the pool ->
// equity %. Guarantees the team rows sum to EXACTLY poolPercent (floating
// point rounding is corrected by nudging whoever has the largest raw
// share, so the one visible adjustment is as small and unnoticeable as
// possible).
function getEquityTable() {
  const pool = Number(state.settings.poolPercent) || 0;
  const base = state.members.map((m) => {
    const gross = getMemberGrossPoints(m.id);
    const deducted = getMemberDeductionPoints(m.id);
    const rawNet = gross - deducted;
    return { id: m.id, name: m.name, role: m.role, gross, deducted, rawNet, netPoints: Math.max(0, rawNet) };
  });
  const totalPoints = base.reduce((s, r) => s + r.netPoints, 0);
  const rows = base.map((r) => {
    const share = totalPoints > 0 ? r.netPoints / totalPoints : 0;
    const equityPercentRaw = share * pool;
    return { ...r, share, equityPercentRaw, equityPercent: round2(equityPercentRaw) };
  });
  if (rows.length > 0 && totalPoints > 0) {
    const roundedSum = round2(rows.reduce((s, r) => s + r.equityPercent, 0));
    const drift = round2(pool - roundedSum);
    if (Math.abs(drift) >= 0.01) {
      let target = rows[0];
      for (const r of rows) if (r.equityPercentRaw > target.equityPercentRaw) target = r;
      target.equityPercent = round2(target.equityPercent + drift);
    }
  }
  rows.sort((a, b) => b.equityPercent - a.equityPercent);
  return { rows, totalPoints, pool, founderPercent: Number(state.settings.founderPercent) || 0 };
}

// Standard 1-year-cliff / 4-year-total vesting, computed from a start date.
// Returns what % of this person's EVENTUAL points-based allocation they
// would actually keep if they left the company today.
function getVestingStatus(member) {
  if (!member.vestingStart) return { label: "No vesting start date set", percent: 0, cliffPassed: false };
  const start = new Date(member.vestingStart + "T00:00:00");
  if (isNaN(start.getTime())) return { label: "Invalid vesting start date", percent: 0, cliffPassed: false };
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  months = Math.max(0, months);
  if (months < VESTING.cliffMonths) {
    return { label: `Cliff not reached (${months}/${VESTING.cliffMonths} mo)`, percent: 0, cliffPassed: false, months };
  }
  const percent = Math.min(100, (months / VESTING.totalMonths) * 100);
  const label = percent >= 100 ? "Fully vested" : `${percent.toFixed(1)}% vested`;
  return { label, percent, cliffPassed: true, months };
}

// Turns raw state into the handful of things a founder actually needs to
// notice at a glance: what's piling up unreviewed, and who has no logged
// work at all yet (easy to forget, and it silently looks like 0% equity).
function computeInsights() {
  const totalMembers = state.members.length;
  const totalEntries = state.entries.length;
  const pendingReview = state.entries.filter((e) => e.quality === null || e.quality === undefined || e.quality === "").length;
  const { totalPoints } = getEquityTable();
  const neverLogged = state.members.filter((m) => !state.entries.some((e) => e.memberId === m.id));
  const sortedAgreements = state.agreements.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lastAgreement = sortedAgreements[0] || null;
  let daysSinceAgreement = null;
  if (lastAgreement) {
    daysSinceAgreement = Math.floor((Date.now() - new Date(lastAgreement.createdAt).getTime()) / 86400000);
  }
  return { totalMembers, totalEntries, pendingReview, totalPoints, neverLogged, lastAgreement, daysSinceAgreement };
}

/* -------------------------------------------------------------------------
   4. FORMATTING + SAFE-TEXT HELPERS
   ---------------------------------------------------------------------- */

function fmtPct(n) {
  return `${(Number(n) || 0).toFixed(2)}%`;
}
function fmtPts(n) {
  return (Number(n) || 0).toFixed(1);
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
}
function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str ?? "");
  return div.innerHTML;
}
function memberName(id) {
  const m = state.members.find((x) => x.id === id);
  return m ? m.name : "(removed member)";
}

// Visually the row-flash animation confirms an action succeeded; this is
// the equivalent confirmation for screen-reader users. Clearing the text
// first guarantees repeated identical messages are still announced.
function announce(message) {
  const el = document.getElementById("sr-status");
  if (!el) return;
  el.textContent = "";
  requestAnimationFrame(() => {
    el.textContent = message;
  });
}

// Tracks the single most-recently added/edited record so its table row can
// receive a brief highlight on the next render, then self-clears.
let lastTouched = { type: null, id: null };
function markTouched(type, id) {
  lastTouched = { type, id };
}
function isTouched(type, id) {
  return lastTouched.type === type && lastTouched.id === id;
}

/* -------------------------------------------------------------------------
   5. DIALOG HELPERS (native <dialog>)
   ---------------------------------------------------------------------- */

const dlgBreakdown = document.getElementById("dlg-breakdown");
const dlgConfirm = document.getElementById("dlg-confirm");

function showBreakdown(entry) {
  const b = entryScoreBreakdown(entry);
  const body = document.getElementById("breakdown-body");
  const rows = [
    ["Priority base", entry.priority, `${b.base}`],
    ["Type weight", entry.type, `× ${b.typeW}`],
    ["Quality", b.hasQuality ? `${entry.quality}★` : "Not rated yet", b.hasQuality ? `× ${b.qualW}` : "— (scores 0 until rated)"],
    ["Initiative", entry.initiative, `× ${b.initW}`],
    ["Efficiency (est/actual hrs)", entry.estHours && entry.actualHours ? `${entry.estHours}h / ${entry.actualHours}h` : "not logged", `× ${b.effW.toFixed(2)}`],
  ];
  body.innerHTML = `
    <h3>${escapeHtml(entry.title)}</h3>
    <p class="muted">${escapeHtml(memberName(entry.memberId))} · ${fmtDate(entry.date)}</p>
    <table class="breakdown-table">
      <thead><tr><th>Factor</th><th>Value</th><th>Contributes</th></tr></thead>
      <tbody>
        ${rows.map((r) => `<tr><td>${escapeHtml(r[0])}</td><td>${escapeHtml(r[1])}</td><td>${escapeHtml(r[2])}</td></tr>`).join("")}
      </tbody>
      <tfoot><tr><td colspan="2">Total score</td><td><strong>${b.hasQuality ? fmtPts(b.total) + " pts" : "— pending review"}</strong></td></tr></tfoot>
    </table>
    ${entry.notes ? `<p class="muted">Note: ${escapeHtml(entry.notes)}</p>` : ""}
  `;
  dlgBreakdown.showModal();
}

function confirmAction(message) {
  return new Promise((resolve) => {
    document.getElementById("confirm-message").textContent = message;
    dlgConfirm.showModal();
    const onClose = () => {
      dlgConfirm.removeEventListener("close", onClose);
      resolve(dlgConfirm.returnValue === "yes");
    };
    dlgConfirm.addEventListener("close", onClose);
  });
}

/* -------------------------------------------------------------------------
   6. RENDERING
   ---------------------------------------------------------------------- */

// A small fixed palette for team-member strip segments — muted, part of
// one family, so the strip reads as "one pool" rather than competing
// brand colors. Founder gets the gold accent, always first.
const MEMBER_HUES = [152, 170, 135, 95, 185, 60, 205, 25];

function renderOwnershipStrip() {
  const { rows, founderPercent } = getEquityTable();
  const strip = document.getElementById("ownership-strip");
  const legend = document.getElementById("ownership-legend");

  const founderSeg = `<div class="seg seg-founder" style="--w:${founderPercent}%" aria-hidden="true"></div>`;
  const memberSegs = rows
    .map((r, i) => {
      const hue = MEMBER_HUES[i % MEMBER_HUES.length];
      return r.equityPercent > 0
        ? `<button type="button" class="seg" data-jump-member="${r.id}" style="--w:${r.equityPercent}%; --hue:${hue}" aria-label="${escapeHtml(r.name)} — ${fmtPct(r.equityPercent)}. Click to view their work log."></button>`
        : "";
    })
    .join("");
  strip.innerHTML = founderSeg + memberSegs;
  strip.setAttribute("role", "img");
  strip.setAttribute("aria-label", `Ownership split: ${escapeHtml(state.settings.founderName || "Founder")} ${fmtPct(founderPercent)}, team pool ${fmtPct(state.settings.poolPercent)}`);

  const teamSum = round2(rows.reduce((s, r) => s + r.equityPercent, 0));
  legend.innerHTML = `
    <li class="legend-item"><span class="swatch swatch-founder"></span>${escapeHtml(state.settings.founderName || "Founder")} — <strong>${fmtPct(founderPercent)}</strong></li>
    ${rows
      .map((r, i) => {
        const hue = MEMBER_HUES[i % MEMBER_HUES.length];
        return `<li class="legend-item"><span class="swatch" style="--hue:${hue}"></span><button type="button" data-jump-member="${r.id}">${escapeHtml(r.name)}</button> — <strong>${fmtPct(r.equityPercent)}</strong></li>`;
      })
      .join("")}
    <li class="legend-total">Total: ${fmtPct(founderPercent + teamSum)} ${Math.abs(founderPercent + teamSum - 100) < 0.011 ? "✓" : "⚠ does not reach 100%, check Company Setup"}</li>
  `;
}

function jumpToSection(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function clearEntryFilters() {
  document.getElementById("log-filter").value = "";
  document.getElementById("log-filter-status").value = "";
  document.getElementById("log-filter-type").value = "";
  document.getElementById("log-filter-priority").value = "";
  document.getElementById("log-search").value = "";
}

function jumpToPendingReview() {
  clearEntryFilters();
  document.getElementById("log-filter-status").value = "pending";
  renderEntries();
  jumpToSection("section-worklog");
}

function jumpToMemberLog(memberId) {
  clearEntryFilters();
  document.getElementById("log-filter").value = memberId;
  renderEntries();
  jumpToSection("section-worklog");
}

// For a teammate with zero entries, the most useful click isn't filtering
// (there's nothing to filter to) — it's pre-selecting them in the Add form
// so logging their first item is one click away.
function jumpToLogFor(memberId) {
  document.getElementById("e-member").value = memberId;
  jumpToSection("section-worklog");
  document.getElementById("e-title").focus();
}

function renderInsights() {
  const { totalMembers, totalEntries, pendingReview, totalPoints, neverLogged, daysSinceAgreement } = computeInsights();
  const row = document.getElementById("insights-row");

  const chips = [];
  chips.push(`<div class="stat-chip"><span class="stat-value">${totalMembers}</span><span class="stat-label">${totalMembers === 1 ? "teammate" : "teammates"} on roster</span></div>`);
  chips.push(`<div class="stat-chip"><span class="stat-value">${totalEntries}</span><span class="stat-label">work-log entries · ${fmtPts(totalPoints)} pts logged</span></div>`);
  chips.push(
    pendingReview > 0
      ? `<button type="button" class="stat-chip stat-warn" id="chip-pending">
           <span class="stat-value">${pendingReview}</span>
           <span class="stat-label">awaiting your quality review →</span>
         </button>`
      : `<div class="stat-chip stat-ok"><span class="stat-value">0</span><span class="stat-label">awaiting review — all caught up</span></div>`
  );
  chips.push(
    daysSinceAgreement === null
      ? `<div class="stat-chip stat-warn"><span class="stat-value">—</span><span class="stat-label">no Plan Agreement yet — numbers are a live draft</span></div>`
      : `<div class="stat-chip"><span class="stat-value">${daysSinceAgreement}</span><span class="stat-label">day${daysSinceAgreement === 1 ? "" : "s"} since last agreement</span></div>`
  );
  row.innerHTML = chips.join("");

  const note = document.getElementById("never-logged-note");
  if (neverLogged.length === 0) {
    note.hidden = true;
    note.innerHTML = "";
  } else {
    note.hidden = false;
    note.innerHTML =
      `No work logged yet for: ` +
      neverLogged.map((m) => `<button type="button" data-jump-log="${m.id}">${escapeHtml(m.name)}</button>`).join(", ") +
      `. They currently show 0% purely because nothing's on record — click a name to log their first item.`;
  }
}

function renderCompanySetup() {
  document.getElementById("cfg-company").value = state.settings.companyName;
  document.getElementById("cfg-founder-name").value = state.settings.founderName;
  document.getElementById("cfg-founder-pct").value = state.settings.founderPercent;
  document.getElementById("cfg-pool-pct").value = state.settings.poolPercent;
  const title = document.getElementById("app-title");
  title.textContent = state.settings.companyName ? `${state.settings.companyName} — Equity Ledger` : "Equity Ledger";
  document.getElementById("masthead-dateline").textContent = `As of ${new Date().toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })} · live working draft`;
}

function memberOptions(selectedId) {
  if (state.members.length === 0) return `<option value="">Add a teammate first</option>`;
  return (
    `<option value="">Choose a teammate…</option>` +
    state.members
      .map((m) => `<option value="${m.id}" ${m.id === selectedId ? "selected" : ""}>${escapeHtml(m.name)}</option>`)
      .join("")
  );
}

function renderRoster() {
  const body = document.getElementById("roster-body");
  if (state.members.length === 0) {
    body.innerHTML = `<tr><td colspan="6" class="empty-state">No teammates yet. Add the first one below — everyone you add here becomes eligible for a slice of the ${fmtPct(state.settings.poolPercent)} pool.</td></tr>`;
    return;
  }
  body.innerHTML = state.members
    .map((m) => {
      const v = getVestingStatus(m);
      return `<tr${isTouched("member", m.id) ? ' class="row-flash"' : ""}>
        <td data-label="Name">${escapeHtml(m.name)}</td>
        <td data-label="Role">${escapeHtml(m.role) || "—"}</td>
        <td data-label="Joined">${fmtDate(m.joinDate)}</td>
        <td data-label="Vesting start">${fmtDate(m.vestingStart)}</td>
        <td data-label="Vesting status"><span class="${v.cliffPassed ? "tag tag-gain" : "tag tag-wait"}">${escapeHtml(v.label)}</span></td>
        <td data-label="Actions" class="actions">
          <button type="button" class="btn-ghost" data-action="edit-member" data-id="${m.id}">Edit</button>
          <button type="button" class="btn-ghost btn-danger" data-action="delete-member" data-id="${m.id}">Delete</button>
        </td>
      </tr>`;
    })
    .join("");
}

function renderEntries() {
  const memberFilter = document.getElementById("log-filter").value;
  const statusFilter = document.getElementById("log-filter-status").value;
  const typeFilter = document.getElementById("log-filter-type").value;
  const priorityFilter = document.getElementById("log-filter-priority").value;
  const searchTerm = document.getElementById("log-search").value.trim().toLowerCase();
  const body = document.getElementById("entries-body");
  const countLabel = document.getElementById("entries-count");

  let list = state.entries.slice();
  if (memberFilter) list = list.filter((e) => e.memberId === memberFilter);
  if (statusFilter === "pending") list = list.filter((e) => e.quality === null || e.quality === undefined || e.quality === "");
  if (statusFilter === "reviewed") list = list.filter((e) => !(e.quality === null || e.quality === undefined || e.quality === ""));
  if (typeFilter) list = list.filter((e) => e.type === typeFilter);
  if (priorityFilter) list = list.filter((e) => e.priority === priorityFilter);
  if (searchTerm) list = list.filter((e) => e.title.toLowerCase().includes(searchTerm) || (e.notes || "").toLowerCase().includes(searchTerm));
  list.sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.id.localeCompare(a.id));

  const anyFilterActive = memberFilter || statusFilter || typeFilter || priorityFilter || searchTerm;
  countLabel.textContent = anyFilterActive ? `Showing ${list.length} of ${state.entries.length} entries` : `${state.entries.length} entries total`;

  if (state.entries.length === 0) {
    body.innerHTML = `<tr><td colspan="10" class="empty-state">No work logged yet. Log a task or project below — it only counts toward equity once you rate its quality.</td></tr>`;
    return;
  }
  if (list.length === 0) {
    body.innerHTML = `<tr><td colspan="10" class="empty-state">Nothing matches the current filters.</td></tr>`;
    return;
  }
  body.innerHTML = list
    .map((e) => {
      const score = computeEntryScore(e);
      const rated = !(e.quality === null || e.quality === undefined || e.quality === "");
      const hours = e.estHours || e.actualHours ? `${e.estHours || "–"}h / ${e.actualHours || "–"}h` : "—";
      return `<tr${isTouched("entry", e.id) ? ' class="row-flash"' : ""}>
        <td data-label="Date">${fmtDate(e.date)}</td>
        <td data-label="Member">${escapeHtml(memberName(e.memberId))}</td>
        <td data-label="Title">${escapeHtml(e.title)}</td>
        <td data-label="Type"><span class="tag">${e.type}</span></td>
        <td data-label="Priority"><span class="tag tag-priority-${e.priority.toLowerCase()}">${e.priority}</span></td>
        <td data-label="Initiative">${e.initiative === "Self-Initiated" ? "Self-initiated" : "Assigned"}</td>
        <td data-label="Quality">${rated ? "★".repeat(Number(e.quality)) + "☆".repeat(5 - Number(e.quality)) : `<span class="tag tag-wait">Awaiting review</span>`}</td>
        <td data-label="Hours (est/actual)">${hours}</td>
        <td data-label="Score" class="num">${rated ? fmtPts(score) : "—"}</td>
        <td data-label="Actions" class="actions">
          <button type="button" class="btn-ghost" data-action="view-entry" data-id="${e.id}">View</button>
          <button type="button" class="btn-ghost" data-action="edit-entry" data-id="${e.id}">Edit</button>
          <button type="button" class="btn-ghost btn-danger" data-action="delete-entry" data-id="${e.id}">Delete</button>
        </td>
      </tr>`;
    })
    .join("");
}

function renderDeductions() {
  const body = document.getElementById("deductions-body");
  if (state.deductions.length === 0) {
    body.innerHTML = `<tr><td colspan="6" class="empty-state">No deductions on record. Good — keep it that way. Every deduction here requires a written reason, visible to everyone.</td></tr>`;
    return;
  }
  const list = state.deductions.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  body.innerHTML = list
    .map(
      (d) => `<tr${isTouched("deduction", d.id) ? ' class="row-flash"' : ""}>
        <td data-label="Date">${fmtDate(d.date)}</td>
        <td data-label="Member">${escapeHtml(memberName(d.memberId))}</td>
        <td data-label="Category">${escapeHtml(d.label)}</td>
        <td data-label="Points" class="num"><span class="tag tag-loss">−${fmtPts(d.points)}</span></td>
        <td data-label="Reason">${escapeHtml(d.note)}</td>
        <td data-label="Actions" class="actions">
          <button type="button" class="btn-ghost" data-action="edit-deduction" data-id="${d.id}">Edit</button>
          <button type="button" class="btn-ghost btn-danger" data-action="delete-deduction" data-id="${d.id}">Delete</button>
        </td>
      </tr>`
    )
    .join("");
}

function renderEquityTable() {
  const { rows, pool, founderPercent } = getEquityTable();
  const body = document.getElementById("equity-body");
  const founderRow = `<tr class="row-founder">
    <td data-label="Name"><strong>${escapeHtml(state.settings.founderName || "Founder")}</strong></td>
    <td data-label="Gross pts">—</td>
    <td data-label="Deducted">—</td>
    <td data-label="Net pts">—</td>
    <td data-label="Share">Fixed</td>
    <td data-label="Equity %"><strong>${fmtPct(founderPercent)}</strong></td>
    <td data-label="Vesting">Not applicable — founder</td>
  </tr>`;

  const memberRows = state.members.length
    ? rows
        .map((r) => {
          const member = state.members.find((m) => m.id === r.id);
          const v = member ? getVestingStatus(member) : { label: "—", cliffPassed: false };
          const negNote = r.rawNet < 0 ? ` <span class="muted">(raw ${fmtPts(r.rawNet)}, floored at 0)</span>` : "";
          return `<tr>
            <td data-label="Name">${escapeHtml(r.name)}</td>
            <td data-label="Gross pts" class="num">${fmtPts(r.gross)}</td>
            <td data-label="Deducted" class="num">${r.deducted > 0 ? "−" + fmtPts(r.deducted) : "0.0"}</td>
            <td data-label="Net pts" class="num">${fmtPts(r.netPoints)}${negNote}</td>
            <td data-label="Share" class="num">${(r.share * 100).toFixed(1)}%</td>
            <td data-label="Equity %" class="num"><strong>${fmtPct(r.equityPercent)}</strong></td>
            <td data-label="Vesting"><span class="${v.cliffPassed ? "tag tag-gain" : "tag tag-wait"}">${escapeHtml(v.label)}</span></td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="empty-state">Add teammates to see the split.</td></tr>`;

  const teamSum = round2(rows.reduce((s, r) => s + r.equityPercent, 0));
  const total = round2(founderPercent + teamSum);
  const checkOk = Math.abs(total - 100) < 0.011;
  const totalRow = `<tr class="row-total">
    <td data-label="Name">Total</td>
    <td data-label="Gross pts"></td><td data-label="Deducted"></td><td data-label="Net pts"></td>
    <td data-label="Share"></td>
    <td data-label="Equity %"><strong>${fmtPct(total)} ${checkOk ? "✓" : "⚠"}</strong></td>
    <td data-label="Vesting"></td>
  </tr>`;

  body.innerHTML = founderRow + memberRows + totalRow;
}

function renderAgreements() {
  const list = document.getElementById("agreements-list");
  if (state.agreements.length === 0) {
    list.innerHTML = `<p class="empty-state">No Plan Agreement generated yet. Until you generate one, every number above is a live working draft — nothing is locked in.</p>`;
    return;
  }
  const sorted = state.agreements.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  list.innerHTML = sorted
    .map((a) => {
      const rows = a.rows
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.name)}</td><td class="num">${fmtPts(r.netPoints)}</td><td class="num"><strong>${fmtPct(r.equityPercent)}</strong></td></tr>`
        )
        .join("");
      return `<details class="agreement-card">
        <summary>${escapeHtml(a.title || "Untitled agreement")} — ${fmtDateTime(a.createdAt)}</summary>
        <table class="breakdown-table">
          <thead><tr><th>Name</th><th>Net points</th><th>Equity %</th></tr></thead>
          <tbody>
            <tr><td>${escapeHtml(a.founderName || "Founder")}</td><td>—</td><td><strong>${fmtPct(a.founderPercent)}</strong></td></tr>
            ${rows}
          </tbody>
        </table>
        <button type="button" class="btn-secondary" data-action="print-agreement" data-id="${a.id}">Print this agreement</button>
      </details>`;
    })
    .join("");
}

function renderDocFormula() {
  const pr = FORMULA.priorityPoints;
  document.getElementById("doc-priority-table").innerHTML = Object.entries(pr)
    .map(([k, v]) => `<tr><td>${k}</td><td class="num">${v} pts</td></tr>`)
    .join("");
  const tw = FORMULA.typeWeight;
  document.getElementById("doc-type-table").innerHTML = Object.entries(tw)
    .map(([k, v]) => `<tr><td>${k}</td><td class="num">× ${v}</td></tr>`)
    .join("");
  const qm = FORMULA.qualityMultiplier;
  document.getElementById("doc-quality-table").innerHTML = Object.entries(qm)
    .map(([k, v]) => `<tr><td>${"★".repeat(Number(k))}${"☆".repeat(5 - Number(k))}</td><td class="num">× ${v}</td></tr>`)
    .join("");
  const im = FORMULA.initiativeMultiplier;
  document.getElementById("doc-initiative-table").innerHTML = Object.entries(im)
    .map(([k, v]) => `<tr><td>${k}</td><td class="num">× ${v}</td></tr>`)
    .join("");
  document.getElementById("doc-efficiency-note").textContent = `Capped between ×${FORMULA.efficiencyBounds.min} and ×${FORMULA.efficiencyBounds.max}.`;
  document.getElementById("doc-vesting-note").textContent = `${VESTING.cliffMonths}-month cliff, ${VESTING.totalMonths}-month total vesting.`;
  document.getElementById("doc-founder-pool").textContent = `${state.settings.founderPercent}% founder, ${state.settings.poolPercent}% team pool`;
  document.getElementById("doc-deduction-table").innerHTML = Object.values(DEDUCTION_PRESETS)
    .filter((p) => p.label)
    .map((p) => `<tr><td>${escapeHtml(p.label)}</td><td class="num">− ${p.points} pts</td></tr>`)
    .join("");
}

function renderAll() {
  renderCompanySetup();
  renderInsights();
  renderOwnershipStrip();
  renderRoster();
  // keep filter dropdown's current selection if still valid
  const filterSel = document.getElementById("log-filter");
  const prevFilter = filterSel.value;
  filterSel.innerHTML = `<option value="">All teammates</option>` + state.members.map((m) => `<option value="${m.id}">${escapeHtml(m.name)}</option>`).join("");
  filterSel.value = state.members.some((m) => m.id === prevFilter) ? prevFilter : "";
  renderEntries();
  renderDeductions();
  // member dropdowns in the two forms
  document.getElementById("e-member").innerHTML = memberOptions(document.getElementById("e-member").value);
  document.getElementById("d-member").innerHTML = memberOptions(document.getElementById("d-member").value);
  renderEquityTable();
  renderAgreements();
  renderDocFormula();
  saveState();
  lastTouched = { type: null, id: null };
}

/* -------------------------------------------------------------------------
   7. FORM <-> STATE: Company Setup
   ---------------------------------------------------------------------- */

function wireCompanySetup() {
  const company = document.getElementById("cfg-company");
  const founderName = document.getElementById("cfg-founder-name");
  const founderPct = document.getElementById("cfg-founder-pct");
  const poolPct = document.getElementById("cfg-pool-pct");

  company.addEventListener("input", () => {
    state.settings.companyName = company.value;
    renderCompanySetup();
    saveState();
  });
  founderName.addEventListener("input", () => {
    state.settings.founderName = founderName.value;
    renderOwnershipStrip();
    renderEquityTable();
    renderAgreements();
    saveState();
  });
  // Keep the two percentages linked to 100 automatically.
  founderPct.addEventListener("input", () => {
    const v = clamp(Number(founderPct.value) || 0, 0, 100);
    state.settings.founderPercent = v;
    state.settings.poolPercent = round2(100 - v);
    poolPct.value = state.settings.poolPercent;
    renderOwnershipStrip();
    renderEquityTable();
    renderRoster();
    renderDocFormula();
    saveState();
  });
  poolPct.addEventListener("input", () => {
    const v = clamp(Number(poolPct.value) || 0, 0, 100);
    state.settings.poolPercent = v;
    state.settings.founderPercent = round2(100 - v);
    founderPct.value = state.settings.founderPercent;
    renderOwnershipStrip();
    renderEquityTable();
    renderRoster();
    renderDocFormula();
    saveState();
  });
}

/* -------------------------------------------------------------------------
   8. MEMBERS: add / edit / delete
   ---------------------------------------------------------------------- */

function resetMemberForm() {
  const form = document.getElementById("form-member");
  form.reset();
  document.getElementById("m-editid").value = "";
  document.getElementById("m-submit").textContent = "Add teammate";
  document.getElementById("m-cancel-edit").hidden = true;
  document.getElementById("m-join").value = todayISO();
}

function wireMemberForm() {
  const form = document.getElementById("form-member");
  resetMemberForm();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const editId = document.getElementById("m-editid").value;
    const name = document.getElementById("m-name").value.trim();
    const dupe = state.members.find((m) => m.name.toLowerCase() === name.toLowerCase() && m.id !== editId);
    if (dupe) {
      alert(`"${name}" is already on the roster. Use a distinguishing name (e.g. a surname) if two teammates share a first name.`);
      return;
    }
    const payload = {
      name,
      role: document.getElementById("m-role").value.trim(),
      joinDate: document.getElementById("m-join").value,
      vestingStart: document.getElementById("m-vest").value,
    };
    if (editId) {
      const m = state.members.find((x) => x.id === editId);
      Object.assign(m, payload);
      markTouched("member", editId);
      announce(`Saved changes for ${payload.name}.`);
    } else {
      const id = uid();
      state.members.push({ id, ...payload });
      markTouched("member", id);
      announce(`${payload.name} added to the roster.`);
    }
    resetMemberForm();
    renderAll();
  });

  document.getElementById("m-cancel-edit").addEventListener("click", resetMemberForm);

  document.getElementById("roster-body").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const m = state.members.find((x) => x.id === id);
    if (!m) return;
    if (btn.dataset.action === "edit-member") {
      document.getElementById("m-editid").value = m.id;
      document.getElementById("m-name").value = m.name;
      document.getElementById("m-role").value = m.role || "";
      document.getElementById("m-join").value = m.joinDate || "";
      document.getElementById("m-vest").value = m.vestingStart || "";
      document.getElementById("m-submit").textContent = "Save changes";
      document.getElementById("m-cancel-edit").hidden = false;
      document.getElementById("form-member").scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (btn.dataset.action === "delete-member") {
      const linkedEntries = state.entries.filter((x) => x.memberId === id).length;
      const linkedDeductions = state.deductions.filter((x) => x.memberId === id).length;
      const extra = linkedEntries || linkedDeductions ? ` This also removes ${linkedEntries} work-log entr${linkedEntries === 1 ? "y" : "ies"} and ${linkedDeductions} deduction${linkedDeductions === 1 ? "" : "s"} tied to them.` : "";
      const ok = await confirmAction(`Remove ${m.name} from the roster?${extra}`);
      if (!ok) return;
      state.members = state.members.filter((x) => x.id !== id);
      state.entries = state.entries.filter((x) => x.memberId !== id);
      state.deductions = state.deductions.filter((x) => x.memberId !== id);
      announce(`${m.name} removed from the roster.`);
      renderAll();
    }
  });
}

/* -------------------------------------------------------------------------
   9. WORK LOG: add / edit / delete / view
   ---------------------------------------------------------------------- */

function resetEntryForm() {
  const form = document.getElementById("form-entry");
  form.reset();
  document.getElementById("e-editid").value = "";
  document.getElementById("e-submit").textContent = "Log work";
  document.getElementById("e-cancel-edit").hidden = true;
  document.getElementById("e-date").value = todayISO();
}

function wireEntryForm() {
  const form = document.getElementById("form-entry");
  resetEntryForm();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const editId = document.getElementById("e-editid").value;
    const qualityVal = document.getElementById("e-quality").value;
    const payload = {
      memberId: document.getElementById("e-member").value,
      title: document.getElementById("e-title").value.trim(),
      type: document.getElementById("e-type").value,
      priority: document.getElementById("e-priority").value,
      initiative: document.getElementById("e-initiative").value,
      quality: qualityVal === "" ? null : Number(qualityVal),
      estHours: document.getElementById("e-est").value ? Number(document.getElementById("e-est").value) : null,
      actualHours: document.getElementById("e-actual").value ? Number(document.getElementById("e-actual").value) : null,
      date: document.getElementById("e-date").value,
      notes: document.getElementById("e-notes").value.trim(),
    };
    if (editId) {
      const en = state.entries.find((x) => x.id === editId);
      Object.assign(en, payload);
      markTouched("entry", editId);
      announce(`Saved changes to "${payload.title}".`);
    } else {
      const id = uid();
      state.entries.push({ id, ...payload });
      markTouched("entry", id);
      announce(
        payload.quality === null
          ? `"${payload.title}" logged for ${memberName(payload.memberId)}. It will count toward equity once you rate its quality.`
          : `"${payload.title}" logged and scored for ${memberName(payload.memberId)}.`
      );
    }
    resetEntryForm();
    renderAll();
  });

  document.getElementById("e-cancel-edit").addEventListener("click", resetEntryForm);
  document.getElementById("log-filter").addEventListener("change", renderEntries);
  document.getElementById("log-filter-status").addEventListener("change", renderEntries);
  document.getElementById("log-filter-type").addEventListener("change", renderEntries);
  document.getElementById("log-filter-priority").addEventListener("change", renderEntries);
  document.getElementById("log-search").addEventListener("input", renderEntries);
  document.getElementById("log-filter-clear").addEventListener("click", () => {
    clearEntryFilters();
    renderEntries();
  });

  document.getElementById("entries-body").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const en = state.entries.find((x) => x.id === id);
    if (!en) return;
    if (btn.dataset.action === "view-entry") showBreakdown(en);
    if (btn.dataset.action === "edit-entry") {
      document.getElementById("e-editid").value = en.id;
      document.getElementById("e-member").value = en.memberId;
      document.getElementById("e-title").value = en.title;
      document.getElementById("e-type").value = en.type;
      document.getElementById("e-priority").value = en.priority;
      document.getElementById("e-initiative").value = en.initiative;
      document.getElementById("e-quality").value = en.quality === null || en.quality === undefined ? "" : en.quality;
      document.getElementById("e-est").value = en.estHours ?? "";
      document.getElementById("e-actual").value = en.actualHours ?? "";
      document.getElementById("e-date").value = en.date;
      document.getElementById("e-notes").value = en.notes || "";
      document.getElementById("e-submit").textContent = "Save changes";
      document.getElementById("e-cancel-edit").hidden = false;
      document.getElementById("form-entry").scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (btn.dataset.action === "delete-entry") {
      const ok = await confirmAction(`Delete the work-log entry "${en.title}"? This cannot be undone.`);
      if (!ok) return;
      state.entries = state.entries.filter((x) => x.id !== id);
      announce(`Deleted "${en.title}".`);
      renderAll();
    }
  });
}

/* -------------------------------------------------------------------------
   10. DEDUCTIONS: add / edit / delete
   ---------------------------------------------------------------------- */

function resetDeductionForm() {
  const form = document.getElementById("form-deduction");
  form.reset();
  document.getElementById("d-editid").value = "";
  document.getElementById("d-submit").textContent = "Record deduction";
  document.getElementById("d-cancel-edit").hidden = true;
  document.getElementById("d-date").value = todayISO();
  syncDeductionCategoryDefaults();
}

function syncDeductionCategoryDefaults() {
  const cat = document.getElementById("d-category").value;
  const preset = DEDUCTION_PRESETS[cat];
  const customWrap = document.getElementById("d-customlabel-wrap");
  if (cat === "custom") {
    customWrap.hidden = false;
    document.getElementById("d-customlabel").required = true;
  } else {
    customWrap.hidden = true;
    document.getElementById("d-customlabel").required = false;
  }
  if (preset && cat !== "custom") {
    document.getElementById("d-points").value = preset.points;
  }
}

function wireDeductionForm() {
  const form = document.getElementById("form-deduction");
  resetDeductionForm();

  document.getElementById("d-category").addEventListener("change", syncDeductionCategoryDefaults);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const editId = document.getElementById("d-editid").value;
    const cat = document.getElementById("d-category").value;
    const label = cat === "custom" ? document.getElementById("d-customlabel").value.trim() : DEDUCTION_PRESETS[cat].label;
    const payload = {
      memberId: document.getElementById("d-member").value,
      category: cat,
      label,
      points: Math.abs(Number(document.getElementById("d-points").value) || 0),
      note: document.getElementById("d-note").value.trim(),
      date: document.getElementById("d-date").value,
    };
    if (editId) {
      const d = state.deductions.find((x) => x.id === editId);
      Object.assign(d, payload);
      markTouched("deduction", editId);
      announce(`Saved changes to the deduction for ${memberName(payload.memberId)}.`);
    } else {
      const id = uid();
      state.deductions.push({ id, ...payload });
      markTouched("deduction", id);
      announce(`Recorded a ${payload.points}-point deduction for ${memberName(payload.memberId)}: ${payload.label}.`);
    }
    resetDeductionForm();
    renderAll();
  });

  document.getElementById("d-cancel-edit").addEventListener("click", resetDeductionForm);

  document.getElementById("deductions-body").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    const d = state.deductions.find((x) => x.id === id);
    if (!d) return;
    if (btn.dataset.action === "edit-deduction") {
      document.getElementById("d-editid").value = d.id;
      document.getElementById("d-member").value = d.memberId;
      document.getElementById("d-category").value = d.category;
      syncDeductionCategoryDefaults();
      if (d.category === "custom") document.getElementById("d-customlabel").value = d.label;
      document.getElementById("d-points").value = d.points;
      document.getElementById("d-note").value = d.note;
      document.getElementById("d-date").value = d.date;
      document.getElementById("d-submit").textContent = "Save changes";
      document.getElementById("d-cancel-edit").hidden = false;
      document.getElementById("form-deduction").scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (btn.dataset.action === "delete-deduction") {
      const ok = await confirmAction(`Remove this deduction (${d.label}, ${memberName(d.memberId)})?`);
      if (!ok) return;
      state.deductions = state.deductions.filter((x) => x.id !== id);
      announce(`Deduction removed.`);
      renderAll();
    }
  });
}

/* -------------------------------------------------------------------------
   11. PLAN AGREEMENTS: generate + print
   ---------------------------------------------------------------------- */

function wireAgreements() {
  document.getElementById("form-agreement").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (state.members.length === 0) {
      alert("Add at least one teammate before generating an agreement.");
      return;
    }
    const titleInput = document.getElementById("a-title");
    const ok = await confirmAction(
      "This freezes the CURRENT numbers (points, deductions, equity %) into a dated, read-only record. Live tracking keeps running below for the next review period. Continue?"
    );
    if (!ok) return;
    const { rows, founderPercent } = getEquityTable();
    state.agreements.push({
      id: uid(),
      title: titleInput.value.trim(),
      createdAt: new Date().toISOString(),
      founderName: state.settings.founderName || "Founder",
      founderPercent,
      companyName: state.settings.companyName,
      rows: rows.map((r) => ({ name: r.name, netPoints: r.netPoints, equityPercent: r.equityPercent })),
    });
    titleInput.value = "";
    announce("Plan Agreement generated and locked in.");
    renderAll();
  });

  document.getElementById("agreements-list").addEventListener("click", (e) => {
    const btn = e.target.closest('button[data-action="print-agreement"]');
    if (!btn) return;
    printAgreement(btn.dataset.id);
  });
}

function printAgreement(id) {
  const a = state.agreements.find((x) => x.id === id);
  if (!a) return;
  const rows = a.rows
    .map((r) => `<tr><td>${escapeHtml(r.name)}</td><td>${fmtPts(r.netPoints)}</td><td>${fmtPct(r.equityPercent)}</td></tr>`)
    .join("");
  document.getElementById("print-area").innerHTML = `
    <h1>${escapeHtml(a.companyName || "Equity Plan Agreement")}</h1>
    <h2>${escapeHtml(a.title || "Untitled agreement")}</h2>
    <p>Generated ${fmtDateTime(a.createdAt)}</p>
    <table border="1" cellpadding="6" style="border-collapse:collapse;width:100%">
      <thead><tr><th>Name</th><th>Net points</th><th>Equity %</th></tr></thead>
      <tbody>
        <tr><td>${escapeHtml(a.founderName)}</td><td>—</td><td>${fmtPct(a.founderPercent)}</td></tr>
        ${rows}
      </tbody>
    </table>
    <p style="margin-top:24px;font-size:0.85em">This is a points-derived allocation from an internal tracking tool, not a legal instrument. It should be executed through a formal shareholder/ESOP agreement drafted or reviewed by a qualified professional.</p>
    <p>Signature — Founder: ______________________&nbsp;&nbsp;&nbsp;&nbsp;Date: ______________</p>
  `;
  document.body.classList.add("is-printing");
  window.print();
}
window.addEventListener("afterprint", () => document.body.classList.remove("is-printing"));

/* -------------------------------------------------------------------------
   12. DATA & BACKUP: export / import / reset
   ---------------------------------------------------------------------- */

function wireDataTools() {
  document.getElementById("btn-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = todayISO();
    const name = (state.settings.companyName || "equity-ledger").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    a.href = url;
    a.download = `${name}-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    announce("Backup file downloaded.");
  });

  document.getElementById("file-import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      alert("That file isn't valid JSON — import cancelled.");
      e.target.value = "";
      return;
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.members)) {
      alert("That doesn't look like an Equity Ledger backup file — import cancelled.");
      e.target.value = "";
      return;
    }
    const ok = await confirmAction("Importing replaces everything currently in this ledger. Export a backup of the current data first if you're unsure. Continue?");
    e.target.value = "";
    if (!ok) return;
    const d = defaultState();
    state = {
      settings: { ...d.settings, ...(parsed.settings || {}) },
      members: Array.isArray(parsed.members) ? parsed.members : [],
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      deductions: Array.isArray(parsed.deductions) ? parsed.deductions : [],
      agreements: Array.isArray(parsed.agreements) ? parsed.agreements : [],
    };
    announce("Backup imported. All data replaced.");
    renderAll();
  });

  document.getElementById("btn-reset").addEventListener("click", async () => {
    const ok = await confirmAction("Erase ALL data in this ledger (teammates, work log, deductions, agreements)? Export a backup first if you want to keep a copy. This cannot be undone.");
    if (!ok) return;
    state = defaultState();
    announce("All data erased.");
    renderAll();
  });
}

/* -------------------------------------------------------------------------
   12b. INSIGHTS + OWNERSHIP STRIP: click-to-jump wiring
   These containers are rebuilt (innerHTML) on every render, so listeners
   are attached ONCE to the stable parent and delegated — never re-attached
   per render.
   ---------------------------------------------------------------------- */

function wireInsightsAndJumps() {
  document.getElementById("ownership-strip").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-jump-member]");
    if (btn) jumpToMemberLog(btn.dataset.jumpMember);
  });
  document.getElementById("ownership-legend").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-jump-member]");
    if (btn) jumpToMemberLog(btn.dataset.jumpMember);
  });
  document.getElementById("insights-row").addEventListener("click", (e) => {
    if (e.target.closest("#chip-pending")) jumpToPendingReview();
  });
  document.getElementById("never-logged-note").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-jump-log]");
    if (btn) jumpToLogFor(btn.dataset.jumpLog);
  });
}

/* -------------------------------------------------------------------------
   13. TABS (ARIA tabs pattern — click + arrow-key navigation)
   ---------------------------------------------------------------------- */

function wireTabs() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  function activate(tab) {
    tabs.forEach((t) => {
      const selected = t === tab;
      t.setAttribute("aria-selected", String(selected));
      t.tabIndex = selected ? 0 : -1;
      t.classList.toggle("active", selected);
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      panel.hidden = !selected;
    });
    tab.focus();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") activate(tabs[(i + 1) % tabs.length]);
      if (e.key === "ArrowLeft") activate(tabs[(i - 1 + tabs.length) % tabs.length]);
      if (e.key === "Home") activate(tabs[0]);
      if (e.key === "End") activate(tabs[tabs.length - 1]);
    });
  });
}

/* -------------------------------------------------------------------------
   14. INIT
   ---------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  wireTabs();
  wireCompanySetup();
  wireMemberForm();
  wireEntryForm();
  wireDeductionForm();
  wireAgreements();
  wireDataTools();
  wireInsightsAndJumps();
  renderAll();
});