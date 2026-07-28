import {
  detectReceiptImageContentType,
  googleVisionConfidence,
  googleVisionConfidenceDetails,
  googleVisionOcr,
  receiptImageDimensions,
  receiptImageSafeToDecode,
} from "./google-vision.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("detects supported receipt image signatures", () => {
  assertEquals(
    detectReceiptImageContentType(new Uint8Array([0xff, 0xd8, 0xff, 0x00])),
    "image/jpeg",
    "JPEG signature",
  );
  assertEquals(
    detectReceiptImageContentType(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ),
    "image/png",
    "PNG signature",
  );
  assertEquals(
    detectReceiptImageContentType(
      new Uint8Array([
        0x52,
        0x49,
        0x46,
        0x46,
        0,
        0,
        0,
        0,
        0x57,
        0x45,
        0x42,
        0x50,
      ]),
    ),
    "image/webp",
    "WebP signature",
  );
  assertEquals(
    detectReceiptImageContentType(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    null,
    "non-image signature",
  );
});

Deno.test("reads declared dimensions and skips decompression bombs", () => {
  const png = new Uint8Array(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.set([0x49, 0x48, 0x44, 0x52], 12);
  png.set([0x00, 0x00, 0x0f, 0xa0], 16); // 4000
  png.set([0x00, 0x00, 0x0b, 0xb8], 20); // 3000
  const dimensions = receiptImageDimensions(png, "image/png");
  assertEquals(dimensions?.width, 4000, "PNG width");
  assertEquals(dimensions?.height, 3000, "PNG height");
  assert(receiptImageSafeToDecode(png, "image/png"), "12 MP PNG is safe");

  png.set([0x00, 0x01, 0x86, 0xa0], 16); // 100000
  assert(
    !receiptImageSafeToDecode(png, "image/png"),
    "extreme declared dimensions must not reach Image.decode",
  );

  const jpeg = new Uint8Array(21);
  jpeg.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  jpeg.set([0x04, 0x38, 0x07, 0x80], 7); // 1080 x 1920
  const jpegDimensions = receiptImageDimensions(jpeg, "image/jpeg");
  assertEquals(jpegDimensions?.width, 1920, "JPEG width");
  assertEquals(jpegDimensions?.height, 1080, "JPEG height");
});

Deno.test("sends the Vision key in a header and builds one OCR request", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const fetcher = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    requestedUrl = String(input);
    requestedInit = init;
    return new Response(
      JSON.stringify({
        responses: [{
          fullTextAnnotation: {
            text: "Paddle Rage receipt",
            pages: [{ confidence: 0.97 }],
          },
        }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const result = await googleVisionOcr(
    "test-secret-key",
    "data:image/png;base64,QUJD",
    { fetcher },
  );

  assertEquals(
    requestedUrl,
    "https://vision.googleapis.com/v1/images:annotate",
    "Vision endpoint",
  );
  assert(
    !requestedUrl.includes("test-secret-key"),
    "key must not appear in URL",
  );
  const headers = new Headers(requestedInit?.headers);
  assertEquals(
    headers.get("x-goog-api-key"),
    "test-secret-key",
    "API key header",
  );
  const requestBody = JSON.parse(String(requestedInit?.body || "{}"));
  assertEquals(requestBody.requests.length, 1, "one image request");
  assertEquals(
    requestBody.requests[0].features[0].type,
    "DOCUMENT_TEXT_DETECTION",
    "OCR feature",
  );
  assertEquals(requestBody.requests[0].image.content, "QUJD", "base64 content");
  assertEquals(result.text, "Paddle Rage receipt", "OCR text");
  assertEquals(result.confidence, 0.97, "OCR confidence");
  assertEquals(result.confidenceSource, "native", "OCR confidence source");
});

Deno.test("surfaces a bounded Google Vision API error", async () => {
  const fetcher = (async () =>
    new Response(
      JSON.stringify({ error: { message: "Cloud Vision API is disabled" } }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  let message = "";
  try {
    await googleVisionOcr("test-key", "QUJD", { fetcher });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert(message.includes("403"), "status should be included");
  assert(
    message.includes("Cloud Vision API is disabled"),
    "provider error should be included",
  );
  assert(
    !message.includes("test-key"),
    "API key must not be included in errors",
  );
});

Deno.test("averages nested OCR confidence when page confidence is absent", () => {
  const confidence = googleVisionConfidence({
    pages: [{
      blocks: [{ confidence: 0.8 }, { confidence: 0.6 }],
    }],
  }, "receipt");
  assertEquals(confidence, 0.7, "nested confidence average");
});

Deno.test("marks text-length confidence as heuristic, never native", () => {
  const result = googleVisionConfidenceDetails(
    { pages: [], text: "unused" },
    "A readable receipt-shaped OCR response longer than forty characters",
  );
  assertEquals(result.confidence, 0.9, "heuristic confidence");
  assertEquals(result.source, "heuristic", "heuristic provenance");
});
