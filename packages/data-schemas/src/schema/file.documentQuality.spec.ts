import mongoose from 'mongoose';
import fileSchema from './file';

describe('document quality persistence', () => {
  it('retains the exact server report when casting a private file for storage', () => {
    const Model = mongoose.model('DocumentQualityFixture', fileSchema);
    try {
      const report = {
        policyVersion: '1',
        format: 'pdf',
        filename: 'bericht.pdf',
        sha256: 'a'.repeat(64),
        pages: 2,
        logoApplied: true,
        minimumContrast: 7.56,
        minimumFontPt: 9,
        calculations: 3,
      };
      const file = new Model({
        user: new mongoose.Types.ObjectId(),
        file_id: 'quality-fixture',
        filename: report.filename,
        filepath: '/uploads/quality-fixture.pdf',
        bytes: 100,
        type: 'application/pdf',
        metadata: { documentQuality: report },
      });
      expect(file.toObject().metadata?.documentQuality).toEqual(report);
      expect(file.validateSync()).toBeUndefined();
    } finally {
      mongoose.deleteModel('DocumentQualityFixture');
    }
  });
});
