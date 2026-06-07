// provider_config.ts
// ============================================================
// Council of Agents — Developer Configuration File
// All provider, model, and tuning choices live here.
// No need to touch any other file for experimentation.
// ============================================================

import type {
    AgentMode,
    RealtimeProvider,
    STTProvider,
    ChatProvider,
    TTSProvider,
    TranscriptionProvider,
    RouterProvider,
  } from "./types/providers";
  
  // ============================================================
  // SECTION 1 — AGENT MODE
  // "realtime" : single WS per agent (OpenAI / Gemini)
  // "pipeline" : STT → Chat → TTS chain
  // ============================================================
  
  export const AGENT_MODE: AgentMode = "realtime";
  
  // ============================================================
  // SECTION 2 — REALTIME VOICE (only used if AGENT_MODE = "realtime")
  // ============================================================
  
  export const REALTIME: {
    provider: RealtimeProvider;
    models: Record<RealtimeProvider, string>;
    tuning: {
      openai: {
        turnDetection: null; // always null — orchestrator owns turns
        vadSilenceDurationMs: number;
        vadThreshold: number;
      };
      gemini: {
        turnDetection: null;
        suppressStreamingTokens: boolean; // suppress mid-turn deltas when VAD off
        streamingTokenEventName: string;  // exact event to filter
        vadSilenceDurationMs: number;
      };
    };
  } = {
    provider: "openai",
  
    models: {
      openai: "gpt-4o-realtime-preview-2025-06-03",
      gemini: "gemini-2.0-flash-live-001",
    },
  
    tuning: {
      openai: {
        turnDetection: null,
        vadSilenceDurationMs: 500,
        vadThreshold: 0.5,
      },
      gemini: {
        turnDetection: null,
        suppressStreamingTokens: true,
        streamingTokenEventName: "serverContent.modelTurn.parts", // filter this
        vadSilenceDurationMs: 500,
      },
    },
  };
  
  // ============================================================
  // SECTION 3 — PIPELINE (only used if AGENT_MODE = "pipeline")
  // ============================================================
  
  export const PIPELINE: {
    stt: {
      provider: STTProvider;
      models: Record<STTProvider, string>;
      tuning: {
        deepgram: {
          encoding: string;
          sampleRate: number;       // must match server audio format
          channels: number;
          interimResults: boolean;
          punctuate: boolean;
          smartFormat: boolean;
          endpointing: number;      // ms of silence to finalize
          language: string;
        };
        groq: {
          model: string;
          language: string;
          responseFormat: string;
        };
        sarvam: {
          languageCode: string;     // e.g. "hi-IN", "en-IN"
          model: string;
        };
        google: {
          languageCode: string;
          model: string;
        };
      };
    };
    chat: {
      provider: ChatProvider;
      models: Record<ChatProvider, string>;
      tuning: {
        maxTokens: number;
        temperature: number;
        systemPromptAppend: string; // injected after personality prompt
      };
    };
    tts: {
      provider: TTSProvider;
      models: Record<TTSProvider, string>;
      tuning: {
        deepgram: {
          encoding: string;
          sampleRate: number;       // must match client expectation (24000)
          container: string;
        };
        sarvam: {
          languageCode: string;
          pitch: number;
          pace: number;
          loudness: number;
        };
        openai: {
          speed: number;
          responseFormat: string;
        };
        google: {
          languageCode: string;
          audioEncoding: string;
          speakingRate: number;
        };
      };
    };
  } = {
    stt: {
      provider: "deepgram",
  
      models: {
        deepgram: "nova-2",
        groq:     "whisper-large-v3-turbo",
        sarvam:   "saarika:v2",
        google:   "latest_long",
      },
  
      tuning: {
        deepgram: {
          encoding:       "linear16",
          sampleRate:     24000,      // match server PCM16 @ 24kHz
          channels:       1,
          interimResults: true,
          punctuate:      true,
          smartFormat:    true,
          endpointing:    400,        // ms — tune if STT cuts off early
          language:       "en-IN",
        },
        groq: {
          model:          "whisper-large-v3-turbo",
          language:       "en",
          responseFormat: "json",
        },
        sarvam: {
          languageCode:   "en-IN",
          model:          "saarika:v2",
        },
        google: {
          languageCode:   "en-IN",
          model:          "latest_long",
        },
      },
    },
  
    chat: {
      provider: "groq",
  
      models: {
        openai:  "gpt-4o-mini",
        groq:    "llama-3.1-8b-instant",
        gemini:  "gemini-2.0-flash",
        sarvam:  "sarvam-2b",
      },
  
      tuning: {
        maxTokens:          150,      // keep responses short for voice
        temperature:        0.85,
        systemPromptAppend: "Keep responses under 30 seconds of speech. Be conversational, not listy.",
      },
    },
  
    tts: {
      provider: "deepgram",
  
      models: {
        deepgram: "aura-2-thalia-en",
        openai:   "tts-1",
        google:   "en-IN-Wavenet-D",
        sarvam:   "bulbul:v2",
      },
  
      tuning: {
        deepgram: {
          encoding:   "linear16",
          sampleRate: 24000,          // must match client playout
          container:  "none",
        },
        sarvam: {
          languageCode: "en-IN",
          pitch:        0,
          pace:         1.0,          // 1.0 = normal, tune per personality
          loudness:     1.5,
        },
        openai: {
          speed:          1.0,
          responseFormat: "pcm",
        },
        google: {
          languageCode:  "en-IN",
          audioEncoding: "LINEAR16",
          speakingRate:  1.0,
        },
      },
    },
  };
  
  // ============================================================
  // SECTION 4 — HUMAN TRANSCRIPTION
  // Separate from agent pipeline — human mic → text only
  // ============================================================
  
  export const TRANSCRIPTION: {
    provider: TranscriptionProvider;
    models: Record<TranscriptionProvider, string>;
    tuning: {
      deepgram: {
        encoding:       string;
        sampleRate:     number;
        interimResults: boolean;
        punctuate:      boolean;
        smartFormat:    boolean;
        endpointing:    number;
        language:       string;
      };
      groq: {
        model:          string;
        language:       string;
        responseFormat: string;
      };
      sarvam: {
        languageCode:   string;
        model:          string;
      };
    };
  } = {
    provider: "deepgram",           // no openai-realtime — eliminated
  
    models: {
      deepgram: "nova-2",
      groq:     "whisper-large-v3-turbo",
      sarvam:   "saarika:v2",
    },
  
    tuning: {
      deepgram: {
        encoding:       "linear16",
        sampleRate:     24000,
        interimResults: true,
        punctuate:      true,
        smartFormat:    true,
        endpointing:    400,        // increase if human gets cut off mid-sentence
        language:       "en-IN",
      },
      groq: {
        model:          "whisper-large-v3-turbo",
        language:       "en",
        responseFormat: "json",
      },
      sarvam: {
        languageCode:   "en-IN",
        model:          "saarika:v2",
      },
    },
  };
  
  // ============================================================
  // SECTION 5 — ROUTER (next speaker decision)
  // Use small, fast models with good context windows
  // ============================================================
  
  export const ROUTER: {
    provider: RouterProvider;
    models: Record<RouterProvider, {
      model:            string;
      contextWindow:    number;   // tokens — for reference
      avgLatencyMs:     number;   // approx — for reference
    }>;
    tuning: {
      timeoutMs:              number; // fallback to random if exceeded
      maxConversationTurns:   number; // how many turns to send as context
      chainContinueThreshold: number; // 0–1, probability if no groq
      maxChainTurns:          number; // hard cap
      temperature:            number;
    };
  } = {
    provider: "groq",
  
    models: {
      groq: {
        model:         "llama-3.1-8b-instant",  // fast, 128k context
        contextWindow: 128000,
        avgLatencyMs:  150,
      },
      openai: {
        model:         "gpt-4o-mini",           // 128k context, cheap
        contextWindow: 128000,
        avgLatencyMs:  400,
      },
      gemini: {
        model:         "gemini-2.0-flash",      // 1M context, fast
        contextWindow: 1000000,
        avgLatencyMs:  300,
      },
      sarvam: {
        model:         "sarvam-2b",             // small, good for Indic
        contextWindow: 4096,
        avgLatencyMs:  200,
      },
    },
  
    tuning: {
      timeoutMs:              900,   // if router exceeds this → weighted random
      maxConversationTurns:   12,    // last N turns sent as context
      chainContinueThreshold: 0.80,  // fallback probability without router
      maxChainTurns:          12,    // hard safety cap
      temperature:            0.3,   // low — routing should be deterministic
    },
  };
  
  // ============================================================
  // SECTION 6 — AUDIO
  // Global audio format — all providers must match these
  // ============================================================
  
  export const AUDIO = {
    sampleRate:    24000,   // Hz — PCM16 24kHz throughout
    channels:      1,       // mono
    bitDepth:      16,
    chunkSizeMs:   20,      // ms per audio chunk sent to providers
  
    playout: {
      speedOptions:     [1, 1.5, 2] as const,
      defaultSpeed:     1,
      gaplessScheduling: true,
    },
  
    interrupt: {
      epochBits:              16,   // Uint16 — wraps at 65535, safe for long sessions
      simultaneousThresholdMs: 300, // two speakers within this window = conflict
    },
  };
  
  // ============================================================
  // SECTION 7 — ROOM
  // ============================================================
  
  export const ROOM = {
    maxAgentsPerRoom:     8,
    maxHumansPerRoom:     4,    // future: multi-human support
    destroyOnEmpty:       true,
    sessionTimeoutMs:     0,    // 0 = no timeout
    
    orchestrator: {
      decidingTimeoutMs:      6000,  // max wait for transcript before fallback
      chainReactionDelayMs:   900,   // gap between agent chain turns
      engagementQuestionProb: 1.0,   // always ask human before handing back
      speculativeResponseMs:  0,     // fire response.create before router returns
                                     // set > 0 to enable speculative execution
    },
  };
  
  // ============================================================
  // SECTION 8 — DEFAULT AGENT PERSONALITIES
  // Used when user creates a room without custom agents
  // ============================================================
  
  export const DEFAULT_AGENTS = [
    {
      id:          "agent-rohan",
      name:        "Rohan",
      voice:       "cedar",           // openai voice
      geminiVoice: "Puck",            // gemini voice
      sarvamVoice: "anushka",         // sarvam voice
      assertiveness: 0.8,
      topicWeights: {
        technology: 0.9,
        finance:    0.6,
        policy:     0.5,
        emotion:    0.3,
      },
      systemPrompt: `You are Rohan, a 22-year-old indie developer and crypto skeptic 
  in a voice group discussion. You are sharp, opinionated, and slightly contrarian. 
  You push back on assumptions. You ask "but why though?" You speak in short punchy 
  sentences. You react to what was just said before making your own point. 
  Never agree without adding a new angle. Keep responses under 25 seconds of speech.
  Always name who you are addressing.`,
    },
    {
      id:          "agent-priya",
      name:        "Priya",
      voice:       "marin",
      geminiVoice: "Aoede",
      sarvamVoice: "meera",
      assertiveness: 0.4,
      topicWeights: {
        technology: 0.4,
        finance:    0.3,
        policy:     0.7,
        emotion:    1.0,
      },
      systemPrompt: `You are Priya, a literature graduate working in the nonprofit 
  sector in a voice group discussion. You are idealistic, empathetic, and grounded 
  in human stories. You reframe abstract arguments in terms of real people. 
  You speak with warmth but are not a pushover. You get quietly firm when dignity 
  is at stake. Keep responses under 25 seconds of speech. 
  Always name who you are addressing.`,
    },
    {
      id:          "agent-vikram",
      name:        "Vikram",
      voice:       "ash",
      geminiVoice: "Charon",
      sarvamVoice: "arjun",
      assertiveness: 0.85,
      topicWeights: {
        technology: 0.7,
        finance:    0.9,
        policy:     0.8,
        emotion:    0.3,
      },
      systemPrompt: `You are Vikram, an ex-management consultant turned devil's 
  advocate in a voice group discussion. You stress-test every idea by finding its 
  failure mode. You are not cynical — you want good outcomes, but you don't trust 
  plans that ignore execution risk. You speak precisely and confidently. 
  You often open with "here is the failure mode I worry about." 
  Keep responses under 25 seconds of speech. Always name who you are addressing.`,
    },
    {
      id:          "agent-anika",
      name:        "Anika",
      voice:       "coral",
      geminiVoice: "Leda",
      sarvamVoice: "diya",
      assertiveness: 0.65,
      topicWeights: {
        technology: 0.8,
        finance:    0.7,
        policy:     0.6,
        emotion:    0.5,
      },
      systemPrompt: `You are Anika, a data scientist who demands evidence in a voice 
  group discussion. You are skeptical of anecdotes and availability bias. 
  You ask for counterexamples. You cite uncertainty. You are not cold — you care 
  about outcomes — but you will not let sloppy reasoning slide. 
  You often open with "I want proof that..." or "a counterexample is..." 
  Keep responses under 25 seconds of speech. Always name who you are addressing.`,
    },
    {
      id:          "agent-sara",
      name:        "Sara",
      voice:       "alloy",
      geminiVoice: "Zephyr",
      sarvamVoice: "kavya",
      assertiveness: 0.55,
      topicWeights: {
        technology: 0.4,
        finance:    0.4,
        policy:     0.7,
        emotion:    0.9,
      },
      systemPrompt: `You are Sara, a therapist-in-training with strong opinions about 
  dignity and systemic fairness in a voice group discussion. You are not a mediator — 
  you have a clear value you will not trade away: people must not be treated as 
  collateral. You push back when "flexibility" becomes an excuse to leave people 
  behind. You speak with calm conviction. You will disagree with anyone, including 
  Priya, if the argument is wrong. Keep responses under 25 seconds of speech. 
  Always name who you are addressing.`,
    },
  ];
  
  // ============================================================
  // SECTION 9 — VALIDATION
  // Called at server startup — throws on invalid combinations
  // ============================================================
  
  export function validateConfig(): void {
    if (AGENT_MODE === "pipeline") {
      const { stt, chat, tts } = PIPELINE;
      if (!stt.provider)  throw new Error("PIPELINE.stt.provider is required in pipeline mode");
      if (!chat.provider) throw new Error("PIPELINE.chat.provider is required in pipeline mode");
      if (!tts.provider)  throw new Error("PIPELINE.tts.provider is required in pipeline mode");
      if (tts.provider === "groq") {
        throw new Error("Groq has no TTS API. Choose deepgram, openai, sarvam, or google for TTS.");
      }
    }
  
    if (AUDIO.interrupt.epochBits !== 16) {
      throw new Error("epochBits must be 16 (Uint16). Do not change this.");
    }
  
    if (ROUTER.tuning.timeoutMs < 100) {
      throw new Error("ROUTER.tuning.timeoutMs must be at least 100ms.");
    }
  
    if (TRANSCRIPTION.provider === ("openai" as string)) {
      throw new Error(
        "OpenAI Realtime transcription eliminated — too expensive for STT only. " +
        "Use TRANSCRIPTION.provider = 'deepgram' | 'groq' | 'sarvam'."
      );
    }
  
    console.log(`
  ╔═══════════════════════════════════════════╗
  ║     Council of Agents — Config Loaded     ║
  ╠═══════════════════════════════════════════╣
  ║ Agent mode    : ${AGENT_MODE.padEnd(25)}║
  ║ Realtime      : ${(AGENT_MODE === "realtime" ? REALTIME.provider : "n/a").padEnd(25)}║
  ║ STT           : ${(AGENT_MODE === "pipeline" ? PIPELINE.stt.provider : "n/a").padEnd(25)}║
  ║ Chat          : ${(AGENT_MODE === "pipeline" ? PIPELINE.chat.provider : "n/a").padEnd(25)}║
  ║ TTS           : ${(AGENT_MODE === "pipeline" ? PIPELINE.tts.provider : "n/a").padEnd(25)}║
  ║ Transcription : ${TRANSCRIPTION.provider.padEnd(25)}║
  ║ Router        : ${ROUTER.provider.padEnd(25)}║
  ╚═══════════════════════════════════════════╝
    `);
  }