// Editor names are evidence only inside metadata, never compressed pixels.
const editor =
  /\b(?:adobe\s*photoshop|gimp|pixlr|snapseed|picsart|lightroom|inkscape)\b/i;
const decoder = new TextDecoder("latin1");
const LIMIT = 65536;

async function inflated(data: Uint8Array): Promise<string> {
  const reader = new Blob([new Uint8Array(data)]).stream().pipeThrough(
    new DecompressionStream("deflate"),
  ).getReader();
  let size = 0, text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > LIMIT) break;
      text += decoder.decode(value);
    }
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text;
}

export async function editedBySoftware(bytes: Uint8Array): Promise<boolean> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 8 && bytes[0] === 137 &&
    decoder.decode(bytes.subarray(1, 4)) === "PNG"
  ) {
    for (let pos = 8; pos + 12 <= bytes.length;) {
      const length = view.getUint32(pos), end = pos + 12 + length;
      if (end > bytes.length) break;
      const type = decoder.decode(bytes.subarray(pos + 4, pos + 8));
      if (length <= LIMIT && ["tEXt", "iTXt", "zTXt", "eXIf"].includes(type)) {
        const data = bytes.subarray(pos + 8, pos + 8 + length);
        let text = "";
        if (type === "tEXt" || type === "eXIf") text = decoder.decode(data);
        else {
          const keywordEnd = data.indexOf(0);
          if (
            keywordEnd >= 0 && type === "zTXt" && data[keywordEnd + 1] === 0
          ) text = await inflated(data.subarray(keywordEnd + 2));
          if (keywordEnd >= 0 && type === "iTXt") {
            const languageEnd = data.indexOf(0, keywordEnd + 3);
            const translatedEnd = languageEnd >= 0
              ? data.indexOf(0, languageEnd + 1)
              : -1;
            if (translatedEnd >= 0) {
              text = data[keywordEnd + 1] === 1
                ? await inflated(data.subarray(translatedEnd + 1))
                : decoder.decode(data.subarray(translatedEnd + 1));
            }
          }
        }
        if (editor.test(text)) return true;
      }
      if (type === "IEND") break;
      pos = end;
    }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    for (let pos = 2; pos + 4 <= bytes.length;) {
      if (bytes[pos] !== 255) break;
      while (bytes[pos] === 255) pos++;
      const marker = bytes[pos++];
      if (marker === 218 || marker === 217) break; // Never inspect JPEG scan data.
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (pos + 2 > bytes.length) break;
      const length = view.getUint16(pos);
      if (length < 2 || pos + length > bytes.length) break;
      if (
        [225, 237, 254].includes(marker) && length <= LIMIT &&
        editor.test(decoder.decode(bytes.subarray(pos + 2, pos + length)))
      ) return true;
      pos += length;
    }
  }
  return false;
}
