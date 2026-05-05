# 🚀 NVIDIA NIM Proxy Server

> OpenAI-compatible local proxy with multi-key rotation, smart routing, and multi-model pipelines — powered by NVIDIA's free NIM API.

---

## 📖 Project Kya Hai?

Yeh ek **Node.js proxy server** hai jo NVIDIA ke free AI models ko OpenAI-compatible format mein serve karta hai. Matlab jo bhi app/tool OpenAI API support karta hai (jaise OpenClaw, Continue, Cursor, etc.), woh seedha is proxy se connect ho sakta hai — NVIDIA ke free models use karke, bina koi extra cost ke.

**Key Idea:**
```
Your App (OpenAI format) → localhost:3000/v1 → NVIDIA NIM API
```

---

## 📁 Project Structure

```
project/
├── server.js        # Main backend — Express server, all API logic
├── index.html       # Web UI — single-file frontend (no build step)
├── package.json     # Dependencies (sirf express aur dotenv)
├── package-lock.json
├── .env             # API keys (auto-generated, gitignore karo ise!)
├── routers.json     # Saved router sessions (auto-generated)
└── pipelines.json   # Saved pipelines (auto-generated)
```

---

## ⚙️ Setup & Installation

### 1. Prerequisites
- **Node.js 18+** (native fetch ke liye zaroori hai)
- NVIDIA NIM API key — free mein milti hai: [build.nvidia.com](https://build.nvidia.com)

### 2. Install
```bash
npm install
```

### 3. API Key Configure Karo

`.env` file banao project root mein:
```env
PORT=3000

NVIDIA_API_KEY_1=nvapi-xxxxxxxxxxxxxxxxxxxx
NVIDIA_API_KEY_1_LABEL=My Key 1

# Optional: multiple keys for rotation
NVIDIA_API_KEY_2=nvapi-yyyyyyyyyyyyyyyyyyyy
NVIDIA_API_KEY_2_LABEL=My Key 2
```

### 4. Server Start Karo
```bash
node server.js
```

Web UI open karo: **http://localhost:3000**

---

## 🌐 Web UI — Tabs ka Overview

### 💬 Chat Tab
- Seedha browser se kisi bhi NVIDIA model se baat karo
- Model select karo, temperature/max tokens set karo
- Streaming aur non-streaming dono support karta hai
- Pipeline model select hone pe live progress overlay dikhta hai

### 🔑 Keys Tab
- API keys add/remove/enable/disable karo
- Har key ke stats dekho: requests, success, errors, quota hits
- Keys `.env` file mein auto-save hoti hain

### 🧩 Models Tab
- Saare available NVIDIA free models browse karo
- Filter by category: llm, code, reasoning, multimodal, math, creative, etc.
- Model ID copy karo directly clients ke liye

### 🔀 Router Tab
- Smart router banao jo automatically task type detect karke sahi model pe bheje
- Task types: General, Code, Reasoning, Math, Creative, Summarization, Translation, Factual, Multimodal
- Use karo: model ID = `router/your-slug`

### 🔗 Pipeline Tab
- Multi-model pipeline banao: Planner → N Specialists (parallel) → Synthesizer
- Har task type ke liye alag specialist model assign karo
- Use karo: model ID = `pipeline/your-slug`

### 📋 Logs Tab
- Har request ka detailed log dekho
- Filter by model, status, error type
- Latency, token usage, key used — sab dikhta hai
- Export JSON mein

---

## 🔀 Router — Kaise Kaam Karta Hai?

Router ek intelligent dispatcher hai. Jab request aati hai, woh message content analyze karke task type classify karta hai, aur us type ke liye configured model pe forward karta hai.

**Task Classification:**
```
Message analyze ↓
keyword scoring (code/math/creative/etc.)
       ↓
Best matching type → correct specialist model
```

**Example Router Setup:**

| Task | Model |
|------|-------|
| General | `meta/llama-3.3-70b-instruct` |
| Code | `deepseek-ai/deepseek-v4-flash` |
| Reasoning | `nvidia/llama-3.1-nemotron-ultra-253b-v1` |
| Math | `qwen/qwq-32b` |
| Creative | `meta/llama-4-maverick-17b-128e-instruct` |

**Use karne ka tarika:**
```
Base URL: http://localhost:3000/v1
Model:    router/my-router-slug
```

---

## 🔗 Pipeline — Kaise Kaam Karta Hai?

Pipeline ek 3-step orchestration system hai jo complex tasks ko parallel mein handle karta hai:

```
Step 1: PLANNER model
        └─ Task ko 2-5 subtasks mein todta hai

Step 2: SPECIALIST models (parallel execution)
        ├─ Subtask A → Code model
        ├─ Subtask B → Reasoning model
        └─ Subtask C → Math model

Step 3: SYNTHESIZER model
        └─ Saare results ko ek coherent answer mein jodta hai (streaming)
```

**Live Progress:** Chat mein pipeline use karte waqt real-time status overlay dikhti hai — kaunsa step chal raha hai, kaunsa complete hua, kya result aaya.

**Use karne ka tarika:**
```
Base URL: http://localhost:3000/v1
Model:    pipeline/my-pipeline-slug
```

---

## 🔑 Multi-Key Rotation

Server multiple API keys support karta hai. Jab ek key quota hit kare ya error de:
- Automatically next active key pe switch hota hai
- 429 (rate limit), 402 (credits), 401/403 (auth error) — sab handle hota hai
- Har key ke stats track hote hain separately

```
Request → Key 1 (429 quota) → Key 2 (success) ✓
```

---

## 🤖 Available Models (Free Tier)

Kuch notable free models jo supported hain:

| Model | Best For |
|-------|----------|
| `meta/llama-4-maverick-17b-128e-instruct` | Creative, general (1M ctx) |
| `meta/llama-4-scout-17b-16e-instruct` | Long docs (10M ctx!) |
| `meta/llama-3.3-70b-instruct` | General purpose |
| `deepseek-ai/deepseek-v4-flash` | Code (1M ctx) |
| `deepseek-ai/deepseek-v4-pro` | Code, complex tasks |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1` | Deep reasoning |
| `qwen/qwq-32b` | Math, reasoning |
| `qwen/qwen3-coder-480b-a35b-instruct` | Agentic coding |
| `openai/gpt-oss-120b` | Reasoning |
| `moonshotai/kimi-k2-thinking` | Long-context reasoning |
| `meta/llama-3.2-11b-vision-instruct` | Images (multimodal) |
| `sarvamai/sarvam-m` | Hindi/Indic languages |

---

## 🔌 Client Integration

### OpenAI Python SDK
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="proxy"  # koi bhi value chalegi
)

# Direct model
response = client.chat.completions.create(
    model="meta/llama-3.3-70b-instruct",
    messages=[{"role": "user", "content": "Hello!"}]
)

# Router use karna
response = client.chat.completions.create(
    model="router/my-router",
    messages=[{"role": "user", "content": "Write a Python function to sort a list"}]
)

# Pipeline use karna
response = client.chat.completions.create(
    model="pipeline/my-pipeline",
    messages=[{"role": "user", "content": "Build a full-stack todo app"}],
    stream=True
)
```

### curl
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer proxy" \
  -d '{
    "model": "meta/llama-3.3-70b-instruct",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### OpenClaw / Any OpenAI-compatible tool
```json
{
  "models": {
    "providers": {
      "nvidia": {
        "baseUrl": "http://localhost:3000/v1"
      }
    }
  }
}
```
Model format: `nvidia/meta/llama-3.3-70b-instruct`

---

## 🛠️ API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Web UI |
| `GET` | `/api/health` | Server status |
| `GET/POST/DELETE/PATCH` | `/api/keys` | Key management |
| `GET` | `/api/models` | Available models |
| `GET` | `/v1/models` | OpenAI-format model list |
| `POST` | `/v1/chat/completions` | Main chat endpoint |
| `GET/POST/PATCH/DELETE` | `/api/routers` | Router CRUD |
| `GET/POST/PATCH/DELETE` | `/api/pipelines` | Pipeline CRUD |
| `GET/DELETE` | `/api/logs` | Request logs |

---

## 📊 Data Storage

| File | Kya Store Hota Hai |
|------|--------------------|
| `.env` | API keys (auto-managed) |
| `routers.json` | Router configs + stats |
| `pipelines.json` | Pipeline configs + stats |

Yeh files server khud manage karta hai — manually edit mat karo jab server chal raha ho.

---

## ⚠️ Important Notes

1. **API Key Security:** `.env` file ko git mein commit mat karo — `.gitignore` mein add karo
2. **Node.js Version:** 18+ zaroori hai native `fetch` ke liye
3. **Free Tier Limits:** NVIDIA free models pe rate limits hain — multiple keys add karo rotation ke liye
4. **Pipeline Streaming:** Pipeline sirf streaming mode mein kaam karta hai (`stream: true`)
5. **Local Only:** By default sirf localhost pe accessible hai — production mein use karne se pehle auth add karo

---

## 🐛 Troubleshooting

| Problem | Solution |
|---------|----------|
| `fetch is not defined` | Node.js 18+ install karo |
| `nvapi-` key reject ho rahi | Key sahi hai? build.nvidia.com se verify karo |
| Pipeline button kaam nahi karta | Latest `index.html` use karo (JS functions fix ho gaye hain) |
| `Pipeline not found` error | Pipeline tab mein pehle create karo |
| 429 errors baar baar | Aur keys add karo rotation ke liye |
| Models tab empty | Server internet se connected hai? `/api/health` check karo |

---

## 📝 License

Personal/educational use ke liye free. NVIDIA NIM API ke terms of service follow karo.
