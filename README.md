# TraductorPapers - Traductor en lote de papers científicos (EN → ES)

Aplicación web moderna desarrollada en **React + TypeScript + Vite + Express (Node.js)** reescrita a partir de la versión en Streamlit para traducción académica en lote con análisis de bibliografía y referencias cruzadas.

## ✨ Características Principales

- **Universalidad de documentos**: Procesa cualquier documento o paper en inglés (.pdf, .docx, .txt, .md) individualmente o en lotes de hasta 10+ documentos.
- **Entrada de API visual y no bloqueante**: La barra lateral dispone del campo para ingresar la Google Gemini API Key, mostrando el estado de conexión sin detener la ejecución si no se cuenta con una clave activa.
- **Modos de traducción**:
  - **Gemini directo (document processing)**: Envío y traducción con modelos Google Gemini de última generación (`gemini-3.8-flash`, `gemini-4-argon`, etc.).
  - **Agentes LangChain / Autónomos**: Pipeline estructurado de 3 etapas para análisis jerárquico, traducción técnica rigurosa y extracción de bibliografía.
  - **Motor Autónomo Ultrarrápido**: Motor de traducción autónomo y tolerante a fallos con segmentación inteligente de párrafos y caché en memoria.
- **Cruce de referencias con colores**: Detección y cotejo difuso (*token-set ratio*) de las citas bibliográficas del documento original contra los títulos de los otros papers del lote actual:
  - 🟢 **Verde (`#1B8A3B`)**: Referencia con fuente también traducida en este lote, con porcentaje de similitud.
  - 🔵 **Azul (`#1F3D7A`)**: Referencia sin cruce directo en el lote.
- **Salida multiformato**:
  - Descarga individual en Microsoft Word estructurado (`.docx`) con formato y colores en citas.
  - Descarga individual en texto plano (`.txt`).
  - Descarga masiva de todo el lote en archivo comprimido (`.zip`).
- **Lote de prueba con 1 clic**: Incluye 5 papers seminales de IA y Computer Science con citas cruzadas entre sí para probar inmediatamente sin requerir archivos externos.

## 🚀 Puesta en Marcha

```bash
# Instalar dependencias
npm install

# Iniciar servidor de desarrollo (dev server en puerto 3000)
npm run dev

# Compilar para producción
npm run build
```

## ⚙️ Configuración

Puedes especificar tu clave de API de Gemini a través de:
1. Variable de entorno en `.env`: `GOOGLE_API_KEY=tu_clave` o `GEMINI_API_KEY=tu_clave`
2. El campo interactivo de la barra lateral en la aplicación web.
