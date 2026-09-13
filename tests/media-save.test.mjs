/*
 * Behaviour tests for the Save-to-device flow (js/media-save.js and friends).
 *
 * They run against the browser stub in ./dom-stub.mjs and pin down the rules
 * the save flow has to respect:
 *   - photos are re-encoded as a new watermarked JPEG from an origin-clean
 *     blob: URL,
 *   - videos are re-recorded through canvas + MediaRecorder with the mark,
 *   - bytes come from the direct URL first and the downloadMedia proxy second,
 *   - nothing ever downloads an unwatermarked copy, opens a tab, or navigates
 *     to the media URL.
 */

import test from "node:test";
import assert from "node:assert";

import { fakeErrorResponse, fakeResponse, installDom } from "./dom-stub.mjs";
import {
    MEDIA_PROXY_URL,
    MediaSaveError,
    buildProxyUrl,
    createWatermarkedJpeg,
    createWatermarkedVideo,
    downloadBlob,
    extensionForContentType,
    fetchMediaBlob,
    isStorageDownloadUrl,
    mediaFilename,
    videoWatermarkSupported
} from "../js/media-save.js";
import { SITE_LOGO_URL, getWatermarkMark, resetWatermarkMark } from "../js/watermark.js";

const STORAGE_URL =
    "https://firebasestorage.googleapis.com/v0/b/cashclique-31718.firebasestorage.app" +
    "/o/posts%2Fclip.mp4?alt=media&token=1f9c5f2a-9d3b-4c7e-8a21-6b7d0e5f4a91";
const PHOTO_URL =
    "https://firebasestorage.googleapis.com/v0/b/cashclique-31718.firebasestorage.app" +
    "/o/posts%2Fphoto.jpg?alt=media&token=1f9c5f2a-9d3b-4c7e-8a21-6b7d0e5f4a91";
const DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA";

const VIDEO_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
const PHOTO_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

async function waitFor(predicate, timeoutMs = 3000) {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return true;
}

/** Every test gets a fresh browser stub and a fresh watermark cache. */
function withDom(options, fn) {
    return async (t) => {
        const dom = installDom(options);
        resetWatermarkMark();
        t.after(() => {
            resetWatermarkMark();
            dom.restore();
        });
        await fn(t, dom);
    };
}

function isFakeVideo(dom, source) {
    return source instanceof dom.helpers.FakeVideo;
}

function isFakeImage(dom, source) {
    return source instanceof dom.helpers.FakeImage;
}

function isMark(dom, source) {
    return source instanceof dom.helpers.FakeCanvas;
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

test("photo: a data URL is re-encoded as a new watermarked JPEG", withDom({ remoteLogo: true }, async (t, dom) => {
    const result = await createWatermarkedJpeg({ id: "p1", src: DATA_URL });

    assert.ok(result.blob instanceof Blob, "a new Blob must come back");
    assert.strictEqual(result.blob.type, "image/jpeg");
    assert.strictEqual(result.filename, "cashclique_p1.jpg");
    assert.strictEqual(dom.calls.fetch.length, 0, "data URLs need no network");

    assert.strictEqual(dom.calls.toBlob.length, 1, "exactly one JPEG encode");
    assert.strictEqual(dom.calls.toBlob[0].type, "image/jpeg");
    assert.strictEqual(dom.calls.toBlob[0].quality, 0.94);
    assert.strictEqual(dom.calls.toBlob[0].width, 512);

    // The photo itself plus the corner mark (and the faint centre ghost).
    assert.ok(dom.calls.drawImage.some((source) => isFakeImage(dom, source)), "photo drawn to canvas");
    assert.ok(dom.calls.drawImage.filter((source) => isMark(dom, source)).length >= 2,
        "logo mark drawn as ghost + corner");

    assert.strictEqual(dom.calls.downloads.length, 0, "the page decides when to download");
    assert.strictEqual(dom.calls.windowOpen.length, 0);
    assert.strictEqual(result.watermarkSource, "cloudinary");
}));

test("photo: a remote URL is downloaded to a Blob and drawn from an origin-clean object URL",
    withDom({ remoteLogo: false }, async (t, dom) => {
        dom.fetchHandler = async (url) => {
            if (url === PHOTO_URL) return fakeResponse(PHOTO_BYTES, { contentType: "image/jpeg" });
            return fakeErrorResponse(404, "unexpected");
        };

        const result = await createWatermarkedJpeg({ id: "p2", src: PHOTO_URL });

        assert.strictEqual(dom.calls.fetch[0], PHOTO_URL, "direct URL is tried first");
        assert.strictEqual(dom.calls.objectUrls.length, 1, "bytes are turned into an object URL");
        assert.ok(dom.calls.imageSrcs.some((src) => src.indexOf("blob:") === 0),
            "the <img> is loaded from the object URL, never the cross-origin URL");
        assert.strictEqual(result.blob.type, "image/jpeg");
        assert.notStrictEqual(result.blob, dom.calls.objectUrls[0], "the saved Blob is the re-encoded JPEG");
        assert.ok(dom.calls.revokedUrls.length >= 1, "object URL is released");
        assert.strictEqual(dom.calls.toBlob.length, 1);
        assert.strictEqual(result.watermarkSource, "local", "local fallback mark used when the CDN is blocked");
    }));

test("photo: falls back to the downloadMedia proxy when the direct fetch is CORS-blocked",
    withDom({ remoteLogo: true }, async (t, dom) => {
        dom.fetchHandler = async (url) => {
            if (url.indexOf(MEDIA_PROXY_URL) === 0) {
                return fakeResponse(PHOTO_BYTES, { contentType: "image/jpeg" });
            }
            throw new TypeError("Failed to fetch");
        };

        const result = await createWatermarkedJpeg({ id: "p3", src: PHOTO_URL });

        assert.strictEqual(dom.calls.fetch.length, 2, "direct attempt then proxy attempt");
        assert.ok(dom.calls.fetch[1].indexOf(MEDIA_PROXY_URL) === 0, "second attempt is the proxy");
        assert.ok(dom.calls.fetch[1].indexOf(encodeURIComponent(PHOTO_URL)) !== -1,
            "proxy receives the original Storage URL");
        assert.strictEqual(result.blob.type, "image/jpeg");
        assert.strictEqual(dom.calls.windowOpen.length, 0);
        assert.strictEqual(dom.calls.downloads.length, 0);
    }));

test("photo: a tainted canvas fails loudly instead of saving an unwatermarked copy",
    withDom({ remoteLogo: true, canvasTainted: true }, async (t, dom) => {
        await assert.rejects(
            createWatermarkedJpeg({ id: "p4", src: DATA_URL }),
            (error) => error instanceof MediaSaveError && error.kind === "tainted"
        );
        assert.strictEqual(dom.calls.toBlob.length, 0, "nothing is encoded without the watermark");
        assert.strictEqual(dom.calls.downloads.length, 0);
        assert.strictEqual(dom.calls.windowOpen.length, 0);
    }));

test("photo: a failed JPEG encode raises an error with a message for the user",
    withDom({ remoteLogo: true, toBlobResult: "null" }, async (t, dom) => {
        await assert.rejects(
            createWatermarkedJpeg({ id: "p5", src: DATA_URL }),
            (error) => error instanceof MediaSaveError && error.kind === "render" && !!error.userMessage
        );
        assert.strictEqual(dom.calls.downloads.length, 0);
    }));

test("photo: nothing to save is reported, not downloaded", withDom({}, async (t, dom) => {
    await assert.rejects(
        createWatermarkedJpeg({ id: "p6", src: "" }),
        (error) => error instanceof MediaSaveError && error.kind === "empty"
    );
    assert.strictEqual(dom.calls.downloads.length, 0);
}));

// ---------------------------------------------------------------------------
// Watermark asset resolution
// ---------------------------------------------------------------------------

test("watermark: prefers the Cloudinary favicon and knocks out its white background",
    withDom({ remoteLogo: true }, async (t, dom) => {
        const mark = await getWatermarkMark();
        assert.strictEqual(mark.source, "cloudinary");
        assert.ok(mark.canvas && mark.canvas.width > 0);
        assert.ok(dom.calls.imageSrcs.some((src) => src.indexOf(SITE_LOGO_URL) === 0),
            "the favicon URL is requested");
        assert.ok(dom.calls.putImageData.length >= 1, "white background is removed");
        const pixels = dom.calls.putImageData[0].data;
        assert.strictEqual(pixels[7], 0, "white pixels become transparent");
        assert.strictEqual(pixels[3], 255, "brand pixels stay opaque");
    }));

test("watermark: uses the bundled local asset when the CDN blocks CORS",
    withDom({ remoteLogo: false, localLogo: true }, async (t, dom) => {
        const mark = await getWatermarkMark();
        assert.strictEqual(mark.source, "local");
        assert.ok(dom.calls.imageSrcs.some((src) => src.indexOf("assets/cashclique-watermark.svg") !== -1),
            "the local fallback asset is requested");
    }));

test("watermark: draws the mark itself when no asset can be loaded",
    withDom({ remoteLogo: false, localLogo: false }, async (t, dom) => {
        const mark = await getWatermarkMark();
        assert.strictEqual(mark.source, "drawn");
        assert.ok(mark.canvas && mark.canvas.width === 256, "a drawn badge is still a watermark");
    }));

test("watermark: the mark is cached across saves", withDom({ remoteLogo: true }, async (t, dom) => {
    const first = await getWatermarkMark();
    const second = await getWatermarkMark();
    assert.strictEqual(first, second);
    assert.strictEqual(dom.calls.imageSrcs.filter((src) => src.indexOf(SITE_LOGO_URL) === 0).length, 1);
}));

// ---------------------------------------------------------------------------
// Fetch chain / proxy
// ---------------------------------------------------------------------------

test("fetchMediaBlob: direct first, proxy second, error when both fail", withDom({}, async (t, dom) => {
    dom.fetchHandler = async () => {
        throw new TypeError("Failed to fetch");
    };

    await assert.rejects(
        fetchMediaBlob(STORAGE_URL, { filename: "cashclique_v1.mp4" }),
        (error) => error instanceof MediaSaveError && error.kind === "network" && !!error.userMessage
    );

    assert.strictEqual(dom.calls.fetch.length, 2);
    assert.strictEqual(dom.calls.fetch[0], STORAGE_URL);
    assert.strictEqual(dom.calls.fetch[1], buildProxyUrl(STORAGE_URL, "cashclique_v1.mp4"));
    assert.strictEqual(dom.calls.windowOpen.length, 0, "no tab is opened");
    assert.strictEqual(dom.calls.downloads.length, 0, "nothing is downloaded");
}));

test("fetchMediaBlob: a non-Storage URL is not sent to the proxy", withDom({}, async (t, dom) => {
    dom.fetchHandler = async () => fakeErrorResponse(500, "boom");

    await assert.rejects(
        fetchMediaBlob("https://cdn.example.com/clip.mp4"),
        (error) => error.kind === "network"
    );
    assert.strictEqual(dom.calls.fetch.length, 1);
    assert.strictEqual(isStorageDownloadUrl("https://cdn.example.com/clip.mp4"), false);
    assert.strictEqual(isStorageDownloadUrl(STORAGE_URL), true);
}));

test("fetchMediaBlob: the proxy result reports its content type", withDom({}, async (t, dom) => {
    dom.fetchHandler = async (url) => {
        if (url.indexOf(MEDIA_PROXY_URL) === 0) return fakeResponse(VIDEO_BYTES, { contentType: "video/mp4" });
        throw new TypeError("Failed to fetch");
    };

    const result = await fetchMediaBlob(STORAGE_URL);
    assert.strictEqual(result.viaProxy, true);
    assert.strictEqual(result.contentType, "video/mp4");
    assert.strictEqual(result.blob.size, VIDEO_BYTES.length);
}));

test("fetchMediaBlob: cancellation stops the chain", withDom({}, async (t, dom) => {
    await assert.rejects(
        fetchMediaBlob(STORAGE_URL, { isCancelled: () => true }),
        (error) => error.kind === "cancelled"
    );
    assert.strictEqual(dom.calls.fetch.length, 0);
}));

test("fetchMediaBlob: cancelling mid-download aborts the request", withDom({}, async (t, dom) => {
    let cancelled = false;
    dom.fetchHandler = (url, config) => new Promise((resolve, reject) => {
        const signal = config && config.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
        });
    });

    const pending = fetchMediaBlob(STORAGE_URL, { isCancelled: () => cancelled });
    await waitFor(() => dom.calls.fetch.length === 1);
    cancelled = true;

    await assert.rejects(
        pending,
        (error) => error instanceof MediaSaveError && error.kind === "cancelled"
    );
    assert.strictEqual(dom.calls.fetch.length, 1, "no proxy attempt after a cancel");
}));

test("downloadBlob: only ever uses a blob: URL and a safe filename", withDom({}, async (t, dom) => {
    const blob = new Blob([PHOTO_BYTES], { type: "image/jpeg" });
    downloadBlob(blob, 'cashclique_1"weird".jpg');

    assert.strictEqual(dom.calls.downloads.length, 1);
    assert.ok(dom.calls.downloads[0].href.indexOf("blob:") === 0, "anchor points at a blob: URL");
    assert.strictEqual(dom.calls.downloads[0].download, "cashclique_1_weird_.jpg");
    assert.strictEqual(dom.calls.windowOpen.length, 0);

    assert.throws(() => downloadBlob(new Blob([]), "empty.jpg"), (error) => error.kind === "empty");
    assert.strictEqual(dom.calls.downloads.length, 1, "an empty Blob downloads nothing");
}));

test("helpers: filenames and extensions", () => {
    assert.strictEqual(mediaFilename("abc123", "jpg"), "cashclique_abc123.jpg");
    assert.strictEqual(mediaFilename("../../x", "webm"), "cashclique_x.webm");
    assert.strictEqual(extensionForContentType("video/mp4", "webm"), "mp4");
    assert.strictEqual(extensionForContentType("video/webm;codecs=vp9", "mp4"), "webm");
    assert.strictEqual(extensionForContentType("", "mov"), "mov");
});

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

test("video: unsupported browsers get an error, never the raw file", withDom({ recorderSupported: false }, async (t, dom) => {
    dom.fetchHandler = async () => fakeResponse(VIDEO_BYTES, { contentType: "video/mp4" });

    assert.strictEqual(videoWatermarkSupported(), false);
    await assert.rejects(
        createWatermarkedVideo({ id: "v1", src: STORAGE_URL }),
        (error) => error instanceof MediaSaveError && error.kind === "unsupported" && !!error.userMessage
    );
    assert.strictEqual(dom.calls.fetch.length, 0, "we do not even fetch when we cannot watermark");
    assert.strictEqual(dom.calls.downloads.length, 0, "the unwatermarked source is never saved");
    assert.strictEqual(dom.calls.windowOpen.length, 0);
    assert.strictEqual(dom.calls.recorderStarts.length, 0);
}));

test("video: fetched bytes are re-recorded with the mark and returned as a Blob",
    withDom({ remoteLogo: true }, async (t, dom) => {
        dom.fetchHandler = async (url) => {
            if (url === STORAGE_URL) return fakeResponse(VIDEO_BYTES, { contentType: "video/mp4" });
            return fakeErrorResponse(404, "unexpected");
        };

        const stages = [];
        const result = await createWatermarkedVideo({
            id: "v2",
            src: STORAGE_URL,
            onStage: (stage) => stages.push(stage),
            onProgress: () => {}
        });

        assert.ok(result.blob instanceof Blob);
        assert.ok(result.blob.size > 0, "the recording has bytes");
        assert.strictEqual(result.extension, "webm");
        assert.strictEqual(result.filename, "cashclique_v2.webm");
        assert.strictEqual(result.sourceExtension, "mp4");
        assert.strictEqual(result.hadAudio, true, "audio track kept where possible");
        assert.deepStrictEqual(stages, ["download", "watermark"]);

        // Audio is routed through the graph, never to the speakers, and the
        // context is closed once the recording is done.
        assert.strictEqual(dom.calls.audioSources.length, 1, "soundtrack tapped from the video element");
        assert.strictEqual(dom.calls.audioConnections.length, 1, "one graph connection");
        assert.notStrictEqual(dom.calls.audioConnections[0], dom.audioContexts[0].destination,
            "the recording is silent to the user");
        assert.strictEqual(dom.audioContexts[0].closed, true, "audio context released");
        assert.strictEqual(dom.calls.audioSources[0].muted, false,
            "the element is unmuted so the graph receives audio");

        assert.strictEqual(dom.calls.fetch[0], STORAGE_URL, "direct URL first");
        assert.ok(dom.calls.videoSrcs[0].indexOf("blob:") === 0,
            "the video plays from an object URL, not from the Storage URL");
        assert.strictEqual(dom.calls.recorderStarts.length, 1);
        assert.ok(dom.calls.drawImage.some((source) => isFakeVideo(dom, source)), "frames drawn");
        assert.ok(dom.calls.drawImage.some((source) => isMark(dom, source)), "mark drawn on every frame");
        assert.ok(dom.calls.revokedUrls.length >= 1, "object URLs released");
        assert.strictEqual(dom.calls.downloads.length, 0);
        assert.strictEqual(dom.calls.windowOpen.length, 0);
    }));

test("video: keeps audio via the element capture stream when there is no AudioContext",
    withDom({ remoteLogo: true, audioContext: false }, async (t, dom) => {
        dom.fetchHandler = async () => fakeResponse(VIDEO_BYTES, { contentType: "video/mp4" });

        const result = await createWatermarkedVideo({ id: "v7", src: STORAGE_URL });

        assert.strictEqual(dom.audioContexts.length, 0, "this browser has no AudioContext");
        assert.strictEqual(result.hadAudio, true, "audio still captured from the element");
        assert.ok(result.blob.size > 0);
        assert.strictEqual(dom.calls.recorderStarts.length, 1);
        assert.strictEqual(dom.calls.downloads.length, 0);
    }));

test("video: the proxy is used when Storage blocks the direct fetch", withDom({ remoteLogo: true }, async (t, dom) => {
    dom.fetchHandler = async (url) => {
        if (url.indexOf(MEDIA_PROXY_URL) === 0) return fakeResponse(VIDEO_BYTES, { contentType: "video/mp4" });
        throw new TypeError("Failed to fetch");
    };

    const result = await createWatermarkedVideo({ id: "v3", src: STORAGE_URL });

    assert.strictEqual(dom.calls.fetch.length, 2);
    assert.ok(dom.calls.fetch[1].indexOf(MEDIA_PROXY_URL) === 0);
    assert.strictEqual(result.viaProxy, true);
    assert.ok(result.blob.size > 0);
}));

test("video: a recorder failure surfaces an error and never saves the source",
    withDom({ remoteLogo: true }, async (t, dom) => {
        dom.fetchHandler = async () => fakeResponse(VIDEO_BYTES, { contentType: "video/mp4" });

        const pending = createWatermarkedVideo({ id: "v4", src: STORAGE_URL });
        await waitFor(() => !!dom.currentRecorder && dom.currentRecorder.state === "recording");
        dom.currentRecorder.fail("encoder died");

        await assert.rejects(pending, (error) => error instanceof MediaSaveError && !!error.userMessage);
        assert.strictEqual(dom.calls.downloads.length, 0);
        assert.strictEqual(dom.calls.windowOpen.length, 0);
    }));

test("video: unreachable media raises a network error with no navigation", withDom({}, async (t, dom) => {
    dom.fetchHandler = async () => {
        throw new TypeError("Failed to fetch");
    };

    await assert.rejects(
        createWatermarkedVideo({ id: "v5", src: STORAGE_URL }),
        (error) => error instanceof MediaSaveError && error.kind === "network"
    );
    assert.strictEqual(dom.calls.fetch.length, 2, "direct + proxy");
    assert.strictEqual(dom.calls.videoSrcs.length, 0, "the video element is never pointed at Storage");
    assert.strictEqual(dom.calls.downloads.length, 0);
    assert.strictEqual(dom.calls.windowOpen.length, 0);
    assert.strictEqual(dom.calls.navigations.length, 0);
}));

test("video: cancelling mid-save stops before any download", withDom({ remoteLogo: true }, async (t, dom) => {
    dom.fetchHandler = async () => fakeResponse(VIDEO_BYTES, { contentType: "video/mp4" });
    let cancelled = false;

    const pending = createWatermarkedVideo({
        id: "v6",
        src: STORAGE_URL,
        isCancelled: () => cancelled
    });
    await waitFor(() => !!dom.currentRecorder && dom.currentRecorder.state === "recording");
    cancelled = true;

    await assert.rejects(pending, (error) => error.kind === "cancelled");
    assert.strictEqual(dom.calls.downloads.length, 0);
}));
