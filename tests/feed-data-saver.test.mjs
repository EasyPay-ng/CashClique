/*
 * Page-level guard rails for the data-saver feed.
 *
 * These assertions describe the behaviour the dashboard is expected to keep:
 * a paged feed, no video element before a tap, comments read on demand, and a
 * side menu that is the same everywhere. They complement the module tests in
 * feed-media.test.mjs.
 */

import test from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("dashboard: the feed is paged instead of streaming the whole collection", () => {
    const source = read("dashboard.html");

    assert.match(source, /limit\(FEED_PAGE_SIZE\)/, "the first page is capped");
    assert.match(source, /startAfter\(feedCursor\)/, "more posts continue from the cursor");
    assert.doesNotMatch(source, /onSnapshot\(postsQuery/, "no live listener over every post");
    assert.doesNotMatch(source, /collection\(db, "posts"\), orderBy\("timestamp", "desc"\)\)/,
        "an unbounded posts query is gone");

    // Every secondary read is capped too.
    assert.match(source, /limit\(COMMENTS_PAGE_SIZE\)/);
    assert.match(source, /limit\(NOTIFICATIONS_LIMIT\)/);
    assert.match(source, /limit\(SUPPORT_MESSAGES_LIMIT\)/);
    assert.match(source, /limit\(1\)/, "the new-post watch reads a single document");
});

test("dashboard: no video is downloaded before the viewer taps play", () => {
    const source = read("dashboard.html");

    assert.doesNotMatch(source, /<video[^>]*\ssrc=/i, "nothing renders a video with a src");
    assert.doesNotMatch(source, /preload="metadata"/, "preload is set by the player helper, not markup");
    assert.doesNotMatch(source, /videos\.html/, "the link to the missing videos.html page is gone");
    assert.match(source, /playVideoInShell\(/, "playback goes through the shared helper");
    assert.match(source, /videoShellHTML\(/, "video posts use the poster shell");
    assert.match(source, /lazyImageFrameHTML\(/, "photos use the lazy frame");
});

test("dashboard: comments are read only while a thread is open", () => {
    const source = read("dashboard.html");

    assert.doesNotMatch(source, /function loadComments\(/, "the eager per-post subscriber is gone");
    assert.match(source, /function openComments\(postId\)/);
    assert.match(source, /function closeComments\(postId\)/);
    assert.match(source, /function rewindComments\(\)/);

    const toggleStart = source.indexOf("window.toggleComments");
    assert.ok(toggleStart > 0, "the comment toggle exists");
    const toggle = source.slice(toggleStart, toggleStart + 400);
    assert.match(toggle, /openComments\(id\)/, "opening a thread loads it");
    assert.match(toggle, /closeComments\(id\)/, "closing a thread stops reading");
});

test("dashboard: views are counted only for posts actually on screen", () => {
    const source = read("dashboard.html");

    assert.match(source, /IntersectionObserver/);
    assert.match(source, /VIEW_DWELL_MS/);
    assert.doesNotMatch(source, /if \(!post\.hasViewed\) trackView\(postId\);/,
        "rendering a post no longer counts a view");
});

test("post.html: new photos go to Storage so post documents stay small", () => {
    const source = read("post.html");

    assert.match(source, /await uploadPostImage\(selectedImageBase64\)/, "the photo is uploaded");
    assert.match(source, /images\/\$\{currentUser\.uid\}\//, "uploads land under the user's folder");
    assert.match(source, /imageUrl: imageUrl/, "the document stores the URL");
    assert.match(source, /imageBase64: imageBase64/, "base64 stays as the offline fallback");
});

test("readers understand the uploaded photo URL", () => {
    // The dashboard resolves photo sources through the shared module.
    assert.match(read("dashboard.html"), /from "\.\/js\/feed-media\.js"/);
    assert.match(read("js/feed-media.js"), /data\.imageUrl \|\| data\.imageBase64 \|\| data\.image/);
    for (const page of ["post-view.html", "my-content.html", "profile.html"]) {
        assert.match(read(page), /imageUrl/, `${page} reads imageUrl`);
    }
});

test("thumbnails on the profile and my-content grids download no video", () => {
    for (const page of ["my-content.html", "profile.html"]) {
        assert.doesNotMatch(read(page), /<video[^>]*\ssrc=/i, `${page} has no <video src>`);
    }
});

test("side menu: every page offers the same entries", () => {
    const pages = [
        "dashboard.html",
        "my-content.html",
        "earnings.html",
        "opportunities.html",
        "settings.html",
        "post.html",
        "boost.html"
    ];
    const entries = [
        'href="dashboard.html"',
        'href="dashboard.html?feed=videos"',
        'href="dashboard.html?feed=following"',
        'href="my-content.html"',
        'href="earnings.html"',
        'href="opportunities.html"',
        'href="boost.html"',
        'href="post.html"',
        'href="profile.html"',
        'href="settings.html"'
    ];

    for (const page of pages) {
        const source = read(page);
        const sidebar = source.slice(source.indexOf('class="sidebar"'));
        for (const entry of entries) {
            assert.ok(sidebar.includes(entry), `${page}: side menu is missing ${entry}`);
        }
        assert.match(sidebar, /id="(logout|logoutBtn|sidebar-logout)"/, `${page}: side menu keeps a logout action`);
    }
});
