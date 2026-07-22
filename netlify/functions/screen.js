// Serverless proxy: holds your Google Gemini key server-side and returns a content advisory.
// FREE tier: get a key at https://aistudio.google.com/apikey  (no credit card, cannot rack up charges).
// Set GEMINI_API_KEY in Netlify > Site configuration > Environment variables.
// Optional: GEMINI_MODEL (defaults to gemini-2.5-flash).

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    year: { type: "STRING" },
    identified: { type: "BOOLEAN" },
    verdict: { type: "STRING", enum: ["safe", "caution", "preview"] },
    verdict_reason: { type: "STRING" },
    age_note: { type: "STRING" },
    categories: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          key: { type: "STRING" },
          level: { type: "INTEGER" },
          note: { type: "STRING" },
          moments: { type: "ARRAY", items: { type: "STRING" } }
        },
        required: ["key", "level", "note", "moments"]
      }
    }
  },
  required: ["title", "year", "identified", "verdict", "verdict_reason", "age_note", "categories"]
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed." });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(500, { error: "Server is missing GEMINI_API_KEY. Add it in Netlify environment variables and redeploy." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (_) { return json(400, { error: "Bad request body." }); }

  const title = (body.title || "").trim();
  const year  = (body.year  || "").trim();
  const age   = (body.age   || "a toddler around 2 years old").trim();
  if (!title) return json(400, { error: "No title provided." });

  const system = "You are a cautious parent-advisory assistant that screens films and shows for young children. Err on the side of flagging: a young child is easily frightened by things adults ignore (loud sudden sounds, scary faces, a character dying or getting lost, tense music).";

  const user =
`Screen the ${year ? year + " " : ""}title "${title}" for ${age}. Base it on what you know about the title's content from parent guides and reviews.
Return the "categories" array with exactly these seven keys, in this order: scary, peril, death, themes, sexual, language, substances.
Meaning: scary = scary & startling (jump scares, loud sounds, scary faces, villains); peril = peril & violence; death = death & separation; themes = sad / intense themes; sexual = sexual content; language = language; substances = substances.
Rules: level is 0 (none) to 4 (intense). verdict "safe" if broadly fine for the age, "caution" if a few moments warrant a parent nearby, "preview" if a parent should preview key scenes or skip. verdict_reason max 18 words. age_note max 22 words, specific to the age. Each category note under 14 words. moments: up to 3 short scene descriptions; include an approximate timestamp ONLY if you are confident (e.g. "~34 min: ..."), otherwise describe the scene with no fake time; use [] if nothing notable. If you cannot identify the title, set identified=false and give your best generic guess.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          temperature: 0.4,
          maxOutputTokens: 1500
        }
      })
    });

    if (!r.ok) {
      const t = await r.text();
      return json(502, { error: "AI service returned " + r.status + ". " + shorten(t) });
    }

    const data = await r.json();

    if (data.promptFeedback && data.promptFeedback.blockReason) {
      return json(502, { error: "The request was blocked by a content filter. Try a different title." });
    }
    const cand = (data.candidates || [])[0];
    if (!cand) return json(502, { error: "No response from the AI service. Try again." });
    if (cand.finishReason === "SAFETY") {
      return json(502, { error: "The response was blocked by a content filter for this title." });
    }

    const text = ((cand.content && cand.content.parts) || []).map(p => p.text || "").join("");
    const parsed = extractJSON(text);
    if (!parsed) return json(502, { error: "Got a response but could not read it. Try again." });
    return json(200, parsed);
  } catch (e) {
    return json(502, { error: "Request failed: " + (e.message || "unknown error") });
  }
};

function json(statusCode, obj) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
}
function shorten(s) {
  try { const j = JSON.parse(s); return (j.error && j.error.message) || String(s).slice(0, 180); }
  catch (_) { return String(s).slice(0, 180); }
}
function extractJSON(text) {
  if (!text) return null;
  let t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(t); } catch (_) {}
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s === -1 || e === -1 || e < s) return null;
  let slice = t.slice(s, e + 1);
  try { return JSON.parse(slice); } catch (_) {}
  try { return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1")); } catch (_) {}
  return null;
}
