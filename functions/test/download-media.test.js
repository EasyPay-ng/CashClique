"use strict";

/*
 * Behaviour tests for the downloadMedia HTTP proxy.
 *
 * The Firebase Admin SDKs are stubbed so the real handler in ../index.js runs
 * against a fake Storage object. This is the regression test for the bug that
 * broke every photo and video save: the token check read `metadata.downloadTokens`,
 * which `file.getMetadata()` never returns (the Cloud Storage JSON API keeps the
 * token in `metadata.firebaseStorageDownloadTokens`), so the proxy answered 403
 * for every request and both download buttons failed.
 */

const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const { Readable, Writable } = require("node:stream");

const PROJECT = "cashclique-31718";
const BUCKET = PROJECT + ".firebasestorage.app";
const TOKEN = "1f9c5f2a-9d3b-4c7e-8a21-6b7d0e5f4a91";
const OTHER_TOKEN = "9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d";
const VIDEO_BYTES = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

// ---------------------------------------------------------------------------
// Stub the Firebase SDKs before requiring the functions entry point.
// ---------------------------------------------------------------------------
let handler = null;
let handlerOptions = null;
let storageFile = null;
let streamRequested = 0;
const requestedPaths = [];
const logs = { warn: [], error: [] };

function documentStub() {
  return {
    onCreate: () => ({}),
    onUpdate: () => ({})
  };
}

const firestoreStub = () => ({
  collection: () => ({
    doc: () => ({
      get: async () => ({ exists: false }),
      collection: () => ({ add: async () => ({}) })
    })
  })
});
firestoreStub.FieldValue = { serverTimestamp: () => "SERVER_TIMESTAMP" };

const adminStub = {
  initializeApp: () => {},
  firestore: firestoreStub,
  storage: () => ({
    bucket: () => ({
      file: (objectPath) => {
        requestedPaths.push(objectPath);
        return storageFile;
      }
    })
  })
};

const functionsV1 = { firestore: { document: () => documentStub() } };
const functionsV2 = {
  onRequest: (options, fn) => {
    handlerOptions = options;
    handler = fn;
    return fn;
  }
};
const loggerStub = {
  warn: (...args) => logs.warn.push(args),
  error: (...args) => logs.error.push(args),
  info: () => {},
  log: () => {}
};

// index.js resolves the project + bucket at load time, exactly like the
// Functions runtime does through FIREBASE_CONFIG.
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT, storageBucket: BUCKET });

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "firebase-functions/v1") return functionsV1;
  if (request === "firebase-functions/v2/https") return functionsV2;
  if (request === "firebase-functions/logger") return loggerStub;
  if (request === "firebase-admin") return adminStub;
  return realLoad.call(this, request, parent, isMain);
};
require("../index.js");
Module._load = realLoad;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeBucketFile(metadata, options = {}) {
  return {
    getMetadata: async () => {
      if (options.metadataError) throw options.metadataError;
      return [metadata];
    },
    createReadStream: () => {
      streamRequested += 1;
      return Readable.from([options.bytes || VIDEO_BYTES]);
    }
  };
}

function makeResponse() {
  const chunks = [];
  const res = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
  res.statusCode = 200;
  res.headers = {};
  res.body = null;
  res.headersSent = false;
  res.set = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
    return res;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    res.end();
    return res;
  };
  res.send = (payload) => {
    res.body = payload;
    res.end();
    return res;
  };
  res.chunks = chunks;
  return res;
}

function storageUrl(params = {}) {
  const search = new URLSearchParams({ alt: "media", token: params.token === undefined ? TOKEN : params.token });
  if (params.filename) search.set("filename", params.filename);
  return "https://firebasestorage.googleapis.com/v0/b/" + BUCKET +
    "/o/" + encodeURIComponent(params.objectPath || "posts/clip.mp4") + "?" + search.toString();
}

async function invoke(method, query, deps = {}) {
  storageFile = deps.file || null;
  // Mirror Express: the proxy reads `url` and `filename` from its own query
  // string, which is what buildProxyUrl() puts on the request.
  const proxyQuery = Object.assign({}, query);
  if (proxyQuery.url) {
    const filename = new URL(proxyQuery.url).searchParams.get("filename");
    if (filename) proxyQuery.filename = filename;
  }
  const res = makeResponse();
  const finished = new Promise((resolve) => res.on("finish", resolve));
  await handler({ method, query: proxyQuery, headers: {} }, res);
  await finished;
  return res;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test("is deployed as a public us-central1 endpoint", async () => {
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(typeof handler === "function", "onRequest registered the handler");
  assert.strictEqual(handlerOptions.region, "us-central1");
  assert.strictEqual(handlerOptions.invoker, "public");
});

test("OPTIONS gets an empty CORS preflight response", async () => {
  const res = await invoke("OPTIONS", {});
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(res.headers["access-control-allow-origin"], "*");
  assert.match(res.headers["access-control-allow-methods"], /GET/);
});

test("streams a video whose token is stored in Cloud Storage custom metadata", async () => {
  // Exactly what admin.storage().bucket().file().getMetadata() returns.
  const metadata = {
    contentType: "video/mp4",
    size: String(VIDEO_BYTES.length),
    metadata: { firebaseStorageDownloadTokens: TOKEN }
  };
  const res = await invoke("GET", {
    url: storageUrl({ filename: "cashclique_v1.mp4" })
  }, { file: makeBucketFile(metadata) });

  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.headers["content-type"], "video/mp4");
  assert.strictEqual(res.headers["content-length"], String(VIDEO_BYTES.length));
  assert.strictEqual(res.headers["content-disposition"], 'attachment; filename="cashclique_v1.mp4"');
  assert.strictEqual(res.headers["access-control-allow-origin"], "*");
  assert.deepStrictEqual(Buffer.concat(res.chunks), VIDEO_BYTES, "the original bytes are streamed");
  assert.deepStrictEqual(requestedPaths, ["posts/clip.mp4"]);
});

test("streams a photo when several tokens are live and the requested one is second", async () => {
  const metadata = {
    contentType: "image/jpeg",
    metadata: { firebaseStorageDownloadTokens: OTHER_TOKEN + "," + TOKEN }
  };
  const res = await invoke("GET", {
    url: storageUrl({ objectPath: "images/uid/photo.jpg", filename: "cashclique_p1.jpg" })
  }, { file: makeBucketFile(metadata) });

  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.headers["content-type"], "image/jpeg");
  assert.deepStrictEqual(Buffer.concat(res.chunks), VIDEO_BYTES);
});

test("still accepts the Firebase metadata shape (top-level downloadTokens)", async () => {
  const metadata = { contentType: "video/webm", downloadTokens: TOKEN };
  const res = await invoke("GET", {
    url: storageUrl({ objectPath: "posts/clip.webm" })
  }, { file: makeBucketFile(metadata) });

  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.headers["content-type"], "video/webm");
});

test("rejects a URL whose token is not one of the object's live tokens", async () => {
  streamRequested = 0;
  const metadata = { contentType: "video/mp4", metadata: { firebaseStorageDownloadTokens: OTHER_TOKEN } };
  const res = await invoke("GET", {
    url: storageUrl({ token: TOKEN })
  }, { file: makeBucketFile(metadata) });

  assert.strictEqual(res.statusCode, 403);
  assert.match(res.body.error, /no longer valid/i);
  assert.strictEqual(streamRequested, 0, "nothing is streamed for a rejected token");
  assert.strictEqual(logs.warn.length >= 1, true, "the rejection is logged");
});

test("rejects an object that has no download token at all", async () => {
  streamRequested = 0;
  const res = await invoke("GET", {
    url: storageUrl({})
  }, { file: makeBucketFile({ contentType: "video/mp4", metadata: {} }) });

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(streamRequested, 0);
});

test("returns 404 when the object is missing and 502 on an unexpected storage error", async () => {
  const notFound = Object.assign(new Error("Not Found"), { code: 404 });
  const missing = await invoke("GET", { url: storageUrl({}) }, {
    file: makeBucketFile({}, { metadataError: notFound })
  });
  assert.strictEqual(missing.statusCode, 404);

  const broken = await invoke("GET", { url: storageUrl({}) }, {
    file: makeBucketFile({}, { metadataError: Object.assign(new Error("boom"), { code: 500 }) })
  });
  assert.strictEqual(broken.statusCode, 502);
});

test("answers HEAD without opening a read stream", async () => {
  streamRequested = 0;
  const res = await invoke("HEAD", { url: storageUrl({}) }, {
    file: makeBucketFile({ contentType: "video/mp4", metadata: { firebaseStorageDownloadTokens: TOKEN } })
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(streamRequested, 0);
});

test("rejects other methods, foreign buckets and untokenized URLs", async () => {
  const post = await invoke("POST", {});
  assert.strictEqual(post.statusCode, 405);

  const foreign = await invoke("GET", {
    url: "https://firebasestorage.googleapis.com/v0/b/someone-else.appspot.com/o/clip.mp4?token=" + TOKEN
  });
  assert.strictEqual(foreign.statusCode, 400);
  assert.strictEqual(foreign.body.reason, "foreign-bucket");

  const untokenized = await invoke("GET", {
    url: "https://firebasestorage.googleapis.com/v0/b/" + BUCKET + "/o/clip.mp4?alt=media"
  });
  assert.strictEqual(untokenized.statusCode, 400);
  assert.strictEqual(untokenized.body.reason, "missing-token");
});
