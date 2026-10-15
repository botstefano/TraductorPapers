"""
utils.py
Funciones de apoyo:
 - Lectura de PDFs (texto completo + aislar sección de "References")
 - Detección/parseo de referencias individuales
 - Cruce (matching) entre referencias del artículo original (inglés)
   y las fuentes que sí fueron traducidas al español, para poder
   resaltarlas con un color distinto.
 - Generación de documentos .docx de salida con el texto traducido
   y las referencias coloreadas.
"""

from __future__ import annotations

import io
import os
import re
from dataclasses import dataclass, field
from typing import List, Optional, Callable

import pdfplumber
import pypdf
from docx import Document
from docx.shared import RGBColor, Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH
from rapidfuzz import fuzz
import requests
from deep_translator import MyMemoryTranslator


# --------------------------------------------------------------------------
# Extracción universal de texto de documentos (PDF, DOCX, TXT, MD)
# --------------------------------------------------------------------------

def extract_text_from_pdf(file_bytes: bytes) -> str:
    """Extrae todo el texto de un PDF usando pdfplumber con fallback a pypdf."""
    text_parts = []
    try:
        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text() or ""
                text_parts.append(page_text)
        result = "\n".join(text_parts).strip()
        if result:
            return result
    except Exception:
        pass

    try:
        reader = pypdf.PdfReader(io.BytesIO(file_bytes))
        fallback_parts = [page.extract_text() or "" for page in reader.pages]
        return "\n".join(fallback_parts).strip()
    except Exception:
        return ""


def extract_text_from_docx(file_bytes: bytes) -> str:
    """Extrae todo el texto de un documento Word (.docx)."""
    try:
        doc = Document(io.BytesIO(file_bytes))
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        for table in doc.tables:
            for row in table.rows:
                row_text = " | ".join([cell.text.strip() for cell in row.cells if cell.text.strip()])
                if row_text:
                    paragraphs.append(row_text)
        return "\n\n".join(paragraphs).strip()
    except Exception:
        return ""


def extract_text_from_txt(file_bytes: bytes) -> str:
    """Extrae texto plano decodificando en UTF-8 con fallback a latin-1."""
    try:
        return file_bytes.decode("utf-8").strip()
    except UnicodeDecodeError:
        try:
            return file_bytes.decode("latin-1").strip()
        except Exception:
            return file_bytes.decode("utf-8", errors="ignore").strip()


def extract_text_from_document(file_bytes: bytes, filename: str) -> str:
    """
    Identifica el formato de cualquier documento o paper (PDF, DOCX, TXT, MD)
    y extrae su contenido íntegro.
    """
    ext = os.path.splitext(filename)[1].lower()

    if ext == ".pdf":
        text = extract_text_from_pdf(file_bytes)
    elif ext in [".docx", ".doc"]:
        text = extract_text_from_docx(file_bytes)
    elif ext in [".txt", ".md", ".csv", ".rst"]:
        text = extract_text_from_txt(file_bytes)
    else:
        text = extract_text_from_pdf(file_bytes)
        if not text:
            text = extract_text_from_docx(file_bytes)
        if not text:
            text = extract_text_from_txt(file_bytes)

    return text.strip()


def extract_title_from_text(full_text: str, filename: str) -> str:
    """Infiere el título del documento a partir del texto o del nombre de archivo."""
    lines = [line.strip() for line in full_text.split("\n") if line.strip()]
    if lines:
        for candidate in lines[:6]:
            if len(candidate) > 6 and not candidate.lower().startswith(("arxiv:", "doi:", "http", "page ", "vol.")):
                return candidate
    base = os.path.splitext(filename)[0]
    return base.replace("_", " ").replace("-", " ").title()


REFERENCES_HEADERS = [
    "references", "bibliography", "works cited", "referencias",
    "bibliografía", "literature cited",
]


def split_body_and_references(full_text: str) -> tuple[str, str]:
    """
    Separa el cuerpo del artículo de la sección de referencias.
    Busca la última aparición de un encabezado típico de referencias.
    """
    lower = full_text.lower()
    cut_idx = -1
    for header in REFERENCES_HEADERS:
        # Buscamos el encabezado como línea propia (evita falsos positivos
        # dentro de oraciones, ej. "we cite references throughout").
        for m in re.finditer(rf"\n\s*{re.escape(header)}\s*\n", lower):
            if m.start() > cut_idx:
                cut_idx = m.start()
    if cut_idx == -1:
        return full_text, ""
    return full_text[:cut_idx], full_text[cut_idx:]


REFERENCE_ITEM_RE = re.compile(
    r"(?:^|\n)\s*(?:\[\d+\]|\d+\.)\s+(.+?)(?=(?:\n\s*(?:\[\d+\]|\d+\.)\s+)|\Z)",
    re.DOTALL,
)


def parse_reference_items(references_block: str) -> List[str]:
    """
    Intenta partir el bloque de referencias en items individuales.
    Soporta formatos numerados '[1] ...' y '1. ...'. Si no detecta
    ningún patrón, hace un fallback partiendo por líneas en blanco.
    """
    matches = REFERENCE_ITEM_RE.findall(references_block)
    items = [m.strip().replace("\n", " ") for m in matches if m.strip()]
    if items:
        return items

    # Fallback: separar por doble salto de línea
    raw_items = [seg.strip().replace("\n", " ")
                 for seg in references_block.split("\n\n") if seg.strip()]
    return raw_items


# --------------------------------------------------------------------------
# Cruce de referencias con fuentes traducidas
# --------------------------------------------------------------------------

@dataclass
class ReferenceMatch:
    reference_text: str
    matched_source_title: Optional[str] = None
    similarity: float = 0.0
    is_translated_source: bool = False


def cross_check_references(
    reference_items: List[str],
    translated_source_titles: List[str],
    threshold: float = 55.0,
) -> List[ReferenceMatch]:
    """
    Para cada referencia del artículo, calcula similitud difusa (fuzzy)
    contra los títulos de los papers que sí fueron traducidos en este
    mismo lote. Si supera el umbral, se marca como 'fuente traducida
    disponible' (para resaltarla en color distinto en el documento final).
    """
    results = []
    for ref in reference_items:
        best_title = None
        best_score = 0.0
        for title in translated_source_titles:
            score = fuzz.token_set_ratio(ref, title)
            if score > best_score:
                best_score = score
                best_title = title
        is_match = best_score >= threshold
        results.append(
            ReferenceMatch(
                reference_text=ref,
                matched_source_title=best_title if is_match else None,
                similarity=best_score,
                is_translated_source=is_match,
            )
        )
    return results



# --------------------------------------------------------------------------
# Motor de traducción inteligente y autónomo (EN -> ES)
# --------------------------------------------------------------------------

_TRANSLATION_CACHE: dict[str, str] = {}
_mymemory_instance: Optional[MyMemoryTranslator] = None


def _get_mymemory():
    global _mymemory_instance
    if _mymemory_instance is None:
        _mymemory_instance = MyMemoryTranslator(source="en-US", target="es-ES")
    return _mymemory_instance


def translate_chunk_direct(chunk: str) -> str:
    """Traduce un fragmento de texto en-es utilizando endpoints ultrarrápidos y resilientes."""
    clean = chunk.strip()
    if not clean:
        return chunk

    if clean in _TRANSLATION_CACHE:
        return _TRANSLATION_CACHE[clean]

    # Estrategia 1: Endpoint de Google Translate Client (muy rápido y sin API key)
    try:
        url = "https://clients5.google.com/translate_a/t"
        params = {"client": "dict-chrome-ex", "sl": "en", "tl": "es", "q": clean}
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        resp = requests.get(url, params=params, headers=headers, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, list) and len(data) > 0 and isinstance(data[0], str):
                result = data[0].strip()
                _TRANSLATION_CACHE[clean] = result
                return result
    except Exception:
        pass

    # Estrategia 2: Fallback con MyMemory Translator
    try:
        if len(clean) <= 450:
            tr = _get_mymemory().translate(clean)
            if tr:
                _TRANSLATION_CACHE[clean] = tr.strip()
                return tr.strip()
        else:
            sentences = re.split(r"(?<=[.?!])\s+", clean)
            translated_sentences = []
            buf = ""
            for s in sentences:
                if len(buf) + len(s) + 1 <= 400:
                    buf = (buf + " " + s).strip()
                else:
                    if buf:
                        tr_part = _get_mymemory().translate(buf) or buf
                        translated_sentences.append(tr_part)
                    buf = s
            if buf:
                tr_part = _get_mymemory().translate(buf) or buf
                translated_sentences.append(tr_part)
            combined = " ".join(translated_sentences).strip()
            if combined:
                _TRANSLATION_CACHE[clean] = combined
                return combined
    except Exception:
        pass

    return clean


def translate_text_smart(
    text: str,
    progress_callback: Optional[Callable[[float, str], None]] = None,
    max_chunk_size: int = 1200,
) -> str:
    """
    Traduce un texto completo (de cualquier longitud) dividiéndolo en
    párrafos y bloques coherentes, respetando la estructura original.
    """
    if not text.strip():
        return ""

    paragraphs = text.split("\n")
    total_paras = len(paragraphs)
    translated_paras = []

    for i, p in enumerate(paragraphs):
        p_clean = p.strip()
        if not p_clean:
            translated_paras.append("")
            continue

        if progress_callback and (i % 3 == 0 or i == total_paras - 1):
            pct = min(0.98, (i + 1) / max(1, total_paras))
            progress_callback(pct, f"Traduciendo sección {i+1} de {total_paras}...")

        if len(p_clean) > max_chunk_size:
            sentences = re.split(r"(?<=[.?!])\s+", p_clean)
            sub_chunks = []
            cur = ""
            for s in sentences:
                if len(cur) + len(s) + 1 <= max_chunk_size:
                    cur = (cur + " " + s).strip()
                else:
                    if cur:
                        sub_chunks.append(cur)
                    cur = s
            if cur:
                sub_chunks.append(cur)

            translated_sub = [translate_chunk_direct(sc) for sc in sub_chunks]
            translated_paras.append(" ".join(translated_sub))
        else:
            translated_paras.append(translate_chunk_direct(p_clean))

    if progress_callback:
        progress_callback(1.0, "Traducción completada con éxito.")

    return "\n".join(translated_paras)


# --------------------------------------------------------------------------
# Generación de documento .docx con resaltado
# --------------------------------------------------------------------------

COLOR_MATCHED = RGBColor(0x1B, 0x8A, 0x3B)      # verde: referencia con fuente traducida disponible
COLOR_UNMATCHED = RGBColor(0x1F, 0x3D, 0x7A)    # azul oscuro: referencia sin traducción cruzada
COLOR_TITLE = RGBColor(0x00, 0x00, 0x00)


def build_translated_docx(
    original_filename: str,
    translated_body: str,
    reference_matches: List[ReferenceMatch],
) -> bytes:
    """
    Construye un .docx con:
      - Título
      - Cuerpo traducido al español
      - Sección de referencias, coloreando en verde las que cruzan con
        una fuente también traducida en el lote, y en azul las que no.
    """
    doc = Document()

    title = doc.add_heading(f"Traducción: {original_filename}", level=1)
    for run in title.runs:
        run.font.color.rgb = COLOR_TITLE

    doc.add_heading("Cuerpo del artículo (traducido)", level=2)
    for para in translated_body.split("\n"):
        if para.strip():
            p = doc.add_paragraph(para.strip())
            p.style.font.size = Pt(11)

    if reference_matches:
        doc.add_heading("Referencias (cruce con fuentes traducidas)", level=2)
        legend = doc.add_paragraph()
        legend.add_run("Leyenda: ").bold = True
        run_g = legend.add_run("verde = referencia con fuente también traducida en este lote")
        run_g.font.color.rgb = COLOR_MATCHED
        legend.add_run("   |   ")
        run_b = legend.add_run("azul = referencia sin cruce en el lote")
        run_b.font.color.rgb = COLOR_UNMATCHED

        for match in reference_matches:
            p = doc.add_paragraph()
            run = p.add_run(match.reference_text)
            run.font.color.rgb = (
                COLOR_MATCHED if match.is_translated_source else COLOR_UNMATCHED
            )
            if match.is_translated_source:
                note = p.add_run(
                    f"  [coincide con: {match.matched_source_title} | "
                    f"similitud {match.similarity:.0f}%]"
                )
                note.italic = True
                note.font.size = Pt(9)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def build_zip_of_docs(named_docs: dict[str, bytes]) -> bytes:
    """Empaqueta varios .docx en un único .zip para descarga en lote."""
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for filename, content in named_docs.items():
            zf.writestr(filename, content)
    return buf.getvalue()
