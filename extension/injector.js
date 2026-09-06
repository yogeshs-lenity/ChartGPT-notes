// Runs in the MAIN world at document_start — shares the page's JS context.
// Wraps window.fetch so that when ChatGPT loads a conversation it caches the
// full JSON in window.__cgn_conv__ for content.js to read.
(function () {
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await _fetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
      if (/\/backend-api\/conversation\/[a-f0-9-]+(?:[?#]|$)/.test(url)) {
        resp.clone().json().then(d => {
          if (d?.mapping) window.__cgn_conv__ = d;
        }).catch(() => {});
      }
    } catch {}
    return resp;
  };
})();
