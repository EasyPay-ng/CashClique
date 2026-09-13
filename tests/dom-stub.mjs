/*
 * Minimal browser stub so the Save-to-device modules can be exercised in Node.
 *
 * It records everything the modules touch (fetches, object URLs, canvas draws,
 * toBlob calls, anchor downloads, window.open) so the tests can assert that a
 * download only ever happens with a freshly watermarked Blob behind it.
 */

export function installDom(options = {}) {
    const dom = {
        options: Object.assign({
            remoteLogo: false,        // Cloudinary logo blocked by CORS by default
            localLogo: true,          // the bundled fallback asset loads
            canvasTainted: false,
            toBlobResult: "blob",     // "blob" | "null"
            recorderSupported: true,
            origin: "https://cashclique.test"
        }, options),
        calls: {
            fetch: [],
            imageSrcs: [],
            objectUrls: [],
            revokedUrls: [],
            downloads: [],
            windowOpen: [],
            drawImage: [],
            putImageData: [],
            toBlob: [],
            recorderStarts: [],
            videoSrcs: [],
            audioSources: [],
            audioConnections: [],
            navigations: []
        },
        fetchHandler: null,
        objectUrlCount: 0,
        audioContexts: [],
        currentRecorder: null
    };

    dom.resetCalls = () => {
        Object.keys(dom.calls).forEach((key) => { dom.calls[key].length = 0; });
        dom.objectUrlCount = 0;
        dom.audioContexts.length = 0;
        dom.currentRecorder = null;
    };

    const origin = dom.options.origin;

    function pixelData(width, height) {
        // Even pixels are brand orange, odd pixels are white: mirrors the real
        // logo (a mark on a white square) so white-knockout can be verified.
        const data = new Uint8ClampedArray(Math.max(4, width * height * 4));
        for (let i = 0; i < data.length; i += 8) {
            data[i] = 255; data[i + 1] = 106; data[i + 2] = 0; data[i + 3] = 255;
            if (i + 4 < data.length) {
                data[i + 4] = 255; data[i + 5] = 255; data[i + 6] = 255; data[i + 7] = 255;
            }
        }
        return data;
    }

    class FakeContext {
        constructor(canvas) {
            this.canvas = canvas;
            this.globalAlpha = 1;
            this.fillStyle = "";
            this.strokeStyle = "";
            this.font = "";
            this.shadowColor = "";
            this.shadowBlur = 0;
            this.lineCap = "";
            this.lineWidth = 1;
        }
        save() {}
        restore() {}
        beginPath() {}
        closePath() {}
        moveTo() {}
        lineTo() {}
        quadraticCurveTo() {}
        arc() {}
        fill() {}
        stroke() {}
        createLinearGradient() {
            return { addColorStop() {} };
        }
        measureText(text) {
            return { width: String(text).length * 8 };
        }
        fillText() {}
        drawImage(source) {
            dom.calls.drawImage.push(source);
        }
        getImageData(x, y, width, height) {
            if (dom.options.canvasTainted) {
                const error = new Error("The canvas has been tainted by cross-origin data.");
                error.name = "SecurityError";
                throw error;
            }
            return { data: pixelData(width || 1, height || 1), width: width || 1, height: height || 1 };
        }
        putImageData(imageData) {
            dom.calls.putImageData.push(imageData);
        }
    }

    class FakeCanvas {
        constructor() {
            this.width = 0;
            this.height = 0;
            this._context = new FakeContext(this);
        }
        getContext() {
            return this._context;
        }
        toBlob(callback, type, quality) {
            dom.calls.toBlob.push({ type, quality, width: this.width, height: this.height });
            if (dom.options.toBlobResult === "null") return callback(null);
            callback(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: type || "image/jpeg" }));
        }
        toDataURL(type) {
            return "data:" + (type || "image/png") + ";base64,AAAA";
        }
        captureStream() {
            return new FakeMediaStream("canvas");
        }
    }

    class FakeMediaStream {
        constructor(label) {
            this.label = label;
            this.tracks = [];
            this.audioTracks = label === "video" ? [new FakeTrack("audio")] : [];
        }
        addTrack(track) {
            this.tracks.push(track);
        }
        getTracks() {
            return this.tracks.concat(this.audioTracks);
        }
        getAudioTracks() {
            return this.audioTracks;
        }
        getVideoTracks() {
            return [];
        }
    }

    class FakeTrack {
        constructor(kind) {
            this.kind = kind;
            this.stopped = false;
        }
        stop() {
            this.stopped = true;
        }
    }

    class FakeAudioContext {
        constructor() {
            this.state = "suspended";
            this.closed = false;
            // Stands in for ctx.destination (the speakers).
            this.destination = { name: "speakers" };
            dom.audioContexts.push(this);
        }
        createMediaElementSource(element) {
            dom.calls.audioSources.push(element);
            return {
                connect: (target) => {
                    dom.calls.audioConnections.push(target);
                }
            };
        }
        createMediaStreamDestination() {
            const stream = new FakeMediaStream("audio-destination");
            // A real MediaStreamAudioDestinationNode always exposes one track.
            stream.audioTracks = [new FakeTrack("audio")];
            this.destinationStream = stream;
            return { stream };
        }
        resume() {
            if (this.closed) return Promise.reject(new Error("closed"));
            this.state = "running";
            return Promise.resolve();
        }
        close() {
            this.closed = true;
            this.state = "closed";
            return Promise.resolve();
        }
    }

    class FakeImage {
        constructor() {
            this.naturalWidth = 0;
            this.naturalHeight = 0;
            this.width = 0;
            this.height = 0;
            this.crossOrigin = null;
            this.decoding = "";
            this.onload = null;
            this.onerror = null;
            this._src = "";
        }
        get src() {
            return this._src;
        }
        set src(value) {
            this._src = value;
            dom.calls.imageSrcs.push(value);
            const loads = imageShouldLoad(value, dom.options);
            setTimeout(() => {
                if (loads) {
                    this.naturalWidth = 512;
                    this.naturalHeight = 512;
                    this.width = 512;
                    this.height = 512;
                    if (this.onload) this.onload();
                } else if (this.onerror) {
                    this.onerror(new Error("CORS request blocked"));
                }
            }, 0);
        }
    }

    class FakeVideo {
        constructor() {
            this.videoWidth = 640;
            this.videoHeight = 360;
            this.duration = 2;
            this.currentTime = 0;
            this.muted = false;
            this.volume = 1;
            this.preload = "";
            this.playsInline = false;
            this.crossOrigin = null;
            this.onloadedmetadata = null;
            this.onloadeddata = null;
            this.onended = null;
            this.onerror = null;
            this._src = "";
            this.playAttempts = 0;
        }
        get src() {
            return this._src;
        }
        set src(value) {
            this._src = value;
            if (value) dom.calls.videoSrcs.push(value);
        }
        setAttribute() {}
        removeAttribute() {}
        load() {
            setTimeout(() => {
                if (this.onloadedmetadata) this.onloadedmetadata();
                else if (this.onloadeddata) this.onloadeddata();
            }, 0);
        }
        captureStream() {
            return new FakeMediaStream("video");
        }
        play() {
            this.playAttempts++;
            return Promise.resolve().then(() => {
                setTimeout(() => {
                    this.currentTime = this.duration;
                    if (this.onended) this.onended();
                }, 10);
            });
        }
        pause() {}
    }

    class FakeMediaRecorder {
        constructor(stream, config) {
            this.stream = stream;
            this.mimeType = (config && config.mimeType) || "video/webm";
            this.state = "inactive";
            this.ondataavailable = null;
            this.onerror = null;
            this.onstop = null;
            dom.currentRecorder = this;
        }
        static isTypeSupported(type) {
            if (!dom.options.recorderSupported) return false;
            return String(type).indexOf("webm") === 0 || String(type).indexOf("video/webm") === 0;
        }
        start() {
            this.state = "recording";
            dom.calls.recorderStarts.push(this.mimeType);
        }
        stop() {
            this.state = "inactive";
            if (this.ondataavailable) {
                this.ondataavailable({
                    data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01])], { type: this.mimeType })
                });
            }
            if (this.onstop) this.onstop();
        }
        fail(message) {
            if (this.onerror) this.onerror({ error: new Error(message || "recorder blew up") });
        }
    }

    class FakeAnchor {
        constructor() {
            this.href = "";
            this.download = "";
            this.rel = "";
            this.style = {};
            this.clicked = false;
        }
        click() {
            this.clicked = true;
            dom.calls.downloads.push({ href: this.href, download: this.download });
        }
        remove() {}
    }

    function imageShouldLoad(url, opts) {
        if (/^data:/i.test(url)) return true;
        if (/^blob:/i.test(url)) return true;
        if (url.indexOf("res.cloudinary.com") !== -1) return !!opts.remoteLogo;
        if (url.indexOf("cashclique-watermark") !== -1) return !!opts.localLogo;
        return true;
    }

    const fakeDocument = {
        baseURI: origin + "/dashboard.html",
        body: {
            appendChild(element) {
                dom.lastAppended = element;
                return element;
            },
            removeChild() {}
        },
        createElement(tag) {
            if (tag === "canvas") return new FakeCanvas();
            if (tag === "video") return new FakeVideo();
            if (tag === "a") return new FakeAnchor();
            return { style: {}, appendChild() {}, click() {}, remove() {} };
        },
        getElementById() {
            return null;
        }
    };

    // The AudioContext route is how real browsers keep the soundtrack; pass
    // audioContext: false to exercise the element captureStream fallback.
    const useAudioContext = options.audioContext !== false;
    const fakeWindow = {
        location: { href: origin + "/dashboard.html" },
        open(url) {
            dom.calls.windowOpen.push(url);
            return null;
        },
        AudioContext: useAudioContext ? FakeAudioContext : undefined,
        webkitAudioContext: undefined
    };

    const globals = {
        document: fakeDocument,
        window: fakeWindow,
        Image: FakeImage,
        HTMLCanvasElement: FakeCanvas,
        MediaRecorder: FakeMediaRecorder,
        AudioContext: useAudioContext ? FakeAudioContext : undefined,
        requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
        cancelAnimationFrame: (id) => clearTimeout(id),
        open: fakeWindow.open,
        fetch: async (url, config) => {
            dom.calls.fetch.push(String(url));
            if (dom.fetchHandler) return dom.fetchHandler(String(url), config);
            const error = new TypeError("Failed to fetch");
            throw error;
        }
    };

    const previous = {};
    Object.keys(globals).forEach((key) => {
        previous[key] = Object.prototype.hasOwnProperty.call(globalThis, key)
            ? { value: globalThis[key], had: true }
            : { had: false };
        globalThis[key] = globals[key];
    });

    // Blob URLs live on the URL constructor in browsers.
    previous.createObjectURL = URL.createObjectURL;
    previous.revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => {
        dom.calls.objectUrls.push(blob);
        dom.objectUrlCount += 1;
        return "blob:" + origin + "/" + dom.objectUrlCount;
    };
    URL.revokeObjectURL = (url) => {
        dom.calls.revokedUrls.push(url);
    };

    dom.restore = () => {
        Object.keys(globals).forEach((key) => {
            if (previous[key].had) globalThis[key] = previous[key].value;
            else delete globalThis[key];
        });
        URL.createObjectURL = previous.createObjectURL;
        URL.revokeObjectURL = previous.revokeObjectURL;
    };

    dom.helpers = { FakeCanvas, FakeImage, FakeVideo, FakeMediaRecorder, FakeAnchor };
    return dom;
}

/** A Response-like object for the fetch stub. */
export function fakeResponse(bytes, options = {}) {
    const blob = new Blob([bytes], { type: options.contentType || "application/octet-stream" });
    return {
        ok: options.ok !== false,
        status: options.status || 200,
        statusText: options.statusText || "OK",
        headers: {
            get(name) {
                if (String(name).toLowerCase() === "content-type") return options.contentType || "";
                return null;
            }
        },
        blob: async () => blob
    };
}

export function fakeErrorResponse(status, message) {
    return {
        ok: false,
        status: status,
        statusText: message || "",
        headers: { get: () => null },
        blob: async () => new Blob([])
    };
}
