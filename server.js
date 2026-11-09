// TikTok Recipe Extractor — local prototype server (no dependencies).
// Run: node --env-file=.env server.js   then open http://localhost:3000

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-4.5";

// Step 1: get the video's caption from the public TikTok video page (no login needed).
// The page embeds its data as JSON in a <script> tag. This is unofficial and may break if TikTok changes it.
async function getTikTokCaption(videoUrl) {
  const res = await fetch(videoUrl, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" } });
  if (!res.ok) throw new Error("TikTok could not find that video (status " + res.status + ").");
  const html = await res.text();
  try {
    const json = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)[1];
    const item = JSON.parse(json).__DEFAULT_SCOPE__["webapp.video-detail"].itemInfo.itemStruct;
    return { caption: item.desc || "", author: item.author?.uniqueId || "" };
  } catch {
    throw new Error("Couldn't read the caption from TikTok. Paste the recipe text instead.");
  }
}

// Step 2: ask the AI model to turn the caption (and any pasted text) into a structured recipe.
async function extractRecipe(sourceText) {
  const prompt = `You extract recipes from TikTok video captions and transcripts.
Return ONLY a JSON object with this shape:
{"title": string, "ingredients": [{"item": string, "quantity": string}], "steps": [string], "notes": string}

Rules:
- Only use information in the source text. Do not invent ingredients or steps.
- If quantities are not given, use "" for quantity.
- If the source has no real recipe, return empty lists and explain in "notes".

Source text:
"""${sourceText}"""`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("OpenRouter error: " + (data.error?.message || res.status));

  // Models sometimes wrap JSON in ```json fences; strip them before parsing.
  const text = data.choices[0].message.content.replace(/```(json)?/g, "").trim();
  return { recipe: JSON.parse(text), usage: data.usage };
}

async function handleExtract(body) {
  const { url, text } = JSON.parse(body || "{}");
  if (!API_KEY || API_KEY.includes("replace-with-your-key")) {
    throw new Error("Missing OPENROUTER_API_KEY. Add your key to .env and restart the server.");
  }
  if (!url && !text) throw new Error("Paste a TikTok link or the recipe text.");

  let caption = "", author = "";
  if (url) {
    if (!/^https:\/\/(www\.|vm\.|m\.)?tiktok\.com\//.test(url)) throw new Error("That doesn't look like a TikTok link.");
    ({ caption, author } = await getTikTokCaption(url));
  }

  const sourceText = [caption, text].filter(Boolean).join("\n\n");
  const { recipe, usage } = await extractRecipe(sourceText);
  return { caption, author, recipe, usage };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(__dirname, "public", "index.html")).pipe(res);
  }
  if (req.method === "POST" && req.url === "/api/extract") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const result = await handleExtract(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error(err.message);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => console.log(`Recipe Extractor running at http://localhost:${PORT} (model: ${MODEL})`));
