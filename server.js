/**
 * NVIDIA NIM Proxy Server
 * OpenAI-compatible proxy with multi-key rotation, fallback, and Web UI
 * Use: http://localhost:3000/v1 as base_url in OpenClaw / any OpenAI-compatible client
 */

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000');
const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';
const NVIDIA_IMAGE_ENDPOINTS = ['/images/generations', '/genai/images/generations'];

async function postImageGeneration(keyValue, payload) {
  let lastRes = null;
  for (const ep of NVIDIA_IMAGE_ENDPOINTS) {
    const r = await fetch(`${NVIDIA_BASE}${ep}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keyValue}` },
      body: JSON.stringify(payload)
    });
    lastRes = r;
    if (r.ok || r.status !== 404) return { res: r, endpoint: ep };
  }
  return { res: lastRes, endpoint: NVIDIA_IMAGE_ENDPOINTS[NVIDIA_IMAGE_ENDPOINTS.length - 1] };
}
const ENV_FILE = path.join(__dirname, '.env');
const PIPELINES_FILE = path.join(__dirname, 'pipelines.json');
const LOGS_FILE = path.join(__dirname, 'logs.local.json');
const USER_MODELS_FILE = path.join(__dirname, 'user_models.local.json');
const MAX_LOGS = 1000;
const PIPELINE_MAX_CONCURRENCY = parseInt(process.env.PIPELINE_MAX_CONCURRENCY || '3');
const PIPELINE_PLANNER_TIMEOUT_MS = parseInt(process.env.PIPELINE_PLANNER_TIMEOUT_MS || '90000');
const PIPELINE_SUBTASK_TIMEOUT_MS = parseInt(process.env.PIPELINE_SUBTASK_TIMEOUT_MS || '90000');

// ─── State ────────────────────────────────────────────────────────────────────
let keys = [];          // { id, value, label, active, addedAt, stats }
let currentKeyIndex = 0;
let logs = [];
let logIdCounter = 0;
let requestCounter = 0;
let pipelines = [];     // { id, name, slug, models:{planner,synthesizer,...}, maxSubtasks, createdAt, stats }
let userModels = [];
const pipelineConcurrency = new Map();

// ─── .env loader/saver ────────────────────────────────────────────────────────
function loadKeysFromEnv() {
  const loaded = [];
  let i = 1;
  while (true) {
    const val = process.env[`NVIDIA_API_KEY_${i}`];
    if (!val) break;
    loaded.push({
      id: `key_${i}`,
      value: val.trim(),
      label: process.env[`NVIDIA_API_KEY_${i}_LABEL`] || `Key ${i}`,
      active: true,
      addedAt: new Date().toISOString(),
      stats: { requests: 0, success: 0, errors: 0, quota: 0, lastUsed: null, lastError: null }
    });
    i++;
  }
  // Also check legacy single key
  if (loaded.length === 0 && process.env.NVIDIA_API_KEY) {
    loaded.push({
      id: 'key_1',
      value: process.env.NVIDIA_API_KEY.trim(),
      label: 'Default Key',
      active: true,
      addedAt: new Date().toISOString(),
      stats: { requests: 0, success: 0, errors: 0, quota: 0, lastUsed: null, lastError: null }
    });
  }
  return loaded;
}

function saveKeysToEnv() {
  try {
    let envContent = `# NVIDIA NIM Proxy - API Keys\n# Auto-managed by proxy server\n# Do not edit manually while server is running\n\n`;
    envContent += `PORT=${PORT}\n\n`;
    keys.forEach((k, i) => {
      envContent += `NVIDIA_API_KEY_${i + 1}=${k.value}\n`;
      envContent += `NVIDIA_API_KEY_${i + 1}_LABEL=${k.label}\n`;
    });
    fs.writeFileSync(ENV_FILE, envContent, 'utf8');
    return true;
  } catch (e) {
    console.error('[env] Failed to save .env:', e.message);
    return false;
  }
}

// ─── Key Manager ──────────────────────────────────────────────────────────────
function maskKey(val) {
  if (!val || val.length < 12) return '****';
  return val.slice(0, 8) + '********' + val.slice(-4);
}

function getActiveKeys() {
  return keys.filter(k => k.active);
}

function getNextKey(triedIds = []) {
  const active = getActiveKeys();
  if (active.length === 0) return null;

  // Start from currentKeyIndex, find one not in triedIds
  for (let i = 0; i < active.length; i++) {
    const idx = (currentKeyIndex + i) % active.length;
    const k = active[idx];
    if (!triedIds.includes(k.id)) {
      currentKeyIndex = (idx + 1) % active.length;
      return k;
    }
  }
  return null;
}

function recordKeyUsage(id, result, extra = {}) {
  const k = keys.find(k => k.id === id);
  if (!k) return;
  k.stats.requests++;
  k.stats.lastUsed = new Date().toISOString();
  if (result === 'success') k.stats.success++;
  if (result === 'error') {
    k.stats.errors++;
    k.stats.lastError = extra.error || 'unknown';
  }
  if (result === 'quota') {
    k.stats.quota++;
    k.stats.lastError = '429 quota exceeded';
  }
}

// ─── Internal Model Caller ────────────────────────────────────────────────────
// Non-streaming call to any NVIDIA model with key rotation + retry
async function callModel(modelId, messages, maxTokens = 2048, timeoutMs = 90000) {
  const triedIds = [];
  let lastError = 'No active keys';
  for (let attempt = 0; attempt < Math.min(keys.length || 1, 3); attempt++) {
    const key = getNextKey(triedIds);
    if (!key) break;
    triedIds.push(key.id);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(`${NVIDIA_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key.value}` },
        body: JSON.stringify({ model: modelId, messages, max_tokens: maxTokens, temperature: 0.2, stream: false }),
        signal: ctrl.signal
      });
      clearTimeout(timer);
      const data = await res.json();
      if (res.status === 429) { recordKeyUsage(key.id, 'quota'); lastError = '429 quota'; continue; }
      if (!res.ok) { recordKeyUsage(key.id, 'error', { error: data.error?.message }); lastError = data.error?.message || `HTTP ${res.status}`; continue; }
      recordKeyUsage(key.id, 'success');
      return data.choices?.[0]?.message?.content || '';
    } catch (e) {
      recordKeyUsage(key.id, 'error', { error: e.message });
      lastError = e.message;
    }
  }
  throw new Error(`callModel(${modelId}) failed: ${lastError}`);
}


function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callModelWithRetry(modelId, messages, maxTokens = 2048, retries = 2, timeoutMs = 90000) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try { return await callModel(modelId, messages, maxTokens, timeoutMs); }
    catch (e) {
      lastErr = e;
      if (i < retries) await sleep(250 * (2 ** i));
    }
  }
  throw lastErr || new Error('Unknown model call failure');
}

// ─── Pipeline Manager ─────────────────────────────────────────────────────────
function loadPipelines() {
  try {
    if (fs.existsSync(PIPELINES_FILE)) return JSON.parse(fs.readFileSync(PIPELINES_FILE, 'utf8'));
  } catch (e) { console.error('[pipelines] Load failed:', e.message); }
  return [];
}
function savePipelines() {
  try { fs.writeFileSync(PIPELINES_FILE, JSON.stringify(pipelines, null, 2), 'utf8'); return true; }
  catch (e) { console.error('[pipelines] Save failed:', e.message); return false; }
}

const PLANNER_SYSTEM = `You are a task decomposition expert for an AI pipeline system.
Analyze the user's request and break it into 1-5 focused subtasks for specialist models.

Rules:
- Each subtask must be SELF-CONTAINED (include all needed context)
- Subtasks run IN PARALLEL — they cannot depend on each other
- Only decompose if the task genuinely has multiple distinct aspects
- For simple tasks, return a single subtask

Valid types: general, code, reasoning, math, creative, summarization, translation, factual, multimodal

Return ONLY valid JSON (no markdown fences, no explanation):
[{"type":"code","label":"Fix the auth bug","prompt":"...full focused prompt with all context..."}]`;

const SYNTHESIZER_SYSTEM = `You are synthesizing outputs from multiple specialist AI models into a single coherent answer.
Integrate all results naturally — do NOT mention "Specialist A said..." or "according to model X".
Just present the best unified answer. If specialists overlap, keep the most accurate/specific version.
If specialists contradict, prefer the more detailed/confident one.
Format the answer clearly and practically for the user.`;

async function runPipeline(pipeline, messages, clientRes, opts = {}) {
  const emitStatusEvents = opts.emitStatusEvents !== false;
  const startTime = Date.now();
  const activeForPipeline = pipelineConcurrency.get(pipeline.id) || 0;
  if (activeForPipeline >= PIPELINE_MAX_CONCURRENCY) {
    clientRes.status(429).json({ error: { message: `Pipeline busy (max ${PIPELINE_MAX_CONCURRENCY} concurrent runs). Try again shortly.`, type: 'proxy_error', code: 'pipeline_concurrency_limit' } });
    return;
  }
  pipelineConcurrency.set(pipeline.id, activeForPipeline + 1);

  function sse(eventName, data) {
    if (!emitStatusEvents) return;
    clientRes.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  // Set SSE headers
  clientRes.setHeader('Content-Type', 'text/event-stream');
  clientRes.setHeader('Cache-Control', 'no-cache');
  clientRes.setHeader('X-Accel-Buffering', 'no');
  clientRes.flushHeaders?.();

  const originalRequest = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';

  try {
    // ── Step 1: Plan ───────────────────────────────────────────────────────
    sse('pipeline_status', { step: 'planning', model: pipeline.models.planner, message: 'Breaking task into subtasks...' });
    console.log(`[pipeline:${pipeline.slug}] Planning with ${pipeline.models.planner}`);

    let plan = [];
    const enabledTasks = (pipeline.enabledTasks && typeof pipeline.enabledTasks === 'object') ? pipeline.enabledTasks : Object.fromEntries(Object.keys(PIPELINE_DEFAULT_MODELS).filter(t => !['planner', 'synthesizer'].includes(t)).map(t => [t, true]));
    const enabledCustomTasks = (pipeline.customTasks || []).filter(t => t && t.enabled !== false && t.id && t.model);
    const enabledCustomIds = enabledCustomTasks.map(t => t.id);
    try {
      const planText = await callModelWithRetry(pipeline.models.planner, [
        { role: 'system', content: `${PLANNER_SYSTEM}\n\nEnabled task types for this pipeline: ${Object.entries(enabledTasks).filter(([, on]) => !!on).map(([k]) => k).join(', ') || 'general'}${enabledCustomIds.length ? `, ${enabledCustomIds.join(', ')}` : ''}.\nOnly emit types from enabled task types.` },
        ...messages
      ], 1024, 2, PIPELINE_PLANNER_TIMEOUT_MS);
      const jsonMatch = planText.match(/\[[\s\S]*\]/);
      plan = JSON.parse(jsonMatch ? jsonMatch[0] : planText);
      if (!Array.isArray(plan) || plan.length === 0) throw new Error('empty plan');
    } catch (e) {
      console.warn(`[pipeline:${pipeline.slug}] Plan parse failed (${e.message}), falling back to single task`);
      plan = [{ type: classifyTask(messages), label: 'Main task', prompt: originalRequest }];
    }

    // Cap subtasks
    const allowedTypesSet = new Set([...Object.entries(enabledTasks).filter(([, on]) => !!on).map(([k]) => k), ...enabledCustomIds]);
    plan = plan.map(p => ({ ...p, type: (p?.type || 'general').toString().toLowerCase() })).filter(p => allowedTypesSet.has(p.type)).slice(0, pipeline.maxSubtasks || 5);
    if (!plan.length) plan = [{ type: 'general', label: 'Main task', prompt: originalRequest }];
    sse('pipeline_status', { step: 'plan_ready', subtasks: plan.map(p => ({ type: p.type, label: p.label })) });
    console.log(`[pipeline:${pipeline.slug}] Plan: ${plan.map(p => p.type).join(', ')}`);

    // ── Step 2: Execute subtasks in parallel ───────────────────────────────
    const results = await Promise.all(plan.map(async (subtask, idx) => {
      const customTask = enabledCustomTasks.find(t => t.id === subtask.type);
      const modelId = customTask?.model || pipeline.models[subtask.type] || pipeline.models.general;
      sse('pipeline_status', { step: 'executing', index: idx, type: subtask.type, label: subtask.label, model: modelId });
      console.log(`[pipeline:${pipeline.slug}] Subtask[${idx}] ${subtask.type} → ${modelId}`);
      try {
        const result = await callModelWithRetry(modelId, [
          ...messages.filter(m => m.role === 'system'),
          { role: 'user', content: subtask.prompt }
        ], 2048, 2, PIPELINE_SUBTASK_TIMEOUT_MS);
        sse('pipeline_status', { step: 'subtask_done', index: idx, type: subtask.type, label: subtask.label, chars: result.length });
        return { type: subtask.type, label: subtask.label, model: modelId, result, ok: true };
      } catch (e) {
        sse('pipeline_status', { step: 'subtask_error', index: idx, type: subtask.type, error: e.message });
        return { type: subtask.type, label: subtask.label, model: modelId, result: `[Error: ${e.message}]`, ok: false };
      }
    }));

    // ── Step 3: Stream synthesis ───────────────────────────────────────────
    sse('pipeline_status', { step: 'synthesizing', model: pipeline.models.synthesizer, message: 'Combining all results...' });
    console.log(`[pipeline:${pipeline.slug}] Synthesizing with ${pipeline.models.synthesizer}`);

    const specialistSummary = results.map(r =>
      `[${r.type.toUpperCase()} — ${r.label}]\n${r.result}`
    ).join('\n\n---\n\n');

    const synthMessages = [
      { role: 'system', content: SYNTHESIZER_SYSTEM },
      ...messages,
      { role: 'user', content: `Specialist results to synthesize:\n\n${specialistSummary}\n\nProvide the final unified answer:` }
    ];

    // Stream synthesis using key rotation
    const triedIds = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const key = getNextKey(triedIds);
      if (!key) break;
      triedIds.push(key.id);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 300000);
        const synthRes = await fetch(`${NVIDIA_BASE}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key.value}` },
          body: JSON.stringify({ model: pipeline.models.synthesizer, messages: synthMessages, max_tokens: 4096, temperature: 0.4, stream: true }),
          signal: ctrl.signal
        });
        clearTimeout(timer);
        if (synthRes.status === 429) { recordKeyUsage(key.id, 'quota'); continue; }
        if (!synthRes.ok) { recordKeyUsage(key.id, 'error'); continue; }

        recordKeyUsage(key.id, 'success');
        const reader = synthRes.body.getReader();
        const decoder = new TextDecoder();
        let totalContent = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          clientRes.write(chunk);
          // Extract content for stats
          chunk.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]').forEach(l => {
            try { totalContent += JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || ''; } catch {}
          });
        }

        // Update pipeline stats
        pipeline.stats.total = (pipeline.stats.total || 0) + 1;
        pipeline.stats.totalSubtasks = (pipeline.stats.totalSubtasks || 0) + plan.length;
        pipeline.stats.lastUsed = new Date().toISOString();
        pipeline.stats.avgSubtasks = Math.round(pipeline.stats.totalSubtasks / pipeline.stats.total);
        savePipelines();
        addLog({
          method: 'POST', endpoint: '/v1/chat/completions', model: `pipeline/${pipeline.slug}`,
          statusCode: 200, latencyMs: Date.now() - startTime, isStream: true,
          streaming: { streamChunks: plan.length + 1, streamBytes: totalContent.length },
          keyId: key.id, keyMasked: maskKey(key.value), keyLabel: key.label,
        });
        break;
      } catch (e) {
        console.error(`[pipeline:${pipeline.slug}] Synthesis stream error: ${e.message}`);
      }
    }

    if (!clientRes.writableEnded) {
      clientRes.write('data: [DONE]\n\n');
      clientRes.end();
    }

  } catch (e) {
    console.error(`[pipeline:${pipeline.slug}] Fatal error: ${e.message}`);
    sse('pipeline_status', { step: 'error', message: e.message });
    if (!clientRes.writableEnded) {
      const errChunk = JSON.stringify({ choices: [{ delta: { content: `\n\n❌ Pipeline error: ${e.message}` } }] });
      clientRes.write(`data: ${errChunk}\n\ndata: [DONE]\n\n`);
      clientRes.end();
    }
  } finally {
    const active = pipelineConcurrency.get(pipeline.id) || 1;
    pipelineConcurrency.set(pipeline.id, Math.max(0, active - 1));
  }
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

// ─── Task Classifier ──────────────────────────────────────────────────────────
// ─── Task Classifier Keywords ─────────────────────────────────────────────────
const CODE_KW = [
  'code','function','debug','bug','error','class','implement','algorithm',
  'python','javascript','typescript','java','c++','c#','rust','golang','sql',
  'html','css','react','vue','angular','node','git','docker','kubernetes',
  'program','script','syntax','compile','runtime','exception','stacktrace',
  'library','framework','variable','loop','array','object','refactor',
  'unit test','deploy','api endpoint','regex','bash','shell','database',
  'query','method','interface','module','import','async','promise','recursion',
  'binary search','data structure','leetcode','repository','pull request','ci/cd',
  'mongoose','prisma','graphql','rest api','microservice','pipeline','devops',
  'webpack','vite','eslint','prettier','jest','pytest','swagger','openapi',
  'pointer','heap','stack overflow','linked list','tree','graph algorithm'
];

const REASON_KW = [
  'analyze','analyse','explain why','compare and contrast','strategy','complex problem',
  'think step by step','step by step','reason through','logical','prove','hypothesis',
  'philosophical','derive','evaluate','critique','assess','implications','trade-off',
  'trade off','pros and cons','advantages and disadvantages','decision framework',
  'argument','counterargument','nuance','comprehensive analysis','thorough explanation',
  'ethical','moral dilemma','policy','economic','scientific method',
  'cause and effect','root cause','breakdown','framework','first principles',
  'systems thinking','critical thinking','weigh','deliberate','investigate',
  'what would happen if','why does','how would you','make a case'
];

const MATH_KW = [
  'calculate','solve','equation','integral','derivative','matrix','vector',
  'proof','theorem','formula','algebra','calculus','geometry','statistics',
  'probability','sum of','product of','square root','logarithm','trigonometry',
  'differential','optimization','linear programming','eigenvalue','fourier',
  'numerically','simplify','factor','polynomial','determinant','gradient',
  'divergence','curl','laplace','taylor series','binomial','combinatorics',
  'permutation','modulo','prime','fibonacci','arithmetic','median','variance',
  'standard deviation','regression','correlation','bayes','expected value',
  'limit of','infinity','converge','series expansion','maximize','minimize',
  'what is the value','compute','evaluate the expression','find x','find y'
];

const CREATIVE_KW = [
  'write a story','write a poem','write a song','write a script','write a blog',
  'creative writing','short story','fiction','novel','character','protagonist',
  'plot','narrative','brainstorm','come up with ideas','generate ideas',
  'imagine','fantasy','sci-fi','horror','romance','dialogue','monologue',
  'metaphor','simile','rhyme','haiku','sonnet','creative','witty','funny joke',
  'roleplay','role play','act as','pretend you are','write me a',
  'caption','tagline','slogan','advertisement copy','product description',
  'make it more engaging','make it catchy','rewrite in a creative way',
  'bedtime story','fairy tale','fable','essay style','in the voice of'
];

const SUMMARY_KW = [
  'summarize','summarise','tldr','tl;dr','summary of','key points','main points',
  'brief overview','give me the gist','what is this about','condense','shorten',
  'highlight the important','extract the key','outline of','recap','overview of',
  'bullet points from','in a nutshell','simplify this','paraphrase this',
  'what does this say','what are the takeaways','abstract of','synopsis'
];

const TRANSLATE_KW = [
  'translate','translation','convert to english','convert to spanish','convert to french',
  'convert to german','convert to hindi','convert to arabic','convert to chinese',
  'convert to japanese','convert to korean','convert to portuguese','convert to russian',
  'in spanish','in french','in german','in hindi','in arabic','in chinese',
  'in japanese','how do you say','what is the word for','language','bilingual',
  'multilingual','localize','localise','transcribe in','write in english',
  'write in spanish','write in french','interpret this in'
];

const FACTUAL_KW = [
  'what is','what are','who is','who was','when did','where is','where was',
  'how many','how much','which country','which city','capital of','population of',
  'definition of','define','meaning of','tell me about','what does it mean',
  'history of','founded in','invented by','discovered by','year of','date of',
  'simple question','quick question','fact about','is it true that','true or false',
  'what year','how old is','give me a quick answer'
];

// ─── Non-Latin script detection ────────────────────────────────────────────
function hasNonLatinScript(text) {
  // Arabic, Hebrew, Devanagari (Hindi), CJK (Chinese/Japanese/Korean)
  return /[\u0600-\u06FF\u0590-\u05FF\u0900-\u097F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(text);
}

function classifyTask(messages) {
  if (!messages || !Array.isArray(messages)) return 'general';

  // Image in messages → multimodal
  const hasImage = messages.some(m =>
    Array.isArray(m.content) && m.content.some(c => c.type === 'image_url')
  );
  if (hasImage) return 'multimodal';

  // Extract text — last user message gets 3× weight for recency
  const allParts = messages.map(m => {
    if (typeof m.content === 'string') return { text: m.content, role: m.role };
    if (Array.isArray(m.content))
      return { text: m.content.filter(c => c.type === 'text').map(c => c.text).join(' '), role: m.role };
    return { text: '', role: m.role };
  });

  const fullText = allParts.map(p => p.text).join(' ');

  // Non-Latin script → translation
  if (hasNonLatinScript(fullText)) return 'translation';

  // Long text → summarization (>3000 words likely needs summary/large-ctx)
  const wordCount = fullText.trim().split(/\s+/).length;
  if (wordCount > 3000) return 'summarization';

  // Build weighted text: last user message repeated 3× for recency
  const lastUserMsg = [...allParts].reverse().find(p => p.role === 'user');
  const weightedText = (fullText + ' ' + (lastUserMsg ? lastUserMsg.text.repeat(2) : '')).toLowerCase();

  // Score each type
  const scores = {
    code:          0,
    reasoning:     0,
    math:          0,
    creative:      0,
    summarization: 0,
    translation:   0,
    factual:       0,
  };

  CODE_KW    .forEach(k => { if (weightedText.includes(k)) scores.code++;          });
  REASON_KW  .forEach(k => { if (weightedText.includes(k)) scores.reasoning++;     });
  MATH_KW    .forEach(k => { if (weightedText.includes(k)) scores.math++;          });
  CREATIVE_KW.forEach(k => { if (weightedText.includes(k)) scores.creative++;      });
  SUMMARY_KW .forEach(k => { if (weightedText.includes(k)) scores.summarization++; });
  TRANSLATE_KW.forEach(k => { if (weightedText.includes(k)) scores.translation++;  });
  FACTUAL_KW .forEach(k => { if (weightedText.includes(k)) scores.factual++;       });

  // Find winner
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];

  // Confidence threshold: require at least 2 keyword hits to commit
  if (best[1] < 2) return 'general';

  return best[0];
}


function addLog(entry) {
  const log = {
    id: ++logIdCounter,
    timestamp: new Date().toISOString(),
    requestNumber: ++requestCounter,
    method: entry.method || 'META',
    endpoint: entry.endpoint || entry.event || 'unknown',
    model: entry.model || 'unknown',
    statusCode: entry.statusCode ?? 'NA',
    ...entry
  };
  logs.push(log);
  if (logs.length > MAX_LOGS) logs.shift();
  saveLogs();

  // Console output
  const status = entry.statusCode || '???';
  const latency = entry.latencyMs ? `${entry.latencyMs}ms` : '-';
  const key = entry.keyMasked || 'no-key';
  const err = entry.errorType ? ` [${entry.errorType}]` : '';
  console.log(`[${new Date().toISOString()}] #${log.requestNumber} ${entry.method || 'GET'} ${entry.endpoint} → ${status} (${latency}) key=${key}${err}`);
  if (entry.errorDetail) console.error(`  ↳ Error: ${entry.errorDetail}`);

  return log;
}


function loadLogs() {
  try {
    if (fs.existsSync(LOGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) { console.error('[logs] Load failed:', e.message); }
  return [];
}

function saveLogs() {
  try { fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2), 'utf8'); return true; }
  catch (e) { console.error('[logs] Save failed:', e.message); return false; }
}

// ─── NVIDIA Free Tier Models ──────────────────────────────────────────────────
// Source: build.nvidia.com — only "Free Endpoint" tagged models (verified May 2025)
// Model IDs match exactly what build.nvidia.com page URLs show: /<org>/<model-slug>
const NVIDIA_FREE_MODELS = [

  // ── Meta Llama 4 (Free Endpoint confirmed) ────────────────────────────────
  { id: 'meta/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick 17B (128E)', org: 'meta',        ctx: 1000000, category: 'llm',       free: true },
  { id: 'meta/llama-4-scout-17b-16e-instruct',     name: 'Llama 4 Scout 17B (16E)',     org: 'meta',        ctx: 10000000,category: 'llm',       free: true },

  // ── Meta Llama 3.x (Free Endpoint confirmed) ──────────────────────────────
  { id: 'meta/llama-3.3-70b-instruct',             name: 'Llama 3.3 70B Instruct',      org: 'meta',        ctx: 131072,  category: 'llm',       free: true },
  { id: 'meta/llama-3.1-70b-instruct',             name: 'Llama 3.1 70B Instruct',      org: 'meta',        ctx: 131072,  category: 'llm',       free: true },
  { id: 'meta/llama-3.1-8b-instruct',              name: 'Llama 3.1 8B Instruct',       org: 'meta',        ctx: 131072,  category: 'llm',       free: true },
  { id: 'meta/llama-3.1-405b-instruct',            name: 'Llama 3.1 405B Instruct',     org: 'meta',        ctx: 131072,  category: 'llm',       free: true },
  { id: 'meta/llama-3.2-3b-instruct',              name: 'Llama 3.2 3B Instruct',       org: 'meta',        ctx: 131072,  category: 'llm',       free: true },
  { id: 'meta/llama-3.2-1b-instruct',              name: 'Llama 3.2 1B Instruct',       org: 'meta',        ctx: 131072,  category: 'llm',       free: true },
  { id: 'meta/llama-3.2-11b-vision-instruct',      name: 'Llama 3.2 11B Vision',        org: 'meta',        ctx: 131072,  category: 'multimodal',free: true },
  { id: 'meta/llama-3.2-90b-vision-instruct',      name: 'Llama 3.2 90B Vision',        org: 'meta',        ctx: 131072,  category: 'multimodal',free: true },
  { id: 'meta/llama-guard-4-12b',                  name: 'Llama Guard 4 12B (Safety)',  org: 'meta',        ctx: 131072,  category: 'safety',    free: true },

  // ── DeepSeek AI (ALL 4 are Free Endpoint — verified from build.nvidia.com/deepseek-ai) ──
  { id: 'deepseek-ai/deepseek-v4-flash',           name: 'DeepSeek V4 Flash (284B MoE)', org: 'deepseek-ai',ctx: 1000000, category: 'code',      free: true },
  { id: 'deepseek-ai/deepseek-v4-pro',             name: 'DeepSeek V4 Pro (1M ctx)',    org: 'deepseek-ai', ctx: 1000000, category: 'code',      free: true },
  { id: 'deepseek-ai/deepseek-v3.2',               name: 'DeepSeek V3.2 (685B)',        org: 'deepseek-ai', ctx: 131072,  category: 'llm',       free: true },

  // ── Qwen (Free Endpoint confirmed — from build.nvidia.com/qwen) ───────────
  { id: 'qwen/qwen3-coder-480b-a35b-instruct',     name: 'Qwen3 Coder 480B (Agentic)',  org: 'qwen',        ctx: 262144,  category: 'code',      free: true },
  { id: 'qwen/qwq-32b',                            name: 'QwQ 32B (Reasoning)',         org: 'qwen',        ctx: 131072,  category: 'reasoning', free: true },
  { id: 'qwen/qwen2.5-coder-7b-instruct',          name: 'Qwen2.5 Coder 7B',           org: 'qwen',        ctx: 131072,  category: 'code',      free: true },
  { id: 'qwen/qwen2-7b-instruct',                  name: 'Qwen2 7B Instruct',           org: 'qwen',        ctx: 131072,  category: 'llm',       free: true },

  // ── Mistral AI (Free Endpoint confirmed — from build.nvidia.com/mistralai) ─
  { id: 'mistralai/mistral-large-3-675b-instruct-2512', name: 'Mistral Large 3 675B',  org: 'mistralai',   ctx: 131072,  category: 'llm',       free: true },
  { id: 'mistralai/devstral-2-123b-instruct-2512', name: 'Devstral 2 123B (Code)',     org: 'mistralai',   ctx: 262144,  category: 'code',      free: true },
  { id: 'mistralai/magistral-small-2506',          name: 'Magistral Small (Reasoning)', org: 'mistralai',  ctx: 131072,  category: 'reasoning', free: true },
  { id: 'mistralai/mistral-medium-3-instruct',     name: 'Mistral Medium 3 Instruct',  org: 'mistralai',   ctx: 131072,  category: 'llm',       free: true },
  { id: 'mistralai/mistral-small-3.1-24b-instruct-2503', name: 'Mistral Small 3.1 24B', org: 'mistralai', ctx: 131072,  category: 'llm',       free: true },
  { id: 'mistralai/mistral-nemotron',              name: 'Mistral Nemotron (Agentic)',  org: 'mistralai',   ctx: 131072,  category: 'llm',       free: true },
  { id: 'mistralai/mamba-codestral-7b-v0.1',       name: 'Mamba Codestral 7B',         org: 'mistralai',   ctx: 256000,  category: 'code',      free: true },
  { id: 'mistralai/mistral-7b-instruct-v0.2',      name: 'Mistral 7B v0.2',            org: 'mistralai',   ctx: 32768,   category: 'llm',       free: true },

  // ── NVIDIA Nemotron (Free Endpoint confirmed) ─────────────────────────────
  { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', name: 'Nemotron Ultra 253B v1',     org: 'nvidia',      ctx: 131072,  category: 'reasoning', free: true },
  { id: 'nvidia/llama-3.3-nemotron-super-49b-v1',  name: 'Nemotron Super 49B v1',      org: 'nvidia',      ctx: 131072,  category: 'llm',       free: true },
  { id: 'nvidia/llama-3.1-nemotron-nano-8b-v1',    name: 'Nemotron Nano 8B v1',        org: 'nvidia',      ctx: 131072,  category: 'llm',       free: true },

  // ── Z.ai / GLM ────────────────────────────────────────────────────────────
  // NOTE: glm-4.7 returns 404, glm-5.1 times out — removed until NVIDIA fixes them

  // ── MiniMax (Free Endpoint confirmed — from build.nvidia.com/models) ──────
  { id: 'minimaxai/minimax-m2.7',                  name: 'MiniMax M2.7 (230B)',         org: 'minimaxai',   ctx: 200000,  category: 'llm',       free: true },

  // ── Moonshot Kimi (Free Endpoint confirmed from build.nvidia.com/moonshotai + XDA) ──
  { id: 'moonshotai/kimi-k2.6',                    name: 'Kimi K2.6 (1T Multimodal)',   org: 'moonshotai',  ctx: 131072,  category: 'multimodal',free: true },
  { id: 'moonshotai/kimi-k2.5',                    name: 'Kimi K2.5 (1T, Long Context)',org: 'moonshotai',  ctx: 131072,  category: 'llm',       free: true },
  { id: 'moonshotai/kimi-k2-thinking',             name: 'Kimi K2 Thinking',            org: 'moonshotai',  ctx: 262144,  category: 'reasoning', free: true },
  { id: 'moonshotai/kimi-k2-instruct',             name: 'Kimi K2 Instruct',            org: 'moonshotai',  ctx: 131072,  category: 'llm',       free: true },

  // ── OpenAI GPT-OSS (Free Endpoint confirmed from build.nvidia.com/openai) ─
  { id: 'openai/gpt-oss-120b',                     name: 'GPT-OSS 120B (Reasoning)',    org: 'openai',      ctx: 131072,  category: 'reasoning', free: true },
  { id: 'openai/gpt-oss-20b',                      name: 'GPT-OSS 20B (Reasoning)',     org: 'openai',      ctx: 131072,  category: 'reasoning', free: true },

  // ── ByteDance Seed-OSS (Free Endpoint confirmed from build.nvidia.com/bytedance) ──
  { id: 'bytedance/seed-oss-36b-instruct',          name: 'Seed-OSS 36B (Long Context)', org: 'bytedance',  ctx: 131072,  category: 'llm',       free: true },

  // ── Stepfun (confirmed from developer usage + XDA article) ───────────────
  { id: 'stepfun-ai/step-3.5-flash',               name: 'Step-3.5 Flash (200K ctx)',   org: 'stepfun-ai',  ctx: 200000,  category: 'llm',       free: true },

  // ── Sarvam (Free Endpoint confirmed from docs.api.nvidia.com) ────────────
  { id: 'sarvamai/sarvam-m',                        name: 'Sarvam M (Multilingual, Indic)', org: 'sarvamai', ctx: 32768,  category: 'llm',       free: true },
];


const NVIDIA_IMAGE_MODELS = [
  { id: 'black-forest-labs/FLUX.1-dev', name: 'FLUX.1-dev', org: 'black-forest-labs', ctx: 0, category: 'image', free: true },
  { id: 'black-forest-labs/FLUX.1-schnell', name: 'FLUX.1-schnell', org: 'black-forest-labs', ctx: 0, category: 'image', free: true },
  { id: 'black-forest-labs/FLUX.2-klein-4b', name: 'FLUX.2-klein-4b', org: 'black-forest-labs', ctx: 0, category: 'image', free: true },
  { id: 'stabilityai/stable-diffusion-3.5-large', name: 'Stable Diffusion 3.5 Large', org: 'stabilityai', ctx: 0, category: 'image', free: true },
  { id: 'qwen/qwen-image', name: 'Qwen Image', org: 'qwen', ctx: 0, category: 'image', free: true },
  { id: 'qwen/qwen-image-edit', name: 'Qwen Image Edit', org: 'qwen', ctx: 0, category: 'image', free: true }
];

function loadUserModels() {
  try { if (fs.existsSync(USER_MODELS_FILE)) { const d=JSON.parse(fs.readFileSync(USER_MODELS_FILE,'utf8')); if (Array.isArray(d)) return d; } } catch(e){ console.error('[models] load failed', e.message); }
  return [];
}
function saveUserModels() {
  try { fs.writeFileSync(USER_MODELS_FILE, JSON.stringify(userModels, null, 2), 'utf8'); return true; } catch(e){ console.error('[models] save failed', e.message); return false; }
}
function allCatalogModels() {
  return [...NVIDIA_FREE_MODELS, ...NVIDIA_IMAGE_MODELS, ...userModels, ...pipelines.map(p => ({ id:`pipeline/${p.slug}`, name:`[Pipeline] ${p.name}`, org:'pipeline', category:'pipeline', ctx:131072, free:true }))];
}

// ─── Express Setup ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// CORS for local dev
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    keysTotal: keys.length,
    keysActive: getActiveKeys().length,
    logsCount: logs.length,
    requestsHandled: requestCounter,
    nvidiaBase: NVIDIA_BASE,
    port: PORT
  });
});

// ─── Keys API ─────────────────────────────────────────────────────────────────
app.get('/api/keys', (req, res) => {
  res.json(keys.map(k => ({
    id: k.id,
    label: k.label,
    masked: maskKey(k.value),
    active: k.active,
    addedAt: k.addedAt,
    stats: k.stats
  })));
});

app.post('/api/keys', (req, res) => {
  const { value, label } = req.body;
  if (!value || !value.startsWith('nvapi-')) {
    return res.status(400).json({ error: 'Invalid key — must start with nvapi-' });
  }
  // Check duplicate
  if (keys.find(k => k.value === value.trim())) {
    return res.status(409).json({ error: 'Key already exists' });
  }
  const newKey = {
    id: `key_${Date.now()}`,
    value: value.trim(),
    label: (label || `Key ${keys.length + 1}`).trim(),
    active: true,
    addedAt: new Date().toISOString(),
    stats: { requests: 0, success: 0, errors: 0, quota: 0, lastUsed: null, lastError: null }
  };
  keys.push(newKey);
  saveKeysToEnv();
  addLog({ method: 'META', endpoint: '/api/keys', event: 'key_added', keyMasked: maskKey(newKey.value), label: newKey.label, statusCode: 201 });
  res.status(201).json({ ok: true, id: newKey.id, masked: maskKey(newKey.value) });
});

app.delete('/api/keys/:id', (req, res) => {
  const idx = keys.findIndex(k => k.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Key not found' });
  const removed = keys.splice(idx, 1)[0];
  saveKeysToEnv();
  addLog({ method: 'META', endpoint: '/api/keys', event: 'key_removed', keyMasked: maskKey(removed.value), statusCode: 200 });
  res.json({ ok: true });
});

app.patch('/api/keys/:id', (req, res) => {
  const k = keys.find(k => k.id === req.params.id);
  if (!k) return res.status(404).json({ error: 'Key not found' });
  if (typeof req.body.active === 'boolean') k.active = req.body.active;
  if (req.body.label) k.label = req.body.label.trim();
  saveKeysToEnv();
  res.json({ ok: true });
});

// ─── Logs API ─────────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
  let result = [...logs].reverse(); // newest first
  if (req.query.filter) {
    const f = req.query.filter.toLowerCase();
    result = result.filter(l =>
      (l.endpoint || '').toLowerCase().includes(f) ||
      (l.model || '').toLowerCase().includes(f) ||
      (l.errorType || '').toLowerCase().includes(f) ||
      (l.event || '').toLowerCase().includes(f) ||
      String(l.statusCode || '').includes(f)
    );
  }
  if (req.query.limit) result = result.slice(0, parseInt(req.query.limit));
  res.json(result);
});

app.delete('/api/logs', (req, res) => {
  const count = logs.length;
  logs = [];
  saveLogs();
  res.json({ ok: true, cleared: count });
});

// ─── Models ───────────────────────────────────────────────────────────────────
app.get('/v1/models', (req, res) => {
  const data = [...NVIDIA_FREE_MODELS, ...NVIDIA_IMAGE_MODELS, ...userModels].map(m => ({
    id: m.id,
    object: 'model',
    created: 1700000000,
    owned_by: m.org,
    permission: [],
    root: m.id,
    parent: null,
    context_window: m.ctx,
    category: m.category,
    free: m.free,
    name: m.name
  }));
  const pipelineModels = pipelines.map(p => ({
    id: `pipeline/${p.slug}`,
    object: 'model',
    created: Math.floor(new Date(p.createdAt).getTime() / 1000),
    owned_by: 'pipeline',
    permission: [],
    root: `pipeline/${p.slug}`,
    parent: null,
    context_window: 131072,
    category: 'pipeline',
    free: true,
    name: `[Pipeline] ${p.name}`
  }));
  res.json({ object: 'list', data: [...data, ...pipelineModels] });
});

app.get('/api/models', (req, res) => {
  let result = allCatalogModels();

  if (req.query.q) {
    const q = req.query.q.toLowerCase();
    result = result.filter(m =>
      m.id.toLowerCase().includes(q) ||
      m.name.toLowerCase().includes(q) ||
      m.org.toLowerCase().includes(q) ||
      m.category.toLowerCase().includes(q)
    );
  }
  if (req.query.category) result = result.filter(m => m.category === req.query.category);
  res.json(result);
});


app.post('/api/models/custom', (req, res) => {
  const { id, name, org='custom', category='llm', free=true } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  if (allCatalogModels().find(m => m.id === id)) return res.status(409).json({ error: 'Model already exists' });
  const model = { id: String(id).trim(), name: String(name).trim(), org: String(org).trim(), category: String(category).trim(), ctx: 131072, free: !!free };
  userModels.push(model); saveUserModels();
  addLog({ method:'META', endpoint:'/api/models/custom', event:'model_added', model:id, statusCode:201 });
  res.status(201).json({ ok:true, model });
});

app.delete('/api/models/custom/:id', (req, res) => {
  const id = decodeURIComponent(req.params.id);
  const idx = userModels.findIndex(m => m.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Custom model not found' });
  const removed = userModels.splice(idx,1)[0]; saveUserModels();
  addLog({ method:'META', endpoint:'/api/models/custom', event:'model_removed', model:id, statusCode:200 });
  res.json({ ok:true, removed });
});

app.post('/api/models/verify', async (req, res) => {
  const { model, apiKey, type='chat' } = req.body || {};
  if (!model) return res.status(400).json({ error: 'model required' });
  const key = apiKey || getActiveKeys()[0]?.value;
  if (!key) return res.status(400).json({ error: 'apiKey required (or add active key in server)' });
  try {
    let vr;
    if (type === 'image') {
      if (model === 'microsoft/TRELLIS') return res.json({ ok:false, status:400, model, detail:'TRELLIS is not compatible with /images/generations on this proxy.' });
      const ir = await postImageGeneration(key, { model, prompt:'test image', size:'1024x1024' });
      vr = ir.res;
    } else {
      vr = await fetch(`${NVIDIA_BASE}/chat/completions`, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`}, body: JSON.stringify({ model, stream:false, max_tokens:8, messages:[{role:'user',content:'say ok'}] }) });
    }
    const txt = await vr.text();
    res.json({ ok: vr.ok, status: vr.status, model, detail: txt.slice(0, 500) });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

const modelStatusCache = {};

app.get('/api/models/status', (req, res) => {
  res.json(modelStatusCache);
});

app.post('/api/models/verify-all', async (req, res) => {
  const key = req.body?.apiKey || getActiveKeys()[0]?.value;
  if (!key) return res.status(400).json({ error: 'apiKey required (or add active key in server)' });
  const models = allCatalogModels().filter(m => m.category !== 'pipeline');
  const results = await Promise.all(models.map(async (m) => {
    try {
      const isImage = m.category === 'image';
      const vr = await fetch(`${NVIDIA_BASE}${isImage ? '/images/generations' : '/chat/completions'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify(isImage
          ? { model: m.id, prompt: 'test image', size: '1024x1024' }
          : { model: m.id, stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'say ok' }] })
      });
      const txt = await vr.text();
      const out = { model: m.id, category: m.category, ok: vr.ok, status: vr.status, reason: vr.ok ? 'PASS' : txt.slice(0, 220) };
      modelStatusCache[m.id] = { ok: out.ok, status: out.status, ts: new Date().toISOString() };
      return out;
    } catch (e) {
      return { model: m.id, category: m.category, ok: false, status: 0, reason: e.message };
    }
  }));
  const pass = results.filter(r => r.ok).length;
  res.json({ total: results.length, pass, fail: results.length - pass, results });
});

// ─── Main Proxy ───────────────────────────────────────────────────────────────
async function proxyToNvidia(req, res, endpoint) {
  const startTime = Date.now();

  // ── Pipeline model resolution ────────────────────────────────────────────────
  if (req.body && typeof req.body.model === 'string' && req.body.model.startsWith('pipeline/')) {
    const slug = req.body.model.slice(9);
    const pipeline = pipelines.find(p => p.slug === slug);
    if (!pipeline) {
      return res.status(404).json({
        error: { message: `Pipeline '${slug}' not found. Create it in the Pipelines tab.`, type: 'proxy_error', code: 'pipeline_not_found' }
      });
    }
    const activeKeys = getActiveKeys();
    if (activeKeys.length === 0) {
      return res.status(503).json({
        error: { message: 'No active API keys for pipeline execution.', type: 'proxy_error', code: 'no_keys' }
      });
    }
    console.log(`[pipeline] Routing request to pipeline '${slug}'`);
    const wantsPipelineEvents =
      req.headers['x-pipeline-events'] === '1' ||
      req.headers['x-client'] === 'nim-proxy-ui' ||
      req.query.pipeline_events === '1';
    return runPipeline(pipeline, req.body.messages || [], res, { emitStatusEvents: wantsPipelineEvents });
  }

  if (req.body && typeof req.body.model === 'string' && req.body.model.startsWith('router/')) {
    return res.status(410).json({ error: { message: `Router feature has been removed. Use pipeline/<slug> instead.`, type: 'proxy_error', code: 'router_removed' } });
  }


  const requestedModel = req.body?.model;
  const catalog = allCatalogModels();
  const selectedModelMeta = catalog.find(m => m.id === requestedModel);
  if (endpoint === '/chat/completions' && selectedModelMeta?.category === 'image') {
    const prompt = (req.body?.messages || []).filter(m => m.role === 'user').slice(-1)[0]?.content || 'Generate an image';
    const key = getActiveKeys()[0];
    if (!key) return res.status(503).json({ error: { message: 'No active API keys for image generation', type: 'proxy_error', code: 'no_keys' } });
    try {
      const irReq = await postImageGeneration(key.value, { model: requestedModel, prompt, size: req.body?.size || req.body?.image_size || '1024x1024', quality: req.body?.quality || 'standard' });
      const ir = irReq.res;
      const imgText = await ir.text();
      let data;
      try { data = JSON.parse(imgText); }
      catch {
        if (ir.status === 404) {
          return res.status(400).json({ error: { message: `Image endpoint rejected model '${requestedModel}' (HTTP 404). Your account or region may not have image API enabled yet. Tried NVIDIA image endpoints and all returned 404.`, code: 'image_model_unsupported' } });
        }
        return res.status(500).json({ error: { message: `Image API returned non-JSON: ${imgText.slice(0,200)}` } });
      }
      if (!ir.ok) return res.status(ir.status).json(data);
      if (data.requestId && data.statusUrl) {
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const poll = await fetch(data.statusUrl, { headers: { Authorization: `Bearer ${key.value}` } });
          const pd = await poll.json().catch(() => ({}));
          if (pd.status === 'fulfilled' || pd.data) { data = pd; break; }
          if (pd.status === 'failed') return res.status(500).json({ error: { message: 'Image generation failed' } });
        }
      }
      const b64 = data?.data?.[0]?.b64_json;
      const url = data?.data?.[0]?.url;
      const markdownImg = b64 ? `![generated](data:image/png;base64,${b64})` : (url ? `![generated](${url})` : '(no image output)');
      const payload = { id: `img-${Date.now()}`, object:'chat.completion', choices:[{ index:0, message:{ role:'assistant', content: markdownImg }, finish_reason:'stop' }] };
      if (req.body?.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        const chunk = JSON.stringify({ choices: [{ delta: { content: markdownImg } }] });
        res.write(`data: ${chunk}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return res.json(payload);
    } catch (e) { return res.status(500).json({ error: { message: e.message, type: 'proxy_error', code: 'image_proxy_error' } }); }
  }

  const isStream  = !!(req.body && req.body.stream === true);
  const model     = (req.body && req.body.model) || 'unknown';
  const method    = req.method;

  // ── Strip empty/blank messages that break some models ──────────────────────
  if (req.body && Array.isArray(req.body.messages)) {
    req.body.messages = req.body.messages.filter(m => {
      const c = m.content;
      if (typeof c === 'string') return c.trim().length > 0;
      if (Array.isArray(c)) return c.length > 0;
      return c != null;
    });
  }

  const logBase = {
    method, endpoint, model, isStream,
    requestBody: req.body ? JSON.stringify(req.body).slice(0, 400) : null,
  };

  const triedIds = [];

  while (true) {
    const key = getNextKey(triedIds);

    if (!key) {
      const latencyMs = Date.now() - startTime;
      addLog({
        ...logBase, statusCode: 503, latencyMs,
        errorType: 'ALL_KEYS_EXHAUSTED',
        errorDetail: `All ${triedIds.length} key(s) tried — all failed or quota hit`,
        triedKeys: triedIds.length
      });
      if (!res.headersSent) {
        res.status(503).json({
          error: {
            message: `All ${triedIds.length} API key(s) exhausted / errored. Add more keys via Web UI.`,
            type: 'proxy_error', code: 'all_keys_exhausted'
          }
        });
      }
      return;
    }

    triedIds.push(key.id);

    // Per-attempt abort controller — handles BOTH timeout AND client disconnect.
    // Created fresh each retry so signals don't bleed across attempts.
    const abort = new AbortController();

    // Wire client-disconnect → abort this attempt's fetch.
    // Use a named function so we can remove the listener cleanly afterwards.
    const onClientClose = () => abort.abort('client_disconnected');
    res.on('close', onClientClose);

    // Timeout: 5 min streaming (reasoning models think long), 2 min non-stream
    const timeoutMs = isStream ? 300000 : 120000;
    const timeoutId = setTimeout(() => abort.abort('timeout'), timeoutMs);

    try {
      const nvidiaUrl = `${NVIDIA_BASE}${endpoint}`;
      const headers = {
        'Authorization': `Bearer ${key.value}`,
        'Content-Type': 'application/json',
        'Accept': isStream ? 'text/event-stream' : 'application/json',
      };

      const fetchRes = await fetch(nvidiaUrl, {
        method,
        headers,
        body: method !== 'GET' ? JSON.stringify(req.body) : undefined,
        signal: abort.signal
      });

      clearTimeout(timeoutId);
      res.off('close', onClientClose); // Done with initial fetch, remove listener

      const latencyMs = Date.now() - startTime;

      // ── 429 Rate-limited ─────────────────────────────────────────────────
      if (fetchRes.status === 429) {
        recordKeyUsage(key.id, 'quota');
        addLog({
          ...logBase, statusCode: 429, latencyMs,
          keyId: key.id, keyMasked: maskKey(key.value), keyLabel: key.label,
          errorType: 'RATE_LIMITED',
          errorDetail: `Key ${maskKey(key.value)} rate-limited (429). Rotating to next key.`,
          triedKeys: triedIds.length, willRetry: true
        });
        console.log(`  ↳ 429 on ${maskKey(key.value)}, rotating to next key...`);
        continue;
      }

      // ── 402 Credits exhausted ────────────────────────────────────────────
      if (fetchRes.status === 402) {
        let b = {};
        try { b = await fetchRes.json(); } catch {}
        const detail = b.detail || b.message || 'Cloud credits exhausted';
        recordKeyUsage(key.id, 'quota');
        addLog({
          ...logBase, statusCode: 402, latencyMs,
          keyId: key.id, keyMasked: maskKey(key.value), keyLabel: key.label,
          errorType: 'CREDITS_EXHAUSTED',
          errorDetail: `Key ${maskKey(key.value)} credits exhausted (402): ${detail}. Rotating.`,
          triedKeys: triedIds.length, willRetry: true
        });
        console.log(`  ↳ 402 credits exhausted on ${maskKey(key.value)}, rotating...`);
        continue;
      }

      // ── 401 / 403 Auth error ─────────────────────────────────────────────
      if (fetchRes.status === 401 || fetchRes.status === 403) {
        let b = {};
        try { b = await fetchRes.json(); } catch {}
        recordKeyUsage(key.id, 'error', { error: `HTTP ${fetchRes.status}` });
        addLog({
          ...logBase, statusCode: fetchRes.status, latencyMs,
          keyId: key.id, keyMasked: maskKey(key.value), keyLabel: key.label,
          errorType: 'AUTH_ERROR',
          errorDetail: `Key rejected (${fetchRes.status}): ${JSON.stringify(b).slice(0, 200)}. Rotating.`,
          triedKeys: triedIds.length, willRetry: true
        });
        console.log(`  ↳ Auth error ${fetchRes.status} on ${maskKey(key.value)}, rotating...`);
        continue;
      }

      // ── Streaming success ────────────────────────────────────────────────
      if (isStream && fetchRes.ok) {
        const reader = fetchRes.body.getReader();

        // ── First-chunk timeout (40s): if model never starts responding, rotate ─
        const FIRST_CHUNK_MS = 40000;
        let firstChunk = null;
        try {
          firstChunk = await Promise.race([
            reader.read(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('first_chunk_timeout')), FIRST_CHUNK_MS))
          ]);
        } catch (fce) {
          reader.cancel().catch(() => {});
          if (fce.message === 'first_chunk_timeout') {
            recordKeyUsage(key.id, 'error', { error: 'No first token in 40s' });
            addLog({
              ...logBase, statusCode: 'FCT', latencyMs: Date.now() - startTime,
              keyId: key.id, keyMasked: maskKey(key.value), keyLabel: key.label,
              errorType: 'FIRST_CHUNK_TIMEOUT',
              errorDetail: `Model did not send first token within 40s. Rotating to next key.`,
              triedKeys: triedIds.length, willRetry: true
            });
            console.log(`  ↳ First-chunk timeout on ${maskKey(key.value)}, rotating...`);
            continue; // try next key
          }
          throw fce; // re-throw unexpected errors
        }

        // Got first chunk — now it's safe to commit headers to client
        recordKeyUsage(key.id, 'success');
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
        }

        let chunkCount = 0, totalChars = 0;
        const onStreamClose = () => reader.cancel().catch(() => {});
        res.on('close', onStreamClose);

        try {
          // Process first chunk, then continue
          if (firstChunk && !firstChunk.done && firstChunk.value) {
            chunkCount++;
            totalChars += firstChunk.value.length;
            res.write(Buffer.from(firstChunk.value));
          }
          while (!firstChunk?.done) {
            const { done, value } = await reader.read();
            if (done) break;
            chunkCount++;
            totalChars += value.length;
            res.write(Buffer.from(value));
          }
        } catch (_) {
          // Client disconnected mid-stream
        addLog({ method: 'META', endpoint: '/pipeline/run', event: 'pipeline_run_finished', model: `pipeline/${pipeline.slug}`, statusCode: 200, latencyMs: Date.now() - startTime });
  } finally {
          res.off('close', onStreamClose);
          res.end();
        }

        addLog({
          ...logBase, statusCode: 200, latencyMs: Date.now() - startTime,
          keyId: key.id, keyMasked: maskKey(key.value), keyLabel: key.label,
          streaming: true, streamChunks: chunkCount, streamBytes: totalChars,
          triedKeys: triedIds.length
        });
        return;
      }

      // ── Non-streaming response ───────────────────────────────────────────
      const body = await fetchRes.text();
      let parsedBody = null;
      try { parsedBody = JSON.parse(body); } catch {}

      if (!fetchRes.ok) {
        const errType = fetchRes.status >= 500 ? 'NVIDIA_SERVER_ERROR' : 'NVIDIA_CLIENT_ERROR';
        recordKeyUsage(key.id, 'error', { error: `HTTP ${fetchRes.status}` });
        addLog({
          ...logBase, statusCode: fetchRes.status, latencyMs,
          keyId: key.id, keyMasked: maskKey(key.value), keyLabel: key.label,
          errorType: errType, errorDetail: body.slice(0, 500),
          triedKeys: triedIds.length
        });
        if (!res.headersSent) res.status(fetchRes.status).set('Content-Type', 'application/json').send(body);
        return;
      }

      // ── Non-streaming success ────────────────────────────────────────────
      recordKeyUsage(key.id, 'success');
      const usage = parsedBody && parsedBody.usage ? parsedBody.usage : null;
      addLog({
        ...logBase, statusCode: 200, latencyMs,
        keyId: key.id, keyMasked: maskKey(key.value), keyLabel: key.label,
        triedKeys: triedIds.length,
        promptTokens:     usage ? usage.prompt_tokens     : null,
        completionTokens: usage ? usage.completion_tokens : null,
        totalTokens:      usage ? usage.total_tokens      : null,
        responseSnippet:  parsedBody && parsedBody.choices
          ? (parsedBody.choices[0]?.message?.content || '').slice(0, 200)
          : body.slice(0, 200)
      });
      if (!res.headersSent) res.status(200).set('Content-Type', 'application/json').send(body);
      return;

    } catch (err) {
      clearTimeout(timeoutId);
      res.off('close', onClientClose);
      const latencyMs = Date.now() - startTime;

      // ── Client disconnected → silent exit, do NOT retry ─────────────────
      // Check abort.signal.reason (Web API standard) — NOT err.message
      if (abort.signal.reason === 'client_disconnected') {
        console.log(`  ↳ Client disconnected, aborting silently`);
        if (!res.headersSent) res.end();
        return;
      }

      // ── Timeout → rotate to next key ─────────────────────────────────────
      if (err.name === 'AbortError' || abort.signal.reason === 'timeout') {
        recordKeyUsage(key.id, 'error', { error: 'Timed out' });
        addLog({
          ...logBase, statusCode: 'TOUT', latencyMs,
          keyId: key.id, keyMasked: maskKey(key.value), keyLabel: key.label,
          errorType: 'TIMEOUT',
          errorDetail: `Request timed out after ${timeoutMs / 1000}s. Rotating to next key.`,
          triedKeys: triedIds.length, willRetry: true
        });
        console.log(`  ↳ Timeout on ${maskKey(key.value)}, rotating...`);
        continue;
      }

      // ── Real network error → classify, log, rotate ────────────────────────
      let netType = 'NETWORK_ERROR', netHint = '';
      const msg = err.message || '';
      if (msg.includes('ENOTFOUND') || msg.includes('getaddrinfo')) {
        netType = 'DNS_FAILURE'; netHint = ' — cannot resolve integrate.api.nvidia.com (check internet/DNS)';
      } else if (msg.includes('ECONNREFUSED')) {
        netType = 'CONN_REFUSED'; netHint = ' — connection refused';
      } else if (msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')) {
        netType = 'CONN_TIMEOUT'; netHint = ' — connection timed out/reset';
      } else if (msg.includes('certificate') || msg.includes('SSL') || msg.includes('TLS')) {
        netType = 'SSL_ERROR'; netHint = ' — SSL/TLS error';
      }

      recordKeyUsage(key.id, 'error', { error: msg });
      const moreKeysLeft = getActiveKeys().length > triedIds.length;
      addLog({
        ...logBase, statusCode: 'NET', latencyMs,
        keyId: key.id, keyMasked: maskKey(key.value), keyLabel: key.label,
        errorType: netType,
        errorDetail: (msg || 'Network error') + netHint,
        triedKeys: triedIds.length, willRetry: moreKeysLeft
      });
      console.error(`  ↳ ${netType} on ${maskKey(key.value)}: ${msg}${netHint}`);

      if (moreKeysLeft) {
        console.log(`  ↳ Rotating to next key...`);
        continue;
      }

      if (!res.headersSent) {
        res.status(503).json({
          error: {
            message: `Network error after trying all ${triedIds.length} key(s): ${msg || netType}${netHint}`,
            type: 'proxy_error', code: netType.toLowerCase()
          }
        });
      }
      return;
    }
  }
}

// ─── Router Sessions API ──────────────────────────────────────────────────────
const ROUTER_DEFAULT_MODELS = {
  general:       'meta/llama-3.3-70b-instruct',
  code:          'deepseek-ai/deepseek-v4-flash',
  reasoning:     'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  multimodal:    'meta/llama-3.2-11b-vision-instruct',
  math:          'qwen/qwq-32b',
  creative:      'meta/llama-4-maverick-17b-128e-instruct',
  summarization: 'meta/llama-4-scout-17b-16e-instruct',
  translation:   'meta/llama-3.3-70b-instruct',
  factual:       'meta/llama-3.1-8b-instruct',
};

// ─── Pipeline Sessions API ────────────────────────────────────────────────────
const PIPELINE_DEFAULT_MODELS = {
  planner:       'meta/llama-3.3-70b-instruct',
  synthesizer:   'meta/llama-3.3-70b-instruct',
  general:       'meta/llama-3.3-70b-instruct',
  code:          'deepseek-ai/deepseek-v4-flash',
  reasoning:     'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  multimodal:    'meta/llama-3.2-11b-vision-instruct',
  math:          'qwen/qwq-32b',
  creative:      'meta/llama-4-maverick-17b-128e-instruct',
  summarization: 'meta/llama-4-scout-17b-16e-instruct',
  translation:   'meta/llama-3.3-70b-instruct',
  factual:       'meta/llama-3.1-8b-instruct',
};
const PIPELINE_TASK_TYPES = Object.keys(PIPELINE_DEFAULT_MODELS).filter(t => !['planner', 'synthesizer'].includes(t));
function normalizeCustomTasks(arr = []) {
  if (!Array.isArray(arr)) return [];
  return arr.map((t, i) => ({
    id: String(t?.id || '').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || `custom-${i + 1}`,
    label: String(t?.label || t?.id || `Custom ${i + 1}`).slice(0, 60),
    model: String(t?.model || '').trim(),
    instruction: String(t?.instruction || '').slice(0, 400),
    enabled: t?.enabled !== false
  })).filter(t => t.model);
}


app.get('/api/pipelines', (req, res) => res.json(pipelines));

app.post('/api/pipelines', (req, res) => {
  const { name, slug, models, maxSubtasks, enabledTasks, customTasks } = req.body;
  if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'slug: only lowercase, numbers, hyphens' });
  if (pipelines.find(p => p.slug === slug)) return res.status(409).json({ error: `Slug '${slug}' already exists` });

  const pipelineModels = {};
  for (const type of Object.keys(PIPELINE_DEFAULT_MODELS)) {
    pipelineModels[type] = models?.[type] || PIPELINE_DEFAULT_MODELS[type];
  }

  const pipeline = {
    id: `pip_${Date.now()}`,
    name: name.trim(),
    slug: slug.trim(),
    models: pipelineModels,
    enabledTasks: Object.fromEntries(PIPELINE_TASK_TYPES.map(t => [t, typeof enabledTasks?.[t] === 'boolean' ? enabledTasks[t] : true])),
    customTasks: normalizeCustomTasks(customTasks),
    maxSubtasks: Math.min(Math.max(parseInt(maxSubtasks) || 4, 2), 8),
    createdAt: new Date().toISOString(),
    stats: { total: 0, totalSubtasks: 0, avgSubtasks: 0, lastUsed: null }
  };
  pipelines.push(pipeline);
  savePipelines();
  addLog({ method: 'META', endpoint: '/api/pipelines', event: 'pipeline_created', label: pipeline.name, statusCode: 201 });
  res.status(201).json(pipeline);
});

app.patch('/api/pipelines/:id', (req, res) => {
  const pipeline = pipelines.find(p => p.id === req.params.id);
  if (!pipeline) return res.status(404).json({ error: 'Pipeline not found' });
  if (req.body.name) pipeline.name = req.body.name.trim();
  if (req.body.maxSubtasks) pipeline.maxSubtasks = Math.min(Math.max(parseInt(req.body.maxSubtasks) || 4, 2), 8);
  if (req.body.models && typeof req.body.models === 'object') Object.assign(pipeline.models, req.body.models);
  if (req.body.enabledTasks && typeof req.body.enabledTasks === 'object') {
    pipeline.enabledTasks = pipeline.enabledTasks || {};
    for (const t of PIPELINE_TASK_TYPES) {
      if (typeof req.body.enabledTasks[t] === 'boolean') pipeline.enabledTasks[t] = req.body.enabledTasks[t];
    }
  }
  if (req.body.customTasks) pipeline.customTasks = normalizeCustomTasks(req.body.customTasks);
  savePipelines();
  res.json({ ok: true, pipeline });
});

app.delete('/api/pipelines/:id', (req, res) => {
  const idx = pipelines.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Pipeline not found' });
  const removed = pipelines.splice(idx, 1)[0];
  savePipelines();
  addLog({ method: 'META', endpoint: '/api/pipelines', event: 'pipeline_deleted', label: removed.name, statusCode: 200 });
  res.json({ ok: true });
});

// ─── Route: /v1/chat/completions ──────────────────────────────────────────────
app.post('/v1/chat/completions', (req, res) => proxyToNvidia(req, res, '/chat/completions'));

// ─── Route: /v1/completions (legacy) ─────────────────────────────────────────
app.post('/v1/completions', (req, res) => proxyToNvidia(req, res, '/completions'));

// ─── Route: /v1/embeddings ────────────────────────────────────────────────────
app.post('/v1/embeddings', (req, res) => proxyToNvidia(req, res, '/embeddings'));

// ─── Route: GET /v1 (base URL probe — clients hit this to check connectivity) ─
app.get('/v1', (req, res) => {
  res.json({ object: 'list', message: 'NVIDIA NIM Proxy active', models_url: '/v1/models' });
});

// ─── Catch-all for any other /v1/* ────────────────────────────────────────────
app.all('/v1/*splat', (req, res) => {
  const endpoint = req.path.replace('/v1', '');
  proxyToNvidia(req, res, endpoint);
});

// ─── Init & Start ─────────────────────────────────────────────────────────────
keys = loadKeysFromEnv();
pipelines = loadPipelines();
logs = loadLogs();
logIdCounter = logs.reduce((m, l) => Math.max(m, l.id || 0), 0);
userModels = loadUserModels();
requestCounter = logs.reduce((m, l) => Math.max(m, l.requestNumber || 0), 0);

// ─── Startup Connectivity Check ───────────────────────────────────────────────
async function checkNvidiaConnectivity() {
  try {
    const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
      method: 'GET',
      signal: AbortSignal.timeout(8000)
    });
    if (res.ok || res.status === 401 || res.status === 403) {
      console.log('  ✓ NVIDIA API reachable (HTTP ' + res.status + ')');
    } else {
      console.warn('  ⚠ NVIDIA API returned HTTP ' + res.status + ' — may have issues');
    }
  } catch (err) {
    if (err.message && (err.message.includes('ENOTFOUND') || err.message.includes('getaddrinfo'))) {
      console.error('  ✗ DNS FAILURE: Cannot reach integrate.api.nvidia.com — check your internet connection!');
    } else if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      console.warn('  ⚠ NVIDIA API connectivity check timed out (slow network?)');
    } else if (err.message && (err.message.includes('fetch is not a function') || err.message.includes('fetch is not defined'))) {
      console.error('  ✗ Native fetch unavailable! Upgrade to Node.js 18+ or run: npm install node-fetch');
    } else {
      console.warn('  ⚠ NVIDIA API connectivity check failed: ' + err.message);
    }
  }
}

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║        NVIDIA NIM Proxy Server — Ready               ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Web UI  :  http://localhost:${PORT}`);
  console.log(`  API     :  http://localhost:${PORT}/v1`);
  console.log(`  Models  :  http://localhost:${PORT}/v1/models`);
  console.log(`  Logs    :  http://localhost:${PORT}/api/logs`);
  console.log(`  Keys    :  ${keys.length} loaded (${getActiveKeys().length} active)`);
  console.log(`  Max logs:  ${MAX_LOGS} entries`);
  if (keys.length === 0) {
    console.log('\n  ⚠  No API keys found! Add via Web UI or .env file.');
  } else {
    keys.forEach((k, i) => console.log(`  Key ${i+1}: ${maskKey(k.value)} — ${k.label}`));
  }
  console.log('\n  OpenClaw → ~/.openclaw/openclaw.json (set NVIDIA_API_KEY=proxy in env):');
  console.log('  { "models": { "providers": { "nvidia": { "baseUrl": "http://localhost:' + PORT + '/v1" } } } }');
  console.log('  Model refs: nvidia/<org>/<model>  →  nvidia/meta/llama-3.3-70b-instruct');
  console.log('');
  checkNvidiaConnectivity();
});
