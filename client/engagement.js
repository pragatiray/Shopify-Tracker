; (function EngagementTracker() {
    'use strict';
    // --- CONFIGURATION ---
    // Change this to your production backend or ngrok URL
    var API_ENDPOINT = 'https://YOUR_BACKEND_URL.com/analyze';
    var FLUSH_INTERVAL = 30000;
    var SESSION_ID = (function () {
        var id = sessionStorage.getItem('_et_sid') || Math.random().toString(36).substring(2, 15);
        sessionStorage.setItem('_et_sid', id);
        return id;
    })();

    var _pageStart = Date.now();

    /* ─── State Management ─── */
    function getQueue() { return JSON.parse(sessionStorage.getItem('_et_q') || '[]'); }
    function saveQueue(q) { sessionStorage.setItem('_et_q', JSON.stringify(q)); }
    function clearTracker() { sessionStorage.removeItem('_et_q'); }

    function pushEvent(type, payload) {
        if (sessionStorage.getItem('_et_modal_shown')) return;
        var q = getQueue();
        q.push({ type: type, timestamp: new Date().toISOString(), payload: payload });
        saveQueue(q);
    }

    function recordTime() {
        var now = Date.now();
        var seconds = Math.round((now - _pageStart) / 1000);
        if (seconds > 0) {
            pushEvent('time_on_page', { seconds: seconds });
            _pageStart = now;
        }
    }

    function flush() {
        // 1. Exit if modal already shown
        if (sessionStorage.getItem('_et_modal_shown')) return;

        // 2. Always attempt to record time first
        recordTime();

        // 3. Get the queue AFTER time recording
        var eventsToSend = getQueue();

        // Debugging: Log the queue to your console so you can see it working
        console.log('[ET] Attempting flush. Events in queue:', eventsToSend.length);

        if (eventsToSend.length === 0) return;

        fetch(API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true'
            },
            body: JSON.stringify({ sessionId: SESSION_ID, events: eventsToSend }),
            keepalive: true
        })
            .then(function (res) { return res.json(); })
            .then(handleApiResponse)
            .catch(function (err) { console.error('[ET] Sync failed:', err); });
    }

    function handleApiResponse(data) {
        console.log('[ET] Backend response:', data);
        if (data && data.trigger && !sessionStorage.getItem('_et_modal_shown')) {
            sessionStorage.setItem('_et_modal_shown', '1');
            clearTracker();
            showModal(data.message || "Checking in! Do you have any questions?");
        }
    }

    /* ─── Tracking Listeners ─── */

    // Initial Page View
    pushEvent('page_view', { url: location.href, title: document.title });

    // Improved Click Listener
    document.addEventListener('click', function (e) {
        // Look for the Add to Cart button or any element inside it
        var atc = e.target.closest('[name="add"]') ||
            e.target.closest('form[action*="/cart/add"] button') ||
            e.target.closest('.ad-to-cart-button'); // Add common Shopify classes

        if (atc) {
            console.log('[ET] Add to Cart detected');
            pushEvent('click', {
                action: 'add_to_cart',
                text: atc.innerText.trim().substring(0, 30)
            });

            // Small delay to ensure pushEvent finishes writing to sessionStorage 
            // before flush reads it
            setTimeout(flush, 50);
        }
    }, true);

    // Periodic flush
    setInterval(flush, FLUSH_INTERVAL);

    window.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flush();
    });

    /* ──────────────────────── MODAL UI ───────────────────────────── */

    function showModal(message) {
        var styleId = '_et_modal_style';
        if (!document.getElementById(styleId)) {
            var css = document.createElement('style');
            css.id = styleId;
            css.textContent = [
                '#_et_overlay{position:fixed;inset:0;z-index:9999999;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.4);font-family:sans-serif;}',
                '#_et_card{background:#fff;max-width:400px;width:90%;margin-bottom:40px;padding:20px;border-radius:12px;position:relative;box-shadow:0 10px 25px rgba(0,0,0,0.2);}',
                '#_et_close{position:absolute;top:10px;right:10px;border:none;background:none;font-size:18px;cursor:pointer;}'
            ].join('');
            document.head.appendChild(css);
        }

        var overlay = document.createElement('div');
        overlay.id = '_et_overlay';
        overlay.innerHTML = '<div id="_et_card"><button id="_et_close">&times;</button><p>' + escapeHtml(message) + '</p></div>';
        document.body.appendChild(overlay);

        document.getElementById('_et_close').onclick = function () {
            overlay.remove();
        };
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

})();
