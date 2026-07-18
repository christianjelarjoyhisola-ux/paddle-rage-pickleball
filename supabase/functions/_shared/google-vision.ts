export type ReceiptImageContentType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export type GoogleVisionOcrResult = {
  text: string;
  confidence: number;
};

export type ReceiptImageDimensions = {
  width: number;
  height: number;
};

const GOOGLE_VISION_ANNOTATE_URL =
  "https://vision.googleapis.com/v1/images:annotate";

function errorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (record.error) return errorMessage(record.error);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "Unknown Google Vision error";
  }
}

export function detectReceiptImageContentType(
  bytes: Uint8Array,
): ReceiptImageContentType | null {
  if (
    bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d &&
    bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 &&
    bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) + bytes[offset + 3];
}

export function receiptImageDimensions(
  bytes: Uint8Array,
  contentType = detectReceiptImageContentType(bytes),
): ReceiptImageDimensions | null {
  if (contentType === "image/png") {
    if (
      bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !==
        "IHDR"
    ) return null;
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }

  if (contentType === "image/webp") {
    if (bytes.length < 30) return null;
    const kind = String.fromCharCode(...bytes.subarray(12, 16));
    if (kind === "VP8X") {
      return {
        width: u24le(bytes, 24) + 1,
        height: u24le(bytes, 27) + 1,
      };
    }
    if (
      kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    ) {
      return {
        width: u16le(bytes, 26) & 0x3fff,
        height: u16le(bytes, 28) & 0x3fff,
      };
    }
    if (kind === "VP8L" && bytes[20] === 0x2f) {
      return {
        width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) +
          ((bytes[24] & 0x0f) << 10),
      };
    }
    return null;
  }

  if (contentType === "image/jpeg") {
    const startOfFrame = new Set([
      0xc0,
      0xc1,
      0xc2,
      0xc3,
      0xc5,
      0xc6,
      0xc7,
      0xc9,
      0xca,
      0xcb,
      0xcd,
      0xce,
      0xcf,
    ]);
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
      if (offset + 1 >= bytes.length) return null;
      const segmentLength = u16be(bytes, offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) {
        return null;
      }
      if (startOfFrame.has(marker) && segmentLength >= 7) {
        return {
          width: u16be(bytes, offset + 5),
          height: u16be(bytes, offset + 3),
        };
      }
      offset += segmentLength;
    }
  }
  return null;
}

export function receiptImageSafeToDecode(
  bytes: Uint8Array,
  contentType = detectReceiptImageContentType(bytes),
  maxPixels = 16 * 1024 * 1024,
  maxDimension = 8192,
): boolean {
  const dimensions = receiptImageDimensions(bytes, contentType);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
    return false;
  }
  if (dimensions.width > maxDimension || dimensions.height > maxDimension) {
    return false;
  }
  return dimensions.width <= Math.floor(maxPixels / dimensions.height);
}

export function googleVisionConfidence(
  annotation: Record<string, unknown> | null,
  text: string,
): number {
  if (!annotation) return text.length > 40 ? 0.9 : text.length > 0 ? 0.5 : 0;
  const pages = Array.isArray(annotation.pages)
    ? annotation.pages as Array<Record<string, unknown>>
    : [];
  if (
    pages.length && typeof pages[0].confidence === "number" &&
    pages[0].confidence > 0
  ) {
    return pages[0].confidence;
  }

  let total = 0;
  let count = 0;
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const item = node as Record<string, unknown>;
    if (typeof item.confidence === "number" && item.confidence > 0) {
      total += item.confidence;
      count++;
    }
    for (const key of ["blocks", "paragraphs", "words", "symbols"]) {
      const children = item[key];
      if (Array.isArray(children)) children.forEach(visit);
    }
  };
  pages.forEach(visit);
  if (count > 0) return total / count;
  return text.length > 40 ? 0.9 : text.length > 0 ? 0.5 : 0;
}

type GoogleVisionOcrOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

export async function googleVisionOcr(
  apiKey: string,
  base64: string,
  options: GoogleVisionOcrOptions = {},
): Promise<GoogleVisionOcrResult> {
  const key = apiKey.trim();
  if (!key) throw new Error("Google Vision API key is missing");

  const comma = base64.indexOf(",");
  const content = base64.startsWith("data:") && comma !== -1
    ? base64.slice(comma + 1)
    : base64;
  if (!content) throw new Error("Google Vision image content is empty");

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 25_000,
  );
  let response: Response;
  try {
    response = await (options.fetcher || fetch)(GOOGLE_VISION_ANNOTATE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Keep credentials out of URLs, proxy logs, and exception traces.
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        requests: [{
          image: { content },
          features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
          imageContext: { languageHints: ["en"] },
        }],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Google Vision request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(
      `Google Vision error ${response.status}: ${
        errorMessage(data).slice(0, 500)
      }`,
    );
  }
  const responses = Array.isArray(data.responses) ? data.responses : [];
  const result = (responses[0] || {}) as Record<string, unknown>;
  if (result.error) {
    throw new Error(
      `Google Vision: ${errorMessage(result.error).slice(0, 500)}`,
    );
  }

  const fullText = result.fullTextAnnotation &&
      typeof result.fullTextAnnotation === "object"
    ? result.fullTextAnnotation as Record<string, unknown>
    : null;
  const textAnnotations = Array.isArray(result.textAnnotations)
    ? result.textAnnotations as Array<Record<string, unknown>>
    : [];
  const text = typeof fullText?.text === "string"
    ? fullText.text
    : typeof textAnnotations[0]?.description === "string"
    ? textAnnotations[0].description
    : "";

  return {
    text,
    confidence: googleVisionConfidence(fullText, text),
  };
}
