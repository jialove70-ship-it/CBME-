export const STORE_NAME = "cbme-poll-v1";
export const CHOICES = Object.freeze(["used", "curious", "first"]);
const ROOM_PATTERN = /^[A-Z2-9]{6}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1024;
const READ_CONCURRENCY = 20;
const ALLOWED_WEB_ORIGINS = new Set(['https://jialove70-ship-it.github.io']);

class RequestError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "CDN-Cache-Control": "no-store",
      "Netlify-CDN-Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function validateMethodAndOrigin(request, method) {
  if (request.method !== method) {
    throw new RequestError(405, "method_not_allowed", "此端點不支援這個請求方式。", { Allow: method });
  }
  const origin = request.headers.get("Origin");
  const allowedOrigin = origin === new URL(request.url).origin || ALLOWED_WEB_ORIGINS.has(origin);
  if ((origin && !allowedOrigin) || (request.headers.get("Sec-Fetch-Site") === "cross-site" && !ALLOWED_WEB_ORIGINS.has(origin))) {
    throw new RequestError(403, "cross_origin_request", "請從本網站開啟投票。無法接受跨網站請求。");
  }
}

function validateRoom(room) {
  if (typeof room !== "string" || !ROOM_PATTERN.test(room)) {
    throw new RequestError(400, "invalid_room", "請輸入六位大寫英文或數字的房間代碼。");
  }
  return room;
}

async function readSmallJson(request) {
  const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new RequestError(415, "unsupported_media_type", "請以 JSON 格式送出投票。");
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      throw new RequestError(400, "invalid_content_length", "請求長度格式不正確。");
    }
    if (Number(contentLength) > MAX_BODY_BYTES) {
      throw new RequestError(413, "body_too_large", "投票資料超過大小限制。");
    }
  }

  const reader = request.body?.getReader();
  if (!reader) {
    throw new RequestError(400, "invalid_json", "投票資料不是有效的 JSON。");
  }
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new RequestError(413, "body_too_large", "投票資料超過大小限制。");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(400, "invalid_body", "無法讀取投票資料，請重新送出。");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestError(400, "invalid_json", "投票資料不是有效的 JSON。");
  }
}

function validateVote(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new RequestError(400, "invalid_input", "投票資料格式不正確。");
  }
  const keys = Object.keys(data);
  if (keys.length !== 3 || keys.some((key) => !["room", "voterId", "choice"].includes(key))) {
    throw new RequestError(400, "invalid_input", "投票資料須包含房間、投票識別碼與選項。");
  }
  const room = validateRoom(data.room);
  if (typeof data.voterId !== "string" || !UUID_PATTERN.test(data.voterId)) {
    throw new RequestError(400, "invalid_voter", "投票識別碼格式不正確，請重新開啟投票頁。");
  }
  if (!CHOICES.includes(data.choice)) {
    throw new RequestError(400, "invalid_choice", "請選擇有效的投票選項。");
  }
  return { room, voterId: data.voterId.toLowerCase(), choice: data.choice };
}

function handled(handler) {
  return async (request) => {
    const origin = request.headers.get('Origin');
    const addCors = response => {
      if (ALLOWED_WEB_ORIGINS.has(origin)) {
        response.headers.set('Access-Control-Allow-Origin', origin);
        response.headers.set('Vary', 'Origin');
      }
      return response;
    };
    try {
      if (request.method === 'OPTIONS') {
        validateMethodAndOrigin(request, 'OPTIONS');
        const method = request.headers.get('Access-Control-Request-Method');
        const headers = (request.headers.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (!['GET', 'POST'].includes(method) || headers.some(value => value !== 'content-type')) {
          throw new RequestError(403, 'invalid_preflight', '不允許此跨站請求。');
        }
        return addCors(new Response(null, { status: 204, headers: {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Cache-Control': 'no-store',
        } }));
      }
      return addCors(await handler(request));
    } catch (error) {
      if (error instanceof RequestError) {
        return addCors(jsonResponse({ error: error.code, message: error.message }, error.status, error.headers));
      }
      // Return no store details or participant identifiers to clients or logs.
      console.error("Poll storage request failed.");
      return addCors(jsonResponse({ error: "storage_unavailable", message: "投票服務暫時無法連線，請稍後再試。" }, 503));
    }
  };
}

/** Store access is injected so concurrency and HTTP behaviour can be tested offline. */
export function createPollHandlers({ openStore, now = () => new Date() }) {
  if (typeof openStore !== "function") throw new TypeError("openStore is required");

  const vote = handled(async (request) => {
    validateMethodAndOrigin(request, "POST");
    const { room, voterId, choice } = validateVote(await readSmallJson(request));
    const store = openStore();
    const key = `${room}/${voterId}`;
    // Each voter has an immutable record. Atomic create-only writes avoid lost votes.
    const { modified } = await store.setJSON(key, { choice, createdAt: now().toISOString() }, { onlyIfNew: true });
    if (modified === true) return jsonResponse({ room, choice, voted: true }, 201);
    if (modified !== false) throw new Error("Unexpected store response");

    const existing = await store.get(key, { type: "json", consistency: "strong" });
    if (!existing || !CHOICES.includes(existing.choice)) throw new Error("Existing vote is unavailable");
    return jsonResponse({
      error: "already_voted",
      message: "此瀏覽器已在這個房間完成投票，無法更改選項。",
      room,
      choice: existing.choice,
    }, 409);
  });

  const results = handled(async (request) => {
    validateMethodAndOrigin(request, "GET");
    const query = new URL(request.url).searchParams;
    if (query.getAll("room").length !== 1) {
      throw new RequestError(400, "invalid_room", "請提供一個有效的房間代碼。");
    }
    const room = validateRoom(query.get("room"));
    const store = openStore();
    const prefix = `${room}/`;
    const counts = { used: 0, curious: 0, first: 0 };
    const seen = new Set();

    // Iterate every page; the key prefix isolates each presentation room.
    for await (const page of store.list({ prefix, paginate: true })) {
      const keys = page.blobs.map(({ key }) => key).filter((key) => {
        if (typeof key !== "string" || !key.startsWith(prefix) || !UUID_PATTERN.test(key.slice(prefix.length)) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      for (let index = 0; index < keys.length; index += READ_CONCURRENCY) {
        const records = await Promise.all(keys.slice(index, index + READ_CONCURRENCY).map((key) => store.get(key, { type: "json", consistency: "strong" })));
        for (const record of records) {
          if (record && CHOICES.includes(record.choice)) counts[record.choice] += 1;
        }
      }
    }
    return jsonResponse({
      room,
      total: counts.used + counts.curious + counts.first,
      counts,
      updatedAt: now().toISOString(),
    });
  });

  return { vote, results };
}
