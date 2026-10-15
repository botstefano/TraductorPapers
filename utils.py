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

COLOR_MATCHED = RGBColor(0x15, 0x80, 0x3D)      # verde esmeralda: referencia cruzada en el lote
COLOR_UNMATCHED = RGBColor(0x1D, 0x4E, 0xD8)    # azul académico: referencia externa
COLOR_HEADING = RGBColor(0x0F, 0x17, 0x2A)      # slate 900
COLOR_TEXT = RGBColor(0x1E, 0x29, 0x3B)         # slate 800
COLOR_MUTED = RGBColor(0x64, 0x74, 0x8B)        # slate 500


import tempfile


def convert_pdf_to_docx_bytes(pdf_bytes: bytes) -> Optional[bytes]:
    """
    Convierte un PDF en memoria a un documento Word (.docx) clonando
    la maquetación original, incluyendo columnas, tablas, tipografías e imágenes.
    """
    try:
        from pdf2docx import Converter

        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f_pdf:
            f_pdf.write(pdf_bytes)
            pdf_path = f_pdf.name

        docx_path = pdf_path.replace(".pdf", ".docx")
        try:
            cv = Converter(pdf_path)
            cv.convert(docx_path, start=0, end=None)
            cv.close()

            if os.path.exists(docx_path):
                with open(docx_path, "rb") as f_docx:
                    return f_docx.read()
        finally:
            try:
                if os.path.exists(pdf_path):
                    os.remove(pdf_path)
                if os.path.exists(docx_path):
                    os.remove(docx_path)
            except Exception:
                pass
    except Exception:
        pass
    return None


def translate_docx_in_place(
    docx_bytes: bytes,
    reference_matches: List[ReferenceMatch],
    translator_func: Optional[Callable[[str], str]] = None,
) -> bytes:
    """
    Toma un documento Word (.docx) maquetado y traduce cada párrafo y celda de tabla
    reemplazando el texto en inglés por español, preservando imágenes, gráficos,
    estilos de fuente, y coloreando las referencias bibliográficas.
    """
    if translator_func is None:
        translator_func = translate_chunk_direct

    doc = Document(io.BytesIO(docx_bytes))

    in_references = False
    for p in doc.paragraphs:
        txt = p.text.strip()
        if not txt:
            continue

        lower = txt.lower()
        if any(h in lower for h in REFERENCES_HEADERS) and len(txt) < 40:
            in_references = True
            p.text = "REFERENCIAS BIBLIOGRÁFICAS (CRUCE DE CITAS)"
            for run in p.runs:
                run.bold = True
                run.font.name = "Times New Roman"
                run.font.color.rgb = COLOR_HEADING
            continue

        if in_references:
            matched = None
            for m in reference_matches:
                if fuzz.token_set_ratio(txt, m.reference_text) >= 65:
                    matched = m
                    break

            if matched and matched.is_translated_source:
                p.text = matched.reference_text
                if matched.matched_source_title:
                    note = p.add_run(
                        f"  [✓ Coincide con: \"{matched.matched_source_title}\" — Similitud {match.similarity:.0f}%]"
                    )
                    note.italic = True
                    note.bold = True
                    note.font.name = "Times New Roman"
                    note.font.color.rgb = COLOR_MATCHED
                for run in p.runs:
                    run.font.color.rgb = COLOR_MATCHED
            else:
                for run in p.runs:
                    run.font.color.rgb = COLOR_UNMATCHED
        else:
            # Reemplazar texto preservando el párrafo e interlineado
            if len(txt) > 3 and not txt.isdigit():
                try:
                    translated = translator_func(txt)
                    p.text = translated
                except Exception:
                    pass

    # Traducir tablas conservando su formato, bordes y celdas
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                cell_txt = cell.text.strip()
                if cell_txt and len(cell_txt) > 2 and not cell_txt.isdigit() and not cell_txt.startswith("http"):
                    try:
                        cell.text = translator_func(cell_txt)
                    except Exception:
                        pass

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def build_translated_docx(
    original_filename: str,
    translated_body: str,
    reference_matches: List[ReferenceMatch],
    paper_title: Optional[str] = None,
    original_file_bytes: Optional[bytes] = None,
    translator_func: Optional[Callable[[str], str]] = None,
) -> bytes:
    """
    Construye un documento .docx:
      1. Si se proporciona original_file_bytes (PDF o DOCX), intenta clonar la
         maquetación original (incluyendo imágenes, figuras, tablas y columnas)
         y traducir in-place.
      2. Si pdf2docx no está disponible o falla, genera un documento con maquetación
         académica profesional certificada (Times New Roman, márgenes 1", caja de Abstract).
    """
    ext = os.path.splitext(original_filename)[1].lower()

    # Estrategia A: Preservación visual idéntica vía conversión PDF/DOCX -> Word
    if original_file_bytes:
        docx_raw = None
        if ext == ".pdf":
            docx_raw = convert_pdf_to_docx_bytes(original_file_bytes)
        elif ext in [".docx", ".doc"]:
            docx_raw = original_file_bytes

        if docx_raw:
            try:
                translated_in_place = translate_docx_in_place(
                    docx_raw, reference_matches, translator_func=translator_func
                )
                if translated_in_place and len(translated_in_place) > 2000:
                    return translated_in_place
            except Exception:
                pass

    # Estrategia B: Plantilla Académica Profesional Estándar
    from docx.shared import Inches, Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH

    doc = Document()

    # 1. Configurar márgenes de página estándar (1 pulgada = 2.54 cm)
    section = doc.sections[0]
    section.top_margin = Inches(1.0)
    section.bottom_margin = Inches(1.0)
    section.left_margin = Inches(1.0)
    section.right_margin = Inches(1.0)

    # Encabezado de página
    header = section.header
    header_para = header.paragraphs[0]
    header_para.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run_hdr = header_para.add_run(f"Traducción Científica (EN → ES) — {original_filename}")
    run_hdr.font.name = "Times New Roman"
    run_hdr.font.size = Pt(8.5)
    run_hdr.font.color.rgb = COLOR_MUTED

    # 2. Título principal
    title_text = paper_title
    lines = [line.strip() for line in translated_body.split("\n") if line.strip()]
    if not title_text:
        if lines and len(lines[0]) < 180 and not lines[0].lower().startswith("resumen"):
            title_text = lines[0]
        else:
            base = os.path.splitext(original_filename)[0]
            title_text = base.replace("_", " ").replace("-", " ").title()

    p_title = doc.add_paragraph()
    p_title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_title.paragraph_format.space_before = Pt(12)
    p_title.paragraph_format.space_after = Pt(4)
    run_title = p_title.add_run(title_text)
    run_title.bold = True
    run_title.font.name = "Times New Roman"
    run_title.font.size = Pt(18)
    run_title.font.color.rgb = COLOR_HEADING

    # Subtítulo de traducción
    p_sub = doc.add_paragraph()
    p_sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_sub.paragraph_format.space_after = Pt(4)
    run_sub = p_sub.add_run("[Traducción Científica Especializada (EN → ES)]")
    run_sub.italic = True
    run_sub.font.name = "Times New Roman"
    run_sub.font.size = Pt(10)
    run_sub.font.color.rgb = COLOR_MUTED

    # Metadatos del documento
    p_meta = doc.add_paragraph()
    p_meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p_meta.paragraph_format.space_after = Pt(16)
    run_m1 = p_meta.add_run("Documento original: ")
    run_m1.font.size = Pt(9)
    run_m1.font.name = "Times New Roman"
    run_m1.font.color.rgb = COLOR_MUTED
    run_m2 = p_meta.add_run(original_filename)
    run_m2.bold = True
    run_m2.font.size = Pt(9)
    run_m2.font.name = "Times New Roman"
    run_m3 = p_meta.add_run("   |   Formato: Paper Académico Revisado")
    run_m3.font.size = Pt(9)
    run_m3.font.name = "Times New Roman"
    run_m3.font.color.rgb = COLOR_MUTED

    # 3. Procesar cuerpo: separar Abstract de secciones ordinarias
    in_abstract = False
    abstract_paras = []
    regular_paras = []

    for idx, raw_line in enumerate(translated_body.split("\n")):
        line_clean = raw_line.strip()
        if not line_clean:
            continue
        if idx == 0 and line_clean == title_text:
            continue

        lower = line_clean.lower()
        if lower in ["resumen", "abstract", "resumen (abstract)"] or lower.startswith(("resumen:", "abstract:")):
            in_abstract = True
            content = re.sub(r"^(?:resumen|abstract)[:\s-]*", "", line_clean, flags=re.IGNORECASE).strip()
            if content:
                abstract_paras.append(content)
            continue

        is_heading_candidate = (
            lower.startswith(("1.", "2.", "3.", "4.", "5.", "6.", "7.", "8.", "9."))
            or lower.startswith(("introducción", "introduccion", "metodología", "resultados", "discusión", "conclusión", "conclusiones"))
            or (len(line_clean) < 45 and not line_clean.endswith(".") and line_clean.isupper())
        )

        if in_abstract and is_heading_candidate:
            in_abstract = False

        if in_abstract:
            abstract_paras.append(line_clean)
        else:
            is_sec = is_heading_candidate or line_clean.startswith("#")
            clean_text = line_clean.lstrip("#").strip()
            regular_paras.append((clean_text, is_sec))

    # Renderizar Resumen en recuadro destacado
    if abstract_paras:
        tbl = doc.add_table(rows=1, cols=1)
        tbl.autofit = False
        tbl.columns[0].width = Inches(6.5)
        cell = tbl.cell(0, 0)
        
        p_ab_hdr = cell.paragraphs[0]
        p_ab_hdr.alignment = WD_ALIGN_PARAGRAPH.CENTER
        p_ab_hdr.paragraph_format.space_before = Pt(4)
        p_ab_hdr.paragraph_format.space_after = Pt(4)
        r_ab_hdr = p_ab_hdr.add_run("RESUMEN / ABSTRACT")
        r_ab_hdr.bold = True
        r_ab_hdr.font.name = "Times New Roman"
        r_ab_hdr.font.size = Pt(10.5)
        r_ab_hdr.font.color.rgb = COLOR_HEADING

        for ab_text in abstract_paras:
            p_ab = cell.add_paragraph()
            p_ab.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            p_ab.paragraph_format.space_after = Pt(4)
            p_ab.paragraph_format.line_spacing = 1.15
            r_ab = p_ab.add_run(ab_text)
            r_ab.italic = True
            r_ab.font.name = "Times New Roman"
            r_ab.font.size = Pt(10)
            r_ab.font.color.rgb = COLOR_TEXT

        p_spacer = doc.add_paragraph()
        p_spacer.paragraph_format.space_before = Pt(6)
        p_spacer.paragraph_format.space_after = Pt(6)

    # Renderizar Párrafos y Encabezados del Cuerpo
    for text_item, is_heading in regular_paras:
        if is_heading:
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(14)
            p.paragraph_format.space_after = Pt(4)
            p.paragraph_format.keep_with_next = True
            run = p.add_run(text_item.upper())
            run.bold = True
            run.font.name = "Times New Roman"
            run.font.size = Pt(12)
            run.font.color.rgb = COLOR_HEADING
        else:
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            p.paragraph_format.first_line_indent = Inches(0.25)
            p.paragraph_format.space_after = Pt(6)
            p.paragraph_format.line_spacing = 1.15
            run = p.add_run(text_item)
            run.font.name = "Times New Roman"
            run.font.size = Pt(10.5)
            run.font.color.rgb = COLOR_TEXT

    # 4. Sección de Referencias con Sangría Francesa (Hanging Indent)
    if reference_matches:
        p_ref_hdr = doc.add_paragraph()
        p_ref_hdr.paragraph_format.space_before = Pt(18)
        p_ref_hdr.paragraph_format.space_after = Pt(6)
        p_ref_hdr.paragraph_format.keep_with_next = True
        run_rh = p_ref_hdr.add_run("REFERENCIAS BIBLIOGRÁFICAS (CRUCE DE CITAS)")
        run_rh.bold = True
        run_rh.font.name = "Times New Roman"
        run_rh.font.size = Pt(12)
        run_rh.font.color.rgb = COLOR_HEADING

        # Leyenda
        matched_count = sum(1 for m in reference_matches if m.is_translated_source)
        unmatched_count = len(reference_matches) - matched_count

        legend = doc.add_paragraph()
        legend.paragraph_format.space_after = Pt(10)
        r_leg_title = legend.add_run("Leyenda del Cruce: ")
        r_leg_title.bold = True
        r_leg_title.font.name = "Times New Roman"
        r_leg_title.font.size = Pt(9.5)

        run_g = legend.add_run(f"🟢 VERDE ({matched_count}) = Cita con fuente traducida en este lote")
        run_g.font.name = "Times New Roman"
        run_g.font.size = Pt(9.5)
        run_g.font.color.rgb = COLOR_MATCHED
        run_g.bold = True

        run_sep = legend.add_run("   |   ")
        run_sep.font.size = Pt(9.5)

        run_b = legend.add_run(f"🔵 AZUL ({unmatched_count}) = Referencia externa sin cruce")
        run_b.font.name = "Times New Roman"
        run_b.font.size = Pt(9.5)
        run_b.font.color.rgb = COLOR_UNMATCHED
        run_b.bold = True

        # Cada referencia con Sangría Francesa (Hanging Indent) de 0.35 pulgadas
        for match in reference_matches:
            p = doc.add_paragraph()
            p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            p.paragraph_format.left_indent = Inches(0.35)
            p.paragraph_format.first_line_indent = Inches(-0.35)
            p.paragraph_format.space_after = Pt(5)
            p.paragraph_format.line_spacing = 1.1

            run = p.add_run(match.reference_text)
            run.font.name = "Times New Roman"
            run.font.size = Pt(9.5)
            run.font.color.rgb = (
                COLOR_MATCHED if match.is_translated_source else COLOR_UNMATCHED
            )
            run.bold = match.is_translated_source

            if match.is_translated_source and match.matched_source_title:
                note = p.add_run(
                    f"  [✓ Coincide con: \"{match.matched_source_title}\" — Similitud {match.similarity:.0f}%]"
                )
                note.italic = True
                note.bold = True
                note.font.name = "Times New Roman"
                note.font.size = Pt(8.5)
                note.font.color.rgb = COLOR_MATCHED

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
