import type { TFile } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

export default function PdfIntakeNotice({ file }: { file: Partial<TFile> }) {
  const localize = useLocalize();
  const status = file.metadata?.documentIntake?.status;
  if (!status) return null;
  const key =
    status === 'skipped'
      ? 'com_ui_pdf_intake_skipped'
      : status === 'incomplete'
        ? 'com_ui_pdf_intake_incomplete'
        : status === 'ocr'
          ? 'com_ui_pdf_intake_ocr'
          : 'com_ui_pdf_intake_read';
  return (
    <p role="status" className="mb-2 max-w-xl text-sm text-text-secondary">
      {localize(key)}
    </p>
  );
}
