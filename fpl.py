
import asyncio
import time
from collections import Counter, defaultdict

import httpx

FPL = "https://fantasy.premierleague.com/api"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Kopala FPL)",
    "Accept": "application/json",
}
POS = {1: "GKP", 2: "DEF", 3: "MID", 4: "FWD"}

# Price model: share of ownership that must transfer net to move a price.
# FPL doesn't publish its thresholds, so tune this against the official site.
MANAGERS = 11_000_000
PRICE_RATE = 0.00015

_cache: dict[str, tuple[float, object]] = {}


async def get(path: str, ttl: int = 30):
    """GET from the FPL API with a small in-memory cache."""
    hit = _cache.get(path)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]

    async with httpx.AsyncClient(headers=HEADERS, timeout=15) as client:
        r = await client.get(f"{FPL}/{path}")
        r.raise_for_status()
        data = r.json()

    _cache[path] = (time.time(), data)
    return data


async def bootstrap():
    return await get("bootstrap-static/", ttl=3600)


def current_event(events: list[dict]) -> dict:
    return (
        next((e for e in events if e["is_current"]), None)
        or next((e for e in events if e["is_next"]), None)
        or events[-1]
    )


def provisional_bonus(elements: list[dict], fixtures: list[dict]) -> dict[int, int]:
    """
    Live 3/2/1 bonus from BPS for fixtures still in play.
    Ties share the higher award, and the next place is skipped (FPL rules).
    """
    open_ids = {f["id"] for f in fixtures if not f["finished"]}
    per_fixture: dict[int, list[tuple[int, int]]] = defaultdict(list)

    for el in elements:
        for ex in el.get("explain", []):
            if ex["fixture"] not in open_ids:
                continue
            bps = next((s["value"] for s in ex["stats"] if s["identifier"] == "bps"), 0)
            if bps > 0:
                per_fixture[ex["fixture"]].append((bps, el["id"]))

    awards: dict[int, int] = defaultdict(int)
    slots = [3, 2, 1]
    for rows in per_fixture.values():
        rows.sort(reverse=True)
        i = 0
        while i < len(rows) and i < 3:
            j = i
            while j < len(rows) and rows[j][0] == rows[i][0]:
                j += 1
            for _, pid in rows[i:j]:
                awards[pid] += slots[i]
            i = j
    return dict(awards)


def legal_xi(players: list[dict], els: dict) -> bool:
    """1 GK, 3-5 DEF, 2-5 MID, 1-3 FWD, 11 players total."""
    if len(players) != 11:
        return False
    c = Counter(els[p["element"]]["element_type"] for p in players)
    return c[1] == 1 and 3 <= c[2] <= 5 and 2 <= c[3] <= 5 and 1 <= c[4] <= 3


async def live_team(team_id: int) -> dict:
    boot = await bootstrap()
    gw = current_event(boot["events"])["id"]

    entry, history, picks, live, fixtures = await asyncio.gather(
        get(f"entry/{team_id}/", ttl=300),
        get(f"entry/{team_id}/history/", ttl=300),
        get(f"entry/{team_id}/event/{gw}/picks/", ttl=30),
        get(f"event/{gw}/live/", ttl=30),
        get(f"fixtures/?event={gw}", ttl=60),
    )

    els = {e["id"]: e for e in boot["elements"]}
    teams = {t["id"]: t["short_name"] for t in boot["teams"]}
    live_by_id = {e["id"]: e["stats"] for e in live["elements"]}
    prov = provisional_bonus(live["elements"], fixtures)
    chip = picks.get("active_chip")
    bboost = chip == "bboost"

    def fixtures_for(pid: int) -> list[dict]:
        team = els[pid]["team"]
        return [f for f in fixtures if team in (f["team_h"], f["team_a"])]

    def minutes(pid: int) -> int:
        return live_by_id.get(pid, {}).get("minutes", 0)

    def points(pid: int) -> int:
        return live_by_id.get(pid, {}).get("total_points", 0) + prov.get(pid, 0)

    def status(pid: int) -> str:
        fs = fixtures_for(pid)
        if not fs:
            return "blank"
        if all(f["finished"] for f in fs):
            return "finished"
        if any(f["started"] and not f["finished"] for f in fs):
            return "live"
        return "pending"

    def done(pid: int) -> bool:
        return status(pid) in ("finished", "blank")

    def unstarted(pid: int) -> bool:
        return any(not f["started"] for f in fixtures_for(pid))

    ordered = sorted(picks["picks"], key=lambda p: p["position"])
    xi = [dict(p, subbed_out=False, subbed_in=False) for p in ordered if p["position"] <= 11]
    bench = [dict(p, subbed_out=False, subbed_in=False) for p in ordered if p["position"] > 11]

    # Auto-subs: a starter who didn't play after their match finished is replaced
    # by the first bench player who did, if the formation stays legal.
    # Bench Boost disables auto-subs.
    lineup = list(xi)
    if not bboost:
        for i, starter in enumerate(xi):
            pid = starter["element"]
            if not (done(pid) and minutes(pid) == 0):
                continue
            for sub in bench:
                if sub["subbed_in"] or minutes(sub["element"]) == 0:
                    continue
                trial = lineup[:i] + [sub] + lineup[i + 1 :]
                if legal_xi(trial, els):
                    starter["subbed_out"] = True
                    sub["subbed_in"] = True
                    lineup[i] = sub
                    break

    active = [*lineup, *bench] if bboost else lineup
    active_ids = {p["element"] for p in active}

    # Captaincy: vice takes over if the captain is out and the vice played.
    cap = next((p["element"] for p in picks["picks"] if p["is_captain"]), None)
    vice = next((p["element"] for p in picks["picks"] if p["is_vice_captain"]), None)
    cap_mult = 3 if chip == "3xc" else 2
    captain = cap
    if (
        cap is not None
        and vice is not None
        and (cap not in active_ids or (done(cap) and minutes(cap) == 0))
        and vice in active_ids
        and minutes(vice) > 0
    ):
        captain = vice

    def mult(pid: int) -> int:
        if pid not in active_ids:
            return 0
        return cap_mult if pid == captain else 1

    def row(p: dict) -> dict:
        pid = p["element"]
        el = els[pid]
        st = live_by_id.get(pid, {})
        return {
            "id": pid,
            "name": el["web_name"],
            "team": teams.get(el["team"], ""),
            "pos": POS[el["element_type"]],
            "type": el["element_type"],
            "price": el["now_cost"] / 10,
            "eo": float(el["selected_by_percent"] or 0),
            "position": p["position"],
            "minutes": minutes(pid),
            "points": points(pid),
            "bonus": st.get("bonus", 0) + prov.get(pid, 0),
            "provisional": prov.get(pid, 0) > 0,
            "multiplier": mult(pid),
            "captain": mult(pid) > 0 and pid == captain,
            "status": status(pid),
            "subbed_out": p["subbed_out"],
            "subbed_in": p["subbed_in"],
        }

    gross = sum(points(p["element"]) * mult(p["element"]) for p in active)
    hits = picks["entry_history"]["event_transfers_cost"]
    finished = sum(1 for p in lineup if done(p["element"]))
    yet = sum(1 for p in lineup if unstarted(p["element"]))

    # FPL publishes overall rank after each GW, so the change is the movement
    # over the last completed gameweek.
    hist = history.get("current", [])
    change = None
    if len(hist) >= 2:
        change = hist[-2]["overall_rank"] - hist[-1]["overall_rank"]

    return {
        "gw": gw,
        "entry": {
            "name": entry["name"],
            "manager": f'{entry["player_first_name"]} {entry["player_last_name"]}',
        },
        "gross": gross,
        "hits": hits,
        "net": gross - hits,
        "rank": entry.get("summary_overall_rank"),
        "rank_change": change,
        "safety_pct": round(finished / 11 * 100),
        "yet_to_play": yet,
        "chip": chip,
        "pitch": [row(p) for p in lineup],
        "xi": [row(p) for p in xi],
        "bench": [row(p) for p in bench],
    }


async def price_changes() -> dict:
    boot = await bootstrap()
    teams = {t["id"]: t["short_name"] for t in boot["teams"]}
    rows = []

    for e in boot["elements"]:
        net = e["transfers_in_event"] - e["transfers_out_event"]
        if net == 0:
            continue
        own = float(e["selected_by_percent"] or 0)
        threshold = max(1.0, own / 100 * MANAGERS * PRICE_RATE)
        rows.append(
            {
                "id": e["id"],
                "name": e["web_name"],
                "full": f'{e["first_name"]} {e["second_name"]}',
                "team": teams.get(e["team"], ""),
                "pos": POS[e["element_type"]],
                "type": e["element_type"],
                "price": e["now_cost"] / 10,
                "own": own,
                "net": net,
                "progress": min(100.0, abs(net) / threshold * 100),
            }
        )
    return {"rows": rows}


# ---------- live rank estimate ----------

OVERALL_LEAGUE = 314      # FPL's overall classic league
PAGE_SIZE = 50            # managers per standings page
SAMPLE_PER_PAGE = 2       # managers sampled from each standings page
DENSE_PAGES = 10          # sample every page up to here (top 500)
MAX_PAGE = 20_000         # about 1,000,000 managers
GROWTH = 1.3              # spacing grows by 30% per sampled page
CONCURRENCY = 4           # keep requests gentle on FPL
SAMPLE_TTL = 120          # seconds to reuse the sampled manager list

_sample_cache: dict = {"gw": None, "t": 0.0, "rows": []}


def sample_pages() -> list[int]:
    pages = list(range(1, DENSE_PAGES + 1))
    p = float(DENSE_PAGES)
    while p < MAX_PAGE:
        p *= GROWTH
        pages.append(min(MAX_PAGE, round(p)))
    return sorted(set(pages))


def page_weights(pages: list[int]) -> dict[int, float]:
    """How many managers each sampled page stands for, split across its samples."""
    weights = {}
    for i, p in enumerate(pages):
        lo = 1 if i == 0 else (pages[i - 1] + p) / 2
        hi = (p + pages[i + 1]) / 2 if i + 1 < len(pages) else p + 0.5
        weights[p] = (hi - lo) * PAGE_SIZE / SAMPLE_PER_PAGE
    return weights


async def _sample_managers(gw: int) -> list[tuple[int, float]]:
    """Returns (entry_id, weight) pairs, cached briefly."""
    now = time.time()
    if _sample_cache["gw"] == gw and now - _sample_cache["t"] < SAMPLE_TTL:
        return _sample_cache["rows"]

    pages = sample_pages()
    weights = page_weights(pages)
    sem = asyncio.Semaphore(CONCURRENCY)

    async def fetch_page(p: int):
        async with sem:
            data = await get(
                f"leagues-classic/{OVERALL_LEAGUE}/standings/?page_standings={p}",
                ttl=300,
            )
        results = data["standings"]["results"]
        step = max(1, PAGE_SIZE // SAMPLE_PER_PAGE)
        return [(r["entry"], weights[p]) for r in results[::step][:SAMPLE_PER_PAGE]]

    results = await asyncio.gather(*(fetch_page(p) for p in pages), return_exceptions=True)
    rows = []
    for r in results:
        if isinstance(r, Exception):
            continue  # skip pages FPL didn't return
        rows.extend(r)

    _sample_cache.update(gw=gw, t=now, rows=rows)
    return rows


async def _entry_points(entry_id: int, gw: int, live_pts: dict[int, int],
                        prov: dict[int, int], sem: asyncio.Semaphore) -> int | None:
    async with sem:
        try:
            picks = await get(f"entry/{entry_id}/event/{gw}/picks/", ttl=30)
        except httpx.HTTPError:
            return None  # private, missing, or temporarily unavailable

    bboost = picks.get("active_chip") == "bboost"
    total = 0
    for p in picks["picks"]:
        if p["position"] > 11 and not bboost:
            continue  # bench only scores under Bench Boost
        pid = p["element"]
        total += (live_pts.get(pid, 0) + prov.get(pid, 0)) * p["multiplier"]
    return total - picks["entry_history"]["event_transfers_cost"]


async def estimate_rank(team_id: int) -> dict:
    boot = await bootstrap()
    gw = current_event(boot["events"])["id"]

    sample, live, fixtures = await asyncio.gather(
        _sample_managers(gw),
        get(f"event/{gw}/live/", ttl=30),
        get(f"fixtures/?event={gw}", ttl=60),
    )

    live_pts = {e["id"]: e["stats"]["total_points"] for e in live["elements"]}
    prov = provisional_bonus(live["elements"], fixtures)

    sem = asyncio.Semaphore(CONCURRENCY)
    mine = await _entry_points(team_id, gw, live_pts, prov, sem)
    if mine is None:
        raise httpx.HTTPError("Could not load your picks for this gameweek")

    scores = await asyncio.gather(
        *(_entry_points(eid, gw, live_pts, prov, sem) for eid, _ in sample)
    )

    counted = [(s, w) for s, (_, w) in zip(scores, sample) if s is not None]
    above = sum(w for s, w in counted if s > mine)

    return {
        "gw": gw,
        "your_points": mine,
        "estimated_rank": round(1 + above),
        "sample_size": len(counted),
        "note": "Estimate from a sample of managers. Most accurate in the top few hundred thousand.",
    }


# ---------- planner ----------

PLAN_HORIZON = 6  # GWs shown in the planner strip
MAX_FT = 5


async def planner_data(team_id: int) -> dict:
    boot = await bootstrap()
    events = boot["events"]
    cur = current_event(events)["id"]
    last = events[-1]["id"]
    nxt = next((e["id"] for e in events if e["is_next"]), min(cur + 1, last))
    horizon = [g for g in range(nxt, nxt + PLAN_HORIZON) if g <= last]

    entry, history, picks, fixtures = await asyncio.gather(
        get(f"entry/{team_id}/", ttl=300),
        get(f"entry/{team_id}/history/", ttl=300),
        get(f"entry/{team_id}/event/{cur}/picks/", ttl=60),
        get("fixtures/", ttl=600),
    )

    # Free transfers entering the next GW: start with 1, then each finished GW
    # spends what was used and banks one more, capped at 5.
    ft = 1
    for e in history.get("current", []):
        if e["event"] >= nxt:
            break
        ft = min(max(ft - e["event_transfers"], 0) + 1, MAX_FT)

    teams = {
        t["id"]: {"short": t["short_name"], "strength": t["strength"]}
        for t in boot["teams"]
    }

    players = [
        {
            "id": e["id"],
            "name": e["web_name"],
            "full": f'{e["first_name"]} {e["second_name"]}',
            "team": e["team"],
            "team_short": teams.get(e["team"], {}).get("short", ""),
            "type": e["element_type"],
            "price": e["now_cost"],  # tenths of £m
            "chance": e["chance_of_playing_next_round"],
        }
        for e in boot["elements"]
    ]

    fixture_rows = [
        {"gw": f["event"], "h": f["team_h"], "a": f["team_a"]}
        for f in fixtures
        if f["event"] in horizon
    ]

    return {
        "entry_name": entry["name"],
        "manager": f'{entry["player_first_name"]} {entry["player_last_name"]}',
        "squad": [p["element"] for p in picks["picks"]],
        "bank": entry["last_deadline_bank"],  # tenths of £m
        "ft": ft,
        "next_gw": nxt,
        "horizon": horizon,
        "players": players,
        "teams": teams,
        "fixtures": fixture_rows,
    }

# ---------- match review ----------

def _stat(stats: dict, key: str) -> int:
    return stats.get(key, {}).get("value", 0)


async def match_review(team_id: int) -> dict:
    boot = await bootstrap()
    gw = current_event(boot["events"])["id"]
    els = {e["id"]: e for e in boot["elements"]}
    teams = {t["id"]: t["short_name"] for t in boot["teams"]}

    fixtures, live, picks = await asyncio.gather(
        get(f"fixtures/?event={gw}", ttl=60),
        get(f"event/{gw}/live/", ttl=30),
        get(f"entry/{team_id}/event/{gw}/picks/", ttl=30),
    )

    mine = {p["element"] for p in picks["picks"]}
    prov = provisional_bonus(live["elements"], fixtures)
    fx_by_id = {f["id"]: f for f in fixtures}
    per_fixture: dict[int, list[dict]] = defaultdict(list)

    for el in live["elements"]:
        pid = el["id"]
        player = els.get(pid)
        if not player:
            continue

        for ex in el.get("explain", []):
            fx = fx_by_id.get(ex["fixture"])
            if not fx:
                continue

            stats = {s["identifier"]: s for s in ex["stats"]}
            bps = _stat(stats, "bps")
            if bps == 0 and _stat(stats, "minutes") == 0:
                continue

            # Confirmed bonus once the match finishes; provisional before that.
            # Provisional awards are summed per player, so double gameweeks
            # may show the combined figure in this view.
            if fx["finished"]:
                bonus = stats["bonus"]["points"] if "bonus" in stats else 0
            else:
                bonus = prov.get(pid, 0)

            per_fixture[fx["id"]].append({
                "name": player["web_name"],
                "team": teams.get(player["team"], ""),
                "side": "h" if player["team"] == fx["team_h"] else "a",
                "points": sum(
                    s["points"] for s in ex["stats"]
                    if s["identifier"] not in ("bps", "bonus")
                ) + bonus,
                "bps": bps,
                "bonus": bonus,
                "provisional": not fx["finished"] and bonus > 0,
                "minutes": _stat(stats, "minutes"),
                "goals": _stat(stats, "goals_scored"),
                "assists": _stat(stats, "assists"),
                "saves": _stat(stats, "saves"),
                "yellow": _stat(stats, "yellow_cards"),
                "red": _stat(stats, "red_cards"),
                "clean_sheet": _stat(stats, "clean_sheets") > 0,
                "defcon": _stat(stats, "defensive_contribution"),
                "mine": pid in mine,
            })

    out = []
    for fx in sorted(fixtures, key=lambda f: f.get("kickoff_time") or ""):
        players = per_fixture.get(fx["id"], [])
        players.sort(key=lambda p: (-p["bps"], p["name"]))
        out.append({
            "id": fx["id"],
            "home": teams.get(fx["team_h"], ""),
            "away": teams.get(fx["team_a"], ""),
            "home_score": fx["team_h_score"],
            "away_score": fx["team_a_score"],
            "kickoff": fx.get("kickoff_time"),
            "started": fx["started"],
            "finished": fx["finished"],
            "players": players,
        })

    return {"gw": gw, "fixtures": out}



# ---------- live rank estimate ----------

OVERALL_LEAGUE = 314          # FPL's overall classic league
PAGE_SIZE = 50                # managers per standings page
SAMPLE_PER_PAGE = 2           # managers sampled from each standings page
DENSE_PAGES = 10              # sample every page up to here (top 500)
MAX_PAGE = 20_000             # about 1,000,000 managers
GROWTH = 1.3                  # spacing grows by 30% per sampled page
CONCURRENCY = 4               # keep requests gentle on FPL
SAMPLE_TTL = 120              # seconds to reuse the sampled manager list

_sample_cache: dict = {"gw": None, "t": 0.0, "rows": []}


def sample_pages() -> list[int]:
    pages = list(range(1, DENSE_PAGES + 1))
    p = float(DENSE_PAGES)
    while p < MAX_PAGE:
        p *= GROWTH
        pages.append(min(MAX_PAGE, round(p)))
    return sorted(set(pages))


def page_weights(pages: list[int]) -> dict[int, float]:
    """How many managers each sampled page stands for, split across its samples."""
    weights = {}
    for i, p in enumerate(pages):
        lo = 1 if i == 0 else (pages[i - 1] + p) / 2
        hi = (p + pages[i + 1]) / 2 if i + 1 < len(pages) else p + 0.5
        weights[p] = (hi - lo) * PAGE_SIZE / SAMPLE_PER_PAGE
    return weights


async def _sample_managers(gw: int) -> list[tuple[int, float]]:
    """Returns (entry_id, weight) pairs, cached briefly."""
    now = time.time()
    if _sample_cache["gw"] == gw and now - _sample_cache["t"] < SAMPLE_TTL:
        return _sample_cache["rows"]

    pages = sample_pages()
    weights = page_weights(pages)
    sem = asyncio.Semaphore(CONCURRENCY)

    async def fetch_page(p: int):
        async with sem:
            data = await get(
                f"leagues-classic/{OVERALL_LEAGUE}/standings/?page_standings={p}",
                ttl=300,
            )
        results = data["standings"]["results"]
        step = max(1, PAGE_SIZE // SAMPLE_PER_PAGE)
        return [(r["entry"], weights[p]) for r in results[::step][:SAMPLE_PER_PAGE]]

    results = await asyncio.gather(*(fetch_page(p) for p in pages), return_exceptions=True)
    rows = []
    for r in results:
        if isinstance(r, Exception):
            continue  # skip pages FPL didn't return
        rows.extend(r)

    _sample_cache.update(gw=gw, t=now, rows=rows)
    return rows


async def _entry_points(entry_id: int, gw: int, live_pts: dict[int, int],
                        prov: dict[int, int], sem: asyncio.Semaphore) -> int | None:
    async with sem:
        try:
            picks = await get(f"entry/{entry_id}/event/{gw}/picks/", ttl=30)
        except httpx.HTTPError:
            return None  # private, missing, or temporarily unavailable

    bboost = picks.get("active_chip") == "bboost"
    total = 0
    for p in picks["picks"]:
        if p["position"] > 11 and not bboost:
            continue  # bench only scores under Bench Boost
        pid = p["element"]
        total += (live_pts.get(pid, 0) + prov.get(pid, 0)) * p["multiplier"]
    return total - picks["entry_history"]["event_transfers_cost"]


async def estimate_rank(team_id: int) -> dict:
    boot = await bootstrap()
    gw = current_event(boot["events"])["id"]

    sample, live, fixtures = await asyncio.gather(
        _sample_managers(gw),
        get(f"event/{gw}/live/", ttl=30),
        get(f"fixtures/?event={gw}", ttl=60),
    )

    live_pts = {e["id"]: e["stats"]["total_points"] for e in live["elements"]}
    prov = provisional_bonus(live["elements"], fixtures)

    sem = asyncio.Semaphore(CONCURRENCY)
    mine = await _entry_points(team_id, gw, live_pts, prov, sem)
    if mine is None:
        raise httpx.HTTPError("Could not load your picks for this gameweek")

    scores = await asyncio.gather(
        *(_entry_points(eid, gw, live_pts, prov, sem) for eid, _ in sample)
    )

    counted = [(s, w) for s, (_, w) in zip(scores, sample) if s is not None]
    total_weight = sum(w for _, w in counted) or 1
    above = sum(w for s, w in counted if s > mine)

    return {
        "gw": gw,
        "your_points": mine,
        "estimated_rank": round(1 + above),
        "sample_size": len(counted),
        "note": "Estimate from a sample of managers. Most accurate in the top few hundred thousand.",
    }

    # ---------- planner ----------

PLAN_HORIZON = 6  # GWs shown in the planner strip
MAX_FT = 5


async def planner_data(team_id: int) -> dict:
    boot = await bootstrap()
    events = boot["events"]
    cur = current_event(events)["id"]
    last = events[-1]["id"]
    nxt = next((e["id"] for e in events if e["is_next"]), min(cur + 1, last))
    horizon = [g for g in range(nxt, nxt + PLAN_HORIZON) if g <= last]

    entry, history, picks, fixtures = await asyncio.gather(
        get(f"entry/{team_id}/", ttl=300),
        get(f"entry/{team_id}/history/", ttl=300),
        get(f"entry/{team_id}/event/{cur}/picks/", ttl=60),
        get("fixtures/", ttl=600),
    )

    # Free transfers entering the next GW: start with 1, then each finished GW
    # spends what was used and banks one more, capped at 5.
    ft = 1
    for e in history.get("current", []):
        if e["event"] >= nxt:
            break
        ft = min(max(ft - e["event_transfers"], 0) + 1, MAX_FT)

    teams = {
        t["id"]: {"short": t["short_name"], "strength": t["strength"]}
        for t in boot["teams"]
    }
    team_short = {tid: t["short"] for tid, t in teams.items()}

    players = [
        {
            "id": e["id"],
            "name": e["web_name"],
            "full": f'{e["first_name"]} {e["second_name"]}',
            "team": e["team"],
            "team_short": team_short.get(e["team"], ""),
            "type": e["element_type"],
            "price": e["now_cost"],  # tenths of £m
            "chance": e["chance_of_playing_next_round"],
        }
        for e in boot["elements"]
    ]

    fixture_rows = [
        {"gw": f["event"], "h": f["team_h"], "a": f["team_a"]}
        for f in fixtures
        if f["event"] in horizon
    ]

    return {
        "entry_name": entry["name"],
        "manager": f'{entry["player_first_name"]} {entry["player_last_name"]}',
        "squad": [p["element"] for p in picks["picks"]],
        "bank": entry["last_deadline_bank"],  # tenths of £m
        "ft": ft,
        "next_gw": nxt,
        "horizon": horizon,
        "players": players,
        "teams": teams,
        "fixtures": fixture_rows,
    }