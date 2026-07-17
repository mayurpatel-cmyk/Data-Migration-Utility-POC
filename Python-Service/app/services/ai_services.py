import httpx
import json
import re
from fastapi import HTTPException

OLLAMA_BASE_URL = "http://127.0.0.1:11434/api"
# UPGRADE: Swapped out large model for the high-speed 1.5B CPU-optimized version
AI_MODEL = "qwen2.5:1.5b"

class LocalAiService:
    @staticmethod
    async def generate_mapping(source_fields: list, target_fields: list) -> dict:
        """
        Queries qwen2.5:1.5b using Ollama's native API with strict JSON formatting.
        """
        system_prompt = (
            "You are a strict data-matching API router. Your task is to match source fields to target fields based on semantic similarity.\n"
            "You must respond ONLY with a valid JSON object matching this exact schema:\n"
            "{\n"
            '  "mappings": [\n'
            '    {"sourceField": "string", "targetField": "string", "confidence": 0.95}\n'
            '  ]\n'
            "}\n"
        )
        
        user_prompt = f"Source Schema Fields: {json.dumps(source_fields)}\nTarget Schema Fields: {json.dumps(target_fields)}"
        
        payload = {
            "model": AI_MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "format": "json",       
            "stream": False,        
            "options": {
                "temperature": 0.0  
            }
        }
        
        try:
            async with httpx.AsyncClient(timeout=None, trust_env=False) as client:
                response = await client.post(
                    f"{OLLAMA_BASE_URL}/chat", 
                    json=payload,
                    headers={"Content-Type": "application/json"}
                )
                
                if response.status_code != 200:
                    raise HTTPException(status_code=500, detail=f"Ollama Error: {response.text}")
                
                raw_content = response.json().get("message", {}).get("content", "")
                clean_content = re.sub(r"```json\s*|```", "", raw_content).strip()
                
                return json.loads(clean_content)
                
        except httpx.ReadTimeout:
            raise HTTPException(status_code=504, detail="AI generation timed out.")
        except httpx.RequestError as e:
            raise HTTPException(status_code=503, detail="Cannot reach AI service sidecar.")
        except (json.JSONDecodeError, KeyError) as e:
            raise HTTPException(status_code=502, detail="AI response failed structural JSON validation.")