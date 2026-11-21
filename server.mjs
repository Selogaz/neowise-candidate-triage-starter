import { createServer as createHttpServer } from "node:http";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));
const topics = new Set(["delivery", "pricing", "other"]);
const manualReview = { status: "manual_review", topic: null, draft: null };
export const maxBodyBytes = 64 * 1024;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function classifyRequest(text, classifier) {
  const signal = AbortSignal.timeout(300);
  const deadline = new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

  try {
    const output = await Promise.race([classifier(text, { signal }), deadline]);
    if (typeof output !== "string") return manualReview;
    const result = JSON.parse(output);
    if (!isObject(result) || !topics.has(result.topic) ||
        typeof result.draft !== "string" || !result.draft.trim()) {
      return manualReview;
    }
    return { status: "ready", topic: result.topic, draft: result.draft };
  } catch {
    return manualReview;
  }
}

async function handleTriage(request, response, classifier) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    // Дочитываем лишнее без хранения, чтобы клиент получил ответ, а память не росла.
    if (size <= maxBodyBytes) chunks.push(chunk);
  }
  if (size > maxBodyBytes) {
    return json(response, 413, { status: "payload_too_large" });
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return json(response, 400, { status: "invalid_input" });
  }
  if (!isObject(input) || typeof input.text !== "string" || !input.text.trim()) {
    return json(response, 400, { status: "invalid_input" });
  }
  return json(response, 200, await classifyRequest(input.text, classifier));
}

export function createServer(classifier = classify) {
  return createHttpServer(async (request, response) => {
    let pathname;
    try {
      ({ pathname } = new URL(request.url, "http://localhost"));
    } catch {
      return json(response, 400, { status: "invalid_input" });
    }
    if (request.method === "GET" && pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || pathname !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response, classifier);
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const port = Number(process.env.PORT || 3000);
  const server = createServer();
  server.on("error", (error) => {
    console.error(error.code === "EADDRINUSE"
      ? `Порт ${port} занят. Задайте другой через переменную PORT.`
      : `Не удалось запустить сервер: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Сервер запущен: http://127.0.0.1:${server.address().port}`);
  });
}
