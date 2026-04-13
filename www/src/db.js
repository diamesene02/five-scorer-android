// Local IndexedDB layer (Dexie).
// Same shape as the Next.js prototype, ported as plain JS.
//
// Tables:
//   - roster       : cached players (synced from server on first online)
//   - matches      : local + synced
//   - matchPlayers : compositions (matchId+playerId composite key)
//   - goals        : ordered events
//   - outbox       : pending mutations to push to Supabase

import Dexie from "dexie";

class FiveScorerDB extends Dexie {
  constructor() {
    super("five-scorer");
    this.version(1).stores({
      roster: "id, name, isGuest",
      matches: "id, playedAt, status",
      matchPlayers: "key, matchId, playerId, [matchId+team]",
      goals: "id, matchId, scorerId, createdAt, [matchId+createdAt]",
      outbox: "++id, createdAt",
    });
  }
}

export const db = new FiveScorerDB();

const mpKey = (matchId, playerId) => `${matchId}::${playerId}`;

// ---------------- Roster ----------------

export async function saveRoster(players) {
  await db.roster.bulkPut(
    players.map((p) => ({
      id: p.id,
      name: p.name,
      nickname: p.nickname ?? null,
      isGuest: !!p.isGuest,
    }))
  );
}

export async function getRoster() {
  return db.roster.orderBy("name").toArray();
}

export async function addLocalGuest(id, name) {
  await db.roster.put({ id, name, nickname: null, isGuest: true });
  await enqueue({
    kind: "createPlayer",
    payload: { id, name, isGuest: true },
  });
}

// ---------------- Match lifecycle ----------------

export async function createMatch({
  id,
  playedAt,
  teamAName,
  teamBName,
  teamA,
  teamB,
}) {
  await db.transaction(
    "rw",
    db.matches,
    db.matchPlayers,
    db.outbox,
    async () => {
      await db.matches.put({
        id,
        playedAt,
        teamAName,
        teamBName,
        scoreA: 0,
        scoreB: 0,
        status: "LIVE",
        mvpId: null,
      });
      const mps = [
        ...teamA.map((pid) => ({ key: mpKey(id, pid), matchId: id, playerId: pid, team: "A" })),
        ...teamB.map((pid) => ({ key: mpKey(id, pid), matchId: id, playerId: pid, team: "B" })),
      ];
      await db.matchPlayers.bulkPut(mps);
      await enqueue({
        kind: "createMatch",
        payload: { id, playedAt, teamAName, teamBName, teamA, teamB },
      });
    }
  );
}

export async function scoreGoal({ id, matchId, scorerId, createdAt }) {
  await db.transaction(
    "rw",
    db.matches,
    db.matchPlayers,
    db.goals,
    db.outbox,
    async () => {
      const mp = await db.matchPlayers.get(mpKey(matchId, scorerId));
      if (!mp) throw new Error("Joueur non inscrit");
      const m = await db.matches.get(matchId);
      if (!m) throw new Error("Match introuvable");
      if (m.status === "FINISHED") throw new Error("Match terminé");

      await db.goals.put({
        id,
        matchId,
        scorerId,
        team: mp.team,
        minute: null,
        createdAt,
      });
      await db.matches.update(matchId, {
        scoreA: mp.team === "A" ? m.scoreA + 1 : m.scoreA,
        scoreB: mp.team === "B" ? m.scoreB + 1 : m.scoreB,
      });
      await enqueue({
        kind: "addGoal",
        payload: { id, matchId, scorerId, team: mp.team, createdAt },
      });
    }
  );
}

export async function undoLastGoalOf(matchId, scorerId) {
  return db.transaction(
    "rw",
    db.matches,
    db.goals,
    db.outbox,
    async () => {
      const goals = await db.goals
        .where("[matchId+createdAt]")
        .between([matchId, Dexie.minKey], [matchId, Dexie.maxKey])
        .toArray();
      const candidates = goals.filter((g) => g.scorerId === scorerId);
      const last = candidates[candidates.length - 1];
      if (!last) return null;

      await db.goals.delete(last.id);
      const m = await db.matches.get(matchId);
      if (m) {
        await db.matches.update(matchId, {
          scoreA: last.team === "A" ? Math.max(0, m.scoreA - 1) : m.scoreA,
          scoreB: last.team === "B" ? Math.max(0, m.scoreB - 1) : m.scoreB,
        });
      }
      await enqueue({
        kind: "removeGoal",
        payload: { goalId: last.id, matchId },
      });
      return last.id;
    }
  );
}

export async function finishMatch(matchId, mvpId) {
  await db.transaction("rw", db.matches, db.outbox, async () => {
    await db.matches.update(matchId, { status: "FINISHED", mvpId });
    await enqueue({
      kind: "finishMatch",
      payload: { matchId, mvpId },
    });
  });
}

// ---------------- Selectors ----------------

export async function getMatch(matchId) {
  const [match, mps, goals] = await Promise.all([
    db.matches.get(matchId),
    db.matchPlayers.where("matchId").equals(matchId).toArray(),
    db.goals.where("matchId").equals(matchId).sortBy("createdAt"),
  ]);
  if (!match) return null;

  const goalCount = {};
  goals.forEach((g) => {
    goalCount[g.scorerId] = (goalCount[g.scorerId] || 0) + 1;
  });

  const roster = await db.roster.bulkGet(mps.map((mp) => mp.playerId));
  const byId = new Map();
  roster.forEach((p) => p && byId.set(p.id, p));

  const enrich = (mp) => ({
    id: mp.playerId,
    name: byId.get(mp.playerId)?.name ?? "?",
    goals: goalCount[mp.playerId] ?? 0,
    team: mp.team,
  });
  return {
    match,
    teamA: mps.filter((mp) => mp.team === "A").map(enrich),
    teamB: mps.filter((mp) => mp.team === "B").map(enrich),
    goals,
  };
}

export async function listMatches(limit = 30) {
  const matches = await db.matches
    .orderBy("playedAt")
    .reverse()
    .limit(limit)
    .toArray();
  return matches;
}

export async function deleteMatchLocal(matchId) {
  await db.transaction(
    "rw",
    db.matches,
    db.matchPlayers,
    db.goals,
    db.outbox,
    async () => {
      await db.matches.delete(matchId);
      await db.matchPlayers.where("matchId").equals(matchId).delete();
      await db.goals.where("matchId").equals(matchId).delete();
      await enqueue({ kind: "deleteMatch", payload: { matchId } });
    }
  );
}

// ---------------- Outbox ----------------

async function enqueue(op) {
  await db.outbox.add({
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    op,
  });
}

export async function outboxCount() {
  return db.outbox.count();
}

export async function outboxPeekFirst() {
  return db.outbox.orderBy("createdAt").first();
}

export async function outboxRemove(id) {
  return db.outbox.delete(id);
}

export async function outboxBumpAttempts(id, error) {
  const e = await db.outbox.get(id);
  if (!e) return;
  await db.outbox.update(id, {
    attempts: (e.attempts ?? 0) + 1,
    lastError: error,
  });
}
