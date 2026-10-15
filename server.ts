import express from "express";
import type { Request, Response } from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Body parser for JSON with large files (PDF base64)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Ensure valid Google API key from environment if placeholder was set
if (
  (!process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY.includes("tu_api_key")) &&
  process.env.GEMINI_API_KEY
) {
  process.env.GOOGLE_API_KEY = process.env.GEMINI_API_KEY;
}

// In-memory translation cache
const translationCache = new Map<string, string>();

// Fallback direct translation via public translation endpoint
async function translateChunkPublic(chunk: string): Promise<string> {
  const clean = chunk.trim();
  if (!clean) return chunk;

  if (translationCache.has(clean)) {
    return translationCache.get(clean)!;
  }

  // Strategy 1: Google Translate public web client endpoint
  try {
    const url = "https://clients5.google.com/translate_a/t";
    const params = new URLSearchParams({
      client: "dict-chrome-ex",
      sl: "en",
      tl: "es",
      q: clean,
    });

    const response = await fetch(`${url}?${params.toString()}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (response.ok) {
      const data = await response.json();
      if (Array.isArray(data) && data.length > 0 && typeof data[0] === "string") {
        const translated = data[0].trim();
        translationCache.set(clean, translated);
        return translated;
      }
    }
  } catch {
    // Continue to fallback
  }

  // Strategy 2: MyMemory API fallback
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
      clean.slice(0, 450)
    )}&langpair=en|es`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      if (data?.responseData?.translatedText) {
        const translated = data.responseData.translatedText.trim();
        translationCache.set(clean, translated);
        return translated;
      }
    }
  } catch {
    // Continue to fallback
  }

  return clean;
}

// Helper to run promises with limited concurrency
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      results[index] = await fn(items[index]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function translateParagraphsSmart(text: string): Promise<string> {
  if (!text || !text.trim()) return "";

  const paragraphs = text.split("\n");

  const translatedParas = await mapConcurrent(paragraphs, 6, async (para) => {
    const trimmed = para.trim();
    if (!trimmed) return "";

    if (trimmed.length > 800) {
      const sentences = trimmed.split(/(?<=[.?!])\s+/);
      const chunks: string[] = [];
      let cur = "";

      for (const s of sentences) {
        if ((cur + " " + s).trim().length <= 600) {
          cur = (cur + " " + s).trim();
        } else {
          if (cur) chunks.push(cur);
          cur = s;
        }
      }
      if (cur) chunks.push(cur);

      const translatedChunks = await Promise.all(chunks.map((c) => translateChunkPublic(c)));
      return translatedChunks.join(" ");
    } else {
      return await translateChunkPublic(trimmed);
    }
  });

  return translatedParas.join("\n");
}

// Map user model selection to modern valid Gemini models
function resolveGeminiModel(requestedModel?: string): string {
  if (!requestedModel) return "gemini-3.8-flash";
  const m = requestedModel.toLowerCase().trim();
  if (m.includes("2.0") || m.includes("flash") || m.includes("1.5-flash")) {
    return "gemini-3.8-flash";
  }
  if (m.includes("pro") || m.includes("1.5-pro")) {
    return "gemini-4-argon";
  }
  return "gemini-3.8-flash";
}

function buildTextFromSortedItems(sortedItems: any[]): string {
  let text = "";
  let lastY: number | null = null;
  let lastX = 0;
  for (const item of sortedItems) {
    if (lastY === null) {
      text += item.str;
    } else if (Math.abs(lastY - item.transform[5]) > 4) {
      text += "\n" + item.str;
    } else {
      if (item.transform[4] - lastX > 4 && !text.endsWith(" ") && !item.str.startsWith(" ")) {
        text += " ";
      }
      text += item.str;
    }
    lastY = item.transform[5];
    lastX = item.transform[4] + (item.width || 0);
  }
  return text;
}

// --------------------------------------------------------------------------
// API Endpoints
// --------------------------------------------------------------------------

// 1. Text extraction from uploaded file (PDF, DOCX, TXT, MD)
app.post("/api/extract-document", async (req: Request, res: Response) => {
  try {
    const { filename, base64 } = req.body;
    if (!filename || !base64) {
      return res.status(400).json({ error: "Missing filename or base64 data" });
    }

    const buffer = Buffer.from(base64, "base64");
    const ext = path.extname(filename).toLowerCase();
    let text = "";

    if (ext === ".pdf") {
      try {
        const parsed = await pdfParse(buffer, {
          pagerender: (pageData: any) => {
            return pageData.getTextContent({ normalizeWhitespace: true }).then((textContent: any) => {
              const items = textContent.items;
              if (!items || items.length === 0) return "";

              const xs = items.map((it: any) => it.transform[4]);
              const minX = Math.min(...xs);
              const maxX = Math.max(...xs);
              const midX = (minX + maxX) / 2;

              // Check if items cluster in two distinct columns (typical of scientific IEEE / ACM / arXiv papers)
              const leftItems = items.filter((it: any) => it.transform[4] < midX - 25);
              const rightItems = items.filter((it: any) => it.transform[4] > midX + 25);
              const isTwoCol =
                items.length > 25 &&
                leftItems.length > items.length * 0.25 &&
                rightItems.length > items.length * 0.25;

              const sortFn = (a: any, b: any) => {
                if (Math.abs(b.transform[5] - a.transform[5]) > 4) {
                  return b.transform[5] - a.transform[5];
                }
                return a.transform[4] - b.transform[4];
              };

              if (isTwoCol) {
                // Top header / title items (y > 700 or wide items spanning both columns)
                const headerItems = items.filter((it: any) => it.transform[5] > 700 || it.width > 280);
                const headerSet = new Set(headerItems);
                const bodyItems = items.filter((it: any) => !headerSet.has(it));

                const leftCol = bodyItems.filter((it: any) => it.transform[4] < midX);
                const rightCol = bodyItems.filter((it: any) => it.transform[4] >= midX);

                headerItems.sort(sortFn);
                leftCol.sort(sortFn);
                rightCol.sort(sortFn);

                return buildTextFromSortedItems([...headerItems, ...leftCol, ...rightCol]);
              }

              // Single column or standard page
              const sorted = [...items].sort(sortFn);
              return buildTextFromSortedItems(sorted);
            });
          },
        });
        text = parsed.text || "";
      } catch (err: any) {
        return res.status(422).json({ error: `Error parsing PDF: ${err.message}` });
      }
    } else if (ext === ".docx" || ext === ".doc") {
      try {
        const result = await mammoth.extractRawText({ buffer });
        text = result.value || "";
      } catch (err: any) {
        return res.status(422).json({ error: `Error parsing Word document: ${err.message}` });
      }
    } else {
      // txt, md, etc.
      try {
        text = buffer.toString("utf-8");
      } catch {
        text = buffer.toString("latin1");
      }
    }

    return res.json({
      filename,
      text: text.trim(),
    });
  } catch (error: any) {
    console.error("Extraction error:", error);
    return res.status(500).json({ error: error.message || "Failed to extract text" });
  }
});

// 2. Translation endpoint
app.post("/api/translate", async (req: Request, res: Response) => {
  try {
    const {
      text,
      filename,
      mode = "gemini",
      apiKey,
      modelName,
      batchTitles = [],
    } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Missing text for translation" });
    }

    const effectiveApiKey =
      (apiKey && apiKey.trim() && !apiKey.includes("demo_scientific_key"))
        ? apiKey.trim()
        : process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;

    const resolvedModel = resolveGeminiModel(modelName);

async function withTimeout<T>(promise: Promise<T>, ms = 15000): Promise<T> {
  let timer: any;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Timeout excedido")), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

    // Mode 1: Gemini Direct
    if (mode === "gemini" && effectiveApiKey) {
      try {
        const ai = new GoogleGenAI({ apiKey: effectiveApiKey });
        const prompt = `Eres un traductor científico experto en inglés-español.
Traduce COMPLETAMENTE el siguiente artículo científico al español, conservando:
- La estructura original (título, resumen/abstract, secciones, subsecciones).
- Terminología técnica precisa y consistente en el ámbito de la ciencia y la tecnología.
- El orden y formato exacto de la sección de Referencias/References tal como aparece en el original (NO traduzcas los títulos ni autores de las referencias, transcríbelas idénticas al original).

Devuelve ÚNICAMENTE el texto traducido, sin comentarios adicionales, sin introducciones tipo "Aquí está la traducción", y sin bloques de código markdown:

${text}`;

        const response = await withTimeout(
          ai.models.generateContent({
            model: resolvedModel,
            contents: prompt,
          }),
          15000
        );

        const translatedText = response.text?.trim();
        if (translatedText && translatedText.length > 50) {
          return res.json({
            translatedText,
            engineUsed: `Gemini (${resolvedModel})`,
          });
        }
      } catch (err: any) {
        console.warn("Gemini direct failed or quota exceeded, using resilient autonomous engine:", err.message);
      }
    }

    // Mode 2: Agentes LangChain style
    if (mode === "agent" && effectiveApiKey) {
      try {
        const ai = new GoogleGenAI({ apiKey: effectiveApiKey });
        const agentPrompt = `Actúa como un AGENTE CIENTÍFICO AUTÓNOMO especializado en procesamiento y traducción de papers académicos.
Tu tarea se compone de 3 etapas secuenciales coordinadas:
1. Analizar la jerarquía del paper (título, resumen/abstract, metodología, resultados, discusión).
2. Traducir el cuerpo al español académico de alto rigor técnico.
3. Transcribir íntegra y textualmente la sección 'REFERENCES' al final con el encabezado "### REFERENCIAS".

Títulos de otros papers en el lote actual para verificación de citas:
${batchTitles.map((t: string, i: number) => `[${i + 1}] ${t}`).join("\n")}

Documento original a procesar:
${text}

Devuelve el documento completamente traducido. Al final incluye la sección "### REFERENCIAS" con las citas originales intactas.`;

        const response = await withTimeout(
          ai.models.generateContent({
            model: resolvedModel,
            contents: agentPrompt,
          }),
          15000
        );

        const translatedText = response.text?.trim();
        if (translatedText && translatedText.length > 50) {
          return res.json({
            translatedText,
            engineUsed: `Agente Científico (${resolvedModel})`,
          });
        }
      } catch (err: any) {
        console.warn("Agent mode API failed, using autonomous engine fallback:", err.message);
      }
    }

    // Mode 3: Motor Autónomo Ultrarrápido (and fallback for Mode 1 & 2)
    const translatedText = await translateParagraphsSmart(text);
    return res.json({
      translatedText,
      engineUsed: "Motor Autónomo Ultrarrápido",
    });
  } catch (error: any) {
    console.error("Translation error:", error);
    return res.status(500).json({ error: error.message || "Translation failed" });
  }
});

// 3. Demo dataset with 5 realistic academic papers for instant testing
app.get("/api/sample-papers", (_req: Request, res: Response) => {
  const samplePapers = [
    {
      filename: "1_Attention_Is_All_You_Need_Transformer.txt",
      title: "Attention Is All You Need",
      content: `Attention Is All You Need
Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones

Abstract
The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder. The best performing models also connect the encoder and decoder through an attention mechanism. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely. Experiments on two machine translation tasks show these models to be superior in quality while being more parallelizable and requiring significantly less time to train.

Introduction
Recurrent neural networks, long short-term memory and gated recurrent neural networks in particular, have been firmly established as state of the art approaches in sequence modeling and transduction problems such as language modeling and machine translation. Numerous efforts have since continued to push the boundaries of recurrent language models and encoder-decoder architectures. Recurrent models typically factor computation along the symbol positions of the input and output sequences. Aligning the positions to steps in computation time, they generate a sequence of hidden states, as a function of the previous hidden state and the input for position.

Model Architecture
Most competitive neural sequence transduction models have an encoder-decoder structure. Here, the encoder maps an input sequence of symbol representations to a sequence of continuous representations. Given this representation, the decoder then generates an output sequence of symbols one element at a time. At each step the model is auto-regressive, consuming the previously generated symbols as additional input when generating the next. The Transformer follows this overall architecture using stacked self-attention and point-wise, fully connected layers for both the encoder and decoder.

References
[1] Dzmitry Bahdanau, Kyunghyun Cho, and Yoshua Bengio. Neural machine translation by jointly learning to align and translate. CoRR, 2014.
[2] Jacob Devlin, Ming-Wei Chang, Kenton Lee, and Kristina Toutanova. BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding. arXiv preprint arXiv:1810.04805, 2018.
[3] Tom B. Brown, Benjamin Mann, Nick Ryder, Melanie Subbiah. Language Models are Few-Shot Learners. NeurIPS 2020.
[4] Sepp Hochreiter and Jürgen Schmidhuber. Long short-term memory. Neural computation, 1997.`,
    },
    {
      filename: "2_BERT_Pretraining_Deep_Bidirectional_Transformers.txt",
      title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
      content: `BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding
Jacob Devlin, Ming-Wei Chang, Kenton Lee, Kristina Toutanova

Abstract
We introduce a new language representation model called BERT, which stands for Bidirectional Encoder Representations from Transformers. Unlike recent language representation models, BERT is designed to pre-train deep bidirectional representations from unlabeled text by jointly conditioning on both left and right context in all layers. As a result, the pre-trained BERT model can be fine-tuned with just one additional output layer to create state-of-the-art models for a wide range of tasks, such as question answering and language inference, without substantial task-specific architecture modifications.

Introduction
Language model pre-training has been shown to be effective for improving many natural language processing tasks. These include low-level tasks such as natural language inference and paraphrasing, which aim to predict the relationships between sentences by analyzing them holistically, as well as token-level tasks such as named entity recognition and question answering. There are two existing strategies for applying pre-trained language representations to downstream tasks: feature-based and fine-tuning.

Overview of BERT
There are two steps in our framework: pre-training and fine-tuning. During pre-training, the model is trained on unlabeled data over different pre-training tasks. For fine-tuning, the BERT model is first initialized with the pre-trained parameters, and all of the parameters are fine-tuned using labeled data from the downstream tasks. Each downstream task has separate fine-tuned models, even though they are initialized with the same pre-trained parameters.

References
[1] Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones. Attention Is All You Need. Advances in Neural Information Processing Systems, 2017.
[2] Alec Radford, Karthik Narasimhan, Tim Salimans, Ilya Sutskever. Improving language understanding by generative pre-training. OpenAI Report, 2018.
[3] Colin Raffel, Noam Shazeer, Adam Roberts. Exploring the Limits of Transfer Learning with a Unified Text-to-Text Transformer. JMLR, 2020.
[4] Matthew E. Peters, Mark Neumann, Mohit Iyyer. Deep contextualized word representations. NAACL 2018.`,
    },
    {
      filename: "3_Language_Models_Are_Few_Shot_Learners_GPT3.txt",
      title: "Language Models are Few-Shot Learners",
      content: `Language Models are Few-Shot Learners
Tom B. Brown, Benjamin Mann, Nick Ryder, Melanie Subbiah, Jared Kaplan

Abstract
Recent work has demonstrated substantial gains on many NLP tasks and benchmarks by pre-training on a large corpus of text followed by fine-tuning on a specific task. While typically task-agnostic in architecture, this method still requires task-specific fine-tuning datasets of thousands or tens of thousands of examples. In contrast, humans can generally perform a new language task from only a few examples or from simple instructions. Here we show that scaling up language models greatly improves task-agnostic, few-shot performance, sometimes even reaching competitiveness with prior state-of-the-art fine-tuning approaches.

Introduction
The trend in natural language processing over the last few years has been the development of increasingly expressive language models, pre-trained on diverse web text. These models are then either fine-tuned on supervised datasets or prompted directly. In this work, we test the hypothesis that scaling up language models greatly improves few-shot performance and across a broad spectrum of benchmarks. We train GPT-3, an autoregressive language model with 175 billion parameters.

Evaluation and Findings
For each task, we evaluate GPT-3 under 3 conditions: few-shot learning, one-shot learning, and zero-shot learning. On many benchmarks, GPT-3 achieves strong performance without any fine-tuning. We find that few-shot performance improves smoothly with model scale, showing power-law trends across parameters, dataset size, and compute.

References
[1] Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones. Attention Is All You Need. NeurIPS, 2017.
[2] Jacob Devlin, Ming-Wei Chang, Kenton Lee, and Kristina Toutanova. BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding. arXiv preprint arXiv:1810.04805, 2018.
[3] Colin Raffel, Noam Shazeer, Adam Roberts. Exploring the Limits of Transfer Learning with a Unified Text-to-Text Transformer. JMLR, 2020.
[4] Dario Amodei, Chris Olah, Jacob Steinhardt. Concrete Problems in AI Safety. arXiv:1606.06565, 2016.`,
    },
    {
      filename: "4_Exploring_Limits_Transfer_Learning_T5.txt",
      title: "Exploring the Limits of Transfer Learning with a Unified Text-to-Text Transformer",
      content: `Exploring the Limits of Transfer Learning with a Unified Text-to-Text Transformer
Colin Raffel, Noam Shazeer, Adam Roberts, Katherine Lee, Sharan Narang

Abstract
Transfer learning, where a model is first pre-trained on a data-rich task before being fine-tuned on a downstream task, has emerged as a powerful technique in natural language processing (NLP). The effectiveness of transfer learning has given rise to a diversity of approaches, tools, and benchmarks. In this paper, we explore the landscape of transfer learning techniques for NLP by introducing a unified framework that treats every text processing problem as a "text-to-text" problem.

Introduction
Deep learning models trained on large text corpora have driven significant advances across various natural language understanding tasks. By casting all text processing problems into a unified text-to-text format, our framework allows us to directly apply the same model, objective, training procedure, and decoding process to every task. We systematically evaluate various pre-training objectives, architectures, unlabeled datasets, transfer approaches, and scaling factors.

Architecture and Results
Our model uses a standard encoder-decoder Transformer structure. We evaluate it on benchmarks including GLUE, SuperGLUE, translation, and summarization tasks. By combining our systematic findings with scale, we achieve state-of-the-art results across many demanding benchmarks.

References
[1] Ashish Vaswani, Noam Shazeer, Niki Parmar, Jakob Uszkoreit, Llion Jones. Attention Is All You Need. NIPS 2017.
[2] Jacob Devlin, Ming-Wei Chang, Kenton Lee, Kristina Toutanova. BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding. NAACL 2019.
[3] Tom B. Brown, Benjamin Mann, Nick Ryder, Melanie Subbiah. Language Models are Few-Shot Learners. NeurIPS 2020.
[4] Alex Krizhevsky, Ilya Sutskever, Geoffrey E. Hinton. ImageNet classification with deep convolutional neural networks. NIPS 2012.`,
    },
    {
      filename: "5_Deep_Residual_Learning_ResNet.txt",
      title: "Deep Residual Learning for Image Recognition",
      content: `Deep Residual Learning for Image Recognition
Kaiming He, Xiangyu Zhang, Shaoqing Ren, Jian Sun

Abstract
Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously. We explicitly reformulate the layers as learning residual functions with reference to the layer inputs, instead of learning unreferenced functions. We provide comprehensive empirical evidence showing that these networks are easier to optimize, and can gain accuracy from considerably increased depth.

Introduction
Deep convolutional neural networks have led to a series of breakthroughs for image classification. When deeper networks are able to start converging, a degradation problem has been exposed: with the network depth increasing, accuracy gets saturated and then degrades rapidly. Unexpectedly, such degradation is not caused by overfitting, and adding more layers to a suitably deep model leads to higher training error.

Residual Learning Framework
Instead of hoping each few stacked layers directly fit a desired underlying mapping, we explicitly let these layers fit a residual mapping. Formally, denoting the desired underlying mapping as H(x), we let the stacked nonlinear layers fit another mapping of F(x) := H(x) - x. The original mapping is recast into F(x) + x. We hypothesize that it is easier to optimize the residual mapping than to optimize the original, unreferenced mapping.

References
[1] Alex Krizhevsky, Ilya Sutskever, Geoffrey E. Hinton. ImageNet classification with deep convolutional neural networks. NIPS 2012.
[2] Yann LeCun, Leon Bottou, Yoshua Bengio, Patrick Haffner. Gradient-based learning applied to document recognition. Proceedings of the IEEE, 1998.
[3] Karen Simonyan, Andrew Zisserman. Very deep convolutional networks for large-scale image recognition. ICLR 2015.
[4] Christian Szegedy, Wei Liu, Yangqing Jia. Going deeper with convolutions. CVPR 2015.`,
    },
  ];

  res.json(samplePapers);
});

// Setup Vite or static serving
async function startServer() {
  const isProduction = process.env.NODE_ENV === "production";

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, "dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
