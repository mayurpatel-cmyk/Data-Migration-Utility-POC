import httpx
import math
import re
from fastapi import HTTPException
from typing import Dict, List, Any

OLLAMA_BASE_URL = "http://127.0.0.1:11434/api"
EMBEDDING_MODEL = "nomic-embed-text" 

# In-memory cache to prevent re-embedding the same target fields
_TARGET_CACHE: Dict[str, List[float]] = {}

class LocalAiService:
    @staticmethod
    def _precompute_magnitude(vector: List[float]) -> float:
        """Helper to pre-calculate vector magnitude for faster loops."""
        return math.sqrt(sum(a * a for a in vector))

    @staticmethod
    def fast_cosine_similarity(v1: List[float], v2: List[float], mag1: float, mag2: float) -> float:
        """Optimized math function using pre-calculated magnitudes."""
        if mag1 * mag2 == 0:
            return 0.0
        dot_product = sum(a * b for a, b in zip(v1, v2))
        return dot_product / (mag1 * mag2)

    @staticmethod
    async def get_embeddings(texts: List[str]) -> List[List[float]]:
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
    async def generate_mapping(source_fields: List[Dict[str, Any]], target_fields: List[Dict[str, Any]]) -> dict:
        if not source_fields or not target_fields:
            return {"mappings": []}

        # 1. Clean up text perfectly (Do NOT include the data type in the text, it confuses the AI)
        def prep_text(name):
            if not name: return ""
            s1 = re.sub(r'(.)([A-Z][a-z]+)', r'\1 \2', name)
            return re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', s1).replace('_', ' ').lower()

        src_texts = [prep_text(f.get("name", "")) for f in source_fields]
        
        # 2. Check Cache for Targets to save network time
        tgt_texts_to_fetch = []
        tgt_indices_to_fetch = []
        tgt_vectors = [None] * len(target_fields)

        for i, f in enumerate(target_fields):
            cache_key = prep_text(f.get("name", ""))
            if cache_key in _TARGET_CACHE:
                tgt_vectors[i] = _TARGET_CACHE[cache_key]
            else:
                tgt_texts_to_fetch.append(cache_key)
                tgt_indices_to_fetch.append(i)

        # 3. Fetch Embeddings
        src_vectors = await LocalAiService.get_embeddings(src_texts)
        
        if tgt_texts_to_fetch:
            new_tgt_vectors = await LocalAiService.get_embeddings(tgt_texts_to_fetch)
            for text, idx, vec in zip(tgt_texts_to_fetch, tgt_indices_to_fetch, new_tgt_vectors):
                tgt_vectors[idx] = vec
                _TARGET_CACHE[text] = vec 

        # Pre-compute magnitudes
        src_mags = [LocalAiService._precompute_magnitude(v) for v in src_vectors]
        tgt_mags = [LocalAiService._precompute_magnitude(v) for v in tgt_vectors]

        mappings = []
        claimed_targets = set() 
        all_potential_matches = []

        # High-Accuracy Data Type Categories
        numeric_types = {'number', 'integer', 'double', 'currency', 'float', 'decimal', 'percent'}
        text_types = {'string', 'text', 'textarea', 'picklist', 'reference', 'id', 'url', 'phone', 'email'}
        date_types = {'date', 'datetime', 'timestamp'}
        bool_types = {'boolean', 'checkbox'}

        # 4. Score all combinations
        for idx_src, src_vec in enumerate(src_vectors):
            src_field = source_fields[idx_src]
            src_type = src_field.get("type", "string").lower()
            src_mag = src_mags[idx_src]
            
            for idx_tgt, tgt_vec in enumerate(tgt_vectors):
                tgt_field = target_fields[idx_tgt]
                tgt_type = tgt_field.get("type", "string").lower()

                # STRICT TYPE ENFORCEMENT: Group checking
                is_exact = src_type == tgt_type
                is_forgiving = (
                    (src_type in text_types and tgt_type in text_types) or
                    (src_type in numeric_types and tgt_type in numeric_types) or
                    (src_type in date_types and tgt_type in date_types) or
                    (src_type in bool_types and tgt_type in bool_types)
                )

                # Skip completely if types are fundamentally incompatible (e.g., date to boolean)
                if not (is_exact or is_forgiving):
                    continue

                # Math calculation
                similarity = LocalAiService.fast_cosine_similarity(src_vec, tgt_vec, src_mag, tgt_mags[idx_tgt])
                
                # THE SECRET SAUCE: Add a mathematical bonus if the data types match EXACTLY
                if is_exact:
                    similarity += 0.05 
                
                # RAISED THRESHOLD: Must be > 0.75 to prevent bad guesses
                if similarity > 0.75:
                    all_potential_matches.append({
                        "sourceField": src_field.get("name"),
                        "targetField": tgt_field.get("name"),
                        "confidence": similarity
                    })

        # 5. Sort matches by highest confidence first (Tie-breakers won by type exactness)
        all_potential_matches.sort(key=lambda x: x["confidence"], reverse=True)

        for match in all_potential_matches:
            if match["targetField"] not in claimed_targets:
                mappings.append({
                    "sourceField": match["sourceField"],
                    "targetField": match["targetField"],
                    "confidence": round(match["confidence"], 2)
                })
                claimed_targets.add(match["targetField"])
                
                if len(mappings) >= len(source_fields):
                    break

        return {"mappings": mappings}