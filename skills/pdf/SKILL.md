---
name: pdf
description: Process PDF files - extract text, create PDFs, merge documents. Use when user asks to read PDF, create PDF, or work with PDF files.
---

# PDF Processing Skill

You now have expertise in PDF manipulation. Follow these workflows:

## Reading PDFs

**Option 1: Quick text extraction (preferred)**
```bash
# Using pdftotext (poppler-utils)
pdftotext input.pdf -  # Output to stdout
pdftotext input.pdf output.txt  # Output to file

# If pdftotext not available, try:
npx tsx -e "import { readFile } from 'node:fs/promises'; import pdf from 'pdf-parse'; const data = await pdf(await readFile('input.pdf')); console.log(data.text);"
```

**Option 2: Page-by-page with metadata**
```typescript
import { readFile } from "node:fs/promises";
import pdf from "pdf-parse";

const data = await pdf(await readFile("input.pdf"));
console.log(`Pages: ${data.numpages}`);
console.log(`Metadata: ${JSON.stringify(data.info)}`);
console.log(data.text);
```

## Creating PDFs

**Option 1: From Markdown (recommended)**
```bash
# Using pandoc
pandoc input.md -o output.pdf

# With custom styling
pandoc input.md -o output.pdf --pdf-engine=xelatex -V geometry:margin=1in
```

**Option 2: Programmatically**
```typescript
import { writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";

const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText("Hello, PDF!", { x: 100, y: 750, size: 12, font });
await writeFile("output.pdf", await doc.save());
```

**Option 3: From HTML**
```bash
# Using wkhtmltopdf
wkhtmltopdf input.html output.pdf

# Or with Playwright
npx playwright pdf input.html output.pdf
```

## Merging PDFs

```typescript
import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";

const merged = await PDFDocument.create();
for (const path of ["file1.pdf", "file2.pdf", "file3.pdf"]) {
  const source = await PDFDocument.load(await readFile(path));
  const pages = await merged.copyPages(source, source.getPageIndices());
  pages.forEach((page) => merged.addPage(page));
}
await writeFile("merged.pdf", await merged.save());
```

## Splitting PDFs

```typescript
import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";

const source = await PDFDocument.load(await readFile("input.pdf"));
for (const index of source.getPageIndices()) {
  const single = await PDFDocument.create();
  const [page] = await single.copyPages(source, [index]);
  single.addPage(page);
  await writeFile(`page_${index + 1}.pdf`, await single.save());
}
```

## Key Libraries

| Task | Library | Install |
|------|---------|---------|
| Read text | pdf-parse | `npm install pdf-parse` |
| Read/Write/Merge | pdf-lib | `npm install pdf-lib` |
| HTML to PDF | Playwright or wkhtmltopdf | `npm install playwright` / `brew install wkhtmltopdf` |
| Text extraction | pdftotext | `brew install poppler` / `apt install poppler-utils` |

## Best Practices

1. **Always check if tools are installed** before using them
2. **Handle encoding issues** - PDFs may contain various character encodings
3. **Large PDFs**: Process page by page to avoid memory issues
4. **OCR for scanned PDFs**: Use `ocrmypdf` or `tesseract` if text extraction returns empty
