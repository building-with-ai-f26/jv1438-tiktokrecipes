# AGENTS.md — Coding Agent Operating Manual

> Give this file to your coding agent and check that it is using these instructions. Keep the stack, commands, and ground rules current.

## 1. Project Overview
- **What this repo builds:** Fridge to Feast, a meal prep planner for working professionals who want to eat home-cooked food without planning every meal: a saved kitchen inventory, a weekly meal prep plan (recipe ideas from what you have, or a TikTok recipe import), a grocery list with specific amounts, and one-tap kitchen updates after shopping or cooking. Fridge photo scanning is planned for a later build.
- **Primary user & core workflow:** [See the living PRD in `docs/index.html`]
- **Tech stack:** Node.js (no npm packages) / plain HTML+JS in `public/index.html` / OpenRouter API. `server.js` has three JSON endpoints (`/api/suggest`, `/api/extract` for TikTok captions, `/api/grocery`) that share one `askModel` helper. User data (kitchen, plan, grocery list) lives in the browser's localStorage; there is no database. Each visitor gets 20 AI requests per minute (rate limit in `server.js`).

## 2. Commands
- **Install dependencies:** none (needs Node 20.6+ for `--env-file`). Copy `.env.example` to `.env` and add your OpenRouter key.
- **Run locally:** `node --env-file=.env server.js`, then open http://localhost:3000
- **Deploy:** see section 4, Shipping (Render, start command `node server.js`)
- **Run deterministic tests:** none yet (Build 4)
- **Run model evals:** none yet (Build 4)

## 3. Non-Negotiable Engineering Rules
1. **Plan before coding:** Before touching multiple files, propose a brief plan and wait for approval.
2. **Small batches:** Make small, focused changes that can be reviewed and explained by a human in a single Pull Request.
3. **Explainability:** Avoid unnecessary abstractions or dependencies. Help the human builder understand the main components, what changed, why it matters, what could break, and how it was checked.
4. **Verify changes:** Run relevant checks. For a reproducible logic bug, use a failing test to demonstrate the fix when practical. Record manual checks and known limitations; follow the selected Build 4 evaluation track.
5. **Zero secrets in code:** Never hardcode API keys, tokens, or credentials. Always read from environment variables (`.env`) and update `.env.example` when new variables are needed.
6. **Stop when looping:** If a fix fails twice in a row, stop, summarize what failed, and ask the human before trying a third approach.
7. **Think about real use before picking limits:** Before choosing a number like a rate limit, timeout or size cap, think through how people will actually use the app (for example, a whole class on one shared Wi-Fi IP address). *Added after a real mistake:* the agent first set the rate limit to 10 requests per minute per IP, which could have blocked a pod testing together in class. It was raised to 20 before committing.

## 4. Shipping
The app runs on **Render** (free Web Service) from the `main` branch. Every push to `main` redeploys it automatically.

**One-time setup (done by the human in the Render dashboard):**
1. render.com → **New → Web Service** → connect the GitHub repo `building-with-ai-f26/jv1438-tiktokrecipes`, branch `main`.
2. Settings: **Runtime** Node · **Build command** `node --version` (there is nothing to install) · **Start command** `node server.js` · **Instance type** Free.
   Do *not* use `--env-file=.env` on Render: there is no `.env` file there, and Node stops if the file is missing.
3. **Environment** tab: add `OPENROUTER_API_KEY` (the real key), `OPENROUTER_MODEL`, `OPENROUTER_VISION_MODEL`, and `NODE_VERSION` = `24`. Render sets `PORT` itself.
4. Deploy, then copy the `https://….onrender.com` URL into the PRD and README.

**Every change after that (the agent follows these steps):**
1. Work on a new branch, never directly on `main`.
2. Run the app locally (`node --env-file=.env server.js`) and check the changed feature works.
3. Search the changes for secrets before committing: `git diff | grep -E "sk-or-|sk-ant-|sk-proj-|sk_live_|sb_secret_|service_role"` should print nothing.
4. Commit, push the branch and open a pull request. **Ask the human before merging.**
5. After the human merges, wait for Render to finish deploying, then check the live site: the page loads, one AI feature works on a phone, and the PostHog snippet still loads.
6. If the live site is broken: in Render, open **Events** and use **Rollback** on the last good deploy, then fix on a branch.

Note: free Render services fall asleep after about 15 minutes with no visitors, so the first visit can take up to a minute to load.

## 5. Ask me first
The agent must stop and get the human's OK before any of these:
- **Deleting or changing data:** deleting files or branches, `git reset --hard`, `git push --force`, clearing anyone's saved data, or adding or changing a database.
- **Keys, secrets and permissions:** creating, reading out, changing or rotating API keys; editing `.env`; changing Render, GitHub, OpenRouter or PostHog settings or access.
- **Anything that costs money:** switching to a paid model, adding OpenRouter credit, upgrading a Render plan, or adding a paid service.
- **Going live:** merging to `main` (which deploys to the live site) or changing the deploy settings.
