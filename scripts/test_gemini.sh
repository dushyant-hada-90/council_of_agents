#!/bin/bash

# Load .env file
if [ -f ".env" ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Configuration
API_KEY="${GOOGLE_API_KEY}"
API_ENDPOINT="aiplatform.googleapis.com"
MODEL_ID="gemini-3.5-flash"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

LOG_FILE="gemini_load_test_$(date +%Y%m%d_%H%M%S).log"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}" | tee -a "$LOG_FILE"
echo -e "${BLUE}  Gemini 15-Step Stress Simulator (Vertex AI)      ${NC}" | tee -a "$LOG_FILE"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}" | tee -a "$LOG_FILE"

if [ -z "$API_KEY" ]; then
    echo -e "${RED}Error: No API key found. Set GOOGLE_API_KEY in your .env file.${NC}"
    exit 1
fi

# Base System Instructions
SYSTEM_INSTRUCTIONS_RAW=$(cat << 'EOF'
You are the orchestrator of a multi-agent live voice conference. Determine if the AI agents should keep talking to each other, or if control should be passed back to the human user.

CRITERIA TO CONTINUE (continue = true):
- There is an active, unresolved disagreement or a sharp counter-point to be made between agents.

CRITERIA TO STOP (continue = false):
- The last speaking agent asked the human ('You') a direct question.
- The maximum agent-to-agent turn threshold has been reached.

Output valid JSON only matching this schema:
{
  "continue": true|false,
  "reason": "<max 12 words>"
}
EOF
)

# Base Starting Conversation History
ACCUMULATED_HISTORY=$(cat << 'EOF'
You: Hello. Hello.
Marcus: Hello! Glad you're here. Let's get straight to it. To help you break this analysis paralysis, what are the two specific career paths you are currently weighing against each other?
Valerie: I'm ready, Marcus. But let's let our guest actually tell us what those two paths are first! What are the two options you're torn between?
EOF
)

# Robust escaping function to neutralize Windows line endings
escape_for_json() {
    local str="$1"
    str="${str//$'\r'/}"
    str="${str//\\/\\\\}"
    str="${str//\"/\\\"}"
    str="${str//$'\n'/\\n}"
    echo -n "$str"
}

# Run the 15-iteration simulation loop
for turn in {1..15}; do
    echo -e "\n${BLUE}------------------------------------------------------------${NC}" | tee -a "$LOG_FILE"
    echo -e "${BLUE}Hit #${turn}/15 - Processing Context Stack...${NC}" | tee -a "$LOG_FILE"
    
    # Continuously grow the conversation payload by 3 sentences every turn after the first
    if [ "$turn" -gt 1 ]; then
        S1="Marcus: Let us thoroughly evaluate data metric matrix line item code alpha-${turn}."
        S2="Valerie: I counter that assertion because the emotional focus on step ${turn} outweighs your data numbers."
        S3="Marcus: Dynamic parameter adjustment noted, progressing conference cycle iteration forward."
        
        # Append to the historical timeline using native formatting
        ACCUMULATED_HISTORY="${ACCUMULATED_HISTORY}"$'\n'"${S1}"$'\n'"${S2}"$'\n'"${S3}"
    fi
        
    CLEAN_SYS=$(escape_for_json "$SYSTEM_INSTRUCTIONS_RAW")
    CLEAN_CONV=$(escape_for_json "$ACCUMULATED_HISTORY")
    USER_PROMPT_TEXT="${CLEAN_CONV}\\n\\nLast line from Valerie: \\\"What are the two options you're torn between?\\\"\\n\\nShould another agent react?"

    PAYLOAD_FILE="/tmp/flow_payload_${turn}.json"
    
    # Construct complete structural payload
    cat > "$PAYLOAD_FILE" << EOF
{
  "systemInstruction": {
    "parts": [
      {
        "text": "${CLEAN_SYS}"
      }
    ]
  },
  "contents": [
    {
      "role": "user",
      "parts": [
        {
          "text": "${USER_PROMPT_TEXT}"
        }
      ]
    }
  ],
  "generationConfig": {
    "temperature": 0.15,
    "maxOutputTokens": 256,
    "responseMimeType": "application/json"
  }
}
EOF

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # DISPATCH CONTENT GENERATION
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    OUTPUT_FILE="/tmp/flow_resp_${turn}.json"
    start_time=$(date +%s%3N)
    
    # Executes POST mapping while keeping response payload completely isolated from raw headers
    http_code=$(curl -s -w "%{http_code}" -X POST \
        "https://${API_ENDPOINT}/v1/publishers/google/models/${MODEL_ID}:generateContent?key=${API_KEY}" \
        -H "Content-Type: application/json" \
        -d @"$PAYLOAD_FILE" \
        -o "$OUTPUT_FILE")
        
    end_time=$(date +%s%3N)
    duration=$((end_time - start_time))
    
    if [[ "$http_code" == "200" ]]; then
        echo -e "${GREEN}  ✓ SUCCESS (${duration}ms)${NC}" | tee -a "$LOG_FILE"
        
        # Read exact context sizes straight from target tracking variables 
        PROMPT_TOKENS=$(grep -o '"promptTokenCount": *[0-9]*' "$OUTPUT_FILE" | grep -o '[0-9]*' | head -n1)
        CANDIDATE_TOKENS=$(grep -o '"candidatesTokenCount": *[0-9]*' "$OUTPUT_FILE" | grep -o '[0-9]*' | head -n1)
        TOTAL_TOKENS=$(grep -o '"totalTokenCount": *[0-9]*' "$OUTPUT_FILE" | grep -o '[0-9]*' | head -n1)
        
        echo -e "  [Token Audit Log]" | tee -a "$LOG_FILE"
        echo -e "    -> Verified Input (Prompt):   ${YELLOW}${PROMPT_TOKENS:-0}${NC} tokens" | tee -a "$LOG_FILE"
        echo -e "    -> Generated Output (Response): ${YELLOW}${CANDIDATE_TOKENS:-0}${NC} tokens" | tee -a "$LOG_FILE"
        echo -e "    -> Cumulative Frame Total:    ${CYAN}${TOTAL_TOKENS:-0}${NC} tokens" | tee -a "$LOG_FILE"
        
        echo -e "  [Model Routing Decision]:" | tee -a "$LOG_FILE"
        # Bulletproof cross-platform JSON extractor string engine
        python -c "import json, sys; print(json.load(open('$OUTPUT_FILE'))['candidates'][0]['content']['parts'][0]['text'])" 2>/dev/null | tee -a "$LOG_FILE"
        
    elif [[ "$http_code" == "429" ]]; then
        echo -e "${RED}  ✗ 429 RESOURCE_EXHAUSTED. Rate limit hit.${NC}" | tee -a "$LOG_FILE"
        exit 429
    else
        echo -e "${RED}  ✗ Unexpected HTTP Status: ${http_code}${NC}" | tee -a "$LOG_FILE"
        echo "Raw Response Body:"
        cat "$OUTPUT_FILE"
    fi
    
    # Prevent rapid deployment script slamming throttles too fast
    sleep 1.5
done

# Clean loop workspace tracking artifacts
rm -f /tmp/flow_payload_*.json /tmp/flow_resp_*.json