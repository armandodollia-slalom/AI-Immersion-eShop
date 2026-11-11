// Counts down to the promotion's end ("Xd Yh Zm left") and hides the banner at zero,
// with no reload. The banner is static SSR and its <script> tag is part of the
// component, so init is idempotent and re-runs after Blazor enhanced navigation
// (which swaps the banner markup).
(function () {
    if (window.__promoCountdownLoaded) {
        if (window.__promoCountdownInit) window.__promoCountdownInit();
        return;
    }
    window.__promoCountdownLoaded = true;

    let timer = 0;

    function format(ms) {
        const totalMinutes = Math.floor(ms / 60000);
        const d = Math.floor(totalMinutes / 1440);
        const h = Math.floor((totalMinutes % 1440) / 60);
        const m = totalMinutes % 60;
        return d + 'd ' + h + 'h ' + m + 'm left';
    }

    function tick() {
        const els = document.querySelectorAll('[data-promo-countdown]');
        if (!els.length) {
            clearInterval(timer);
            timer = 0;
            return;
        }
        els.forEach(el => {
            const end = Date.parse(el.getAttribute('data-ends-at') || '');
            if (isNaN(end)) return;
            const remaining = end - Date.now();
            const banner = el.closest('[data-promo-banner]');
            if (remaining <= 0) {
                if (banner) banner.hidden = true;
                return;
            }
            if (banner) banner.hidden = false;
            el.textContent = format(remaining);
        });
    }

    function init() {
        tick();
        if (!timer) timer = setInterval(tick, 1000);
    }
    window.__promoCountdownInit = init;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    (function hookEnhancedNav() {
        if (window.Blazor && typeof window.Blazor.addEventListener === 'function') {
            window.Blazor.addEventListener('enhancedload', () => setTimeout(init, 0));
        } else {
            setTimeout(hookEnhancedNav, 150);
        }
    })();
})();
