const modelSelect = document.getElementById('model-select');
const contextRange = document.getElementById('context-range');
const contextVal = document.getElementById('context-val');
const keyGroq = document.getElementById('key-groq');
const keyGemini = document.getElementById('key-gemini');

// Load settings
chrome.storage.local.get(['selectedModelIdx', 'contextSentences', 'apiKeys'], (res) => {
  if (res.selectedModelIdx !== undefined) modelSelect.value = res.selectedModelIdx;
  if (res.contextSentences !== undefined) {
    contextRange.value = res.contextSentences;
    contextVal.textContent = res.contextSentences;
  }
  if (res.apiKeys) {
    keyGroq.value = res.apiKeys.GROQ_API_KEY || '';
    keyGemini.value = res.apiKeys.GEMINI_API_KEY || '';
  }
});

// Save on change
modelSelect.addEventListener('change', () => {
  chrome.storage.local.set({ selectedModelIdx: parseInt(modelSelect.value) });
});

contextRange.addEventListener('input', () => {
  contextVal.textContent = contextRange.value;
  chrome.storage.local.set({ contextSentences: parseInt(contextRange.value) });
});

const saveKeys = () => {
  chrome.storage.local.set({
    apiKeys: {
      GROQ_API_KEY: keyGroq.value.trim(),
      GEMINI_API_KEY: keyGemini.value.trim()
    }
  });
};

keyGroq.addEventListener('input', saveKeys);
keyGemini.addEventListener('input', saveKeys);
