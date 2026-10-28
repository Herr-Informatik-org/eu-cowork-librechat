import sharp from 'sharp';
import { reencodeMailImage, MAX_MAIL_IMAGE_INPUT } from './images';

const pixel = () => sharp({ create: { width: 8, height: 4, channels: 3, background: '#aabbcc' } });

describe('explicit mail raster image normalization', () => {
  test.each(['png', 'jpeg'] as const)(
    'reencodes %s pixels as bounded PNG without metadata',
    async (format) => {
      const input = await pixel().withMetadata({ density: 300 }).toFormat(format).toBuffer();
      const output = await reencodeMailImage(input, `image/${format}`);
      expect(output).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
      const normalized = Buffer.from(output!.split(',')[1], 'base64');
      const metadata = await sharp(normalized).metadata();
      expect(metadata).toMatchObject({ format: 'png', width: 8, height: 4, hasProfile: false });
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
    },
  );
  test('bounds output dimensions even for valid bigger images', async () => {
    const input = await sharp({
      create: { width: 2400, height: 1000, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const output = await reencodeMailImage(input, 'image/png');
    const metadata = await sharp(Buffer.from(output!.split(',')[1], 'base64')).metadata();
    expect(metadata.width).toBe(1600);
    expect(metadata.height).toBeLessThanOrEqual(1600);
  });
  test('rejects mismatched MIME, unsupported formats and source polyglots before reencoding', async () => {
    const png = await pixel().png().toBuffer();
    const jpeg = await pixel().jpeg().toBuffer();
    for (const [input, mime] of [
      [png, 'image/jpeg'],
      [jpeg, 'image/png'],
      [png, 'image/svg+xml'],
      [png, 'application/octet-stream'],
      [png, '__proto__'],
      [Buffer.from('<svg onload="alert(1)"></svg>'), 'image/png'],
      [Buffer.from('%PDF-1.7'), 'image/jpeg'],
      [Buffer.concat([png, Buffer.from('<script>alert(1)</script>')]), 'image/png'],
      [Buffer.concat([jpeg, Buffer.from('<html>')]), 'image/jpeg'],
      [Buffer.from('GIF89a'), 'image/gif'],
      [Buffer.alloc(MAX_MAIL_IMAGE_INPUT + 1), 'image/png'],
    ] as const)
      expect(await reencodeMailImage(input, mime)).toBeUndefined();
  });
  test('rejects animated PNG chunks, truncated input and excessive pixels', async () => {
    const png = await pixel().png().toBuffer();
    const animation = Buffer.from([0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(
      await reencodeMailImage(
        Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)]),
        'image/png',
      ),
    ).toBeUndefined();
    expect(await reencodeMailImage(png.subarray(0, -1), 'image/png')).toBeUndefined();
    const huge = await sharp({
      create: { width: 2500, height: 2000, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    expect(await reencodeMailImage(huge, 'image/png')).toBeUndefined();
  });
});
