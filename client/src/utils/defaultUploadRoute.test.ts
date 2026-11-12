import { EToolResources as R } from 'librechat-data-provider';
import { defaultUploadRoute } from './defaultUploadRoute';
const options = [R.file_search, R.execute_code, R.context, undefined];
it.each(['Vorlage.docx', 'Kalkulation.xlsx', 'Export.csv', 'Praesentation.pptx'])(
  'preserves the original of %s through the analysis path',
  (name) => {
    expect(defaultUploadRoute([{ name, type: 'application/octet-stream' }], options)).toBe(
      R.execute_code,
    );
  },
);
it('extracts PDF and text locally by default', () => {
  expect(defaultUploadRoute([{ name: 'Bericht.pdf', type: 'application/pdf' }], options)).toBe(
    R.context,
  );
});
it('uses the image provider path for images', () => {
  expect(defaultUploadRoute([{ name: 'Bild.png', type: 'image/png' }], options)).toBeUndefined();
});
it('never selects a disabled capability', () => {
  expect(
    defaultUploadRoute([{ name: 'Vorlage.docx', type: 'application/octet-stream' }], [R.context]),
  ).toBe(R.context);
});
