# Traductor en lote de papers científicos (EN → ES)

Aplicación en **Python + Streamlit** para la tarea de la Semana 3:
sube 10 papers científicos en inglés (PDF, de los últimos 5 años),
la app los traduce **en lote** al español usando la **API de Gemini**
(o, para nota extra, **agentes de LangChain**), y genera un `.docx`
por cada paper con las **referencias resaltadas en color** según si
cruzan (fuzzy match) con otra fuente también traducida en el mismo lote.

## 1. Instalación

```bash
cd paper_translator
python -m venv venv
source venv/bin/activate      # En Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## 2. Configura tu API Key de Gemini

Opción A — variable de entorno:
```bash
cp .env.example .env
# edita .env y pega tu API key (https://aistudio.google.com/app/apikey)
```

Opción B — pegarla directamente en el campo de la barra lateral de la app
al ejecutarla (no se guarda en disco).

## 3. Ejecutar la aplicación

```bash
streamlit run app.py
```

Se abrirá en `http://localhost:8501`.

## 4. Uso

1. En la barra lateral, ingresa tu **API Key de Gemini** y elige el modo:
   - **Gemini directo (document processing)**: envía cada PDF completo al
     modelo Gemini, que lo traduce usando su capacidad nativa de lectura
     de documentos (sin OCR manual). Ver:
     https://ai.google.dev/gemini-api/docs/document-processing?hl=es-419
   - **Agentes LangChain (nota extra)**: un `AgentExecutor` decide, con
     herramientas propias (`extract_pdf_text`, `extract_references_section`,
     `cross_check_references_tool`), cómo extraer, traducir y cruzar
     referencias.
2. Sube tus **10 papers en PDF** (arrastra o selecciona varios a la vez).
3. Presiona **"Traducir lote"**.
4. Descarga cada `.docx` individual o el `.zip` con todos.

## 5. Cómo se cumplen los criterios de la tarea

| Requisito                                                                 | Dónde se resuelve |
|----------------------------------------------------------------------------|--------------------|
| 10 papers en inglés (últimos 5 años) + su traducción (20 en total)         | El usuario los sube; la app produce 1 `.docx` traducido por cada PDF subido. |
| App en Python + Streamlit que lea y traduzca ficheros **en lote**          | `app.py`: `st.file_uploader(accept_multiple_files=True)` + bucle de traducción sobre todos los archivos. |
| Uso de API del traductor / **API de Gemini** / agentes LangChain o n8n     | `gemini_translator.py` (Gemini directo) y `langchain_agent.py` (agente con tools). |
| Revisión del contenido del artículo                                        | El cuerpo completo se traduce y se muestra íntegro en el `.docx` de salida. |
| Referencias cruzadas con las fuentes traducidas, **marcadas de color diferente** | `utils.py::cross_check_references` (fuzzy matching) + `build_translated_docx` (verde = con cruce, azul = sin cruce). |

## 6. Estructura del proyecto

```
paper_translator/
├── app.py                 # Interfaz Streamlit (orquestador principal)
├── gemini_translator.py   # Traducción directa vía API de Gemini (document processing)
├── langchain_agent.py     # Modo con AGENTES LangChain (nota extra)
├── utils.py                # Extracción de PDF, parseo de referencias, cruce y generación de .docx
├── requirements.txt
├── .env.example
└── README.md
```

## 7. Notas

- El **cruce de referencias** es *dentro del propio lote*: se compara cada
  referencia citada por un paper contra los **títulos de los otros papers
  que subiste y tradujiste en la misma corrida**. Si tus 10 papers no se
  citan entre sí, es normal que la mayoría quede en azul ("sin cruce");
  eso es exactamente lo que se espera que la revisión en vivo muestre.
- Puedes ajustar el **umbral de similitud** (slider en la barra lateral)
  si el cruce es demasiado estricto o demasiado permisivo.
- El modo de **agentes LangChain** otorga nota extra según la indicación
  del profesor ("quien lo haga usando agentes tendrá más nota").
