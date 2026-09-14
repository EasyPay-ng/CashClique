/*
 * Shared "Save to device" plumbing for CashClique.
 *
 * Rules this module enforces for every page that uses it:
 *   - Saved photos are re-encoded as a new JPEG with the CashClique mark
 *     burned in, from an origin-clean blob: URL, so canvas.toBlob() succeeds
 *     and the watermark cannot be stripped by CORS.
 *   - Saved videos keep their original bytes, format, quality and audio. No
 *     watermarking, playback, canvas or MediaRecorder support is required.
 *   - Bytes are fetched directly first and through the downloadMedia Firebase
 *     Function proxy second, because the Storage bucket may not send CORS
 *     headers. Nothing here ever navigates to the media URL, opens a tab, or
 *     starts playing the video as a "fallback".
 */

import {
    APP_NAME,
    SITE_LOGO_URL,
    drawCenterGhost,
    drawCornerMark,
    getWatermarkMark,
    loadImageElement
} from "./watermark.js";

export {
    APP_NAME,
    SITE_LOGO_URL,
    getWatermarkMark
};

// HTTP proxy that streams a tokenized Firebase Storage download URL back with
// CORS headers. Used only when the direct fetch is blocked.
export const MEDIA_PROXY_URL = "https://us-central1-cashclique-31718.cloudfunctions.net/downloadMedia";

export const PROJECT_STORAGE_BUCKET = "cashclique-31718.firebasestorage.app";

const FETCH_TIMEOUT_MS = 240000;
const STORAGE_HOSTS = ["firebasestorage.googleapis.com", "storage.googleapis.com"];

/** Error type carrying a message that is safe to show the user. */
export class MediaSaveError extends Error {
    constructor(kind, message, options = {}) {
        super(message);
        this.name = "MediaSaveError";
        this.kind = kind || "failed";
        this.userMessage = options.userMessage || friendlyMessage(this.kind, message);
        this.details = options.details || "";
        if (options.cause !== undefined) this.cause = options.cause;
        if (this.kind === "cancelled") this.cancelled = true;
    }
}

const USER_MESSAGES = {
    cancelled: "Save cancelled",
    unsupported: "This browser cannot save a watermarked copy. Please update your browser and try again.",
    network: "Could not download this media. Check your connection and try again.",
    render: "Could not add the CashClique watermark. Please try again.",
    empty: "This media file is empty.",
    tainted: "This media is blocked by cross-origin restrictions and cannot be watermarked."
};

function friendlyMessage(kind, fallback) {
    return USER_MESSAGES[kind] || fallback || "Could not save this media. Please try again.";
}

/** Normalise anything thrown along the way into a MediaSaveError. */
export function toMediaSaveError(error) {
    if (error instanceof MediaSaveError) return error;
    const kind = (error && error.kind) || (error && error.cancelled ? "cancelled" : "failed");
    if (kind === "cancelled") return new MediaSaveError("cancelled", "Save cancelled", { cause: error });
    const isSecurity = error && (error.name === "SecurityError" || /tainted|origin-clean|cross-origin/i.test(String(error && error.message)));
    const resolvedKind = isSecurity ? "tainted" : kind;
    return new MediaSaveError(resolvedKind, (error && error.message) || "Could not save this media", {
        userMessage: USER_MESSAGES[resolvedKind],
        cause: error
    });
}

/** Trigger a browser download for a Blob. Never used with a media URL. */
export function downloadBlob(blob, filename) {
    if (!blob || !blob.size) {
        throw new MediaSaveError("empty", "There is nothing to download");
    }
    const safeName = sanitizeFilename(filename) || "cashclique-media";
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; // blob: URL only - never the Firebase Storage URL
    anchor.download = safeName;
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
        URL.revokeObjectURL(url);
        anchor.remove();
    }, 4000);
    return safeName;
}

export function sanitizeFilename(filename) {
    return String(filename || "")
        .replace(/[\\/:*?"<>|\r\n]+/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
}

export function mediaFilename(id, extension) {
    const safeId = String(id || "").replace(/[^A-Za-z0-9_-]+/g, "") || String(Date.now());
    const ext = String(extension || "jpg").replace(/[^A-Za-z0-9]+/g, "") || "jpg";
    return `cashclique_${safeId}.${ext}`;
}

/** True for Firebase Storage / Google Cloud Storage download URLs. */
export function isStorageDownloadUrl(href) {
    try {
        const url = new URL(href, window.location.href);
        if (url.protocol !== "https:" && url.protocol !== "http:") return false;
        const host = url.hostname.toLowerCase();
        if (host === PROJECT_STORAGE_BUCKET) return true;
        return STORAGE_HOSTS.indexOf(host) !== -1 ||
            host.endsWith(".firebasestorage.app") ||
            host.endsWith(".storage.googleapis.com") ||
            host.endsWith(".firebasestorage.googleapis.com");
    } catch (error) {
        return false;
    }
}

export function buildProxyUrl(href, filename) {
    const proxy = new URL(MEDIA_PROXY_URL);
    proxy.searchParams.set("url", String(href));
    const safeName = sanitizeFilename(filename);
    if (safeName) proxy.searchParams.set("filename", safeName);
    return proxy.toString();
}

/**
 * Fetch media bytes: direct URL first, downloadMedia proxy second.
 * Resolves with `{ blob, contentType, viaProxy }`; rejects with MediaSaveError
 * when both attempts fail (the caller shows a toast and stays on the page).
 */
export async function fetchMediaBlob(href, options = {}) {
    const { filename = "", isCancelled = () => false, timeoutMs = FETCH_TIMEOUT_MS } = options;
    if (!href) throw new MediaSaveError("network", "No media URL to download");

    const attempts = [{ label: "direct", url: href }];
    if (isStorageDownloadUrl(href)) {
        attempts.push({ label: "proxy", url: buildProxyUrl(href, filename) });
    }

    const failures = [];
    for (const attempt of attempts) {
        if (isCancelled()) throw new MediaSaveError("cancelled", "Save cancelled");
        try {
            const result = await fetchOnce(attempt.url, { timeoutMs, isCancelled });
            return {
                blob: result.blob,
                contentType: result.contentType,
                viaProxy: attempt.label === "proxy"
            };
        } catch (error) {
            if (error instanceof MediaSaveError && error.kind === "cancelled") throw error;
            const reason = (error && error.message) || String(error);
            failures.push(attempt.label + ": " + reason);
            console.warn("[CashClique] media fetch via " + attempt.label + " URL failed:", error);
        }
    }

    throw new MediaSaveError("network", "Could not download the media file", {
        userMessage: USER_MESSAGES.network,
        details: failures.join(" | ")
    });
}

async function fetchOnce(url, options) {
    const { timeoutMs, isCancelled } = options;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller && timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    // Cancelling the save must also stop an in-flight download.
    const cancelPoll = controller && typeof isCancelled === "function"
        ? setInterval(() => {
            if (isCancelled()) controller.abort();
        }, 250)
        : null;
    try {
        const response = await fetch(url, {
            signal: controller ? controller.signal : undefined,
            cache: "no-store",
            credentials: "omit",
            redirect: "follow"
        });
        if (!response.ok) throw new Error("HTTP " + response.status + " " + (response.statusText || ""));
        const blob = await response.blob();
        if (!blob || !blob.size) throw new Error("empty response body");
        if (isCancelled && isCancelled()) throw new MediaSaveError("cancelled", "Save cancelled");
        return { blob, contentType: response.headers.get("content-type") || blob.type || "" };
    } catch (error) {
        if (error && error.name === "AbortError") {
            if (isCancelled && isCancelled()) throw new MediaSaveError("cancelled", "Save cancelled");
            throw new Error("timed out after " + Math.round((timeoutMs || 0) / 1000) + "s");
        }
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
        if (cancelPoll) clearInterval(cancelPoll);
    }
}

export function extensionForContentType(contentType, fallback) {
    const type = String(contentType || "").toLowerCase();
    if (type.includes("webm")) return "webm";
    if (type.includes("ogg")) return "ogv";
    if (type.includes("quicktime")) return "mov";
    if (type.includes("matroska")) return "mkv";
    if (type.includes("mpeg")) return "mpg";
    if (type.includes("mp4") || type.includes("m4v")) return "mp4";
    if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
    if (type.includes("png")) return "png";
    if (type.includes("webp")) return "webp";
    if (type.includes("gif")) return "gif";
    return fallback || "mp4";
}

function canvasToBlob(canvas, type, quality) {
    if (typeof canvas.toBlob === "function") {
        return new Promise((resolve, reject) => {
            try {
                canvas.toBlob((blob) => resolve(blob || null), type, quality);
            } catch (error) {
                reject(error);
            }
        });
    }
    // Very old browsers: rebuild the Blob from the data URL.
    return Promise.resolve().then(() => {
        const dataUrl = canvas.toDataURL(type, quality);
        const parts = String(dataUrl).split(",");
        const mime = (parts[0].match(/data:([^;]+)/) || [, type])[1];
        const binary = atob(parts[1] || "");
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    });
}

function assertCanvasReadable(context, width, height) {
    try {
        context.getImageData(0, 0, Math.min(1, width), Math.min(1, height));
    } catch (error) {
        throw new MediaSaveError("tainted", "Canvas is not origin-clean", { cause: error });
    }
}

/**
 * Build a watermarked JPEG from a data URL, an http(s) URL, or a Blob.
 * Remote sources are downloaded to a Blob first and drawn from the object URL
 * so the canvas stays origin-clean and toBlob() cannot fail on CORS.
 */
export async function createWatermarkedJpeg(options = {}) {
    const {
        id = "",
        src = "",
        blob = null,
        filename = "",
        quality = 0.94,
        ghost = true,
        watermark = null,
        isCancelled = () => false
    } = options;

    const targetName = sanitizeFilename(filename) || mediaFilename(id, "jpg");
    if (!src && !blob) throw new MediaSaveError("empty", "Nothing to save");

    let objectUrl = "";
    try {
        let imageSource = "";
        if (blob) {
            objectUrl = URL.createObjectURL(blob);
            imageSource = objectUrl;
        } else if (/^data:/i.test(src)) {
            imageSource = src;
        } else {
            const fetched = await fetchMediaBlob(src, { filename: targetName, isCancelled });
            objectUrl = URL.createObjectURL(fetched.blob);
            imageSource = objectUrl;
        }

        if (isCancelled()) throw new MediaSaveError("cancelled", "Save cancelled");

        const image = await loadImageElement(imageSource, { timeoutMs: 30000 });
        if (!image) throw new MediaSaveError("render", "Could not decode this photo");

        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) throw new MediaSaveError("render", "Could not read this photo's dimensions");

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new MediaSaveError("unsupported", "Canvas is unavailable in this browser");

        context.drawImage(image, 0, 0, width, height);
        assertCanvasReadable(context, width, height);

        // `watermark` lets tests and tools inject a pre-rendered mark.
        const mark = watermark ? { canvas: watermark, source: "provided" } : await getWatermarkMark();
        const logo = mark && mark.canvas ? mark.canvas : null;
        if (ghost && logo) drawCenterGhost(context, width, height, logo);
        drawCornerMark(context, width, height, logo, { appName: APP_NAME });

        const output = await canvasToBlob(canvas, "image/jpeg", quality);
        if (!output || !output.size) {
            throw new MediaSaveError("render", "Could not create the watermarked photo");
        }
        return { blob: output, filename: targetName, width, height, watermarkSource: mark ? mark.source : "drawn" };
    } catch (error) {
        throw toMediaSaveError(error);
    } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
}

/**
 * Download the original video, without re-encoding or adding a watermark.
 * Keep the existing CORS proxy and cancellation behaviour on every page.
 */
export async function createVideoDownload(options = {}) {
    const { id = "", src = "", blob = null, isCancelled = () => false, onStage = () => {} } = options;
    if (!src && !blob) throw new MediaSaveError("empty", "Nothing to save");
    try {
        if (isCancelled()) throw new MediaSaveError("cancelled", "Save cancelled");
        onStage("download");
        const fetched = blob ? { blob, contentType: blob.type, viaProxy: false } :
            await fetchMediaBlob(src, { filename: mediaFilename(id, videoExtensionFromUrl(src)), isCancelled });
        if (isCancelled()) throw new MediaSaveError("cancelled", "Save cancelled");
        if (!fetched.blob || !fetched.blob.size) throw new MediaSaveError("empty", "This video is empty");
        const extension = extensionForContentType(fetched.contentType || fetched.blob.type, videoExtensionFromUrl(src));
        return {
            blob: fetched.blob,
            filename: mediaFilename(id, extension),
            extension,
            mimeType: fetched.contentType || fetched.blob.type,
            viaProxy: fetched.viaProxy
        };
    } catch (error) {
        throw toMediaSaveError(error);
    }
}

// Firebase Storage paths are percent-encoded. Use their extension only when
// Content-Type is missing/generic, never include URL queries in the filename.
function videoExtensionFromUrl(src) {
    try {
        const path = decodeURIComponent(new URL(src).pathname);
        const match = path.match(/\.(mp4|webm|mov|m4v|mkv|ogv|avi|mpg|mpeg)$/i);
        return match ? match[1].toLowerCase() : "mp4";
    } catch (_) {
        return "mp4";
    }
}
