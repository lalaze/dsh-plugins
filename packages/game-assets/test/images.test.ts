import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageSize } from '../src/images.js';

const png = (width: number, height: number) => {
  const data = Buffer.alloc(24);
  data.writeUInt32BE(0x89504e47, 0); data.writeUInt32BE(0x0d0a1a0a, 4); data.writeUInt32BE(13, 8); data.write('IHDR', 12, 'latin1');
  data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  return data;
};

test('pixel sizes are read from PNG, GIF, WebP, JPEG and SVG headers', () => {
  assert.deepEqual(imageSize(png(96, 64)), { width: 96, height: 64 });
  const gif = Buffer.from('GIF89a\0\0\0\0', 'latin1'); gif.writeUInt16LE(480, 6); gif.writeUInt16LE(264, 8);
  assert.deepEqual(imageSize(gif), { width: 480, height: 264 });

  const lossless = Buffer.alloc(30); lossless.write('RIFF', 0, 'latin1'); lossless.write('WEBPVP8L', 8, 'latin1'); lossless[20] = 0x2f;
  lossless.writeUInt32LE((100 - 1) | ((50 - 1) << 14), 21);
  assert.deepEqual(imageSize(lossless), { width: 100, height: 50 });
  const extended = Buffer.alloc(30); extended.write('RIFF', 0, 'latin1'); extended.write('WEBPVP8X', 8, 'latin1');
  extended.writeUIntLE(319, 24, 3); extended.writeUIntLE(199, 27, 3);
  assert.deepEqual(imageSize(extended), { width: 320, height: 200 });

  // SOI, an APP0 segment to skip, then a baseline frame header.
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08]), Buffer.from([0x01, 0x00, 0x02, 0x00]), Buffer.alloc(12)]);
  assert.deepEqual(imageSize(jpeg), { width: 512, height: 256 });

  assert.deepEqual(imageSize(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="64px" height="32">')), { width: 64, height: 32 });
  assert.deepEqual(imageSize(Buffer.from('<svg viewBox="0 0 24 16" xmlns="http://www.w3.org/2000/svg">')), { width: 24, height: 16 });
});

test('truncated or foreign bytes have no size', () => {
  for (const data of [Buffer.alloc(0), png(0, 10), png(10, 10).subarray(0, 20), Buffer.from('GIF89a'), Buffer.from('plain text'), Buffer.from([0xff, 0xd8, 0xff])]) assert.equal(imageSize(data), undefined);
});
