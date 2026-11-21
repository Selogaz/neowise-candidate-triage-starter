import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { createServer, maxBodyBytes } from "./server.mjs";

const manualReview = { status: "manual_review", topic: null, draft: null };
const mockDraft = "Спасибо за обращение. Уточним детали заявки.";
const customOutputs = new Map([
  ["extra fields", { status: "unexpected", topic: "other", draft: "Черновик ответа", extra: true }],
  ["null output", null],
  ["array output", [{ topic: "other", draft: mockDraft }]],
  ["numeric draft", { topic: "other", draft: 42 }],
  ["missing draft", { topic: "other" }],
]);

let classifierCalls = 0;
let timeoutSignal;
const server = createServer();
const customServer = createServer((text, { signal }) => {
  classifierCalls++;
  if (text === "ignore timeout") {
    timeoutSignal = signal;
    return new Promise(() => {});
  }
  if (!customOutputs.has(text)) throw new Error(`Unexpected classifier input: ${text}`);
  return JSON.stringify(customOutputs.get(text));
});

before(async () => {
  await Promise.all([server, customServer].map(async (instance) => {
    instance.listen(0, "127.0.0.1");
    await once(instance, "listening");
  }));
});

after(async () => {
  const listeningServers = [server, customServer].filter((instance) => instance.listening);
  await Promise.all(listeningServers.map((instance) => new Promise((resolve, reject) => {
    instance.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  })));
});

function url(instance, path) {
  return `http://127.0.0.1:${instance.address().port}${path}`;
}

async function postTriage(instance, body, path = "/api/triage") {
  const response = await fetch(url(instance, path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(3_000),
  });
  return { status: response.status, body: await response.json() };
}

// Ответ должен прийти по лимиту 300 мс: не раньше и заметно до штатных 1200 мс имитатора.
function assertWithinTimeout(elapsed) {
  assert.ok(elapsed >= 250, `Expected at least 250 ms, got ${elapsed.toFixed(0)} ms`);
  assert.ok(elapsed < 1_000, `Expected less than 1,000 ms, got ${elapsed.toFixed(0)} ms`);
}

test("rejects invalid input before calling the classifier", async () => {
  for (const body of [
    "{",
    "null",
    "42",
    '"text"',
    '["text"]',
    "{}",
    '{"text":null}',
    '{"text":42}',
    '{"text":""}',
    JSON.stringify({ text: " \t\n" }),
  ]) {
    assert.deepEqual(await postTriage(customServer, body), {
      status: 400,
      body: { status: "invalid_input" },
    }, body);
  }
  assert.equal(classifierCalls, 0);
});

test("returns a ready response for each supported topic", async () => {
  for (const [text, topic] of [
    ["Когда доставка?", "delivery"],
    ["Какова стоимость доставки?", "pricing"],
    ["Как с вами связаться?", "other"],
  ]) {
    assert.deepEqual(await postTriage(server, JSON.stringify({ text })), {
      status: 200,
      body: { status: "ready", topic, draft: mockDraft },
    });
  }
});

test("returns only the public response fields", async () => {
  assert.deepEqual(await postTriage(customServer, '{"text":"extra fields"}'), {
    status: 200,
    body: { status: "ready", topic: "other", draft: "Черновик ответа" },
  });
});

test("sends invalid model outputs to manual review", async () => {
  for (const text of ["null output", "array output", "numeric draft", "missing draft"]) {
    assert.deepEqual(await postTriage(customServer, JSON.stringify({ text })), {
      status: 200,
      body: manualReview,
    }, text);
  }
});

test("sends mock failure cases to manual review", async () => {
  for (const text of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    assert.deepEqual(await postTriage(server, JSON.stringify({ text })), {
      status: 200,
      body: manualReview,
    }, text);
  }
});

test("returns manual review before the mock delay completes", async () => {
  const start = performance.now();
  const result = await postTriage(server, '{"text":"[timeout]"}');
  const elapsed = performance.now() - start;
  assert.deepEqual(result, { status: 200, body: manualReview });
  assertWithinTimeout(elapsed);
});

test("limits waiting when the model ignores the abort signal", async () => {
  const start = performance.now();
  const result = await postTriage(customServer, '{"text":"ignore timeout"}');
  const elapsed = performance.now() - start;
  assert.deepEqual(result, { status: 200, body: manualReview });
  assertWithinTimeout(elapsed);
  assert.ok(timeoutSignal instanceof AbortSignal);
  assert.ok(timeoutSignal.aborted);
});

test("serves the page and rejects unknown routes", async () => {
  const page = await fetch(url(server, "/"));
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.match(await page.text(), /<form>/);

  for (const [method, path] of [["GET", "/missing"], ["GET", "/api/triage"], ["POST", "/"]]) {
    const response = await fetch(url(server, path), { method });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), { status: "not_found" });
  }
});

test("routes by path and ignores the query string", async () => {
  assert.deepEqual(await postTriage(server, '{"text":"Когда доставка?"}', "/api/triage?source=test"), {
    status: 200,
    body: { status: "ready", topic: "delivery", draft: mockDraft },
  });
});

test("rejects oversized bodies without calling the classifier", async () => {
  const callsBefore = classifierCalls;
  const text = "a".repeat(maxBodyBytes);
  assert.deepEqual(await postTriage(customServer, JSON.stringify({ text })), {
    status: 413,
    body: { status: "payload_too_large" },
  });
  assert.equal(classifierCalls, callsBefore);
});
