export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";

export interface Decoded {
  text: string;
  encoding: Encoding;
  bom: boolean;
}

/** Work out a file's text encoding and decode it. */
export function decodeBytes(bytes: Uint8Array): Decoded {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8", bom: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le", bom: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be", bom: true };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8", bom: false };
  } catch {
    // Not valid UTF-8: almost certainly an older Excel/Windows export.
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252", bom: false };
  }
}

// Windows-1252 differs from Latin-1 only in 0x80–0x9F.
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
  0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
  0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
  0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Encode text back into the file's original encoding. */
export function encodeText(text: string, encoding: Encoding, bom: boolean): Uint8Array {
  if (encoding === "utf-8") {
    const body = new TextEncoder().encode(text);
    if (!bom) return body;
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    const le = encoding === "utf-16le";
    const off = bom ? 2 : 0;
    const out = new Uint8Array(text.length * 2 + off);
    if (bom) out.set(le ? [0xff, 0xfe] : [0xfe, 0xff]);
    for (let i = 0; i < text.length; i++) {
      const u = text.charCodeAt(i);
      out[off + i * 2] = le ? u & 0xff : u >> 8;
      out[off + i * 2 + 1] = le ? u >> 8 : u & 0xff;
    }
    return out;
  }
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const u = text.charCodeAt(i);
    if (u < 0x80 || (u >= 0xa0 && u <= 0xff)) out[i] = u;
    else out[i] = CP1252_HIGH[u] ?? 0x3f; // "?" for characters 1252 can't hold
  }
  return out;
}

export function encodingLabel(e: Encoding, bom: boolean): string {
  switch (e) {
    case "utf-8": return bom ? "UTF-8 (BOM)" : "UTF-8";
    case "utf-16le": return "UTF-16 LE";
    case "utf-16be": return "UTF-16 BE";
    case "windows-1252": return "Windows-1252";
  }
}
