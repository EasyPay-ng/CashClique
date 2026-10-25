/*
 * Shared harness for the dashboard feed tests.
 *
 * It evaluates the real dashboard module in Node against a small DOM and a
 * Firestore stub, so tests (and tooling) can drive the actual render path
 * instead of re-implementing it.
 */

import { readFileSync } from "node:fs";
import vm from "node:vm";

import {
    autoplayVideoHTML,
    lazyImageFrameHTML,
    playVideoInShell,
    postImageSrc,
    postMediaKind,
    primeAutoplayVideo,
    videoShellHTML
} from "../js/feed-media.js";
import { likedCategories, orderDiscoverFeed, orderForFeed, suggestedCreators, timeValue } from "../js/feed-ranking.js";

export const VIDEO_URL =
    "https://firebasestorage.googleapis.com/v0/b/cashclique-31718.firebasestorage.app" +
    "/o/videos%2Fu1%2Fclip.mp4?alt=media&token=1f9c5f2a";
export const PHOTO_URL =
    "https://firebasestorage.googleapis.com/v0/b/cashclique-31718.firebasestorage.app" +
    "/o/images%2Fu2%2Fphoto.jpg?alt=media&token=1f9c5f2a";

export const escapeHtmlText = (value) =>
    String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------------------------------------------------------------- DOM stub
export function makeElement(tag) {
    const element = {
        tagName: tag,
        style: {},
        dataset: {},
        attributes: {},
        children: [],
        _html: "",
        _text: "",
        classList: {
            values: new Set(),
            add(name) { this.values.add(name); },
            remove(name) { this.values.delete(name); },
            toggle(name, force) {
                const on = force === undefined ? !this.values.has(name) : !!force;
                if (on) this.values.add(name); else this.values.delete(name);
                return on;
            },
            contains(name) { return this.values.has(name); }
        },
        addEventListener() {},
        appendChild(child) { this.children.push(child); return child; },
        insertAdjacentHTML(_position, markup) { this._html = markup + this._html; },
        setAttribute(key, value) { this.attributes[key] = value; },
        removeAttribute(key) { delete this.attributes[key]; },
        focus() {}, remove() {}, contains() { return false; },
        querySelector() { return makeElement("div"); },
        querySelectorAll() { return []; },
        set innerHTML(value) { this._html = String(value); this._text = ""; },
        get innerHTML() { return this._html || (this._text ? escapeHtmlText(this._text) : ""); },
        set textContent(value) { this._text = String(value); this._html = ""; },
        get textContent() { return this._text; }
    };
    return element;
}

export function makeDom() {
    const registry = new Map();
    const dom = {
        registry,
        created: [],
        getElementById(id) {
            if (!registry.has(id)) registry.set(id, makeElement("div"));
            return registry.get(id);
        },
        createElement(tag) {
            const element = makeElement(tag);
            if (tag === "video") {
                element.playCalls = 0;
                element.play = function () { this.playCalls += 1; return { catch() {} }; };
            }
            dom.created.push(element);
            return element;
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        body: makeElement("body")
    };
    return dom;
}

// ------------------------------------------------------- firebase stub
export function makeFirestore(posts) {
    const calls = { getDocs: [], listeners: [], setDoc: [], batchCommits: [] };
    const snapshotOf = (docs) => ({
        docs,
        size: docs.length,
        empty: docs.length === 0,
        forEach(fn) { docs.forEach(fn); }
    });
    const users = {
        me: { username: "member", avatar: "", isVerified: false },
        u1: { username: "ada", avatar: "", isVerified: true },
        u2: { username: "bola", avatar: "https://cashclique.test/avatars/bola.png", isVerified: false }
    };
    let postRows = posts.slice();
    const postData = new Map(postRows.map(row => [row.id, row.data()]));
    const watchHistory = new Map();
    const userReposts = new Map();
    const postReports = new Map();

    const dataSnapshot = (id, data) => ({
        id,
        exists: () => data !== undefined,
        data: () => data === undefined ? undefined : Object.assign({}, data)
    });
    const pathOf = reference => String(reference && reference.__doc || "");
    const storeForPath = path => {
        if (path.endsWith("/watchHistory") || path.includes("/watchHistory/")) return watchHistory;
        if (path.endsWith("/reposts") || path.includes("/reposts/")) return userReposts;
        if (path.startsWith("postReports/")) return postReports;
        return null;
    };
    const write = (operation, reference, value) => {
        const path = pathOf(reference);
        const id = path.split("/").pop();
        const parts = path.split("/");
        if (parts[0] === "posts") {
            if (operation === "delete") {
                postData.delete(id);
                postRows = postRows.filter(row => row.id !== id);
            } else {
                postData.set(id, Object.assign({}, postData.get(id) || {}, value || {}));
                const row = postDoc(id, postData.get(id));
                const index = postRows.findIndex(item => item.id === id);
                if (index >= 0) postRows[index] = row; else postRows.push(row);
            }
            return;
        }
        const store = storeForPath(path);
        if (!store) return;
        if (operation === "delete") store.delete(id);
        else store.set(id, Object.assign({}, store.get(id) || {}, value || {}));
    };

    const firebase = {
        calls,
        stores: { watchHistory, userReposts, postReports, postData },
        initializeApp: () => ({}),
        getAuth: () => ({ currentUser: { uid: "me" } }),
        getFirestore: () => ({}),
        getMessaging: () => ({}),
        getToken: async () => "token",
        onMessage: () => {},
        signOut: async () => {},
        arrayUnion: (value) => ({ __op: "arrayUnion", value }),
        arrayRemove: (value) => ({ __op: "arrayRemove", value }),
        increment: (value) => ({ __op: "increment", value }),
        serverTimestamp: () => ({ __op: "timestamp", toDate: () => new Date() }),
        addDoc: async () => ({ id: "new" }),
        updateDoc: async (reference, value) => write("set", reference, value),
        setDoc: async (reference, value, options = {}) => {
            const path = pathOf(reference);
            calls.setDoc.push({ path, value, options });
            write("set", reference, value);
        },
        writeBatch: () => {
            const operations = [];
            return {
                set(reference, value) { operations.push(["set", reference, value]); },
                delete(reference) { operations.push(["delete", reference]); },
                update(reference, value) { operations.push(["set", reference, value]); },
                commit: async () => {
                    calls.batchCommits.push(operations.slice());
                    operations.forEach(([operation, reference, value]) => write(operation, reference, value));
                }
            };
        },
        runTransaction: async () => {},
        onSnapshot: (query, _next) => { calls.listeners.push(query); return () => {}; },
        query: (target, ...rest) => ({ target, clauses: rest }),
        collection: (_db, ...path) => ({ __collection: path.join("/") }),
        doc: (_db, ...path) => ({ __doc: path.join("/") }),
        where: (...args) => ({ __where: args }),
        orderBy: (...args) => ({ __orderBy: args }),
        limit: (value) => ({ __limit: value }),
        startAfter: (value) => ({ __startAfter: value }),
        // Enough of Firestore's query surface for the feed: orderBy desc,
        // where("timestamp", "<", cutoff), limit and startAfter.
        getDocs: async (query) => {
            calls.getDocs.push(query);
            const clauses = (query && query.clauses) || [];
            const collectionPath = query && query.target && query.target.__collection || "";
            let rows = [];
            if (collectionPath === "posts") {
                rows = postRows.slice();
            } else if (collectionPath.endsWith("/watchHistory")) {
                rows = Array.from(watchHistory.entries()).map(([id, data]) => postDoc(id, data));
            } else if (collectionPath.endsWith("/reposts")) {
                rows = Array.from(userReposts.entries()).map(([id, data]) => postDoc(id, data));
            }
            const filter = clauses.find(clause => clause && clause.__where);
            if (filter && filter.__where[1] === "<") {
                rows = rows.filter(post => timeValue(post.data()) < filter.__where[2].getTime());
            }
            const order = clauses.find(clause => clause && clause.__orderBy);
            if (order) {
                const field = order.__orderBy[0];
                const stampValue = row => {
                    const data = row.data() || {};
                    const stamp = data[field] || data.timestamp;
                    return timeValue({ timestamp: stamp });
                };
                rows.sort((a, b) => stampValue(b) - stampValue(a));
            }
            const limited = clauses.find(clause => clause && clause.__limit);
            const after = clauses.find(clause => clause && clause.__startAfter);
            let startIndex = 0;
            if (after) {
                const index = rows.findIndex(item => item === after.__startAfter);
                startIndex = index >= 0 ? index + 1 : rows.length;
            }
            const wanted = limited ? limited.__limit : rows.length;
            return snapshotOf(rows.slice(startIndex, startIndex + wanted));
        },
        getDoc: async (reference) => {
            const path = pathOf(reference);
            const parts = path.split("/");
            const id = parts[parts.length - 1];
            if (parts[0] === "users" && parts.length === 2) return dataSnapshot(id, users[id]);
            if (parts[0] === "posts") return dataSnapshot(id, postData.get(id));
            const store = storeForPath(path);
            if (store) return dataSnapshot(id, store.get(id));
            return dataSnapshot(id, undefined);
        },
        onAuthStateChanged: (_auth, callback) => { onAuth = callback; }
    };
    let onAuth = null;
    firebase.runAuth = (user) => onAuth(user);
    return firebase;
}


export function runDashboard(posts, overrides = {}) {
    const html = readFileSync(new URL("../dashboard.html", import.meta.url), "utf8");
    const start = html.indexOf('<script type="module">') + '<script type="module">'.length;
    const script = html.slice(start, html.lastIndexOf("</script>"));
    // Drop the CDN import statements: every name they provide is stubbed below.
    const source = script.replace(/^import[\s\S]*?from\s+"[^"]+";\s*$/gm, "");

    const dom = makeDom();
    const firebase = makeFirestore(posts);
    const context = {
        ...firebase,
        // Real data-saver helpers, so the markup under test is the shipped one.
        autoplayVideoHTML, lazyImageFrameHTML, postImageSrc, postMediaKind, videoShellHTML, playVideoInShell, primeAutoplayVideo,
        likedCategories, orderDiscoverFeed, orderForFeed, suggestedCreators, timeValue,
        createWatermarkedJpeg: async () => ({ blob: null, filename: "x.jpg" }),
        createVideoDownload: async () => ({ blob: null, filename: "x.mp4" }),
        downloadBlob: () => {},
        mediaFilename: (id, extension) => `${id}.${extension}`,
        document: dom,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        URL, URLSearchParams, Promise, Math, Date, JSON, Object, Array, String, Number, Set, Map, Error,
        console: { log() {}, warn() {}, error() {} },
        setTimeout: () => 0,          // deferred work (FCM, debounce) never fires here
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        encodeURIComponent, decodeURIComponent, parseInt, parseFloat, isNaN,
        alert() {},
        IntersectionObserver: class {
            constructor(callback) { this.callback = callback; }
            observe() {} unobserve() {} disconnect() {}
        },
        Notification: { requestPermission: async () => "denied" },
        navigator: { share: null, clipboard: { writeText: async () => {} } }
    };
    // In a browser `window` is the global object; mirror that so `window.fn = ...`
    // assignments are reachable the same way the page reaches them.
    context.window = context;
    context.location = {
        href: "https://cashclique.test/dashboard.html",
        search: "",
        origin: "https://cashclique.test"
    };
    context.history = { replaceState() {} };
    context.scrollTo = () => {};
    context.scrollY = 0;
    context.addEventListener = () => {};
    context.globalThis = context;
    Object.assign(context, overrides);

    vm.runInNewContext(source, context, { filename: "dashboard.html" });
    firebase.runAuth({ uid: "me", email: "me@cashclique.test" });
    return { context, dom, firebase };
}

export const flushTimes = async (times = 8) => {
    for (let i = 0; i < times; i++) await new Promise(resolve => setImmediate(resolve));
};

export function postDoc(id, data) {
    return { id, data: () => data };
}

export const SAMPLE_POSTS = [
    postDoc("video1", {
        userId: "u1", username: "ada", content: "Morning routine, but make it fast.",
        category: "Daily Life", videoUrl: VIDEO_URL, likes: 128, commentCount: 14, views: 640,
        timestamp: { toDate: () => new Date("2026-09-18T09:00:00Z") }
    }),
    postDoc("photo1", {
        userId: "u2", username: "bola", content: "Match day energy.",
        category: "Sports", imageUrl: PHOTO_URL, likes: 64, commentCount: 5, views: 210,
        timestamp: { toDate: () => new Date("2026-09-18T08:30:00Z") }
    }),
    postDoc("text1", {
        userId: "u1", username: "ada", content: "What should I post next?",
        category: "Comedy", likes: 9, commentCount: 3, views: 40,
        timestamp: { toDate: () => new Date("2026-09-18T08:00:00Z") }
    })
];
