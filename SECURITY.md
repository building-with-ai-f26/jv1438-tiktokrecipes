# SECURITY.md — Fridge to Feast

**Live site:** https://fridge-to-feast-oguz.onrender.com
**Lane:** Beginner
**Audit date:** November 21, 2026

## What kind of app this is
**AI app, no database.** The server (`server.js`, plain Node with no npm packages) has three AI routes: `/api/suggest`, `/api/extract` and `/api/grocery`. They call OpenRouter with a key that lives only on the server. Each visitor's kitchen, plan and grocery list are saved in **their own browser's localStorage**. The server stores nothing, so there is no database, no sign-in and no file storage.

Hosting is a Render free Web Service in Virginia (US East), connected as a public Git repository. Deploys are manual (**Manual Deploy → Deploy latest commit**). Requests reach the app through Cloudflare.

## What we checked and what we found

### 1. Access control test (AI app, no database)
| Check | Result |
|---|---|
| Searched the live page's code for `sk-or-`, `sk-ant-`, `sk-proj-`, `sk_live_`, `sb_secret_`, `service_role` | ✅ None found. The only key in the page is PostHog's `phc_…`, which is meant to be public. |
| Called `/api/suggest` 30 times in a row on the live site | ✅ Requests 1–20 → `400` (empty request, never reaches the AI). Requests 21–30 → **`429 Too many requests`** with a `Retry-After` header. |

The test requests were empty on purpose: the rate limit is checked first, so the test cost $0.

### 2. Secret keys stay on the server
- Searched **every commit on every branch** (`git log --all -p`) for the patterns above. The only matches are the placeholder `sk-or-v1-replace-with-your-key` in `.env.example` and the search command written in `AGENTS.md`. ✅ No real key was ever committed.
- `.env` is listed in `.gitignore` (`git check-ignore .env` confirms it).
- On Render, the key is set in the **Environment** tab. The start command is `node server.js` with no `.env` file on the server.
- **Nothing to rotate.**

### 3. File storage
Not applicable. Screenshots for recipe import are shrunk in the browser (max 1600 px JPEG), sent to the model once, and never saved.

### 4. Protecting production from the coding agent
- `AGENTS.md` has an **Ask me first** list: deleting data, `git reset --hard` / force-push, keys and `.env`, Render/GitHub/OpenRouter/PostHog settings, anything that costs money, and merging to `main` (which deploys).
- The agent works on branches and opens pull requests. A human merges them and clicks deploy on Render.
- **Database backup:** not applicable, since there is no database. User data lives in each visitor's browser.

### 5. Spending caps and rate limits
- **OpenRouter key "Tiktok Recipes": hard credit limit of $1, resetting monthly.** Auto top-up is off and no payment method is saved. The app currently uses `openrouter/free` ($0 per request).
- **Per-visitor rate limit on every AI route:** 20 requests per minute per visitor IP, counted before any work happens. The limit was chosen so that a pod testing together on one shared classroom Wi-Fi IP isn't blocked (an earlier draft used 10).

### 6. Dependencies
No npm packages (there is no `package.json`), so `npm audit` has nothing to check. The server uses only Node's built-in `http`, `fs` and `path`. Render runs Node 24 (`NODE_VERSION=24`).

### 7. Agent security review: trying to break the app
The coding agent (Claude Code) reviewed the code and attacked the live site. Results:

| # | Attack | What happened | Status |
|---|---|---|---|
| 1 | Send 30 AI requests in a row | Blocked at request 21 with `429` | ✅ Working as designed |
| 2 | **Dodge the rate limit with a fake `X-Forwarded-For` IP on each request** | **All 30 got through, with no limit.** The server trusted the first IP in that header, and visitors control it. | ✅ **Fixed** (commit `8e6ce45`): the server now uses `cf-connecting-ip`, which Cloudflare sets. Render logs confirm this source is used. Retest: blocked at request 20. |
| 3 | Fake `CF-Connecting-IP` / `True-Client-IP` headers | Cloudflare rejected every request with `403` before it reached the app | ✅ Not possible |
| 4 | **Send one huge request (191 MB) to an AI route** (tested on a local copy, not the live site) | **Server memory jumped to about 1,210 MB.** Render's free plan has 512 MB, so one or two of these could crash the live site for everyone. The rate limit doesn't help, because it counts requests, not size. | ✅ **Fixed:** request bodies over 3 MB get `413` and the connection is closed. Local retest: 191 MB with its size declared → `413` immediately; 191 MB sent in chunks with no size declared → `413` once 3 MB arrives. Memory after both: **61 MB**. A normal 2 MB screenshot-sized request still goes through. |
| 5 | Inject HTML or script through AI output or TikTok captions | The page builds everything with `textContent` and never puts this text into the page as HTML, so injected text shows as text | ✅ Not possible |

Other things reviewed:
- **Diet field and prompt injection:** the new Diet setting sends `vegetarian` or `vegan`, and the server only maps those exact values to fixed rules. Anything else is ignored, so the field can't carry someone's own instructions into the prompt.
- **TikTok link:** must match `https://(www.|vm.|m.)tiktok.com/`, so the server can't be pointed at other sites.
- **Screenshot upload:** must be a `data:image/(png|jpeg|webp|gif);base64,` value.

## What we fixed
1. Added a per-visitor rate limit (20/min) with `429` responses.
2. Fixed the rate-limit bypass via fake `X-Forwarded-For` (attack #2).
3. Request size cap of 3 MB, so oversized requests get `413` (attack #4).

## Remaining issues and known limits
- **Rate-limit counts are in memory.** They reset when Render restarts the server, and they wouldn't be shared if the app ever ran on more than one server.
- **Shared IPs share a limit.** Everyone on one network (a classroom, an office) shares 20 requests per minute.
- **Typing a recipe or craving in the box is still free text sent to the AI.** Someone could try to make the AI say odd things, but it can only answer that one visitor, has no tools, and can't reach other users' data. Worst case is a strange recipe card for the person who typed it.
- **The OpenRouter key expires Feb 7, 2027.** After that, AI features stop until a new key is created and pasted into Render's Environment tab.
- **No automatic deploys.** Render isn't connected to the class GitHub organization (that needs owner approval), so deploys are manual.
- **PostHog session replay** records page use on the live site. Visitors can type their kitchen items, which are not sensitive, but there's no sign-in, so there's no personal account data to leak.
- **Free model.** `openrouter/free` is slow (about 110–130 s per suggestion on the live site) and its quality varies.
