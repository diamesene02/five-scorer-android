// Vanilla DOM UI for Five Scorer mobile app.
//
// State machine: pin -> setup -> live -> mvp -> done -> setup
// Plus a top-bar with sync badge always visible.

import { createId } from "@paralleldrive/cuid2";
import { APP_PIN } from "./config.js";
import {
  getRoster,
  addLocalGuest,
  createMatch,
  scoreGoal,
  undoLastGoalOf,
  finishMatch,
  getMatch,
  listMatches,
  deleteMatchLocal,
} from "./db.js";
import {
  initSync,
  pullRoster,
  drainOutbox,
  kickSync,
  subscribeSync,
} from "./sync.js";

// ---------------- helpers ----------------

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
};

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

let currentMatchId = null;
let pendingGoalAnim = null; // { team: 'A' | 'B' } — set just before a render that reflects a new goal

// ---------------- Sync badge ----------------

function renderSyncBadge() {
  const badge = $("#sync-badge");
  if (!badge) return;
  subscribeSync((s) => {
    let cls = "ok", txt = "Synchro OK";
    if (!s.online) { cls = "off"; txt = "Hors ligne"; }
    else if (s.syncing) { cls = "warn"; txt = "Sync…"; }
    else if (s.pending > 0) { cls = "warn"; txt = `${s.pending} à envoyer`; }

    // Preserve dot vs badge style (dot during live, badge elsewhere)
    const isDot = badge.classList.contains("sync-dot");
    if (isDot) {
      badge.className = "sync-dot " + cls;
      badge.textContent = "";
    } else {
      badge.className = "sync-badge " + cls;
      badge.textContent = txt;
    }
    badge.title = s.lastError || txt;
  });
  badge.onclick = () => drainOutbox();
}

// ---------------- Routing ----------------

const screens = ["pin", "setup", "live", "mvp", "done", "history"];
function show(name) {
  for (const s of screens) {
    const node = document.getElementById("screen-" + s);
    if (node) node.classList.toggle("active", s === name);
  }
  window.scrollTo(0, 0);
}

// ---------------- PIN ----------------

function renderPin() {
  const root = $("#screen-pin");
  root.innerHTML = "";
  root.appendChild(
    el("div", { class: "pin-card" }, [
      el("h1", {}, "Five Scorer"),
      el("p", { class: "muted" }, "Code d'accès"),
      el("input", {
        id: "pin-input",
        type: "tel",
        inputmode: "numeric",
        maxlength: "8",
        autofocus: "true",
        oninput: (e) => { e.target.value = e.target.value.replace(/\D/g, ""); },
        onkeydown: (e) => { if (e.key === "Enter") tryPin(); },
      }),
      el("button", { class: "btn primary big", onclick: tryPin }, "Entrer"),
      el("p", { id: "pin-error", class: "muted error", style: "min-height:1.2em" }, ""),
    ])
  );
  setTimeout(() => $("#pin-input")?.focus(), 50);
}

function tryPin() {
  const v = $("#pin-input").value.trim();
  if (!APP_PIN || v === APP_PIN) {
    sessionStorage.setItem("fs-unlocked", "1");
    return goSetup();
  }
  $("#pin-error").textContent = "Code invalide";
  $("#pin-input").value = "";
  $("#pin-input").focus();
}

// ---------------- Setup ----------------

const newSetup = () => ({
  teamAName: "Blanc",
  teamBName: "Noir",
  assignments: {}, // id -> 'A' | 'B'
});
let setup = newSetup();

async function goSetup() {
  setup = newSetup();
  updateTopbarForLive(false);
  show("setup");
  await renderSetup();
}

async function renderSetup() {
  const players = await getRoster();
  const root = $("#screen-setup");
  root.innerHTML = "";
  root.appendChild(
    el("div", { class: "wrap" }, [
      el("div", { class: "row gap" }, [
        el("input", {
          class: "team-input",
          value: setup.teamAName,
          oninput: (e) => { setup.teamAName = e.target.value; updateTallies(); },
        }),
        el("input", {
          class: "team-input",
          value: setup.teamBName,
          oninput: (e) => { setup.teamBName = e.target.value; updateTallies(); },
        }),
      ]),
      el("div", { class: "section-title" }, "Joueurs — tap : Aucun → A → B"),
      buildPlayerGrid(players),
      el("div", { class: "section-title" }, "Ajouter un invité"),
      el("div", { class: "row gap" }, [
        el("input", { id: "guest-input", placeholder: "Nom de l'invité" }),
        el("button", { class: "btn ghost", onclick: addGuestHandler }, "+ Ajouter"),
      ]),
      el("div", { id: "tallies", class: "muted center" }, ""),
      el("div", { class: "row gap" }, [
        el("button", { class: "btn ghost", onclick: () => goHistory() }, "📋 Historique"),
        el("button", {
          class: "btn primary big",
          onclick: startMatch,
        }, "Lancer le match"),
      ]),
    ])
  );
  updateTallies();
}

function buildPlayerGrid(players) {
  const grid = el("div", { class: "players" });
  const sorted = [...players].sort((a, b) => {
    if (a.isGuest !== b.isGuest) return a.isGuest ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  sorted.forEach((p) => {
    const a = setup.assignments[p.id];
    const card = el("button", {
      class: "pcard" + (a ? " " + a : ""),
      onclick: () => {
        const cur = setup.assignments[p.id];
        const next = !cur ? "A" : cur === "A" ? "B" : null;
        if (next) setup.assignments[p.id] = next;
        else delete setup.assignments[p.id];
        renderSetup();
      },
    }, [
      el("div", { class: "pcard-name" }, p.name + (p.isGuest ? "  (inv.)" : "")),
      el("div", { class: "pcard-team" }, !a ? "—" : a === "A" ? setup.teamAName : setup.teamBName),
    ]);
    grid.appendChild(card);
  });
  return grid;
}

function updateTallies() {
  const a = Object.values(setup.assignments).filter((v) => v === "A").length;
  const b = Object.values(setup.assignments).filter((v) => v === "B").length;
  const t = $("#tallies");
  if (t) t.textContent = `${setup.teamAName} : ${a} · ${setup.teamBName} : ${b}`;
}

async function addGuestHandler() {
  const input = $("#guest-input");
  const name = input.value.trim();
  if (!name) return;
  const id = createId();
  await addLocalGuest(id, name);
  setup.assignments[id] = "A";
  input.value = "";
  await renderSetup();
  kickSync();
}

async function startMatch() {
  const teamA = Object.entries(setup.assignments).filter(([, v]) => v === "A").map(([id]) => id);
  const teamB = Object.entries(setup.assignments).filter(([, v]) => v === "B").map(([id]) => id);
  if (!teamA.length || !teamB.length) {
    alert("Chaque équipe doit avoir au moins un joueur.");
    return;
  }
  const id = createId();
  await createMatch({
    id,
    playedAt: new Date().toISOString(),
    teamAName: setup.teamAName,
    teamBName: setup.teamBName,
    teamA, teamB,
  });
  currentMatchId = id;
  kickSync();
  goLive(id);
}

// ---------------- Live ----------------

async function goLive(matchId) {
  currentMatchId = matchId;
  show("live");
  updateTopbarForLive(true);
  await renderLive();
}

let matchStartTs = null;
let clockInterval = null;

function updateTopbarForLive(isLive) {
  const topbar = $(".topbar");
  const existingBtn = document.getElementById("btn-fin");
  if (existingBtn) existingBtn.remove();
  const existingLive = topbar.querySelector(".topbar-left");
  if (existingLive) existingLive.remove();

  if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }

  if (isLive) {
    // Left: LIVE dot + clock
    const clockEl = el("span", { class: "match-clock", id: "match-clock" }, "00:00");
    const left = el("div", { class: "topbar-left" }, [
      el("span", { class: "live-dot" }),
      el("span", {}, "LIVE"),
      clockEl,
    ]);
    topbar.insertBefore(left, topbar.firstChild);

    matchStartTs = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - matchStartTs) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      clockEl.textContent = `${mm}:${ss}`;
    };
    tick();
    clockInterval = setInterval(tick, 1000);

    // Right: Fin + sync dot
    let endDiv = topbar.querySelector(".topbar-end");
    if (!endDiv) {
      endDiv = el("div", { class: "topbar-end" });
      const badge = $("#sync-badge");
      if (badge) { badge.className = "sync-dot"; badge.textContent = ""; }
      topbar.appendChild(endDiv);
      if (badge) endDiv.appendChild(badge);
    }
    const btn = el("button", { class: "btn-fin", id: "btn-fin", onclick: confirmEnd }, "Fin");
    endDiv.insertBefore(btn, endDiv.firstChild);

    // Hide brand on live
    const brand = topbar.querySelector(".brand");
    if (brand) brand.style.display = "none";
  } else {
    // Restore brand + sync badge style
    const brand = topbar.querySelector(".brand");
    if (brand) brand.style.display = "";
    const badge = $("#sync-badge");
    if (badge) {
      badge.className = "sync-badge ok";
      if (!badge.textContent || badge.textContent === "") badge.textContent = "\u2026";
    }
  }
}

function confirmEnd() {
  const overlay = el("div", { class: "confirm-overlay" });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.appendChild(
    el("div", { class: "confirm-box" }, [
      el("h2", {}, "Terminer ce match ?"),
      el("div", { class: "row" }, [
        el("button", { class: "btn ghost", onclick: () => overlay.remove() }, "Annuler"),
        el("button", { class: "btn red", onclick: () => { overlay.remove(); goMvp(currentMatchId); } }, "Terminer"),
      ]),
    ])
  );
  document.body.appendChild(overlay);
}

function attachLongPress(btn, onTap, onLong) {
  let timer = null;
  let didLong = false;
  const start = () => {
    didLong = false;
    btn.classList.add("pressing");
    timer = setTimeout(() => {
      didLong = true;
      btn.classList.remove("pressing");
      if (navigator.vibrate) navigator.vibrate(30);
      onLong();
    }, 500);
  };
  const cancel = () => {
    clearTimeout(timer);
    btn.classList.remove("pressing");
  };
  const end = (e) => {
    clearTimeout(timer);
    btn.classList.remove("pressing");
    if (!didLong) onTap();
    e.preventDefault();
  };
  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", end);
  btn.addEventListener("pointerleave", cancel);
  btn.addEventListener("pointercancel", cancel);
}

const BALL_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm0 2a7.94 7.94 0 0 1 5 1.78l-1.58 1.14-3.42-1.1Zm-7.8 6.24L5.9 9l1.3 3.94-1 .73-2-2.9Zm4.16 8.26-1.1-3.4L9 12.5l3 2.2v1.7Zm3.64.44v-1.76l3-2.2 1.74 1.04-1.1 3.4a7.93 7.93 0 0 1-3.64-.48Zm6.07-2.18-2-2.9 1.3-3.94 1.7 1.24a7.93 7.93 0 0 1-1 5.6Z"/></svg>';

function buildPlayerTile(p) {
  const btn = el("button", { class: "tile-plus" }, "+1");
  const goalsEl = el("span", { class: "tile-goals" }, p.goals > 0 ? String(p.goals) : "");

  const goalsWrap = el("div", { class: "tile-goals-wrap" }, [
    p.goals > 0 ? el("span", { class: "tile-ball", html: BALL_SVG }) : null,
    goalsEl,
  ].filter(Boolean));

  const body = el("div", { class: "tile-body" }, [
    el("div", { class: "tile-name" }, p.name),
    goalsWrap,
  ]);

  attachLongPress(btn,
    async () => {
      try {
        if (navigator.vibrate) navigator.vibrate(12);
        pendingGoalAnim = { team: p.team };
        await scoreGoal({ id: createId(), matchId: currentMatchId, scorerId: p.id, createdAt: new Date().toISOString() });
        kickSync();
        renderLive();
      } catch (e) { alert(e.message || e); }
    },
    async () => {
      if (p.goals <= 0) return;
      try {
        const removed = await undoLastGoalOf(currentMatchId, p.id);
        if (!removed) return;
        kickSync();
        renderLive();
      } catch (e) { alert(e.message || e); }
    }
  );

  // Layout: accent bar position depends on team (A=left, B=right)
  const accent = el("div", { class: "tile-accent" });
  const parts = p.team === "A" ? [accent, body, btn] : [btn, body, accent];
  return el("div", { class: "tile " + p.team }, parts);
}

async function renderLive() {
  const root = $("#screen-live");
  if (!currentMatchId) { goSetup(); return; }
  const data = await getMatch(currentMatchId);
  if (!data) { goSetup(); return; }
  const { match, teamA, teamB } = data;
  if (match.status === "FINISHED") return goDone(currentMatchId);

  root.textContent = "";

  const aLead = match.scoreA > match.scoreB;
  const bLead = match.scoreB > match.scoreA;
  const scoreA = el("span", { class: "score" + (aLead ? " leading A" : "") }, String(match.scoreA));
  const scoreB = el("span", { class: "score" + (bLead ? " leading B" : "") }, String(match.scoreB));

  root.appendChild(
    el("header", { class: "scorebar" }, [
      el("div", { class: "scorebar-team A" }, [
        el("div", { class: "team-chip A" }, match.teamAName),
      ]),
      el("div", { class: "scoreboard" }, [
        scoreA,
        el("span", { class: "sep" }, ":"),
        scoreB,
      ]),
      el("div", { class: "scorebar-team B" }, [
        el("div", { class: "team-chip B" }, match.teamBName),
      ]),
    ])
  );

  const sortedA = [...teamA].sort((a, b) => a.name.localeCompare(b.name));
  const sortedB = [...teamB].sort((a, b) => a.name.localeCompare(b.name));
  const isLandscape = window.innerWidth > window.innerHeight;

  if (isLandscape) {
    const colA = el("div", { class: "team-col" }, [
      el("div", { class: "team-header A" }, match.teamAName),
      ...sortedA.map((p) => buildPlayerTile(p)),
    ]);
    const colB = el("div", { class: "team-col" }, [
      el("div", { class: "team-header B" }, match.teamBName),
      ...sortedB.map((p) => buildPlayerTile(p)),
    ]);
    root.appendChild(el("div", { class: "live-teams" }, [colA, colB]));
  } else {
    const grid = el("div", { class: "live-grid" });
    [...sortedA, ...sortedB].forEach((p) => grid.appendChild(buildPlayerTile(p)));
    root.appendChild(el("div", { class: "wrap" }, grid));
  }

  // Fire goal animations if a goal was just scored
  if (pendingGoalAnim) {
    const team = pendingGoalAnim.team;
    pendingGoalAnim = null;
    requestAnimationFrame(() => {
      const scoreEl = team === "A" ? scoreA : scoreB;
      if (scoreEl) {
        scoreEl.classList.add("goaled");
        setTimeout(() => scoreEl.classList.remove("goaled"), 600);
      }
    });
  }
}

// ---------------- MVP ----------------

let mvpSel = null;
async function goMvp(matchId) {
  currentMatchId = matchId;
  mvpSel = null;
  show("mvp");
  await renderMvp();
}
async function renderMvp() {
  const data = await getMatch(currentMatchId);
  if (!data) return goSetup();
  const root = $("#screen-mvp");
  root.innerHTML = "";
  const all = [...data.teamA, ...data.teamB].sort((a, b) => a.name.localeCompare(b.name));
  const grid = el("div", { class: "mvp-grid" });
  all.forEach((p) => {
    grid.appendChild(
      el("button", {
        class: "mvp-cell" + (mvpSel === p.id ? " sel" : ""),
        onclick: () => { mvpSel = mvpSel === p.id ? null : p.id; renderMvp(); },
      }, p.name)
    );
  });
  root.appendChild(
    el("div", { class: "wrap" }, [
      el("h1", {}, "MVP du match ?"),
      grid,
      el("div", { class: "row gap" }, [
        el("button", { class: "btn ghost big", onclick: () => confirmFinish(null) }, "Pas de MVP"),
        el("button", { class: "btn primary big", onclick: () => confirmFinish(mvpSel) }, "Valider"),
      ]),
    ])
  );
}
async function confirmFinish(mvpId) {
  await finishMatch(currentMatchId, mvpId);
  kickSync();
  goDone(currentMatchId);
}

// ---------------- Done / Recap ----------------

async function goDone(matchId) {
  currentMatchId = matchId;
  show("done");
  const data = await getMatch(matchId);
  const root = $("#screen-done");
  root.innerHTML = "";
  if (!data) { root.appendChild(el("p", {}, "Match introuvable")); return; }
  const { match, teamA, teamB, goals } = data;
  const all = [...teamA, ...teamB];
  const goalCount = {};
  goals.forEach((g) => { goalCount[g.scorerId] = (goalCount[g.scorerId] || 0) + 1; });
  const scorers = all
    .filter((p) => goalCount[p.id])
    .sort((a, b) => goalCount[b.id] - goalCount[a.id]);
  const mvp = match.mvpId ? all.find((p) => p.id === match.mvpId) : null;

  root.appendChild(
    el("div", { class: "wrap" }, [
      el("h1", {}, "Match terminé"),
      el("div", { class: "final-pill" },
        `${match.teamAName}  ${match.scoreA}  —  ${match.scoreB}  ${match.teamBName}`),
      mvp ? el("div", { class: "mvp-line" }, [
        el("span", { class: "tag mvp" }, "MVP"), " " + mvp.name,
      ]) : null,
      el("div", { class: "section-title" }, "Buteurs"),
      el("div", { class: "event-list" },
        scorers.length
          ? scorers.map((p) => el("div", { class: "ev" }, [
              el("span", {}, [
                el("span", { class: "tag " + p.team }, p.team === "A" ? match.teamAName : match.teamBName),
                " " + p.name,
              ]),
              el("strong", {}, String(goalCount[p.id])),
            ]))
          : el("div", { class: "muted pad" }, "Aucun but.")
      ),
      el("div", { class: "row gap" }, [
        el("button", { class: "btn ghost big", onclick: goSetup }, "Nouveau match"),
        el("button", { class: "btn ghost big", onclick: goHistory }, "Historique"),
      ]),
    ])
  );
}

// ---------------- History ----------------

async function goHistory() {
  show("history");
  const matches = await listMatches();
  const root = $("#screen-history");
  root.innerHTML = "";
  root.appendChild(
    el("div", { class: "wrap" }, [
      el("h1", {}, "Historique"),
      matches.length === 0
        ? el("p", { class: "muted" }, "Aucun match.")
        : el("div", { class: "event-list" },
            matches.map((m) =>
              el("div", { class: "ev clickable", onclick: () => openHistoryItem(m.id) }, [
                el("div", {}, [
                  el("div", { class: "ev-title" },
                    `${m.teamAName} ${m.scoreA} - ${m.scoreB} ${m.teamBName}`),
                  el("div", { class: "muted small" },
                    new Date(m.playedAt).toLocaleDateString("fr-FR", {
                      weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
                    }) + (m.status === "LIVE" ? " · en cours" : "")),
                ]),
                el("span", { class: "tag " + (m.status === "LIVE" ? "warn" : "ok") }, m.status),
              ])
            )
          ),
      el("button", { class: "btn ghost big", onclick: goSetup }, "← Retour"),
    ])
  );
}

function openHistoryItem(id) {
  currentMatchId = id;
  goDone(id);
}

// ---------------- Boot ----------------

export async function boot() {
  // Build static screens shells
  const app = $("#app");
  if (!app.dataset.built) {
    app.innerHTML = `
      <header class="topbar">
        <div class="brand">⚽ Five Scorer</div>
        <button id="sync-badge" class="sync-badge ok">…</button>
      </header>
      <main>
        <section id="screen-pin" class="screen"></section>
        <section id="screen-setup" class="screen"></section>
        <section id="screen-live" class="screen"></section>
        <section id="screen-mvp" class="screen"></section>
        <section id="screen-done" class="screen"></section>
        <section id="screen-history" class="screen"></section>
      </main>
    `;
    app.dataset.built = "1";
  }

  initSync();
  renderSyncBadge();

  // PIN gate (session-scoped)
  if (APP_PIN && sessionStorage.getItem("fs-unlocked") !== "1") {
    show("pin");
    renderPin();
  } else {
    show("setup");
    await renderSetup();
  }

  // Hydrate roster from network when possible (background)
  pullRoster();
}
