import {
  MAMMOTH_STYLE_MAP,
  parseWordDocumentBytes,
  type ParsedDocumentResult,
} from './docParser';

interface MammothOptions {
  styleMap?: string[];
}

export async function convertDocxInBrowser(arrayBuffer: ArrayBuffer): Promise<string | null> {
  try {
    const mod = (await import('mammoth/mammoth.browser.min.js')) as unknown as {
      convertToHtml?: (
        input: { arrayBuffer: ArrayBuffer },
        options?: MammothOptions
      ) => Promise<{ value: string }>;
      default?: {
        convertToHtml?: (
          input: { arrayBuffer: ArrayBuffer },
          options?: MammothOptions
        ) => Promise<{ value: string }>;
      };
    };
    const globalMammoth = (
      window as unknown as {
        mammoth?: {
          convertToHtml?: (
            input: { arrayBuffer: ArrayBuffer },
            options?: MammothOptions
          ) => Promise<{ value: string }>;
        };
      }
    ).mammoth;

    const convertToHtml =
      mod?.convertToHtml || mod?.default?.convertToHtml || globalMammoth?.convertToHtml;
    if (!convertToHtml) return null;
    const res = await convertToHtml({ arrayBuffer }, { styleMap: MAMMOTH_STYLE_MAP });
    return res.value || null;
  } catch {
    return null;
  }
}

export async function parseWordFileInBrowser(
  bytes: Uint8Array,
  fileName: string
): Promise<ParsedDocumentResult> {
  return parseWordDocumentBytes(bytes, fileName, async (rawBytes) => {
    const copy = new Uint8Array(rawBytes.byteLength);
    copy.set(rawBytes);
    return convertDocxInBrowser(copy.buffer);
  });
}
