// ─── State ─────────────────────────────────────────────────────────────────
let allModels = [];
let selectedModelId = null;
let chatHistory = [];
let useStream = true;
let autoRefresh = true;
let autoRefreshTimer = null;
let lastArenaResults = [];
let arenaUseStream = true;
let lastLogId = 0;
const CHAT_STORAGE_KEY = 'nim_proxy_chat_history_v1';

// ─── Init ──────────────────────────────────────────────────────────────────
async function init() {
  loadChatHistory();
  await Promise.all([refreshHealth(), refreshKeys(), loadModels(), refreshLogs(), loadPipelines()]);
  setupArenaModels();
  startAutoRefresh();
}

function saveChatHistory() {
  try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatHistory)); } catch {}
}

function loadChatHistory() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    chatHistory = parsed.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
    const wrap = document.getElementById('chat-msgs');
    wrap.innerHTML = '';
    if (!chatHistory.length) {
      wrap.innerHTML = '<div class="msg system-msg">Welcome! Select a model and start chatting.</div>';
      return;
    }
    chatHistory.forEach(m => addMessage(m.role, m.content));
  } catch {}
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    if (!autoRefresh) return;
    refreshHealth();
    refreshKeys();
    refreshLogs();
  }, 3000);
}

// ─── Nav ───────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');
  if (name === 'pipeline') loadPipelines();
}

// ─── Health ────────────────────────────────────────────────────────────────
async function refreshHealth() {
  try {
    const d = await api('/api/health');
    document.getElementById('h-keys').textContent = d.keysActive + '/' + d.keysTotal;
    document.getElementById('h-reqs').textContent = d.requestsHandled;
    document.getElementById('h-uptime').textContent = formatUptime(d.uptime);
    document.getElementById('s-total-req').textContent = d.requestsHandled;
  } catch {}
}

function formatUptime(s) {
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}

// ─── Keys ──────────────────────────────────────────────────────────────────
async function refreshKeys() {
  try {
    const keys = await api('/api/keys');
    renderKeys(keys);
    document.getElementById('key-badge').textContent = keys.length;
    document.getElementById('h-keys').textContent = keys.filter(k=>k.active).length + '/' + keys.length;

    // Dashboard key summary
    const activeKeys = keys.filter(k=>k.active);
    document.getElementById('s-active-keys').textContent = activeKeys.length;
    const quotaHits = keys.reduce((s,k)=>s+k.stats.quota,0);
    const errors = keys.reduce((s,k)=>s+k.stats.errors,0);
    document.getElementById('s-quota-hits').textContent = quotaHits;
    document.getElementById('s-errors').textContent = errors;
    document.getElementById('keys-summary').textContent = `${activeKeys.length} active / ${keys.length} total`;

    // Dashboard key cards
    const dashKeys = document.getElementById('dash-keys');
    if (keys.length === 0) {
      dashKeys.innerHTML = '<div class="empty">No keys. Add via Keys tab →</div>';
    } else {
      dashKeys.innerHTML = keys.map(k => `
        <div class="key-row">
          <div class="key-info">
            <div class="key-label-text">${esc(k.label)}</div>
            <div class="key-val">${esc(k.masked)}</div>
            <div class="key-stats">
              <div class="key-stat-item"><span>Req:</span><b>${k.stats.requests}</b></div>
              <div class="key-stat-item"><span>OK:</span><b class="text-green">${k.stats.success}</b></div>
              <div class="key-stat-item"><span>429:</span><b class="text-amber">${k.stats.quota}</b></div>
              <div class="key-stat-item"><span>Err:</span><b class="text-red">${k.stats.errors}</b></div>
              ${k.stats.lastUsed ? `<div class="key-stat-item"><span>Last:</span><b>${relTime(k.stats.lastUsed)}</b></div>` : ''}
            </div>
          </div>
          <span class="badge ${k.active ? 'badge-green' : 'badge-gray'}">${k.active ? 'active' : 'paused'}</span>
        </div>
      `).join('');
    }
  } catch {}
}

function renderKeys(keys) {
  const el = document.getElementById('keys-list');
  if (keys.length === 0) { el.innerHTML = '<div class="empty">No keys added yet</div>'; return; }
  el.innerHTML = keys.map(k => `
    <div class="key-row">
      <div class="key-info">
        <div class="flex gap-8 items-center" style="margin-bottom:4px">
          <div class="key-label-text">${esc(k.label)}</div>
          <span class="badge ${k.active ? 'badge-green' : 'badge-gray'}">${k.active ? 'active' : 'paused'}</span>
        </div>
        <div class="key-val">${esc(k.masked)}</div>
        <div class="key-stats">
          <div class="key-stat-item"><span>Requests:</span><b>${k.stats.requests}</b></div>
          <div class="key-stat-item"><span>Success:</span><b class="text-green">${k.stats.success}</b></div>
          <div class="key-stat-item"><span>Quota hits:</span><b class="text-amber">${k.stats.quota}</b></div>
          <div class="key-stat-item"><span>Errors:</span><b class="text-red">${k.stats.errors}</b></div>
          ${k.stats.lastUsed ? `<div class="key-stat-item"><span>Last used:</span><b>${relTime(k.stats.lastUsed)}</b></div>` : ''}
          ${k.stats.lastError ? `<div class="key-stat-item text-red"><span>Last error:</span><b>${esc(k.stats.lastError)}</b></div>` : ''}
        </div>
      </div>
      <div class="flex gap-8">
        <button class="btn btn-ghost btn-sm" onclick="toggleKey('${k.id}', ${!k.active})">${k.active ? 'Pause' : 'Enable'}</button>
        <button class="btn btn-danger btn-sm" onclick="removeKey('${k.id}')">Remove</button>
      </div>
    </div>
  `).join('');
}

async function addKey() {
  const val = document.getElementById('new-key-val').value.trim();
  const label = document.getElementById('new-key-label').value.trim();
  if (!val) { toast('Enter an API key', 'error'); return; }
  if (!val.startsWith('nvapi-')) { toast('Key must start with nvapi-', 'error'); return; }
  try {
    await api('/api/keys', 'POST', { value: val, label });
    document.getElementById('new-key-val').value = '';
    document.getElementById('new-key-label').value = '';
    toast('Key added and saved to .env ✓', 'success');
    refreshKeys();
  } catch (e) {
    toast(e.message || 'Failed to add key', 'error');
  }
}

async function removeKey(id) {
  if (!confirm('Remove this key?')) return;
  await api('/api/keys/' + id, 'DELETE');
  toast('Key removed', 'info');
  refreshKeys();
}

async function toggleKey(id, active) {
  await api('/api/keys/' + id, 'PATCH', { active });
  refreshKeys();
}

// ─── Models ────────────────────────────────────────────────────────────────
async function loadModels() {
  try {
    const data = await api('/api/models');
    allModels = data;
    renderModels(data);
    populateChatModelSelect(data);
    setupArenaModels();
    loadModelStatus();
  } catch {}
}

function filterModels() {
  const q = document.getElementById('model-search').value.toLowerCase();
  const cat = document.getElementById('model-cat').value;
  let filtered = allModels;
  if (q) filtered = filtered.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.org.toLowerCase().includes(q));
  if (cat) filtered = filtered.filter(m => m.category === cat);
  renderModels(filtered);
}

function renderModels(models) {
  const grid = document.getElementById('models-grid');
  // Count per category
  const cats = {};
  allModels.forEach(m => { cats[m.category] = (cats[m.category]||0)+1; });
  const catStr = Object.entries(cats).map(([k,v])=>`${k}: ${v}`).join(' · ');
  document.getElementById('model-count').textContent = `${models.length} of ${allModels.length} models  ·  ${catStr}`;
  grid.innerHTML = models.map(m => `
    <div class="model-card ${selectedModelId===m.id?'selected':''}" 
         onclick="selectModel('${m.id}')" id="mc-${m.id.replace(/\//g,'-')}">
      <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:4px">
        <div class="model-id" style="flex:1;cursor:pointer" onclick="event.stopPropagation();copyId('${esc(m.id)}')" title="Click to copy">${esc(m.id)}</div>
        <button class="btn btn-ghost btn-sm" style="padding:2px 7px;font-size:11px;flex-shrink:0" onclick="event.stopPropagation();copyId('${esc(m.id)}')" title="Copy model ID">⎘</button>
      </div>
      <div class="model-name">${esc(m.name)}</div>
      <div class="model-meta">
        <span class="badge badge-blue">${esc(m.org)}</span>
        <span class="badge ${catBadge(m.category)}">${catIcon(m.category)} ${esc(m.category)}</span>
        <span class="badge badge-green">free</span>
        <span class="model-ctx">${formatCtx(m.ctx)}</span>
      </div>
    </div>
  `).join('');
}


async function loadModelStatus() {
  try {
    const status = await api('/api/models/status');
    Object.entries(status || {}).forEach(([id, st]) => updateModelCardStatus(id, !!st.ok));
  } catch {}
}

function updateModelCardStatus(modelId, isLive) {
  const card = document.getElementById('mc-' + modelId.replace(/\//g, '-'));
  if (!card) return;
  let dot = card.querySelector('.verify-dot');
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'verify-dot';
    dot.style.cssText = 'width:7px;height:7px;border-radius:50%;display:inline-block;margin-left:4px;';
    card.querySelector('.model-id')?.appendChild(dot);
  }
  dot.style.background = isLive ? 'var(--green)' : 'var(--red)';
  dot.title = isLive ? 'Live ✓' : 'Dead ✗';
}

function catBadge(c){return c==='code'?'badge-purple':c==='reasoning'?'badge-amber':c==='multimodal'?'badge-blue':c==='safety'?'badge-red':'badge-gray'}
function catIcon(c){return c==='code'?'💻':c==='reasoning'?'🧠':c==='multimodal'?'👁️':c==='safety'?'🛡️':'💬'}
function formatCtx(n){
  if(n>=10000000) return '10M ctx';
  if(n>=1000000) return '1M ctx';
  if(n>=200000) return '200k ctx';
  if(n>=131072) return '128k ctx';
  if(n>=65536) return '64k ctx';
  if(n>=32768) return '32k ctx';
  return '8k ctx';
}

function copyId(id) {
  navigator.clipboard.writeText(id).then(() => toast('Copied: ' + id.split('/').pop() + ' ✓', 'success'));
}

function selectModel(id) {
  selectedModelId = id;
  document.querySelectorAll('.model-card').forEach(c => c.classList.remove('selected'));
  const el = document.getElementById('mc-' + id.replace(/\//g,'-'));
  if (el) el.classList.add('selected');
  // Set in chat too
  const sel = document.getElementById('chat-model');
  if (sel) sel.value = id;
}

function copyModelId() {
  if (!selectedModelId) return;
  copyId(selectedModelId);
}

function populateChatModelSelect(models) {
  const sel = document.getElementById('chat-model');
  sel.innerHTML = models.map(m => `<option value="${esc(m.id)}">${esc(m.name)} — ${esc(m.id)}</option>`).join('');
if (models.find(m => m.id === selectedModelId)) sel.value = selectedModelId;
  else sel.value = models.find(m => m.id === 'meta/llama-3.3-70b-instruct') ? 'meta/llama-3.3-70b-instruct' : (models[0]?.id || '');
}

// ─── Chat ──────────────────────────────────────────────────────────────────
function toggleStream() {
  useStream = !useStream;
  document.getElementById('stream-btn').textContent = 'Stream: ' + (useStream ? 'ON' : 'OFF');
}

function clearChat() {
  chatHistory = [];
  document.getElementById('chat-msgs').innerHTML = '<div class="msg system-msg">Chat cleared</div>';
  saveChatHistory();
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  document.getElementById('chat-model').addEventListener('change', function() {
    const model = allModels.find(m => m.id === this.value);
    const isImage = model?.category === 'image';
    const ctrls = document.getElementById('image-controls');
    if (ctrls) ctrls.style.display = isImage ? 'flex' : 'none';
    const streamBtn = document.getElementById('stream-btn');
    if (streamBtn) {
      streamBtn.style.opacity = isImage ? '0.4' : '1';
      streamBtn.title = isImage ? 'Stream is handled automatically for image models' : '';
    }
  });
});

let currentAbortController = null;
let chatTimerInterval = null;

function stopChat() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
}

function setChatBusy(busy) {
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const input = document.getElementById('chat-input');
  sendBtn.style.display = busy ? 'none' : '';
  stopBtn.style.display = busy ? '' : 'none';
  input.disabled = busy;
  if (!busy) {
    clearInterval(chatTimerInterval);
    document.getElementById('chat-status').textContent = '';
    input.focus();
  }
}

function startElapsedTimer() {
  const start = Date.now();
  const status = document.getElementById('chat-status');
  clearInterval(chatTimerInterval);
  chatTimerInterval = setInterval(() => {
    const s = ((Date.now() - start) / 1000).toFixed(1);
    status.textContent = `⏱ ${s}s — reasoning models may take 30-60s before first token`;
  }, 500);
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  const model = document.getElementById('chat-model').value;
  if (!model) { toast('Select a model first', 'error'); return; }

  input.value = '';
  setChatBusy(true);
  startElapsedTimer();

  appendMsg('user', text);
  chatHistory.push({ role: 'user', content: text });
  saveChatHistory();

  const thinkEl = appendMsg('assistant', '', true);

  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  try {
    const modelMeta = allModels.find(m => m.id === model);
    const body = {
      model,
      messages: chatHistory,
      max_tokens: parseInt(document.getElementById('chat-maxtok').value) || 1024,
      temperature: parseFloat(document.getElementById('chat-temp').value) || 0.7,
      stream: useStream
    };
    if (modelMeta?.category === 'image') body.size = document.getElementById('image-size')?.value || '1024x1024';

    if (useStream) {
      // Show pipeline progress overlay if using a pipeline model
      if (model.startsWith('pipeline/')) showPipelineProgress();
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer proxy' },
        body: JSON.stringify(body),
        signal
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        thinkEl.remove();
        appendMsg('system-msg', '❌ Error: ' + (err.error?.message || JSON.stringify(err)));
        return;
      }
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (ctype.includes('application/json')) {
        const data = await res.json().catch(() => ({}));
        thinkEl.remove();
        const reply = data.choices?.[0]?.message?.content || data.error?.message || '(empty response)';
        appendMsg(data.error ? 'system-msg' : 'assistant', data.error ? `❌ ${reply}` : reply);
        if (!data.error && reply.trim()) {
          chatHistory.push({ role: 'assistant', content: reply });
          saveChatHistory();
        }
        hidePipelineProgress();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = '';
      let msgEl = document.createElement('div');
      msgEl.className = 'msg assistant';
      msgEl.textContent = '';
      thinkEl.replaceWith(msgEl);

      // Clear timer on first token
      let firstToken = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstToken) {
          firstToken = true;
          clearInterval(chatTimerInterval);
          document.getElementById('chat-status').textContent = '● streaming...';
        }
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        let i = 0;
        while (i < lines.length) {
          const line = lines[i];
          // Pipeline status event
          if (line === 'event: pipeline_status') {
            const dataLine = lines[++i] || '';
            if (dataLine.startsWith('data: ')) {
              try {
                const ev = JSON.parse(dataLine.slice(6));
                updatePipelineProgress(ev);
              } catch {}
            }
          } else if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const d = JSON.parse(line.slice(6));
              const delta = d.choices?.[0]?.delta?.content || '';
              if (delta) {
                full += delta;
                msgEl.textContent = full;
                scrollChatBottom();
              }
            } catch {}
          }
          i++;
        }
      }
      hidePipelineProgress();
      chatHistory.push({ role: 'assistant', content: full });
      saveChatHistory();
      if (!full.trim()) {
        appendMsg('system-msg', '⚠️ Model returned empty response. Try again or switch model.');
      }

    } else {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer proxy' },
        body: JSON.stringify(body),
        signal
      });
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        const match = rawText.match(/\{[\s\S]+\}/);
        data = match ? JSON.parse(match[0]) : { error: { message: rawText.slice(0, 200) } };
      }
      thinkEl.remove();
      if (data.error) {
        appendMsg('system-msg', '❌ ' + (data.error.message || JSON.stringify(data.error)));
      } else {
        const reply = data.choices?.[0]?.message?.content || '';
        appendMsg('assistant', reply || '(empty response)');
        if (reply.trim()) chatHistory.push({ role: 'assistant', content: reply });
        saveChatHistory();
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      thinkEl.remove && thinkEl.remove();
      appendMsg('system-msg', '⏹ Stopped by user');
    } else {
      thinkEl.remove && thinkEl.remove();
      appendMsg('system-msg', '❌ ' + e.message);
    }
  } finally {
    currentAbortController = null;
    setChatBusy(false);
  }
}

function appendMsg(role, text, thinking = false) {
  const wrap = document.getElementById('chat-msgs');
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  if (thinking) {
    el.innerHTML = '<div class="thinking"><span></span><span></span><span></span></div>';
  } else {
    renderMessageContent(el, text);
  }
  wrap.appendChild(el);
  scrollChatBottom();
  return el;
}

function renderMessageContent(el, text) {
  const imgMatch = /^!\[[^\]]*\]\((data:image\/[^)]+|https?:\/\/[^)]+)\)$/.exec((text || '').trim());
  if (imgMatch) {
    const img = document.createElement('img');
    img.src = imgMatch[1];
    img.alt = 'generated image';
    img.style.maxWidth = '100%';
    img.style.borderRadius = '8px';
    el.appendChild(img);
    return;
  }
  el.innerHTML = renderMarkdown(text || '');
}


function renderMarkdown(text) {
  return esc(text)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre class="code-block" data-lang="${lang}"><code>${code}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

function scrollChatBottom() {
  const msgs = document.getElementById('chat-msgs');
  msgs.scrollTop = msgs.scrollHeight;
}

// ─── Logs ──────────────────────────────────────────────────────────────────
async function refreshLogs() {
  try {
    const filter = document.getElementById('log-filter').value;
    const params = filter ? `?filter=${encodeURIComponent(filter)}&limit=200` : '?limit=200';
    const logs = await api('/api/logs' + params);
    renderLogs(logs);
    lastLogId = logs[0]?.id || lastLogId;
    const badge = document.getElementById('log-badge');
    if (logs.length > 0) { badge.style.display=''; badge.textContent=logs.length; }
  } catch {}
}

function renderLogs(logs) {
  const el = document.getElementById('logs-list');
  if (logs.length === 0) { el.innerHTML = '<div class="empty">No logs yet — make a request to see detailed logs here</div>'; return; }
  
  // Stats bar
  const statsBar = document.getElementById('log-stats-bar');
  if (statsBar) {
    const successes = logs.filter(l => l.statusCode===200 && !l.errorType).length;
    const quotas = logs.filter(l => l.statusCode===429 || l.errorType==='QUOTA_EXCEEDED').length;
    const errors = logs.filter(l => l.errorType && l.errorType!=='QUOTA_EXCEEDED').length;
    const totalTok = logs.reduce((s,l)=>s+(l.totalTokens||0),0);
    const avgLat = logs.filter(l=>l.latencyMs).length
      ? Math.round(logs.filter(l=>l.latencyMs).reduce((s,l)=>s+l.latencyMs,0)/logs.filter(l=>l.latencyMs).length)
      : 0;
    statsBar.innerHTML = `
      <span style="color:var(--green)">✓ ${successes} success</span>
      <span style="color:var(--amber)">⚡ ${quotas} quota</span>
      <span style="color:var(--red)">✗ ${errors} error</span>
      ${totalTok > 0 ? `<span style="color:var(--cyan)">🪙 ${totalTok.toLocaleString()} tokens</span>` : ''}
      ${avgLat > 0 ? `<span style="color:var(--text3)">⏱ ${avgLat}ms avg</span>` : ''}
      <span style="color:var(--text3)">${logs.length} entries</span>
    `;
  }

  el.innerHTML = logs.map(l => renderLog(l)).join('');

  // Dashboard recent
  const dashLogs = document.getElementById('dash-logs');
  if (dashLogs) dashLogs.innerHTML = logs.slice(0,5).map(l => renderLog(l)).join('');
}

function renderLog(l) {
  const isError = l.errorType && !['QUOTA_EXCEEDED'].includes(l.errorType);
  const isQuota = l.errorType === 'QUOTA_EXCEEDED';
  const isSuccess = !l.errorType && l.statusCode === 200;
  const isMeta = l.method === 'META';
  const cls = isMeta ? 'meta' : isQuota ? 'quota' : isError ? 'error' : isSuccess ? 'success' : '';

  const statusBadge = l.statusCode
    ? `<span class="badge ${l.statusCode===200?'badge-green':l.statusCode===429?'badge-amber':'badge-red'}">${l.statusCode}</span>`
    : `<span class="badge badge-gray">???</span>`;

  const modelShort = l.model && l.model!=='unknown' 
    ? l.model.split('/').pop() 
    : null;

  const tokenInfo = l.totalTokens 
    ? `<span style="color:var(--cyan);font-size:11px">🪙 ${l.totalTokens}</span>` 
    : l.streaming ? `<span style="color:var(--purple);font-size:11px">⟳ stream</span>` : '';

  const detail = buildLogDetail(l);

  return `<div class="log-entry ${cls}" onclick="this.classList.toggle('expanded')">
    <div class="log-header">
      <span class="log-time">${l.timestamp?.slice(0,23).replace('T',' ') || ''}</span>
      <span style="color:var(--text3);font-size:11px;min-width:24px">#${l.requestNumber||''}</span>
      <span class="log-method">${l.method||''}</span>
      <span class="log-endpoint" style="font-size:12px">${esc(l.endpoint||l.event||'')}</span>
      ${modelShort ? `<span class="log-model" title="${esc(l.model)}">${esc(modelShort)}</span>` : ''}
      ${statusBadge}
      ${l.errorType ? `<span class="badge badge-red" style="font-size:10px">${esc(l.errorType.replace(/_/g,' '))}</span>` : ''}
      ${tokenInfo}
      ${l.keyMasked ? `<span class="log-key" style="font-size:11px">${esc(l.keyMasked)}</span>` : ''}
      ${l.latencyMs ? `<span class="log-latency">${l.latencyMs}ms</span>` : ''}
    </div>
    <div class="log-detail">${esc(detail)}</div>
  </div>`;
}

function buildLogDetail(l) {
  const lines = [];
  if (l.requestNumber) lines.push(`Request #${l.requestNumber}`);
  if (l.model && l.model!=='unknown') lines.push(`Model: ${l.model}`);
  if (l.keyLabel) lines.push(`Key: ${l.keyLabel} (${l.keyMasked})`);
  if (l.latencyMs) lines.push(`Latency: ${l.latencyMs}ms`);
  if (l.triedKeys > 1) lines.push(`Keys tried: ${l.triedKeys}`);
  if (l.totalTokens) lines.push(`Tokens: ${l.promptTokens||0} prompt + ${l.completionTokens||0} completion = ${l.totalTokens} total`);
  if (l.streaming) lines.push(`Streaming: ${l.streamChunks} chunks, ${l.streamBytes} bytes`);
  if (l.errorType) lines.push(`Error type: ${l.errorType}`);
  if (l.errorDetail) lines.push(`Error: ${l.errorDetail}`);
  if (l.willRetry === true) lines.push('Action: Retried with next key');
  if (l.requestBody) lines.push(`Request body: ${l.requestBody}`);
  if (l.responseSnippet) lines.push(`Response: ${l.responseSnippet}`);
  return lines.join('\n');
}

async function clearLogs() {
  if (!confirm('Clear all logs?')) return;
  await api('/api/logs', 'DELETE');
  toast('Logs cleared', 'info');
  refreshLogs();
}

function exportLogs() {
  api('/api/logs?limit=1000').then(logs => {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nvidia-proxy-logs-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
    a.click();
    toast(`Exported ${logs.length} log entries ✓`, 'success');
  });
}

function toggleAutoRefresh() {
  autoRefresh = !autoRefresh;
  document.getElementById('auto-refresh-btn').textContent = 'Auto: ' + (autoRefresh ? 'ON' : 'OFF');
}

async function addCustomModelPrompt() {
  const id = prompt('Model ID (e.g. org/model-name)');
  if (!id) return;
  const name = prompt('Display name');
  if (!name) return;
  const category = prompt('Category (llm/code/reasoning/multimodal/image)', 'llm') || 'llm';
  try {
    await api('/api/models/custom', 'POST', { id, name, category, org: id.split('/')[0] || 'custom', free: true });
    toast('Custom model added ✓', 'success');
    loadModels();
  } catch (e) { toast(e.message, 'error'); }
}

async function removeCustomModelPrompt() {
  const id = prompt('Model ID to remove');
  if (!id) return;
  try {
    await api('/api/models/custom/' + encodeURIComponent(id), 'DELETE');
    toast('Custom model removed ✓', 'success');
    loadModels();
  } catch (e) { toast(e.message, 'error'); }
}

async function verifyModelPrompt() {
  const model = prompt('Model ID to verify', document.getElementById('chat-model')?.value || '');
  if (!model) return;
  const type = (prompt('Type? chat or image', 'chat') || 'chat').toLowerCase();
  try {
    const res = await api('/api/models/verify', 'POST', { model, type });
    toast(`Verify ${model}: ${res.status} ${res.ok ? 'OK' : 'FAIL'}`, res.ok ? 'success' : 'error');
  } catch (e) { toast(e.message, 'error'); }
}

const verifyStatus = new Map();
function showVerifyPanel(){ const p=document.getElementById('verify-panel'); if (p) p.style.display='block'; }
async function verifyAllBatched() {
  const BATCH_SIZE = 4, DELAY_MS = 1500;
  const panel = document.getElementById('verify-progress');
  const bar = document.getElementById('verify-bar');
  const statusEl = document.getElementById('verify-status');
  const resultsEl = document.getElementById('verify-results');
  panel.style.display = 'block'; resultsEl.innerHTML='';
  const toCheck = allModels.filter(m => m.category !== 'image' && m.category !== 'pipeline');
  let done = 0;
  for (let i=0; i<toCheck.length; i+=BATCH_SIZE) {
    const batch = toCheck.slice(i, i+BATCH_SIZE);
    await Promise.all(batch.map(async (m) => {
      try {
        const res = await fetch('/api/models/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ model:m.id, type:'chat' }), signal: AbortSignal.timeout(15000) });
        const data = await res.json().catch(() => ({ ok:false, status:0 }));
        verifyStatus.set(m.id, { ok: !!data.ok, status: data.status, ts: Date.now() });
        updateModelCardStatus(m.id, !!data.ok);
        const row=document.createElement('div'); row.style.cssText='padding:3px 0;border-bottom:1px solid var(--border)';
        row.innerHTML=`<span style="color:${data.ok?'var(--green)':'var(--red)'}">${data.ok?'✅':'❌'}</span> <b>${esc(m.id)}</b> <span style="color:var(--text3)">[${data.status}]</span>`;
        resultsEl.appendChild(row);
      } catch { verifyStatus.set(m.id, { ok:false, status:0, ts:Date.now() }); }
      done++; bar.style.width=(done/toCheck.length*100)+'%'; statusEl.textContent=`${done}/${toCheck.length} checked`;
    }));
    if (i + BATCH_SIZE < toCheck.length) await new Promise(r => setTimeout(r, DELAY_MS));
  }
  const pass=[...verifyStatus.values()].filter(v=>v.ok).length;
  toast(`Verify done: ${pass} live / ${toCheck.length-pass} dead`, pass < toCheck.length ? 'error':'success');
}

// ─── Helpers ───────────────────────────────────────────────────────────────
async function api(path, method='GET', body=null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = {};
  try {
    const firstLine = text.split('\n').find(l => {
      const t = l.trim();
      return t.startsWith('{') || t.startsWith('[');
    });
    data = JSON.parse(firstLine || text || '{}');
  } catch {
    const preview = text.slice(0, 120).replace(/\n/g, ' ');
    throw new Error(preview || 'Non-JSON response from server');
  }
  if (!res.ok) throw new Error(data?.error?.message || data?.error || data?.detail || 'Request failed');
  return data;
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return Math.floor(diff/1000) + 's ago';
  if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
  return Math.floor(diff/3600000) + 'h ago';
}

function toast(msg, type='info') {
  const el = document.createElement('div');
  el.className = 'toast-msg ' + type;
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ─── PIPELINE ──────────────────────────────────────────────────────────────

const PIPELINE_DEFAULTS = {
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

function populatePipelineSelects(models, current = {}) {
  const allKeys = ['planner', 'synthesizer', ...Object.keys(TASK_CONFIG)];
  allKeys.forEach(type => {
    const sel = document.getElementById('pf-' + type);
    if (!sel) return;
    sel.innerHTML = '';
    const cats = {};
    models.forEach(m => { (cats[m.category] = cats[m.category] || []).push(m); });
    Object.entries(cats).forEach(([cat, ms]) => {
      const og = document.createElement('optgroup');
      og.label = cat.toUpperCase();
      ms.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name || m.id;
        og.appendChild(opt);
      });
      sel.appendChild(og);
    });
    const wanted = current[type] || PIPELINE_DEFAULTS[type];
    if (wanted) sel.value = wanted;
  });
}

async function showPipelineForm(pipeline = null) {
  document.getElementById('pipeline-form').style.display = 'block';
  const models = await loadAllModels();
  populatePipelineSelects(models, pipeline ? pipeline.models : {});
  if (pipeline) {
    document.getElementById('pf-name').value = pipeline.name;
    document.getElementById('pf-slug').value = pipeline.slug;
    document.getElementById('pf-max').value = pipeline.maxSubtasks || 4;
    document.getElementById('pf-slug').dataset.editId = pipeline.id;
    document.getElementById('pf-custom-tasks').value = JSON.stringify(pipeline.customTasks || [], null, 2);
  } else {
    document.getElementById('pf-name').value = '';
    document.getElementById('pf-slug').value = '';
    document.getElementById('pf-max').value = '4';
    delete document.getElementById('pf-slug').dataset.editId;
    document.getElementById('pf-custom-tasks').value = '[]';
  }
  document.getElementById('pf-name').focus();
  document.getElementById('pipeline-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hidePipelineForm() {
  document.getElementById('pipeline-form').style.display = 'none';
}

function autoPipelineSlug() {
  const name = document.getElementById('pf-name').value;
  const slugEl = document.getElementById('pf-slug');
  if (!slugEl.dataset.editId) {
    slugEl.value = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  }
}

async function createPipeline() {
  const name = document.getElementById('pf-name').value.trim();
  const slug = document.getElementById('pf-slug').value.trim();
  const editId = document.getElementById('pf-slug').dataset.editId;
  const maxSubtasks = parseInt(document.getElementById('pf-max').value) || 4;
  if (!name || !slug) { toast('Name and slug are required', 'error'); return; }
  if (!/^[a-z0-9-]+$/.test(slug)) { toast('Slug: only lowercase letters, numbers, hyphens', 'error'); return; }

  const models = {};
  const enabledTasks = {};
  let customTasks = [];
  try { customTasks = JSON.parse(document.getElementById('pf-custom-tasks').value || '[]'); if (!Array.isArray(customTasks)) throw new Error('invalid'); } catch { return toast('Custom tasks must be valid JSON array', 'error'); }
  ['planner', 'synthesizer', ...Object.keys(TASK_CONFIG)].forEach(type => {
    const sel = document.getElementById('pf-' + type);
    if (sel) models[type] = sel.value;
    const chk = document.getElementById('pf-enable-' + type);
    enabledTasks[type] = chk ? !!chk.checked : true;
  });

  try {
    if (editId) {
      await api('/api/pipelines/' + editId, 'PATCH', { name, maxSubtasks, models, enabledTasks, customTasks });
      toast('Pipeline updated ✓', 'success');
    } else {
      await api('/api/pipelines', 'POST', { name, slug, maxSubtasks, models, enabledTasks, customTasks });
      toast('Pipeline created ✓', 'success');
    }
    hidePipelineForm();
    loadPipelines();
    loadModels();
  } catch (e) {
    toast(e.message || 'Error saving pipeline', 'error');
  }
}

function setupArenaModels() {
  const ids = ['arena-model-1', 'arena-model-2', 'arena-model-3'];
  const sels = ids.map(id => document.getElementById(id)).filter(Boolean);
  if (!sels.length || !allModels.length) return;
  const opts = allModels.map(m => `<option value="${esc(m.id)}">${esc(m.name)} — ${esc(m.id)}</option>`).join('');
  sels.forEach((sel, i) => {
    const prev = sel.value;
    sel.innerHTML = `<option value="">(off)</option>${opts}`;
    sel.value = prev || allModels[i]?.id || '';
  });
}

async function runArena() {
  const prompt = document.getElementById('arena-input')?.value?.trim();
  if (!prompt) return toast('Arena prompt required', 'error');
  const models = ['arena-model-1', 'arena-model-2', 'arena-model-3'].map(id => document.getElementById(id)?.value).filter(Boolean);
  if (!models.length) return toast('Select at least one model', 'error');
  const out = document.getElementById('arena-results');
  lastArenaResults = models.map(model => ({ model, ms: 0, ok: false, text: 'Running...' }));
  out.innerHTML = models.map((model, i) => `<div class="card" id="arena-card-${i}"><div class="card-title">${esc(model)} · running...</div><pre id="arena-pre-${i}">Waiting for response...</pre></div>`).join('');
  await Promise.all(models.map((model, i) => runArenaForModel(model, prompt, i)));
}

function clearArena() {
  const input = document.getElementById('arena-input');
  const out = document.getElementById('arena-results');
  if (input) input.value = '';
  if (out) out.innerHTML = '';
  lastArenaResults = [];
}

function toggleArenaStream() {
  arenaUseStream = !arenaUseStream;
  const btn = document.getElementById('arena-stream-btn');
  if (btn) btn.textContent = 'Arena Stream: ' + (arenaUseStream ? 'ON' : 'OFF');
}

async function runArenaForModel(model, prompt, idx) {
  const t0 = Date.now();
  const card = document.getElementById(`arena-card-${idx}`);
  const pre = document.getElementById(`arena-pre-${idx}`);
  try {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer proxy' },
      body: JSON.stringify({ model, stream: arenaUseStream, messages: [{ role: 'user', content: prompt }] })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const text = err.error?.message || JSON.stringify(err) || 'Request failed';
      updateArenaCard(idx, model, false, Date.now() - t0, text);
      return;
    }
    if (!arenaUseStream) {
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '(empty)';
      updateArenaCard(idx, model, true, Date.now() - t0, text);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try { full += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || ''; } catch {}
      }
      if (pre) pre.textContent = full || '...';
    }
    updateArenaCard(idx, model, true, Date.now() - t0, full || '(empty)');
  } catch (e) {
    updateArenaCard(idx, model, false, Date.now() - t0, e.message);
  }
}

function updateArenaCard(idx, model, ok, ms, text) {
  const card = document.getElementById(`arena-card-${idx}`);
  const pre = document.getElementById(`arena-pre-${idx}`);
  if (card) card.querySelector('.card-title').textContent = `${model} · ${ms}ms · ${ok ? 'OK' : 'ERR'}`;
  if (pre) pre.textContent = text;
  lastArenaResults[idx] = { model, ms, ok, text };
}

async function loadPipelines() {
  try {
    const data = await api('/api/pipelines');
    renderPipelines(data);
    const badge = document.getElementById('pipeline-badge');
    if (data.length > 0) { badge.textContent = data.length; badge.style.display = ''; }
    else badge.style.display = 'none';
  } catch (e) { console.error('loadPipelines', e); }
}

function renderPipelines(ps) {
  const el = document.getElementById('pipeline-list');
  if (!ps.length) {
    el.innerHTML = '<div class="empty">No pipelines yet — click "New Pipeline" to create one</div>';
    return;
  }
  el.innerHTML = ps.map(p => pipelineCard(p)).join('');
}

function pipelineCard(p) {
  const port = location.port || '3000';
  const modelId = `pipeline/${p.slug}`;
  const baseUrl = `${location.protocol}//${location.hostname}:${port}/v1`;
  const total = p.stats?.total || 0;
  const avgSub = p.stats?.avgSubtasks || 0;
  const lastUsed = p.stats?.lastUsed ? relTime(p.stats.lastUsed) : 'never';

  const specialistGrid = Object.entries(TASK_CONFIG).map(([t, cfg]) => {
    const modelName = (p.models[t] || PIPELINE_DEFAULTS[t] || '').split('/').slice(-1)[0];
    return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:8px 10px;min-width:0">
      <div style="font-size:11px;color:var(--text3);margin-bottom:3px">${cfg.icon} ${cfg.label}</div>
      <div style="font-size:10px;color:${cfg.color};overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${p.models[t] || ''}">${modelName}</div>
    </div>`;
  }).join('');

  const plannerName = (p.models.planner || PIPELINE_DEFAULTS.planner || '').split('/').slice(-1)[0];
  const synthName   = (p.models.synthesizer || PIPELINE_DEFAULTS.synthesizer || '').split('/').slice(-1)[0];

  return `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--text)">${esc(p.name)}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">Created ${relTime(p.createdAt)} · Last used ${lastUsed} · ${total} runs · avg ${avgSub} subtasks · max ${p.maxSubtasks}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-ghost btn-sm" onclick="editPipeline('${p.id}')">✏️ Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deletePipeline('${p.id}')">Delete</button>
      </div>
    </div>
    <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:12px">
      <div style="font-size:11px;color:var(--text3);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Use in any OpenAI-compatible client</div>
      <div style="display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:6px;margin-bottom:6px">
        <span style="font-size:11px;color:var(--text3)">Base URL</span>
        <code style="font-size:12px;color:var(--cyan);background:var(--bg4);padding:3px 8px;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${baseUrl}</code>
        <button class="btn btn-ghost btn-sm" onclick="copyText('${baseUrl}','Base URL copied')">Copy</button>
      </div>
      <div style="display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:6px">
        <span style="font-size:11px;color:var(--text3)">Model ID</span>
        <code style="font-size:12px;color:var(--cyan);background:var(--bg4);padding:3px 8px;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${modelId}</code>
        <button class="btn btn-ghost btn-sm" onclick="copyText('${modelId}','Model ID copied')">Copy</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
      <div style="background:var(--blue-bg);border:1px solid var(--blue);border-radius:6px;padding:8px 10px">
        <div style="font-size:11px;color:var(--blue);margin-bottom:3px">📋 Planner</div>
        <div style="font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.models.planner||'')}">${esc(plannerName)}</div>
      </div>
      <div style="background:var(--purple-bg);border:1px solid var(--purple);border-radius:6px;padding:8px 10px">
        <div style="font-size:11px;color:var(--purple);margin-bottom:3px">🔮 Synthesizer</div>
        <div style="font-size:11px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(p.models.synthesizer||'')}">${esc(synthName)}</div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Specialist Models</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${specialistGrid}</div>
  </div>`;
}

async function editPipeline(id) {
  const ps = await api('/api/pipelines');
  const p = ps.find(x => x.id === id);
  if (!p) return;
  showPipelineForm(p);
}

async function deletePipeline(id) {
  if (!confirm('Delete this pipeline?')) return;
  try {
    await api('/api/pipelines/' + id, 'DELETE');
    toast('Pipeline deleted', 'success');
    loadPipelines();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

function showPipelineProgress() {
  const el = document.getElementById('pipeline-progress');
  if (el) { el.style.display = 'block'; document.getElementById('pipeline-steps').innerHTML = ''; }
}

function hidePipelineProgress() {
  const el = document.getElementById('pipeline-progress');
  if (el) el.style.display = 'none';
}

function updatePipelineProgress(ev) {
  const container = document.getElementById('pipeline-steps');
  if (!container) return;
  if (ev.step === 'planning') {
    container.innerHTML = `<div style="font-size:12px;color:var(--cyan)">📋 Planning... (${esc(ev.model?.split('/').pop()||'')})</div>`;
  } else if (ev.step === 'plan_ready') {
    const pills = (ev.subtasks||[]).map(s =>
      `<span style="background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:11px;color:var(--text2)">${esc(s.label||s.type)}</span>`
    ).join(' ');
    container.innerHTML = `<div style="font-size:12px;color:var(--green);margin-bottom:4px">✓ Plan — ${(ev.subtasks||[]).length} subtasks</div><div style="display:flex;flex-wrap:wrap;gap:4px">${pills}</div>`;
  } else if (ev.step === 'executing') {
    const html = `<div data-idx="${ev.index}" style="font-size:12px;color:var(--amber)">⟳ [${esc(ev.type)}] ${esc(ev.label||'')} → ${esc(ev.model?.split('/').pop()||'')}</div>`;
    const existing = container.querySelector(`[data-idx="${ev.index}"]`);
    if (existing) existing.outerHTML = html; else container.insertAdjacentHTML('beforeend', html);
  } else if (ev.step === 'subtask_done') {
    const html = `<div data-idx="${ev.index}" style="font-size:12px;color:var(--green)">✓ [${esc(ev.type)}] ${esc(ev.label||'')} (${ev.chars} chars)</div>`;
    const existing = container.querySelector(`[data-idx="${ev.index}"]`);
    if (existing) existing.outerHTML = html; else container.insertAdjacentHTML('beforeend', html);
  } else if (ev.step === 'subtask_error') {
    const html = `<div data-idx="${ev.index}" style="font-size:12px;color:var(--red)">✗ [${esc(ev.type)}] ${esc(ev.error||'error')}</div>`;
    const existing = container.querySelector(`[data-idx="${ev.index}"]`);
    if (existing) existing.outerHTML = html; else container.insertAdjacentHTML('beforeend', html);
  } else if (ev.step === 'synthesizing') {
    container.insertAdjacentHTML('beforeend', `<div style="font-size:12px;color:var(--cyan);margin-top:4px">🔮 Synthesizing... (${esc(ev.model?.split('/').pop()||'')})</div>`);
  } else if (ev.step === 'error') {
    container.insertAdjacentHTML('beforeend', `<div style="font-size:12px;color:var(--red)">❌ ${esc(ev.message||'Pipeline error')}</div>`);
  }
}

// ─── Boot ──────────────────────────────────────────────────────────────────
init();

// ─── ROUTER ────────────────────────────────────────────────────────────────
let allModelsCache = [];

// Default picks per task type
const ROUTER_DEFAULTS = {
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

const TASK_CONFIG = {
  general:       { icon: '💬', label: 'General',       desc: 'Default fallback — casual Q&A',             color: 'var(--blue)'   },
  code:          { icon: '💻', label: 'Code',          desc: 'Code, debug, implement, explain',           color: 'var(--purple)' },
  reasoning:     { icon: '🧠', label: 'Reasoning',     desc: 'Analyze, compare, evaluate',                color: 'var(--amber)'  },
  multimodal:    { icon: '👁️', label: 'Multimodal',    desc: 'Image inputs in prompt',                   color: 'var(--cyan)'   },
  math:          { icon: '📐', label: 'Math',          desc: 'Equations, proofs, calculations',           color: 'var(--green)'  },
  creative:      { icon: '✍️', label: 'Creative',      desc: 'Stories, poems, scripts, brainstorm',       color: 'var(--purple)' },
  summarization: { icon: '📄', label: 'Summarization', desc: 'Long docs — needs large context model',     color: 'var(--blue)'   },
  translation:   { icon: '🌐', label: 'Translation',   desc: 'Language conversion, multilingual',         color: 'var(--green)'  },
  factual:       { icon: '⚡', label: 'Factual',       desc: 'Quick facts, definitions → fast model',    color: 'var(--amber)'  },
};

async function loadAllModels() {
  if (allModelsCache.length) return allModelsCache;
  try {
    const data = await api('/api/models');
    allModelsCache = data.filter(m => m.category !== 'router');
    return allModelsCache;
  } catch { return []; }
}

function populateRouterSelects(models, current = {}) {
  Object.keys(TASK_CONFIG).forEach(type => {
    const sel = document.getElementById('rf-' + type);
    if (!sel) return;
    sel.innerHTML = '';
    const cats = {};
    models.forEach(m => { (cats[m.category] = cats[m.category] || []).push(m); });
    Object.entries(cats).forEach(([cat, ms]) => {
      const og = document.createElement('optgroup');
      og.label = cat.toUpperCase();
      ms.forEach(m => {
        const o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.name || m.id;
        if ((current[type] || ROUTER_DEFAULTS[type]) === m.id) o.selected = true;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    if (!sel.value) sel.value = models[0]?.id || '';
  });
}

async function showRouterForm(router = null) {
  document.getElementById('router-form').style.display = 'block';
  const models = await loadAllModels();
  populateRouterSelects(models, router ? router.models : {});
  if (router) {
    document.getElementById('rf-name').value = router.name;
    document.getElementById('rf-slug').value = router.slug;
    document.getElementById('rf-slug').dataset.editId = router.id;
  } else {
    document.getElementById('rf-name').value = '';
    document.getElementById('rf-slug').value = '';
    delete document.getElementById('rf-slug').dataset.editId;
  }
  document.getElementById('rf-name').focus();
  document.getElementById('router-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideRouterForm() {
  document.getElementById('router-form').style.display = 'none';
}

function autoSlug() {
  const name = document.getElementById('rf-name').value;
  const slugEl = document.getElementById('rf-slug');
  if (!slugEl.dataset.editId) { // don't auto-overwrite when editing
    slugEl.value = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  }
}

async function createRouter() {
  const name = document.getElementById('rf-name').value.trim();
  const slug = document.getElementById('rf-slug').value.trim();
  const editId = document.getElementById('rf-slug').dataset.editId;
  if (!name || !slug) { toast('Name and slug are required', 'error'); return; }
  if (!/^[a-z0-9-]+$/.test(slug)) { toast('Slug: only lowercase letters, numbers, hyphens', 'error'); return; }

  const models = {};
  Object.keys(TASK_CONFIG).forEach(type => {
    const sel = document.getElementById('rf-' + type);
    if (sel) models[type] = sel.value;
  });

  try {
    if (editId) {
      await api('/api/routers/' + editId, 'PATCH', { name, models });
      toast('Router updated ✓', 'success');
    } else {
      await api('/api/routers', 'POST', { name, slug, models });
      toast('Router created ✓', 'success');
    }
    hideRouterForm();
    loadRouters();
  } catch (e) {
    toast(e.message || 'Error saving router', 'error');
  }
}

async function loadRouters() {
  try {
    const data = await api('/api/routers');
    renderRouters(data);
    // Update badge
    const badge = document.getElementById('router-badge');
    if (data.length > 0) { badge.textContent = data.length; badge.style.display = ''; }
    else badge.style.display = 'none';
  } catch (e) { console.error('loadRouters', e); }
}

function renderRouters(rs) {
  const el = document.getElementById('router-list');
  if (!rs.length) {
    el.innerHTML = '<div class="empty">No router sessions yet — click "New Session" to create one</div>';
    return;
  }
  el.innerHTML = rs.map(r => routerCard(r)).join('');
}

function routerCard(r) {
  const port = location.port || '3000';
  const modelId = `router/${r.slug}`;
  const baseUrl = `${location.protocol}//${location.hostname}:${port}/v1`;
  const byType = r.stats?.byType || {};
  const total = r.stats?.total || 0;
  const lastUsed = r.stats?.lastUsed ? relTime(r.stats.lastUsed) : 'never';

  const taskBar = Object.entries(TASK_CONFIG).map(([t, cfg]) => {
    const n = byType[t] || 0;
    const pct = total > 0 ? Math.round(n / total * 100) : 0;
    const modelName = (r.models[t] || ROUTER_DEFAULTS[t] || '').split('/').slice(-1)[0];
    return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:8px 10px;min-width:0">
      <div style="font-size:11px;color:var(--text3);margin-bottom:3px">${cfg.icon} ${cfg.label}</div>
      <div style="font-size:12px;font-weight:600;color:${cfg.color}">${n} <span style="color:var(--text3);font-weight:400">(${pct}%)</span></div>
      <div style="font-size:10px;color:var(--text3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.models[t] || ''}">${modelName}</div>
    </div>`;
  }).join('');

  return `<div class="card" style="margin-bottom:16px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--text)">${esc(r.name)}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">Created ${relTime(r.createdAt)} · Last used ${lastUsed} · ${total} total requests</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-ghost btn-sm" onclick="editRouter('${r.id}')">✏️ Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteRouter('${r.id}')">Delete</button>
      </div>
    </div>

    <!-- Usage info -->
    <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:12px">
      <div style="font-size:11px;color:var(--text3);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:.5px">Use this router in any OpenAI-compatible client</div>
      <div style="display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:6px;margin-bottom:6px">
        <span style="font-size:11px;color:var(--text3)">Base URL</span>
        <code style="font-size:12px;color:var(--cyan);background:var(--bg4);padding:3px 8px;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${baseUrl}</code>
        <button class="btn btn-ghost btn-sm" onclick="copyText('${baseUrl}','Base URL copied')">Copy</button>
      </div>
      <div style="display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:6px">
        <span style="font-size:11px;color:var(--text3)">Model ID</span>
        <code style="font-size:12px;color:var(--purple);background:var(--bg4);padding:3px 8px;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${modelId}</code>
        <button class="btn btn-ghost btn-sm" onclick="copyText('${modelId}','Model ID copied')">Copy</button>
      </div>
    </div>

    <!-- Task breakdown -->
    <div style="font-size:11px;color:var(--text3);font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Route Map</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${taskBar}</div>
  </div>`;
}

async function editRouter(id) {
  const rs = await api('/api/routers');
  const r = rs.find(x => x.id === id);
  if (!r) return;
  showRouterForm(r);
}

async function deleteRouter(id) {
  if (!confirm('Delete this router session?')) return;
  try {
    await api('/api/routers/' + id, 'DELETE');
    toast('Router deleted', 'success');
    loadRouters();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

function copyText(text, msg) {
  navigator.clipboard.writeText(text).then(() => toast(msg || 'Copied!', 'success')).catch(() => toast('Copy failed', 'error'));
}


function copyArenaResults() {
  if (!lastArenaResults.length) return toast('No arena results', 'error');
  const txt = lastArenaResults.map(r => `Model: ${r.model}\nLatency: ${r.ms}ms\nStatus: ${r.ok ? 'OK' : 'ERR'}\n\n${r.text}`).join('\n\n---\n\n');
  navigator.clipboard.writeText(txt).then(() => toast('Arena results copied ✓', 'success'));
}

function exportArenaResults() {
  if (!lastArenaResults.length) return toast('No arena results', 'error');
  const blob = new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), results: lastArenaResults }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `arena-results-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.json`;
  a.click();
  toast('Arena results exported ✓', 'success');
}
