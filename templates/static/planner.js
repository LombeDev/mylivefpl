const MAX_FT = 5;
const HIT = 4;
const CLUB_LIMIT = 3;
const POS_LIMIT = { 1: 2, 2: 5, 3: 5, 4: 3 };
const POS = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };
const BASE = { 1: 3, 2: 3.5, 3: 4, 4: 4.5 };
const XI_SHAPE = [[1, 1], [2, 4], [3, 4], [4, 2]];

const $ = (id) => document.getElementById(id);
const money = (tenths) => `£${(tenths / 10).toFixed(1)}m`;
const bySquad = (a, b) => a.type - b.type || a.name.localeCompare(b.name);

let D = null;
let players = new Map();
let teams = new Map();
let fixByGw = new Map();
let transfers = [];      // { gw, out, in }
let selGw = null;
let outId = null;
let query = "";
let posFilter = "same";
let maxPrice = "";

/* ---------- simulation ---------- */

// Walks the horizon GW by GW. Each GW's transfers apply in order. FT is used
// first, and anything beyond that costs a hit. Bank tracks sell and buy prices.
function simulate() {
  let squad = [...D.squad];
  let bank = D.bank;
  let ft = D.ft;

  return D.horizon.map((gw) => {
    let applied = 0;
    for (const t of transfers.filter((x) => x.gw === gw)) {
      const out = players.get(t.out);
      const inn = players.get(t.in);
      if (!out || !inn || !squad.includes(t.out)) continue; // stale after an edit
      squad = squad.map((id) => (id === t.out ? t.in : id));
      bank += out.price - inn.price;
      applied++;
    }
    const avail = ft;
    const hits = Math.max(0, applied - avail) * HIT;
    ft = Math.min(Math.max(avail - applied, 0) + 1, MAX_FT);
    return { gw, avail, used: applied, hits, bank, squad: [...squad] };
  });
}

/* ---------- expected points model ---------- */

function fixturesFor(teamId, gw) {
  return (fixByGw.get(gw) || []).filter((f) => f.h === teamId || f.a === teamId);
}

// Rough expected points for one GW from team strength and position.
// It's a comparison tool, not a forecast: it ignores form and minutes.
function epFor(p, gw) {
  const own = teams.get(p.team)?.strength ?? 3;
  const avail = (p.chance ?? 100) / 100;
  let total = 0;
  for (const f of fixturesFor(p.team, gw)) {
    const oppId = f.h === p.team ? f.a : f.h;
    const opp = teams.get(oppId)?.strength ?? 3;
    total += 2 * BASE[p.type] * (own / (own + opp)) * avail;
  }
  return total;
}

function horizonEp(p) {
  return D.horizon.reduce((sum, gw) => sum + epFor(p, gw), 0);
}

// Best 4-4-2-style XI estimate from the squad.
function bestXi(ids, gw) {
  const list = ids.map((id) => players.get(id)).filter(Boolean);
  let total = 0;
  for (const [type, count] of XI_SHAPE) {
    const vals = list
      .filter((p) => p.type === type)
      .map((p) => epFor(p, gw))
      .sort((a, b) => b - a);
    total += vals.slice(0, count).reduce((a, b) => a + b, 0);
  }
  return total;
}

function fixtureCells(p, gw) {
  const own = teams.get(p.team)?.strength ?? 3;
  const cells = fixturesFor(p.team, gw).map((f) => {
    const home = f.h === p.team;
    const opp = teams.get(home ? f.a : f.h);
    const diff = (opp?.strength ?? 3) - own;
    const cls =
      diff <= -1 ? "bg-emerald-400 text-gray-900"
      : diff === 0 ? "bg-gray-600 text-gray-100"
      : diff === 1 ? "bg-rose-500 text-white"
      : "bg-rose-800 text-white";
    return `<span class="block rounded px-1.5 py-0.5 text-center text-[11px] font-semibold ${cls}">${esc(opp?.short ?? "?")} ${home ? "H" : "A"}</span>`;
  });
  return cells.length
    ? cells.join("")
    : `<span class="block text-center text-xs text-gray-600">Blank</span>`;
}

/* ---------- candidates ---------- */

function candidates(sim, out) {
  const budget = sim.bank + out.price;
  const cap = maxPrice ? Math.round(parseFloat(maxPrice) * 10) : Infinity;
  const q = query.trim().toLowerCase();
  const squadSet = new Set(sim.squad);
  const others = sim.squad
    .map((id) => players.get(id))
    .filter((p) => p && p.id !== out.id);

  return [...players.values()]
    .filter((p) => !squadSet.has(p.id))
    .filter((p) =>
      posFilter === "any" ||
      (posFilter === "same" ? p.type === out.type : p.type === Number(posFilter))
    )
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.full.toLowerCase().includes(q))
    .filter((p) => p.price <= cap)
    .map((p) => {
      let reason = null;
      if (p.price > budget) reason = "Over budget";
      else if (others.filter((x) => x.team === p.team).length >= CLUB_LIMIT)
        reason = `${CLUB_LIMIT} from this club`;
      else if (others.filter((x) => x.type === p.type).length >= POS_LIMIT[p.type])
        reason = "Position full";
      return { p, reason, ep: horizonEp(p) };
    })
    .sort((a, b) => (!!a.reason - !!b.reason) || b.ep - a.ep)
    .slice(0, 40);
}

/* ---------- rendering ---------- */

function card(label, value, foot) {
  return `
    <div class="rounded-2xl border border-white/10 bg-gray-800/60 p-5">
      <p class="text-[11px] font-semibold uppercase tracking-wider text-gray-400">${label}</p>
      <p class="mt-2 text-3xl font-bold tabular-nums text-white">${value}</p>
      <p class="mt-2 text-xs text-gray-500">${foot}</p>
    </div>`;
}

function chip(text, tone) {
  const cls =
    tone === "emerald" ? "bg-emerald-500/15 text-emerald-300"
    : tone === "rose" ? "bg-rose-500/15 text-rose-300"
    : "bg-amber-400/15 text-amber-300";
  return `<span class="rounded px-1.5 py-0.5 text-[11px] font-semibold ${cls}">${text}</span>`;
}

function showError(msg) {
  $("error").textContent = msg;
  $("error").classList.toggle("hidden", !msg);
}

function renderStrip() {
  $("strip").innerHTML = D.horizon
    .map((gw) => {
      const count = transfers.filter((t) => t.gw === gw).length;
      const on = gw === selGw;
      return `
        <button onclick="selectGw(${gw})"
          class="rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
            on ? "bg-emerald-500 text-white shadow-sm shadow-emerald-500/20" : "bg-gray-800 text-gray-400 hover:text-white"
          }">
          GW${gw}${count ? ` <span class="ml-1 rounded bg-white/20 px-1.5 text-xs">${count}</span>` : ""}
        </button>`;
    })
    .join("");
}

function renderMetrics(sims, sim) {
  const squadValue = sim.squad.reduce((s, id) => s + (players.get(id)?.price ?? 0), 0);
  const gwNet = bestXi(sim.squad, sim.gw) - sim.hits;
  const horizonNet = sims.reduce((s, x) => s + bestXi(x.squad, x.gw) - x.hits, 0);

  $("metrics").innerHTML = [
    card("Bank", money(sim.bank), `Squad ${money(squadValue)}`),
    card("Free transfers", `${sim.avail} FT`, `${sim.used} planned in GW${sim.gw}`),
    card("Hit cost", `−${sim.hits}`, "points deducted"),
    card(`GW${sim.gw} projection`, gwNet.toFixed(1), "XI estimate, net of hits"),
    card(`Next ${D.horizon.length} GWs`, horizonNet.toFixed(1), "anticipated, net of hits"),
  ].join("");
}

function renderSquad(sim) {
  const bought = new Set(transfers.filter((t) => t.gw === selGw).map((t) => t.in));
  const list = sim.squad.map((id) => players.get(id)).filter(Boolean).sort(bySquad);

  const rows = list
    .map((p) => {
      const selected = outId === p.id;
      return `
        <button onclick="pickOut(${p.id})"
          class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
            selected ? "bg-rose-500/15" : "hover:bg-white/5"
          }">
          <span class="w-10 text-[11px] font-semibold text-gray-500">${POS[p.type]}</span>
          <span class="min-w-0 flex-1">
            <span class="block truncate font-medium text-white">${esc(p.name)}</span>
            <span class="text-xs text-gray-500">${esc(p.team_short)}</span>
          </span>
          ${bought.has(p.id) ? chip("IN", "emerald") : ""}
          ${selected ? chip("OUT", "rose") : ""}
          <span class="w-16 text-right text-sm tabular-nums text-gray-300">${money(p.price)}</span>
          <span class="w-14 text-right text-sm font-semibold tabular-nums text-emerald-300">${epFor(p, sim.gw).toFixed(1)}</span>
        </button>`;
    })
    .join("");

  $("squad").innerHTML = `
    <div class="flex items-center gap-3 border-b border-white/10 bg-gray-800/80 px-3 py-2 text-[11px] uppercase tracking-wider text-gray-400">
      <span class="w-10">Pos</span>
      <span class="flex-1">Player</span>
      <span class="w-16 text-right">Price</span>
      <span class="w-14 text-right">xPts</span>
    </div>
    <div class="divide-y divide-white/5">${rows}</div>`;
}

function renderTransfers(sim) {
  const list = transfers
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.gw === selGw);

  const items = list.length
    ? list
        .map(
          ({ t, i }) => `
          <li class="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm">
            <span class="text-gray-300">
              <span class="text-rose-300">${esc(players.get(t.out)?.name ?? "?")}</span>
              → <span class="text-emerald-300">${esc(players.get(t.in)?.name ?? "?")}</span>
            </span>
            <button onclick="removeTransfer(${i})" class="text-xs text-gray-500 hover:text-white">Remove</button>
          </li>`
        )
        .join("")
    : `<p class="text-sm text-gray-500">No transfers yet. Click a player in your squad to start.</p>`;

  const warning =
    sim.used > sim.avail
      ? `<p class="mt-3 text-xs text-amber-300">${sim.used - sim.avail} transfer(s) beyond your free transfers: −${sim.hits} pts.</p>`
      : "";

  $("transfers").innerHTML = `
    <div class="mb-3 flex items-center justify-between">
      <h2 class="text-sm font-semibold text-white">Transfers in GW${sim.gw}</h2>
      ${list.length ? `<button onclick="clearGw()" class="text-xs text-gray-400 hover:text-rose-300">Clear GW${sim.gw}</button>` : ""}
    </div>
    <ul class="space-y-2">${items}</ul>
    ${warning}
    ${transfers.length ? `<button onclick="resetPlan()" class="mt-4 text-xs text-gray-500 hover:text-rose-300">Reset whole plan</button>` : ""}`;
}

function renderSearch(sim) {
  const out = outId != null ? players.get(outId) : null;
  $("replace-body").classList.toggle("hidden", !out);

  if (!out) {
    $("replace-head").innerHTML = `
      <p class="text-sm text-gray-500">
        Click a player in your squad to find a replacement. Candidates are filtered by budget, position and club limit.
      </p>`;
    $("candidates").innerHTML = "";
    return;
  }

  const willHit = sim.used >= sim.avail;
  $("replace-head").innerHTML = `
    <div class="flex items-start justify-between gap-3">
      <div>
        <p class="text-[11px] uppercase tracking-wider text-gray-400">Replace</p>
        <p class="font-semibold text-white">${esc(out.name)} <span class="text-sm font-normal text-gray-400">${money(out.price)}</span></p>
        <p class="text-xs text-gray-500">Budget ${money(sim.bank + out.price)}</p>
      </div>
      <button onclick="cancelOut()" class="text-xs text-gray-400 hover:text-white">Cancel</button>
    </div>
    ${willHit ? `<p class="mt-3 text-xs text-amber-300">No free transfers left this GW. Each extra transfer costs −${HIT} pts.</p>` : ""}`;

  const list = candidates(sim, out);
  $("candidates").innerHTML = list.length
    ? list
        .map(
          ({ p, reason, ep }) => `
          <li>
            <button onclick="makeTransfer(${p.id})" ${reason ? "disabled" : ""}
              class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent">
              <span class="w-10 text-[11px] font-semibold text-gray-500">${POS[p.type]}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate font-medium text-white">${esc(p.name)}</span>
                <span class="text-xs text-gray-500">${esc(p.team_short)} · ${reason ?? (willHit ? `Transfer costs −${HIT}` : "Transfer in")}</span>
              </span>
              <span class="w-16 text-right text-sm tabular-nums text-gray-300">${money(p.price)}</span>
              <span class="w-14 text-right text-sm font-semibold tabular-nums text-emerald-300">${ep.toFixed(1)}</span>
            </button>
          </li>`
        )
        .join("")
    : `<li class="px-4 py-6 text-center text-sm text-gray-500">No matches.</li>`;
}

function renderTicker(sims) {
  const finalSquad = sims[sims.length - 1].squad
    .map((id) => players.get(id))
    .filter(Boolean)
    .sort(bySquad);

  const head = `
    <thead class="bg-gray-800/80 text-[11px] uppercase tracking-wider text-gray-400">
      <tr>
        <th class="px-3 py-2 text-left font-medium">Player</th>
        ${D.horizon.map((gw) => `<th class="px-3 py-2 text-center font-medium">GW${gw}</th>`).join("")}
        <th class="px-3 py-2 text-right font-medium">Total</th>
      </tr>
    </thead>`;

  const body = finalSquad
    .map(
      (p) => `
      <tr class="border-t border-white/5">
        <td class="px-3 py-2">
          <span class="font-medium text-white">${esc(p.name)}</span>
          <span class="ml-1 text-xs text-gray-500">${esc(p.team_short)}</span>
        </td>
        ${D.horizon
          .map((gw) => `<td class="px-2 py-2"><div class="flex flex-col gap-0.5">${fixtureCells(p, gw)}</div></td>`)
          .join("")}
        <td class="px-3 py-2 text-right font-semibold tabular-nums text-emerald-300">${horizonEp(p).toFixed(1)}</td>
      </tr>`
    )
    .join("");

  $("ticker").innerHTML = `<table class="w-full min-w-[640px] text-left text-sm">${head}<tbody>${body}</tbody></table>`;
}

function render() {
  if (!D) return;
  const sims = simulate();
  if (!sims.length) {
    showError("No upcoming gameweeks to plan.");
    return;
  }
  const sim = sims.find((s) => s.gw === selGw) ?? sims[0];

  $("subtitle").textContent = `${D.manager} · ${D.entry_name} · planning from GW${D.next_gw}`;
  renderStrip();
  renderMetrics(sims, sim);
  renderSquad(sim);
  renderTransfers(sim);
  renderSearch(sim);
  renderTicker(sims);
}

/* ---------- actions (called from inline onclick) ---------- */

function selectGw(gw) {
  selGw = gw;
  outId = null;
  render();
}

function pickOut(id) {
  outId = outId === id ? null : id;
  render();
}

function cancelOut() {
  outId = null;
  render();
}

function makeTransfer(inId) {
  if (outId == null || selGw == null) return;
  transfers.push({ gw: selGw, out: outId, in: inId });
  outId = null;
  render();
}

function removeTransfer(index) {
  transfers.splice(index, 1);
  render();
}

function clearGw() {
  transfers = transfers.filter((t) => t.gw !== selGw);
  render();
}

function resetPlan() {
  transfers = [];
  outId = null;
  render();
}

/* ---------- wiring ---------- */

$("q").addEventListener("input", (e) => {
  query = e.target.value;
  render();
});
$("pos").addEventListener("change", (e) => {
  posFilter = e.target.value;
  render();
});
$("max").addEventListener("input", (e) => {
  maxPrice = e.target.value;
  render();
});

async function load() {
  try {
    const res = await fetch("/api/planner", { cache: "no-store" });
    if (res.status === 401) {
      location.href = "/login";
      return;
    }
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `Request failed (${res.status})`);

    D = d;
    players = new Map(d.players.map((p) => [p.id, p]));
    teams = new Map(Object.entries(d.teams).map(([id, t]) => [Number(id), t]));
    fixByGw = new Map();
    for (const f of d.fixtures) {
      if (!fixByGw.has(f.gw)) fixByGw.set(f.gw, []);
      fixByGw.get(f.gw).push(f);
    }
    selGw = d.horizon[0] ?? null;
    transfers = [];
    showError("");
    render();
  } catch (err) {
    showError(err.message);
  }
}

load();