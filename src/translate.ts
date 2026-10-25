// Ollama translation. The desk never downloads a model: it calls the
// user's own Ollama server and the model they picked in Settings (from
// their installed list via /api/tags). Translation is deliberately
// low-temperature and source-faithful, and the result stays editable —
// Tibetan/Sanskrit machine translation varies by model, so the desk
// always keeps source and translation side by side.

export function buildPrompt(text: string, langLabel: string): string {
  return (
    `Translate the following ${langLabel} text into English. ` +
    `Output only the English translation, with no introduction, ` +
    `explanation, or commentary.\n\n${text}`
  );
}

export interface TranslateOpts {
  url: string;
  model: string;
  fetchFn?: typeof fetch;
}

export async function translateText(
  text: string,
  langLabel: string,
  opts: TranslateOpts,
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.url.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetchFn(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        prompt: buildPrompt(text, langLabel),
        stream: false,
        options: { temperature: 0.2 },
      }),
    });
  } catch {
    throw new Error(`Ollama is unreachable at ${opts.url} — is it running?`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Ollama returned ${res.status}${body ? ": " + body.slice(0, 200) : ""} — check the model name in Settings.`,
    );
  }
  const data = (await res.json()) as { response?: string };
  const out = (data.response ?? "").trim();
  if (!out) throw new Error("Ollama returned an empty translation.");
  return out;
}

export async function listModels(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  const base = url.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetchFn(`${base}/api/tags`);
  } catch {
    throw new Error(`Ollama is unreachable at ${url} — is it running?`);
  }
  if (!res.ok) throw new Error(`Ollama returned ${res.status} for /api/tags.`);
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name);
}
