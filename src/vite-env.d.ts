/// <reference types="vite/client" />

declare module 'mammoth/mammoth.browser.min.js' {
  const mammothBrowser: {
    convertToHtml: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
  };
  export default mammothBrowser;
  export const convertToHtml: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
}
