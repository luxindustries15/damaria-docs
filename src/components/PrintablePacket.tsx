import type { ExamSubmission } from '../types';
import { apiUrl } from '../utils/api';

interface PrintablePacketProps {
  submission: ExamSubmission | null;
  copies?: number;
  pdfPageImages?: string[];
}

export function PrintablePacket({
  submission,
  copies = 1,
  pdfPageImages = [],
}: PrintablePacketProps) {
  if (!submission) return null;

  const isImage = submission.fileMime?.startsWith('image/') && submission.fileUrl;
  const hasPdfPages = pdfPageImages.length > 0;
  const repeatCount = Math.min(Math.max(1, copies), 25);
  const indices = Array.from({ length: repeatCount }, (_, i) => i);

  return (
    <div className="print-only bg-white text-black font-serif">
      {indices.map((copyIdx) => (
        <div key={copyIdx}>
          {hasPdfPages ? (
            pdfPageImages.map((src, pageIdx) => (
              <div
                key={`${copyIdx}-${pageIdx}`}
                className={
                  copyIdx < repeatCount - 1 || pageIdx < pdfPageImages.length - 1
                    ? 'print-page-break'
                    : ''
                }
              >
                <img src={src} alt={`${submission.title} page ${pageIdx + 1}`} className="w-full h-auto" />
              </div>
            ))
          ) : (
            <div className={`p-8 ${copyIdx < repeatCount - 1 ? 'print-page-break' : ''}`}>
              {isImage && submission.fileUrl ? (
                <img
                  src={apiUrl(submission.fileUrl)}
                  alt={submission.title}
                  className="max-w-full h-auto mx-auto"
                />
              ) : submission.renderedHtml ? (
                <div
                  className="prose max-w-none text-black leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: submission.renderedHtml }}
                />
              ) : (
                <div className="space-y-3">
                  <h1 className="text-xl font-bold">{submission.title}</h1>
                  <p className="text-sm">Sent by: {submission.senderName}</p>
                  {submission.fileName && <p className="text-sm">File: {submission.fileName}</p>}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
