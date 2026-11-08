import { t } from './i18n.js';
import { PDFDocument, rgb } from './vendor/pdf-lib.esm.min.js';

const paperSizes = { a4: [595.2756, 841.8898], a3: [841.8898, 1190.5512], letter: [612, 792] };
export const imagePattern = /\.(png|jpe?g)$/i;

export async function loadSource(file) {
  const format = file.format || (imagePattern.test(file.name) ? (/\.png$/i.test(file.name) ? 'png' : 'jpeg') : 'pdf');
  if (format === 'pdf') {
    return { ...file, format, original: await PDFDocument.load(file.bytes, { updateMetadata: false }) };
  }
  if (!['png', 'jpeg'].includes(format)) throw Error(t("不支持的图片格式"));
  const imageBytes = file.imageBytes || file.bytes;
  const paper = Object.hasOwn(paperSizes, file.paper) || file.paper === 'original' ? file.paper : 'a4';
  const background = /^#[\da-f]{6}$/i.test(file.background) ? file.background : '#ffffff';
  const original = await PDFDocument.create();
  const image = await (format === 'png' ? original.embedPng(imageBytes) : original.embedJpg(imageBytes));
  const [width, height] = file.sizeFrom ? [file.sizeFrom.width, file.sizeFrom.height]
    : paperSizes[paper] || [image.width * 0.75, image.height * 0.75];
  const page = original.addPage([width, height]);
  const channels = background.slice(1).match(/../g).map(value => parseInt(value, 16) / 255);
  page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(...channels) });
  const scale = Math.min(width / image.width, height / image.height);
  const w = image.width * scale, h = image.height * scale;
  page.drawImage(image, { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h });
  const bytes = await original.save();
  return { ...file, format, paper, background, imageBytes, bytes, original };
}

export function folderContents(project, sources, folder) {
  const contents = [];
  for (const item of Object.values(project.materialFolders)) {
    if (item.parent === folder) contents.push(...folderContents(project, sources, item.id));
  }
  for (const [key] of sources) {
    if ((project.materialLocations[key] || null) === folder) contents.push(key);
  }
  return contents;
}

export function validateFolders(project, sources) {
  project.materialFolders ??= {};
  project.materialLocations ??= {};
  const folders = project.materialFolders;
  for (const [key, item] of Object.entries(folders)) {
    if (!/^[0-9a-f-]{36}$/i.test(key) || item?.id !== key || typeof item.name !== 'string' ||
        (item.parent !== null && !Object.hasOwn(folders, item.parent))) throw Error(t("素材文件夹结构无效。"));
    const seen = new Set([key]);
    for (let parent = item.parent; parent; parent = folders[parent].parent) {
      if (seen.has(parent) || !Object.hasOwn(folders, parent)) throw Error(t("素材文件夹存在循环。"));
      seen.add(parent);
    }
  }
  for (const [source, folder] of Object.entries(project.materialLocations)) {
    if (!sources.has(source) || !Object.hasOwn(folders, folder)) throw Error(t("素材文件位置无效。"));
  }
}
