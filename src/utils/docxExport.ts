import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  BorderStyle,
  WidthType,
  Header,
  Footer,
  PageNumber,
  ShadingType,
} from "docx";
import type { ReferenceMatch } from "./textProcessing";

const COLOR_MATCHED = "15803D";    // Emerald/Green for cross-referenced citation
const COLOR_UNMATCHED = "1D4ED8";  // Blue for uncrossed citation
const COLOR_HEADING = "0F172A";    // Slate 900
const COLOR_TEXT = "1E293B";       // Slate 800
const COLOR_MUTED = "64748B";      // Slate 500

const ACADEMIC_FONT = "Times New Roman";

interface DocxOptions {
  paperTitle?: string;
}

export async function buildTranslatedDocxBlob(
  originalFilename: string,
  translatedBody: string,
  referenceMatches: ReferenceMatch[],
  options?: DocxOptions
): Promise<Blob> {
  const children: (Paragraph | Table)[] = [];

  // Extract clean title: prefer options.paperTitle or extract first non-empty line
  let title = options?.paperTitle;
  const lines = translatedBody.split("\n").map((l) => l.trim()).filter(Boolean);

  if (!title) {
    if (lines.length > 0 && lines[0].length < 180 && !lines[0].toLowerCase().startsWith("resumen")) {
      title = lines[0];
    } else {
      title = originalFilename
        .replace(/\.[^/.]+$/, "")
        .replace(/[_-]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  // 1. PAPER TITLE (Centered, 18pt, Bold, Academic Slate)
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: title,
          bold: true,
          font: ACADEMIC_FONT,
          size: 36, // 18pt
          color: COLOR_HEADING,
        }),
      ],
      spacing: { before: 200, after: 120 },
    })
  );

  // 2. SUBTITLE & METADATA BANNER
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "[Traducción Científica Especializada (EN → ES)]",
          italics: true,
          font: ACADEMIC_FONT,
          size: 20, // 10pt
          color: COLOR_MUTED,
        }),
      ],
      spacing: { after: 60 },
    })
  );

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `Documento fuente original: `,
          font: ACADEMIC_FONT,
          size: 18, // 9pt
          color: COLOR_MUTED,
        }),
        new TextRun({
          text: originalFilename,
          bold: true,
          font: ACADEMIC_FONT,
          size: 18,
          color: "334155",
        }),
        new TextRun({
          text: `   |   Formato: Paper Científico Revisado`,
          font: ACADEMIC_FONT,
          size: 18,
          color: COLOR_MUTED,
        }),
      ],
      spacing: { after: 240 },
      border: {
        bottom: {
          style: BorderStyle.SINGLE,
          size: 6,
          color: "CBD5E1",
        },
      },
    })
  );

  // 3. PARSE SECTIONS AND ABSTRACT
  let inAbstract = false;
  const abstractParagraphs: string[] = [];
  const regularParagraphs: { text: string; isHeading: boolean; headingLevel: number }[] = [];

  const rawParagraphs = translatedBody.split("\n");

  for (let i = 0; i < rawParagraphs.length; i++) {
    const rawLine = rawParagraphs[i].trim();
    if (!rawLine) continue;

    // Skip the title if it was repeated on line 0
    if (i === 0 && rawLine === title) continue;

    const lower = rawLine.toLowerCase();

    // Check if entering abstract
    if (
      lower === "resumen" ||
      lower === "abstract" ||
      lower.startsWith("resumen:") ||
      lower.startsWith("abstract:") ||
      lower === "resumen (abstract)"
    ) {
      inAbstract = true;
      const content = rawLine.replace(/^(?:resumen|abstract)[:\s-]*/i, "").trim();
      if (content) abstractParagraphs.push(content);
      continue;
    }

    // Check if heading of next section exits abstract
    const headingMatch = rawLine.match(/^(?:(\d{1,2}(?:\.\d{1,2})*)\s+)?([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑ\s]{2,50})$/);
    const isSectionStart =
      lower.startsWith("1.") ||
      lower.startsWith("introducción") ||
      lower.startsWith("introduccion") ||
      lower.startsWith("1. introducción") ||
      lower.startsWith("2.") ||
      lower.startsWith("3.") ||
      lower.startsWith("conclusión") ||
      lower.startsWith("conclusiones") ||
      lower.startsWith("metodología") ||
      lower.startsWith("resultados") ||
      lower.startsWith("discusión");

    if (inAbstract && (isSectionStart || (headingMatch && headingMatch[2].length < 35))) {
      inAbstract = false;
    }

    if (inAbstract) {
      abstractParagraphs.push(rawLine);
      continue;
    }

    // Determine if line is a section heading
    if (
      isSectionStart ||
      (headingMatch && rawLine.length < 50 && !rawLine.endsWith(".")) ||
      (rawLine.startsWith("#") && rawLine.length < 60)
    ) {
      const cleanHeading = rawLine.replace(/^#+\s*/, "").trim();
      const isSub = cleanHeading.includes(".") && cleanHeading.split(".")[1]?.trim()?.length > 0;
      regularParagraphs.push({
        text: cleanHeading,
        isHeading: true,
        headingLevel: isSub ? 2 : 1,
      });
    } else {
      regularParagraphs.push({
        text: rawLine,
        isHeading: false,
        headingLevel: 0,
      });
    }
  }

  // RENDER ABSTRACT (If present, in a clean, shaded callout box)
  if (abstractParagraphs.length > 0) {
    const abstractCells = [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: "RESUMEN / ABSTRACT",
            bold: true,
            font: ACADEMIC_FONT,
            size: 21, // 10.5pt
            color: COLOR_HEADING,
          }),
        ],
        spacing: { before: 80, after: 100 },
      }),
      ...abstractParagraphs.map(
        (p) =>
          new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            children: [
              new TextRun({
                text: p,
                italics: true,
                font: ACADEMIC_FONT,
                size: 20, // 10pt
                color: COLOR_TEXT,
              }),
            ],
            spacing: { after: 80, line: 260 },
          })
      ),
    ];

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [
              new TableCell({
                children: abstractCells,
                shading: {
                  type: ShadingType.CLEAR,
                  fill: "F8FAFC", // Slate-50 background
                },
                borders: {
                  top: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
                  bottom: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
                  left: { style: BorderStyle.SINGLE, size: 16, color: "3B82F6" }, // Blue accent line
                  right: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
                },
                margins: {
                  top: 140,
                  bottom: 140,
                  left: 200,
                  right: 200,
                },
              }),
            ],
          }),
        ],
      })
    );

    children.push(new Paragraph({ spacing: { after: 180 } }));
  }

  // RENDER BODY PARAGRAPHS WITH ACADEMIC FORMATTING
  for (const item of regularParagraphs) {
    if (item.isHeading) {
      if (item.headingLevel === 1) {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [
              new TextRun({
                text: item.text.toUpperCase(),
                bold: true,
                font: ACADEMIC_FONT,
                size: 24, // 12pt
                color: COLOR_HEADING,
              }),
            ],
            spacing: { before: 260, after: 100 },
            border: {
              bottom: { style: BorderStyle.SINGLE, size: 4, color: "E2E8F0" },
            },
          })
        );
      } else {
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_3,
            children: [
              new TextRun({
                text: item.text,
                bold: true,
                font: ACADEMIC_FONT,
                size: 22, // 11pt
                color: "334155",
              }),
            ],
            spacing: { before: 180, after: 80 },
          })
        );
      }
    } else {
      children.push(
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          children: [
            new TextRun({
              text: item.text,
              font: ACADEMIC_FONT,
              size: 21, // 10.5pt standard scientific body font
              color: COLOR_TEXT,
            }),
          ],
          indent: { firstLine: 360 }, // 0.25 inch first-line indent
          spacing: { after: 120, line: 276 }, // 1.15 line spacing
        })
      );
    }
  }

  // 4. ACADEMIC REFERENCES SECTION WITH LEGEND AND HANGING INDENTS
  if (referenceMatches && referenceMatches.length > 0) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [
          new TextRun({
            text: "REFERENCIAS BIBLIOGRÁFICAS (CRUCE DE CITAS)",
            bold: true,
            font: ACADEMIC_FONT,
            size: 24, // 12pt
            color: COLOR_HEADING,
          }),
        ],
        spacing: { before: 340, after: 120 },
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 6, color: "CBD5E1" },
        },
      })
    );

    // Legend banner in clean callout table
    const matchedCount = referenceMatches.filter((m) => m.isTranslatedSource).length;
    const unmatchedCount = referenceMatches.length - matchedCount;

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [
              new TableCell({
                shading: { type: ShadingType.CLEAR, fill: "F1F5F9" },
                borders: {
                  top: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
                  bottom: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
                  left: { style: BorderStyle.SINGLE, size: 12, color: "10B981" },
                  right: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
                },
                margins: { top: 100, bottom: 100, left: 160, right: 160 },
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: "Leyenda del Cruce Bibliográfico: ",
                        bold: true,
                        font: ACADEMIC_FONT,
                        size: 19,
                      }),
                      new TextRun({
                        text: `🟢 VERDE (${matchedCount})`,
                        bold: true,
                        color: COLOR_MATCHED,
                        font: ACADEMIC_FONT,
                        size: 19,
                      }),
                      new TextRun({
                        text: " = Cita cruzada con otra fuente traducida en este lote.   |   ",
                        font: ACADEMIC_FONT,
                        size: 19,
                        color: "475569",
                      }),
                      new TextRun({
                        text: `🔵 AZUL (${unmatchedCount})`,
                        bold: true,
                        color: COLOR_UNMATCHED,
                        font: ACADEMIC_FONT,
                        size: 19,
                      }),
                      new TextRun({
                        text: " = Referencia externa sin cruce en el lote.",
                        font: ACADEMIC_FONT,
                        size: 19,
                        color: "475569",
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      })
    );

    children.push(new Paragraph({ spacing: { after: 140 } }));

    // Each reference formatted with Academic Hanging Indent (0.35 in)
    for (const match of referenceMatches) {
      const runs = [
        new TextRun({
          text: match.referenceText,
          font: ACADEMIC_FONT,
          color: match.isTranslatedSource ? COLOR_MATCHED : COLOR_UNMATCHED,
          size: 19, // 9.5pt academic citation font
          bold: match.isTranslatedSource,
        }),
      ];

      if (match.isTranslatedSource && match.matchedSourceTitle) {
        runs.push(
          new TextRun({
            text: `  [✓ Coincide con: "${match.matchedSourceTitle}" — Similitud: ${match.similarity}%]`,
            italics: true,
            bold: true,
            size: 17, // 8.5pt
            color: "166534",
            font: ACADEMIC_FONT,
          })
        );
      }

      children.push(
        new Paragraph({
          alignment: AlignmentType.JUSTIFIED,
          indent: {
            left: 500, // 0.35 inch left indent
            hanging: 500, // hanging indent for citation numbers/authors
          },
          children: runs,
          spacing: { after: 100, line: 240 },
        })
      );
    }
  }

  // BUILD COMPLETE DOCUMENT WITH MARGINS, HEADER & FOOTER
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440,    // 1 inch
              bottom: 1440, // 1 inch
              left: 1440,   // 1 inch
              right: 1440,  // 1 inch
            },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: `Traducción Académica Certificada (EN → ES) — ${title.slice(0, 50)}...`,
                    font: ACADEMIC_FONT,
                    size: 16, // 8pt
                    color: "94A3B8",
                  }),
                ],
                spacing: { after: 120 },
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    text: "Página ",
                    font: ACADEMIC_FONT,
                    size: 18,
                    color: "94A3B8",
                  }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: ACADEMIC_FONT,
                    size: 18,
                    color: "94A3B8",
                  }),
                  new TextRun({
                    text: " de ",
                    font: ACADEMIC_FONT,
                    size: 18,
                    color: "94A3B8",
                  }),
                  new TextRun({
                    children: [PageNumber.TOTAL_PAGES],
                    font: ACADEMIC_FONT,
                    size: 18,
                    color: "94A3B8",
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return await Packer.toBlob(doc);
}
