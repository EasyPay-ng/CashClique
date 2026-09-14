import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync(new URL("../js/theme.js", import.meta.url), "utf8");

function browser({ saved = null, blocked = false, sidebar = false, feed = false } = {}) {
    const storage = new Map(saved === null ? [] : [["cc_theme", saved]]);
    const events = {};
    const ready = {};
    const label = {};
    const attributes = {};
    const clicks = {};
    let mounted = "";
    const button = {
        classList: { add() {} },
        setAttribute(key, value) { attributes[key] = value; },
        querySelector() { return label; },
        addEventListener(key, listener) { clicks[key] = listener; }
    };
    const nav = { querySelector() { return { after() { mounted = "sidebar"; } }; } };
    const root = { dataset: {} };
    const document = {
        documentElement: root,
        readyState: "loading",
        createElement() { return button; },
        querySelector(selector) { return selector === ".sidebar" ? (sidebar ? nav : null) : (feed ? {} : null); },
        body: { appendChild() { mounted = "body"; } },
        addEventListener(key, listener) { ready[key] = listener; }
    };
    vm.runInNewContext(script, {
        document,
        localStorage: {
            getItem(key) { if (blocked) throw new Error("blocked"); return storage.get(key) ?? null; },
            setItem(key, value) { if (blocked) throw new Error("blocked"); storage.set(key, value); }
        },
        window: { addEventListener(key, listener) { events[key] = listener; } }
    });
    return { root, attributes, label, storage, events, clicks, mount() { ready.DOMContentLoaded(); return mounted; } };
}

test("theme: restores the saved preference before DOM content loads", () => {
    const page = browser({ saved: "dark" });
    assert.equal(page.root.dataset.theme, "dark");
    page.mount();
    assert.equal(page.attributes.role, "switch");
    assert.equal(page.attributes["aria-checked"], "true");
    assert.equal(page.label.textContent, "Dark mode");
});

test("theme: both choices persist across reloads and returning visits", () => {
    let page = browser();
    page.mount();
    assert.equal(page.root.dataset.theme, "light");
    for (const choice of ["dark", "light"]) {
        page.clicks.click();
        assert.equal(page.storage.get("cc_theme"), choice);
        page = browser({ saved: page.storage.get("cc_theme") });
        assert.equal(page.root.dataset.theme, choice);
        page.mount();
        assert.equal(page.attributes["aria-checked"], String(choice === "dark"));
    }
});

test("theme: invalid preferences default to light and blocked storage does not break the switch", () => {
    assert.equal(browser({ saved: "invalid" }).root.dataset.theme, "light");
    const page = browser({ blocked: true });
    page.mount();
    assert.doesNotThrow(() => page.clicks.click());
    assert.equal(page.root.dataset.theme, "dark");
});

test("theme: other tabs stay in sync, including cleared storage", () => {
    const page = browser();
    page.mount();
    page.events.storage({ key: "cc_theme", newValue: "dark" });
    assert.equal(page.root.dataset.theme, "dark");
    assert.equal(page.attributes["aria-checked"], "true");
    page.events.storage({ key: "unrelated", newValue: "light" });
    assert.equal(page.root.dataset.theme, "dark");
    page.events.storage({ key: null, newValue: null });
    assert.equal(page.root.dataset.theme, "light");
});

test("theme: only the immersive feed puts its switch in the menu", () => {
    assert.equal(browser({ sidebar: true, feed: true }).mount(), "sidebar");
    assert.equal(browser({ sidebar: true }).mount(), "body", "desktop-only sidebars must not hide the switch on mobile");
    assert.equal(browser().mount(), "body");
});

test("theme: every app page loads the shared switch before styles and the theme CSS last", () => {
    const root = new URL("../", import.meta.url);
    for (const name of readdirSync(root).filter(name => name.endsWith(".html"))) {
        const html = readFileSync(new URL(name, root), "utf8");
        assert.doesNotMatch(html, /var\(--var\(/, `${name}: custom property names remain valid`);
        const scriptIndex = html.indexOf('<script src="js/theme.js">');
        const stylesIndex = html.indexOf('href="assets/theme.css"');
        assert.ok(scriptIndex > 0 && scriptIndex < html.indexOf("<style"), `${name}: early theme restoration`);
        assert.ok(stylesIndex > html.lastIndexOf("</style>") && stylesIndex < html.indexOf("</head>"), `${name}: shared stylesheet`);
    }
});
