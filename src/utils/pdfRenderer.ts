import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export interface RenderedPdfResult {
  pageCount: number;
  pageImages: string[];
}

export async function getPdfPageCountFromFile(file: File): Promise<number | null> {
  try {
    const buffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}

export async function renderPdfFromUrl(url: string): Promise<RenderedPdfResult> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Could not load PDF file (HTTP ${res.status}).`);
  }
  const buffer = await res.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;
  const pageImages: string[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.9 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) continue;

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    // Paint solid white background so transparent PDFs print crisply as JPEG
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: context,
      viewport,
      canvas,
    }).promise;

    pageImages.push(canvas.toDataURL('image/jpeg', 0.92));
  }

  return {
    pageCount: pdf.numPages,
    pageImages,
  };
}
