import { CheckCircle2, Cpu, Usb, WifiOff, Clock } from 'lucide-react';
import type { PrinterStatus, SubmissionStatus } from '../types';

export function SubmissionStatusLabel({ status }: { status: SubmissionStatus }) {
  if (status === 'printed') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 whitespace-nowrap">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        Printed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-300 whitespace-nowrap">
      <Clock className="w-3.5 h-3.5 shrink-0" />
      Waiting
    </span>
  );
}

export function PrinterStatusLabel({ status }: { status: PrinterStatus }) {
  switch (status) {
    case 'connected-digital':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400 whitespace-nowrap">
          <Cpu className="w-3.5 h-3.5 shrink-0" />
          Connected (Digital)
        </span>
      );
    case 'connected-manual':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-300 whitespace-nowrap">
          <Usb className="w-3.5 h-3.5 shrink-0" />
          Connected (Manual)
        </span>
      );
    case 'offline':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-400 whitespace-nowrap">
          <WifiOff className="w-3.5 h-3.5 shrink-0" />
          Offline
        </span>
      );
  }
}
