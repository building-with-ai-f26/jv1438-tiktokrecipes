// Fridge to Feast — local prototype server (no dependencies).
// Run: node --env-file=.env server.js   then open http://localhost:3000

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "deepseek/deepseek-v4-flash";
// Screenshots need a model that can read images; the free router picks one at $0.
const VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || "openrouter/free";

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

// Send one prompt to the model and parse the JSON it returns. Shared by every AI feature.
// `content` is either a string, or a list of text/image parts when a screenshot is attached.
// Free models sometimes send back an empty or broken answer, so try one more time before giving up.
async function askModel(content) {
  // A list of parts means a screenshot is attached, so use the image-capable model.
  const model = Array.isArray(content) ? VISION_MODEL : MODEL;
  try {
    return await askModelOnce(content, model);
  } catch (err) {
    // Only retry a bad answer; a missing key or an OpenRouter error (like no credits) won't fix itself.
    if (!err.message.startsWith("The AI didn't return")) throw err;
    console.error("Retrying after: " + err.message);
    return await askModelOnce(content, model);
  }
}

async function askModelOnce(content, model) {
  if (!API_KEY || API_KEY.includes("replace-with-your-key")) {
    throw new Error("Missing OPENROUTER_API_KEY. Add your key to .env and restart the server.");
  }
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("OpenRouter error: " + (data.error?.message || res.status));

  // Models sometimes wrap JSON in ```json fences or add a sentence around it; keep just the {...} part.
  const text = data.choices?.[0]?.message?.content || "";
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  try {
    if (start === -1 || end === -1) throw new Error("no JSON object found");
    return { json: JSON.parse(text.slice(start, end + 1)), usage: data.usage };
  } catch (err) {
    // Log what came back so a bad answer can be debugged from the terminal.
    console.error(`Unusable reply from ${data.model} (${err.message}): ${text.slice(0, 200) || "(empty)"}`);
    throw new Error("The AI didn't return a usable answer. Try again.");
  }
}

// Step 2: ask the AI model to turn the caption, pasted text and/or screenshot into a structured recipe.
async function extractRecipe(sourceText, image) {
  const prompt = `You extract recipes from TikTok captions, recipe websites, screenshots, and recipes people type in.
Return ONLY a JSON object with this shape:
{"title": string, "ingredients": [{"item": string, "quantity": string}], "steps": [string], "notes": string}

Rules:
- Only use information in the source text${image ? " and the attached image" : ""}. Do not invent ingredients or steps.
- If quantities are not given, use "" for quantity.
- If the source has no real recipe, return empty lists and explain in "notes".

Source text:
"""${sourceText || "(none, the recipe is in the image)"}"""`;

  const content = image ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: image } }] : prompt;
  const { json, usage } = await askModel(content);
  return { recipe: json, usage };
}

async function handleExtract(body) {
  const { url, text, image } = JSON.parse(body || "{}");
  if (!url && !text && !image) throw new Error("Paste a TikTok link, type a recipe, or add a screenshot.");
  if (image && !/^data:image\/(png|jpeg|webp|gif);base64,/.test(image)) throw new Error("That screenshot isn't an image file we can read.");

  let caption = "", author = "";
  if (url) {
    if (!/^https:\/\/(www\.|vm\.|m\.)?tiktok\.com\//.test(url)) throw new Error("That doesn't look like a TikTok link.");
    ({ caption, author } = await getTikTokCaption(url));
  }

  const sourceText = [caption, text].filter(Boolean).join("\n\n");
  const { recipe, usage } = await extractRecipe(sourceText, image);
  return { caption, author, recipe, usage };
}

// Short text version of the kitchen for prompts, e.g. "- 1 block firm tofu (use soon)".
function describeKitchen(kitchen) {
  if (!kitchen.length) return "(nothing listed)";
  return kitchen.map((k) => `- ${k.qty ? k.qty + " " : ""}${k.name}${k.useSoon ? " (use soon)" : ""}`).join("\n");
}

// "What can I make?": recipe ideas built mostly from what the user already has.
async function handleSuggest(body) {
  const { kitchen = [], staples = [], craving = "", diet = "", glutenFree = false } = JSON.parse(body || "{}");
  // Only these exact values reach the prompt, so a visitor can't slip their own text in through "diet".
  const DIET_RULES = {
    vegetarian: "Every recipe must be vegetarian: no meat, poultry, fish or seafood, and no ingredients made from them (like chicken stock, fish sauce or gelatin). Eggs and dairy are fine.",
    vegan: "Every recipe must be vegan: no meat, poultry, fish, seafood, eggs, dairy, honey or anything made from them (like chicken stock, fish sauce, butter or gelatin).",
  };
  const GLUTEN_FREE_RULE = "Every recipe must be gluten-free: no wheat, barley, rye or regular oats, and nothing made from them (like regular pasta, bread, flour tortillas, couscous, seitan, regular soy sauce or beer). Use gluten-free swaps such as rice, potatoes, corn tortillas, tamari or certified gluten-free oats or pasta.";
  // Each rule is fixed text; only true/known values switch it on, so visitors can't add their own words.
  const dietRule = [DIET_RULES[diet], glutenFree === true ? GLUTEN_FREE_RULE : ""].filter(Boolean).join(" ");
  if (!kitchen.length && !craving) throw new Error("Add a few things to My Kitchen first, or name a dish you're craving.");

  const prompt = `You are a meal prep coach who suggests genuinely delicious recipes. Suggest 3 recipes.
Return ONLY a JSON object with this shape:
{"recipes": [{"title": string, "servings": number, "ingredients": [{"item": string, "quantity": string}], "steps": [string], "uses_up": [string], "to_buy": [string]}]}

Rules:
- Taste comes first. Pick well-loved, flavorful dishes people actually crave (good seasoning, aromatics, a sauce or acid, contrasting textures). Never force unrelated kitchen items together just to use them up.
- Build each recipe around 1-3 kitchen items that fit it naturally, especially ones marked "(use soon)". Buying other ingredients is fine and expected (up to about 6) when it makes the dish better.
- Pick dishes that are good for meal prep: they keep 3-4 days in the fridge and reheat well.
- Make the 3 recipes different from each other (cuisine, main ingredient or style).
- Assume salt, pepper, cooking oil and water are available, plus the pantry staples listed below. Use them freely.
- Give every ingredient a specific quantity.
- "uses_up" lists kitchen items marked "(use soon)" that the recipe uses.
- "to_buy" lists every ingredient the recipe needs that is NOT in the kitchen or pantry staples.
- Steps are short and clear, 4-8 steps, with times and temperatures.
${dietRule ? `- ${dietRule} This rule comes before everything else, including the kitchen and the craving. If the kitchen lists an item that breaks it, leave that item out.\n` : ""}${craving ? `- The user is craving: "${craving}". All 3 recipes should match that request.` : ""}

Kitchen:
${describeKitchen(kitchen)}

Pantry staples (always stocked):
${staples.join(", ") || "(none listed)"}`;

  const { json, usage } = await askModel(prompt);
  return { recipes: json.recipes || [], usage };
}

// Grocery list: what the planned recipes need, scaled to portions, minus what's already in the kitchen.
async function handleGrocery(body) {
  const { recipes = [], kitchen = [], staples = [] } = JSON.parse(body || "{}");
  if (!recipes.length) throw new Error("Add at least one recipe to your plan first.");

  const planText = recipes.map((r) =>
    `## ${r.title} (recipe serves ${r.servings || "unknown, estimate it"}; make ${r.portions} portions)\n` +
    r.ingredients.map((i) => `- ${i.quantity ? i.quantity + " " : ""}${i.item}`).join("\n")
  ).join("\n\n");

  const prompt = `You make grocery lists for meal prep.
Return ONLY a JSON object with this shape:
{"sections": [{"name": string, "items": [{"item": string, "quantity": string, "for": [string]}]}]}

Rules:
- Scale each recipe's ingredients to the number of portions asked for.
- Combine the same ingredient across recipes into one line.
- Subtract what is already in the kitchen. Leave an item out if the kitchen has enough; if it has some, list only what's missing.
- Skip salt, pepper, cooking oil, water, and anything in the pantry staples list.
- Give specific quantities in the units people buy at a store (e.g. "1.5 lbs", "1 bunch", "2 cans (15 oz)", "1 dozen").
  Never list less than one store unit: a recipe needing 1 tsp cumin means "1 jar" on the list.
- "quantity" is only the amount, never the item name: {"item": "limes", "quantity": "2"}, not {"item": "limes", "quantity": "2 limes"}.
- "for" lists the recipe titles that need the item.
- Section names must be from: Produce, Protein, Dairy & Eggs, Bakery, Pantry, Spices & Sauces, Frozen, Other. Leave out empty sections.

Meal prep plan:
${planText}

Kitchen:
${describeKitchen(kitchen)}

Pantry staples (always stocked, never put these on the list):
${staples.join(", ") || "(none listed)"}`;

  const { json, usage } = await askModel(prompt);
  return { sections: json.sections || [], usage };
}

// Rate limit: each visitor (by IP address) gets RATE_LIMIT AI requests per minute, so nobody can run up
// the OpenRouter bill. It's counted before any work happens, so blocked requests cost nothing.
// Counts live in memory and reset when the server restarts, which is fine for one small server.
const RATE_LIMIT = 20; // roomy enough for a pod testing on one shared classroom Wi-Fi
const WINDOW_MS = 60 * 1000;
const visitors = new Map(); // ip -> { count, resetAt }

// On Render, requests come through Cloudflare, which sets cf-connecting-ip to the real visitor's IP.
// Don't trust x-forwarded-for: a visitor can put any IP in it and dodge the limit (found in the Build 3 audit).
// Locally there's no proxy, so use the connection's own address.
let loggedIpSource = false;
function visitorIp(req) {
  const ip = req.headers["cf-connecting-ip"];
  if (!loggedIpSource) { // one log line so the live logs show which source is used (never the IP itself)
    console.log("Rate limit counts visitors by: " + (ip ? "cf-connecting-ip" : "connection address"));
    loggedIpSource = true;
  }
  return ip || req.socket.remoteAddress;
}

// Returns how many seconds the visitor must wait, or 0 if the request is allowed.
function rateLimited(ip) {
  const now = Date.now();
  let v = visitors.get(ip);
  if (!v || now >= v.resetAt) {
    v = { count: 0, resetAt: now + WINDOW_MS };
    visitors.set(ip, v);
  }
  v.count++;
  return v.count > RATE_LIMIT ? Math.ceil((v.resetAt - now) / 1000) : 0;
}

// Forget visitors whose minute is over, so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, v] of visitors) if (now >= v.resetAt) visitors.delete(ip);
}, WINDOW_MS).unref();

const MAX_BODY_BYTES = 3 * 1024 * 1024; // 3 MB

// Send 413 and close the connection so the rest of the oversized upload isn't read.
function tooLarge(req, res) {
  res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
  res.end(JSON.stringify({ error: "That's too big to send. Try a smaller screenshot or less text." }));
  req.resume(); // throw away anything still arriving instead of keeping it in memory
}

// POST routes: each takes the raw request body and returns an object to send back as JSON.
const routes = { "/api/extract": handleExtract, "/api/suggest": handleSuggest, "/api/grocery": handleGrocery };

const server = http.createServer((req, res) => {
  // Sign-in settings for the page. Both values are public by design (the publishable key can only do
  // what Row Level Security allows); they live in .env / Render so they aren't written into the code.
  if (req.method === "GET" && req.url === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      supabaseUrl: process.env.SUPABASE_URL || null,
      supabaseKey: process.env.SUPABASE_PUBLISHABLE_KEY || null,
    }));
  }
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(__dirname, "public", "index.html")).pipe(res);
  }
  if (req.method === "POST" && routes[req.url]) {
    const wait = rateLimited(visitorIp(req));
    if (wait) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(wait) });
      return res.end(JSON.stringify({ error: `Too many requests. Please wait ${wait} seconds and try again.` }));
    }
    // Size cap: a huge request could use up the server's memory and crash it for everyone
    // (Build 3 audit: one 191 MB request used about 1.2 GB). Screenshots are shrunk in the browser to about 1-2 MB.
    if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) return tooLarge(req, res);
    let body = "", size = 0, stopped = false;
    req.on("data", (chunk) => {
      if (stopped) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { stopped = true; body = ""; return tooLarge(req, res); }
      body += chunk;
    });
    req.on("end", async () => {
      if (stopped) return;
      try {
        const result = await routes[req.url](body);
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

server.listen(PORT, () => console.log(`Fridge to Feast running at http://localhost:${PORT} (model: ${MODEL}, screenshots: ${VISION_MODEL})`));
