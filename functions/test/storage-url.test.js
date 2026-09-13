"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  buildContentDisposition,
  guessContentType,
  isProjectBucket,
  objectPathIsSafe,
  parseTokenizedStorageUrl,
  sanitizeFilename
} = require("../lib/storage-url");

const PROJECT = "cashclique-31718";
const BUCKET = "cashclique-31718.firebasestorage.app";
const TOKEN = "1f9c5f2a-9d3b-4c7e-8a21-6b7d0e5f4a91";
const opts = { projectId: PROJECT, storageBucket: BUCKET };

test("accepts a tokenized /v0/b/<bucket>/o/<object> download URL", () => {
  const url =
    "https://firebasestorage.googleapis.com/v0/b/" + BUCKET +
    "/o/posts%2Fclip.mp4?alt=media&token=" + TOKEN;
  const parsed = parseTokenizedStorageUrl(url, opts);
  assert.strictEqual(parsed.valid, true, parsed.reason);
  assert.strictEqual(parsed.bucket, BUCKET);
  assert.strictEqual(parsed.objectPath, "posts/clip.mp4");
  assert.strictEqual(parsed.token, TOKEN);
  assert.strictEqual(parsed.filename, "clip.mp4");
});

test("accepts the project's firebasestorage.app host form", () => {
  const url = "https://" + BUCKET + "/v0/b/" + BUCKET + "/o/a%2Fb%2Fphoto.jpg?token=" + TOKEN;
  const parsed = parseTokenizedStorageUrl(url, opts);
  assert.strictEqual(parsed.valid, true, parsed.reason);
  assert.strictEqual(parsed.objectPath, "a/b/photo.jpg");
});

test("accepts the legacy appspot.com bucket", () => {
  const url =
    "https://firebasestorage.googleapis.com/v0/b/" + PROJECT +
    ".appspot.com/o/videos%2Fv.mp4?alt=media&token=" + TOKEN;
  assert.strictEqual(parseTokenizedStorageUrl(url, opts).valid, true);
});

test("accepts storage.googleapis.com path and host styles", () => {
  const byPath = parseTokenizedStorageUrl(
    "https://storage.googleapis.com/" + BUCKET + "/videos%2Fv.mp4?token=" + TOKEN, opts
  );
  assert.strictEqual(byPath.valid, true, byPath.reason);
  assert.strictEqual(byPath.objectPath, "videos/v.mp4");

  const byHost = parseTokenizedStorageUrl(
    "https://" + BUCKET + ".storage.googleapis.com/videos/v.mp4?token=" + TOKEN, opts
  );
  assert.strictEqual(byHost.valid, true, byHost.reason);
  assert.strictEqual(byHost.bucket, BUCKET);
  assert.strictEqual(byHost.objectPath, "videos/v.mp4");
});

test("rejects a URL with no download token", () => {
  const url = "https://firebasestorage.googleapis.com/v0/b/" + BUCKET + "/o/clip.mp4?alt=media";
  assert.strictEqual(parseTokenizedStorageUrl(url, opts).reason, "missing-token");
});

test("rejects a malformed token", () => {
  const url = "https://firebasestorage.googleapis.com/v0/b/" + BUCKET + "/o/clip.mp4?token=abc";
  assert.strictEqual(parseTokenizedStorageUrl(url, opts).reason, "malformed-token");
});

test("rejects another project's bucket", () => {
  const url =
    "https://firebasestorage.googleapis.com/v0/b/someone-else.appspot.com/o/clip.mp4?token=" + TOKEN;
  assert.strictEqual(parseTokenizedStorageUrl(url, opts).reason, "foreign-bucket");
  assert.strictEqual(isProjectBucket("someone-else.appspot.com", PROJECT), false);
  assert.strictEqual(isProjectBucket(BUCKET, PROJECT), true);
});

test("rejects hosts that are not Firebase/Google storage", () => {
  const url = "https://evil.example.com/v0/b/" + BUCKET + "/o/clip.mp4?token=" + TOKEN;
  assert.strictEqual(parseTokenizedStorageUrl(url, opts).reason, "unsupported-host");
});

test("rejects non-https URLs", () => {
  const url = "http://firebasestorage.googleapis.com/v0/b/" + BUCKET + "/o/c.mp4?token=" + TOKEN;
  assert.strictEqual(parseTokenizedStorageUrl(url, opts).reason, "unsupported-protocol");
});

test("rejects traversal inside the object path", () => {
  const url =
    "https://firebasestorage.googleapis.com/v0/b/" + BUCKET + "/o/..%2F..%2Fsecret.mp4?token=" + TOKEN;
  assert.strictEqual(parseTokenizedStorageUrl(url, opts).reason, "unsafe-object-path");
  assert.strictEqual(objectPathIsSafe("posts/clip.mp4"), true);
  assert.strictEqual(objectPathIsSafe("posts//clip.mp4"), false);
});

test("rejects empty and unparseable input", () => {
  assert.strictEqual(parseTokenizedStorageUrl("", opts).reason, "missing-url");
  assert.strictEqual(parseTokenizedStorageUrl(undefined, opts).reason, "missing-url");
  assert.strictEqual(parseTokenizedStorageUrl("not a url", opts).reason, "not-a-url");
});

test("sanitizes download filenames", () => {
  assert.strictEqual(sanitizeFilename('my"file.mp4'), "my_file.mp4");
  assert.strictEqual(sanitizeFilename("../../etc/passwd"), ".._.._etc_passwd");
  assert.strictEqual(sanitizeFilename("a\r\nb.mp4"), "ab.mp4");
  assert.strictEqual(sanitizeFilename("   ", "fallback.mp4"), "fallback.mp4");
  assert.strictEqual(sanitizeFilename("", "fallback.mp4"), "fallback.mp4");
});

test("builds an attachment disposition", () => {
  assert.strictEqual(
    buildContentDisposition("cashclique_1.mp4"),
    'attachment; filename="cashclique_1.mp4"'
  );
  const unicode = buildContentDisposition("café.mp4");
  assert.match(unicode, /^attachment; filename="caf_\.mp4"; filename\*=UTF-8''caf%C3%A9\.mp4$/);
});

test("guesses content types from the object path", () => {
  assert.strictEqual(guessContentType("posts/clip.mp4"), "video/mp4");
  assert.strictEqual(guessContentType("posts/clip.WEBM"), "video/webm");
  assert.strictEqual(guessContentType("posts/photo.jpg"), "image/jpeg");
  assert.strictEqual(guessContentType("posts/mystery"), "application/octet-stream");
});
