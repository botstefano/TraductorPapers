import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import type { ReferenceMatch } from "./textProcessing";

const COLOR_MATCHED = "1B8A3B";   // Green: reference with translated source in batch
const COLOR_UNMATCHED = "1F3D7A"; // Dark blue: reference without match in batch
const COLOR_TITLE = "000000";

export async function buildTranslatedDocxBlob(
  originalFilename: string,
  translatedBody: string,
  referenceMatches: ReferenceMatch[]
): Promise<Blob> {
  const children: Paragraph[] = [];

  // Title: "Traducción: {originalFilename}"
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [
        new TextRun({
          text: `Traducción: ${originalFilename}`,
          bold: true,
          color: COLOR_TITLE,
          size: 32, // 16pt
        }),
      ],
      spacing: { after: 240 },
    })
  );

  // Section: Cuerpo del artículo (traducido)
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [
        new TextRun({
          text: "Cuerpo del artículo (traducido)",
          bold: true,
          color: "2B2D42",
          size: 26, // 13pt
        }),
      ],
      spacing: { before: 200, after: 120 },
    })
  );

  // Paragraphs of translated body
  const bodyParagraphs = translatedBody.split("\n");
  for (const para of bodyParagraphs) {
    const trimmed = para.trim();
    if (trimmed) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: trimmed,
              size: 22, // 11pt
            }),
          ],
          spacing: { after: 140, line: 276 },
        })
      );
    }
  }

  // Section: Referencias (cruce con fuentes traducidas)
  if (referenceMatches && referenceMatches.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [
          new TextRun({
            text: "Referencias (cruce con fuentes traducidas)",
            bold: true,
            color: "2B2D42",
            size: 26,
          }),
        ],
        spacing: { before: 300, after: 120 },
      })
    );

    // Legend
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Leyenda: ", bold: true }),
          new TextRun({
            text: "verde = referencia con fuente también traducida en este lote",
            color: COLOR_MATCHED,
            bold: true,
          }),
          new TextRun({ text: "   |   " }),
          new TextRun({
            text: "azul = referencia sin cruce en el lote",
            color: COLOR_UNMATCHED,
            bold: true,
          }),
        ],
        spacing: { after: 180 },
      })
    );

    // Individual references
    for (const match of referenceMatches) {
      const runs = [
        new TextRun({
          text: match.referenceText,
          color: match.isTranslatedSource ? COLOR_MATCHED : COLOR_UNMATCHED,
          size: 20, // 10pt
        }),
      ];

      if (match.isTranslatedSource && match.matchedSourceTitle) {
        runs.push(
          new TextRun({
            text: `  [coincide con: ${match.matchedSourceTitle} | similitud ${match.similarity}%]`,
            italics: true,
            size: 18, // 9pt
            color: COLOR_MATCHED,
          })
        );
      }

      children.push(
        new Paragraph({
          children: runs,
          spacing: { after: 100 },
        })
      );
    }
  }

  const doc = new Document({
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  return await Packer.toBlob(doc);
}
