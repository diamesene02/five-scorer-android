// Auto-compute MVP based on goals + assists + team result.
// See /lib/mvp.ts for the identical web version.

export function computeMvp({ match, players }) {
  const winA = match.scoreA > match.scoreB;
  const winB = match.scoreB > match.scoreA;
  const draw = match.scoreA === match.scoreB;

  const ranked = players
    .map((p) => {
      const contrib = (p.goals || 0) + (p.assists || 0);
      const base = (p.goals || 0) * 2 + (p.assists || 0) * 1.5;
      const won = (p.team === "A" && winA) || (p.team === "B" && winB);
      const bonus = contrib === 0 ? 0 : won ? 2 : draw ? 1 : 0;
      return {
        id: p.id,
        name: p.name,
        team: p.team,
        goals: p.goals || 0,
        assists: p.assists || 0,
        score: base + bonus,
      };
    })
    .filter((c) => c.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.goals - a.goals ||
        b.assists - a.assists ||
        a.name.localeCompare(b.name)
    );

  return ranked[0] || null;
}
