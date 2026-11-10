import { describe, test, expect } from "bun:test";
import { buildPrompt, translateText, listModels, translateWithProvider } from "../src/translate.ts";

describe("buildPrompt", () => {
  test("asks for English only, no commentary", () => {
    const p = buildPrompt("text", "Tibetan");
    expect(p).toContain("Tibetan");
    expect(p).toContain("into English");
    expect(p).toContain("Output only the English translation");
    expect(p).toContain("text");
  });
});

function stubFetch(body: unknown, ok = true, status = 200) {
  return (async () => ({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

describe("translateText", () => {
  test("returns the trimmed response", async () => {
    const out = await translateText("src", "Tibetan", {
      url: "http://localhost:11434",
      model: "m",
      fetchFn: stubFetch({ response: "  Hello world  " }),
    });
    expect(out).toBe("Hello world");
  });

  test("unreachable Ollama is a clear error, not a crash", async () => {
    const failing = (async () => {
      throw new Error("conn refused");
    }) as unknown as typeof fetch;
    await expect(
      translateText("src", "Tibetan", { url: "http://localhost:11434", model: "m", fetchFn: failing }),
    ).rejects.toThrow("unreachable");
  });

  test("non-200 surfaces the status", async () => {
    await expect(
      translateText("src", "Tibetan", {
        url: "http://localhost:11434",
        model: "nope",
        fetchFn: stubFetch({ error: "model not found" }, false, 404),
      }),
    ).rejects.toThrow("404");
  });

  test("empty response is an error", async () => {
    await expect(
      translateText("src", "Tibetan", {
        url: "http://localhost:11434",
        model: "m",
        fetchFn: stubFetch({ response: "   " }),
      }),
    ).rejects.toThrow("empty");
  });
});

describe("listModels", () => {
  test("maps /api/tags names", async () => {
    const names = await listModels(
      "http://localhost:11434",
      stubFetch({ models: [{ name: "a:1" }, { name: "b" }] }),
    );
    expect(names).toEqual(["a:1", "b"]);
  });
});

describe("translateWithProvider", () => {
  function capturingFetch(body: unknown) {
    const seen: { url: string; init: Record<string, unknown> } = { url: "", init: {} };
    const fn = (async (url: string, init: Record<string, unknown>) => {
      seen.url = url;
      seen.init = init;
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }) as unknown as typeof fetch;
    return { fn, seen };
  }

  const base = {
    ollama: { url: "http://localhost:11434", model: "m" },
    gemini: { apiKey: "test-key-123", model: "gemini-2.5-flash" },
  };

  test("ollama routes to /api/generate", async () => {
    const { fn, seen } = capturingFetch({ response: "hi" });
    const out = await translateWithProvider("src", "Tibetan", {
      provider: "ollama",
      ...base,
      fetchFn: fn,
    });
    expect(out).toBe("hi");
    expect(seen.url).toContain("/api/generate");
  });

  test("gemini routes to generateContent with the key header", async () => {
    const { fn, seen } = capturingFetch({
      candidates: [{ content: { parts: [{ text: "hello" }] } }],
    });
    const out = await translateWithProvider("src", "Tibetan", {
      provider: "gemini",
      ...base,
      fetchFn: fn,
    });
    expect(out).toBe("hello");
    expect(seen.url).toContain("generativelanguage.googleapis.com");
    expect(seen.url).toContain("gemini-2.5-flash");
    expect(
      (seen.init.headers as Record<string, string>)["x-goog-api-key"],
    ).toBe("test-key-123");
  });
});
