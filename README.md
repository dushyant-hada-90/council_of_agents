# Council of Agents

Multi-agent voice conference platform built with Next.js, Supabase, and OpenAI Realtime API. Deploy to Google Cloud Run.

## Features

- **Multi-agent voice meetings** — Real-time push-to-talk conferences with multiple AI participants
- **Supabase Auth** — Email/password signup, login, session persistence, protected routes
- **Agent management** — Create, edit, delete, and duplicate AI agents with custom personalities and voices
- **Meeting configuration** — Select agents, set topic/goal/context, configure AI turn thresholds
- **Transcript persistence** — In-memory buffer with 60-second Supabase flush + final flush on meeting end/shutdown
- **User dashboard** — Analytics, meeting history, searchable transcripts with download
- **Multi-tenant** — Row-Level Security (RLS) for complete user data isolation
- **Cloud Run ready** — Dockerized with WebSocket support and graceful SIGTERM handling

## Quick start

### 1. Supabase setup

1. Create a [Supabase](https://supabase.com) project
2. Run the migration in `supabase/migrations/001_initial_schema.sql` via the SQL editor
3. Copy your project URL, anon key, and service role key

### 2. Environment

```bash
cp .env.example .env.local
# Fill in OPENAI_API_KEY, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
```

### 3. Install & run

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deploy to Cloud Run

```bash
# Build and push (replace PROJECT_ID and REGION)
gcloud builds submit --tag gcr.io/PROJECT_ID/council-of-agents
gcloud run deploy council-of-agents \
  --image gcr.io/PROJECT_ID/council-of-agents \
  --platform managed \
  --region REGION \
  --allow-unauthenticated \
  --port 8080 \
  --session-affinity \
  --set-env-vars "NODE_ENV=production,..." \
  --timeout 3600 \
  --cpu-boost
```

Set all environment variables from `.env.example` in Cloud Run. Enable session affinity for WebSocket stickiness during scaling.

## Architecture

```
Browser (Next.js UI)
    │  REST API + WebSocket (/ws)
    ▼
Custom Node Server (server.ts)
    ├── Next.js App Router
    ├── RoomManager (multi-meeting)
    ├── Orchestrator (turn FSM + AI threshold)
    ├── OpenAI Realtime (per agent)
    └── TranscriptPersister → Supabase Postgres
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Development with hot reload |
| `npm run build` | Production build |
| `npm start` | Run production server |
| `npm run typecheck` | TypeScript validation |
