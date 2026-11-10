// Gemini translation via Google's Generative Language API.
// The API key lives in the desk's settings (entered in the Settings
// form, stored in the local SQLite database, never returned by any
// GET endpoint) and is sent only to Google, in the x-goog-api-key
// header. Same prompt contract as the Ollama path: low temperature,
// source-faithful, output only the translation.

import { buildPrompt } from "./translate.ts";

export function geminiEndpoint(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
}

export interface GeminiOpts {
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
}

export async function translateTextGemini(
  text: string,
  langLabel: string,
  opts: GeminiOpts,
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(geminiEndpoint(opts.model), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": opts.apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(text, langLabel) }] }],
        generationConfig: { temperature: 0.2 },
      }),
    });
  } catch {
    throw new Error("Gemini is unreachable — check your network.");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Gemini returned ${res.status}${body ? ": " + body.slice(0, 200) : ""} — check the API key and model name in Settings.`,
    );
  }
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const out = (data.candidates ?? [])
    .flatMap((c) => c.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!out) throw new Error("Gemini returned an empty translation.");
  return out;
}
