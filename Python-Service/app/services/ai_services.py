import httpx
import json
import re
from fastapi import HTTPException

OLLAMA_BASE_URL = "http://127.0.0.1:11434/api"
AI_MODEL = "llama3.2:1b"

class LocalAiService:
    @staticmethod
    async def generate_mapping(source_fields: list, target_fields: list) -> dict:
        """
        Queries llama3.1 using Ollama's native API with strict JSON formatting.
        """
        
        system_prompt = (
            "You are an expert data-migration assistant specializing in CRM schema matching.\n"
            "Your task is to map source fields to target fields based on deep semantic similarity and data type compatibility.\n\n"
            "CRITICAL RULES:\n"
            "1. Only map fields if they have a clear semantic relationship (e.g., 'email_address' matches 'WorkEmail').\n"
            "2. Strict Type Alignment: Avoid mapping incompatible types unless easily coercible (e.g., do NOT map a 'boolean' to a 'datetime').\n"
            "3. Explicit Omissions: If a source field has NO logical match in the target schema, do NOT invent a mapping. Omit it from the results array entirely.\n"
            "4. Confidence Scores: Assign a realistic confidence score between 0.0 and 1.0 based on how exact the semantic match is.\n\n"
            "You must respond ONLY with a valid JSON object matching this exact schema:\n"
            "{\n"
            '  "mappings": [\n'
            '    {"sourceField": "string", "targetField": "string", "confidence": 0.85}\n'
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
                "temperature": 0.0,
                "num_predict": 800, 
                "num_ctx": 4096, 
                "num_thread": 8     
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