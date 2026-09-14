/*
 * CashClique watermark helpers shared by every "Save" flow.
 *
 * Saved photos must always carry the CashClique mark, so this module owns one
 * cached copy of the logo plus the drawing code that stamps it on a canvas.
 *
 * The mark is the same favicon every page links to (Cloudinary). It is fetched
 * with crossOrigin="anonymous" so the canvas stays origin-clean; if Cloudinary
 * refuses the cross-origin request we fall back to the local asset shipped with
 * the app, and finally to a mark drawn in code, so a watermark is never
 * missing and never silently skipped.
 */

export const APP_NAME = "CashClique";

// Same favicon used by <link rel="icon"> on every page.
export const SITE_LOGO_URL = "https://res.cloudinary.com/dq7fpxfbc/image/upload/v1772726030/logo2_drw2fc.jpg";

// Same-origin copy of the mark, used when the CDN blocks cross-origin reads.
export const LOCAL_WATERMARK_PATH = "assets/cashclique-watermark.svg";

const MARK_TIMEOUT_MS = 6000;

let markPromise = null;

/** Resolve a repo-relative asset path against the current page directory. */
export function localAssetUrl(path) {
    const clean = String(path || "").replace(/^\/+/, "");
    try {
        const base = new URL(document.baseURI || window.location.href);
        base.search = "";
        base.hash = "";
        base.pathname = base.pathname.replace(/[^/]*$/, "") + clean;
        return base.toString();
    } catch (error) {
        return clean;
    }
}

/**
 * Load an image and resolve with the element, or null when it cannot be used.
 * Remote images are requested with CORS so they never taint a canvas.
 */
export function loadImageElement(src, options = {}) {
    const { crossOrigin = "anonymous", timeoutMs = MARK_TIMEOUT_MS } = options;
    return new Promise((resolve) => {
        if (!src) return resolve(null);
        const image = new Image();
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            resolve(result);
        };
        const timer = setTimeout(() => finish(null), timeoutMs);
        if (!/^data:/i.test(src) && crossOrigin) image.crossOrigin = crossOrigin;
        image.decoding = "async";
        image.onload = () => finish(image);
        image.onerror = () => finish(null);
        image.src = src;
    });
}

/**
 * Copy an image into a canvas, verifying the canvas is still readable.
 * Returns null when the image is empty or taints the canvas (CORS), which is
 * exactly the case where toBlob() would throw later on.
 */
export function rasterize(image) {
    try {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) return null;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.drawImage(image, 0, 0, width, height);
        const pixels = context.getImageData(0, 0, width, height).data;
        let visible = 0;
        for (let i = 3; i < pixels.length; i += 4) {
            if (pixels[i] > 0) visible++;
        }
        return visible > 0 ? canvas : null;
    } catch (error) {
        // Tainted canvas (SecurityError) or no 2D context at all.
        return null;
    }
}

/**
 * The Cloudinary favicon is a JPG sitting on a white square. Knock the white
 * out with a soft ramp so the mark blends over photos instead of
 * showing up as a white box.
 */
export function stripWhiteBackground(image) {
    const canvas = rasterize(image);
    if (!canvas) return null;
    try {
        const context = canvas.getContext("2d");
        const data = context.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = data.data;
        let kept = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            const whiteness = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
            let alpha;
            if (whiteness <= 200) alpha = 255;
            else if (whiteness >= 252) alpha = 0;
            else alpha = Math.round(((252 - whiteness) / 52) * 255);
            if (alpha < pixels[i + 3]) pixels[i + 3] = alpha;
            if (pixels[i + 3] > 0) kept++;
        }
        if (!kept) return null;
        context.putImageData(data, 0, 0);
        return canvas;
    } catch (error) {
        return canvas;
    }
}

/**
 * The mark, as a transparent canvas, plus where it came from.
 * Cached: one network round-trip per page, reused by photos.
 */
export function getWatermarkMark() {
    if (markPromise) return markPromise;
    markPromise = loadWatermarkMark();
    return markPromise;
}

/** Drop the cached mark (used by tests and after a failed CDN response). */
export function resetWatermarkMark() {
    markPromise = null;
}

async function loadWatermarkMark() {
    // 1. The real favicon from Cloudinary.
    const remote = await loadImageElement(cacheBusted(SITE_LOGO_URL));
    if (remote) {
        const stripped = stripWhiteBackground(remote);
        if (stripped) return { canvas: stripped, source: "cloudinary" };
        const plain = rasterize(remote);
        if (plain) return { canvas: plain, source: "cloudinary" };
    }

    // 2. Local fallback asset (same origin: never blocked by CORS).
    const local = await loadImageElement(localAssetUrl(LOCAL_WATERMARK_PATH));
    if (local) {
        const canvas = rasterize(local);
        if (canvas) return { canvas, source: "local" };
    }

    // 3. Last resort: draw the badge in code so the mark always exists.
    return { canvas: drawFallbackMark(256), source: "drawn" };
}

function cacheBusted(url) {
    return url + (url.includes("?") ? "&" : "?") + "ccmark=1";
}

/** Badge + "C" + chat dots, drawn with the brand colours. */
export function drawFallbackMark(size = 256) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) return canvas;
    const radius = size * 0.24;
    const gradient = context.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, "#ff9142");
    gradient.addColorStop(0.55, "#ff6a00");
    gradient.addColorStop(1, "#e05400");
    context.fillStyle = gradient;
    roundRect(context, size * 0.016, size * 0.016, size * 0.968, size * 0.968, radius);
    context.fill();
    context.strokeStyle = "rgba(255,255,255,0.35)";
    context.lineWidth = Math.max(2, size * 0.02);
    roundRect(context, size * 0.026, size * 0.026, size * 0.948, size * 0.948, radius * 0.95);
    context.stroke();
    context.strokeStyle = "#ffffff";
    context.lineWidth = size * 0.117;
    context.lineCap = "round";
    context.beginPath();
    context.arc(size / 2, size / 2, size * 0.219, -Math.PI * 0.25, Math.PI * 0.25, true);
    context.stroke();
    [-0.086, 0, 0.086].forEach((offset, index) => {
        context.globalAlpha = 1 - index * 0.14;
        context.fillStyle = "#ffffff";
        context.beginPath();
        context.arc(size * (0.5 + offset), size / 2, size * 0.037, 0, Math.PI * 2);
        context.fill();
    });
    context.globalAlpha = 1;
    return canvas;
}

function roundRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y);
    context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r);
    context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height);
    context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r);
    context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
}

/** Lower-right corner mark. Falls back to the wordmark if no logo is usable. */
export function drawCornerMark(context, width, height, mark, options = {}) {
    const { alpha = 1, appName = APP_NAME } = options;
    const padding = Math.max(12, Math.round(width * 0.03));
    context.save();
    context.shadowColor = "rgba(0,0,0,0.85)";
    context.shadowBlur = Math.max(6, Math.round(width * 0.014));
    if (mark && mark.width > 0 && mark.height > 0) {
        const markWidth = Math.min(width * 0.22, 300);
        const markHeight = markWidth * (mark.height / mark.width);
        context.globalAlpha = alpha;
        context.drawImage(mark, width - markWidth - padding, height - markHeight - padding, markWidth, markHeight);
    } else {
        context.globalAlpha = 1;
        context.fillStyle = "#ffffff";
        context.font = `900 ${Math.max(16, Math.round(width * 0.035))}px Poppins, Arial, sans-serif`;
        const label = appName || APP_NAME;
        const textWidth = context.measureText(label).width;
        context.fillText(label, width - textWidth - padding, height - padding);
    }
    context.restore();
}

/** Clearly visible centred mark used on saved photos. */
export function drawCenterGhost(context, width, height, mark, options = {}) {
    const { alpha = 0.32 } = options;
    if (!mark || !mark.width || !mark.height) return;
    const ghostWidth = width * 0.32;
    const ghostHeight = ghostWidth * (mark.height / mark.width);
    context.save();
    context.globalAlpha = alpha;
    context.shadowColor = "rgba(0,0,0,0.8)";
    context.shadowBlur = Math.max(4, Math.round(width * 0.008));
    context.drawImage(mark, (width - ghostWidth) / 2, (height - ghostHeight) / 2, ghostWidth, ghostHeight);
    context.restore();
}
