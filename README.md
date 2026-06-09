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
    ├── Next.js App Router (app/, components/)
    └── server/ — conference runtime (WebSocket + FSM)
          ├── wsServer.ts, roomManager.ts, orchestrator.ts
          ├── pipelineAgentSession.ts, audioMixer.ts
          └── sessionRecorder.ts

lib/ — shared domain modules
    ├── pipeline/     — STT, Gemini chat, TTS, routing, human transcribe
    ├── supabase/     — admin client, transcript persister, audio usage, types
    ├── s3/           — S3 client + meeting audio uploader
    ├── logger/       — structured logging + API/chat model error logs
    ├── helpers/      — name matching, playout epoch, PCM constants, rate limit
    ├── auth/, agents/, config/, meeting/, guest/, env.ts
    └── (supabase/migrations/ at repo root for SQL schema)
```

### Per-agent turn (pipeline)

1. **Human stops talking** → rolling 30s STT segments merge into one transcript (`lib/pipeline/humanSegmentTranscriber.ts`).
2. **Gemini merged call** (`pickSpeakerAndRespond`) picks the next agent and writes their reply in one JSON request (2 retries; deterministic server fallback if Gemini fails).
3. **Google TTS** synthesizes reply **sentence-by-sentence** for faster first audio (`lib/pipeline/tts.ts`, `lib/helpers/text/sentenceSplit.ts`).
4. Audio streams to the browser over WebSocket; transcript text syncs to the UI.

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
| `GEMINI_PLANNER_MODEL` | Gemini model for guest agent planning (voice pipeline uses `gemini-3.5-flash` via Vertex publisher API) |
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
  pipeline/       STT, Gemini chat, TTS, routing, human transcribe
  supabase/       Admin client, transcript persister, audio usage, DB types
  s3/             S3 client + meeting audio uploader
  logger/         Structured logging, API logs, Gemini error artifacts
  helpers/        Name matching, playout epoch, PCM constants, rate limit
  agents/         Agent types, roster builder
  auth/           JWT sessions, password hashing
  config/         Pipeline tuning, guest limits, suggested prompts
  meeting/        Browser audio capture and playout helpers
  env.ts          Validated environment schema
server/           Conference runtime (WebSocket, FSM, agent sessions)
  orchestrator.ts, roomManager.ts, wsServer.ts, pipelineAgentSession.ts, …
server.ts         HTTP + Next.js + WebSocket entry point
supabase/         SQL schema and migrations (Supabase CLI)
scripts/s3/       S3 ops CLI (list, play, bucket management)
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
