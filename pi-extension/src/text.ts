/** Python string semantics the DSPy state depends on, so TypeScript builds byte-identical inputs. */

// Characters Python's str.isprintable() rejects (other than space), which repr() escapes.
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** Python's dict.get: a present key wins even when its value is null. */
export function pyGet(obj: Record<string, unknown>, key: string, fallback: unknown): unknown {
  return obj && Object.hasOwn(obj, key) ? obj[key] : fallback;
}

/** Python's str(): strings unchanged, everything else as repr. */
export function pyStr(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}

export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return reprString(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value).map(([k, v]) => `${reprString(k)}: ${pyRepr(v)}`).join(", ")}}`;
  }
  return String(value);
}

function reprString(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch !== " " && NON_PRINTABLE.test(ch)) {
      const hex = cp.toString(16);
      out += cp <= 0xff ? `\\x${hex.padStart(2, "0")}` : cp <= 0xffff ? `\\u${hex.padStart(4, "0")}` : `\\U${hex.padStart(8, "0")}`;
    } else out += ch;
  }
  return out + quote;
}

/** state._clip: Python counts code points, so slicing works on code points too. */
export function clip(value: unknown, limit: number): string {
  const text = pyStr(value);
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit).join("")}… [${chars.length - limit} more chars]`;
}
