import json
import os

log_path = r"C:\Users\DUSHYANT\Desktop\council_of_agents\server\logs\gemini-errors.json"

print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
print("  Gemini Token Consumption Log Auditor                          ")
print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
print(f"{'Timestamp (IST)':<24} | {'Status':<7} | {'Input':<7} | {'Output':<7} | {'Total':<7}")
print("─────────────────────────────────────────────────────────────────")

if not os.path.exists(log_path):
    print(f"Error: Target log file not found at: {log_path}")
    exit(1)

total_input_tokens = 0
total_output_tokens = 0
log_count = 0

with open(log_path, 'r', encoding='utf-8') as f:
    for line_num, line in enumerate(f, 1):
        line = line.strip()
        if not line:
            continue
            
        try:
            log_entry = json.loads(line)
            log_count += 1
            
            timestamp = log_entry.get("timestampIst", "Unknown Time").replace(" IST", "")
            success = log_entry.get("success", False)
            status_str = "SUCCESS" if success else "FAILED"
            
            # Navigate deep into the JSON tree to find usageMetadata
            # http -> response -> body -> usageMetadata
            http_layer = log_entry.get("http", {})
            response_layer = http_layer.get("response", {}) if http_layer else {}
            body_layer = response_layer.get("body", {}) if response_layer else {}
            
            # Extracted token counts (Default to 0 if missing or if the request failed)
            input_tokens = 0
            output_tokens = 0
            total_tokens = 0
            
            if body_layer and "usageMetadata" in body_layer:
                metadata = body_layer["usageMetadata"]
                input_tokens = metadata.get("promptTokenCount", 0)
                output_tokens = metadata.get("candidatesTokenCount", 0)
                total_tokens = metadata.get("totalTokenCount", 0)
                
                # Accumulate grand totals
                total_input_tokens += input_tokens
                total_output_tokens += output_tokens
            
            # Print the row
            print(f"{timestamp:<24} | {status_str:<7} | {input_tokens:<7} | {output_tokens:<7} | {total_tokens:<7}")
            
        except json.JSONDecodeError:
            print(f"[Line {line_num}] ✗ Failed to parse line as valid JSON.")
        except Exception as e:
            print(f"[Line {line_num}] ✗ Error extracting token data: {str(e)}")

print("─────────────────────────────────────────────────────────────────")
print(f"Processed {log_count} log entries.")
print(f"Cumulative Budget Consumed: Input: {total_input_tokens} | Output: {total_output_tokens} | Grand Total: {total_input_tokens + total_output_tokens} tokens")