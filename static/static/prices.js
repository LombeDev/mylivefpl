const TAB_ON = { risers: "bg-emerald-500 text-white", fallers: "bg-rose-500 text-white" };
let rows = [];
let tab = "risers";

const $ = (id) => document.getElementById(id);

function sortRows(list, key) {
  const value = {
    progress: (r) => r.progress,
    net: (r) => Math.abs(r.net),
    price: (r) => r.price,
    own: (r) => r.own,
  }[key];
  return list.sort((a, b) => value(b) - value(a));
}

function rowHtml(r) {
  const rise = r.net > 0;
  const color = rise ? "text-emerald-300" : "text-rose-300";
  const bar = rise ? "bg-emerald-400" : "bg-rose-400";
  return `
    <tr class="border-t border-white/5 hover:bg-white/[0.02]">
      <td class="px-3 py-2.5 font-medium text-white">${esc(r.name)}</td>
      <td class="px-3 py-2.5 text-gray-300">${esc(r.team)}</td>
      <td class="px-3 py-2.5 text-xs font-semibold text-gray-500">${r.pos}</td>
      <td class="px-3 py-2.5 text-right tabular-nums text-gray-300">£${r.price.toFixed(1)}m</td>
      <td class="px-3 py-2.5 text-right tabular-nums text-gray-300">${r.own.toFixed(1)}%</td>
      <td class="px-3 py-2.5 text-right font-semibold tabular-nums ${color}">${rise ? "+" : ""}${fmt.format(r.net)}</td>
      <td class="px-3 py-2.5">
        <div class="flex items-center gap-3">
          <div class="h-2 w-32 overflow-hidden rounded-full bg-white/10">
            <div class="h-full rounded-full ${bar}" style="width:${r.progress.toFixed(1)}%"></div>
          </div>
          <span class="w-12 text-xs tabular-nums text-gray-400">${r.progress.toFixed(0)}%</span>
        </div>
      </td>
    </tr>`;
}

function draw() {
  const q = $("search").value.trim().toLowerCase();
  const pos = $("pos").value;
  const club = $("club").value;

  let list = rows.filter((r) => (tab === "risers" ? r.net > 0 : r.net < 0));
  list = list.filter(
    (r) =>
      (pos === "all" || String(r.type) === pos) &&
      (club === "all" || r.team === club) &&
      (!q || r.full.toLowerCase().includes(q) || r.name.toLowerCase().includes(q))
  );
  sortRows(list, $("sort").value);

  const shown = list.slice(0, 150);
  $("rows").innerHTML =
    shown.map(rowHtml).join("") ||
    `<tr><td colspan="7" class="px-3 py-8 text-center text-gray-500">No players match these filters.</td></tr>`;
  $("count").textContent = `Showing ${shown.length} of ${list.length}`;
  paintTabs();
}

function paintTabs() {
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    const name = btn.dataset.tab;
    const active = name === tab;
    btn.className = `rounded-full px-5 py-2 text-sm font-semibold transition-colors ${
      active ? TAB_ON[name] : "text-gray-400 hover:text-white"
    }`;
  });
  document.querySelector('[data-count="risers"]').textContent = rows.filter((r) => r.net > 0).length;
  document.querySelector('[data-count="fallers"]').textContent = rows.filter((r) => r.net < 0).length;
}

function fillClubs() {
  const clubs = [...new Set(rows.map((r) => r.team))].sort();
  $("club").insertAdjacentHTML(
    "beforeend",
    clubs.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("")
  );
}

document.querySelectorAll("[data-tab]").forEach((btn) =>
  btn.addEventListener("click", () => {
    tab = btn.dataset.tab;
    draw();
  })
);
["search", "pos", "club", "sort"].forEach((id) => $(id).addEventListener("input", draw));

getJSON("/api/prices")
  .then((d) => {
    rows = d.rows;
    fillClubs();
    draw();
  })
  .catch((err) => {
    $("error").textContent = err.message;
    $("error").classList.remove("hidden");
  });