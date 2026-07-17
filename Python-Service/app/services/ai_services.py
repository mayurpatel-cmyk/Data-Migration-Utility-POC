import httpx
import math
import re
from fastapi import HTTPException

OLLAMA_BASE_URL = "http://127.0.0.1:11434/api"

# We use an embedding-specific model instead of a chat model for millisecond processing
EMBEDDING_MODEL = "nomic-embed-text" 

class LocalAiService:
    @staticmethod
    def cosine_similarity(v1: list[float], v2: list[float]) -> float:
        """Calculates the mathematical distance between two vectors."""
        dot_product = sum(a * b for a, b in zip(v1, v2))
        magnitude1 = math.sqrt(sum(a * a for a in v1))
        magnitude2 = math.sqrt(sum(a * a for a in v2))
        if magnitude1 * magnitude2 == 0:
            return 0.0
        return dot_product / (magnitude1 * magnitude2)

    @staticmethod
    async def get_embeddings(texts: list[str]) -> list[list[float]]:
        """Fetches vector embeddings in batches from Ollama."""
        if not texts:
            return []
            
        payload = {
            "model": EMBEDDING_MODEL,
            "input": texts
        }
        
        async with httpx.AsyncClient(timeout=None, trust_env=False) as client:
            try:
                response = await client.post(
                    f"{OLLAMA_BASE_URL}/embed", 
                    json=payload
                )
                
                if response.status_code != 200:
                    raise HTTPException(status_code=500, detail=f"Ollama Embed Error: {response.text}")
                
                return response.json().get("embeddings", [])
                
            except httpx.RequestError:
                raise HTTPException(status_code=503, detail="Cannot reach Ollama embedding service.")
            
    @staticmethod
    async def generate_mapping(source_fields: list, target_fields: list) -> dict:
        """
        Uses mathematical vector similarity instead of an LLM to instantly 
        match semantic meaning between source and target fields.
        """
        if not source_fields or not target_fields:
            return {"mappings": []}

        # 1. Clean up field names for better semantic understanding
        # Changes "billing_address" or "BillingAddress" into "billing address"
        def prep_text(name):
            if not name: return ""
            s1 = re.sub(r'(.)([A-Z][a-z]+)', r'\1 \2', name)
            clean = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', s1).replace('_', ' ').lower()
            return clean

        src_texts = [prep_text(f.get("name", "")) for f in source_fields]
        tgt_texts = [prep_text(f.get("name", "")) for f in target_fields]

        # 2. Instantly generate vectors for all fields
        src_vectors = await LocalAiService.get_embeddings(src_texts)
        tgt_vectors = await LocalAiService.get_embeddings(tgt_texts)

        mappings = []

        # 3. Calculate distance and find the best matches
        for idx_src, src_vec in enumerate(src_vectors):
            src_field = source_fields[idx_src]
            src_type = src_field.get("type", "string").lower()
            
            best_match = None
            best_score = 0.0

            for idx_tgt, tgt_vec in enumerate(tgt_vectors):
                tgt_field = target_fields[idx_tgt]
                tgt_type = tgt_field.get("type", "string").lower()

                # CRITICAL: Enforce Type Compatibility so vectors don't map unrelated data types
                is_exact = src_type == tgt_type
                is_forgiving = (
                    ("string" in src_type and tgt_type in ['string', 'text', 'textarea', 'picklist', 'reference']) or
                    (src_type in ['number', 'integer', 'double', 'currency', 'float'] and tgt_type in ['number', 'integer', 'double', 'currency', 'float'])
                )

                if not (is_exact or is_forgiving):
                    continue

                # Math calculation
                similarity = LocalAiService.cosine_similarity(src_vec, tgt_vec)
                
                if similarity > best_score:
                    best_score = similarity
                    best_match = tgt_field.get("name")

            # 4. Apply a strict confidence threshold (0.65 for embeddings is usually safe)
            if best_score > 0.65 and best_match:
                mappings.append({
                    "sourceField": src_field.get("name"),
                    "targetField": best_match,
                    "confidence": round(best_score, 2)
                })

        return {"mappings": mappings}