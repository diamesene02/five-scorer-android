// Vanilla DOM UI for Five Scorer mobile app.
//
// State machine: pin -> setup -> live -> mvp -> done -> setup
// Plus a top-bar with sync badge always visible.

import { createId } from "@paralleldrive/cuid2";
import { APP_PIN } from "./config.js";
import {
  db,
  getRoster,
  addLocalGuest,
  createMatch,
  scoreGoal,
  setAssist,
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
import { unlockAudio, playGoalSound, playUndoSound, isSoundEnabled, toggleSound } from "./audio.js";
import { renderShareCard } from "./shareCard.js";
import { computeMvp } from "./mvp.js";

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

const screens = ["pin", "home", "setup", "live", "mvp", "done", "history"];
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
    return goHome();
  }
  $("#pin-error").textContent = "Code invalide";
  $("#pin-input").value = "";
  $("#pin-input").focus();
}

// ---------------- Home (dashboard) ----------------

async function goHome() {
  updateTopbarForLive(false);
  show("home");
  await renderHome();
}

async function renderHome() {
  const root = $("#screen-home");
  root.textContent = "";

  // Load all matches, enrich
  const matches = await listMatches(30);
  const finished = matches.filter((m) => m.status === "FINISHED");
  const live = matches.find((m) => m.status === "LIVE") || null;
  const hero = finished[0];
  const rest = finished.slice(1, 6);

  // Aggregate season stats
  let totalGoals = 0;
  const scorerStats = {};
  for (const m of finished) {
    totalGoals += (m.scoreA || 0) + (m.scoreB || 0);
  }
  // Compute top scorers from local goal data
  const allGoals = await db.goals.toArray();
  const matchIdSet = new Set(finished.map((m) => m.id));
  for (const g of allGoals) {
    if (!matchIdSet.has(g.matchId)) continue;
    scorerStats[g.scorerId] = scorerStats[g.scorerId] || { goals: 0, assists: 0 };
    scorerStats[g.scorerId].goals++;
    if (g.assistId) {
      scorerStats[g.assistId] = scorerStats[g.assistId] || { goals: 0, assists: 0 };
      scorerStats[g.assistId].assists++;
    }
  }
  const scorerIds = Object.keys(scorerStats);
  const rosterList = scorerIds.length ? await db.roster.bulkGet(scorerIds) : [];
  const rosterById = new Map();
  rosterList.forEach((p) => p && rosterById.set(p.id, p));
  const topScorers = scorerIds
    .map((id) => ({
      id,
      name: rosterById.get(id)?.name || "?",
      goals: scorerStats[id].goals,
      assists: scorerStats[id].assists,
      ga: scorerStats[id].goals + scorerStats[id].assists,
    }))
    .filter((x) => rosterById.has(x.id))
    .sort((a, b) => b.ga - a.ga || b.goals - a.goals)
    .slice(0, 5);

  const now = new Date();
  const weekday = now.toLocaleDateString("fr-FR", { weekday: "long" }).toUpperCase();
  const dateShort = now.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
  }).toUpperCase();
  const seq = String(finished.length + 1).padStart(3, "0");

  // ---- Masthead ----
  root.appendChild(
    el("section", { class: "home-hero" }, [
      el("div", { class: "row", style: "margin-bottom: 4px; gap: 8px" }, [
        el("span", { class: "label-tech" }, "\u2691"),
        el("span", { class: "seq" }, "N\u00B0" + seq),
        el("span", { class: "label-tech" }, "\u00B7"),
        el("span", { class: "seq" }, weekday),
        el("span", { class: "label-tech", style: "margin-left: auto" }, dateShort),
      ]),
      el("div", { style: "line-height:1; margin-top: 4px" }, [
        el("span", { class: "display-xl", style: "display: inline" }, "Five"),
        el("span", {
          style: "margin-left: 10px; font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.3em; text-transform: uppercase; color: var(--ink-1); vertical-align: middle",
        }, "Scorer"),
      ]),
      el("p", {
        style: "margin: 10px 0 0; font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-2); line-height: 1.5",
      }, "Console de notation \u00B7 Match op\u00E9rations"),
    ])
  );

  // ---- Live strap ----
  if (live) {
    const lastScore = `${live.scoreA} : ${live.scoreB}`;
    const strap = el("div", {
      class: "home-live-strap",
      onclick: () => { currentMatchId = live.id; goLive(live.id); },
    }, [
      el("span", { class: "live-marker" }, "En cours"),
      el("span", {
        class: "num",
        style: "font-size: 22px; font-weight: 500",
      }, lastScore),
      el("span", {
        style: "font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--amber)",
      }, "Reprendre \u2192"),
    ]);
    root.appendChild(strap);
  }

  // ---- Season stats row ----
  root.appendChild(
    el("div", { class: "home-stats-row" }, [
      el("div", { class: "home-stat" }, [
        el("div", { class: "val" }, String(finished.length)),
        el("div", { class: "lbl" }, "Matchs"),
      ]),
      el("div", { class: "home-stat" }, [
        el("div", { class: "val accent" }, String(totalGoals)),
        el("div", { class: "lbl" }, "Buts"),
      ]),
      el("div", { class: "home-stat" }, [
        el("div", { class: "val" }, finished.length ? (totalGoals / finished.length).toFixed(1) : "—"),
        el("div", { class: "lbl" }, "Moy."),
      ]),
    ])
  );

  // ---- Last match poster ----
  if (hero) {
    const winA = hero.scoreA > hero.scoreB;
    const winB = hero.scoreB > hero.scoreA;
    const draw = hero.scoreA === hero.scoreB;
    const lastMatchData = await getMatch(hero.id);
    const mvpPlayer = hero.mvpId
      ? [...(lastMatchData?.teamA || []), ...(lastMatchData?.teamB || [])].find((p) => p.id === hero.mvpId)
      : null;

    const section = el("section", { class: "home-section" });
    section.appendChild(
      el("div", { class: "home-section-title" }, [
        el("span", { class: "label-tech" }, "— Dernier match"),
        el("span", { class: "seq" },
          new Date(hero.playedAt).toLocaleDateString("fr-FR", {
            weekday: "short", day: "2-digit", month: "short",
          }).toUpperCase()),
      ])
    );
    const posterWrap = el("div", { onclick: () => goDone(hero.id), style: "cursor: pointer" });
    posterWrap.appendChild(
      el("div", { class: "home-last-match" }, [
        el("div", { style: "text-align: right" }, [
          el("div", { class: "team-label A" }, hero.teamAName.toUpperCase()),
          el("div", {
            class: "score-big " + (winA ? "win" : draw ? "neutral" : "lose"),
          }, String(hero.scoreA)),
        ]),
        el("div", { class: "vs" }, "vs"),
        el("div", { style: "text-align: left" }, [
          el("div", { class: "team-label B" }, hero.teamBName.toUpperCase()),
          el("div", {
            class: "score-big " + (winB ? "win" : draw ? "neutral" : "lose"),
          }, String(hero.scoreB)),
        ]),
      ])
    );
    if (mvpPlayer) {
      posterWrap.appendChild(
        el("div", { class: "home-mvp-line" }, [
          el("div", { class: "lbl" }, "MVP"),
          el("div", { class: "name" }, mvpPlayer.name),
        ])
      );
    }
    section.appendChild(posterWrap);
    root.appendChild(section);
  }

  // ---- Top scorers ----
  if (topScorers.length > 0) {
    const section = el("section", { class: "home-section home-top-scorers" });
    section.appendChild(
      el("div", { class: "home-section-title" }, [
        el("span", { class: "label-tech" }, "— Top buteurs"),
        el("button", {
          class: "more",
          onclick: () => alert("Classement complet : voir sur le site web"),
        }, "Complet \u2192"),
      ])
    );
    topScorers.forEach((p, i) => {
      section.appendChild(
        el("div", { class: "leader" }, [
          el("span", {
            style: "font-family: var(--font-mono); font-size: 10px; color: var(--ink-2); min-width: 18px",
          }, String(i + 1).padStart(2, "0")),
          el("span", {
            style: "font-family: var(--font-mono); font-size: 12px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em",
          }, p.name),
          el("span", { class: "leader-dots" }),
          el("span", {
            style: "font-family: var(--font-mono); font-size: 11px; color: var(--ink-2)",
          }, `${p.goals}B·${p.assists}P`),
          el("span", {
            style: "font-family: var(--font-mono); font-size: 14px; font-weight: 600; color: var(--amber); min-width: 24px; text-align: right",
          }, String(p.ga)),
        ])
      );
    });
    root.appendChild(section);
  }

  // ---- Recent matches ----
  if (rest.length > 0) {
    const section = el("section", { class: "home-section" });
    section.appendChild(
      el("div", { class: "home-section-title" }, [
        el("span", { class: "label-tech" }, "— Archives"),
        el("button", { class: "more", onclick: goHistory }, "Tout \u2192"),
      ])
    );
    rest.forEach((m, i) => {
      const winA = m.scoreA > m.scoreB;
      const winB = m.scoreB > m.scoreA;
      section.appendChild(
        el("div", {
          class: "home-recent-row",
          onclick: () => goDone(m.id),
        }, [
          el("span", { class: "seq-col" }, String(i + 2).padStart(3, "0")),
          el("span", { class: "date-col" },
            new Date(m.playedAt).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" })),
          el("span", { class: "teams-col" },
            `${m.teamAName} \u00D7 ${m.teamBName}`),
          el("span", { class: "score-col" }, [
            el("span", { class: winA ? "win" : "lose" }, String(m.scoreA)),
            el("span", { class: "sep" }, ":"),
            el("span", { class: winB ? "win" : "lose" }, String(m.scoreB)),
          ]),
        ])
      );
    });
    root.appendChild(section);
  }

  // ---- Actions ----
  root.appendChild(
    el("div", { class: "home-actions" }, [
      el("button", { class: "btn primary big", onclick: goSetup }, "\u2691  Nouveau match"),
      el("button", { class: "btn ghost big", onclick: goHistory }, "Archives"),
    ])
  );

  // ---- Footer ----
  root.appendChild(
    el("footer", { class: "home-footer" },
      "Five Scorer \u00B7 Console v2 \u00B7 Jeudi 21H")
  );
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
        el("button", { class: "btn ghost", onclick: goHome }, "← Accueil"),
        el("button", {
          class: "btn primary big",
          onclick: startMatch,
        }, "⚑  Lancer"),
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
let clockPausedAt = null; // timestamp when paused (null = not paused)
let clockPausedMs = 0; // accumulated paused ms

function updateTopbarForLive(isLive) {
  const topbar = $(".topbar");
  ["btn-fin", "btn-sound", "btn-pause"].forEach((id) => {
    const n = document.getElementById(id);
    if (n) n.remove();
  });
  const existingLive = topbar.querySelector(".topbar-left");
  if (existingLive) existingLive.remove();

  if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }

  if (isLive) {
    // Left: LIVE dot + clock + pause btn
    const clockEl = el("span", { class: "match-clock", id: "match-clock" }, "00:00");
    const pauseBtn = el("button", { class: "icon-btn", id: "btn-pause", title: "Pause", onclick: togglePause }, [
      el("span", { id: "pause-icon" }, "\u23F8")
    ]);
    const liveDot = el("span", { class: "live-dot", id: "live-dot" });
    const left = el("div", { class: "topbar-left" }, [
      liveDot,
      el("span", { id: "live-label" }, "LIVE"),
      clockEl,
      pauseBtn,
    ]);
    topbar.insertBefore(left, topbar.firstChild);

    matchStartTs = Date.now();
    clockPausedAt = null;
    clockPausedMs = 0;
    const tick = () => {
      if (clockPausedAt) return;
      const s = Math.floor((Date.now() - matchStartTs - clockPausedMs) / 1000);
      const mm = String(Math.floor(s / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      clockEl.textContent = `${mm}:${ss}`;
    };
    tick();
    clockInterval = setInterval(tick, 1000);

    // Right: Sound + Fin + sync dot
    let endDiv = topbar.querySelector(".topbar-end");
    if (!endDiv) {
      endDiv = el("div", { class: "topbar-end" });
      const badge = $("#sync-badge");
      if (badge) { badge.className = "sync-dot"; badge.textContent = ""; }
      topbar.appendChild(endDiv);
      if (badge) endDiv.appendChild(badge);
    }
    const soundBtn = el("button", {
      class: "icon-btn",
      id: "btn-sound",
      title: "Son",
      onclick: () => {
        const on = toggleSound();
        soundBtn.textContent = on ? "\uD83D\uDD0A" : "\uD83D\uDD07";
      },
    }, isSoundEnabled() ? "\uD83D\uDD0A" : "\uD83D\uDD07");
    const btn = el("button", { class: "btn-fin", id: "btn-fin", onclick: confirmEnd }, "Fin");
    endDiv.insertBefore(btn, endDiv.firstChild);
    endDiv.insertBefore(soundBtn, btn);

    const brand = topbar.querySelector(".brand");
    if (brand) brand.style.display = "none";
  } else {
    const brand = topbar.querySelector(".brand");
    if (brand) brand.style.display = "";
    const badge = $("#sync-badge");
    if (badge) {
      badge.className = "sync-badge ok";
      if (!badge.textContent || badge.textContent === "") badge.textContent = "\u2026";
    }
  }
}

function togglePause() {
  const pauseIcon = document.getElementById("pause-icon");
  const liveDot = document.getElementById("live-dot");
  const liveLabel = document.getElementById("live-label");
  if (clockPausedAt) {
    // Resume
    clockPausedMs += Date.now() - clockPausedAt;
    clockPausedAt = null;
    if (pauseIcon) pauseIcon.textContent = "\u23F8";
    if (liveDot) liveDot.style.animation = "";
    if (liveLabel) liveLabel.textContent = "LIVE";
  } else {
    // Pause
    clockPausedAt = Date.now();
    if (pauseIcon) pauseIcon.textContent = "\u25B6";
    if (liveDot) liveDot.style.animation = "none";
    if (liveLabel) liveLabel.textContent = "PAUSE";
  }
}

async function showAssistPicker(goalId, scorer) {
  const data = await getMatch(currentMatchId);
  if (!data) return;
  const teammates = (scorer.team === "A" ? data.teamA : data.teamB).filter((p) => p.id !== scorer.id);
  if (teammates.length === 0) return;

  const overlay = el("div", { class: "assist-overlay", id: "assist-picker" });
  const box = el("div", { class: "assist-box" });
  box.appendChild(
    el("div", { class: "assist-title" }, [
      el("span", { class: "tag " + scorer.team }, "BUT"),
      el("span", {}, " " + scorer.name + " — passeur ?"),
    ])
  );

  const chips = el("div", { class: "assist-chips" });
  teammates.forEach((p) => {
    chips.appendChild(
      el("button", {
        class: "assist-chip " + scorer.team,
        onclick: async () => {
          try {
            await setAssist(goalId, p.id);
            kickSync();
          } catch (_) {}
          overlay.remove();
        },
      }, p.name)
    );
  });
  box.appendChild(chips);

  const skipBtn = el("button", {
    class: "btn ghost assist-skip",
    onclick: () => overlay.remove(),
  }, "Aucune passe");
  box.appendChild(skipBtn);

  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  // No auto-dismiss: user picks, skips, or taps outside
}

function confirmEnd() {
  const overlay = el("div", { class: "confirm-overlay" });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.appendChild(
    el("div", { class: "confirm-box" }, [
      el("h2", {}, "Fin du match"),
      el("p", { class: "muted", style: "margin:0 0 16px" }, "Terminer et sauvegarder, ou annuler tout ?"),
      el("div", { class: "row", style: "gap: 8px" }, [
        el("button", { class: "btn ghost", onclick: () => overlay.remove() }, "Retour"),
        el("button", {
          class: "btn",
          style: "background: var(--bg-2); color: var(--live); border: 1px solid var(--live)",
          onclick: () => { overlay.remove(); confirmCancelMatch(); },
        }, "Annuler match"),
        el("button", { class: "btn red", onclick: () => { overlay.remove(); goMvp(currentMatchId); } }, "Terminer"),
      ]),
    ])
  );
  document.body.appendChild(overlay);
}

function confirmCancelMatch() {
  const overlay = el("div", { class: "confirm-overlay" });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.appendChild(
    el("div", { class: "confirm-box" }, [
      el("h2", {}, "Annuler ce match ?"),
      el("p", { class: "muted", style: "margin:0 0 16px" }, "Toutes les données du match seront supprimées. Irréversible."),
      el("div", { class: "row", style: "gap: 8px" }, [
        el("button", { class: "btn ghost", onclick: () => overlay.remove() }, "Retour"),
        el("button", {
          class: "btn red",
          onclick: async () => {
            overlay.remove();
            try {
              await deleteMatchLocal(currentMatchId);
              kickSync();
              currentMatchId = null;
              goSetup();
            } catch (e) {
              alert("Erreur : " + (e.message || e));
            }
          },
        }, "Oui, annuler"),
      ]),
    ])
  );
  document.body.appendChild(overlay);
}

// Module-level guard: after a long-press fires, any pointerup within
// `SUPPRESS_TAP_MS` is swallowed. This prevents the "release adds a goal"
// bug caused by renderLive() destroying the original button mid-press.
let suppressTapUntil = 0;
const SUPPRESS_TAP_MS = 700;

function attachLongPress(btn, onTap, onLong) {
  let timer = null;
  let didLong = false;
  const start = (e) => {
    didLong = false;
    btn.classList.add("pressing");
    // Capture pointer so pointerup reliably fires on this element
    if (e && e.pointerId !== undefined && btn.setPointerCapture) {
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    }
    timer = setTimeout(() => {
      didLong = true;
      suppressTapUntil = Date.now() + SUPPRESS_TAP_MS;
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
    if (!didLong && Date.now() >= suppressTapUntil) onTap();
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
        unlockAudio();
        if (navigator.vibrate) navigator.vibrate(12);
        playGoalSound();
        pendingGoalAnim = { team: p.team };
        const goalId = createId();
        await scoreGoal({ id: goalId, matchId: currentMatchId, scorerId: p.id, createdAt: new Date().toISOString() });
        kickSync();
        renderLive();
        // Show assist picker (non-blocking, auto-dismisses)
        showAssistPicker(goalId, p);
      } catch (e) { alert(e.message || e); }
    },
    async () => {
      if (p.goals <= 0) return;
      try {
        const removed = await undoLastGoalOf(currentMatchId, p.id);
        if (!removed) return;
        playUndoSound();
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
  root.textContent = "";

  const all = [...data.teamA, ...data.teamB];
  const suggested = computeMvp({ match: data.match, players: all });

  // Pre-select the suggested MVP if nothing picked yet
  if (mvpSel == null && suggested) {
    mvpSel = suggested.id;
  }

  const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name));
  const grid = el("div", { class: "mvp-grid" });
  sorted.forEach((p) => {
    const isSel = mvpSel === p.id;
    const isSuggested = suggested && suggested.id === p.id;
    const cell = el("button", {
      class: "mvp-cell" + (isSel ? " sel" : "") + (isSuggested ? " suggested" : ""),
      onclick: () => { mvpSel = mvpSel === p.id ? null : p.id; renderMvp(); },
    }, [
      isSuggested ? el("span", { class: "mvp-badge" }, "\u2B50 Sugg\u00E9r\u00E9") : null,
      el("div", { class: "mvp-name" }, p.name),
      p.goals || p.assists ? el("div", { class: "mvp-stat" },
        [
          p.goals ? `${p.goals}B` : "",
          p.assists ? `${p.assists}P` : "",
        ].filter(Boolean).join(" · ")
      ) : null,
    ]);
    grid.appendChild(cell);
  });

  root.appendChild(
    el("div", { class: "wrap" }, [
      el("div", { class: "kicker", style: "margin-top: 16px" }, "Fin du match"),
      el("h1", { style: "margin: 6px 0 4px; font-size: 28px; letter-spacing: -0.02em" }, "Qui est MVP ?"),
      suggested
        ? el("p", { class: "muted", style: "margin: 0 0 12px" },
            "Suggestion : " + suggested.name +
            " (" + suggested.goals + "B" + (suggested.assists ? " · " + suggested.assists + "P" : "") + ")")
        : el("p", { class: "muted", style: "margin: 0 0 12px" }, "Aucun buteur — choisis manuellement ou passe."),
      grid,
      el("div", { class: "row gap", style: "margin-top: 12px" }, [
        el("button", { class: "btn ghost big", onclick: () => confirmFinish(null) }, "Pas de MVP"),
        el("button", { class: "btn primary big", onclick: () => confirmFinish(mvpSel) }, "Valider"),
      ]),
    ])
  );
}
async function confirmFinish(mvpId) {
  // Final confirmation dialog with match summary before sending to server
  const data = await getMatch(currentMatchId);
  if (!data) return;
  const { match } = data;
  const mvpPlayer = mvpId ? [...data.teamA, ...data.teamB].find((p) => p.id === mvpId) : null;

  const overlay = el("div", { class: "confirm-overlay" });
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.appendChild(
    el("div", { class: "confirm-box", style: "max-width: 360px" }, [
      el("h2", {}, "Envoyer le résultat ?"),
      el("div", { style: "margin: 8px 0 16px; text-align:center" }, [
        el("div", { style: "font-family: var(--font-mono); font-size: 32px; font-weight: 800; letter-spacing: -0.02em" },
          `${match.teamAName}  ${match.scoreA} : ${match.scoreB}  ${match.teamBName}`),
        mvpPlayer
          ? el("div", { style: "margin-top: 6px; font-size: 13px; color: var(--ink-1)" }, `⭐ MVP : ${mvpPlayer.name}`)
          : el("div", { style: "margin-top: 6px; font-size: 13px; color: var(--ink-2)" }, "Sans MVP"),
      ]),
      el("p", { class: "muted", style: "margin:0 0 16px; font-size: 12px" },
        "Le résultat sera envoyé sur le site et visible pour tous."),
      el("div", { class: "row", style: "gap: 8px" }, [
        el("button", { class: "btn ghost", onclick: () => overlay.remove() }, "Revenir"),
        el("button", {
          class: "btn primary",
          onclick: async () => {
            overlay.remove();
            try {
              await finishMatch(currentMatchId, mvpId);
              kickSync();
              goDone(currentMatchId);
            } catch (e) {
              alert("Erreur : " + (e.message || e));
            }
          },
        }, "Envoyer"),
      ]),
    ])
  );
  document.body.appendChild(overlay);
}

// ---------------- Done / Recap ----------------

async function goDone(matchId) {
  currentMatchId = matchId;
  updateTopbarForLive(false);
  show("done");
  const data = await getMatch(matchId);
  const root = $("#screen-done");
  root.textContent = "";
  if (!data) { root.appendChild(el("p", {}, "Match introuvable")); return; }
  const { match, teamA, teamB, goals } = data;
  const all = [...teamA, ...teamB];
  const goalCount = {};
  const assistCount = {};
  goals.forEach((g) => {
    goalCount[g.scorerId] = (goalCount[g.scorerId] || 0) + 1;
    if (g.assistId) assistCount[g.assistId] = (assistCount[g.assistId] || 0) + 1;
  });
  const scorers = all
    .filter((p) => goalCount[p.id])
    .sort((a, b) => goalCount[b.id] - goalCount[a.id]);
  const assisters = all
    .filter((p) => assistCount[p.id])
    .sort((a, b) => assistCount[b.id] - assistCount[a.id]);
  const mvp = match.mvpId ? all.find((p) => p.id === match.mvpId) : null;

  const winA = match.scoreA > match.scoreB;
  const winB = match.scoreB > match.scoreA;

  // Hero score
  const heroScore = el("div", { class: "recap-hero" }, [
    el("div", { class: "recap-teams" }, [
      el("div", { class: "recap-team-name A" }, match.teamAName.toUpperCase()),
      el("div", { class: "recap-team-name B" }, match.teamBName.toUpperCase()),
    ]),
    el("div", { class: "recap-score" }, [
      el("span", { class: "score-num" + (winA ? " win" : winB ? " lose" : "") }, String(match.scoreA)),
      el("span", { class: "score-sep" }, ":"),
      el("span", { class: "score-num" + (winB ? " win" : winA ? " lose" : "") }, String(match.scoreB)),
    ]),
  ]);

  // Timeline
  const timeline = goals.length
    ? el("div", { class: "timeline" },
        goals.map((g) => el("div", { class: "timeline-row " + g.team }, [
          el("span", { class: "timeline-minute" }, (g.minute != null ? g.minute + "'" : "—")),
          el("span", { class: "timeline-ball" }, "\u26BD"),
          el("span", { class: "timeline-scorer" }, g.scorerName || "?"),
          g.assistName
            ? el("span", { class: "timeline-assist" }, "(p. " + g.assistName + ")")
            : null,
        ]))
      )
    : el("div", { class: "muted pad" }, "Aucun but.");

  root.appendChild(
    el("div", { class: "wrap recap-wrap" }, [
      el("div", { class: "recap-header" }, "MATCH TERMINÉ"),
      heroScore,
      mvp ? el("div", { class: "mvp-pill" }, [
        el("span", {}, "\u2B50 MVP — "),
        el("strong", {}, mvp.name),
      ]) : null,

      el("div", { class: "section-title" }, "Chronologie"),
      timeline,

      scorers.length ? el("div", { class: "section-title" }, "Buteurs") : null,
      scorers.length ? el("div", { class: "event-list" },
        scorers.map((p, i) => el("div", { class: "ev" }, [
          el("span", {}, [
            el("span", { class: "podium-medal" }, i === 0 ? "\uD83E\uDD47" : i === 1 ? "\uD83E\uDD48" : i === 2 ? "\uD83E\uDD49" : "·"),
            " ",
            el("span", { class: "tag " + p.team }, p.team === "A" ? match.teamAName : match.teamBName),
            " " + p.name,
          ]),
          el("strong", { class: "goal-dots" }, "\u2022".repeat(Math.min(goalCount[p.id], 5)) + (goalCount[p.id] > 5 ? " +" + (goalCount[p.id] - 5) : "")),
        ]))
      ) : null,

      assisters.length ? el("div", { class: "section-title" }, "Passes d\u00E9cisives") : null,
      assisters.length ? el("div", { class: "event-list" },
        assisters.map((p) => el("div", { class: "ev" }, [
          el("span", {}, p.name),
          el("strong", {}, String(assistCount[p.id])),
        ]))
      ) : null,

      el("div", { class: "row gap" }, [
        el("button", { class: "btn ghost big", onclick: () => shareRecap(data, mvp?.name) }, "\uD83D\uDCE4 Partager"),
        el("button", { class: "btn primary big", onclick: () => rematch(data) }, "\uD83D\uDD04 Rematch"),
      ]),
      el("div", { class: "row gap" }, [
        el("button", { class: "btn ghost", onclick: goHome }, "← Accueil"),
        el("button", { class: "btn ghost", onclick: goHistory }, "Archives"),
      ]),
    ])
  );
}

async function shareRecap(data, mvpName) {
  try {
    const { shareMatchImage } = await import("./shareCard.js");
    await shareMatchImage({ ...data, mvpName });
  } catch (e) {
    alert("Impossible de partager : " + (e.message || e));
  }
}

async function rematch(data) {
  // Clone teams + same player assignments, new match ID
  const teamA = data.teamA.map((p) => p.id);
  const teamB = data.teamB.map((p) => p.id);
  const id = createId();
  await createMatch({
    id,
    playedAt: new Date().toISOString(),
    teamAName: data.match.teamAName,
    teamBName: data.match.teamBName,
    teamA,
    teamB,
  });
  currentMatchId = id;
  kickSync();
  goLive(id);
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
      el("button", { class: "btn ghost big", onclick: goHome }, "← Accueil"),
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
        <div class="brand brand-mono">
          <span class="serif">Five</span>
          <span class="tag-txt">Scorer</span>
        </div>
        <div class="topbar-end">
          <button id="sync-badge" class="sync-badge ok">…</button>
        </div>
      </header>
      <main>
        <section id="screen-pin" class="screen"></section>
        <section id="screen-home" class="screen"></section>
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
    await goHome();
  }

  // Hydrate roster from network when possible (background)
  pullRoster();
}
