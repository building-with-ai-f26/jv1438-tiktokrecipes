// Fridge to Feast — local prototype server (no dependencies).
// Run: node --env-file=.env server.js   then open http://localhost:3000

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-haiku-5.5";

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
  try {
    return await askModelOnce(content);
  } catch (err) {
    // Only retry a bad answer; a missing key or an OpenRouter error (like no credits) won't fix itself.
    if (!err.message.startsWith("The AI didn't return")) throw err;
    console.error("Retrying after: " + err.message);
    return await askModelOnce(content);
  }
}

async function askModelOnce(content) {
  if (!API_KEY || API_KEY.includes("replace-with-your-key")) {
    throw new Error("Missing OPENROUTER_API_KEY. Add your key to .env and restart the server.");
  }
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content }] }),
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

// Short text version of the kitchen for prompts, e.g. "- 2 lbs chicken thighs (use soon)".
function describeKitchen(kitchen) {
  if (!kitchen.length) return "(nothing listed)";
  return kitchen.map((k) => `- ${k.qty ? k.qty + " " : ""}${k.name}${k.useSoon ? " (use soon)" : ""}`).join("\n");
}

// "What can I make?": recipe ideas built mostly from what the user already has.
async function handleSuggest(body) {
  const { kitchen = [], staples = [], craving = "" } = JSON.parse(body || "{}");
  if (!kitchen.length && !craving) throw new Error("Add a few things to My Kitchen first, or name a dish you're craving.");

  const prompt = `You are a meal prep coach who suggests genuinely delicious recipes. Suggest 3 recipes.
Return ONLY a JSON object with this shape:
{"recipes": [{"title": string, "servings": number, "ingredients": [{"item": string, "quantity": string}], "steps": [string], "uses_up": [string], "to_buy": [string]}]}

Rules:
- Taste comes first. Pick well-loved, flavorful dishes people actually crave (good seasoning, aromatics, a sauce or acid, contrasting textures). Never force unrelated kitchen items together just to use them up.
- Build each recipe around 1-3 kitchen items that fit it naturally, especially ones marked "(use soon)". Buying other ingredients is fine and expected (up to about 6) when it makes the dish better.
- Pick dishes that are good for meal prep: they keep 3-4 days in the fridge and reheat well.
- Make the 3 recipes different from each other (cuisine, protein or style).
- Assume salt, pepper, cooking oil and water are available, plus the pantry staples listed below. Use them freely.
- Give every ingredient a specific quantity.
- "uses_up" lists kitchen items marked "(use soon)" that the recipe uses.
- "to_buy" lists every ingredient the recipe needs that is NOT in the kitchen or pantry staples.
- Steps are short and clear, 4-8 steps, with times and temperatures.
${craving ? `- The user is craving: "${craving}". All 3 recipes should match that request.` : ""}

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
- Section names must be from: Produce, Meat & Seafood, Dairy & Eggs, Bakery, Pantry, Spices & Sauces, Frozen, Other. Leave out empty sections.

Meal prep plan:
${planText}

Kitchen:
${describeKitchen(kitchen)}

Pantry staples (always stocked, never put these on the list):
${staples.join(", ") || "(none listed)"}`;

  const { json, usage } = await askModel(prompt);
  return { sections: json.sections || [], usage };
}

// POST routes: each takes the raw request body and returns an object to send back as JSON.
const routes = { "/api/extract": handleExtract, "/api/suggest": handleSuggest, "/api/grocery": handleGrocery };

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(__dirname, "public", "index.html")).pipe(res);
  }
  if (req.method === "POST" && routes[req.url]) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
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

server.listen(PORT, () => console.log(`Fridge to Feast running at http://localhost:${PORT} (model: ${MODEL})`));
