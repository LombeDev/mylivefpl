const errorBox = document.getElementById("error");

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.toggle("hidden", !msg);
}

function card(label, value, subHtml) {
  return `
    <div class="rounded-2xl border border-white/10 bg-gray-800/60 p-5">
      <p class="text-[11px] font-semibold uppercase tracking-wider text-gray-400">${label}</p>
      <p class="mt-2 text-3xl font-bold tabular-nums text-white">${value}</p>
      <p class="mt-2 text-xs text-gray-500">${subHtml}</p>
    </div>`;
}

function renderMetrics(d) {
  let delta = "";
  if (d.rank_change) {
    delta = d.rank_change > 0
      ? `<span class="font-semibold text-emerald-400">▲ ${fmt.format(d.rank_change)}</span>`
      : `<span class="font-semibold text-rose-400">▼ ${fmt.format(-d.rank_change)}</span>`;
  }
  document.getElementById("metrics").innerHTML = [
    card("Live GW points", fmt.format(d.net), `${d.gross} gross, −${d.hits} hits`),
    card("Overall rank", d.rank ? `#${fmt.format(d.rank)}` : "–", `${delta} <span class="text-gray-500">last GW</span>`),
    card("Safety score", `${d.safety_pct}%`, "XI matches finished"),
    card("Yet to play", String(d.yet_to_play), "of your starting XI"),
  ].join("");
}

function pitchPlayer(p) {
  const pts = p.points * p.multiplier;
  return `
    <div class="flex w-20 flex-col items-center sm:w-24 ${p.status === "pending" ? "opacity-70" : ""}">
      <div class="relative flex h-11 w-11 items-center justify-center rounded-full bg-white text-[11px] font-bold text-gray-900 shadow-lg sm:h-12 sm:w-12">
        ${esc(p.team)}
        ${p.captain ? `<span class="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-400 text-[10px] font-bold text-gray-900">C</span>` : ""}
        ${p.bonus > 0 ? `<span class="absolute -bottom-1 -left-1 rounded px-1 text-[9px] font-bold text-gray-900 ${p.provisional ? "bg-amber-300" : "bg-emerald-300"}">+${p.bonus}</span>` : ""}
      </div>
      <p class="mt-1 w-full truncate rounded bg-gray-900/80 px-1.5 py-0.5 text-center text-[11px] font-semibold text-white">${esc(p.name)}</p>
      <p class="text-[11px] font-semibold tabular-nums text-emerald-200">${pts} pts</p>
    </div>`;
}

function renderPitch(lineup) {
  const lines = [4, 3, 2, 1].map((type) =>
    lineup.filter((p) => p.type === type).sort((a, b) => a.position - b.position)
  );
  document.getElementById("pitch").innerHTML = `
    <div class="pointer-events-none absolute inset-3 rounded-xl border border-white/20"></div>
    <div class="pointer-events-none absolute inset-x-3 top-1/2 h-px bg-white/20"></div>
    <div class="relative flex min-h-[520px] flex-col justify-around px-4 py-8">
      ${lines.map((line) => `<div class="flex justify-around">${line.map(pitchPlayer).join("")}</div>`).join("")}
    </div>`;
}

const STATUS_LABEL = { pending: "Yet to play", live: "Playing", finished: "Finished", blank: "Blank GW" };

function chip(text, cls) {
  return `<span class="rounded px-1.5 py-0.5 text-[11px] font-semibold ${cls}">${text}</span>`;
}

function tableRow(p) {
  const base = p.points - p.bonus;
  const status = p.subbed_out
    ? chip("Auto-subbed off", "bg-rose-500/15 text-rose-300")
    : p.subbed_in
      ? chip("Auto-sub on", "bg-emerald-500/15 text-emerald-300")
      : `<span class="text-xs text-gray-400">${STATUS_LABEL[p.status]}</span>`;
  const bonus = p.bonus > 0
    ? `<span class="${p.provisional ? "text-amber-300" : "text-emerald-300"}">+${p.bonus}${p.provisional ? ' <span class="text-[10px] opacity-80">prov</span>' : ""}</span>`
    : `<span class="text-gray-600">–</span>`;

  return `
    <tr class="border-t border-white/5 ${p.subbed_out ? "opacity-40" : ""} ${p.subbed_in ? "bg-emerald-500/5" : ""}">
      <td class="px-3 py-2">
        <span class="font-medium text-white">${esc(p.name)}</span>
        ${p.captain ? chip("C", "bg-amber-400/15 text-amber-300") : ""}
        <span class="ml-1 text-xs text-gray-500">${esc(p.team)} · ${p.pos}</span>
      </td>
      <td class="px-3 py-2">${status}</td>
      <td class="px-3 py-2 text-right tabular-nums text-gray-300">${p.minutes}</td>
      <td class="px-3 py-2 text-right tabular-nums text-gray-300">${base}</td>
      <td class="px-3 py-2 text-right tabular-nums">${bonus}</td>
      <td class="px-3 py-2 text-right tabular-nums text-gray-300">${p.multiplier ? `×${p.multiplier}` : "–"}</td>
      <td class="px-3 py-2 text-right font-semibold tabular-nums text-white">${p.points * p.multiplier}</td>
      <td class="px-3 py-2 text-right tabular-nums text-gray-300">${p.eo.toFixed(1)}%</td>
    </tr>`;
}

function renderTable(d) {
  const head = `
    <thead class="bg-gray-800/80 text-[11px] uppercase tracking-wider text-gray-400">
      <tr>
        <th class="px-3 py-2 text-left font-medium">Player</th>
        <th class="px-3 py-2 text-left font-medium">Status</th>
        <th class="px-3 py-2 text-right font-medium">Min</th>
        <th class="px-3 py-2 text-right font-medium">Pts</th>
        <th class="px-3 py-2 text-right font-medium">Bonus</th>
        <th class="px-3 py-2 text-right font-medium">Mult</th>
        <th class="px-3 py-2 text-right font-medium">Total</th>
        <th class="px-3 py-2 text-right font-medium" title="Selected by %, captaincy share not in FPL API">EO</th>
      </tr>
    </thead>`;
  const section = (label) =>
    `<tr class="bg-white/[0.03]"><td colspan="8" class="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-300">${label}</td></tr>`;

  document.getElementById("squad").innerHTML =
    head +
    `<tbody>${section("Starting XI")}${d.xi.map(tableRow).join("")}${section("Bench")}${d.bench.map(tableRow).join("")}</tbody>`;
}

async function loadEstimate() {
  try {
    const res = await fetch("/api/rank-estimate", { cache: "no-store" });
    if (!res.ok) return;
    const e = await res.json();
    document.getElementById("estimate").textContent =
      `Estimated live rank: #${fmt.format(e.estimated_rank)} (sample ${e.sample_size})`;
  } catch (_) {}
}

async function load() {
  try {
    const res = await fetch("/api/rank", { cache: "no-store" });
    if (res.status === 401) {
      location.href = "/login";
      return;
    }
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`);

    document.getElementById("subtitle").textContent =
      `${d.entry.manager} · ${d.entry.name} · GW${d.gw}${d.chip ? " · " + d.chip : ""}`;
    renderMetrics(d);
    renderPitch(d.pitch);
    renderTable(d);
    showError("");
  } catch (err) {
    showError(err.message);
  }
}

function refresh() {
  if (document.visibilityState !== "visible") return;
  load();
  loadEstimate();
}

refresh();
setInterval(refresh, 60_000);


const TONE_STATUS = {
  finished: { label: "Done", cls: "bg-white/10 text-gray-300" },
  live: { label: "Live", cls: "bg-emerald-500/20 text-emerald-300" },
  upcoming: { label: "Upcoming", cls: "bg-white/5 text-gray-500" },
};

function fixtureStatus(f) {
  if (f.finished) return TONE_STATUS.finished;
  if (f.started) return TONE_STATUS.live;
  return TONE_STATUS.upcoming;
}

function eventLine(p) {
  const bits = [];
  if (p.goals) bits.push(`⚽ ${p.goals > 1 ? p.goals + " " : ""}${esc(p.name)}`);
  if (p.assists) bits.push(`A ${esc(p.name)}`);
  if (p.saves >= 3) bits.push(`🧤 ${p.saves} saves`);
  if (p.yellow) bits.push(`🟨 ${esc(p.name)}`);
  if (p.red) bits.push(`🟥 ${esc(p.name)}`);
  if (p.clean_sheet && p.minutes >= 60) bits.push(`CS ${esc(p.name)}`);
  if (p.defcon) bits.push(`DC ${esc(p.name)} (${p.defcon})`);
  return bits;
}

function raceRow(p) {
  const tone = p.provisional
    ? "bg-amber-300/20 text-amber-300"
    : p.bonus > 0 ? "bg-emerald-300/20 text-emerald-300" : "";
  return `
    <li class="flex items-center gap-2 py-1 text-sm">
      <span class="w-6 text-xs font-semibold tabular-nums ${p.bonus ? "text-white" : "text-transparent"}">
        ${p.bonus ? `+${p.bonus}` : "+0"}
      </span>
      <span class="${tone} rounded px-1 text-[10px] font-bold ${p.bonus ? "" : "invisible"}">${p.provisional ? "prov" : ""}</span>
      <span class="min-w-0 flex-1 truncate ${p.mine ? "font-semibold text-white" : "text-gray-300"}">
        ${p.mine ? '<span class="mr-1 text-emerald-400">●</span>' : ""}${esc(p.name)}
      </span>
      <span class="tabular-nums text-gray-400">${p.bps}</span>
      <span class="w-10 text-right text-xs tabular-nums text-gray-500">${p.points} pts</span>
    </li>`;
}

function fixtureCard(f) {
  const st = fixtureStatus(f);
  const score =
    f.home_score == null ? "v" : `${f.home_score} – ${f.away_score}`;
  const home = f.players.filter((p) => p.side === "h");
  const away = f.players.filter((p) => p.side === "a");
  const events = f.players.flatMap(eventLine);

  const column = (list) =>
    list.length
      ? list.slice(0, 6).map(raceRow).join("")
      : `<li class="py-1 text-sm text-gray-600">No bonus points yet</li>`;

  return `
    <article class="rounded-2xl border border-white/10 bg-gray-800/60 p-4">
      <header class="mb-3 flex items-center justify-between">
        <p class="text-base font-bold text-white">
          ${esc(f.home)} <span class="mx-2 tabular-nums text-gray-300">${score}</span> ${esc(f.away)}
        </p>
        <span class="rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${st.cls}">${st.label}</span>
      </header>

      <div class="grid grid-cols-2 gap-4">
        <div>
          <p class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">${esc(f.home)} bonus race</p>
          <ul class="divide-y divide-white/5">${column(home)}</ul>
        </div>
        <div>
          <p class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">${esc(f.away)} bonus race</p>
          <ul class="divide-y divide-white/5">${column(away)}</ul>
        </div>
      </div>

      ${events.length
        ? `<p class="mt-3 border-t border-white/5 pt-3 text-xs leading-relaxed text-gray-400">${events.join(" · ")}</p>`
        : ""}
    </article>`;
}

async function loadMatches() {
  try {
    const res = await fetch("/api/match-review", { cache: "no-store" });
    if (!res.ok) return;
    const d = await res.json();
    const box = document.getElementById("matches");
    box.innerHTML = d.fixtures.length
      ? d.fixtures.map(fixtureCard).join("")
      : `<p class="text-sm text-gray-500">No fixtures this gameweek.</p>`;
  } catch (_) {}
}

function refresh() {
  if (document.visibilityState !== "visible") return;
  load();
  loadEstimate();
  loadMatches();
}