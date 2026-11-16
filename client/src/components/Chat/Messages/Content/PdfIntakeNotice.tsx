import type { TFile } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

const keys = {
  read: 'com_ui_pdf_intake_read',
  ocr: 'com_ui_pdf_intake_ocr',
  incomplete: 'com_ui_pdf_intake_incomplete',
  skipped: 'com_ui_pdf_intake_skipped',
  original: 'com_ui_pdf_intake_original',
} as const;

export default function PdfIntakeNotice({ file }: { file: Partial<TFile> }) {
  const localize = useLocalize();
  const status = file.metadata?.documentIntake?.status;
  if (!status) return null;
  const key = keys[status];
  return (
    <p role="status" className="mb-2 max-w-xl text-sm text-text-secondary">
      {localize(key)}
    </p>
  );
}
