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

// ---------------- Sync badge ----------------

function renderSyncBadge() {
  const badge = $("#sync-badge");
  if (!badge) return;
  subscribeSync((s) => {
    let cls = "ok", txt = "Synchro OK";
    if (!s.online) { cls = "off"; txt = "Hors ligne"; }
    else if (s.syncing) { cls = "warn"; txt = "Sync…"; }
    else if (s.pending > 0) { cls = "warn"; txt = `${s.pending} à envoyer`; }
    badge.className = "sync-badge " + cls;
    badge.textContent = txt;
    badge.title = s.lastError || "";
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
  await renderLive();
}

async function renderLive() {
  const root = $("#screen-live");
  if (!currentMatchId) { goSetup(); return; }
  const data = await getMatch(currentMatchId);
  if (!data) { goSetup(); return; }
  const { match, teamA, teamB } = data;
  if (match.status === "FINISHED") return goDone(currentMatchId);

  root.innerHTML = "";
  root.appendChild(
    el("header", { class: "scorebar" }, [
      el("div", { class: "col" }, [
        el("div", { class: "tn-a" }, match.teamAName),
        el("div", { class: "score" }, String(match.scoreA)),
      ]),
      el("div", { class: "sep" }, "—"),
      el("div", { class: "col" }, [
        el("div", { class: "tn-b" }, match.teamBName),
        el("div", { class: "score" }, String(match.scoreB)),
      ]),
    ])
  );

  const grid = el("div", { class: "live-grid" });
  [...teamA, ...teamB]
    .sort((a, b) => a.team.localeCompare(b.team) || a.name.localeCompare(b.name))
    .forEach((p) => {
      grid.appendChild(
        el("div", { class: "tile " + p.team }, [
          el("div", { class: "tile-name" }, [
            p.name,
            el("span", { class: "tag " + p.team }, p.team === "A" ? match.teamAName : match.teamBName),
          ]),
          el("div", { class: "tile-goals" }, String(p.goals)),
          el("div", { class: "row gap" }, [
            el("button", {
              class: "btn primary tile-plus",
              onclick: async () => {
                try {
                  await scoreGoal({
                    id: createId(),
                    matchId: currentMatchId,
                    scorerId: p.id,
                    createdAt: new Date().toISOString(),
                  });
                  kickSync();
                  renderLive();
                } catch (e) { alert(e.message || e); }
              },
            }, "+1"),
            el("button", {
              class: "btn ghost tile-minus",
              onclick: async () => {
                try {
                  const removed = await undoLastGoalOf(currentMatchId, p.id);
                  if (!removed) return;
                  kickSync();
                  renderLive();
                } catch (e) { alert(e.message || e); }
              },
            }, "−"),
          ]),
        ])
      );
    });
  root.appendChild(el("div", { class: "wrap" }, grid));

  root.appendChild(
    el("footer", { class: "actionbar" }, [
      el("button", {
        class: "btn red big",
        onclick: () => goMvp(currentMatchId),
      }, "Terminer le match"),
    ])
  );
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
