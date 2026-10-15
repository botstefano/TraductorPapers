import JSZip from "jszip";
import { buildTranslatedDocxBlob } from "./docxExport";
import type { DocumentResult } from "./textProcessing";

export async function buildBatchZip(documents: DocumentResult[]): Promise<Blob> {
  const zip = new JSZip();

  for (const doc of documents) {
    const baseName = doc.filename.replace(/\.[^/.]+$/, "") + "_ES";
    const docxBlob = await buildTranslatedDocxBlob(doc.filename, doc.translatedText, doc.references);
    zip.file(`${baseName}.docx`, docxBlob);
    zip.file(`${baseName}.txt`, doc.translatedText);
  }

  return await zip.generateAsync({ type: "blob" });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  downloadBlob(blob, filename);
}
