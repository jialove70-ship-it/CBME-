import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPollHandlers } from "../netlify/functions/lib/poll.mjs";

const ORIGIN = "https://cbme-example.netlify.app";
const ROOM = "ABC234";
const NOW = "2026-10-21T01:02:03.000Z";

class MockStore {
  records = new Map();
  writes = [];
  reads = [];
  listCalls = [];
  pagesVisited = 0;

  constructor(pageSize = 7) {
    this.pageSize = pageSize;
  }

  async setJSON(key, value, options) {
    // Yield to overlap requests, then emulate the store's atomic conditional write.
    await Promise.resolve();
    this.writes.push({ key, value, options });
    if (options.onlyIfNew && this.records.has(key)) return { modified: false };
    this.records.set(key, structuredClone(value));
    return { modified: true, etag: `etag-${this.records.size}` };
  }

  async get(key, options) {
    this.reads.push({ key, options });
    await Promise.resolve();
    return structuredClone(this.records.get(key) ?? null);
  }

  async *list(options) {
    this.listCalls.push(options);
    const keys = [...this.records.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    for (let index = 0; index < keys.length; index += this.pageSize) {
      this.pagesVisited += 1;
      yield { blobs: keys.slice(index, index + this.pageSize).map((key) => ({ key, etag: "etag" })), directories: [] };
    }
  }
}

function setup(store = new MockStore()) {
  let opens = 0;
  const handlers = createPollHandlers({
    openStore: () => { opens += 1; return store; },
    now: () => new Date(NOW),
  });
  return { store, ...handlers, opens: () => opens };
}

function voteRequest(data, { contentType = "application/json", headers = {}, body, method = "POST" } = {}) {
  return new Request(`${ORIGIN}/.netlify/functions/vote`, {
    method,
    headers: { Origin: ORIGIN, "Content-Type": contentType, ...headers },
    ...(method === "GET" || method === "HEAD" ? {} : { body: body ?? JSON.stringify(data) }),
  });
}

function resultsRequest(room = ROOM, extra = "") {
  return new Request(`${ORIGIN}/.netlify/functions/results?room=${encodeURIComponent(room)}${extra}`);
}

function validVote(overrides = {}) {
  return { room: ROOM, voterId: randomUUID(), choice: "used", ...overrides };
}

test("100 concurrent voters remain separate and all appear across every results page", async () => {
  const { vote, results, store } = setup();
  const choices = ["used", "curious", "first"];
  const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => vote(voteRequest(validVote({ choice: choices[index % 3] })))));
  assert.deepEqual(responses.map(({ status }) => status), Array(100).fill(201));
  assert.equal(store.records.size, 100);
  assert.equal(new Set(store.writes.map(({ key }) => key)).size, 100);
  assert.ok(store.writes.every(({ options }) => options.onlyIfNew === true));

  const response = await results(resultsRequest());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { room: ROOM, total: 100, counts: { used: 34, curious: 33, first: 33 }, updatedAt: NOW });
  assert.equal(store.pagesVisited, 15);
  assert.deepEqual(store.listCalls, [{ prefix: `${ROOM}/`, paginate: true }]);
  assert.ok(store.reads.every(({ options }) => options.type === "json" && options.consistency === "strong"));
});

test("simultaneous retries from one browser accept one vote and return the saved choice", async () => {
  const { vote, results, store } = setup();
  const voterId = randomUUID();
  const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => vote(voteRequest(validVote({ voterId, choice: index % 2 ? "curious" : "used" })))));
  const accepted = responses.filter(({ status }) => status === 201);
  const rejected = responses.filter(({ status }) => status === 409);
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 99);
  const savedChoice = (await accepted[0].json()).choice;
  for (const response of rejected) {
    const body = await response.json();
    assert.equal(body.error, "already_voted");
    assert.equal(body.choice, savedChoice);
  }
  assert.equal(store.records.size, 1);
  assert.equal((await (await results(resultsRequest())).json()).total, 1);
});

test("UUID case variants cannot change a vote; the same browser may vote in a new room", async () => {
  const { vote, results } = setup();
  const voterId = randomUUID();
  assert.equal((await vote(voteRequest(validVote({ voterId })))).status, 201);
  const duplicate = await vote(voteRequest(validVote({ voterId: voterId.toUpperCase(), choice: "first" })));
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).choice, "used");
  assert.equal((await vote(voteRequest(validVote({ room: "XYZ789", voterId, choice: "first" })))).status, 201);
  assert.deepEqual((await (await results(resultsRequest("XYZ789"))).json()).counts, { used: 0, curious: 0, first: 1 });
  assert.deepEqual((await (await results(resultsRequest())).json()).counts, { used: 1, curious: 0, first: 0 });
});

test("invalid room, voter, choice and JSON shapes never touch storage", async (t) => {
  const cases = [
    ["lowercase room", validVote({ room: "abc234" }), "invalid_room"],
    ["short room", validVote({ room: "ABC23" }), "invalid_room"],
    ["path traversal", validVote({ room: "../ABC" }), "invalid_room"],
    ["excluded digit", validVote({ room: "ABC201" }), "invalid_room"],
    ["invalid UUID", validVote({ voterId: "browser-123" }), "invalid_voter"],
    ["invalid choice", validVote({ choice: "__proto__" }), "invalid_choice"],
    ["missing field", { room: ROOM, choice: "used" }, "invalid_input"],
    ["extra field", validVote({ role: "admin" }), "invalid_input"],
    ["array", [], "invalid_input"],
    ["null", null, "invalid_input"],
  ];
  for (const [name, data, code] of cases) {
    await t.test(name, async () => {
      const { vote, opens } = setup();
      const response = await vote(voteRequest(data));
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, code);
      assert.equal(opens(), 0);
    });
  }
});

test("body and content type are validated, including actual streamed bytes", async (t) => {
  const cases = [
    ["wrong content type", { contentType: "text/plain" }, 415],
    ["broken JSON", { body: "{" }, 400],
    ["oversized actual body", { body: " ".repeat(1025) }, 413],
    ["oversized declared body", { headers: { "Content-Length": "1025" } }, 413],
    ["invalid declared length", { headers: { "Content-Length": "-1" } }, 400],
  ];
  for (const [name, options, expected] of cases) {
    await t.test(name, async () => {
      const { vote, opens } = setup();
      assert.equal((await vote(voteRequest(validVote(), options))).status, expected);
      assert.equal(opens(), 0);
    });
  }
  const { vote } = setup();
  assert.equal((await vote(voteRequest(validVote(), { contentType: "application/json; charset=utf-8" }))).status, 201);
});

test("unsupported methods and cross-site browser requests are rejected without CORS access", async () => {
  const { vote, results, opens } = setup();
  const wrongMethod = await vote(voteRequest(validVote(), { method: "GET" }));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("Allow"), "POST");
  const crossOrigin = await vote(voteRequest(validVote(), { headers: { Origin: "https://other.example" } }));
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.get("Access-Control-Allow-Origin"), null);
  const crossSite = await vote(voteRequest(validVote(), { headers: { "Sec-Fetch-Site": "cross-site" } }));
  assert.equal(crossSite.status, 403);
  assert.equal((await results(new Request(`${ORIGIN}/.netlify/functions/results?room=${ROOM}`, { method: "POST" }))).status, 405);
  assert.equal(opens(), 0);
});

test("results validate room, return zeros for an empty room, and are never cacheable", async () => {
  const { vote, results } = setup();
  for (const url of [
    `${ORIGIN}/.netlify/functions/results`,
    `${ORIGIN}/.netlify/functions/results?room=bad`,
    `${ORIGIN}/.netlify/functions/results?room=${ROOM}&room=XYZ789`,
  ]) assert.equal((await results(new Request(url))).status, 400);

  const response = await results(resultsRequest());
  assert.deepEqual(await response.json(), { room: ROOM, total: 0, counts: { used: 0, curious: 0, first: 0 }, updatedAt: NOW });
  const accepted = await vote(voteRequest(validVote()));
  for (const checked of [response, accepted]) {
    assert.equal(checked.headers.get("Cache-Control"), "no-store");
    assert.equal(checked.headers.get("Netlify-CDN-Cache-Control"), "no-store");
    assert.equal(checked.headers.get("Access-Control-Allow-Origin"), null);
    assert.match(checked.headers.get("Content-Type"), /^application\/json/);
  }
});

test("pagination is isolated by room and ignores unrelated or malformed records", async () => {
  const store = new MockStore(2);
  for (const choice of ["used", "used", "curious", "first", "first"]) store.records.set(`${ROOM}/${randomUUID()}`, { choice });
  store.records.set(`XYZ789/${randomUUID()}`, { choice: "used" });
  store.records.set(`${ROOM}/not-a-voter`, { choice: "used" });
  store.records.set(`${ROOM}/${randomUUID()}`, { choice: "unknown" });
  const { results } = setup(store);
  assert.deepEqual((await (await results(resultsRequest())).json()).counts, { used: 2, curious: 1, first: 2 });
  assert.equal(store.pagesVisited, 4);
});

test("store failures return a retryable status without internal details", async () => {
  const { vote, results } = setup({
    setJSON: async () => { throw new Error("sensitive infrastructure detail"); },
    async *list() { throw new Error("sensitive infrastructure detail"); },
  });
  for (const response of [await vote(voteRequest(validVote())), await results(resultsRequest())]) {
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.match(body, /storage_unavailable/);
    assert.doesNotMatch(body, /sensitive infrastructure detail/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});

test('the specified GitHub Pages origin can use the shared Netlify poll', async () => {
  const { vote, results } = setup();
  const githubOrigin = 'https://jialove70-ship-it.github.io';
  const headers = { Origin: githubOrigin, 'Sec-Fetch-Site': 'cross-site' };
  const preflight = await vote(new Request(ORIGIN + '/.netlify/functions/vote', {
    method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), githubOrigin);
  const posted = await vote(voteRequest(validVote(), { headers }));
  assert.equal(posted.status, 201);
  assert.equal(posted.headers.get('Access-Control-Allow-Origin'), githubOrigin);
  const counted = await results(new Request(ORIGIN + '/.netlify/functions/results?room=' + ROOM, { headers }));
  assert.equal(counted.status, 200);
  assert.equal((await counted.json()).total, 1);
  assert.equal(counted.headers.get('Vary'), 'Origin');
  const forbidden = await vote(new Request(ORIGIN + '/.netlify/functions/vote', {
    method: 'OPTIONS', headers: { Origin: 'https://untrusted.example', 'Access-Control-Request-Method': 'POST' }
  }));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get('Access-Control-Allow-Origin'), null);
});
