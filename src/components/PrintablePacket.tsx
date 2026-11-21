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
  const pagesPerCopy = hasPdfPages ? pdfPageImages.length : Math.max(1, submission.pageCount || 1);

  // Keep DOM print payload fast and crash-free: collate up to 10 copies when total pages <= 24,
  // otherwise render 1 clean master copy and let the OS print dialog handle the full copy count.
  const requested = Math.max(1, copies);
  const repeatCount =
    requested <= 10 && requested * pagesPerCopy <= 24 ? requested : 1;
  const indices = Array.from({ length: repeatCount }, (_, i) => i);

  const pageSizeCss =
    submission.paperSize === 'Letter'
      ? 'letter'
      : submission.paperSize === 'Legal'
        ? 'legal'
        : 'A4';

  return (
    <div className="print-only bg-white text-black">
      <style>{`@media print { @page { size: ${pageSizeCss}; margin: 0 !important; } }`}</style>
      {indices.map((copyIdx) => (
        <div key={copyIdx}>
          {hasPdfPages ? (
            pdfPageImages.map((src, pageIdx) => (
              <div
                key={`${copyIdx}-${pageIdx}`}
                className={`print-pdf-page ${
                  copyIdx < repeatCount - 1 || pageIdx < pdfPageImages.length - 1
                    ? 'print-page-break'
                    : ''
                }`}
              >
                <img src={src} alt={`${submission.title} page ${pageIdx + 1}`} />
              </div>
            ))
          ) : (
            <div className={copyIdx < repeatCount - 1 ? 'print-page-break' : ''}>
              {isImage && submission.fileUrl ? (
                <div className="print-pdf-page">
                  <img src={apiUrl(submission.fileUrl)} alt={submission.title} />
                </div>
              ) : (
                <table className="print-margin-table">
                  <thead className="print-margin-head">
                    <tr>
                      <td />
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="print-margin-body">
                        {submission.renderedHtml ? (
                          <div
                            className="print-doc-content"
                            dangerouslySetInnerHTML={{ __html: submission.renderedHtml }}
                          />
                        ) : (
                          <div className="print-doc-content">
                            <h1>{submission.title}</h1>
                            {submission.fileName && <p>{submission.fileName}</p>}
                          </div>
                        )}
                      </td>
                    </tr>
                  </tbody>
                  <tfoot className="print-margin-foot">
                    <tr>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
