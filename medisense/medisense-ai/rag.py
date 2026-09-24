"""
rag.py — Medical History RAG Engine for Vela / Atlas

Handles:
  1. Chunking raw document text into semantic chunks
  2. Embedding chunks via OpenAI text-embedding-3-small
  3. Storing/retrieving chunks in a local SQLite vector store
  4. Cosine-similarity search across a patient's full history
  5. Cited answer synthesis via GPT-4o
  6. Timeline generation across all documents

All functions are designed to be called from async FastAPI handlers
via asyncio.to_thread() for CPU/IO-bound operations.
"""

import json
import os
import re
import sqlite3
import struct
import time
import uuid
from datetime import datetime
from typing import Optional

import numpy as np
from openai import OpenAI

# ── CONFIG ──

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIM = 1536
CHUNK_SIZE_CHARS = 1500       # ~400 tokens
CHUNK_OVERLAP_CHARS = 400     # ~100 tokens overlap
MIN_CHUNK_CHARS = 80          # Skip very short chunks
RELEVANCE_THRESHOLD = float(os.getenv("VELA_RAG_RELEVANCE_THRESHOLD", "0.30"))    # Minimum cosine similarity to include a chunk.
# NOTE: text-embedding-3-small produces genuine relevant-match cosine scores in
# the ~0.30–0.55 range (near-duplicates reach ~0.6+). A prior value of 0.60
# rejected EVERY chunk — even a query containing the report's exact terms
# ("CA 15-3 tumor marker" measured 0.558) — so the RAG path always returned
# "no records found" and Atlas never answered from uploaded reports. Retrieval
# is already scoped per-patient and capped at top_k, so a lower floor safely
# admits real matches without pulling in other patients' data.
DEFAULT_TOP_K = 10

# ── DATABASE ──

_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vela_local.db")
_openai_client: Optional[OpenAI] = None


def _get_openai() -> OpenAI:
    global _openai_client
    if _openai_client is None:
        _openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    return _openai_client


def init_rag_tables():
    """Create the document_chunks table if it doesn't exist.
    Call once at app startup.
    """
    conn = sqlite3.connect(_DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS document_chunks (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        report_date TEXT,
        chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
    )
    """)
    cursor.execute("""
    CREATE INDEX IF NOT EXISTS idx_chunks_patient
    ON document_chunks(patient_id)
    """)
    cursor.execute("""
    CREATE INDEX IF NOT EXISTS idx_chunks_document
    ON document_chunks(document_id)
    """)
    conn.commit()
    conn.close()
    print("✅ RAG tables initialized")


# ── CHUNKING ──

def chunk_text(text: str, chunk_size: int = CHUNK_SIZE_CHARS, overlap: int = CHUNK_OVERLAP_CHARS) -> list[str]:
    """Split text into overlapping chunks, respecting paragraph and sentence boundaries.

    Strategy:
      1. Split on double newlines (paragraph boundaries)
      2. If a paragraph is too long, split on sentence boundaries
      3. Merge small paragraphs together until they reach chunk_size
      4. Apply overlap between chunks
    """
    if not text or len(text.strip()) < MIN_CHUNK_CHARS:
        return []

    # Normalize whitespace
    text = re.sub(r'\n{3,}', '\n\n', text.strip())

    # Split into paragraphs
    paragraphs = re.split(r'\n\s*\n', text)

    # Split long paragraphs into sentences
    segments: list[str] = []
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        if len(para) <= chunk_size:
            segments.append(para)
        else:
            # Split on sentence boundaries
            sentences = re.split(r'(?<=[.!?])\s+', para)
            current = ""
            for sent in sentences:
                if len(current) + len(sent) + 1 > chunk_size and current:
                    segments.append(current.strip())
                    current = sent
                else:
                    current = current + " " + sent if current else sent
            if current.strip():
                segments.append(current.strip())

    # Merge small segments and create overlapping chunks
    chunks: list[str] = []
    current_chunk = ""

    for segment in segments:
        if len(current_chunk) + len(segment) + 2 <= chunk_size:
            current_chunk = current_chunk + "\n\n" + segment if current_chunk else segment
        else:
            if current_chunk and len(current_chunk.strip()) >= MIN_CHUNK_CHARS:
                chunks.append(current_chunk.strip())
            # Start new chunk with overlap from previous
            if overlap > 0 and current_chunk:
                overlap_text = current_chunk[-overlap:]
                # Try to start at a word boundary
                space_idx = overlap_text.find(' ')
                if space_idx > 0:
                    overlap_text = overlap_text[space_idx + 1:]
                current_chunk = overlap_text + "\n\n" + segment
            else:
                current_chunk = segment

    # Don't forget the last chunk
    if current_chunk and len(current_chunk.strip()) >= MIN_CHUNK_CHARS:
        chunks.append(current_chunk.strip())

    return chunks


# ── EMBEDDING ──

def embed_texts(texts: list[str]) -> list[np.ndarray]:
    """Embed a batch of texts using OpenAI's embedding API.
    Returns a list of numpy arrays (float32).
    """
    if not texts:
        return []

    client = _get_openai()
    response = client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=texts,
    )

    embeddings = []
    for item in response.data:
        vec = np.array(item.embedding, dtype=np.float32)
        embeddings.append(vec)

    return embeddings


def _serialize_embedding(vec: np.ndarray) -> bytes:
    """Serialize a numpy float32 array to bytes for SQLite BLOB storage."""
    return vec.tobytes()


def _deserialize_embedding(blob: bytes) -> np.ndarray:
    """Deserialize bytes back to a numpy float32 array."""
    return np.frombuffer(blob, dtype=np.float32)


# ── STORE ──

def store_chunks(
    patient_id: str,
    document_id: str,
    filename: str,
    report_date: str,
    chunks: list[str],
    embeddings: list[np.ndarray],
):
    """Store chunked text and embeddings into the SQLite vector store."""
    if not chunks or not embeddings or len(chunks) != len(embeddings):
        return

    conn = sqlite3.connect(_DB_PATH)
    cursor = conn.cursor()

    rows = []
    for i, (chunk_text_val, embedding) in enumerate(zip(chunks, embeddings)):
        chunk_id = str(uuid.uuid4())
        rows.append((
            chunk_id,
            patient_id,
            document_id,
            filename,
            report_date,
            i,
            chunk_text_val,
            _serialize_embedding(embedding),
        ))

    cursor.executemany(
        """INSERT INTO document_chunks
           (id, patient_id, document_id, filename, report_date, chunk_index, chunk_text, embedding)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        rows,
    )
    conn.commit()
    conn.close()
    print(f"📦 RAG: Stored {len(rows)} chunks for document {document_id}")


def delete_chunks_for_document(document_id: str):
    """Delete all chunks for a given document (when the document is deleted)."""
    conn = sqlite3.connect(_DB_PATH)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM document_chunks WHERE document_id = ?", (document_id,))
    deleted = cursor.rowcount
    conn.commit()
    conn.close()
    if deleted:
        print(f"🗑️ RAG: Deleted {deleted} chunks for document {document_id}")


def delete_chunks_for_patient(patient_id: str):
    """Delete all chunks for a patient."""
    conn = sqlite3.connect(_DB_PATH)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM document_chunks WHERE patient_id = ?", (patient_id,))
    deleted = cursor.rowcount
    conn.commit()
    conn.close()
    if deleted:
        print(f"🗑️ RAG: Deleted {deleted} chunks for patient {patient_id}")


# ── SEARCH ──

def search_chunks(
    patient_id: str,
    query_embedding: np.ndarray,
    top_k: int = DEFAULT_TOP_K,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
) -> list[dict]:
    """Search for the most relevant chunks for a patient using cosine similarity.

    Returns a list of dicts with keys:
      chunk_text, document_id, filename, report_date, chunk_index, relevance_score
    """
    conn = sqlite3.connect(_DB_PATH)
    cursor = conn.cursor()

    # Build query with optional date filter
    sql = "SELECT id, document_id, filename, report_date, chunk_index, chunk_text, embedding FROM document_chunks WHERE patient_id = ?"
    params: list = [patient_id]

    if date_from:
        sql += " AND report_date >= ?"
        params.append(date_from)
    if date_to:
        sql += " AND report_date <= ?"
        params.append(date_to)

    cursor.execute(sql, params)
    rows = cursor.fetchall()
    conn.close()

    if not rows:
        return []

    # Compute cosine similarity for all chunks
    query_norm = query_embedding / (np.linalg.norm(query_embedding) + 1e-10)

    results = []
    for row in rows:
        chunk_id, doc_id, fname, rdate, cidx, ctext, emb_blob = row
        chunk_emb = _deserialize_embedding(emb_blob)
        chunk_norm = chunk_emb / (np.linalg.norm(chunk_emb) + 1e-10)
        score = float(np.dot(query_norm, chunk_norm))

        if score >= RELEVANCE_THRESHOLD:
            results.append({
                "chunk_id": chunk_id,
                "document_id": doc_id,
                "filename": fname,
                "report_date": rdate,
                "chunk_index": cidx,
                "chunk_text": ctext,
                "relevance_score": round(score, 4),
            })

    # Sort by relevance descending
    results.sort(key=lambda x: x["relevance_score"], reverse=True)
    return results[:top_k]


def get_chunk_count(patient_id: str) -> int:
    """Get total number of chunks stored for a patient."""
    conn = sqlite3.connect(_DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM document_chunks WHERE patient_id = ?", (patient_id,))
    count = cursor.fetchone()[0]
    conn.close()
    return count


# ── CITED SYNTHESIS ──

def build_profile_block(patient: dict | None) -> str:
    """
    Format the patient's registration record as a citable source.

    Allergies, known conditions, blood group and demographics live on the
    patients table, not inside any uploaded document — so they were invisible to
    a document-only retriever. Asking Atlas "any allergies?" returned "not found
    in the available records" while Penicillin sat on the patient row. That is
    the single most dangerous kind of false negative this system can produce,
    so the profile is now always supplied alongside the retrieved chunks.
    """
    if not patient:
        return ""
    fields = [
        ("Name", patient.get("name")),
        ("Age", patient.get("age")),
        ("Sex", patient.get("gender")),
        ("Blood group", patient.get("blood_group")),
        ("Allergies", patient.get("allergies")),
        ("Known conditions", patient.get("existing_conditions")),
        ("Ward", patient.get("ward")),
        ("Room", patient.get("room")),
        ("Attending", patient.get("doctor")),
    ]
    lines = [f"{label}: {value}" for label, value in fields
             if value not in (None, "", "None")]
    if not lines:
        return ""
    return "[SOURCE: Patient registration record]\n" + "\n".join(lines)


def synthesize_cited_answer(
    query: str,
    chunks: list[dict],
    patient_name: str = "the patient",
    profile_text: str = "",
) -> dict:
    """Given a query and relevant chunks, synthesize a cited answer using GPT-4o.

    `profile_text` carries registration-record facts (allergies, conditions,
    demographics) that live outside the document index — see build_profile_block.

    Returns:
      {
        "answer": "...",
        "citations": [
          {"document_id": "...", "filename": "...", "report_date": "...", "excerpt": "...", "relevance_score": 0.92}
        ]
      }
    """
    if not chunks and not profile_text:
        return {
            "answer": f"No relevant medical records were found for {patient_name} matching this query. Please upload the relevant reports to enable a complete history search.",
            "citations": [],
        }

    # Build context from chunks with numbered source tags
    context_parts = []
    if profile_text:
        context_parts.append(profile_text)
    for i, chunk in enumerate(chunks):
        source_tag = f"[SOURCE {i+1}: {chunk['filename']}, {chunk['report_date'] or 'Unknown date'}]"
        context_parts.append(f"{source_tag}\n{chunk['chunk_text']}")

    context = "\n\n---\n\n".join(context_parts)

    system_prompt = f"""You are Atlas, the clinical AI assistant at Vela Health.
You are answering a doctor's query about {patient_name}'s medical history using ONLY the source documents provided below.

ABSOLUTE RULES:
1. ONLY state facts that are explicitly present in the source documents below. NEVER infer, guess, or fabricate medical data.
2. For EVERY medical fact you state, you MUST cite the source in the format: (Source: filename, date). For facts taken from the patient registration record, cite it as (Source: Patient registration record).
3. If the source documents do not contain information to answer the query, say: "This information was not found in the available records for {patient_name}."
4. NEVER prescribe medication or make new diagnoses.
5. Keep your response concise and clinically precise (maximum 4-5 sentences).
6. If you see a trend across multiple reports, describe it with citations for each data point.
7. Allergies, known conditions and demographics come from the patient registration record. Treat it as authoritative for those facts, and never answer "not found" for something it clearly states.

SOURCE DOCUMENTS:
{context}"""

    client = _get_openai()
    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": query},
        ],
        max_tokens=500,
        temperature=0.15,
    )
    answer = response.choices[0].message.content.strip()

    # Build citations array from the chunks that were provided
    citations = []
    for chunk in chunks:
        # Extract a short excerpt (first 200 chars of the chunk)
        excerpt = chunk["chunk_text"][:200].strip()
        if len(chunk["chunk_text"]) > 200:
            # Try to cut at a sentence boundary
            last_period = excerpt.rfind('.')
            if last_period > 100:
                excerpt = excerpt[:last_period + 1]
            else:
                excerpt += "…"

        citations.append({
            "document_id": chunk["document_id"],
            "filename": chunk["filename"],
            "report_date": chunk["report_date"],
            "excerpt": excerpt,
            "relevance_score": chunk["relevance_score"],
        })

    return {
        "answer": answer,
        "citations": citations,
    }


def synthesize_cited_answer_streaming(
    query: str,
    chunks: list[dict],
    patient_name: str = "the patient",
    profile_text: str = "",
):
    """Streaming version of synthesize_cited_answer. Yields (token, citations, is_done) tuples.

    - During streaming: yields (token_str, None, False)
    - At the end: yields (None, citations_list, True)
    """
    if not chunks and not profile_text:
        no_match = f"No relevant medical records were found for {patient_name} matching this query. Please upload the relevant reports to enable a complete history search."
        yield (no_match, [], True)
        return

    # Build context from chunks
    context_parts = []
    if profile_text:
        context_parts.append(profile_text)
    for i, chunk in enumerate(chunks):
        source_tag = f"[SOURCE {i+1}: {chunk['filename']}, {chunk['report_date'] or 'Unknown date'}]"
        context_parts.append(f"{source_tag}\n{chunk['chunk_text']}")

    context = "\n\n---\n\n".join(context_parts)

    system_prompt = f"""You are Atlas, the clinical AI assistant at Vela Health.
You are answering a doctor's query about {patient_name}'s medical history using ONLY the source documents provided below.

ABSOLUTE RULES:
1. ONLY state facts that are explicitly present in the source documents below. NEVER infer, guess, or fabricate medical data.
2. For EVERY medical fact you state, you MUST cite the source in the format: (Source: filename, date). For facts taken from the patient registration record, cite it as (Source: Patient registration record).
3. If the source documents do not contain information to answer the query, say: "This information was not found in the available records for {patient_name}."
4. NEVER prescribe medication or make new diagnoses.
5. Keep your response concise and clinically precise (maximum 4-5 sentences).
6. If you see a trend across multiple reports, describe it with citations for each data point.
7. Allergies, known conditions and demographics come from the patient registration record. Treat it as authoritative for those facts, and never answer "not found" for something it clearly states.

SOURCE DOCUMENTS:
{context}"""

    client = _get_openai()
    stream = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": query},
        ],
        max_tokens=500,
        temperature=0.15,
        stream=True,
    )

    for chunk_resp in stream:
        delta = chunk_resp.choices[0].delta if chunk_resp.choices else None
        if delta and delta.content:
            yield (delta.content, None, False)

    # Build citations
    citations = []
    for chunk in chunks:
        excerpt = chunk["chunk_text"][:200].strip()
        if len(chunk["chunk_text"]) > 200:
            last_period = excerpt.rfind('.')
            if last_period > 100:
                excerpt = excerpt[:last_period + 1]
            else:
                excerpt += "…"
        citations.append({
            "document_id": chunk["document_id"],
            "filename": chunk["filename"],
            "report_date": chunk["report_date"],
            "excerpt": excerpt,
            "relevance_score": chunk["relevance_score"],
        })

    yield (None, citations, True)


# ── TIMELINE ──

def generate_timeline(patient_id: str, focus: Optional[str] = None) -> dict:
    """Generate a chronological timeline of all documents for a patient.

    If `focus` is provided, chunks are ranked by relevance to the focus area
    and key findings are extracted accordingly.
    """
    conn = sqlite3.connect(_DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        """SELECT DISTINCT document_id, filename, report_date
           FROM document_chunks
           WHERE patient_id = ?
           ORDER BY report_date ASC""",
        (patient_id,),
    )
    docs = cursor.fetchall()

    if not docs:
        conn.close()
        return {
            "timeline": [],
            "summary": "No medical records found for this patient.",
            "total_documents": 0,
        }

    # Get all chunk texts grouped by document
    timeline_entries = []
    all_text_by_doc = {}

    for doc_id, filename, report_date in docs:
        cursor.execute(
            "SELECT chunk_text FROM document_chunks WHERE document_id = ? ORDER BY chunk_index",
            (doc_id,),
        )
        chunk_rows = cursor.fetchall()
        full_text = "\n".join([r[0] for r in chunk_rows])
        all_text_by_doc[doc_id] = full_text

        timeline_entries.append({
            "document_id": doc_id,
            "filename": filename,
            "date": report_date,
            "text_preview": full_text[:500],
        })

    conn.close()

    # Use GPT to extract key findings for each document
    docs_context = ""
    for entry in timeline_entries:
        docs_context += f"\n---\n[{entry['date']} | {entry['filename']}]\n{entry['text_preview']}\n"

    focus_instruction = ""
    if focus:
        focus_instruction = f'\nPay special attention to anything related to: {focus}'

    client = _get_openai()
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": f"""Extract key medical findings from each document and create a timeline summary.
{focus_instruction}

For each document, return 2-4 key findings as short bullet points.
Also provide a 1-2 sentence overall summary of the patient's medical history trend.

Return ONLY valid JSON:
{{
    "entries": [
        {{
            "filename": "report.pdf",
            "date": "2024-03-15",
            "key_findings": ["Finding 1", "Finding 2"],
            "risk_level": "low|moderate|high|critical"
        }}
    ],
    "summary": "Overall patient history summary..."
}}"""},
            {"role": "user", "content": docs_context},
        ],
        response_format={"type": "json_object"},
        max_tokens=800,
        temperature=0.1,
    )

    try:
        parsed = json.loads(response.choices[0].message.content.strip())
        return {
            "timeline": parsed.get("entries", []),
            "summary": parsed.get("summary", ""),
            "total_documents": len(docs),
        }
    except (json.JSONDecodeError, Exception) as e:
        print(f"⚠️ RAG timeline parse error: {e}")
        # Fallback: return raw entries without AI-extracted findings
        return {
            "timeline": [
                {
                    "filename": e["filename"],
                    "date": e["date"],
                    "key_findings": [],
                    "risk_level": "unknown",
                }
                for e in timeline_entries
            ],
            "summary": f"Patient has {len(timeline_entries)} documents on record.",
            "total_documents": len(timeline_entries),
        }


# ── PROGRESSION NARRATIVE ──

# Per-document text budget when building the whole-history context. Keeps the
# combined prompt inside a safe token range even for patients with many years
# of reports, while preserving enough of each report to describe its findings.
PROGRESSION_CHARS_PER_DOC = 1800
PROGRESSION_MAX_DOCS = 40


def generate_progression_narrative_streaming(patient_id: str, patient_name: str = "the patient"):
    """Stream an AI narrative describing how a patient has changed over time.

    Reads EVERY document on record (oldest → newest), feeds the chronological
    context to GPT-4o, and streams a progression summary token-by-token.
    Yields (token, meta, is_done):
      - during streaming: (token_str, None, False)
      - at the end:       (None, {"span": ..., "document_count": ...}, True)
    """
    conn = sqlite3.connect(_DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        """SELECT DISTINCT document_id, filename, report_date
           FROM document_chunks
           WHERE patient_id = ?
           ORDER BY report_date ASC""",
        (patient_id,),
    )
    docs = cursor.fetchall()

    if not docs:
        conn.close()
        yield (
            f"No medical records are on file for {patient_name} yet. Upload reports to build a longitudinal history.",
            {"span": None, "document_count": 0},
            True,
        )
        return

    # Cap the number of documents to stay within a safe prompt size. When a
    # patient has more than the cap, keep the oldest and newest reports so the
    # narrative still spans the full range rather than truncating recent history.
    if len(docs) > PROGRESSION_MAX_DOCS:
        head = PROGRESSION_MAX_DOCS // 2
        tail = PROGRESSION_MAX_DOCS - head
        docs = docs[:head] + docs[-tail:]

    context_parts = []
    for doc_id, filename, report_date in docs:
        cursor.execute(
            "SELECT chunk_text FROM document_chunks WHERE document_id = ? ORDER BY chunk_index",
            (doc_id,),
        )
        full_text = "\n".join(r[0] for r in cursor.fetchall())[:PROGRESSION_CHARS_PER_DOC]
        context_parts.append(f"[{report_date or 'Unknown date'} | {filename}]\n{full_text}")
    conn.close()

    dates = [d[2] for d in docs if d[2]]
    span = f"{dates[0]} → {dates[-1]}" if dates else None
    context = "\n\n---\n\n".join(context_parts)

    system_prompt = f"""You are Atlas, the clinical AI assistant at Vela Health.
You are writing a longitudinal progression summary for a doctor, describing how {patient_name}'s health has changed over time, using ONLY the chronological source documents below.

ABSOLUTE RULES:
1. ONLY state facts explicitly present in the source documents. NEVER infer, guess, or fabricate medical data.
2. Structure the narrative chronologically — describe the earliest baseline, then how findings changed across subsequent reports, ending with the most recent status.
3. Explicitly call out TRENDS (improving, worsening, stable, newly appeared, resolved) and cite the report date for each data point in the format (date).
4. When a measurable value appears in multiple reports (e.g. a lab value, blood pressure, weight), trace how it moved across dates.
5. NEVER prescribe medication or make new diagnoses.
6. Be clinically precise. Use short paragraphs. End with a 1-sentence overall trajectory.

CHRONOLOGICAL SOURCE DOCUMENTS (oldest first):
{context}"""

    client = _get_openai()
    stream = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Summarize how {patient_name} has changed across their entire medical history on record."},
        ],
        max_tokens=900,
        temperature=0.2,
        stream=True,
    )

    for chunk_resp in stream:
        delta = chunk_resp.choices[0].delta if chunk_resp.choices else None
        if delta and delta.content:
            yield (delta.content, None, False)

    yield (None, {"span": span, "document_count": len(docs)}, True)


# ── HIGH-LEVEL PIPELINE FUNCTIONS ──

def process_document_for_rag(
    patient_id: str,
    document_id: str,
    filename: str,
    report_date: str,
    raw_text: str,
):
    """Full pipeline: chunk → embed → store.
    Called from the document upload background worker.
    """
    if not raw_text or len(raw_text.strip()) < MIN_CHUNK_CHARS:
        print(f"⚠️ RAG: Skipping document {document_id} — text too short ({len(raw_text)} chars)")
        return

    start = time.time()

    # 1. Chunk
    chunks = chunk_text(raw_text)
    if not chunks:
        print(f"⚠️ RAG: No valid chunks from document {document_id}")
        return

    # 2. Embed
    embeddings = embed_texts(chunks)

    # 3. Store
    store_chunks(patient_id, document_id, filename, report_date, chunks, embeddings)

    elapsed = round(time.time() - start, 2)
    print(f"✅ RAG: Processed document {document_id} → {len(chunks)} chunks in {elapsed}s")


def query_patient_history(
    patient_id: str,
    query: str,
    top_k: int = DEFAULT_TOP_K,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    patient_name: str = "the patient",
    profile_text: str = "",
) -> dict:
    """Full RAG query pipeline: embed query → search → synthesize cited answer.

    Returns:
      {
        "status": "success",
        "answer": "...",
        "citations": [...],
        "chunks_searched": 142,
        "time_ms": 850
      }
    """
    start = time.time()

    # 1. Embed the query
    query_embeddings = embed_texts([query])
    if not query_embeddings:
        return {
            "status": "error",
            "answer": "Failed to process the query.",
            "citations": [],
            "chunks_searched": 0,
            "time_ms": 0,
        }

    query_emb = query_embeddings[0]

    # 2. Search
    chunks_total = get_chunk_count(patient_id)
    results = search_chunks(patient_id, query_emb, top_k=top_k, date_from=date_from, date_to=date_to)

    # 3. Synthesize
    synthesis = synthesize_cited_answer(
        query, results, patient_name=patient_name, profile_text=profile_text
    )

    elapsed_ms = round((time.time() - start) * 1000)

    return {
        "status": "success",
        "answer": synthesis["answer"],
        "citations": synthesis["citations"],
        "chunks_searched": chunks_total,
        "chunks_matched": len(results),
        "time_ms": elapsed_ms,
    }


def get_rag_context_for_atlas(
    patient_id: str,
    query: str,
    top_k: int = 5,
    profile_text: str = "",
) -> str:
    """Get RAG context formatted for inclusion in Atlas's LLM prompt.
    Returns a formatted string of relevant chunks with source tags,
    or just the registration record if no documents matched.
    """
    try:
        # The registration record leads: allergies and known conditions must
        # reach Atlas even when no uploaded document matches the question.
        lines = [profile_text] if profile_text else []

        query_embeddings = embed_texts([query])
        if not query_embeddings:
            return "\n".join(lines)

        results = search_chunks(patient_id, query_embeddings[0], top_k=top_k)
        for r in results:
            source = f"[{r['report_date'] or 'Unknown date'} | {r['filename']}]"
            # Truncate long chunks for Atlas context
            text = r['chunk_text'][:400]
            lines.append(f"{source} {text}")

        return "\n".join(lines)

    except Exception as e:
        print(f"⚠️ RAG context for Atlas failed: {e}")
        return profile_text or ""
