import { describe, test, expect } from "bun:test";
import { geminiEndpoint, translateTextGemini } from "../src/gemini.ts";

// The key here is a fake test value only — the real key is entered by
// the user in the Settings form and never appears in code or tests.
const FAKE_KEY = "test-key-123";

function capturingFetch(body: unknown, ok = true, status = 200) {
  const seen: { url: string; init: Record<string, unknown> } = { url: "", init: {} };
  const fn = (async (url: string, init: Record<string, unknown>) => {
    seen.url = url;
    seen.init = init;
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
  return { fn, seen };
}

describe("geminiEndpoint", () => {
  test("builds the generateContent URL for the model", () => {
    expect(geminiEndpoint("gemini-2.5-flash")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
  });
});

describe("translateTextGemini", () => {
  test("returns the trimmed translation, joining parts", async () => {
    const { fn } = capturingFetch({
      candidates: [{ content: { parts: [{ text: "  Hello " }, { text: "world  " }] } }],
    });
    const out = await translateTextGemini("src", "Tibetan", {
      apiKey: FAKE_KEY,
      model: "gemini-2.5-flash",
      fetchFn: fn,
    });
    expect(out).toBe("Hello world");
  });

  test("sends the key in the header and the prompt at temperature 0.2", async () => {
    const { fn, seen } = capturingFetch({
      candidates: [{ content: { parts: [{ text: "hi" }] } }],
    });
    await translateTextGemini("my text", "Sanskrit", {
      apiKey: FAKE_KEY,
      model: "gemini-2.5-flash",
      fetchFn: fn,
    });
    expect(seen.url).toContain("generativelanguage.googleapis.com");
    expect(seen.url).toContain("gemini-2.5-flash");
    const headers = seen.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(FAKE_KEY);
    const body = JSON.parse(String(seen.init.body));
    expect(body.contents[0].parts[0].text).toContain("my text");
    expect(body.contents[0].parts[0].text).toContain("Sanskrit");
    expect(body.generationConfig.temperature).toBe(0.2);
  });

  test("unreachable Gemini is a clear error, not a crash", async () => {
    const failing = (async () => {
      throw new Error("conn refused");
    }) as unknown as typeof fetch;
    await expect(
      translateTextGemini("src", "Tibetan", { apiKey: FAKE_KEY, model: "m", fetchFn: failing }),
    ).rejects.toThrow("unreachable");
  });

  test("non-200 surfaces the status", async () => {
    const { fn } = capturingFetch({ error: { message: "API key not valid" } }, false, 400);
    await expect(
      translateTextGemini("src", "Tibetan", { apiKey: "bad", model: "m", fetchFn: fn }),
    ).rejects.toThrow("400");
  });

  test("empty candidates is an error", async () => {
    const { fn } = capturingFetch({ candidates: [] });
    await expect(
      translateTextGemini("src", "Tibetan", { apiKey: FAKE_KEY, model: "m", fetchFn: fn }),
    ).rejects.toThrow("empty");
  });

  test("missing candidates field is an error", async () => {
    const { fn } = capturingFetch({});
    await expect(
      translateTextGemini("src", "Tibetan", { apiKey: FAKE_KEY, model: "m", fetchFn: fn }),
    ).rejects.toThrow("empty");
  });
});
