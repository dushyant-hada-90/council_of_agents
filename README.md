# Council of Agents

Multi-agent voice conference platform. Humans speak push-to-talk; AI advisors respond in turn over a live WebSocket room.

**Voice stack:** Google Cloud Speech-to-Text → Gemini on Vertex AI → Google Cloud Text-to-Speech.

Built with **Next.js 15**, a custom **Node WebSocket server**, **Supabase Postgres** (storage only), and **AWS S3** (audio artifacts). Deploys to **Google Cloud Run**.

---

## Features

| Area | What it does |
|------|----------------|
| **Voice meetings** | Push-to-talk human input; agents take turns via an orchestrator FSM |
| **Agent council** | Create agents with personality prompts, Google TTS voices, and peer profiles |
| **Turn routing** | Gemini picks the next speaker and generates their reply in one call (merged turn) |
| **Guest trials** | Landing-page prompt flow with auto-planned agents and audio time limits |
| **Transcripts** | Buffered in memory, flushed to Postgres every 60s and on meeting end |
| **Auth** | Custom username/password (`app_users` table) with JWT session cookies — not Supabase Auth |
| **Dashboard** | Meeting history, stats, searchable transcripts |

---

## Architecture

```
Browser (Next.js — MeetingRoom, push-to-talk)
    │  REST (/api/*)  +  WebSocket (ws://host/ws)
    ▼
server.ts
    ├── Next.js App Router (UI + API routes)
    ├── wsServer.ts          — auth, meeting join, message routing
    ├── roomManager.ts       — one ConferenceRoom per meeting
    │     ├── orchestrator.ts    — IDLE → HUMAN_SPEAKING → DECIDING → AGENT_SPEAKING FSM
    │     ├── pipelineAgentSession.ts  — per-agent session (one per advisor)
    │     ├── audioMixer.ts      — mix-minus routing to agents
    │     └── humanTranscribe.ts — buffers human PCM → Google STT
    ├── google/stt.ts        — human speech-to-text
    ├── google/geminiChat.ts — agent replies + merged turn routing
    ├── google/tts.ts        — agent speech synthesis
    ├── nextSpeakerRouter.ts — merged pick+respond, chain-continue decisions
    ├── transcriptPersister.ts → Supabase Postgres
    └── s3AudioUploader.ts   → AWS S3
```

### Per-agent turn (pipeline)

1. **Human stops talking** → PCM16 audio buffered server-side.
2. **Google STT** transcribes the human line (`server/google/stt.ts`).
3. **Gemini merged call** (`pickSpeakerAndRespond`) chooses the next agent and writes their spoken reply in one request. If the human named someone directly, a single `generateAgentResponse` call is used instead.
4. **Google TTS** synthesizes the reply (`server/google/tts.ts`).
5. Audio streams to the browser over WebSocket; transcript text syncs to the UI.

Chain reactions (agent-to-agent turns after the human spoke) use the same pipeline. A separate small Gemini call decides whether the chain should continue.

---

## Prerequisites

- **Node.js 20+**
- **Supabase** project (Postgres only)
- **Google Cloud** project with:
  - Speech-to-Text API enabled
  - Text-to-Speech API enabled
  - Vertex AI API enabled (for Gemini)
  - Service account JSON key (`GOOGLE_APPLICATION_CREDENTIALS`)
- **AWS** account with an S3 bucket (meeting audio storage)

---

## Setup

### 1. Database

1. Create a [Supabase](https://supabase.com) project.
2. In the SQL editor, run **`supabase/schema.sql`** on an empty `public` schema.
3. If migrating an older install, also run `supabase/migrations/002_custom_user_auth.sql`.
4. Copy **Project URL** and **service role key** (Settings → API).

> Do **not** use `supabase/migrations/001_initial_schema.sql` for new installs — it references the old OpenAI Realtime stack.

### 2. Environment

```bash
cp .env.example .env.local   # or .env
```

Required variables (see `.env.example` for defaults):

| Variable | Purpose |
|----------|---------|
| `GCP_PROJECT_ID` | Google Cloud project for Vertex Gemini |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to GCP service account JSON (STT, TTS, Gemini) |
| `GEMINI_CHAT_MODEL` | Gemini model for agent replies and merged turns |
| `GEMINI_ROUTING_MODEL` | Gemini model for chain-continue decisions |
| `GEMINI_PLANNER_MODEL` | Gemini model for guest agent planning |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME` | S3 audio storage |
| `AUTH_SECRET` | JWT signing secret (≥32 chars) |
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Postgres access |

### 3. Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server with hot reload (`tsx watch server.ts`) |
| `npm run build` | Next.js production build + compile server to `dist/` |
| `npm start` | Run `node dist/server.js` |
| `npm run typecheck` | TypeScript check (app + server) |
| `npm run lint` | Next.js ESLint |
| `npm run s3:list` | List meeting folders in S3 |
| `npm run s3:map` | Show files for a meeting prefix |
| `npm run s3:play` | Download/play audio from S3 |
| `npm run s3:size` | Bucket size summary |
| `npm run s3:create-bucket` | Create/configure the S3 bucket |

---

## Deploy to Cloud Run

```bash
gcloud builds submit --tag gcr.io/PROJECT_ID/council-of-agents

gcloud run deploy council-of-agents \
  --image gcr.io/PROJECT_ID/council-of-agents \
  --platform managed \
  --region REGION \
  --allow-unauthenticated \
  --port 8080 \
  --session-affinity \
  --timeout 3600 \
  --cpu-boost
```

Set all variables from `.env.example` as Cloud Run env vars. Enable **session affinity** so WebSocket connections stick to one instance.

The Docker image runs `node dist/server.js` (see `Dockerfile`).

---

## Project layout

```
app/              Next.js pages and API routes
components/       React UI (MeetingRoom, AgentForm, landing flow)
lib/
  agents/         Agent types, roster builder
  auth/           JWT sessions, password hashing
  config/         Pipeline tuning, guest limits, suggested prompts
  env.ts          Validated environment schema
server/
  google/         stt.ts, geminiChat.ts, tts.ts
  orchestrator.ts Turn-taking FSM
  pipelineAgentSession.ts  STT→Gemini→TTS per agent
  roomManager.ts  Meeting lifecycle
  wsServer.ts     WebSocket gateway
server.ts         HTTP + Next.js + WebSocket entry point
supabase/
  schema.sql      Canonical database schema
scripts/          S3 utilities
```

---

## Configuration

- **Chat tuning** (`lib/config/pipeline.ts`) — temperature, max tokens, system prompt suffix for Gemini replies.
- **Gemini models** — set via `GEMINI_*_MODEL` env vars (not per-agent DB fields).
- **Agent voices** — Google Cloud TTS voice names (`en-IN-Wavenet-*`, etc.) set per agent in the UI.
- **Guest limits** — `GUEST_AUDIO_WARN_SECONDS` / `GUEST_AUDIO_MAX_SECONDS`.

---

## Auth model

- Signup/login stores users in `app_users` with bcrypt password hashes.
- Sessions are signed JWTs in HTTP-only cookies (`AUTH_SECRET`).
- API routes enforce `user_id` ownership in application code.
- The server uses the Supabase **service role** key — RLS policies block direct client DB access.
