import { useMemo, useState, type DragEvent, type FormEvent } from 'react';
import {
  CheckCircle2,
  FileText,
  FileUp,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Send,
  X,
} from 'lucide-react';
import type { ExamSubmission, PaperSize } from '../types';
import schoolLogo from '../assets/images/damaria_school_logo_rounded.png';
import { submitDocument, type BackendMode } from '../utils/apiClient';
import { formatBytes, formatTimeAgo } from '../utils/format';
import { getPdfPageCountFromFile } from '../utils/pdfRenderer';
import { SubmissionStatusLabel } from './StatusBadge';

interface TeacherPortalProps {
  submissions: ExamSubmission[];
  publicDomain?: string;
  liveAppUrl?: string;
  backendMode?: BackendMode;
  onSubmitted: () => void;
  onRefresh: () => void;
}

export function TeacherPortal({
  submissions,
  onSubmitted,
  onRefresh,
}: TeacherPortalProps) {
  const [senderName, setSenderName] = useState('');
  const [title, setTitle] = useState('');
  const [requestedCopies, setRequestedCopies] = useState('');
  const [detectedPageCount, setDetectedPageCount] = useState<number | null>(null);
  const [paperSize, setPaperSize] = useState<PaperSize | ''>('');
  const [duplex, setDuplex] = useState<boolean | null>(null);
  const [colorMode, setColorMode] = useState<'bw' | 'color' | null>(null);
  const [staple, setStaple] = useState(false);
  const [notes, setNotes] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Queue filter state
  const [queueSearch, setQueueSearch] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);

  async function handleFilePicked(file: File | null) {
    setSelectedFile(file);
    setDetectedPageCount(null);
    setFeedback(null);
    if (file && !title.trim()) {
      setTitle(file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
    }
    if (file && file.name.toLowerCase().endsWith('.pdf')) {
      const detectedPages = await getPdfPageCountFromFile(file);
      if (detectedPages) setDetectedPageCount(detectedPages);
    }
  }

  function handleDrop(e: DragEvent<HTMLLabelElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0] || null;
    if (file) handleFilePicked(file);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!senderName.trim()) {
      setFeedback({ type: 'err', text: 'Please enter your name before sending.' });
      return;
    }
    if (!selectedFile) {
      setFeedback({ type: 'err', text: 'Please choose a PDF or Word file to send.' });
      return;
    }
    const copiesNum = Number(requestedCopies);
    if (!requestedCopies.trim() || !Number.isFinite(copiesNum) || copiesNum < 1) {
      setFeedback({ type: 'err', text: 'Please enter the number of copies needed.' });
      return;
    }
    if (!paperSize) {
      setFeedback({ type: 'err', text: 'Please select a paper size.' });
      return;
    }
    if (duplex === null) {
      setFeedback({ type: 'err', text: 'Please select print sides.' });
      return;
    }
    if (colorMode === null) {
      setFeedback({ type: 'err', text: 'Please select an ink mode.' });
      return;
    }

    setSubmitting(true);
    setFeedback(null);
    try {
      const formData = new FormData();
      formData.append('senderName', senderName.trim());
      formData.append('title', title.trim());
      formData.append('requestedCopies', String(Math.floor(copiesNum)));
      if (detectedPageCount) {
        formData.append('pageCount', String(detectedPageCount));
      }
      formData.append('paperSize', paperSize);
      formData.append('duplex', String(duplex));
      formData.append('colorMode', colorMode);
      formData.append('staple', String(staple));
      formData.append('notes', notes);
      formData.append('documentFile', selectedFile);

      const data = await submitDocument(formData);

      setTitle('');
      setNotes('');
      setSelectedFile(null);
      setDetectedPageCount(null);
      setRequestedCopies('');
      setPaperSize('');
      setDuplex(null);
      setColorMode(null);
      setStaple(false);
      setFeedback({
        type: 'ok',
        text: `Sent "${data.title}" (${data.requestedCopies} copies) to the Damaria Docs Print Desk.`,
      });
      onSubmitted();
    } catch (err) {
      setFeedback({ type: 'err', text: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  const visibleSent = useMemo(() => {
    return submissions.filter((s) => {
      if (onlyMine && senderName.trim()) {
        if (!s.senderName.toLowerCase().includes(senderName.trim().toLowerCase())) {
          return false;
        }
      }
      if (queueSearch.trim()) {
        const q = queueSearch.toLowerCase();
        return (
          s.title.toLowerCase().includes(q) ||
          s.senderName.toLowerCase().includes(q) ||
          (s.fileName || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [submissions, onlyMine, senderName, queueSearch]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Left: Send PDF / Word Document Form */}
      <form
        onSubmit={handleSubmit}
        className="lg:col-span-7 glass-panel rounded-2xl p-6 sm:p-7 space-y-6"
      >
        <div className="border-b border-white/10 pb-4 flex items-center gap-4">
          {logoFailed ? (
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-[#060a13] border border-white/15 flex items-center justify-center text-sky-400 shrink-0">
              <FileText className="w-7 h-7" />
            </div>
          ) : (
            <img
              src={schoolLogo}
              alt="Damaria Pre & Primary School — Education For Caring and Compassionate"
              referrerPolicy="no-referrer"
              onError={() => setLogoFailed(true)}
              className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl object-contain shrink-0"
            />
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-white text-balance">
              Send a Document for Printing
            </h1>
            <p className="text-sm text-slate-300 mt-1">
              Attach a PDF or Word file, set your required copies, and send it straight to the Print
              Desk.
            </p>
          </div>
        </div>

        {/* Sender & Title */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="sender-name" className="block text-xs font-medium text-slate-300 mb-1.5">
              Your Name
            </label>
            <input
              id="sender-name"
              type="text"
              required
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              placeholder="Enter your name"
              className="glass-input w-full rounded-xl px-4 py-2.5 text-sm"
            />
          </div>

          <div>
            <label htmlFor="doc-title" className="block text-xs font-medium text-slate-300 mb-1.5">
              Document Title
            </label>
            <input
              id="doc-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Document title"
              className="glass-input w-full rounded-xl px-4 py-2.5 text-sm"
            />
          </div>
        </div>

        {/* File Dropzone */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="block text-xs font-medium text-slate-300">
              Document File (.pdf, .docx, .doc)
            </label>
            {selectedFile && (
              <button
                type="button"
                onClick={() => {
                  setSelectedFile(null);
                  setDetectedPageCount(null);
                }}
                className="text-xs text-slate-400 hover:text-white inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0"
              >
                <X className="w-3.5 h-3.5" />
                Remove file
              </button>
            )}
          </div>

          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            className={`flex flex-col items-center justify-center text-center rounded-2xl border border-dashed px-6 py-8 cursor-pointer transition-colors ${
              dragActive
                ? 'border-sky-400 bg-sky-500/12'
                : selectedFile
                  ? 'border-emerald-400/45 bg-emerald-500/[0.06] hover:bg-emerald-500/[0.09]'
                  : 'border-white/20 bg-white/[0.025] hover:bg-white/[0.05]'
            }`}
          >
            <div
              className={`w-11 h-11 rounded-xl flex items-center justify-center mb-3 ${
                selectedFile
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : 'bg-sky-500/15 text-sky-400'
              }`}
            >
              {selectedFile ? (
                <CheckCircle2 className="w-5 h-5" />
              ) : (
                <FileUp className="w-5 h-5" />
              )}
            </div>

            {selectedFile ? (
              <>
                <p className="text-sm font-semibold text-white break-all max-w-md">
                  {selectedFile.name}
                </p>
                <p className="text-xs text-slate-300 mt-1 font-mono tabular-nums">
                  {formatBytes(selectedFile.size)} · Click to replace
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-slate-100">
                  Click to choose a PDF or Word document, or drag it here
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  Supports PDF, DOCX, DOC, TXT, PNG, JPG up to 30 MB
                </p>
              </>
            )}
            <input
              type="file"
              accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg"
              className="hidden"
              onChange={(e) => handleFilePicked(e.target.files?.[0] || null)}
            />
          </label>
        </div>

        {/* Copies & Paper Size */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-white/10 pt-5">
          <div>
            <label htmlFor="copies-input" className="block text-xs font-medium text-slate-300 mb-1.5">
              Number of Copies Needed
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Decrease copies"
                onClick={() =>
                  setRequestedCopies((c) => {
                    const n = Number(c) || 1;
                    return String(Math.max(1, n - 1));
                  })
                }
                className="p-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-slate-200 transition-colors"
              >
                <Minus className="w-4 h-4" />
              </button>
              <input
                id="copies-input"
                type="number"
                min={1}
                max={5000}
                value={requestedCopies}
                onChange={(e) => setRequestedCopies(e.target.value)}
                placeholder="Copies"
                className="glass-input w-full rounded-xl px-3 py-2.5 text-center text-sm font-mono font-semibold tabular-nums"
              />
              <button
                type="button"
                aria-label="Increase copies"
                onClick={() =>
                  setRequestedCopies((c) => {
                    const n = Number(c) || 0;
                    return String(Math.min(5000, n + 1));
                  })
                }
                className="p-2.5 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-slate-200 transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div>
            <label htmlFor="paper-size" className="block text-xs font-medium text-slate-300 mb-1.5">
              Paper Size
            </label>
            <select
              id="paper-size"
              value={paperSize}
              onChange={(e) => setPaperSize(e.target.value as PaperSize | '')}
              className="glass-input w-full rounded-xl px-3.5 py-2.5 text-sm"
            >
              <option value="" disabled>
                Select paper size
              </option>
              <option value="A4">A4</option>
              <option value="Letter">Letter</option>
              <option value="Legal">Legal</option>
            </select>
          </div>
        </div>

        {/* Sides, Color & Finishing */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <span className="block text-xs text-slate-400 mb-1.5">Print Sides</span>
            <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-950/70 border border-white/10">
              <button
                type="button"
                onClick={() => setDuplex(true)}
                className={`py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  duplex === true
                    ? 'bg-sky-500/25 text-sky-200 border border-sky-400/40'
                    : 'text-slate-400 hover:text-white border border-transparent'
                }`}
              >
                Double-Sided
              </button>
              <button
                type="button"
                onClick={() => setDuplex(false)}
                className={`py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  duplex === false
                    ? 'bg-sky-500/25 text-sky-200 border border-sky-400/40'
                    : 'text-slate-400 hover:text-white border border-transparent'
                }`}
              >
                Single-Sided
              </button>
            </div>
          </div>

          <div>
            <span className="block text-xs text-slate-400 mb-1.5">Ink Mode</span>
            <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-slate-950/70 border border-white/10">
              <button
                type="button"
                onClick={() => setColorMode('bw')}
                className={`py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  colorMode === 'bw'
                    ? 'bg-sky-500/25 text-sky-200 border border-sky-400/40'
                    : 'text-slate-400 hover:text-white border border-transparent'
                }`}
              >
                Black & White
              </button>
              <button
                type="button"
                onClick={() => setColorMode('color')}
                className={`py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                  colorMode === 'color'
                    ? 'bg-sky-500/25 text-sky-200 border border-sky-400/40'
                    : 'text-slate-400 hover:text-white border border-transparent'
                }`}
              >
                Color Print
              </button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 items-center">
          <div className="sm:col-span-4">
            <label className="inline-flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer py-1">
              <input
                type="checkbox"
                checked={staple}
                onChange={(e) => setStaple(e.target.checked)}
                className="w-4 h-4 rounded border-white/20 bg-slate-900 text-sky-500"
              />
              Staple each copy
            </label>
          </div>
          <div className="sm:col-span-8">
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional note for the Print Desk"
              className="glass-input w-full rounded-xl px-4 py-2.5 text-sm"
            />
          </div>
        </div>

        {feedback && (
          <div
            className={`rounded-xl px-4 py-3 text-xs font-medium border flex items-center gap-2.5 ${
              feedback.type === 'ok'
                ? 'bg-emerald-500/12 border-emerald-400/35 text-emerald-200'
                : 'bg-rose-500/12 border-rose-400/35 text-rose-200'
            }`}
          >
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{feedback.text}</span>
          </div>
        )}

        <div className="border-t border-white/10 pt-5 flex justify-end">
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-3 rounded-xl text-sm font-semibold bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0"
          >
            <Send className="w-4 h-4" />
            {submitting ? 'Sending Document...' : 'Send for Printing'}
          </button>
        </div>
      </form>

      {/* Right: Real Sent Documents Tracker + Share Link */}
      <div className="lg:col-span-5 space-y-6">
        <div className="glass-panel rounded-2xl p-6 space-y-4">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-3.5">
          <div>
            <h2 className="text-base font-semibold text-white">Sent Documents</h2>
            <p className="text-xs text-slate-400 mt-0.5 font-mono tabular-nums">
              {visibleSent.length} {visibleSent.length === 1 ? 'document' : 'documents'} in queue
            </p>
          </div>

          <div className="flex items-center gap-2">
            {senderName.trim() && (
              <button
                type="button"
                onClick={() => setOnlyMine((v) => !v)}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors whitespace-nowrap shrink-0 ${
                  onlyMine
                    ? 'bg-sky-500/20 border-sky-400/45 text-sky-200'
                    : 'bg-white/[0.04] border-white/10 text-slate-300 hover:text-white'
                }`}
              >
                {onlyMine ? 'Showing Mine' : 'My Files'}
              </button>
            )}
            <button
              type="button"
              onClick={onRefresh}
              aria-label="Refresh sent documents"
              className="p-2 rounded-lg bg-white/[0.05] hover:bg-white/[0.11] border border-white/10 text-slate-300 hover:text-white transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={queueSearch}
            onChange={(e) => setQueueSearch(e.target.value)}
            placeholder="Filter by title or sender..."
            className="glass-input w-full rounded-xl pl-9 pr-3 py-2 text-xs"
          />
        </div>

        {visibleSent.length === 0 ? (
          <div className="py-14 text-center space-y-2.5">
            <FileText className="w-8 h-8 text-slate-500 mx-auto" />
            <p className="text-sm font-medium text-slate-200">
              {submissions.length === 0 ? 'No documents sent yet' : 'No matching documents'}
            </p>
            <p className="text-xs text-slate-400 max-w-xs mx-auto">
              {submissions.length === 0
                ? 'Upload a PDF or Word file on the left to send it to the Damaria Docs Print Desk.'
                : 'Clear your search filter to see all sent documents.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/10 max-h-[540px] overflow-y-auto pr-1">
            {visibleSent.map((sub) => (
              <div key={sub.id} className="py-3.5 first:pt-1 last:pb-1 space-y-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-white truncate">{sub.title}</p>
                    <p className="text-xs text-slate-400 mt-0.5 truncate">
                      {sub.senderName} ·{' '}
                      <span className="uppercase font-mono text-sky-300">{sub.fileType}</span>
                      {' · '}
                      <span className="font-mono tabular-nums">{sub.requestedCopies} copies</span>
                      {' · '}
                      {sub.duplex ? 'Double' : 'Single'}
                      {' · '}
                      {formatTimeAgo(sub.submittedAt)}
                    </p>
                    {sub.status === 'printed' && sub.printedCopies > 0 && (
                      <p className="text-[11px] text-emerald-300/85 mt-0.5 font-mono tabular-nums">
                        Printed {sub.printedCopies} copies ({sub.sheetsConsumed} sheets)
                      </p>
                    )}
                  </div>
                  <SubmissionStatusLabel status={sub.status} />
                </div>
              </div>
            ))}
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
