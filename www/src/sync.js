// Outbox sync worker. Drains FIFO to Supabase REST.
//
// Server-side rows are upserted by primary key (cuid generated client-side),
// so retries are safe — at-least-once delivery.

import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";
import {
  saveRoster,
  outboxCount,
  outboxPeekFirst,
  outboxRemove,
  outboxBumpAttempts,
} from "./db.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

const listeners = new Set();
const state = {
  online: typeof navigator !== "undefined" ? navigator.onLine : true,
  pending: 0,
  syncing: false,
  lastError: null,
  lastSyncedAt: null,
};
function emit() {
  for (const l of listeners) l({ ...state });
}
export function subscribeSync(l) {
  listeners.add(l);
  l({ ...state });
  return () => listeners.delete(l);
}
export function getSyncState() {
  return { ...state };
}

async function refreshPending() {
  state.pending = await outboxCount();
  emit();
}

// ---------------- Replay ----------------

async function replayOp(op) {
  switch (op.kind) {
    case "createPlayer": {
      const { id, name, isGuest } = op.payload;
      const { error } = await supabase
        .from("Player")
        .upsert({ id, name, isGuest }, { onConflict: "id" });
      if (error) throw error;
      return;
    }
    case "createMatch": {
      const { id, playedAt, teamAName, teamBName, teamA, teamB } = op.payload;
      const { error: e1 } = await supabase
        .from("Match")
        .upsert(
          { id, playedAt, teamAName, teamBName, scoreA: 0, scoreB: 0, status: "LIVE" },
          { onConflict: "id" }
        );
      if (e1) throw e1;
      // Reset compositions (idempotent)
      await supabase.from("MatchPlayer").delete().eq("matchId", id);
      const rows = [
        ...teamA.map((pid) => ({ matchId: id, playerId: pid, team: "A" })),
        ...teamB.map((pid) => ({ matchId: id, playerId: pid, team: "B" })),
      ];
      const { error: e2 } = await supabase.from("MatchPlayer").insert(rows);
      if (e2) throw e2;
      return;
    }
    case "addGoal": {
      const { id, matchId, scorerId, team, createdAt } = op.payload;
      const { error: eg } = await supabase
        .from("Goal")
        .upsert(
          { id, matchId, scorerId, team, createdAt },
          { onConflict: "id" }
        );
      if (eg) throw eg;
      await refreshDenormScore(matchId);
      return;
    }
    case "removeGoal": {
      const { goalId, matchId } = op.payload;
      const { error: eg } = await supabase.from("Goal").delete().eq("id", goalId);
      if (eg) throw eg;
      await refreshDenormScore(matchId);
      return;
    }
    case "finishMatch": {
      const { matchId, mvpId } = op.payload;
      const { error } = await supabase
        .from("Match")
        .update({ status: "FINISHED", mvpId })
        .eq("id", matchId);
      if (error) throw error;
      return;
    }
    case "deleteMatch": {
      const { matchId } = op.payload;
      const { error } = await supabase.from("Match").delete().eq("id", matchId);
      if (error) throw error;
      return;
    }
    default:
      throw new Error("Unknown op: " + op.kind);
  }
}

async function refreshDenormScore(matchId) {
  const { count: a } = await supabase
    .from("Goal")
    .select("*", { count: "exact", head: true })
    .eq("matchId", matchId)
    .eq("team", "A");
  const { count: b } = await supabase
    .from("Goal")
    .select("*", { count: "exact", head: true })
    .eq("matchId", matchId)
    .eq("team", "B");
  await supabase
    .from("Match")
    .update({ scoreA: a ?? 0, scoreB: b ?? 0 })
    .eq("id", matchId);
}

// ---------------- Drain ----------------

let inflight = null;

export function drainOutbox() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      await drainInner();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function drainInner() {
  if (!state.online) return;
  state.syncing = true;
  state.lastError = null;
  emit();
  try {
    while (true) {
      const next = await outboxPeekFirst();
      if (!next) break;
      try {
        await replayOp(next.op);
        await outboxRemove(next.id);
        state.lastSyncedAt = new Date().toISOString();
      } catch (e) {
        const msg = e?.message || String(e);
        const code = e?.code || e?.status;
        const retryable =
          !code || code === 408 || code === 429 || (typeof code === "number" && code >= 500);
        await outboxBumpAttempts(next.id, msg);
        state.lastError = msg;
        if (!retryable && next.attempts >= 3) {
          // Drop poisonous op after 3 attempts
          await outboxRemove(next.id);
          continue;
        }
        break; // retryable: try later
      }
    }
  } finally {
    state.syncing = false;
    await refreshPending();
  }
}

// ---------------- Roster pull ----------------

export async function pullRoster() {
  if (!state.online) return null;
  const { data, error } = await supabase.from("Player").select("id, name, nickname, isGuest");
  if (error) {
    state.lastError = error.message;
    emit();
    return null;
  }
  await saveRoster(data || []);
  return data || [];
}

// ---------------- Init ----------------

let inited = false;
export function initSync() {
  if (inited || typeof window === "undefined") return;
  inited = true;

  const setOnline = (v) => {
    state.online = v;
    emit();
    if (v) drainOutbox().then(pullRoster);
  };
  window.addEventListener("online", () => setOnline(true));
  window.addEventListener("offline", () => setOnline(false));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.online) {
      drainOutbox();
    }
  });

  // initial
  refreshPending().then(() => {
    if (state.online) {
      drainOutbox().then(pullRoster);
    }
  });

  // Periodic safety drain every 30s
  setInterval(() => {
    if (state.online) drainOutbox();
  }, 30_000);
}

export async function kickSync() {
  await refreshPending();
  if (state.online) drainOutbox();
}
