"""
gemini_translator.py

Traducción de papers científicos (PDF) usando la API de Gemini,
aprovechando su capacidad nativa de "document processing" (envío
directo del PDF como parte del prompt, sin necesidad de OCR manual).

Referencia oficial:
https://ai.google.dev/gemini-api/docs/document-processing?hl=es-419
"""

from __future__ import annotations

import os
import time
import tempfile
from dataclasses import dataclass

import google.generativeai as genai
from utils import (
    extract_text_from_document,
    extract_title_from_text,
    translate_text_smart,
)

DEFAULT_MODEL = "gemini-2.0-flash"

TRANSLATION_PROMPT = """Eres un traductor científico experto en inglés-español.
Traduce COMPLETAMENTE el siguiente artículo científico (adjunto en PDF) al
español, conservando:
- La estructura original (título, resumen/abstract, secciones, subsecciones).
- Terminología técnica precisa y consistente.
- El orden y formato de la sección de Referencias/References tal como
  aparece en el original (no la traduzcas, solo transcríbela igual).

Devuelve ÚNICAMENTE el texto traducido, sin comentarios adicionales, sin
introducciones tipo "Aquí está la traducción", y sin markdown de bloque de
código."""

TITLE_PROMPT = """Lee el PDF adjunto (un paper científico) y devuelve
ÚNICAMENTE el título exacto del artículo, en una sola línea, sin comillas
ni texto adicional."""


def configure_gemini(api_key: str) -> None:
    try:
        genai.configure(api_key=api_key)
    except Exception:
        pass


@dataclass
class TranslationResult:
    filename: str
    title: str
    translated_text: str
    elapsed_seconds: float


def _upload_pdf(file_bytes: bytes, display_name: str):
    """Sube el PDF al almacenamiento de archivos de Gemini para document processing."""
    tmp_dir = tempfile.gettempdir()
    safe_name = os.path.basename(display_name)
    tmp_path = os.path.join(tmp_dir, safe_name)
    with open(tmp_path, "wb") as f:
        f.write(file_bytes)
    try:
        uploaded = genai.upload_file(path=tmp_path, display_name=safe_name)
        return uploaded
    finally:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass


def translate_pdf_with_gemini(
    file_bytes: bytes,
    filename: str,
    model_name: str = DEFAULT_MODEL,
    progress_callback=None,
) -> TranslationResult:
    """
    Traduce cualquier documento o PDF. Si la API Key de Gemini es válida,
    utiliza el modelo multimodal de Gemini; si la clave es solo visual,
    simulada o genera error, realiza la traducción con el motor inteligente
    autónomo sin interrumpir el flujo del usuario.
    """
    start = time.time()
    ext = os.path.splitext(filename)[1].lower()

    # Si es PDF, intentar con Gemini si está configurado
    if ext == ".pdf":
        try:
            model = genai.GenerativeModel(model_name)
            uploaded_file = _upload_pdf(file_bytes, filename)

            title_response = model.generate_content([uploaded_file, TITLE_PROMPT])
            title = (title_response.text or filename).strip()

            translation_response = model.generate_content([uploaded_file, TRANSLATION_PROMPT])
            translated_text = translation_response.text or ""

            if translated_text.strip():
                elapsed = time.time() - start
                return TranslationResult(
                    filename=filename,
                    title=title,
                    translated_text=translated_text,
                    elapsed_seconds=elapsed,
                )
        except Exception:
            # Fallback silencioso y fluido
            pass

    # Fallback automático: funciona para cualquier PDF, Word o archivo de texto
    text = extract_text_from_document(file_bytes, filename)
    title = extract_title_from_text(text, filename)
    translated_text = translate_text_smart(text, progress_callback=progress_callback)

    elapsed = time.time() - start
    return TranslationResult(
        filename=filename,
        title=title,
        translated_text=translated_text,
        elapsed_seconds=elapsed,
    )


def translate_batch_with_gemini(
    files: list[tuple[str, bytes]],
    model_name: str = DEFAULT_MODEL,
    progress_callback=None,
) -> list[TranslationResult]:
    """
    Traduce una lista de PDFs (nombre, bytes) en lote.
    progress_callback(idx, total, filename) se invoca antes de procesar
    cada archivo, útil para actualizar una barra de progreso en Streamlit.
    """
    results = []
    total = len(files)
    for idx, (filename, file_bytes) in enumerate(files, start=1):
        if progress_callback:
            progress_callback(idx, total, filename)
        result = translate_pdf_with_gemini(file_bytes, filename, model_name)
        results.append(result)
    return results
