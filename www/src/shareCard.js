// Canvas renderer for match recap shareable image.
// Draws 1080x1080 using design tokens. No external deps.

const TOK = {
  bg0: "#07090F",
  bg1: "#0D1220",
  bg2: "#151B2D",
  stroke: "#1F2740",
  ink0: "#F5F7FA",
  ink1: "#A7B0C4",
  ink2: "#5C6484",
  a: "#22C55E",
  aLight: "#4ADE80",
  b: "#38BDF8",
  bLight: "#7DD3FC",
  gold: "#F5B301",
};

function drawRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function renderShareCard({ match, teamA, teamB, goals, mvpName }) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1080;
  const ctx = canvas.getContext("2d");

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, 1080);
  bg.addColorStop(0, TOK.bg1);
  bg.addColorStop(1, TOK.bg0);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1080, 1080);

  // Subtle team wash left/right
  const aWash = ctx.createLinearGradient(0, 0, 540, 0);
  aWash.addColorStop(0, "rgba(34,197,94,0.16)");
  aWash.addColorStop(1, "transparent");
  ctx.fillStyle = aWash;
  ctx.fillRect(0, 0, 540, 1080);

  const bWash = ctx.createLinearGradient(1080, 0, 540, 0);
  bWash.addColorStop(0, "rgba(56,189,248,0.16)");
  bWash.addColorStop(1, "transparent");
  ctx.fillStyle = bWash;
  ctx.fillRect(540, 0, 540, 1080);

  // Header
  ctx.fillStyle = TOK.ink1;
  ctx.font = '600 28px "Space Grotesk", system-ui, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("⚽ FIVE SCORER", 540, 90);

  ctx.fillStyle = TOK.ink2;
  ctx.font = '500 22px "Space Grotesk", system-ui, sans-serif';
  const date = new Date(match.playedAt).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  ctx.fillText(date, 540, 130);

  // Team names
  ctx.font = '700 44px "Space Grotesk", system-ui, sans-serif';
  ctx.textAlign = "center";
  ctx.fillStyle = TOK.aLight;
  ctx.fillText(match.teamAName.toUpperCase(), 290, 260);
  ctx.fillStyle = TOK.bLight;
  ctx.fillText(match.teamBName.toUpperCase(), 790, 260);

  // Score numbers
  ctx.font = '800 220px "JetBrains Mono", ui-monospace, monospace';
  const winA = match.scoreA > match.scoreB;
  const winB = match.scoreB > match.scoreA;
  ctx.fillStyle = winA ? TOK.gold : TOK.ink1;
  if (winA) {
    ctx.shadowColor = "rgba(245,179,1,0.5)";
    ctx.shadowBlur = 40;
  }
  ctx.fillText(String(match.scoreA), 290, 440);
  ctx.shadowBlur = 0;

  ctx.fillStyle = TOK.ink2;
  ctx.font = '500 140px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillText(":", 540, 430);

  ctx.font = '800 220px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = winB ? TOK.gold : TOK.ink1;
  if (winB) {
    ctx.shadowColor = "rgba(245,179,1,0.5)";
    ctx.shadowBlur = 40;
  }
  ctx.fillText(String(match.scoreB), 790, 440);
  ctx.shadowBlur = 0;

  // MVP pill
  if (mvpName) {
    const mvpText = "⭐ MVP : " + mvpName.toUpperCase();
    ctx.font = '700 32px "Space Grotesk", system-ui, sans-serif';
    const tw = ctx.measureText(mvpText).width;
    const pillW = tw + 60;
    const pillX = (1080 - pillW) / 2;
    ctx.fillStyle = TOK.gold;
    drawRoundedRect(ctx, pillX, 495, pillW, 56, 28);
    ctx.fill();
    ctx.fillStyle = "#1f1500";
    ctx.textAlign = "center";
    ctx.fillText(mvpText, 540, 534);
  }

  const goalCount = {};
  goals.forEach((g) => {
    goalCount[g.scorerId] = (goalCount[g.scorerId] || 0) + 1;
  });
  const allPlayers = [...teamA, ...teamB];
  const scorers = allPlayers
    .filter((p) => goalCount[p.id])
    .sort((a, b) => goalCount[b.id] - goalCount[a.id])
    .slice(0, 5);

  const startY = mvpName ? 640 : 600;
  ctx.textAlign = "left";
  ctx.fillStyle = TOK.ink1;
  ctx.font = '700 22px "Space Grotesk", system-ui, sans-serif';
  ctx.fillText("BUTEURS", 140, startY);

  ctx.font = '700 28px "Space Grotesk", system-ui, sans-serif';
  scorers.forEach((p, i) => {
    const y = startY + 50 + i * 60;
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "·";
    ctx.fillStyle = TOK.ink0;
    ctx.fillText(`${medal}  ${p.name}`, 140, y);
    const count = goalCount[p.id];
    ctx.fillStyle = TOK.gold;
    ctx.font = '800 40px "JetBrains Mono", ui-monospace, monospace';
    ctx.fillText(String(count), 560, y);
    ctx.fillStyle = TOK.ink1;
    ctx.font = '600 26px "Space Grotesk", system-ui, sans-serif';
    const teamName = p.team === "A" ? match.teamAName : match.teamBName;
    ctx.fillText(teamName, 760, y);
    ctx.font = '700 28px "Space Grotesk", system-ui, sans-serif';
  });

  // Watermark
  ctx.fillStyle = TOK.ink2;
  ctx.font = '500 18px "Space Grotesk", system-ui, sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("FIVE SCORER · urban foot", 540, 1030);

  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png", 0.92));
}

export async function shareMatchImage(data) {
  const blob = await renderShareCard(data);
  if (!blob) return;
  const file = new File([blob], `five-scorer-${Date.now()}.png`, { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Match Five Scorer" });
      return;
    } catch (_) {}
  }
  // Fallback: download
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
