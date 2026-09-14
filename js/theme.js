/* Shared, device-local appearance preference. Run in <head> before first paint. */
(() => {
    const storageKey = "cc_theme";
    const root = document.documentElement;
    let current = "light";
    let toggle;

    function apply(value) {
        current = value === "dark" ? "dark" : "light";
        root.dataset.theme = current;
        if (toggle) {
            toggle.setAttribute("aria-checked", String(current === "dark"));
            toggle.querySelector(".cc-theme-label").textContent = current === "dark" ? "Dark mode" : "Light mode";
        }
    }

    try { current = localStorage.getItem(storageKey); } catch (_) { /* Storage may be blocked. */ }
    apply(current);

    window.addEventListener("storage", (event) => {
        if (event.key === storageKey || event.key === null) apply(event.newValue);
    });

    function mount() {
        toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "cc-theme-toggle";
        toggle.setAttribute("role", "switch");
        toggle.setAttribute("aria-label", "Dark mode");
        toggle.innerHTML = '<span class="cc-theme-label"></span><span class="cc-theme-track" aria-hidden="true"><span></span></span>';
        toggle.addEventListener("click", () => {
            apply(current === "dark" ? "light" : "dark");
            try { localStorage.setItem(storageKey, current); } catch (_) { /* Keep the switch usable without storage. */ }
        });
        const sidebar = document.querySelector(".sidebar");
        // The immersive feed uses its menu; other pages keep the switch
        // visible even when their desktop-only sidebar is hidden on mobile.
        if (sidebar && document.querySelector(".video-container")) {
            const logo = sidebar.querySelector(".sidebar-logo, .logo");
            if (logo) logo.after(toggle);
            else sidebar.prepend(toggle);
        } else {
            toggle.classList.add("cc-theme-floating");
            document.body.appendChild(toggle);
        }
        apply(current);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
    else mount();
})();
