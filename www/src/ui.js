// Vanilla DOM UI for Five Scorer mobile.
// Visual language: "Direction B Terrain" — pitch green dark, amber/red team
// accents, monospace stencil scoreboard. Templates from claude.ai redesign,
// wired to the real Dexie+Supabase backend.

import { createId } from "@paralleldrive/cuid2";
import { APP_PIN } from "./config.js";
import {
  db,
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
import {
  unlockAudio,
  playGoalSound,
  playUndoSound,
  isSoundEnabled,
  toggleSound,
} from "./audio.js";
import { renderShareCard } from "./shareCard.js";
import { computeMvp } from "./mvp.js";

// ---------------- helpers ----------------

const $ = (sel) => document.querySelector(sel);
const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class" || k === "className") node.className = v;
      else if (k === "style" && typeof v === "object") {
        for (const s in v) node.style[s] = v[s];
      } else if (k === "dataset" && typeof v === "object") {
        for (const d in v) node.dataset[d] = v[d];
      } else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k in node && typeof node[k] !== "function" && k !== "list") {
        try { node[k] = v; } catch (_) { node.setAttribute(k, String(v)); }
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  if (children == null) return;
  const arr = Array.isArray(children) ? children : [children];
  for (const c of arr) {
    if (c == null || c === false) continue;
    node.appendChild(
      typeof c === "string" || typeof c === "number"
        ? document.createTextNode(String(c))
        : c
    );
  }
}

function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

function abbr(name, len = 3) {
  const cleaned = (name || "").toUpperCase().replace(/[^A-Z0-9ÉÈÊËÀÂÄÔÖÙÛÜÇ]/g, "");
  return cleaned.slice(0, len) || "—";
}

function fmtDateShort(iso) {
  return new Date(iso).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
  }).toUpperCase().replace(/\./g, "");
}

function fmtDateLong(iso) {
  return new Date(iso).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  }).toUpperCase();
}

function fmtTopbarDate() {
  return new Date().toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).toUpperCase().replace(/\./g, "");
}

let currentMatchId = null;
let pendingGoalAnim = null; // { team, playerId } — flash on next render

// ---------------- Sync badge ----------------

function renderSyncBadge() {
  const badge = $("#sync-badge");
  if (!badge) return;
  subscribeSync((s) => {
    let cls = "ok", title = "Synchro OK";
    if (!s.online) { cls = "off"; title = "Hors ligne"; }
    else if (s.syncing) { cls = "warn"; title = "Sync en cours…"; }
    else if (s.pending > 0) { cls = "warn"; title = `${s.pending} à envoyer`; }
    badge.className = "sync-dot " + cls;
    badge.title = s.lastError || title;
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

let pinValue = "";
let pinError = false;

function renderPin() {
  pinValue = "";
  pinError = false;
  drawPinScreen();
}

function buildPinPitch() {
  const wrap = el("div", { class: "pin-pitch" });
  const svg = svgEl("svg", {
    width: 280, height: 280, viewBox: "0 0 280 280", style: "opacity:.45",
  });
  const g = svgEl("g", {
    fill: "none",
    stroke: "rgba(255,255,255,0.55)",
    "stroke-width": "1.5",
  });
  g.appendChild(svgEl("circle", { cx: 140, cy: 140, r: 70 }));
  g.appendChild(svgEl("circle", {
    cx: 140, cy: 140, r: 2, fill: "rgba(255,255,255,0.55)",
  }));
  g.appendChild(svgEl("line", { x1: 0, y1: 140, x2: 280, y2: 140 }));
  svg.appendChild(g);
  wrap.appendChild(svg);
  return wrap;
}

function drawPinScreen() {
  const root = $("#screen-pin");
  clear(root);
  if (!root.classList.contains("pin-screen")) root.classList.add("pin-screen");

  root.appendChild(buildPinPitch());

  const dots = el("div", { class: "pin-dots" }, [0, 1, 2, 3].map((i) => {
    const cls = ["pin-dot"];
    if (i < pinValue.length) cls.push("filled");
    if (pinError) cls.push("error");
    return el("span", { class: cls.join(" ") });
  }));

  const keypad = el("div", { class: "pin-keypad" }, [
    ...["1","2","3","4","5","6","7","8","9"].map((d) =>
      el("button", { class: "pin-key", onclick: () => pinDigit(d) }, d)
    ),
    el("button", { class: "pin-key ghost", disabled: true }),
    el("button", { class: "pin-key", onclick: () => pinDigit("0") }, "0"),
    el("button", { class: "pin-key del", onclick: pinDel }, "←"),
  ]);

  const card = el("div", { class: "pin-card" }, [
    el("span", { class: "corners" }),
    el("h1", { class: "pin-title" }, [
      "Five",
      el("span", { class: "accent" }, "."),
      el("br"),
      "Scorer",
    ]),
    el("div", { class: "pin-sub" }, "ENTRER LE CODE"),
    dots,
    keypad,
  ]);

  root.appendChild(card);
}

function pinDigit(d) {
  if (pinValue.length >= 8) return;
  pinValue += d;
  pinError = false;
  if (navigator.vibrate) navigator.vibrate(8);
  if (!APP_PIN || pinValue === APP_PIN) {
    sessionStorage.setItem("fs-unlocked", "1");
    if (navigator.vibrate) navigator.vibrate(20);
    setTimeout(() => goHome(), 140);
    drawPinScreen();
    return;
  }
  if (pinValue.length >= 4 && pinValue.length === (APP_PIN || "").length) {
    pinError = true;
    if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    setTimeout(() => { pinValue = ""; pinError = false; drawPinScreen(); }, 600);
  }
  drawPinScreen();
}

function pinDel() {
  pinValue = pinValue.slice(0, -1);
  pinError = false;
  drawPinScreen();
}

// ---------------- Topbar ----------------

function buildTopbar({ left, center, right } = {}) {
  return el("header", { class: "topbar" }, [
    el("div", { class: "left" }, left || [el("span", { class: "brand" }, [
      "FIVE", el("span", { class: "dot" }, "."), "SCORER",
    ])]),
    el("div", { class: "center" }, center || []),
    el("div", { class: "right" }, [
      el("button", {
        class: "sync-dot",
        id: "sync-badge",
        title: "Sync",
      }),
      ...(right ? [].concat(right) : []),
    ]),
  ]);
}

function rebindSync() { renderSyncBadge(); }

// ---------------- HOME ----------------

async function goHome() {
  show("home");
  await renderHome();
}

async function renderHome() {
  const root = $("#screen-home");
  clear(root);

  const matches = await listMatches(30);
  const finished = matches.filter((m) => m.status === "FINISHED");
  const live = matches.find((m) => m.status === "LIVE") || null;

  root.appendChild(
    buildTopbar({
      center: [el("span", {}, fmtTopbarDate())],
      right: el("button", {
        class: "btn tiny ghost",
        onclick: lock,
        title: "Verrouiller",
      }, "⌧"),
    })
  );
  rebindSync();

  // Hero
  root.appendChild(
    el("section", { class: "home-hero" }, [
      el("div", { class: "home-eyebrow" }, [
        el("span", { class: "eyebrow" }, "FIVE · HEBDO"),
        el("span", { class: "kicker amber" }, "URBAN FOOT"),
      ]),
      el("h1", { class: "home-title" }, [
        "5",
        el("span", { class: "vs" }, "VS"),
        "5",
      ]),
      el("div", { class: "home-meta" },
        `${matches.length ? finished.length + " MATCHS · " : ""}LE JEUDI SOIR`),
    ])
  );

  // Resume / new match CTAs
  if (live) {
    root.appendChild(
      el("div", { class: "cta-row" }, [
        el("button", {
          class: "btn danger big block",
          onclick: () => { currentMatchId = live.id; goLive(live.id); },
        }, [
          el("span", { class: "live-dot" }),
          ` REPRENDRE · ${live.scoreA} : ${live.scoreB}`,
        ]),
        el("button", { class: "btn ghost block", onclick: goSetup }, "+ NOUVEAU MATCH"),
      ])
    );
  } else {
    root.appendChild(
      el("div", { class: "cta-row" }, [
        el("button", {
          class: "btn primary big block",
          onclick: goSetup,
        }, "► COUP D'ENVOI"),
      ])
    );
  }

  // Last match panel
  if (finished.length > 0) {
    const last = finished[0];
    const lastData = await getMatch(last.id);
    const mvpName = last.mvpId
      ? [...(lastData?.teamA || []), ...(lastData?.teamB || [])].find((p) => p.id === last.mvpId)?.name
      : null;
    const totalGoals = last.scoreA + last.scoreB;
    const aWin = last.scoreA > last.scoreB;
    const bWin = last.scoreB > last.scoreA;

    root.appendChild(
      el("div", { class: "section-head" }, [
        el("span", { class: "ttl" }, "Dernier match"),
        el("span", { class: "meta" }, fmtDateShort(last.playedAt)),
      ])
    );
    root.appendChild(
      el("div", {
        class: "scorepanel",
        onclick: () => goDone(last.id),
      }, [
        el("div", { class: "scorepanel-grid" }, [
          el("div", { class: "sp-side" }, [
            el("span", { class: "sp-team A" }, last.teamAName.toUpperCase()),
            el("span", { class: "sp-score " + (aWin ? "win" : "lose") }, String(last.scoreA)),
          ]),
          el("span", { class: "sp-divider" }, "FT"),
          el("div", { class: "sp-side right" }, [
            el("span", { class: "sp-team B" }, last.teamBName.toUpperCase()),
            el("span", { class: "sp-score B " + (bWin ? "win" : "lose") }, String(last.scoreB)),
          ]),
        ]),
        el("div", { class: "scorepanel-foot" }, [
          el("span", { class: "mvp" }, "★ MVP · " + (mvpName || "—")),
          el("span", {}, totalGoals + " BUTS"),
        ]),
      ])
    );
  }

  // Top scorers
  const topScorers = await computeTopScorers(finished);
  if (topScorers.length > 0) {
    const max = Math.max(1, ...topScorers.map((p) => p.goals));
    root.appendChild(
      el("div", { class: "section-head" }, [
        el("span", { class: "ttl" }, "Classement · saison"),
        el("button", {
          class: "btn tiny ghost",
          onclick: goHistory,
        }, "ARCHIVES →"),
      ])
    );
    root.appendChild(
      el("div", { class: "toplist" },
        topScorers.map((p, i) =>
          el("div", { class: "toplist-row" + (i === 0 ? " lead" : "") }, [
            el("span", { class: "toplist-rank" }, String(i + 1).padStart(2, "0")),
            el("span", { class: "toplist-name" }, p.name.toUpperCase()),
            el("div", { class: "toplist-bar" }, [
              el("i", { style: { width: `${(p.goals / max) * 100}%` } }),
            ]),
            el("span", { class: "toplist-goals" }, String(p.goals)),
          ])
        )
      )
    );
  } else if (matches.length === 0) {
    root.appendChild(
      el("div", { class: "fs-empty" }, "Aucun match — lance le premier")
    );
  }

  root.appendChild(el("div", { style: { height: "24px" } }));
}

async function computeTopScorers(finishedMatches) {
  if (!finishedMatches.length) return [];
  const allGoals = await db.goals.toArray();
  const matchSet = new Set(finishedMatches.map((m) => m.id));
  const counts = {};
  for (const g of allGoals) {
    if (!matchSet.has(g.matchId)) continue;
    counts[g.scorerId] = (counts[g.scorerId] ?? 0) + 1;
  }
  const ids = Object.keys(counts);
  if (!ids.length) return [];
  const roster = await db.roster.bulkGet(ids);
  return roster
    .map((p, i) => p ? { id: ids[i], name: p.name, goals: counts[ids[i]] } : null)
    .filter(Boolean)
    .sort((a, b) => b.goals - a.goals)
    .slice(0, 5);
}

function lock() {
  sessionStorage.removeItem("fs-unlocked");
  show("pin");
  renderPin();
}

// ---------------- SETUP ----------------

const newSetup = () => ({
  teamAName: "Blanc",
  teamBName: "Noir",
  assignments: {},
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
  clear(root);
  if (!root.classList.contains("setup-screen")) root.classList.add("setup-screen");

  root.appendChild(
    buildTopbar({
      center: [el("span", {}, "CONFIGURATION")],
      right: el("button", {
        class: "btn tiny ghost",
        onclick: () => goHome(),
      }, "✕"),
    })
  );
  rebindSync();

  root.appendChild(
    el("div", { class: "section-head" }, [
      el("span", { class: "ttl" }, "Équipes"),
    ])
  );
  root.appendChild(
    el("div", { class: "setup-section" }, [
      el("div", { class: "team-fields" }, [
        el("input", {
          class: "field",
          value: setup.teamAName,
          placeholder: "Équipe A",
          maxlength: 14,
          oninput: (e) => { setup.teamAName = e.target.value; refreshTeamCells(); },
        }),
        el("input", {
          class: "field",
          value: setup.teamBName,
          placeholder: "Équipe B",
          maxlength: 14,
          oninput: (e) => { setup.teamBName = e.target.value; refreshTeamCells(); },
        }),
      ]),
    ])
  );

  root.appendChild(
    el("div", { class: "section-head" }, [
      el("span", { class: "ttl" }, `Joueurs · ${players.length}`),
      el("button", {
        class: "btn tiny ghost",
        onclick: addGuestPrompt,
      }, "+ INVITÉ"),
    ])
  );

  const sorted = [...players].sort((a, b) => {
    if (a.isGuest !== b.isGuest) return a.isGuest ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  const rosterSection = el("div", { class: "setup-section" }, [
    ...sorted.map((p) => {
      const team = setup.assignments[p.id];
      return el("div", { class: "player-row", "data-pid": p.id }, [
        el("div", { class: "player-name" },
          p.name.toUpperCase() + (p.isGuest ? "  (INV.)" : "")),
        el("div", { class: "player-toggle" }, [
          el("button", {
            class: "A" + (team === "A" ? " active" : ""),
            onclick: () => toggleTeam(p.id, "A"),
          }, abbr(setup.teamAName)),
          el("button", {
            class: "B" + (team === "B" ? " active" : ""),
            onclick: () => toggleTeam(p.id, "B"),
          }, abbr(setup.teamBName)),
        ]),
      ]);
    }),
    el("div", { class: "setup-counts", id: "setup-counts" }),
  ]);
  root.appendChild(rosterSection);

  root.appendChild(
    el("div", { class: "cta-row" }, [
      el("button", {
        class: "btn primary big block",
        id: "btn-kickoff",
        onclick: startMatch,
      }, "► COUP D'ENVOI"),
    ])
  );

  refreshCounts();
  refreshKickoffEnabled();
}

function toggleTeam(playerId, team) {
  if (setup.assignments[playerId] === team) {
    delete setup.assignments[playerId];
  } else {
    setup.assignments[playerId] = team;
  }
  const row = document.querySelector(`.player-row[data-pid="${playerId}"]`);
  if (row) {
    const buttons = row.querySelectorAll(".player-toggle button");
    buttons[0].classList.toggle("active", setup.assignments[playerId] === "A");
    buttons[1].classList.toggle("active", setup.assignments[playerId] === "B");
  }
  refreshCounts();
  refreshKickoffEnabled();
}

function refreshTeamCells() {
  const aLabel = abbr(setup.teamAName);
  const bLabel = abbr(setup.teamBName);
  document.querySelectorAll(".player-toggle button.A").forEach((b) => b.textContent = aLabel);
  document.querySelectorAll(".player-toggle button.B").forEach((b) => b.textContent = bLabel);
  refreshCounts();
}

function refreshCounts() {
  const a = Object.values(setup.assignments).filter((v) => v === "A").length;
  const b = Object.values(setup.assignments).filter((v) => v === "B").length;
  const status = (a === 5 && b === 5) ? "PRÊT" : (a > 0 && b > 0) ? `${a}V${b}` : "ATTRIBUER";
  const statusCls = (a === 5 && b === 5) ? "ok" : (a > 0 && b > 0) ? "ok" : "warn";
  const node = $("#setup-counts");
  if (!node) return;
  clear(node);
  node.appendChild(el("span", { class: "pill A" }, `${a} · ${abbr(setup.teamAName)}`));
  node.appendChild(el("span", { class: "pill B" }, `${b} · ${abbr(setup.teamBName)}`));
  node.appendChild(el("span", { class: "pill " + statusCls }, status));
}

function refreshKickoffEnabled() {
  const a = Object.values(setup.assignments).filter((v) => v === "A").length;
  const b = Object.values(setup.assignments).filter((v) => v === "B").length;
  const btn = $("#btn-kickoff");
  if (btn) btn.disabled = !(a >= 1 && b >= 1);
}

async function addGuestPrompt() {
  const name = prompt("Nom de l'invité ?");
  if (!name || !name.trim()) return;
  const id = createId();
  await addLocalGuest(id, name.trim());
  setup.assignments[id] = "A";
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
  unlockAudio();
  await createMatch({
    id,
    playedAt: new Date().toISOString(),
    teamAName: setup.teamAName.trim() || "Blanc",
    teamBName: setup.teamBName.trim() || "Noir",
    teamA,
    teamB,
  });
  currentMatchId = id;
  kickSync();
  goLive(id);
}

// ---------------- LIVE ----------------

let matchStartTs = null;
let clockInterval = null;
let clockPausedAt = null;
let clockPausedMs = 0;

async function goLive(matchId) {
  currentMatchId = matchId;
  show("live");
  await renderLive();
  startClockTick();
}

function fmtClock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function matchSeconds() {
  if (!matchStartTs) return 0;
  return Math.floor((Date.now() - matchStartTs - clockPausedMs) / 1000);
}

function startClockTick() {
  if (clockInterval) clearInterval(clockInterval);
  clockInterval = setInterval(() => {
    const root = document.getElementById("screen-live");
    if (!root || !root.classList.contains("active")) {
      clearInterval(clockInterval); clockInterval = null; return;
    }
    if (clockPausedAt) return;
    const clk = document.querySelector("[data-clock]");
    if (clk) clk.textContent = fmtClock(matchSeconds());
  }, 1000);
}

function togglePause(ev) {
  const dot = document.querySelector(".live-screen .topbar .live-dot");
  const lbl = document.querySelector("#live-label");
  if (clockPausedAt) {
    clockPausedMs += Date.now() - clockPausedAt;
    clockPausedAt = null;
    if (dot) dot.style.animation = "";
    if (lbl) lbl.textContent = "LIVE";
    if (ev && ev.currentTarget) ev.currentTarget.textContent = "⏸";
  } else {
    clockPausedAt = Date.now();
    if (dot) dot.style.animation = "none";
    if (lbl) lbl.textContent = "PAUSE";
    if (ev && ev.currentTarget) ev.currentTarget.textContent = "▶";
  }
}

let suppressTapUntil = 0;
const SUPPRESS_TAP_MS = 700;

function attachLongPress(btn, onTap, onHold) {
  let timer = null;
  let didLong = false;
  const start = (e) => {
    didLong = false;
    btn.classList.add("pressing");
    if (e && e.pointerId !== undefined && btn.setPointerCapture) {
      try { btn.setPointerCapture(e.pointerId); } catch (_) {}
    }
    timer = setTimeout(() => {
      didLong = true;
      suppressTapUntil = Date.now() + SUPPRESS_TAP_MS;
      btn.classList.remove("pressing");
      btn.classList.add("held");
      if (navigator.vibrate) navigator.vibrate([20, 30, 60]);
      onHold();
      setTimeout(() => btn.classList.remove("held"), 250);
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
    if (e && e.cancelable) e.preventDefault();
  };
  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", end);
  btn.addEventListener("pointerleave", cancel);
  btn.addEventListener("pointercancel", cancel);
}

function buildJersey(p, team) {
  const goalsTxt = p.goals > 0 ? String(p.goals) : "";
  const initials = abbr(p.name, 2);
  const node = el("button", {
    class: "jersey " + team,
    type: "button",
  }, [
    el("span", { class: "j-num" }, initials),
    el("span", { class: "j-name" }, p.name.toUpperCase()),
    el("span", { class: "j-goals" }, goalsTxt),
  ]);

  attachLongPress(node,
    async () => {
      try {
        unlockAudio();
        if (navigator.vibrate) navigator.vibrate(12);
        playGoalSound();
        pendingGoalAnim = { team, playerId: p.id };
        const goalId = createId();
        await scoreGoal({
          id: goalId,
          matchId: currentMatchId,
          scorerId: p.id,
          createdAt: new Date().toISOString(),
        });
        kickSync();
        renderLive();
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

  return node;
}

async function renderLive() {
  if (!currentMatchId) { goHome(); return; }
  const data = await getMatch(currentMatchId);
  if (!data) { goHome(); return; }
  const { match, teamA, teamB } = data;
  if (match.status === "FINISHED") return goDone(currentMatchId);

  if (matchStartTs == null || matchStartTs !== new Date(match.playedAt).getTime()) {
    matchStartTs = new Date(match.playedAt).getTime();
    clockPausedAt = null;
    clockPausedMs = 0;
  }

  const root = $("#screen-live");
  clear(root);
  if (!root.classList.contains("live-screen")) root.classList.add("live-screen");

  const aLeads = match.scoreA > match.scoreB;
  const bLeads = match.scoreB > match.scoreA;

  // Topbar
  root.appendChild(
    el("header", { class: "topbar" }, [
      el("div", { class: "left" }, [
        el("span", { class: "live-dot" }),
        el("span", { class: "kicker", id: "live-label" }, "LIVE"),
        el("span", { class: "match-clock", "data-clock": "1" }, fmtClock(matchSeconds())),
        el("button", {
          class: "btn tiny ghost",
          onclick: togglePause,
          style: { padding: "4px 8px", letterSpacing: "0" },
          title: "Pause",
        }, clockPausedAt ? "▶" : "⏸"),
      ]),
      el("div", { class: "center" }, []),
      el("div", { class: "right" }, [
        el("button", {
          class: "btn tiny ghost",
          onclick: (e) => {
            const on = toggleSound();
            if (e.currentTarget) e.currentTarget.textContent = on ? "🔊" : "🔇";
          },
          style: { padding: "4px 8px", letterSpacing: "0" },
          title: "Son",
        }, isSoundEnabled() ? "🔊" : "🔇"),
        el("button", {
          class: "sync-dot",
          id: "sync-badge",
          title: "Sync",
        }),
        el("button", {
          class: "btn tiny",
          style: {
            background: "rgba(239,63,50,.14)",
            borderColor: "rgba(239,63,50,.5)",
            color: "#fca5a5",
          },
          onclick: confirmEnd,
        }, "FIN"),
      ]),
    ])
  );
  rebindSync();

  // Scorebar
  const scoreA = el("span", {
    class: "sb-num A" + (aLeads ? " lead" : ""),
  }, String(match.scoreA));
  const scoreB = el("span", {
    class: "sb-num B" + (bLeads ? " lead" : ""),
  }, String(match.scoreB));

  root.appendChild(
    el("div", { class: "scorebar" }, [
      el("div", { class: "scorebar-grid" }, [
        el("div", { class: "sb-side" }, [
          el("span", { class: "sb-team A" }, "DOM"),
          el("span", { class: "sb-name" }, match.teamAName.toUpperCase()),
        ]),
        el("div", { class: "sb-scores" }, [
          scoreA,
          el("span", { class: "sep" }, "·"),
          scoreB,
        ]),
        el("div", { class: "sb-side right" }, [
          el("span", { class: "sb-team B" }, "EXT"),
          el("span", { class: "sb-name" }, match.teamBName.toUpperCase()),
        ]),
      ]),
      el("div", { class: "scorebar-meta" }, [
        el("span", { class: "live" }, [el("span", { class: "live-dot" }), "EN DIRECT"]),
        el("span", {}, `${match.scoreA + match.scoreB} BUTS`),
        el("span", {}, `${teamA.length}V${teamB.length}`),
      ]),
    ])
  );

  // Pitch grid
  const sortedA = [...teamA].sort((a, b) => a.name.localeCompare(b.name));
  const sortedB = [...teamB].sort((a, b) => a.name.localeCompare(b.name));

  root.appendChild(
    el("div", { class: "pitch-grid" }, [
      el("div", { class: "pitch-col" }, [
        el("div", { class: "pitch-col-head A" }, "↑ " + match.teamAName.toUpperCase()),
        ...sortedA.map((p) => buildJersey(p, "A")),
      ]),
      el("div", { class: "pitch-col" }, [
        el("div", { class: "pitch-col-head B" }, "↓ " + match.teamBName.toUpperCase()),
        ...sortedB.map((p) => buildJersey(p, "B")),
      ]),
    ])
  );

  root.appendChild(
    el("div", { class: "live-actions" }, [
      el("span", { class: "live-hint" }, "TAP +1 · APPUI LONG = ANNULER"),
      el("button", {
        class: "btn danger big",
        onclick: confirmEnd,
      }, "COUP DE SIFFLET FINAL"),
    ])
  );

  // Goal flash
  if (pendingGoalAnim) {
    const { team, playerId } = pendingGoalAnim;
    pendingGoalAnim = null;
    requestAnimationFrame(() => {
      const sb = team === "A" ? scoreA : scoreB;
      if (sb) {
        sb.classList.add("goaled");
        setTimeout(() => sb.classList.remove("goaled"), 600);
      }
      const sortedTeam = team === "A" ? sortedA : sortedB;
      const idx = sortedTeam.findIndex((p) => p.id === playerId);
      if (idx >= 0) {
        const col = document.querySelector(
          `#screen-live .pitch-col:nth-child(${team === "A" ? 1 : 2})`
        );
        const tile = col && col.querySelectorAll(".jersey")[idx];
        if (tile) {
          tile.classList.add("flash");
          const ghost = el("span", { class: "ghost-plus" }, "+1");
          tile.appendChild(ghost);
          setTimeout(() => { tile.classList.remove("flash"); ghost.remove(); }, 700);
        }
      }
    });
  }
}

function confirmEnd() {
  const overlay = el("div", { class: "fs-overlay" });
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.appendChild(
    el("div", { class: "fs-dialog" }, [
      el("h2", {}, "Coup de sifflet final ?"),
      el("p", {}, "Tu peux choisir un MVP avant d'envoyer le résultat. Ou annuler ce match."),
      el("div", { class: "fs-dialog-actions" }, [
        el("button", { class: "btn ghost", onclick: () => overlay.remove() }, "Continuer"),
        el("button", {
          class: "btn",
          style: { borderColor: "var(--live)", color: "var(--live)" },
          onclick: () => { overlay.remove(); confirmCancelMatch(); },
        }, "Annuler match"),
        el("button", {
          class: "btn primary",
          onclick: () => { overlay.remove(); goMvp(currentMatchId); },
        }, "Terminer →"),
      ]),
    ])
  );
  document.body.appendChild(overlay);
}

function confirmCancelMatch() {
  const overlay = el("div", { class: "fs-overlay" });
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.appendChild(
    el("div", { class: "fs-dialog" }, [
      el("h2", {}, "Annuler ce match ?"),
      el("p", {}, "Toutes les données du match seront supprimées. Irréversible."),
      el("div", { class: "fs-dialog-actions" }, [
        el("button", { class: "btn ghost", onclick: () => overlay.remove() }, "Retour"),
        el("button", {
          class: "btn danger",
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
  if (!data) return goHome();

  const root = $("#screen-mvp");
  clear(root);

  const all = [...data.teamA, ...data.teamB];
  const suggested = computeMvp({ match: data.match, players: all });
  if (mvpSel == null && suggested) mvpSel = suggested.id;

  root.appendChild(
    buildTopbar({
      center: [el("span", {}, "MVP DU MATCH")],
      right: el("button", {
        class: "btn tiny ghost",
        onclick: () => goLive(currentMatchId),
      }, "←"),
    })
  );
  rebindSync();

  root.appendChild(
    el("section", { class: "home-hero" }, [
      el("span", { class: "eyebrow" }, "FIN DU MATCH"),
      el("h1", { class: "home-title", style: { fontSize: "48px", lineHeight: "1" } },
        suggested ? "MVP" : "AUCUN BUT"),
      el("div", { class: "home-meta" },
        suggested
          ? `SUGGESTION : ${suggested.name.toUpperCase()} · ${suggested.goals}B`
          : "CHOISIS MANUELLEMENT OU PASSE"),
    ])
  );

  const sorted = [...all].sort((a, b) => {
    const ag = a.goals || 0, bg = b.goals || 0;
    return bg - ag || a.name.localeCompare(b.name);
  });
  const grid = el("div", { class: "mvp-cell-grid" });
  sorted.forEach((p) => {
    const isSel = mvpSel === p.id;
    const isSuggested = suggested && suggested.id === p.id;
    const cell = el("button", {
      class: "mvp-cell" + (isSel ? " sel" : "") + (isSuggested ? " suggested" : ""),
      onclick: () => { mvpSel = mvpSel === p.id ? null : p.id; renderMvp(); },
    }, [
      isSuggested ? el("span", { class: "mvp-cell-badge" }, "★ SUGG.") : null,
      el("div", { class: "mvp-cell-name" }, p.name.toUpperCase()),
      el("div", { class: "mvp-cell-meta" }, [
        el("span", { class: "mvp-cell-team " + p.team },
          p.team === "A" ? data.match.teamAName : data.match.teamBName),
        p.goals ? el("span", { class: "mvp-cell-goals" }, `${p.goals}B`) : null,
      ]),
    ]);
    grid.appendChild(cell);
  });
  root.appendChild(el("div", { class: "setup-section" }, [grid]));

  root.appendChild(
    el("div", { class: "live-actions" }, [
      el("button", {
        class: "btn ghost big",
        onclick: () => confirmFinish(null),
      }, "PAS DE MVP"),
      el("button", {
        class: "btn primary big",
        onclick: () => confirmFinish(mvpSel),
      }, "VALIDER →"),
    ])
  );
}

async function confirmFinish(mvpId) {
  const data = await getMatch(currentMatchId);
  if (!data) return;
  const { match } = data;
  const mvpPlayer = mvpId ? [...data.teamA, ...data.teamB].find((p) => p.id === mvpId) : null;

  const overlay = el("div", { class: "fs-overlay" });
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.appendChild(
    el("div", { class: "fs-dialog" }, [
      el("h2", {}, "Envoyer le résultat ?"),
      el("div", { class: "fs-dialog-summary" }, [
        el("div", { class: "fs-dialog-score" },
          `${match.teamAName}  ${match.scoreA} : ${match.scoreB}  ${match.teamBName}`),
        mvpPlayer
          ? el("div", { class: "fs-dialog-mvp" }, "★ MVP · " + mvpPlayer.name.toUpperCase())
          : el("div", { class: "fs-dialog-mvp dim" }, "Sans MVP"),
      ]),
      el("p", {}, "Le résultat sera publié sur le site."),
      el("div", { class: "fs-dialog-actions" }, [
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

// ---------------- DONE / RECAP ----------------

async function goDone(matchId) {
  currentMatchId = matchId;
  if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
  show("done");
  await renderDone();
}

async function renderDone() {
  const data = await getMatch(currentMatchId);
  const root = $("#screen-done");
  clear(root);

  if (!data) {
    root.appendChild(buildTopbar({ center: [el("span", {}, "RECAP")] }));
    root.appendChild(el("div", { class: "fs-empty" }, "Match introuvable"));
    rebindSync();
    return;
  }

  const { match, teamA, teamB, goals } = data;
  const all = [...teamA, ...teamB];
  const goalCount = {};
  goals.forEach((g) => { goalCount[g.scorerId] = (goalCount[g.scorerId] || 0) + 1; });
  const scorers = all
    .filter((p) => goalCount[p.id])
    .sort((a, b) => goalCount[b.id] - goalCount[a.id]);
  const mvp = match.mvpId ? all.find((p) => p.id === match.mvpId) : null;
  const winA = match.scoreA > match.scoreB;
  const winB = match.scoreB > match.scoreA;

  root.appendChild(
    buildTopbar({
      center: [el("span", {}, fmtDateLong(match.playedAt))],
      right: el("button", {
        class: "btn tiny ghost",
        onclick: goHome,
      }, "✕"),
    })
  );
  rebindSync();

  root.appendChild(
    el("section", { class: "home-hero" }, [
      el("span", { class: "eyebrow" }, "MATCH TERMINÉ"),
      el("div", { class: "scorepanel-grid", style: { paddingTop: "12px" } }, [
        el("div", { class: "sp-side" }, [
          el("span", { class: "sp-team A" }, match.teamAName.toUpperCase()),
          el("span", {
            class: "sp-score " + (winA ? "win" : winB ? "lose" : ""),
            style: { fontSize: "80px" },
          }, String(match.scoreA)),
        ]),
        el("span", { class: "sp-divider", style: { fontSize: "16px" } }, "FT"),
        el("div", { class: "sp-side right" }, [
          el("span", { class: "sp-team B" }, match.teamBName.toUpperCase()),
          el("span", {
            class: "sp-score B " + (winB ? "win" : winA ? "lose" : ""),
            style: { fontSize: "80px" },
          }, String(match.scoreB)),
        ]),
      ]),
    ])
  );

  if (mvp) {
    root.appendChild(
      el("div", { class: "mvp-banner" }, [
        el("span", { class: "mvp-banner-label" }, "★ MVP"),
        el("span", { class: "mvp-banner-name" }, mvp.name.toUpperCase()),
      ])
    );
  }

  if (goals.length > 0) {
    root.appendChild(
      el("div", { class: "section-head" }, [
        el("span", { class: "ttl" }, "Chronologie · " + goals.length + " buts"),
      ])
    );
    root.appendChild(
      el("div", { class: "recap-timeline" },
        goals.map((g) => el("div", { class: "recap-event " + g.team }, [
          el("span", { class: "recap-event-min" },
            g.minute != null ? g.minute + "'" : "—"),
          el("span", { class: "recap-event-icon" }, "⚽"),
          el("span", { class: "recap-event-name" }, g.scorerName.toUpperCase()),
          el("span", { class: "recap-event-team " + g.team },
            g.team === "A" ? abbr(match.teamAName) : abbr(match.teamBName)),
        ]))
      )
    );
  } else {
    root.appendChild(el("div", { class: "fs-empty" }, "Aucun but"));
  }

  if (scorers.length > 0) {
    const max = Math.max(1, ...scorers.map((p) => goalCount[p.id]));
    root.appendChild(
      el("div", { class: "section-head" }, [
        el("span", { class: "ttl" }, "Buteurs"),
      ])
    );
    root.appendChild(
      el("div", { class: "toplist" },
        scorers.map((p, i) =>
          el("div", { class: "toplist-row" + (i === 0 ? " lead" : "") }, [
            el("span", { class: "toplist-rank" },
              i === 0 ? "★" : String(i + 1).padStart(2, "0")),
            el("span", { class: "toplist-name" }, p.name.toUpperCase()),
            el("div", { class: "toplist-bar" }, [
              el("i", {
                style: {
                  width: `${(goalCount[p.id] / max) * 100}%`,
                  background: `var(--${p.team === "A" ? "a" : "b"}-500)`,
                },
              }),
            ]),
            el("span", {
              class: "toplist-goals",
              style: { color: `var(--${p.team === "A" ? "a" : "b"}-500)` },
            }, String(goalCount[p.id])),
          ])
        )
      )
    );
  }

  root.appendChild(
    el("div", { class: "cta-row" }, [
      el("div", { class: "fs-actions-2" }, [
        el("button", {
          class: "btn ghost big",
          onclick: () => shareRecap(data, mvp?.name),
        }, "📤 PARTAGER"),
        el("button", {
          class: "btn primary big",
          onclick: () => rematch(data),
        }, "🔄 REMATCH"),
      ]),
      el("div", { class: "fs-actions-2 small" }, [
        el("button", { class: "btn tiny ghost", onclick: goHome }, "← ACCUEIL"),
        el("button", { class: "btn tiny ghost", onclick: goHistory }, "ARCHIVES"),
      ]),
    ])
  );

  root.appendChild(el("div", { style: { height: "24px" } }));
}

async function shareRecap(data, mvpName) {
  try {
    const blob = await renderShareCard({ ...data, mvpName });
    if (!blob) return;
    const file = new File([blob], `five-scorer-${Date.now()}.png`, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Match Five Scorer" });
        return;
      } catch (_) {}
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    alert("Impossible de partager : " + (e.message || e));
  }
}

async function rematch(data) {
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

// ---------------- HISTORY ----------------

async function goHistory() {
  show("history");
  await renderHistory();
}

async function renderHistory() {
  const matches = await listMatches();
  const root = $("#screen-history");
  clear(root);

  root.appendChild(
    buildTopbar({
      center: [el("span", {}, "ARCHIVES")],
      right: el("button", {
        class: "btn tiny ghost",
        onclick: goHome,
      }, "✕"),
    })
  );
  rebindSync();

  if (matches.length === 0) {
    root.appendChild(el("div", { class: "fs-empty" }, "Aucun match en archive"));
    return;
  }

  root.appendChild(
    el("div", { class: "history-list" },
      matches.map((m) => {
        const winA = m.scoreA > m.scoreB;
        const winB = m.scoreB > m.scoreA;
        const isLive = m.status === "LIVE";
        return el("button", {
          class: "history-row" + (isLive ? " live" : ""),
          onclick: () => isLive ? goLive(m.id) : goDone(m.id),
        }, [
          el("div", { class: "history-row-date" }, fmtDateShort(m.playedAt)),
          el("div", { class: "history-row-teams" }, [
            el("span", { class: "ht-name" }, m.teamAName.toUpperCase()),
            el("span", { class: "ht-vs" }, "·"),
            el("span", { class: "ht-name" }, m.teamBName.toUpperCase()),
          ]),
          el("div", { class: "history-row-score" }, [
            el("span", {
              class: "hs-num" + (winA ? " win" : winB ? " lose" : ""),
            }, String(m.scoreA)),
            el("span", { class: "hs-sep" }, ":"),
            el("span", {
              class: "hs-num" + (winB ? " win" : winA ? " lose" : ""),
            }, String(m.scoreB)),
          ]),
          isLive
            ? el("span", { class: "history-row-status" }, [
                el("span", { class: "live-dot" }), "LIVE",
              ])
            : null,
        ]);
      })
    )
  );
}

// ---------------- Boot ----------------

function buildAppShell(app) {
  if (app.dataset.built) return;
  for (const id of ["pin", "home", "setup", "live", "mvp", "done", "history"]) {
    const cls = "screen" +
      (id === "pin" ? " pin-screen" : "") +
      (id === "setup" ? " setup-screen" : "") +
      (id === "live" ? " live-screen" : "");
    app.appendChild(el("section", { id: "screen-" + id, class: cls }));
  }
  app.dataset.built = "1";
}

export async function boot() {
  const app = $("#app");
  buildAppShell(app);

  initSync();

  if (APP_PIN && sessionStorage.getItem("fs-unlocked") !== "1") {
    show("pin");
    renderPin();
  } else {
    await goHome();
  }

  pullRoster();
}
