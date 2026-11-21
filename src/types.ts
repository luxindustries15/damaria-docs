export type PaperSize = 'A4' | 'Letter' | 'Legal';

export type DeviceType = 'printer' | 'photocopier';

export type PrinterConnectionMode = 'digital' | 'manual';

export type PrinterStatus = 'connected-digital' | 'connected-manual' | 'offline';

export type SubmissionStatus = 'waiting' | 'printed';

export type TelemetrySource = 'ipp' | 'pjl' | 'bridge' | 'none';

export interface InkLevels {
  black: number | null;
  cyan?: number | null;
  magenta?: number | null;
  yellow?: number | null;
}

export interface UsbHardwareInfo {
  vendorId?: number;
  productId?: number;
  manufacturer?: string;
  productName?: string;
  serialNumber?: string;
  portLabel?: string;
}

export interface PrinterDevice {
  id: string;
  name: string;
  deviceType: DeviceType;
  location: string;
  connectionMode: PrinterConnectionMode;
  endpoint: string;
  status: PrinterStatus;
  hardwareState: string;
  connectionMessage: string;
  telemetrySource: TelemetrySource;
  lastCheckedAt: string;
  usbInfo?: UsbHardwareInfo;
  isColor: boolean;
  ink: InkLevels;
  supplyNote: string;
  traySheets: number | null;
  trayCapacity: number | null;
  paperState: string;
  totalSheetsPrinted: number;
  imageUrl: string;
}

export interface ExamSubmission {
  id: string;
  senderName: string;
  title: string;
  fileType: 'pdf' | 'word' | 'other';
  fileName: string | null;
  fileMime: string | null;
  fileSizeBytes: number | null;
  fileUrl: string | null;
  renderedHtml: string;
  pageCount: number;
  requestedCopies: number;
  printedCopies: number;
  sheetsConsumed: number;
  paperSize: PaperSize;
  duplex: boolean;
  colorMode: 'bw' | 'color';
  staple: boolean;
  notes: string;
  status: SubmissionStatus;
  assignedPrinterId: string | null;
  assignedPrinterName?: string | null;
  printMode: PrinterConnectionMode | null;
  submittedAt: string;
  completedAt: string | null;
}

export type HistoryLogAction =
  | 'DOCUMENT_SENT'
  | 'DOCUMENT_DELETED'
  | 'PRINT_COMPLETED'
  | 'PRINT_FAILED'
  | 'PRINTER_CONNECTED'
  | 'PRINTER_OFFLINE'
  | 'PRINTER_REMOVED'
  | 'PAPER_UPDATED';

export interface HistoryLogEntry {
  id: string;
  timestamp: string;
  actorName: string;
  action: HistoryLogAction;
  examTitle?: string;
  senderName?: string;
  printerName?: string;
  printMode?: PrinterConnectionMode;
  copiesProduced?: number;
  sheetsUsed?: number;
  details: string;
}

export type NotificationType = HistoryLogAction | 'LOGS_DELETED';

export interface AppNotification {
  id: string;
  timestamp: string;
  type: NotificationType;
  audience: 'all' | 'sender' | 'admin';
  title: string;
  message: string;
  submissionId?: string;
  senderName?: string;
  printerName?: string;
}

export interface BootstrapPayload {
  schemaVersion: number;
  schoolName: string;
  publicDomain?: string;
  liveAppUrl?: string;
  printers: PrinterDevice[];
  submissions: ExamSubmission[];
  logs: HistoryLogEntry[];
  notifications?: AppNotification[];
}
