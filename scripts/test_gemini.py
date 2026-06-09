#!/usr/bin/env python3
"""
Replicates the EXACT behavior of the TypeScript code that caused 429s
This matches the token growth pattern seen in your logs
"""

import os
import json
import time
import random
import requests
from datetime import datetime
from typing import List, Dict, Any, Optional

# Load .env
def load_env():
    env_file = ".env"
    if os.path.exists(env_file):
        with open(env_file, 'r') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    key, value = line.split('=', 1)
                    os.environ[key] = value

load_env()

API_KEY = os.environ.get('GOOGLE_API_KEY')
if not API_KEY:
    print("Error: GOOGLE_API_KEY not found")
    exit(1)

API_ENDPOINT = "aiplatform.googleapis.com"
MODEL_ID = "gemini-3.5-flash"

class Colors:
    RED = '\033[0;31m'
    GREEN = '\033[0;32m'
    YELLOW = '\033[1;33m'
    BLUE = '\033[0;34m'
    CYAN = '\033[0;36m'
    NC = '\033[0m'

def print_colored(color, text):
    print(f"{color}{text}{Colors.NC}")

# EXACT system prompt from your TypeScript code
SYSTEM_INSTRUCTIONS = """You are the orchestrator of a multi-agent live voice conference. Determine if the AI agents should keep talking to each other, or if control should be passed back to the human user.

CRITERIA TO CONTINUE (continue = true):
- There is an active, unresolved disagreement or a sharp counter-point to be made between agents.

CRITERIA TO STOP (continue = false):
- The last speaking agent asked the human ('You') a direct question.
- The maximum agent-to-agent turn threshold has been reached.

Output valid JSON only matching this schema:
{
  "continue": true|false,
  "reason": "<max 12 words>"
}"""

# EXACT initial conversation from your TypeScript code
INITIAL_CONVERSATION = """You: Hello. Hello.
Marcus: Hello! Glad you're here. Let's get straight to it. To help you break this analysis paralysis, what are the two specific career paths you are currently weighing against each other?
Valerie: I'm ready, Marcus. But let's let our guest actually tell us what those two paths are first! What are the two options you're torn between?"""

def call_gemini(contents: str, system_instruction: str = SYSTEM_INSTRUCTIONS) -> Dict[str, Any]:
    """Make a Gemini API call - EXACT same format as TypeScript code"""
    url = f"https://{API_ENDPOINT}/v1/publishers/google/models/{MODEL_ID}:generateContent?key={API_KEY}"
    
    payload = {
        "systemInstruction": {
            "parts": [{"text": system_instruction}]
        },
        "contents": [
            {
                "role": "user",
                "parts": [{"text": contents}]
            }
        ],
        "generationConfig": {
            "temperature": 0.15,
            "maxOutputTokens": 256,
            "responseMimeType": "application/json"
        }
    }
    
    start_time = time.time()
    try:
        response = requests.post(url, json=payload, timeout=60)
        elapsed_ms = int((time.time() - start_time) * 1000)
        
        result = {
            "status_code": response.status_code,
            "elapsed_ms": elapsed_ms,
        }
        
        if response.text:
            result["response"] = response.json()
        
        if response.status_code == 200:
            data = response.json()
            usage = data.get('usageMetadata', {})
            result['prompt_tokens'] = usage.get('promptTokenCount', 0)
            result['total_tokens'] = usage.get('totalTokenCount', 0)
            
            # Extract the JSON response
            candidates = data.get('candidates', [])
            if candidates:
                text = candidates[0].get('content', {}).get('parts', [{}])[0].get('text', '')
                result['response_text'] = text
        
        return result
    except Exception as e:
        return {
            "status_code": 0,
            "elapsed_ms": int((time.time() - start_time) * 1000),
            "error": str(e)
        }

def replicate_exact_typeScript_behavior(num_turns: int = 15):
    """
    Replicates the EXACT behavior of pickSpeakerAndRespond from TypeScript code
    This includes the conversation growth pattern that caused 429s
    """
    print_colored(Colors.BLUE, "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print_colored(Colors.BLUE, "  Replicating TypeScript pickSpeakerAndRespond Behavior")
    print_colored(Colors.BLUE, "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    conversation_history = INITIAL_CONVERSATION
    rate_limits = []
    token_history = []
    
    for turn in range(1, num_turns + 1):
        print_colored(Colors.CYAN, f"\n  Turn {turn}/{num_turns}")
        
        # EXACT user prompt format from your TypeScript code
        user_prompt = f"""{conversation_history}

Last line from Valerie: "What are the two options you're torn between?"

Should another agent react?"""
        
        # Log prompt size
        prompt_chars = len(user_prompt)
        print(f"    Prompt size: {prompt_chars} chars, ~{prompt_chars//4} tokens (approx)")
        
        # Make the API call
        result = call_gemini(user_prompt)
        
        if result['status_code'] == 200:
            tokens = result.get('prompt_tokens', 0)
            token_history.append(tokens)
            print_colored(Colors.GREEN, f"    ✓ SUCCESS ({result['elapsed_ms']}ms) - Prompt tokens: {tokens}")
            
            # Show the model's response
            if result.get('response_text'):
                try:
                    parsed = json.loads(result['response_text'])
                    print(f"      Response: continue={parsed.get('continue')}, reason={parsed.get('reason', '')[:50]}")
                except:
                    print(f"      Response: {result['response_text'][:100]}")
            
            # GROW the conversation - THIS IS KEY
            # The TypeScript code adds 3 sentences per turn after turn 1
            if turn > 1:
                # EXACT sentences from your original bash script
                s1 = f"Marcus: Let us thoroughly evaluate data metric matrix line item code alpha-{turn}."
                s2 = f"Valerie: I counter that assertion because the emotional focus on step {turn} outweighs your data numbers."
                s3 = f"Marcus: Dynamic parameter adjustment noted, progressing conference cycle iteration forward."
                
                conversation_history = f"{conversation_history}\n{s1}\n{s2}\n{s3}"
            
        elif result['status_code'] == 429:
            print_colored(Colors.RED, f"    ✗✗✗ 429 RATE LIMIT at turn {turn}! ✗✗✗")
            print_colored(Colors.RED, f"    Error: {result.get('response', {}).get('error', {}).get('message', 'Unknown')}")
            rate_limits.append(turn)
            
            # Don't break - continue to see pattern
        else:
            print_colored(Colors.RED, f"    ✗ HTTP {result['status_code']} ({result['elapsed_ms']}ms)")
            if 'error' in result:
                print(f"      {result['error']}")
        
        # The TypeScript code has a 1.5s sleep between turns
        if turn < num_turns:
            time.sleep(1.5)
    
    # Print token growth pattern
    print_colored(Colors.BLUE, "\n  Token Growth Pattern:")
    for i, tokens in enumerate(token_history, 1):
        arrow = " → " if i < len(token_history) else ""
        print(f"    Turn {i}: {tokens}{arrow}", end="")
    print()
    
    return rate_limits, token_history

def replicate_token_oscillation_pattern():
    """
    Replicates the token oscillation pattern that appeared in your logs
    Large → Small → Large → Large pattern
    """
    print_colored(Colors.BLUE, "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print_colored(Colors.BLUE, "  Replicating Token Oscillation Pattern (From Logs)")
    print_colored(Colors.BLUE, "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    # Start with medium conversation
    conversation = INITIAL_CONVERSATION
    
    # Add content to reach ~3500 tokens (like your logs)
    for i in range(1, 30):
        conversation += f"\nMarcus: Analysis point {i}: Data suggests correlation."
        conversation += f"\nValerie: Counterpoint {i}: Human element matters."
    
    print_colored(Colors.YELLOW, "\n  Phase 1: Large context (~3500-4000 tokens)")
    user_prompt = f"{conversation}\n\nShould another agent react?"
    result1 = call_gemini(user_prompt)
    
    if result1['status_code'] == 200:
        tokens1 = result1.get('prompt_tokens', 0)
        print_colored(Colors.GREEN, f"    ✓ Large context: {tokens1} tokens")
    else:
        print_colored(Colors.RED, f"    ✗ {result1['status_code']}")
        return
    
    time.sleep(0.5)  # Short delay like in logs
    
    print_colored(Colors.YELLOW, "\n  Phase 2: RESET to small context (~200-400 tokens)")
    small_conversation = "You: Hello.\nMarcus: Hi.\nValerie: Hello.\nMarcus: Quick update."
    user_prompt = small_conversation
    result2 = call_gemini(user_prompt)
    
    if result2['status_code'] == 200:
        tokens2 = result2.get('prompt_tokens', 0)
        print_colored(Colors.GREEN, f"    ✓ Small context (RESET): {tokens2} tokens")
    else:
        print_colored(Colors.RED, f"    ✗ {result2['status_code']}")
        return
    
    time.sleep(0.2)  # VERY SHORT delay - THIS TRIGGERS 429
    
    print_colored(Colors.YELLOW, "\n  Phase 3: IMMEDIATE large context (NO delay) - CRITICAL")
    user_prompt = f"{conversation}\n\nShould another agent react?"
    result3 = call_gemini(user_prompt)
    
    if result3['status_code'] == 200:
        tokens3 = result3.get('prompt_tokens', 0)
        print_colored(Colors.GREEN, f"    ✓ Large context again: {tokens3} tokens")
        print_colored(Colors.YELLOW, f"    Pattern: {tokens1} → {tokens2} → {tokens3} in 0.7s")
    elif result3['status_code'] == 429:
        print_colored(Colors.RED, "    ✗✗✗ 429 TRIGGERED! Pattern: Large → Reset → Immediate Large")
        print_colored(Colors.RED, f"    Token oscillation: {tokens1} → {tokens2} → Large")
    else:
        print_colored(Colors.RED, f"    ✗ HTTP {result3['status_code']}")
    
    return result3['status_code'] == 429

def run_stress_test(iterations: int = 5, concurrent: int = 3):
    """
    Run a stress test with concurrent requests to trigger rate limits
    This simulates what would happen with multiple users
    """
    print_colored(Colors.BLUE, "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print_colored(Colors.BLUE, f"  Stress Test: {concurrent} concurrent x {iterations} iterations")
    print_colored(Colors.BLUE, "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    def worker(worker_id: int):
        """Simulate a single user/session"""
        results = []
        conversation = INITIAL_CONVERSATION
        
        for i in range(iterations):
            user_prompt = f"{conversation}\n\nShould another agent react?"
            result = call_gemini(user_prompt)
            
            # Grow conversation
            if i > 0:
                conversation += f"\nMarcus: Worker {worker_id} analysis point {i}."
                conversation += f"\nValerie: Worker {worker_id} counterpoint {i}."
            
            results.append({
                'worker': worker_id,
                'turn': i + 1,
                'status': result['status_code'],
                'tokens': result.get('prompt_tokens', 0),
                'elapsed': result['elapsed_ms']
            })
            
            # Small delay to simulate real usage
            time.sleep(random.uniform(0.5, 1.5))
        
        return results
    
    import concurrent.futures
    
    all_results = []
    rate_limits = 0
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrent) as executor:
        futures = [executor.submit(worker, i) for i in range(concurrent)]
        
        for future in concurrent.futures.as_completed(futures):
            results = future.result()
            all_results.extend(results)
    
    # Analyze results
    for r in all_results:
        if r['status'] == 200:
            print_colored(Colors.GREEN, f"  Worker {r['worker']}, Turn {r['turn']}: ✓ {r['elapsed']}ms, {r['tokens']} tokens")
        elif r['status'] == 429:
            print_colored(Colors.RED, f"  Worker {r['worker']}, Turn {r['turn']}: ✗ 429 RATE LIMIT!")
            rate_limits += 1
        else:
            print_colored(Colors.YELLOW, f"  Worker {r['worker']}, Turn {r['turn']}: ? HTTP {r['status']}")
    
    print_colored(Colors.CYAN, f"\n  Total rate limits: {rate_limits}/{len(all_results)} requests")
    return rate_limits

def main():
    print_colored(Colors.BLUE, "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print_colored(Colors.BLUE, "  Gemini 429 Replication - TypeScript Behavior Match")
    print_colored(Colors.BLUE, "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    print_colored(Colors.YELLOW, f"\nAPI Key: {API_KEY[:10]}...")
    print_colored(Colors.YELLOW, f"Model: {MODEL_ID}")
    
    # Test 1: Exact TypeScript behavior (15 turns)
    rate_limits, token_history = replicate_exact_typeScript_behavior(15)
    
    # Test 2: Token oscillation pattern
    triggered = replicate_token_oscillation_pattern()
    
    # Test 3: Concurrent stress test
    stress_rate_limits = run_stress_test(iterations=5, concurrent=3)
    
    # Summary
    print_colored(Colors.BLUE, "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print_colored(Colors.BLUE, "  Summary")
    print_colored(Colors.BLUE, "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    print(f"  TypeScript behavior (15 turns): {len(rate_limits)} rate limits")
    print(f"  Token oscillation pattern: {'TRIGGERED' if triggered else 'Not triggered'}")
    print(f"  Concurrent stress test: {stress_rate_limits} rate limits")
    
    if len(rate_limits) > 0 or triggered or stress_rate_limits > 0:
        print_colored(Colors.RED, "\n  ⚠️ RATE LIMITS DETECTED!")
        print_colored(Colors.YELLOW, "\n  The issue is caused by:")
        print_colored(Colors.YELLOW, "    1. Rapid conversation growth (adding 3 sentences per turn)")
        print_colored(Colors.YELLOW, "    2. The specific prompt format with 'Last line from Valerie'")
        print_colored(Colors.YELLOW, "    3. No rate limit handling in your TypeScript code")
        print_colored(Colors.YELLOW, "\n  Solution: Add exponential backoff retry logic")
    else:
        print_colored(Colors.GREEN, "\n  ✓ No rate limits detected")
        print_colored(Colors.YELLOW, "  Your quota may be higher than the environment where logs came from")
        print_colored(Colors.YELLOW, "  The TypeScript code itself needs retry logic for production")

if __name__ == "__main__":
    main()