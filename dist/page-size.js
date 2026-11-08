import { t } from './i18n.js';
import { PDFName, PDFNumber } from './vendor/pdf-lib.esm.min.js';

export const pointsPerMillimeter = 72 / 25.4;
const userUnit = PDFName.of('UserUnit');

export function visibleFrame(page) {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const width = Math.min(media.x + media.width, crop.x + crop.width) - Math.max(media.x, crop.x);
  const height = Math.min(media.y + media.height, crop.y + crop.height) - Math.max(media.y, crop.y);
  const box = width > 0 && height > 0 ? { x: Math.max(media.x, crop.x), y: Math.max(media.y, crop.y), width, height } : media;
  const entry = page.node.lookup(userUnit);
  const unit = entry instanceof PDFNumber && entry.asNumber() > 0 ? entry.asNumber() : 1;
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  const rotated = rotation === 90 || rotation === 270;
  return { box, rotation, unit, width: rotated ? box.height : box.width, height: rotated ? box.width : box.height };
}

export function visibleSize(page) {
  const { width, height, unit } = visibleFrame(page);
  return {
    width: width * unit,
    height: height * unit,
  };
}

export function scaleToWidth(page, targetWidth) {
  const factor = targetWidth / visibleSize(page).width;
  if (!Number.isFinite(factor) || factor <= 0) throw Error(t("页面尺寸无效。"));
  if (factor === 1) return;
  const boxes = ['Media', 'Crop', 'Bleed', 'Trim', 'Art'].map(name => [name, page[`get${name}Box`]()]);
  for (const [name, { x, y, width, height }] of boxes) {
    page[`set${name}Box`](x * factor, y * factor, width * factor, height * factor);
  }
  page.scaleContent(factor, factor);
  page.scaleAnnotations(factor, factor);
}
