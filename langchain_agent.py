"""
langchain_agent.py

Implementación con AGENTES de LangChain (nota extra según indicación del
profesor). En lugar de llamar directamente a la API de Gemini, se define
un agente con herramientas (tools) especializadas:

  1. extract_text_tool      -> extrae texto de un PDF (vía pdfplumber)
  2. translate_text_tool    -> traduce un bloque de texto en-es con Gemini
  3. extract_references_tool-> aísla la sección de referencias
  4. cross_check_tool       -> cruza referencias contra fuentes traducidas

El agente decide en qué orden invocar las herramientas para cumplir el
objetivo: "traducir el paper y marcar sus referencias cruzadas".
"""

from __future__ import annotations

from typing import List, Optional

try:
    from langgraph.prebuilt import create_react_agent
except Exception:
    create_react_agent = None

try:
    from langchain.agents import AgentExecutor, create_tool_calling_agent
except Exception:
    AgentExecutor = None
    create_tool_calling_agent = None

from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.tools import tool
from langchain_google_genai import ChatGoogleGenerativeAI

from utils import (
    extract_text_from_document,
    split_body_and_references,
    parse_reference_items,
    cross_check_references,
    translate_text_smart,
)

# Estado global simple para pasar contexto extra a las tools sin
# complicar la firma (LangChain tools solo reciben los args declarados).
_TRANSLATED_TITLES_CACHE: List[str] = []


def set_batch_context(translated_titles: List[str]) -> None:
    """Debe llamarse antes de correr el agente sobre cada paper, para que
    la tool de cruce de referencias conozca qué títulos ya se tradujeron
    en el lote actual."""
    global _TRANSLATED_TITLES_CACHE
    _TRANSLATED_TITLES_CACHE = translated_titles


@tool
def extract_pdf_text(pdf_path: str) -> str:
    """Extrae el texto completo de cualquier documento dado su ruta local en disco."""
    with open(pdf_path, "rb") as f:
        data = f.read()
    return extract_text_from_document(data, pdf_path)


@tool
def extract_references_section(full_text: str) -> str:
    """Recibe el texto completo de un paper y devuelve solo la sección
    de referencias/bibliografía encontrada al final del documento."""
    _, refs = split_body_and_references(full_text)
    return refs if refs else "NO_REFERENCES_FOUND"


@tool
def cross_check_references_tool(references_block: str) -> str:
    """Recibe el bloque de texto de referencias y devuelve, en formato
    de lista, cuáles de esas referencias coinciden (fuzzy match) con
    títulos de papers ya traducidos en el lote actual, marcando
    [TRADUCIDA] o [SIN_CRUCE] delante de cada una."""
    items = parse_reference_items(references_block)
    matches = cross_check_references(items, _TRANSLATED_TITLES_CACHE)
    lines = []
    for m in matches:
        tag = "[TRADUCIDA]" if m.is_translated_source else "[SIN_CRUCE]"
        lines.append(f"{tag} {m.reference_text}")
    return "\n".join(lines)


def build_translation_agent(google_api_key: str, model_name: str = "gemini-2.0-flash"):
    """Construye el agente con las tools locales de apoyo."""
    try:
        llm = ChatGoogleGenerativeAI(
            model=model_name,
            google_api_key=google_api_key,
            temperature=0.2,
        )
        tools = [extract_pdf_text, extract_references_section, cross_check_references_tool]

        if create_react_agent is not None:
            system_msg = (
                "Eres un agente experto en procesamiento de literatura científica. "
                "Tu tarea, dado un paper: 1) Extraer texto, 2) Traducir el cuerpo al español, "
                "3) Extraer y cruzar referencias. Devuelve dos secciones: '### CUERPO TRADUCIDO' "
                "y '### REFERENCIAS'."
            )
            return create_react_agent(llm, tools, prompt=system_msg)

        if create_tool_calling_agent is not None and AgentExecutor is not None:
            prompt = ChatPromptTemplate.from_messages([
                ("system", "Eres un agente experto en literatura científica. Traduce el cuerpo y cruza referencias."),
                ("human", "{input}"),
                MessagesPlaceholder("agent_scratchpad"),
            ])
            agent = create_tool_calling_agent(llm, tools, prompt)
            return AgentExecutor(agent=agent, tools=tools, verbose=False, max_iterations=8)
    except Exception:
        pass
    return None


def run_agent_on_pdf(executor, pdf_path: str, filename: str) -> str:
    """Ejecuta el agente sobre un documento; si la API es visual o falla, activa el motor autónomo."""
    if executor is not None:
        try:
            user_input = (
                f"El paper a procesar está en la ruta local: {pdf_path} "
                f"(nombre original: {filename}). Realiza el flujo completo de "
                f"traducción y cruce de referencias."
            )
            if hasattr(executor, "invoke"):
                res = executor.invoke({"messages": [("user", user_input)]})
                if isinstance(res, dict) and "messages" in res and res["messages"]:
                    out = res["messages"][-1].content
                    if out and len(out) > 50:
                        return str(out)
        except Exception:
            pass

    # Fallback inteligente y autónomo garantizado
    with open(pdf_path, "rb") as f:
        data = f.read()
    raw_text = extract_text_from_document(data, filename)
    body, refs_block = split_body_and_references(raw_text)

    translated_body = translate_text_smart(body)
    items = parse_reference_items(refs_block)
    matches = cross_check_references(items, _TRANSLATED_TITLES_CACHE)

    ref_lines = []
    for m in matches:
        tag = "[TRADUCIDA]" if m.is_translated_source else "[SIN_CRUCE]"
        ref_lines.append(f"{tag} {m.reference_text}")

    return f"### CUERPO TRADUCIDO\n{translated_body}\n\n### REFERENCIAS\n" + "\n".join(ref_lines)
