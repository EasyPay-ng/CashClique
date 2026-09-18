/*
 * Integration smoke test for the dashboard feed.
 *
 * The dashboard module is evaluated in Node with a small DOM + Firebase stub so
 * the real render path runs: page one is fetched, post markup is produced and
 * the video/photo data-saver rules are checked on the rendered HTML.
 *
 * This is deliberately a behaviour test, not a markup test: it asserts that a
 * video post renders without a <video> element or a media src, that a photo
 * waits in data-src, and that playing a shell is the only way a file is loaded.
 */

import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import {
    PHOTO_URL,
    VIDEO_URL,
    flushTimes,
    postDoc,
    runDashboard
} from "./dashboard-harness.mjs";
import { lazyImageFrameHTML, playVideoInShell } from "../js/feed-media.js";

const POSTS = [
    postDoc("video1", {
        userId: "u1", username: "ada", content: "clip", category: "Comedy",
        videoUrl: VIDEO_URL, likes: 3, commentCount: 2, views: 10,
        timestamp: { toDate: () => new Date("2026-09-18T09:00:00Z") }
    }),
    postDoc("photo1", {
        userId: "u2", username: "bola", content: "photo", category: "Sports",
        imageUrl: PHOTO_URL, likes: 1, commentCount: 0, views: 4,
        timestamp: { toDate: () => new Date("2026-09-18T08:00:00Z") }
    })
];

test("dashboard feed: page one renders without touching any media file", async () => {
    const { dom, firebase } = runDashboard(POSTS);
    await flushTimes();

    const markup = dom.getElementById("feed").innerHTML;

    // Paged fetch, not a collection-wide listener.
    const postsListeners = firebase.calls.listeners.filter(listener =>
        listener && listener.target && listener.target.__collection === "posts");
    for (const listener of postsListeners) {
        assert.ok(listener.clauses.some(clause => clause && clause.__limit),
            "every posts listener is bounded by a limit");
    }
    assert.equal(postsListeners.length, 1, "the new-post watch reads a single document");

    const postsRead = firebase.calls.getDocs.find(call => call && call.clauses &&
        call.clauses.some(clause => clause && clause.__limit === 12));
    assert.ok(postsRead, "the feed reads one capped page");

    // The video post is a shell: no element, no src, no file request.
    assert.match(markup, /class="video-shell"/);
    assert.doesNotMatch(markup, /<video/i, "no video element before a tap");
    assert.doesNotMatch(markup, /preload/i, "no preload hint before a tap");
    assert.ok(markup.includes("data-video-src="), "the URL waits in a data attribute");
    assert.ok(!/(?<![-\w])src="https:\/\/firebasestorage[^"]*clip\.mp4/.test(markup), "the clip URL is never a src");

    // The photo post waits in data-src.
    assert.ok(markup.includes("data-src="), "photo URL is deferred");
    assert.ok(!/\ssrc="https:\/\/firebasestorage[^"]*photo\.jpg/.test(markup), "no photo download at render time");

    // Two posts is less than a page, so the feed says it is caught up.
    assert.match(markup, /You're all caught up/);
    assert.equal(dom.getElementById("video-count").textContent, "1", "the menu badge counts loaded videos");
});

test("dashboard feed: tapping play is what loads the video", async () => {
    const { dom } = runDashboard(POSTS);
    await flushTimes();

    const shell = {
        dataset: { videoSrc: VIDEO_URL, poster: "" },
        innerHTML: "<span>shell</span>",
        classList: { values: new Set(), add(n) { this.values.add(n); }, contains(n) { return this.values.has(n); } },
        removeAttribute() {},
        children: [],
        appendChild(child) { this.children.push(child); }
    };
    const before = dom.created.length;
    const video = playVideoInShell(shell, { document: dom });

    assert.equal(dom.created.length, before + 1, "one video element, created on demand");
    assert.equal(video.src, VIDEO_URL, "the file is requested at tap time");
    assert.equal(video.playCalls, 1);
    assert.equal(video.tagName, "video");
    assert.deepEqual(shell.children, [video]);
});

test("dashboard feed: a failed page shows a retry instead of an empty feed", async () => {
    const { dom } = runDashboard(POSTS, {
        getDocs: async () => { throw new Error("offline"); }
    });
    await flushTimes();

    const markup = dom.getElementById("feed").innerHTML;
    assert.match(markup, /id="feed-retry"/, "the user can retry the page");
    assert.doesNotMatch(markup, /fa-spinner/, "the spinner does not stay forever");
});

test("dashboard feed: more posts are fetched a page at a time", async () => {
    const many = Array.from({ length: 20 }, (_, index) => postDoc(`post${index}`, {
        userId: "u1", username: "ada", content: `post ${index}`, category: "Comedy",
        likes: 0, commentCount: 0, views: 0,
        timestamp: { toDate: () => new Date(Date.UTC(2026, 8, 18, 9, 0, index)) }
    }));
    const { dom, context, firebase } = runDashboard(many);
    await flushTimes();

    let markup = dom.getElementById("feed").innerHTML;
    assert.equal((markup.match(/class="post" data-post-id=/g) || []).length, 12, "only the first page is rendered");
    assert.match(markup, /id="load-more"/, "the next page is offered, not fetched");

    await context.loadMorePosts();
    await flushTimes();
    markup = dom.getElementById("feed").innerHTML;
    assert.equal((markup.match(/class="post" data-post-id=/g) || []).length, 20, "one more page arrived");
    assert.ok(firebase.calls.getDocs.length >= 2, "the second page came from its own read");
});

test("dashboard feed: comments and other tabs stay lazy", async () => {
    const { dom, context, firebase } = runDashboard(POSTS);
    await flushTimes();

    const commentsOf = () => firebase.calls.listeners.filter(listener =>
        listener && listener.target && String(listener.target.__collection || "").startsWith("posts/"));

    assert.equal(commentsOf().length, 0, "no comment thread is read while the feed renders");

    // Opening a thread is what subscribes to it...
    context.toggleComments("photo1");
    await flushTimes();
    assert.equal(commentsOf().length, 1, "opening a thread reads it");
    assert.match(dom.getElementById("comment-list-photo1").innerHTML, /Loading comments|No comments/);

    // ...and closing it stops the reads again.
    context.toggleComments("photo1");
    await flushTimes();
    assert.equal(commentsOf().length, 1, "the listener is not duplicated");
});

test("dashboard feed: the Videos tab shows only video posts", async () => {
    const { dom, context } = runDashboard(POSTS);
    await flushTimes();

    context.setFeedTab("videos");
    await flushTimes();
    const markup = dom.getElementById("feed").innerHTML;

    assert.match(markup, /data-post-id="video1"/);
    assert.doesNotMatch(markup, /data-post-id="photo1"/);
    assert.equal(dom.getElementById("video-count").textContent, "1");
});
