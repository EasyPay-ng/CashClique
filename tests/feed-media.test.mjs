/*
 * Data-saver guarantees for feed media (js/feed-media.js).
 *
 * The feed has to be cheap on mobile data:
 *   - a video post renders as a poster shell — no <video>, no src, no preload,
 *     so nothing is downloaded until the viewer taps play,
 *   - a photo post keeps its URL in data-src until it scrolls into view,
 *   - an uploaded photo URL (imageUrl) wins over an embedded base64 copy.
 */

import test from "node:test";
import assert from "node:assert";

import {
    escapeAttribute,
    lazyImageFrameHTML,
    playVideoInShell,
    postImageSrc,
    postMediaKind,
    videoShellHTML
} from "../js/feed-media.js";

const VIDEO_URL =
    "https://firebasestorage.googleapis.com/v0/b/cashclique-31718.firebasestorage.app" +
    "/o/videos%2Fu1%2Fclip.mp4?alt=media&token=1f9c5f2a";
const PHOTO_URL =
    "https://firebasestorage.googleapis.com/v0/b/cashclique-31718.firebasestorage.app" +
    "/o/images%2Fu1%2Fphoto.jpg?alt=media&token=1f9c5f2a";
const DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD";
const RAW_BASE64 = "9j/4AAQSkZJRgABAQAAAQABAAD";

/** Minimal element double: enough for playVideoInShell(). */
function fakeShell(dataset = {}) {
    return {
        dataset: Object.assign({}, dataset),
        innerHTML: "<span>shell</span>",
        children: [],
        removedAttributes: [],
        classList: {
            values: new Set(),
            add(name) { this.values.add(name); },
            contains(name) { return this.values.has(name); }
        },
        removeAttribute(name) { this.removedAttributes.push(name); },
        appendChild(child) { this.children.push(child); }
    };
}

function fakeDocument() {
    return {
        created: [],
        createElement(tag) {
            const element = {
                tag,
                attributes: {},
                playCalls: 0,
                setAttribute(key, value) { this.attributes[key] = value; },
                play() { this.playCalls += 1; return { catch() {} }; }
            };
            this.created.push(element);
            return element;
        }
    };
}

test("feed media: a video renders as a poster shell, never as a request", () => {
    const shell = videoShellHTML({ videoUrl: VIDEO_URL, poster: PHOTO_URL });

    assert.doesNotMatch(shell, /<video/i, "no <video> element is rendered up front");
    assert.doesNotMatch(shell, /\ssrc="/i, "no src attribute is rendered up front");
    assert.doesNotMatch(shell, /preload/i, "no preload hint is rendered");
    assert.match(shell, /class="video-shell"/);
    assert.ok(shell.includes(`data-video-src="${escapeAttribute(VIDEO_URL)}"`),
        "the file URL waits in a data attribute");
    assert.ok(shell.includes(`data-poster="${escapeAttribute(PHOTO_URL)}"`),
        "an optional poster also waits in a data attribute");
});

test("feed media: only a tap downloads and plays the video", () => {
    const shell = fakeShell({ videoSrc: VIDEO_URL, poster: "" });
    const documentRef = fakeDocument();

    assert.equal(documentRef.created.length, 0, "an idle shell creates nothing");
    const video = playVideoInShell(shell, { document: documentRef });

    assert.equal(documentRef.created.length, 1);
    assert.equal(video.tag, "video");
    assert.equal(video.src, VIDEO_URL, "the src is assigned at play time only");
    assert.equal(video.controls, true);
    assert.equal(video.preload, "metadata");
    assert.equal(video.attributes.playsinline, "");
    assert.equal(video.playCalls, 1);
    assert.ok(shell.classList.contains("playing"));
    assert.deepEqual(shell.children, [video]);
    assert.ok(shell.removedAttributes.includes("tabindex"));

    // A second tap must not start a second download.
    assert.equal(playVideoInShell(shell, { document: documentRef }), null);
    assert.equal(documentRef.created.length, 1);
});

test("feed media: a shell without a source never builds a player", () => {
    const documentRef = fakeDocument();
    assert.equal(playVideoInShell(fakeShell({}), { document: documentRef }), null);
    assert.equal(playVideoInShell(null, { document: documentRef }), null);
    assert.equal(documentRef.created.length, 0);
});

test("feed media: photos keep their URL in data-src", () => {
    const frame = lazyImageFrameHTML(DATA_URL);
    assert.doesNotMatch(frame, /\ssrc="/i, "no src attribute is rendered up front");
    assert.ok(frame.includes(`data-src="${escapeAttribute(DATA_URL)}"`));
    assert.match(frame, /data-lazy-media="1"/);
    assert.match(frame, /loading="lazy"/);

    const poster = lazyImageFrameHTML(PHOTO_URL, "16/9");
    assert.ok(poster.includes('style="aspect-ratio:16/9;"'), "fixed ratio avoids layout jumps");
    assert.equal(lazyImageFrameHTML(""), "");
});

test("feed media: kind and source resolution", () => {
    assert.equal(postMediaKind({ videoUrl: VIDEO_URL, imageUrl: PHOTO_URL }), "video");
    assert.equal(postMediaKind({ imageUrl: PHOTO_URL }), "image");
    assert.equal(postMediaKind({ imageBase64: RAW_BASE64 }), "image");
    assert.equal(postMediaKind({ content: "text only" }), "text");
    assert.equal(postMediaKind({ videoUrl: "   " }), "text");

    assert.equal(postImageSrc({ imageUrl: PHOTO_URL, imageBase64: DATA_URL }), PHOTO_URL,
        "an uploaded URL wins over an embedded copy");
    assert.equal(postImageSrc({ imageBase64: DATA_URL }), DATA_URL);
    assert.equal(postImageSrc({ imageBase64: RAW_BASE64 }), `data:image/jpeg;base64,${RAW_BASE64}`);
    assert.equal(postImageSrc({}), "");
});

test("feed media: attribute escaping keeps markup safe", () => {
    assert.equal(escapeAttribute('a"b&c<d>'), "a&quot;b&amp;c&lt;d&gt;");
    assert.equal(escapeAttribute(null), "");
});
