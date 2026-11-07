import sharp from 'sharp';

export const MAX_MAIL_IMAGE_INPUT = 2_000_000;
export const MAX_MAIL_IMAGE_TOTAL_INPUT = 4_000_000;
const maxPixels = 4_000_000;
const maxOutput = 1_000_000;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function stillPng(input: Buffer): boolean {
  if (!input.subarray(0, 8).equals(pngSignature)) return false;
  let offset = 8;
  let chunks = 0;
  while (offset + 12 <= input.length && ++chunks <= 2048) {
    const length = input.readUInt32BE(offset);
    const name = input.toString('ascii', offset + 4, offset + 8);
    if (length > input.length - offset - 12 || name === 'acTL') return false;
    if (offset === 8 && (name !== 'IHDR' || length !== 13)) return false;
    offset += length + 12;
    if (name === 'IEND') return length === 0 && offset === input.length;
  }
  return false;
}

/** Decode only bounded static raster pixels; output contains no source metadata or active formats. */
export async function reencodeMailImage(
  input: Buffer,
  contentType: string,
): Promise<string | undefined> {
  if (!input.length || input.length > MAX_MAIL_IMAGE_INPUT) return;
  let format: 'png' | 'jpeg';
  if (contentType === 'image/png') format = 'png';
  else if (contentType === 'image/jpeg') format = 'jpeg';
  else return;
  if (format === 'png' && !stillPng(input)) return;
  if (
    format === 'jpeg' &&
    (input[0] !== 0xff ||
      input[1] !== 0xd8 ||
      input[2] !== 0xff ||
      input[input.length - 2] !== 0xff ||
      input[input.length - 1] !== 0xd9)
  )
    return;
  try {
    const image = sharp(input, {
      limitInputPixels: maxPixels,
      animated: false,
      failOn: 'warning',
    }).timeout({ seconds: 2 });
    const metadata = await image.metadata();
    if (
      metadata.format !== format ||
      !metadata.width ||
      !metadata.height ||
      metadata.width > 4096 ||
      metadata.height > 4096 ||
      metadata.width * metadata.height > maxPixels ||
      (metadata.pages ?? 1) !== 1
    )
      return;
    const output = await image
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 6 })
      .toBuffer();
    if (output.length > maxOutput) return;
    return `data:image/png;base64,${output.toString('base64')}`;
  } catch {
    return;
  }
}
