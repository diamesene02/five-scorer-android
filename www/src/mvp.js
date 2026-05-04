// Auto-compute MVP based on goals + team result.
// See /lib/mvp.ts for the identical web version.

export function computeMvp({ match, players }) {
  const winA = match.scoreA > match.scoreB;
  const winB = match.scoreB > match.scoreA;
  const draw = match.scoreA === match.scoreB;

  const ranked = players
    .map((p) => {
      const goals = p.goals || 0;
      const base = goals * 2;
      const won = (p.team === "A" && winA) || (p.team === "B" && winB);
      const bonus = goals === 0 ? 0 : won ? 2 : draw ? 1 : 0;
      return {
        id: p.id,
        name: p.name,
        team: p.team,
        goals,
        score: base + bonus,
      };
    })
    .filter((c) => c.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.goals - a.goals ||
        a.name.localeCompare(b.name)
    );

  return ranked[0] || null;
}
