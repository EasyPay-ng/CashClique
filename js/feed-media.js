/*
 * Feed media helpers (data saver).
 *
 * The feed must never pull media the viewer has not asked for:
 *   - a photo keeps its URL in data-src until it scrolls close to the screen,
 *   - a video is only a poster shell; the <video> element (and therefore the
 *     download) does not exist until the viewer taps play.
 *
 * Kept dependency-free and DOM-light so it can be unit tested in Node.
 */

const ABSOLUTE_URL = /^(data:|https?:|blob:)/i;

/** Escape a value that is written into an HTML attribute. */
export function escapeAttribute(value) {
    return String(value === null || value === undefined ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Resolve a post's photo source. New posts store an uploaded `imageUrl`;
 * older ones embedded a base64 payload (or a bare base64 string).
 */
export function postImageSrc(data) {
    const raw = data && (data.imageUrl || data.imageBase64 || data.image);
    if (!raw) return "";
    const value = String(raw).trim();
    if (!value) return "";
    if (ABSOLUTE_URL.test(value)) return value;
    return `data:image/jpeg;base64,${value}`;
}

/** "video" | "image" | "text" for a post document. */
export function postMediaKind(data) {
    if (data && data.videoUrl && String(data.videoUrl).trim()) return "video";
    if (postImageSrc(data)) return "image";
    return "text";
}

/**
 * Markup for a video post. The URL sits in a data attribute: no <video>, no
 * src, no preload and no poster fetch happen until playVideoInShell() runs.
 */
export function videoShellHTML(options = {}) {
    const {
        videoUrl = "",
        poster = "",
        label = "Tap to play video",
        hint = "Loads only when you tap"
    } = options;
    if (!videoUrl) return "";
    const posterAttr = poster ? ` data-poster="${escapeAttribute(poster)}"` : "";
    return `
            <div class="video-shell" data-video-src="${escapeAttribute(videoUrl)}"${posterAttr}
                 role="button" tabindex="0" aria-label="Play video">
                <span class="vs-play"><i class="fas fa-play"></i></span>
                <span class="vs-label">${escapeAttribute(label)}</span>
                <span class="vs-hint"><i class="fas fa-bolt"></i> ${escapeAttribute(hint)}</span>
            </div>`;
}

/** Markup for a photo: the real URL is held back in data-src. */
export function lazyImageFrameHTML(src, ratio) {
    if (!src) return "";
    const ratioAttr = ratio ? ` style="aspect-ratio:${escapeAttribute(ratio)};"` : "";
    return `
            <div class="media-frame loading" data-lazy-media="1"${ratioAttr}>
                <img data-src="${escapeAttribute(src)}" alt="" loading="lazy" decoding="async">
            </div>`;
}

/**
 * Swap a shell for a real, playing <video>. Only ever called from a click,
 * keypress or another explicit user action.
 */
export function playVideoInShell(shell, options = {}) {
    const documentRef = options.document || (typeof document !== "undefined" ? document : null);
    if (!shell || !documentRef) return null;
    const src = options.src || (shell.dataset && shell.dataset.videoSrc) || "";
    if (!src || (shell.classList && shell.classList.contains("playing"))) return null;

    const video = documentRef.createElement("video");
    video.className = "post-video";
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    if (typeof video.setAttribute === "function") {
        video.setAttribute("playsinline", "");
        video.setAttribute("webkit-playsinline", "");
    }
    if (shell.dataset && shell.dataset.poster) video.poster = shell.dataset.poster;
    video.src = src;

    if (shell.classList) shell.classList.add("playing");
    if (typeof shell.removeAttribute === "function") {
        shell.removeAttribute("role");
        shell.removeAttribute("tabindex");
    }
    shell.innerHTML = "";
    shell.appendChild(video);

    const started = typeof video.play === "function" ? video.play() : null;
    if (started && typeof started.catch === "function") started.catch(() => {});
    return video;
}
