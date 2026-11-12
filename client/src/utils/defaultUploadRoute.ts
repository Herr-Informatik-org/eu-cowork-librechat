import { EToolResources } from 'librechat-data-provider';
/** Choose a permitted local intake path while preserving editable Office originals. */
export function defaultUploadRoute(
  files: Pick<File, 'name' | 'type'>[],
  options: (EToolResources | undefined)[],
): EToolResources | undefined {
  const office = files.some((f) => /\.(docx|xlsx|xls|ods|csv|tsv|pptx)$/i.test(f.name));
  if (office && options.includes(EToolResources.execute_code)) return EToolResources.execute_code;
  const images = files.length > 0 && files.every((f) => f.type.startsWith('image/'));
  if (!images && options.includes(EToolResources.context)) return EToolResources.context;
  if (options.includes(undefined)) return undefined;
  if (options.includes(EToolResources.execute_code)) return EToolResources.execute_code;
  return options[0];
}
