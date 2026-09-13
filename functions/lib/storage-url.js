"use strict";

/**
 * Pure helpers used by the downloadMedia proxy.
 *
 * The web app cannot always read Firebase Storage bytes directly: the bucket
 * may not return CORS headers, and a cross-origin <a download> navigates to
 * the media instead of saving it. The proxy re-streams the object, but only
 * for a tokenized download URL that points at this project's bucket, so it is
 * not an open file reader for the whole bucket.
 *
 * Kept free of Firebase imports so it can be unit tested with plain node.
 */

const FIREBASE_STORAGE_HOST = "firebasestorage.googleapis.com";
const GCS_HOST = "storage.googleapis.com";
const FIREBASESTORAGE_APP_SUFFIX = ".firebasestorage.app";
const GCS_HOST_SUFFIX = ".storage.googleapis.com";

const CONTENT_TYPES = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  pdf: "application/pdf",
  json: "application/json",
  txt: "text/plain"
};

/** Project id from the Functions runtime, with the usual env fallbacks. */
function resolveProjectId(explicit) {
  if (explicit) return String(explicit);
  if (process.env.FIREBASE_CONFIG) {
    try {
      const config = JSON.parse(process.env.FIREBASE_CONFIG);
      if (config && config.projectId) return String(config.projectId);
    } catch (error) {
      // Malformed FIREBASE_CONFIG: fall through to the env vars.
    }
  }
  return String(process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "");
}

/** Storage bucket configured for the running app (may be empty locally). */
function resolveStorageBucket(explicit) {
  if (explicit) return String(explicit);
  if (process.env.FIREBASE_CONFIG) {
    try {
      const config = JSON.parse(process.env.FIREBASE_CONFIG);
      if (config && config.storageBucket) return String(config.storageBucket);
    } catch (error) {
      // Ignore and rely on the project-derived bucket names.
    }
  }
  return "";
}

/** Buckets that belong to this project and may therefore be proxied. */
function projectBuckets(projectId, extraBuckets) {
  const pid = String(projectId || "").toLowerCase();
  const buckets = [];
  if (pid) {
    buckets.push(pid + ".appspot.com");
    buckets.push(pid + ".firebasestorage.app");
  }
  (extraBuckets || []).forEach((bucket) => {
    const name = String(bucket || "").toLowerCase();
    if (name && buckets.indexOf(name) === -1) buckets.push(name);
  });
  return buckets;
}

function isProjectBucket(bucket, projectId, extraBuckets) {
  const name = String(bucket || "").toLowerCase();
  if (!name) return false;
  if (projectBuckets(projectId, extraBuckets).indexOf(name) !== -1) return true;
  const pid = String(projectId || "").toLowerCase();
  // Custom-named buckets are still project scoped when they are prefixed.
  return !!pid && name.indexOf(pid + ".") === 0;
}

function isSupportedHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  return (
    host === FIREBASE_STORAGE_HOST ||
    host === GCS_HOST ||
    host.endsWith(FIREBASESTORAGE_APP_SUFFIX) ||
    host.endsWith(GCS_HOST_SUFFIX)
  );
}

function invalid(reason) {
  return { valid: false, reason: reason, bucket: "", objectPath: "", token: "", filename: "" };
}

function valid(parsed) {
  return Object.assign({ valid: true, reason: "" }, parsed);
}

function objectPathIsSafe(objectPath) {
  const path = String(objectPath || "");
  if (!path || path.length > 1024) return false;
  if (path.indexOf("\u0000") !== -1) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    return segment;
  }
}

/**
 * Validate a Firebase Storage download URL.
 *
 * Accepts the shapes the console and SDK hand out:
 *   https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<object>?alt=media&token=<t>
 *   https://<project>.firebasestorage.app/v0/b/<bucket>/o/<object>?alt=media&token=<t>
 *   https://<bucket>.storage.googleapis.com/<object>?token=<t>
 *   https://storage.googleapis.com/<bucket>/<object>?token=<t>
 *
 * Returns { valid, reason, bucket, objectPath, token, filename }.
 */
function parseTokenizedStorageUrl(rawUrl, options) {
  const opts = options || {};
  const projectId = resolveProjectId(opts.projectId);
  const extraBuckets = [resolveStorageBucket(opts.storageBucket)].filter(Boolean);
  if (Array.isArray(opts.allowedBuckets)) {
    opts.allowedBuckets.forEach((bucket) => {
      if (bucket) extraBuckets.push(String(bucket));
    });
  }

  if (!rawUrl) return invalid("missing-url");

  let url;
  try {
    url = new URL(String(rawUrl));
  } catch (error) {
    return invalid("not-a-url");
  }

  if (url.protocol !== "https:") return invalid("unsupported-protocol");
  if (!isSupportedHost(url.hostname)) return invalid("unsupported-host");

  const token = url.searchParams.get("token") || "";
  if (!token) return invalid("missing-token");
  if (!/^[A-Za-z0-9._-]{16,256}$/.test(token)) return invalid("malformed-token");

  const host = url.hostname.toLowerCase();
  const pathname = url.pathname;
  let bucket = "";
  let objectPath = "";

  // /v0/b/<bucket>/o/<object> (any version prefix)
  const bucketObjectMatch = pathname.match(/\/b\/([^/]+)\/o\/(.+)$/);
  if (bucketObjectMatch) {
    bucket = decodeSegment(bucketObjectMatch[1]);
    objectPath = decodeSegment(bucketObjectMatch[2]);
  } else if (host === GCS_HOST) {
    // https://storage.googleapis.com/<bucket>/<object>
    const pathMatch = pathname.match(/^\/([^/]+)\/(.+)$/);
    if (pathMatch) {
      bucket = decodeSegment(pathMatch[1]);
      objectPath = decodeSegment(pathMatch[2]);
    }
  } else if (host.endsWith(GCS_HOST_SUFFIX)) {
    // https://<bucket>.storage.googleapis.com/<object>
    bucket = host.slice(0, -GCS_HOST_SUFFIX.length);
    objectPath = decodeSegment(pathname.replace(/^\/+/, ""));
  } else if (host.endsWith(FIREBASESTORAGE_APP_SUFFIX) || host === FIREBASE_STORAGE_HOST) {
    // https://<project>.firebasestorage.app/<object>
    bucket = host;
    objectPath = decodeSegment(pathname.replace(/^\/+/, ""));
  }

  if (!bucket || !objectPath) return invalid("unsupported-path");
  if (!isProjectBucket(bucket, projectId, extraBuckets)) return invalid("foreign-bucket");
  if (!objectPathIsSafe(objectPath)) return invalid("unsafe-object-path");

  const filename = objectPath.split("/").pop() || "cashclique-media";
  return valid({ bucket: bucket, objectPath: objectPath, token: token, filename: filename });
}

/** Strip anything that could break a Content-Disposition header. */
function sanitizeFilename(name, fallback) {
  const cleaned = String(name || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-150);
  return cleaned || String(fallback || "cashclique-media");
}

/** attachment disposition with an RFC 5987 variant for non-ASCII names. */
function buildContentDisposition(filename) {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
  let header = 'attachment; filename="' + ascii + '"';
  if (ascii !== safe) {
    header += "; filename*=UTF-8''" + encodeURIComponent(safe);
  }
  return header;
}

function guessContentType(objectPath) {
  const ext = String(objectPath || "").split(".").pop().toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

module.exports = {
  CONTENT_TYPES,
  buildContentDisposition,
  guessContentType,
  isProjectBucket,
  isSupportedHost,
  objectPathIsSafe,
  parseTokenizedStorageUrl,
  projectBuckets,
  resolveProjectId,
  resolveStorageBucket,
  sanitizeFilename
};
