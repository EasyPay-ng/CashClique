/*
 * Static guard rails for the two pages that own a Save button.
 *
 * The save flow used to fall back to navigating to the Firebase Storage URL
 * (window.open / an <a download> pointed at the media) and to downloading the
 * untouched video when watermarking failed. Videos now intentionally download
 * unchanged; navigation fallbacks remain forbidden. Both pages share one flow.
 */

import test from "node:test";
import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MEDIA_PROXY_URL, SITE_LOGO_URL } from "../js/media-save.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PAGES = [
    {
        file: "dashboard.html",
        startMarker: "// ==================== SAVE-TO-DEVICE DOWNLOADS",
        endMarker: "// ==================== UTILITIES"
    },
    {
        file: "post-view.html",
        startMarker: "// ==================== SAVE-TO-DEVICE",
        endMarker: "// Time ago helper"
    }
];

function read(path) {
    return readFileSync(join(ROOT, path), "utf8");
}

function saveSection(page) {
    const source = read(page.file);
    const start = source.indexOf(page.startMarker);
    const end = source.indexOf(page.endMarker, start + 1);
    assert.ok(start !== -1, `${page.file}: save section start marker missing`);
    assert.ok(end > start, `${page.file}: save section end marker missing`);
    return source.slice(start, end);
}

/** Drop comments so call scanning does not match prose. */
function codeOnly(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

for (const page of PAGES) {
    test(`${page.file}: save flow`, () => {
        const source = read(page.file);
        const section = saveSection(page);
        const code = codeOnly(section);

        // Shared implementation, no per-page forks.
        assert.match(source, /from "\.\/js\/media-save\.js"/, "imports the shared save module");
        assert.ok(!/js\/video-watermark\.js/.test(source), "pages go through media-save.js");

        // No navigation fallbacks anywhere on the page.
        for (const banned of ["downloadViaAnchor", "attachmentDownloadUrl", "response-content-disposition"]) {
            assert.ok(source.indexOf(banned) === -1, `${banned} must be gone from ${page.file}`);
        }
        assert.ok(code.indexOf("window.open") === -1, "the save flow never opens the media URL");
        assert.ok(code.indexOf("location.href") === -1, "the save flow never navigates");
        assert.ok(code.indexOf(".play()") === -1, "the save flow never plays the video as a fallback");

        // Photos are watermarked; videos intentionally preserve the original file.
        assert.match(code, /await createWatermarkedJpeg\(/, "photos are watermarked");
        assert.match(code, /await createVideoDownload\(/, "videos download unchanged");
        const downloads = code.match(/downloadBlob\([^)]*\)/g) || [];
        assert.strictEqual(downloads.length, 2, "one download per media kind");
        downloads.forEach((call) => {
            assert.match(call, /downloadBlob\(saved\.blob, saved\.filename\)/,
                `only the prepared Blob is downloaded, got: ${call}`);
        });

        assert.doesNotMatch(code, /videoWatermarkSupported|renderWatermarkedVideo/, "video saves need no recorder");

        // Failures are reported, not papered over.
        assert.match(code, /err\.userMessage/, "errors surface a user message");
        assert.ok(!/saved without watermark/i.test(section), "no unwatermarked fallback download");
        assert.ok(!/Download started/i.test(section), "no anchor-navigation success toast");

        // Cancelling is still possible on the video path.
        assert.match(code, /isCancelled: \(\) => dlState\.cancel/);
        assert.match(code, /window\.cancelSave/);
    });
}

test("watermark assets and endpoints are the documented ones", () => {
    assert.strictEqual(SITE_LOGO_URL,
        "https://res.cloudinary.com/dq7fpxfbc/image/upload/v1772726030/logo2_drw2fc.jpg");
    assert.strictEqual(MEDIA_PROXY_URL,
        "https://us-central1-cashclique-31718.cloudfunctions.net/downloadMedia");

    // The same favicon the pages link to is used as the watermark source.
    for (const page of PAGES) {
        const source = read(page.file);
        assert.ok(source.indexOf(SITE_LOGO_URL) !== -1, `${page.file} links the favicon`);
    }

    // Local fallback asset ships with the app for CORS-blocked CDNs.
    assert.ok(existsSync(join(ROOT, "assets", "cashclique-watermark.svg")),
        "assets/cashclique-watermark.svg must exist");
    const svg = read("assets/cashclique-watermark.svg");
    assert.match(svg, /<svg[^>]+width="512"/, "the fallback asset has intrinsic size");
    assert.match(svg, /CashClique/, "the fallback asset is branded");
});

test("dashboard and post view provide watch history, reposting and harmful-content reports", () => {
    const dashboard = read("dashboard.html");
    const postView = read("post-view.html");

    assert.match(dashboard, /data-tab="history"/, "watch history is available as a feed tab");
    assert.match(dashboard, /users", currentUser\.uid, "watchHistory"/, "history is stored per signed-in user");
    assert.match(dashboard, /class="action-item repost-post"/, "feed posts can be reposted");
    assert.match(dashboard, /scam_fraud/, "scam reports have a dedicated reason");
    assert.match(dashboard, /sexual_content/, "sexual-content reports have a dedicated reason");

    assert.match(postView, /id="repost-action"/, "the post detail view supports reposts");
    assert.match(postView, /id="report-action"/, "the post detail view supports reports");
    assert.match(postView, /addEventListener\('play', \(\) => recordWatchHistory\(postId\)\)/,
        "detail-page video plays are recorded");
});

test("repost wrappers stay out of creator metrics, boosts and account-deletion leftovers", () => {
    const myContent = read("my-content.html");
    const profile = read("profile.html");
    const admin = read("admin.html");
    const opportunities = read("find-opportunities.html");
    const earnings = read("earnings.html");
    const boost = read("boost.html");
    const settings = read("settings.html");

    assert.match(myContent, /post\.postType === "repost"/, "creator content skips repost wrappers");
    assert.match(profile, /post\.data\.postType !== "repost"/, "profile grids skip repost wrappers");
    assert.match(admin, /p\.postType === "repost"/, "admin earnings metrics skip repost wrappers");
    assert.match(opportunities, /doc\.data\(\)\.postType !== "repost"/, "opportunity stats count authored posts only");
    assert.match(earnings, /d\.data\(\)\.postType !== "repost"/, "repost wrappers do not appear as creator revenue");
    assert.match(boost, /docSnap\.data\(\)\.postType !== "repost"/, "repost wrappers cannot be boosted");
    assert.match(settings, /collection\(db, "users", currentUser\.uid, "watchHistory"\)/, "account deletion clears watch history");
    assert.match(settings, /collection\(db, "users", currentUser\.uid, "reposts"\)/, "account deletion clears repost relationships");
});

test("the downloadMedia proxy is declared in functions/index.js", () => {
    const source = read("functions/index.js");
    assert.match(source, /exports\.downloadMedia = onRequest\(/);
    assert.match(source, /region: "us-central1"/);
    assert.match(source, /Access-Control-Allow-Origin/);
    assert.match(source, /req\.method === "OPTIONS"/, "preflight is answered");
    // getMetadata() stores the Firebase token in custom metadata, so the check
    // must go through the helper that reads firebaseStorageDownloadTokens.
    assert.match(source, /hasDownloadToken\(metadata, parsed\.token\)/, "the URL token is verified");
    assert.doesNotMatch(source, /metadata\.downloadTokens/, "the GCS metadata shape has no top-level downloadTokens");
    assert.match(source, /createReadStream\(\)/, "the object is streamed, not buffered");

    const pkg = JSON.parse(read("functions/package.json"));
    assert.ok(pkg.dependencies["firebase-functions"], "firebase-functions is declared");
    assert.ok(pkg.dependencies["firebase-admin"], "firebase-admin is declared");

    const firebaseJson = JSON.parse(read("firebase.json"));
    const functionsConfig = Array.isArray(firebaseJson.functions) ? firebaseJson.functions[0] : firebaseJson.functions;
    assert.strictEqual(functionsConfig.source, "functions");
});
