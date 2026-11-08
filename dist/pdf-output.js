import { t } from './i18n.js';
import { BlendMode, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream, degrees } from './vendor/pdf-lib.esm.min.js';
import { ImageKind, OPS } from './vendor/pdf.mjs';
import { pointsPerMillimeter, scaleToWidth, visibleFrame } from './page-size.js';
import { loadSource } from './material.js';

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}
async function encode(canvas, type = 'image/png', quality) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, type, quality));
  if (!blob) throw Error(t("无法编码图片。"));
  return new Uint8Array(await blob.arrayBuffer());
}
async function bitmapCanvas(bytes, type, max, background) {
  const image = await createImageBitmap(new Blob([bytes], { type }));
  try {
    const ratio = Math.min(1, max / Math.max(image.width, image.height));
    const canvas = makeCanvas(image.width * ratio, image.height * ratio);
    const ctx = canvas.getContext('2d');
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    image.close();
  }
}
export async function imagePng(bytes, format) {
  return encode(await bitmapCanvas(bytes, format === 'jpeg' ? 'image/jpeg' : 'image/png', 1800));
}
function imageCanvas(image) {
  const canvas = makeCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  if (image.bitmap) {
    ctx.drawImage(image.bitmap, 0, 0);
    return canvas;
  }
  if (!image.data) return null;
  const rgba = ctx.createImageData(canvas.width, canvas.height);
  if (image.kind === ImageKind.RGBA_32BPP) rgba.data.set(image.data);
  else {
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const dest = (y * canvas.width + x) * 4;
        if (image.kind === ImageKind.RGB_24BPP) rgba.data.set(image.data.subarray(dest / 4 * 3, dest / 4 * 3 + 3), dest);
        else if (image.kind === ImageKind.GRAYSCALE_1BPP) {
          const pixel = image.data[y * Math.ceil(canvas.width / 8) + (x >> 3)] & (128 >> (x % 8)) ? 255 : 0;
          rgba.data.fill(pixel, dest, dest + 3);
        } else return null;
        rgba.data[dest + 3] = 255;
      }
    }
  }
  ctx.putImageData(rgba, 0, 0);
  return canvas;
}
export async function watermarkChoices(page) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(1.8, 1300 / Math.max(base.width, base.height)) });
  const fullPage = makeCanvas(viewport.width, viewport.height);
  const [operations] = await Promise.all([
    page.getOperatorList(),
    page.render({ canvasContext: fullPage.getContext('2d'), viewport, background: 'rgba(0,0,0,0)' }).promise,
  ]);
  const seen = new Set();
  const pending = [];
  const images = [];
  for (const [index, operation] of operations.fnArray.entries()) {
    const arg = operations.argsArray[index]?.[0];
    if (!arg) continue;
    if ([OPS.paintImageXObject, OPS.paintImageXObjectRepeat].includes(operation)) {
      if (seen.has(arg)) continue;
      seen.add(arg);
      const objects = arg.startsWith('g_') ? page.commonObjs : page.objs;
      if (objects.has(arg)) pending.push(objects.get(arg));
      else pending.push(new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), 5000);
        objects.get(arg, image => {
          clearTimeout(timer);
          resolve(image);
        });
      }));
    } else if (operation === OPS.paintInlineImageXObject) pending.push(arg);
  }
  for (const image of await Promise.all(pending)) {
    if (!image?.width || !image.height) continue;
    try {
      const canvas = imageCanvas(image);
      if (!canvas) continue;
      const ratio = Math.min(1, 1600 / Math.max(canvas.width, canvas.height));
      const scaled = makeCanvas(canvas.width * ratio, canvas.height * ratio);
      scaled.getContext('2d').drawImage(canvas, 0, 0, scaled.width, scaled.height);
      images.push(await encode(scaled));
    } catch { /* Unsupported image encoding can still use the rendered page. */ }
  }
  return { images, fullPage: await encode(fullPage) };
}

async function textPng(text, color) {
  const font = '600 54px sans-serif';
  const measure = makeCanvas(1, 1).getContext('2d');
  measure.font = font;
  const canvas = makeCanvas(Math.ceil(measure.measureText(text).width) + 14, 72);
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, 7, 36);
  return encode(canvas);
}
function pagePoint(frame, x, y) {
  const box = frame.box;
  if (frame.rotation === 90) return { x: box.x + box.width - y, y: box.y + x };
  if (frame.rotation === 180) return { x: box.x + box.width - x, y: box.y + box.height - y };
  if (frame.rotation === 270) return { x: box.x + y, y: box.y + box.height - x };
  return { x: box.x + x, y: box.y + y };
}
function applyWatermark(page, frame, image, options) {
  const width = options.size * pointsPerMillimeter / frame.unit;
  const height = width * image.height / image.width;
  const gap = options.gap * pointsPerMillimeter / frame.unit;
  const angle = options.angle * Math.PI / 180;
  const dx = Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height;
  const dy = Math.abs(Math.sin(angle)) * width + Math.abs(Math.cos(angle)) * height;
  const step = Math.max(1, Math.sqrt(frame.width * frame.height / ((dx + gap) * (dy + gap) * 400)));
  const stepX = (dx + gap) * step, stepY = (dy + gap) * step;
  const columns = Math.min(60, Math.max(1, Math.ceil(frame.width / stepX)));
  const rows = Math.min(60, Math.max(1, Math.ceil(frame.height / stepY)));
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = frame.width / 2 + (column - (columns - 1) / 2) * stepX;
      const y = frame.height / 2 + (row - (rows - 1) / 2) * stepY;
      const corner = pagePoint(frame, x - (width * Math.cos(angle) - height * Math.sin(angle)) / 2,
        y - (width * Math.sin(angle) + height * Math.cos(angle)) / 2);
      page.drawImage(image, { ...corner, width, height, rotate: degrees(frame.rotation + options.angle),
        opacity: options.opacity / 100, blendMode: BlendMode.Multiply });
    }
  }
}
function numberLabel(format, n, total) {
  if (format === 'zh') return t("第 {0} 页", n);
  if (format === 'zh-fraction') return t("第 {0} / {1} 页", n, total);
  if (format === 'fraction') return `${n} / ${total}`;
  return String(n);
}
async function decorate(output, pages, options) {
  const mark = options.watermark
    ? await output.embedPng(options.watermark.text ? await textPng(options.watermark.text, '#444444') : options.watermark.png)
    : null;
  for (const [index, page] of pages.entries()) {
    if (options.width !== null) scaleToWidth(page, options.width);
    output.addPage(page);
    if (!mark && !options.number.format) continue;
    const frame = visibleFrame(page);
    if (mark) applyWatermark(page, frame, mark, options.watermark);
    const offset = options.number.skipCover ? 1 : 0;
    if (!options.number.format || index < offset) continue;
    const n = options.number.start + index - offset;
    const total = options.number.start + pages.length - offset - 1;
    const image = await output.embedPng(await textPng(numberLabel(options.number.format, n, total), '#252735'));
    const height = Math.min(14 / frame.unit, frame.height * 0.09, frame.width * 0.8 * image.height / image.width);
    const width = height * image.width / image.height;
    page.drawImage(image, { ...pagePoint(frame, (frame.width - width) / 2, Math.min(15 / frame.unit, frame.height * 0.045)),
      width, height, rotate: degrees(frame.rotation) });
  }
}

const name = PDFName.of;
function dictionaryValue(stream, key) { return stream.dict.lookup(name(key)); }
function numeric(stream, key) { return dictionaryValue(stream, key)?.asNumber?.(); }
async function compressImages(output, preset) {
  const objects = output.context.enumerateIndirectObjects();
  const masks = new Set();
  for (const [, stream] of objects) {
    if (!(stream instanceof PDFRawStream)) continue;
    for (const key of ['SMask', 'Mask']) if (stream.dict.has(name(key))) masks.add(stream.dict.get(name(key)));
  }
  for (const [reference, stream] of objects) {
    if (!(stream instanceof PDFRawStream) || dictionaryValue(stream, 'Subtype') !== name('Image') ||
        masks.has(reference) ||
        numeric(stream, 'BitsPerComponent') !== 8 ||
        ['SMask', 'Mask', 'ImageMask', 'Decode', 'DecodeParms', 'SMaskInData'].some(key => stream.dict.has(name(key)))) continue;
    const color = dictionaryValue(stream, 'ColorSpace');
    const channels = color === name('DeviceRGB') ? 3 : color === name('DeviceGray') ? 1 : 0;
    const width = numeric(stream, 'Width'), height = numeric(stream, 'Height');
    if (!channels || !(width > 0 && height > 0) || width * height > 24000000 || stream.contents.length < 8000) continue;
    const filter = dictionaryValue(stream, 'Filter');
    try {
      let canvas;
      if (filter === name('DCTDecode')) canvas = await bitmapCanvas(stream.contents, 'image/jpeg', preset.max, '#ffffff');
      else if (filter === name('FlateDecode') || !filter) {
        const pixels = filter ? decodePDFRawStream(stream).decode() : stream.contents;
        if (pixels.length !== width * height * channels) continue;
        const original = imageCanvas(channels === 3 ? { width, height, kind: ImageKind.RGB_24BPP, data: pixels }
          : { width, height, kind: ImageKind.RGB_24BPP, data: Uint8Array.from({ length: pixels.length * 3 }, (_, i) => pixels[Math.floor(i / 3)]) });
        const ratio = Math.min(1, preset.max / Math.max(width, height));
        canvas = makeCanvas(width * ratio, height * ratio);
        canvas.getContext('2d').drawImage(original, 0, 0, canvas.width, canvas.height);
      } else continue;
      const bytes = await encode(canvas, 'image/jpeg', preset.quality);
      if (bytes.length >= stream.contents.length) continue;
      const dict = stream.dict.clone(output.context);
      dict.set(name('Width'), PDFNumber.of(canvas.width));
      dict.set(name('Height'), PDFNumber.of(canvas.height));
      dict.set(name('ColorSpace'), name('DeviceRGB'));
      dict.set(name('Filter'), name('DCTDecode'));
      output.context.assign(reference, PDFRawStream.of(dict, bytes));
    } catch { /* Preserve unsupported or damaged image streams. */ }
  }
}
async function assemble(references, sources, options, preset) {
  const output = await PDFDocument.create();
  const groups = new Map();
  references.forEach((page, position) => {
    if (!groups.has(page.source)) groups.set(page.source, []);
    groups.get(page.source).push({ index: page.index, position });
  });
  const ordered = new Array(references.length);
  for (const [source, entries] of groups) {
    const file = sources.get(source);
    let original = file.original;
    if (preset && file.format === 'png' && file.imageBytes.length > 8000) {
      try {
        const canvas = await bitmapCanvas(file.imageBytes, 'image/png', preset.max, file.background);
        const jpeg = await encode(canvas, 'image/jpeg', preset.quality);
        if (jpeg.length < file.imageBytes.length) {
          const compressed = await loadSource({ ...file, imageBytes: jpeg, format: 'jpeg', sizeFrom: file.original.getPage(0).getSize() });
          original = compressed.original;
        }
      } catch { /* Keep the original image if browser decoding fails. */ }
    }
    const copied = await output.copyPages(original, entries.map(page => page.index));
    entries.forEach((page, i) => { ordered[page.position] = copied[i]; });
  }
  await decorate(output, ordered, options);
  if (preset) await compressImages(output, preset);
  return output.save();
}
export async function composePdf(references, sources, options) {
  let best = await assemble(references, sources, options);
  if (!options.limit || best.byteLength <= options.limit) return best;
  for (const [quality, max] of [[0.82, 1900], [0.65, 1400], [0.46, 1000], [0.28, 650]]) {
    const result = await assemble(references, sources, options, { quality, max });
    if (result.byteLength < best.byteLength) best = result;
    if (best.byteLength <= options.limit) break;
  }
  return best;
}
