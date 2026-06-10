export function estimateTokens(text: string): number {
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  const base = Math.ceil((utf8Bytes / 4) * 1.05);
  const cjkRatio = text.length === 0 ? 0 : countCjkCharacters(text) / text.length;
  const minified = isMinifiedLike(text);
  let multiplier = 1;

  if (cjkRatio > 0.1) multiplier *= 1.3;
  if (minified) multiplier *= 0.8;

  return Math.ceil(base * multiplier);
}

function countCjkCharacters(text: string): number {
  let count = 0;
  for (const char of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) {
      count += 1;
    }
  }
  return count;
}

function isMinifiedLike(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const avgLineLength = lines.length === 0 ? 0 : text.length / lines.length;
  const semicolonDensity = text.length === 0 ? 0 : (text.match(/;/g)?.length ?? 0) / text.length;
  return avgLineLength > 100 && semicolonDensity > 0.01;
}
