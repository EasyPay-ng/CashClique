/*
 * Re-render a downloaded video through a canvas so the saved copy carries the
 * CashClique mark, then hand the recording back as a Blob.
 *
 * This is deliberately strict: if the browser cannot record a watermarked
 * video the promise rejects, so callers never fall back to saving the
 * untouched source file. The video is played from an object URL created from
 * bytes we already fetched, which keeps the canvas origin-clean and the
 * watermark impossible to strip with CORS.
 */

import { APP_NAME, drawCornerMark, getWatermarkMark } from "./watermark.js";

const RECORDER_MIME_TYPES = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4"
];

export function supportedRecorderMimeType() {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
    return RECORDER_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

export function videoWatermarkSupported() {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return false;
    if (typeof HTMLCanvasElement === "undefined" || !HTMLCanvasElement.prototype.captureStream) return false;
    return !!supportedRecorderMimeType();
}

function extensionForMime(mime) {
    return String(mime || "").toLowerCase().includes("mp4") ? "mp4" : "webm";
}

function watermarkError(kind, message) {
    const error = new Error(message);
    error.name = "WatermarkError";
    error.kind = kind;
    if (kind === "cancelled") error.cancelled = true;
    return error;
}

/**
 * Render `videoBlob` with the CashClique logo burned into the lower-right
 * corner. Resolves with `{ blob, extension, mimeType, hadAudio }`.
 *
 * options:
 *   watermark  - prepared mark (canvas). Defaults to the cached site logo.
 *   appName    - text used if no logo asset can be drawn at all.
 *   isCancelled- polled between stages and on every animation frame.
 *   onProgress - (currentTimeSeconds, durationSeconds) during recording.
 */
export async function renderWatermarkedVideo(videoBlob, options = {}) {
    const {
        watermark = null,
        appName = APP_NAME,
        isCancelled = () => false,
        onProgress = () => {}
    } = options;

    if (!videoBlob || !videoBlob.size) {
        throw watermarkError("render", "There is no video data to watermark");
    }

    const mimeType = supportedRecorderMimeType();
    if (!mimeType || typeof HTMLCanvasElement === "undefined" || !HTMLCanvasElement.prototype.captureStream) {
        throw watermarkError("unsupported", "This browser cannot record a watermarked video");
    }
    if (isCancelled()) throw watermarkError("cancelled", "Save cancelled");

    const mark = watermark || (await getWatermarkMark()).canvas;
    if (isCancelled()) throw watermarkError("cancelled", "Save cancelled");

    const sourceUrl = URL.createObjectURL(videoBlob);
    const video = document.createElement("video");
    video.preload = "auto";
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.muted = true;
    video.crossOrigin = "anonymous";
    video.src = sourceUrl;

    const state = { audioContext: null, nativeStream: null };
    let animationFrame = 0;
    let recorder = null;
    let outputStream = null;

    try {
        await waitForMetadata(video);
        if (isCancelled()) throw watermarkError("cancelled", "Save cancelled");

        const width = video.videoWidth || 1280;
        const height = video.videoHeight || 720;
        const duration = Number.isFinite(video.duration) ? video.duration : 0;

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw watermarkError("render", "Canvas is unavailable in this browser");

        outputStream = canvas.captureStream(30);

        // Audio: route the element through an AudioContext into the recorded
        // stream. Nothing is connected to the speakers, so the save stays
        // silent while the soundtrack is preserved.
        const hadAudio = await attachAudio(video, outputStream, state);

        // Prove playback is allowed before the recorder runs, so a rejected
        // autoplay promise cannot leave a half-recorded file behind.
        await primePlayback(video, outputStream, state);
        if (isCancelled()) throw watermarkError("cancelled", "Save cancelled");

        const recorded = await recordPlayback({
            video,
            context,
            outputStream,
            width,
            height,
            duration,
            mark,
            appName,
            mimeType,
            isCancelled,
            onProgress,
            setRecorder: (instance) => { recorder = instance; },
            setAnimationFrame: (id) => { animationFrame = id; }
        });

        if (!recorded.blob || !recorded.blob.size) {
            throw watermarkError("render", "The watermarked video came back empty");
        }
        return {
            blob: recorded.blob,
            extension: extensionForMime(recorded.mimeType || mimeType),
            mimeType: recorded.mimeType || mimeType,
            hadAudio
        };
    } finally {
        cancelAnimationFrame(animationFrame);
        if (recorder && recorder.state !== "inactive") {
            try { recorder.stop(); } catch (error) { /* already stopped */ }
        }
        try { video.pause(); } catch (error) { /* already stopped */ }
        video.removeAttribute("src");
        try { video.load(); } catch (error) { /* noop */ }
        if (state.audioContext) {
            try { await state.audioContext.close(); } catch (error) { /* noop */ }
        }
        if (state.nativeStream) {
            state.nativeStream.getTracks().forEach((track) => track.stop());
        }
        if (outputStream) outputStream.getTracks().forEach((track) => track.stop());
        URL.revokeObjectURL(sourceUrl);
    }
}

function waitForMetadata(video) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            video.onloadedmetadata = null;
            video.onloadeddata = null;
            video.onerror = null;
            fn(arg);
        };
        video.onloadedmetadata = () => finish(resolve);
        video.onloadeddata = () => finish(resolve);
        video.onerror = () => finish(reject, watermarkError("render", "Could not decode the downloaded video"));
        video.load();
    });
}

/**
 * Add the video's soundtrack to the recorded stream. Returns true when an
 * audio track made it in. The element itself is never connected to the
 * speakers, so saving a video stays silent.
 */
async function attachAudio(video, outputStream, state) {
    const AudioContextClass = (typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext)) || null;
    if (AudioContextClass) {
        try {
            const audioContext = new AudioContextClass();
            const source = audioContext.createMediaElementSource(video);
            const destination = audioContext.createMediaStreamDestination();
            source.connect(destination); // graph only - no speaker output
            await audioContext.resume();
            const tracks = destination.stream.getAudioTracks();
            if (tracks.length) {
                tracks.forEach((track) => outputStream.addTrack(track));
                state.audioContext = audioContext;
                // The element must be unmuted for the graph to receive audio;
                // rerouting above keeps it inaudible.
                video.muted = false;
                video.volume = 1;
                return true;
            }
            await audioContext.close();
        } catch (error) {
            console.warn("[CashClique] audio graph unavailable, trying the element capture stream", error);
            state.audioContext = null;
        }
    }
    // Fallback: the element's own capture stream. The element stays muted so
    // nothing plays out loud while the save runs.
    const native = captureFromElement(video);
    if (native) {
        state.nativeStream = native;
        const tracks = native.getAudioTracks();
        if (tracks.length) {
            tracks.forEach((track) => outputStream.addTrack(track));
            return true;
        }
    }
    return false;
}

function captureFromElement(video) {
    try {
        if (typeof video.captureStream === "function") return video.captureStream();
        if (typeof video.mozCaptureStream === "function") return video.mozCaptureStream();
    } catch (error) {
        // Older browsers refuse captureStream on an element already in a graph.
    }
    return null;
}

/**
 * Start playback once to confirm the browser allows it, then rewind so the
 * recording captures the whole clip. Unmuted playback keeps the AudioContext
 * route (and therefore the soundtrack); if it is refused we retry muted with
 * whatever audio the element's own capture stream still provides.
 */
async function primePlayback(video, outputStream, state) {
    const rewind = () => {
        try { video.pause(); } catch (error) { /* noop */ }
        try { video.currentTime = 0; } catch (error) { /* seek unsupported */ }
    };

    try {
        await video.play();
        rewind();
        return;
    } catch (error) {
        if (error && error.name === "AbortError") throw watermarkError("cancelled", "Save cancelled");
    }

    if (state.audioContext) {
        try {
            await state.audioContext.resume();
            await video.play();
            rewind();
            return;
        } catch (error) {
            try { await state.audioContext.close(); } catch (closeError) { /* noop */ }
            state.audioContext = null;
        }
    }

    video.muted = true;
    const native = captureFromElement(video);
    if (native) {
        state.nativeStream = native;
        native.getAudioTracks().forEach((track) => outputStream.addTrack(track));
    }
    try {
        await video.play();
    } catch (error) {
        throw watermarkError("render", "This browser refused to play the video for watermarking");
    }
    rewind();
}

function recordPlayback(config) {
    const {
        video,
        context,
        outputStream,
        width,
        height,
        duration,
        mark,
        appName,
        mimeType,
        isCancelled,
        onProgress,
        setRecorder,
        setAnimationFrame
    } = config;

    return new Promise((resolve, reject) => {
        const chunks = [];
        let settled = false;
        let frameId = 0;

        const recorder = new MediaRecorder(outputStream, {
            mimeType,
            videoBitsPerSecond: 5000000,
            audioBitsPerSecond: 128000
        });
        setRecorder(recorder);

        const cleanup = () => {
            cancelAnimationFrame(frameId);
            try { video.pause(); } catch (error) { /* noop */ }
            video.onended = null;
        };

        const finishWithError = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            try {
                if (recorder.state !== "inactive") recorder.stop();
            } catch (error2) { /* noop */ }
            reject(error);
        };

        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size) chunks.push(event.data);
        };
        recorder.onerror = (event) => {
            const detail = event && event.error ? event.error.message : "";
            finishWithError(watermarkError("render", "Video recording failed" + (detail ? ": " + detail : "")));
        };
        recorder.onstop = () => {
            if (settled) return;
            settled = true;
            cleanup();
            if (isCancelled()) {
                reject(watermarkError("cancelled", "Save cancelled"));
                return;
            }
            const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
            if (!chunks.length || !blob.size) {
                reject(watermarkError("render", "The watermarked video came back empty"));
                return;
            }
            resolve({ blob, mimeType: recorder.mimeType || mimeType });
        };

        video.onended = () => {
            if (settled) return;
            // Let the last frames flush before stopping the recorder.
            setTimeout(() => {
                if (settled) return;
                try {
                    if (recorder.state !== "inactive") recorder.stop();
                } catch (error) {
                    finishWithError(watermarkError("render", "Could not finish the watermarked video"));
                }
            }, 160);
        };

        const drawFrame = () => {
            if (settled) return;
            if (isCancelled()) {
                finishWithError(watermarkError("cancelled", "Save cancelled"));
                return;
            }
            try {
                context.drawImage(video, 0, 0, width, height);
            } catch (error) {
                finishWithError(watermarkError("render", "Could not draw the video onto the canvas"));
                return;
            }
            drawCornerMark(context, width, height, mark, { appName });
            if (duration > 0) {
                try { onProgress(video.currentTime, duration); } catch (error) { /* UI only */ }
            }
            frameId = requestAnimationFrame(drawFrame);
            setAnimationFrame(frameId);
        };

        try {
            recorder.start(1000);
        } catch (error) {
            finishWithError(watermarkError("render", "Could not start the video recorder"));
            return;
        }
        drawFrame();
        video.play().catch((error) => {
            finishWithError(watermarkError("render", "Could not play the video for watermarking"));
        });
    });
}
