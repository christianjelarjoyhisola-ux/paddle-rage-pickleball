import { googleVisionOcr } from "./google-vision.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
const success = () =>
  Response.json({
    responses: [{
      fullTextAnnotation: {
        text: "Receipt text",
        pages: [{ confidence: .96 }],
      },
    }],
  });
async function failure(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    return String(error);
  }
  throw Error("Expected error");
}
function sequence(items: Array<() => Response | Promise<Response>>) {
  let calls = 0;
  const fetcher = (() => items[calls++]()) as typeof fetch;
  return { fetcher, count: () => calls };
}
Deno.test("Vision retries one 503 or 429 then returns native OCR evidence", async () => {
  for (const status of [503, 429]) {
    const mock = sequence([
      () => Response.json({ error: { message: "temporary" } }, { status }),
      success,
    ]);
    const result = await googleVisionOcr("test-key", "aGVsbG8=", mock);
    assert(
      mock.count() === 2 && result.text === "Receipt text" &&
        result.confidenceSource === "native",
      "retry evidence",
    );
  }
});
Deno.test("Vision exhausts exactly two transient attempts", async () => {
  const fail = () =>
    Response.json({ error: { message: "temporary" } }, { status: 503 });
  const mock = sequence([fail, fail, success]);
  assert(
    (await failure(googleVisionOcr("test-key", "aGVsbG8=", mock))).includes(
      "503",
    ),
    "final failure",
  );
  assert(mock.count() === 2, "only one retry");
});
Deno.test("Vision never retries invalid image, authentication, or permission failures", async () => {
  for (const status of [400, 401, 403]) {
    const mock = sequence([
      () => Response.json({ error: { message: "permanent" } }, { status }),
      success,
    ]);
    await failure(googleVisionOcr("test-key", "aGVsbG8=", mock));
    assert(mock.count() === 1, "permanent HTTP failure retried");
  }
  for (const code of [3, 7, 16]) {
    const mock = sequence([
      () =>
        Response.json({
          responses: [{ error: { code, message: "permanent" } }],
        }),
      success,
    ]);
    await failure(googleVisionOcr("test-key", "aGVsbG8=", mock));
    assert(mock.count() === 1, "permanent API failure retried");
  }
});
Deno.test("Vision retries explicit transient per-image API errors", async () => {
  for (const code of [4, 8, 13, 14]) {
    const mock = sequence([
      () =>
        Response.json({
          responses: [{ error: { code, message: "temporary" } }],
        }),
      success,
    ]);
    await googleVisionOcr("test-key", "aGVsbG8=", mock);
    assert(mock.count() === 2, "API transient retry");
  }
});
Deno.test("Vision retries fetch network errors but not arbitrary programming errors", async () => {
  const mock = sequence([() => {
    throw new TypeError("network failed");
  }, success]);
  await googleVisionOcr("test-key", "aGVsbG8=", mock);
  assert(mock.count() === 2, "network retry");
  const bug = sequence([() => {
    throw new Error("programming error");
  }, success]);
  await failure(googleVisionOcr("test-key", "aGVsbG8=", bug));
  assert(bug.count() === 1, "bug retried");
});
Deno.test("Vision does not retry empty or incomplete OCR", async () => {
  for (
    const data of [{ responses: [{}] }, {
      responses: [{ fullTextAnnotation: { text: "Amount only" } }],
    }]
  ) {
    const mock = sequence([() => Response.json(data), success]);
    await googleVisionOcr("test-key", "aGVsbG8=", mock);
    assert(mock.count() === 1, "missing evidence retried");
  }
});
const waitForAbort = (signal: AbortSignal) =>
  new Promise<Response>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
Deno.test("Vision recovers once after timeout within the original total budget", async () => {
  let calls = 0;
  const fetcher =
    ((_url: unknown, init: RequestInit) =>
      ++calls === 1
        ? waitForAbort(init.signal!)
        : Promise.resolve(success())) as typeof fetch;
  const result = await googleVisionOcr("test-key", "aGVsbG8=", {
    fetcher,
    timeoutMs: 1_000,
  });
  assert(calls === 2 && result.text === "Receipt text", "timeout recovery");
});
Deno.test("Vision repeated timeout remains bounded and attempts are aborted", async () => {
  let calls = 0;
  const signals: AbortSignal[] = [];
  const fetcher = ((_url: unknown, init: RequestInit) => {
    calls++;
    signals.push(init.signal!);
    return waitForAbort(init.signal!);
  }) as typeof fetch;
  assert(
    (await failure(
      googleVisionOcr("test-key", "aGVsbG8=", { fetcher, timeoutMs: 1_000 }),
    )).includes("timed out"),
    "timeout error",
  );
  assert(calls === 2 && signals.every((s) => s.aborted), "bounded aborts");
});

