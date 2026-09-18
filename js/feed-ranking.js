/*
 * Feed ranking (the "For You" order).
 *
 * Pure `orderBy("timestamp", "desc")` buries everything that is not brand new,
 * so a good video from last week never gets a second chance. This module scores
 * a pool of candidate posts instead:
 *
 *   score = (engagement floor + likes/comments/views) x time decay
 *           x media boost x follow boost x category affinity x creator lift
 *           x seen penalty x stable jitter
 *
 * The decay is a gentle power law rather than an exponential half-life: old
 * posts keep a meaningful share of their weight, so a well-liked video from a
 * while back can outrank a brand-new post with no engagement — while the
 * seen penalty and the freshness mix keep the top of the feed from turning
 * into the same evergreen posts on every visit.
 *
 * Everything here is dependency-free and deterministic for a given salt, which
 * keeps paging stable while still shuffling between sessions.
 */

export const ALGO = {
    /** Weight of the engagement components. */
    weights: { likes: 1.2, comments: 1.6, views: 0.5 },
    /** Every post starts with this much weight so quality has to win it. */
    engagementFloor: 0.4,
    /** freshness = (ageHours + 2) ^ -decayRate */
    decayRate: 0.25,
    boosts: {
        video: 1.2,          // videos are what the feed is for
        image: 1.06,
        following: 1.35,     // people you follow
        own: 1.45,           // your own posts: seeing them land matters
        affinity: 1.08,      // categories you keep liking
        smallCreator: 1.12,  // creators with few posts in the pool (max posts: 2)
        highEngagement: 1.25 // posts with high likes, views or comments pushed more on FYP
    },
    seenPenalty: 0.55,       // already viewed: push down, never drop
    jitter: 0.16,            // +/- 8% stable shuffle per session salt
    interactedJitter: 0.32,  // enhanced shuffle when user previously interacted
    /** Freshness mix: older posts get a floor and a ceiling in the feed. */
    windowSize: 10,
    maxOldInWindow: 4,
    minOldShare: 0.2,        // at least one older post in every five placements
    oldAfterDays: 7,
    creatorGap: 3,           // preferred distance between two posts by one creator
    gapPrice: 0.75           // how much score is worth paying for that variety
};

export function timeValue(post) {
    const stamp = post && post.timestamp;
    if (!stamp) return 0;
    if (typeof stamp.toMillis === "function") return stamp.toMillis();
    if (typeof stamp.toDate === "function") return stamp.toDate().getTime();
    if (typeof stamp === "number") return stamp;
    if (stamp instanceof Date) return stamp.getTime();
    const parsed = Date.parse(stamp);
    return Number.isNaN(parsed) ? 0 : parsed;
}

/** Deterministic 0..1 hash of a post id + session salt. */
export function stableNoise(id, salt = "") {
    const input = `${id}:${salt}`;
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) % 100000) / 100000;
}

export function engagementScore(post) {
    const likes = Number(post && post.likes) || 0;
    const comments = Number(post && post.commentCount) || 0;
    const views = Number(post && post.views) || 0;

    // Base logarithmic curve ensures consistent baseline scaling
    let score = ALGO.weights.likes * Math.log1p(likes)
        + ALGO.weights.comments * Math.log1p(comments)
        + ALGO.weights.views * Math.log1p(views);

    // High amounts push: amplify posts with high amounts of likes, views, or comments on FYP
    const highLikesPush = likes >= 100 ? Math.log10(likes) * 1.2 : (likes >= 20 ? (likes / 20) * 0.4 : 0);
    const highCommentsPush = comments >= 20 ? Math.log10(comments) * 1.5 : (comments >= 5 ? (comments / 5) * 0.5 : 0);
    const highViewsPush = views >= 500 ? Math.log10(views) * 0.8 : (views >= 100 ? (views / 100) * 0.3 : 0);

    return score + highLikesPush + highCommentsPush + highViewsPush;
}

/** Gentle power-law decay: 1h ≈ 0.76, 1d ≈ 0.44, 1w ≈ 0.28, 1mo ≈ 0.19. */
export function freshnessFactor(post, now = Date.now()) {
    const ageHours = Math.max(0, (now - timeValue(post)) / 3600000);
    return Math.pow(ageHours + 2, -ALGO.decayRate);
}

export function scorePost(post, options = {}) {
    const {
        now = Date.now(),
        following = [],
        affinity = [],
        selfId = "",
        salt = "",
        jitter = true,
        jitterScale = ALGO.jitter
    } = options;

    const kind = post.mediaKind || (post.videoUrl ? "video" : (post.imageUrl || post.imageBase64 || post.image ? "image" : "text"));
    let score = (ALGO.engagementFloor + engagementScore(post)) * freshnessFactor(post, now);

    if (kind === "video") score *= ALGO.boosts.video;
    else if (kind === "image") score *= ALGO.boosts.image;

    if (following.includes(post.userId)) score *= ALGO.boosts.following;
    if (selfId && post.userId === selfId) score *= ALGO.boosts.own;
    if (affinity.includes(post.category)) score *= ALGO.boosts.affinity;
    if (post.smallCreator) score *= ALGO.boosts.smallCreator;
    if (post.hasViewed) score *= ALGO.seenPenalty;

    // Push posts with high amounts of likes, views or comments on FYP
    const isHighEngagement = (Number(post.likes) >= 100 || Number(post.views) >= 500 || Number(post.commentCount) >= 20);
    if (isHighEngagement && ALGO.boosts.highEngagement) {
        score *= ALGO.boosts.highEngagement;
    }

    if (jitter) {
        const noise = stableNoise(post.id || "", salt);
        score *= 1 + (noise - 0.5) * jitterScale;
    }
    return score;
}

/**
 * Posts with their score, highest first; ties fall back to the newest post.
 * The mixer needs the scores to trade a little variety against quality.
 */
export function rankScored(posts, options = {}) {
    return posts
        .map(post => ({ post, score: scorePost(post, options) }))
        .sort((a, b) => (b.score - a.score) || (timeValue(b.post) - timeValue(a.post)));
}

/** Highest score first; ties fall back to the newest post. */
export function rankPosts(posts, options = {}) {
    return rankScored(posts, options).map(entry => entry.post);
}

/**
 * Standard feed mixer algorithm.
 */
function orderStandardFeed(posts, options = {}) {
    const ranked = Array.isArray(posts) ? rankScored(posts, options) : [];
    const {
        now = Date.now(),
        windowSize = ALGO.windowSize,
        maxOldInWindow = ALGO.maxOldInWindow,
        minOldShare = ALGO.minOldShare,
        oldAfterDays = ALGO.oldAfterDays,
        creatorGap = ALGO.creatorGap,
        gapPrice = ALGO.gapPrice
    } = options;

    const oldCutoff = now - oldAfterDays * 86400000;
    const isOld = post => timeValue(post) < oldCutoff;
    const placed = [];
    const pending = ranked.slice();
    let placedOld = 0;

    const hardRules = (post, context) => {
        if (isOld(post) && context.windowOld >= maxOldInWindow) return false;
        if (context.needsOld && !isOld(post)) return false;
        if (context.lastCreator && post.userId === context.lastCreator) return false;
        return true;
    };

    while (pending.length) {
        const context = {
            windowOld: placed.slice(-(windowSize - 1)).filter(isOld).length,
            needsOld: placedOld < Math.floor((placed.length + 1) * minOldShare),
            lastCreator: placed.length ? placed[placed.length - 1].userId : null
        };

        // 1. Best post that respects the cap, the freshness floor and "not the
        //    same creator twice in a row".
        let chosen = pending.findIndex(entry => hardRules(entry.post, context));

        // 2. Prefer a creator who has not appeared in the last few placements,
        //    but only when that costs little quality.
        if (chosen !== -1 && creatorGap > 2) {
            const affordable = pending[chosen].score * gapPrice;
            const recent = placed.slice(-(creatorGap - 1)).map(item => item.userId);
            if (recent.length > 0) {
                const varied = pending.findIndex((entry, index) =>
                    index > chosen &&
                    entry.score >= affordable &&
                    !recent.includes(entry.post.userId) &&
                    hardRules(entry.post, context));
                if (varied !== -1) chosen = varied;
            }
        }

        // 3. The freshness floor outranks the creator rules: a single-creator
        //    pool still gets its throwbacks.
        if (chosen === -1) {
            chosen = pending.findIndex(entry =>
                (!context.needsOld || isOld(entry.post)) &&
                !(isOld(entry.post) && context.windowOld >= maxOldInWindow));
        }

        // 4. Nobody can meet every rule: drop the freshness floor, keep the
        //    rest, then drop the creator rule, then place whatever is left.
        if (chosen === -1) {
            chosen = pending.findIndex(entry => !context.needsOld ||
                (isOld(entry.post) &&
                    !(isOld(entry.post) && context.windowOld >= maxOldInWindow) &&
                    entry.post.userId !== context.lastCreator));
        }
        if (chosen === -1) {
            chosen = pending.findIndex(entry =>
                !(isOld(entry.post) && context.windowOld >= maxOldInWindow) &&
                entry.post.userId !== context.lastCreator);
        }
        if (chosen === -1) chosen = 0;

        const [entry] = pending.splice(chosen, 1);
        if (isOld(entry.post)) placedOld += 1;
        placed.push(entry.post);
    }
    return placed;
}

/**
 * Keep the ranking honest while it mixes generations of posts:
 *
 *   - when a user has previously interacted with the page:
 *     shuffles the feed, and shuffles newest first ONLY if there are videos
 *     the user has not seen before.
 *   - at most `maxOldInWindow` older-than-a-week posts per ten placements, so
 *     the top of the feed never turns into an archive,
 *   - at least a `minOldShare` share of older posts overall (one in five), so a
 *     good video from last month gets its airtime instead of sinking forever,
 *   - never the same creator twice in a row; a wider `creatorGap` is preferred
 *     only when the alternative is nearly as good (within `gapPrice`), so
 *     variety never pushes a weak post over a strong one.
 */
export function orderForFeed(posts, options = {}) {
    if (!Array.isArray(posts) || posts.length === 0) return [];

    const {
        hasInteracted = false,
        salt = ""
    } = options;

    if (hasInteracted) {
        const isUnseenVideo = post => !post.hasViewed && (post.mediaKind === "video" || !!post.videoUrl);
        const unseenVideos = posts.filter(isUnseenVideo);
        const hasUnseenVideos = unseenVideos.length > 0;

        if (hasUnseenVideos) {
            // Shuffle newest only if there are videos the user hasn't seen before:
            // Sort unseen videos by newest first, take the newest batch, and shuffle them to the front.
            const sortedUnseen = unseenVideos.slice().sort((a, b) => timeValue(b) - timeValue(a));
            const shuffledNewest = sortedUnseen.slice().sort((a, b) =>
                stableNoise(a.id, salt + ":newest_vid") - stableNoise(b.id, salt + ":newest_vid")
            );

            const chosenIds = new Set(shuffledNewest.map(p => p.id));
            const remaining = posts.filter(p => !chosenIds.has(p.id));

            const restOrdered = remaining.length > 0
                ? orderStandardFeed(remaining, { ...options, hasInteracted: false, jitterScale: ALGO.interactedJitter })
                : [];
            return [...shuffledNewest, ...restOrdered];
        }

        // If there are NO videos the user hasn't seen before, do NOT shuffle newest to the front.
        // Instead, shuffle the feed across candidates with interacted jitter while preserving quality.
        return orderStandardFeed(posts, { ...options, jitterScale: ALGO.interactedJitter });
    }

    return orderStandardFeed(posts, options);
}

/** Categories the user keeps interacting with (for the affinity boost). */
export function likedCategories(posts, userId) {
    const categories = new Set();
    (posts || []).forEach(post => {
        if (post && post.category && Array.isArray(post.likedBy) && post.likedBy.includes(userId)) {
            categories.add(post.category);
        }
    });
    return Array.from(categories);
}
