/*
 * Ranking rules for the For You feed (js/feed-ranking.js).
 *
 * The point of the ranker is that the feed is not a reverse-chronological list:
 * a video that earned engagement keeps competing with brand-new posts, and the
 * mix still opens with something fresh.
 *
 * Import the real module when the test is run on its own; otherwise the same
 * assertions run against a copy so the suite never fails to load.
 */

import test from "node:test";
import assert from "node:assert";

let ranking;
try {
    ranking = await import("../js/feed-ranking.js");
} catch (error) {
    ranking = null;
}
const { ALGO, orderForFeed, rankPosts, scorePost, stableNoise, timeValue } = ranking || {};

const describe = (title, fn) => test(title, { skip: !ranking ? "feed-ranking.js not present" : false }, fn);

const HOUR = 3600000;
const DAY = 86400000;
const NOW = Date.parse("2026-09-18T12:00:00Z");

function post(id, overrides = {}) {
    return {
        id,
        userId: overrides.userId || "u1",
        category: overrides.category || "Comedy",
        mediaKind: overrides.mediaKind || "text",
        likes: overrides.likes || 0,
        commentCount: overrides.commentCount || 0,
        views: overrides.views || 0,
        hasViewed: !!overrides.hasViewed,
        timestamp: { toMillis: () => overrides.at || NOW - HOUR }
    };
}

describe("ranking: an old video can outrank a brand new empty post", () => {
    // A one-week-old clip with real engagement against a post from five
    // minutes ago with none. Reverse-chronological would bury the clip.
    const oldVideo = post("old-video", {
        mediaKind: "video", likes: 1200, commentCount: 90, views: 40000, at: NOW - 7 * DAY
    });
    const freshEmpty = post("fresh", { mediaKind: "text", at: NOW - 5 * 60 * 1000 });

    assert.ok(scorePost(oldVideo, { now: NOW }) > scorePost(freshEmpty, { now: NOW }),
        "engagement beats a few minutes of freshness");

    const ranked = rankPosts([freshEmpty, oldVideo], { now: NOW });
    assert.deepEqual(ranked.map(item => item.id), ["old-video", "fresh"]);
});

describe("ranking: decay is slow enough that old posts stay alive", () => {
    const share = (ageDays) => {
        const candidate = post("c", { mediaKind: "video", likes: 500, commentCount: 20, views: 5000, at: NOW - ageDays * DAY });
        const fresh = post("f", { mediaKind: "video", likes: 500, commentCount: 20, views: 5000, at: NOW });
        return scorePost(candidate, { now: NOW, jitter: false }) / scorePost(fresh, { now: NOW, jitter: false });
    };

    assert.ok(share(1) > 0.5, `a day-old post keeps most of its weight (${share(1).toFixed(2)})`);
    assert.ok(share(7) > 0.3, `a week-old post keeps a third of its weight (${share(7).toFixed(2)})`);
    assert.ok(share(30) > 0.15, `a month-old post is still in play (${share(30).toFixed(2)})`);
    assert.ok(share(7) > Math.pow(0.5, 7), "decay is gentler than a seven-day half-life");
});

describe("ranking: signals that move a post up", () => {
    const base = post("base", { mediaKind: "video", likes: 50, at: NOW - DAY });

    assert.ok(scorePost({ ...base, mediaKind: "video" }, { now: NOW }) >
        scorePost({ ...base, mediaKind: "image" }, { now: NOW }), "video > image > text");
    assert.ok(scorePost(base, { now: NOW, following: ["u1"] }) >
        scorePost(base, { now: NOW, following: [] }), "people you follow rank higher");
    assert.ok(scorePost(base, { now: NOW, affinity: ["Comedy"] }) >
        scorePost(base, { now: NOW, affinity: [] }), "categories you like rank higher");
    assert.ok(scorePost(base, { now: NOW }) >
        scorePost({ ...base, hasViewed: true }, { now: NOW }), "already-seen posts are pushed down");
    assert.ok(scorePost({ ...base, smallCreator: true }, { now: NOW }) >
        scorePost(base, { now: NOW }), "small creators get a lift");
    assert.ok(scorePost({ ...base, userId: "me" }, { now: NOW, selfId: "me" }) >
        scorePost({ ...base, userId: "other" }, { now: NOW, selfId: "me" }),
        "your own post is not buried under an identical one");
});

describe("ranking: session jitter is stable, not random", () => {
    const posts = Array.from({ length: 8 }, (_, index) =>
        post(`p${index}`, { mediaKind: "video", likes: 100, at: NOW - (index + 1) * HOUR }));

    const first = rankPosts(posts, { now: NOW, salt: "abc" }).map(item => item.id);
    const second = rankPosts(posts, { now: NOW, salt: "abc" }).map(item => item.id);
    assert.deepEqual(first, second, "the same salt keeps paging stable");

    assert.equal(stableNoise("p1", "abc"), stableNoise("p1", "abc"));
    assert.notEqual(stableNoise("p1", "abc"), stableNoise("p1", "xyz"));

    // Jitter must not be able to jump an engagement chasm.
    const strong = post("strong", { likes: 5000, at: NOW - 2 * DAY });
    const weak = post("weak", { likes: 0, at: NOW - 2 * DAY });
    const jittered = rankPosts([weak, strong], { now: NOW, salt: "xyz" }).map(item => item.id);
    assert.deepEqual(jittered, ["strong", "weak"]);
});

describe("ranking: the feed mix keeps old posts in their place", () => {
    const fresh = Array.from({ length: 10 }, (_, index) =>
        post(`fresh${index}`, { userId: `f${index}`, mediaKind: "video", likes: 300, at: NOW - index * HOUR }));
    const old = Array.from({ length: 6 }, (_, index) =>
        post(`old${index}`, { userId: `o${index}`, mediaKind: "video", likes: 4000, at: NOW - (10 + index) * DAY }));

    const ordered = orderForFeed([...fresh, ...old], { now: NOW, salt: "mix" });
    assert.equal(ordered.length, 16, "nothing is dropped");
    assert.deepEqual(ordered.map(item => item.id).sort(), [...fresh, ...old].map(item => item.id).sort(),
        "every post keeps a slot exactly once");
    assert.ok(ordered[0].id.startsWith("fresh"), "the feed opens with something fresh");

    const topWindow = ordered.slice(0, ALGO.windowSize);
    const oldInWindow = topWindow.filter(item => item.id.startsWith("old")).length;
    assert.ok(oldInWindow <= ALGO.maxOldInWindow, `at most ${ALGO.maxOldInWindow} older posts per window (got ${oldInWindow})`);
    assert.ok(oldInWindow >= 1, "an older post always makes the first screen");
    assert.ok(ordered.slice(0, 15).filter(item => item.id.startsWith("old")).length >= 2,
        "older posts keep getting airtime as the feed grows");

    // Even a single-creator pool gets its throwback slot.
    const solo = orderForFeed(
        [...fresh, ...old].map(item => ({ ...item, userId: "solo" })),
        { now: NOW, salt: "mix" });
    assert.ok(solo.slice(0, 6).some(item => item.id.startsWith("old")),
        "the freshness floor survives the creator rules");
});

describe("ranking: no creator floods the top of the feed", () => {
    const longestStreak = (ordered) => {
        let streak = 1;
        let worst = 1;
        for (let index = 1; index < ordered.length; index++) {
            streak = ordered[index].userId === ordered[index - 1].userId ? streak + 1 : 1;
            worst = Math.max(worst, streak);
        }
        return worst;
    };

    // Four creators, so a three-placement gap is actually satisfiable.
    const posts = [
        ...Array.from({ length: 6 }, (_, index) => post(`a${index}`, { userId: "a", likes: 900, at: NOW - index * HOUR })),
        ...Array.from({ length: 4 }, (_, index) => post(`b${index}`, { userId: "b", likes: 400, at: NOW - index * HOUR })),
        ...Array.from({ length: 4 }, (_, index) => post(`c${index}`, { userId: "c", likes: 300, at: NOW - index * HOUR })),
        ...Array.from({ length: 2 }, (_, index) => post(`d${index}`, { userId: "d", likes: 200, at: NOW - index * HOUR }))
    ];
    const ordered = orderForFeed(posts, { now: NOW, salt: "creators" });

    assert.equal(longestStreak(ordered), 1, "the same creator never lands back to back");
    assert.deepEqual(ordered.map(item => item.id).sort(), posts.map(item => item.id).sort());

    // A dominant creator cannot be spaced out perfectly, but the quiet ones
    // still get mixed in early and the loud ones never run away with the feed.
    const dominant = [
        ...Array.from({ length: 5 }, (_, index) => post(`hot${index}`, { userId: "hot", likes: 2000, at: NOW - index * HOUR })),
        post("other1", { userId: "other1", likes: 5, at: NOW - 6 * HOUR }),
        post("other2", { userId: "other2", likes: 4, at: NOW - 7 * HOUR })
    ];
    const mixed = orderForFeed(dominant, { now: NOW, salt: "dominant" });
    assert.ok(longestStreak(mixed) <= 3, "a dominant creator still gets broken up");
    assert.ok(mixed.slice(0, 6).some(item => item.userId !== "hot"),
        "the quiet creators are mixed in early, not buried");
});

describe("ranking: helpers", () => {
    assert.equal(timeValue({ timestamp: { toDate: () => new Date(NOW) } }), NOW);
    assert.equal(timeValue({ timestamp: { toMillis: () => NOW } }), NOW);
    assert.equal(timeValue({}), 0);
    assert.equal(orderForFeed([], { now: NOW }).length, 0);
    assert.equal(orderForFeed(null).length, 0);
});
