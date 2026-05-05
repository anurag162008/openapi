# 🚀 NVIDIA NIM Proxy Server

> OpenAI-compatible local proxy with multi-key rotation and a stronger multi-model pipeline system, powered by NVIDIA NIM.

---

## What this project is

This is a **Node.js proxy server** that exposes NVIDIA-hosted models through an OpenAI-compatible API.
Any client that can talk to the OpenAI API (OpenClaw, Continue, Cursor, custom apps, etc.) can point to this proxy.

**Flow:**

```txt
Your App (OpenAI format) → http://localhost:3000/v1 → NVIDIA NIM API
```

---

## Project structure

```txt
project/
├── server.js            # Backend proxy + pipeline orchestration
├── index.html           # UI markup
├── assets/
│   ├── styles.css       # UI styles
│   └── app.js           # UI behavior
├── package.json         # Dependencies
├── package-lock.json
├── .env                 # API keys (auto-managed)
└── pipelines.json       # Saved pipelines + runtime stats
```

---

## Setup

### 1) Prerequisites
- **Node.js 18+** (required for native `fetch`)
- NVIDIA API key from [build.nvidia.com](https://build.nvidia.com)

### 2) Install dependencies

```bash
npm install
```

### 3) Create `.env`

```env
PORT=3000

NVIDIA_API_KEY_1=nvapi-xxxxxxxxxxxxxxxxxxxx
NVIDIA_API_KEY_1_LABEL=Primary Key

# Optional additional keys for rotation
NVIDIA_API_KEY_2=nvapi-yyyyyyyyyyyyyyyyyyyy
NVIDIA_API_KEY_2_LABEL=Backup Key
```

### 4) Start server

```bash
node server.js
```

Open UI: **http://localhost:3000**

---

## Web UI overview

### 💬 Chat
- Talk to any available model directly.
- Supports streaming and non-streaming.
- Shows real-time pipeline progress events when using `pipeline/<slug>` models.

### 🧠 Models
- Browse available NVIDIA models.
- Filter/search by category and ID.

### 🔗 Pipeline
- Build and manage multi-model pipelines.
- Architecture: **Planner → Parallel specialists → Synthesizer**.
- Map specialist models per task type.
- Configure max subtasks.
- Enable/disable task tracks using `enabledTasks` support.

### 🔑 API Keys
- Add/remove/enable/disable keys.
- Per-key usage stats: requests, success, errors, quota hits.

### 📋 Logs
- Inspect request history with latency/status details.
- Export or clear logs.

---

## Pipeline behavior

Pipeline execution has three stages:

1. **Planner**: breaks the user request into focused subtasks.
2. **Specialists (parallel)**: each subtask is sent to the mapped specialist model.
3. **Synthesizer**: merges specialist outputs into one final answer (streamed).

### Strong routing guarantees
- Planner is instructed to emit only enabled task types.
- Server-side filtering enforces enabled task types before execution.
- Invalid/disabled types are dropped.
- Safe fallback to `general` if needed.

Use in clients:

```txt
Base URL: http://localhost:3000/v1
Model:    pipeline/<your-slug>
```

---

## Multi-key rotation

When a key fails (quota/auth/etc.), the proxy automatically rotates to another active key.
Per-key stats are tracked and visible in the UI.

---

## Client examples

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="proxy"  # any placeholder string works for local proxy
)

response = client.chat.completions.create(
    model="meta/llama-3.3-70b-instruct",
    messages=[{"role": "user", "content": "Hello!"}]
)

pipeline_response = client.chat.completions.create(
    model="pipeline/my-pipeline",
    messages=[{"role": "user", "content": "Design and implement a todo app"}],
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

---

## API endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Web UI |
| `GET` | `/api/health` | Server status |
| `GET/POST/DELETE/PATCH` | `/api/keys` | Key management |
| `GET` | `/api/models` | Available models |
| `GET` | `/v1/models` | OpenAI-format model list |
| `POST` | `/v1/chat/completions` | Main chat endpoint |
| `GET/POST/PATCH/DELETE` | `/api/pipelines` | Pipeline CRUD |
| `GET/DELETE` | `/api/logs` | Request logs |

---

## Data files

| File | Purpose |
|---|---|
| `.env` | API keys and labels |
| `pipelines.json` | Pipeline configuration + stats |

> Do not manually edit these files while the server is running.

---

## Notes

1. Keep `.env` out of git.
2. Node.js 18+ is required.
3. Free-tier model limits apply; add multiple keys for smoother usage.
4. Pipeline mode is designed for streaming workflows.
5. This is local-first; add auth/network controls before production exposure.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `fetch is not defined` | Upgrade to Node.js 18+ |
| API key rejected | Verify key at build.nvidia.com |
| `Pipeline not found` | Create it first in the Pipeline tab |
| Frequent 429 errors | Add more keys for rotation |
| Models list empty | Check internet access and `/api/health` |

---

## License

Free for personal/educational use. Follow NVIDIA NIM API terms of service.
