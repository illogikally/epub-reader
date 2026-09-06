// ============================================================
// Model registry — ported from the reader's js/state.js.
//
// Models used to be a fixed two-entry MODELS array picked by index
// (settings.selectedModelIdx). They are now one flat, fully editable list:
// every entry can be removed, new ones added by the id the provider knows
// them by, and the selection is an id rather than an index into a constant.
//
// Loaded by both the popup and the content script, so everything here is a
// plain global — content scripts are not ES modules.
// ============================================================

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_URL = 'https://generativelanguage.googleapis.com';

// Where a model is served from, which key it is filed under, and which
// request shape it speaks. Per-provider rather than per-model, so an added
// model only has to name its provider.
const PROVIDERS = [
  { value: 'groq',   label: 'Groq',   url: GROQ_URL,   format: 'openai', keyRef: 'GROQ_API_KEY' },
  { value: 'gemini', label: 'Gemini', url: GEMINI_URL, format: 'google', keyRef: 'GEMINI_API_KEY' },
];
const DEFAULT_PROVIDER = 'groq';

function providerOf(model) {
  return PROVIDERS.find(p => p.value === model?.provider) || PROVIDERS[0];
}

// Groq's text models share one endpoint but not one request shape:
// `reasoning_effort` is the part that varies. gpt-oss takes low, qwen3 takes
// none, and llama/gemma/mixtral reject the parameter outright — sending it to
// a model that doesn't support it fails the whole request, so it is a
// per-model setting rather than something guessed from the model's name.
const REASONING_MODES = [
  { value: 'off',  label: 'off' },    // parameter omitted entirely
  { value: 'none', label: 'none' },
  { value: 'low',  label: 'low' },
];
const DEFAULT_REASONING = 'off';      // the only value every model accepts

// Seeded on first run, and ordinary models from then on: nothing here is
// fixed, every one of them can be removed.
const SEED_MODELS = [
  { id: 'groq-gpt-oss-120b', provider: 'groq', model: 'openai/gpt-oss-120b', reasoning: 'low' },
  { id: 'groq-qwen3-8-27b',  provider: 'groq', model: 'qwen/qwen3.8-27b',    reasoning: 'none' },
];
const DEFAULT_MODEL_ID = SEED_MODELS[0].id;

// The storage keys this module owns — hand them to chrome.storage.local.get.
const MODEL_STORE_KEYS = ['models', 'selectedModelId', 'selectedModelIdx'];

function newModelId() {
  return 'model-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function normaliseModels(list) {
  return (Array.isArray(list) ? list : [])
    .filter(m => m && typeof m.model === 'string' && m.model.trim())
    .map(m => ({
      id: m.id || newModelId(),
      provider: PROVIDERS.some(p => p.value === m.provider) ? m.provider : DEFAULT_PROVIDER,
      model: m.model.trim(),
      reasoning: REASONING_MODES.some(r => r.value === m.reasoning) ? m.reasoning : DEFAULT_REASONING,
    }));
}

// Pulls { models, selectedModelId } out of a chrome.storage.local result,
// seeding a first run and carrying the old index-based selection over.
function readModelStore(res) {
  const models = Array.isArray(res.models)
    ? normaliseModels(res.models)
    : SEED_MODELS.map(m => ({ ...m }));
  let selectedModelId;
  if (typeof res.selectedModelId === 'string') {
    selectedModelId = res.selectedModelId;
  } else if (typeof res.selectedModelIdx === 'number') {
    selectedModelId = SEED_MODELS[res.selectedModelIdx]?.id || DEFAULT_MODEL_ID;
  } else {
    selectedModelId = DEFAULT_MODEL_ID;
  }
  return { models, selectedModelId };
}

// Null when the list is empty — every model can be removed, so that is a
// state the caller has to cope with rather than an impossible one.
function currentModel(models, selectedModelId) {
  return models.find(m => m.id === selectedModelId) || models[0] || null;
}

// Returns the new entry, or null if that model id is already in the list.
function addModel(models, modelId, provider, reasoning) {
  const model = String(modelId || '').trim();
  if (!model) return null;
  if (models.some(m => m.model.toLowerCase() === model.toLowerCase())) return null;
  const entry = {
    id: newModelId(),
    provider: PROVIDERS.some(p => p.value === provider) ? provider : DEFAULT_PROVIDER,
    model,
    reasoning: REASONING_MODES.some(r => r.value === reasoning) ? reasoning : DEFAULT_REASONING,
  };
  models.push(entry);
  return entry;
}

// Mutates `models` and returns the selection to keep — never one pointing at
// something that no longer exists (null once the list is empty).
function removeModel(models, selectedModelId, id) {
  const idx = models.findIndex(m => m.id === id);
  if (idx < 0) return selectedModelId;
  models.splice(idx, 1);
  if (selectedModelId === id) return models[0]?.id || null;
  return selectedModelId;
}
