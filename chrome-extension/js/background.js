chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.action === 'fetchOxfordHtml') {
    fetch(req.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
      .then(res => res.ok ? res.text() : '')
      .then(html => sendResponse({ html }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // Keep message channel open for async response
  }
});
