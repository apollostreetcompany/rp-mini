import { describe, expect, it } from "vitest";
import { estimateTokens } from "./index.js";

describe("estimateTokens", () => {
  it("estimates ASCII text as ceil(utf8Bytes / 4 * 1.05)", () => {
    expect(estimateTokens("abcd".repeat(10))).toBe(11);
  });

  it("upweights text when more than 10 percent of characters are CJK", () => {
    const text = "hello世界世界世界世界世界";
    const base = Math.ceil((Buffer.byteLength(text, "utf8") / 4) * 1.05);

    expect(estimateTokens(text)).toBe(Math.ceil(base * 1.3));
  });

  it("downweights minified-looking code", () => {
    const line = "const a=1;".repeat(40);
    const text = `${line}\n${line}`;
    const base = Math.ceil((Buffer.byteLength(text, "utf8") / 4) * 1.05);

    expect(estimateTokens(text)).toBe(Math.ceil(base * 0.8));
  });
});
