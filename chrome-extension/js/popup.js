// Model registry helpers (PROVIDERS, REASONING_MODES, readModelStore, …)
// come from js/models.js, loaded ahead of this file.

const modelList = document.getElementById('model-list');
const addDetails = document.getElementById('add-model');
const nmModel = document.getElementById('nm-model');
const nmProvider = document.getElementById('nm-provider');
const nmReasoning = document.getElementById('nm-reasoning');
const nmError = document.getElementById('nm-error');
const nmAdd = document.getElementById('nm-add');
const contextRange = document.getElementById('context-range');
const contextVal = document.getElementById('context-val');
const wordRange = document.getElementById('word-spacing-range');
const wordVal = document.getElementById('word-spacing-val');
const keyGroq = document.getElementById('key-groq');
const keyGemini = document.getElementById('key-gemini');

// Local mirror of the stored registry; every edit rewrites it wholesale.
let models = [];
let selectedModelId = null;

function fillSelect(el, options) {
  el.innerHTML = '';
  options.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    el.appendChild(opt);
  });
}
fillSelect(nmProvider, PROVIDERS);
fillSelect(nmReasoning, REASONING_MODES);
nmProvider.value = DEFAULT_PROVIDER;
nmReasoning.value = DEFAULT_REASONING;

function saveModels() {
  chrome.storage.local.set({ models, selectedModelId });
}

function renderModels() {
  modelList.innerHTML = '';
  // Every model is removable, so the list can legitimately end up empty.
  if (!models.length) {
    const empty = document.createElement('div');
    empty.className = 'model-empty';
    empty.textContent = 'none — add one below';
    modelList.appendChild(empty);
    return;
  }
  const current = currentModel(models, selectedModelId);
  models.forEach(m => {
    const row = document.createElement('div');
    row.className = 'model-row';

    // The label and the trash are both real buttons, so the row is a
    // wrapper rather than one element — nesting them would be invalid.
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'model-pick' + (m === current ? ' selected' : '');
    pick.title = m.model;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = m.model;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = providerOf(m).value
      + (m.reasoning === 'off' ? '' : ' · ' + m.reasoning);
    pick.append(name, tag);
    pick.addEventListener('click', () => {
      selectedModelId = m.id;
      saveModels();
      renderModels();
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'model-del';
    del.title = `Remove ${m.model}`;
    del.setAttribute('aria-label', del.title);
    del.textContent = '×';
    del.addEventListener('click', () => {
      if (!confirm(`Remove "${m.model}"?`)) return;
      selectedModelId = removeModel(models, selectedModelId, m.id);
      saveModels();
      renderModels();
    });

    row.append(pick, del);
    modelList.appendChild(row);
  });
}

function submitModel() {
  const id = nmModel.value.trim();
  if (!id) {
    nmError.textContent = 'Enter a model ID, the name the provider knows it by.';
    nmError.hidden = false;
    return;
  }
  const added = addModel(models, id, nmProvider.value, nmReasoning.value);
  if (!added) {
    nmError.textContent = `"${id}" is already in the list.`;
    nmError.hidden = false;
    return;
  }
  nmError.hidden = true;
  selectedModelId = added.id;   // adding it means you want to use it
  saveModels();
  nmModel.value = '';
  nmProvider.value = DEFAULT_PROVIDER;
  nmReasoning.value = DEFAULT_REASONING;
  addDetails.open = false;
  renderModels();
}

nmAdd.addEventListener('click', submitModel);
nmModel.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); submitModel(); }
});

// Load settings
chrome.storage.local.get([...MODEL_STORE_KEYS, 'contextSentences', 'popupWordSpacing', 'apiKeys'], (res) => {
  ({ models, selectedModelId } = readModelStore(res));
  renderModels();
  if (res.contextSentences !== undefined) {
    contextRange.value = res.contextSentences;
    contextVal.textContent = res.contextSentences;
  }
  const ws = res.popupWordSpacing === undefined ? 0 : res.popupWordSpacing;
  wordRange.value = ws;
  wordVal.textContent = ws + 'px';
  if (res.apiKeys) {
    keyGroq.value = res.apiKeys.GROQ_API_KEY || '';
    keyGemini.value = res.apiKeys.GEMINI_API_KEY || '';
  }
});

contextRange.addEventListener('input', () => {
  contextVal.textContent = contextRange.value;
  chrome.storage.local.set({ contextSentences: parseInt(contextRange.value) });
});

wordRange.addEventListener('input', () => {
  wordVal.textContent = wordRange.value + 'px';
  chrome.storage.local.set({ popupWordSpacing: parseFloat(wordRange.value) });
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
