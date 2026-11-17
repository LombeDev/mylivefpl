import os

import httpx
from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware

import fpl

app = FastAPI(title="Kopala FPL")

# Set SECRET_KEY in Render's Environment tab. The fallback is for local use only.
app.add_middleware(
    SessionMiddleware,
    secret_key=os.environ.get("SECRET_KEY", "dev-only-change-me"),
    same_site="lax",
    max_age=60 * 60 * 24 * 30,  # stay signed in for 30 days
)

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


@app.exception_handler(httpx.HTTPError)
async def upstream_error(request: Request, exc: httpx.HTTPError):
    if isinstance(exc, httpx.HTTPStatusError):
        msg = f"FPL API returned {exc.response.status_code}. The data may not be available yet."
    else:
        msg = str(exc) or "Could not reach the FPL API. Try again shortly."
    return JSONResponse({"error": msg}, status_code=502)


def current_team(request: Request) -> int | None:
    value = request.session.get("team_id")
    return int(value) if value else None


def render(request: Request, template: str, active: str, **extra):
    return templates.TemplateResponse(request, template, {"active": active, **extra})


# ---------- auth ----------

@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    if current_team(request):
        return RedirectResponse("/rank", status_code=303)
    return render(request, "login.html", "login", error=None)


@app.post("/login", response_class=HTMLResponse)
async def login(request: Request, team_id: str = Form(...)):
    team_id = team_id.strip()
    if not team_id.isdigit():
        return render(request, "login.html", "login", error="Enter a numeric FPL Team ID.")

    try:
        entry = await fpl.get(f"entry/{team_id}/", ttl=300)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            msg = "No FPL team found with that ID. Check the number and try again."
        else:
            msg = f"FPL API returned {exc.response.status_code}. Try again shortly."
        return render(request, "login.html", "login", error=msg)
    except httpx.HTTPError:
        msg = "Could not reach the FPL API. Try again shortly."
        return render(request, "login.html", "login", error=msg)

    request.session["team_id"] = int(team_id)
    request.session["team_name"] = entry["name"]
    return RedirectResponse("/rank", status_code=303)


@app.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/", status_code=303)


# ---------- pages ----------

@app.get("/")
async def home():
    return RedirectResponse("/rank", status_code=303)


@app.get("/rank", response_class=HTMLResponse)
async def rank_page(request: Request):
    if not current_team(request):
        return RedirectResponse("/login", status_code=303)
    return render(request, "rank.html", "rank")


@app.get("/planner", response_class=HTMLResponse)
async def planner_page(request: Request):
    if not current_team(request):
        return RedirectResponse("/login", status_code=303)
    return render(request, "planner.html", "planner")


@app.get("/price-changes", response_class=HTMLResponse)
async def prices_page(request: Request):
    # Price data is public, so this page doesn't need sign-in.
    return render(request, "prices.html", "prices")


# ---------- API ----------

@app.get("/api/me")
async def api_me(request: Request):
    team = current_team(request)
    if not team:
        return JSONResponse({"error": "Not signed in"}, status_code=401)
    return {"team_id": team, "team_name": request.session.get("team_name")}


@app.get("/api/rank")
async def api_rank(request: Request):
    team = current_team(request)
    if not team:
        return JSONResponse({"error": "Not signed in"}, status_code=401)
    return await fpl.live_team(team)


@app.get("/api/rank-estimate")
async def api_rank_estimate(request: Request):
    team = current_team(request)
    if not team:
        return JSONResponse({"error": "Not signed in"}, status_code=401)
    return await fpl.estimate_rank(team)


@app.get("/api/planner")
async def api_planner(request: Request):
    team = current_team(request)
    if not team:
        return JSONResponse({"error": "Not signed in"}, status_code=401)
    return await fpl.planner_data(team)


@app.get("/api/prices")
async def api_prices():
    return await fpl.price_changes()





@app.get("/api/planner")
async def api_planner(request: Request):
    team = current_team(request)
    if not team:
        return JSONResponse({"error": "Not signed in"}, status_code=401)
    return await fpl.planner_data(team)