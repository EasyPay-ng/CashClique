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

test("dashboard feed: ranking, not the clock, orders the For You feed", async () => {
    const minutes = 60 * 1000;
    const fixture = [
        postDoc("fresh-empty", {
            userId: "u9", username: "newbie", content: "my very first post",
            category: "Comedy", likes: 0, commentCount: 0, views: 0,
            timestamp: { toDate: () => new Date(Date.now() - 2 * minutes) }
        }),
        postDoc("old-banger", {
            userId: "u8", username: "veteran", content: "the clip everyone kept watching",
            category: "Comedy", videoUrl: VIDEO_URL, likes: 4200, commentCount: 310, views: 90000,
            timestamp: { toDate: () => new Date(Date.now() - 20 * 24 * 60 * minutes) }
        }),
        postDoc("steady", {
            userId: "u7", username: "steady", content: "yesterday's photo",
            category: "Sports", imageUrl: PHOTO_URL, likes: 40, commentCount: 3, views: 120,
            timestamp: { toDate: () => new Date(Date.now() - 26 * 60 * minutes) }
        })
    ];

    const { dom } = runDashboard(fixture, { sessionStorage: { getItem: () => "salty", setItem() {}, removeItem() {} } });
    await flushTimes(12);

    const order = Array.from(dom.getElementById("feed").innerHTML
        .matchAll(/class="post" data-post-id="([^"]+)"/g)).map(match => match[1]);

    assert.deepEqual(order.slice().sort(), ["fresh-empty", "old-banger", "steady"], "every post is rendered once");
    assert.ok(order.indexOf("old-banger") < order.indexOf("fresh-empty"),
        `the popular video from three weeks ago should outrank an empty brand-new post, got: ${order}`);
    assert.ok(order.indexOf("old-banger") < order.indexOf("steady"), "it outranks a quiet photo too");

    // The user can see why an older post is up there.
    assert.match(dom.getElementById("feed").innerHTML, /post-age-tag[^>]*>throwback/,
        "older posts in the mix are labelled");
});

test("dashboard feed: every post has a share button", async () => {
    const { dom } = runDashboard(POSTS);
    await flushTimes();
    const markup = dom.getElementById("feed").innerHTML;
    assert.match(markup, /class="action-item share-post"/);
    assert.equal((markup.match(/share-post/g) || []).length, POSTS.length);
});

test("dashboard feed: video posts can be reposted and undone without duplicating the media", async () => {
    const { dom, context, firebase } = runDashboard(POSTS);
    await flushTimes();

    let markup = dom.getElementById("feed").innerHTML;
    assert.match(markup, /class="action-item repost-post"/);
    assert.match(markup, /class="action-item report-post"/);

    await context.toggleRepost("video1");
    await flushTimes(12);
    assert.ok(firebase.stores.userReposts.has("video1"), "the account stores one repost relationship per source post");
    assert.ok(firebase.stores.postData.has("repost_me_video1"), "the feed stores a lightweight repost entry");
    const repost = firebase.stores.postData.get("repost_me_video1");
    assert.equal(repost.postType, "repost");
    assert.equal(repost.originalPostId, "video1");
    assert.equal(repost.videoUrl, undefined, "the large video URL is not copied into the repost document");
    markup = dom.getElementById("feed").innerHTML;
    assert.match(markup, /You<\/div>|You reposted/, "the repost is attributed to the member");

    await context.toggleRepost("video1");
    await flushTimes();
    assert.equal(firebase.stores.userReposts.has("video1"), false, "the repost can be undone");
    assert.equal(firebase.stores.postData.has("repost_me_video1"), false, "undo removes the lightweight feed entry");
});

test("dashboard feed: playing a video saves it to the signed-in member's watch history", async () => {
    const { dom, context, firebase } = runDashboard(POSTS);
    await flushTimes();
    assert.equal(firebase.calls.setDoc.length, 0, "idle feed videos are not recorded");

    const shell = {
        dataset: { videoSrc: VIDEO_URL, videoPostId: "video1", poster: "" },
        innerHTML: "<span>shell</span>",
        classList: { values: new Set(), add(name) { this.values.add(name); }, contains(name) { return this.values.has(name); } },
        removeAttribute() {},
        children: [],
        appendChild(child) { this.children.push(child); }
    };
    context.playFeedVideo(shell);
    await flushTimes();

    const historyWrite = firebase.calls.setDoc.find(call => call.path === "users/me/watchHistory/video1");
    assert.ok(historyWrite, "the play records history under the current user's account");
    assert.equal(historyWrite.value.postId, "video1");
    assert.ok(historyWrite.value.watchedAt, "the last-played time is saved");

    context.setFeedTab("history");
    await flushTimes(12);
    const markup = dom.getElementById("feed").innerHTML;
    assert.match(markup, /Watch history/);
    assert.match(markup, /Watched /, "history cards show when the viewer last played the clip");
    assert.match(markup, /data-post-id="video1"/);
    assert.doesNotMatch(markup, /data-post-id="photo1"/, "only watched videos appear");
});

test("dashboard feed: a member can report a post with a moderation reason", async () => {
    const { dom, context, firebase } = runDashboard(POSTS);
    await flushTimes();
    context.openReportModal("video1");
    dom.getElementById("report-reason").value = "sexual_content";
    dom.getElementById("report-details").value = "Explicit material in this clip";
    await context.submitPostReport();
    await flushTimes();

    const reportWrite = firebase.calls.setDoc.find(call => call.path === "postReports/video1_me");
    assert.ok(reportWrite, "the report is stored in the moderation queue");
    assert.equal(reportWrite.value.reason, "sexual_content");
    assert.equal(reportWrite.value.contentType, "video");
    assert.equal(reportWrite.value.status, "pending");
    assert.equal(reportWrite.value.details, "Explicit material in this clip");
});

test("dashboard feed: a video ad autoplays instead of waiting for a tap", async () => {
    const { context } = runDashboard(POSTS);
    await flushTimes();
    const markup = context.postHTML({
        id: "video1",
        userId: "u1",
        username: "ada",
        content: "clip",
        mediaKind: "video",
        videoUrl: VIDEO_URL,
        likedBy: [],
        likes: 0,
        commentCount: 0,
        views: 0,
        hasViewed: true,
        userAvatar: "",
        timestamp: { toDate: () => new Date("2026-09-18T09:00:00Z") }
    }, {
        id: "ad1",
        title: "JOIN GRIPPDACASH",
        description: "Earn by playing games, task, etc",
        mediaType: "video",
        videoUrl: VIDEO_URL,
        flyer: "",
        targetUrl: "https://grippdacash.example"
    });
    assert.match(markup, /SPONSORED/);
    assert.match(markup, /JOIN GRIPPDACASH/);
    assert.match(markup, /<video/i);
    assert.match(markup, /autoplay/);
    assert.match(markup, /muted/);
    assert.match(markup, /ad-autoplay/);
    assert.doesNotMatch(markup, /Tap to play video ad/);
    assert.match(markup, /class="ad-cta"/);
});

test("dashboard feed: Discover has trending, recommended, explore and creators", async () => {
    const { dom, context } = runDashboard(POSTS);
    await flushTimes();

    context.setFeedTab("discover");
    await flushTimes();
    assert.ok(dom.getElementById("discover-pills").classList.contains("show"));
    let markup = dom.getElementById("feed").innerHTML;
    assert.match(markup, /data-post-id="video1"/);

    context.setDiscoverMode("creators");
    await flushTimes();
    markup = dom.getElementById("feed").innerHTML;
    assert.match(markup, /class="creator-grid"/);
    assert.match(markup, /data-creator-id="u1"/);
    assert.doesNotMatch(markup, /data-post-id=/, "creators mode shows people, not the post feed");
});
