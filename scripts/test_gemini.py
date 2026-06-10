#!/usr/bin/env python3
"""
Replicates the EXACT behavior of the TypeScript code that caused 429s
"""

import os
import json
import time
import random
import requests
from datetime import datetime
from typing import List, Dict, Any, Optional
import concurrent.futures  # FIXED: Import the module properly

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
            if turn > 1:
                s1 = f"Marcus: Let us thoroughly evaluate data metric matrix line item code alpha-{turn}."
                s2 = f"Valerie: I counter that assertion because the emotional focus on step {turn} outweighs your data numbers."
                s3 = f"Marcus: Dynamic parameter adjustment noted, progressing conference cycle iteration forward."
                
                conversation_history = f"{conversation_history}\n{s1}\n{s2}\n{s3}"
            
        elif result['status_code'] == 429:
            print_colored(Colors.RED, f"    ✗✗✗ 429 RATE LIMIT at turn {turn}! ✗✗✗")
            error_msg = result.get('response', {}).get('error', {}).get('message', 'Unknown')
            print_colored(Colors.RED, f"    Error: {error_msg}")
            rate_limits.append(turn)
            
            # CRITICAL: Continue to see if more 429s occur
            # This matches production behavior where some requests succeed after 429
            
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
        if i in rate_limits:
            print_colored(Colors.RED, f"    Turn {i}: {tokens} ✗ 429")
        else:
            print(f"    Turn {i}: {tokens}")
    
    return rate_limits, token_history

def test_with_retry_logic():
    """
    Test the SAME pattern but WITH exponential backoff retry logic
    This shows the solution
    """
    print_colored(Colors.BLUE, "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print_colored(Colors.BLUE, "  TEST WITH RETRY LOGIC (Exponential Backoff)")
    print_colored(Colors.BLUE, "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    def call_with_retry(contents, max_retries=5):
        """Exponential backoff retry logic"""
        for attempt in range(max_retries):
            result = call_gemini(contents)
            
            if result['status_code'] != 429:
                return result
            
            # Calculate delay: 1s, 2s, 4s, 8s, 16s
            delay = (2 ** attempt)
            print_colored(Colors.YELLOW, f"      Retry {attempt + 1}/{max_retries} after {delay}s")
            time.sleep(delay)
        
        return result  # Return last result even if 429
    
    conversation_history = INITIAL_CONVERSATION
    rate_limits = 0
    
    for turn in range(1, 16):
        print_colored(Colors.CYAN, f"\n  Turn {turn}/15")
        
        user_prompt = f"""{conversation_history}

Last line from Valerie: "What are the two options you're torn between?"

Should another agent react?"""
        
        result = call_with_retry(user_prompt)
        
        if result['status_code'] == 200:
            tokens = result.get('prompt_tokens', 0)
            print_colored(Colors.GREEN, f"    ✓ SUCCESS ({result['elapsed_ms']}ms) - Tokens: {tokens}")
        elif result['status_code'] == 429:
            print_colored(Colors.RED, f"    ✗ Still 429 after all retries")
            rate_limits += 1
        else:
            print_colored(Colors.YELLOW, f"    ? HTTP {result['status_code']}")
        
        # Grow conversation
        if turn > 1:
            s1 = f"Marcus: Analysis point {turn}."
            s2 = f"Valerie: Counterpoint {turn}."
            s3 = f"Marcus: Resolution {turn}."
            conversation_history = f"{conversation_history}\n{s1}\n{s2}\n{s3}"
        
        if turn < 15:
            time.sleep(1.5)
    
    print_colored(Colors.GREEN, f"\n  Rate limits with retry: {rate_limits}")
    return rate_limits

def run_stress_test(iterations: int = 5, concurrent: int = 3):
    """Run a stress test with concurrent requests"""
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
    
    # Test 2: Solution with retry logic
    retry_rate_limits = test_with_retry_logic()
    
    # Summary
    print_colored(Colors.BLUE, "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print_colored(Colors.BLUE, "  SUMMARY & SOLUTION")
    print_colored(Colors.BLUE, "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    
    print(f"\n  Current code: {len(rate_limits)} rate limits in 15 turns")
    print(f"  With retry logic: {retry_rate_limits} rate limits survived")
    
    print_colored(Colors.RED, "\n  ⚠️ YOUR TYPESCRIPT CODE NEEDS THIS FIX:")
    print_colored(Colors.YELLOW, """
  Add this function to your TypeScript code:

  async function callGeminiWithRetry(
    model: string,
    body: GeminiGenerateBody,
    operation: ChatModelOperation,
    maxRetries: number = 5
  ): Promise<GeminiPostResult> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await geminiPost(model, body, operation, Date.now());
      } catch (err) {
        const isRateLimit = err.message.includes('429') || 
                           err.message.includes('RESOURCE_EXHAUSTED');
        
        if (!isRateLimit || attempt === maxRetries - 1) throw err;
        
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s, 16s
        logger.warn('GEMINI_RETRY', `Rate limited, retrying in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Max retries exceeded');
  }

  Then replace all geminiPost() calls with callGeminiWithRetry()
  """)

if __name__ == "__main__":
    main()