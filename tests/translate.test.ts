import { describe, test, expect } from "bun:test";
import { buildPrompt, translateText, listModels } from "../src/translate.ts";

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
