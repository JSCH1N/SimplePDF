import * as pdfjs from './vendor/pdf.mjs';
import { PDFDocument } from './vendor/pdf-lib.esm.min.js';

pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.mjs';
const byId = id => document.getElementById(id);
const thumbs = byId('thumbs');
const viewport = byId('viewport');
const paper = byId('paper');
const rows = new Map();
let documentData;
let order = [];
let selected;
let past = [];
let future = [];
let opening = false;
let exporting = false;
let scale = 1;
let fit = false;
let previewVersion = 0;
let previewTask;
let dragged;
let marker;
let pointerY;
let scrollFrame;

function message(content = '', error = false) {
  const banner = byId('message');
  banner.textContent = content;
  banner.hidden = !content;
  banner.classList.toggle('error', error);
}

function syncControls() {
  const index = order.indexOf(selected);
  const ready = Boolean(documentData);
  byId('open').disabled = opening || exporting;
  byId('choose').disabled = opening;
  byId('export').disabled = !ready || opening || exporting;
  byId('undo').disabled = !past.length;
  byId('redo').disabled = !future.length;
  if (!ready) return;
  byId('page-info').textContent = `第 ${index + 1} 页 · 共 ${order.length} 页`;
  byId('position').textContent = `${index + 1} / ${order.length}`;
  byId('prev').disabled = index === 0;
  byId('next').disabled = index === order.length - 1;
  byId('target').max = order.length;
  byId('target').placeholder = String(index + 1);
  byId('fit').setAttribute('aria-pressed', fit);
}

async function openFile(file) {
  if (!file || opening || exporting) return;
  opening = true;
  syncControls();
  message('正在读取 PDF…');
  let loading;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    loading = pdfjs.getDocument({
      data: bytes.slice(),
      cMapUrl: './vendor/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: './vendor/standard_fonts/',
      isEvalSupported: false,
    });
    const pdf = await loading.promise;
    if (!pdf.numPages) throw new Error('empty PDF');
    await pdf.getPage(1);
    const original = await PDFDocument.load(bytes);
    if (original.getPageCount() !== pdf.numPages) throw new Error('page count mismatch');

    const previous = documentData;
    documentData = { pdf, original, name: file.name };
    order = Array.from({ length: pdf.numPages }, (_, index) => index + 1);
    selected = order[0];
    past = [];
    future = [];
    fit = true;
    scale = 1;
    thumbnailObserver.disconnect();
    for (const row of rows.values()) row.renderTask?.cancel();
    rows.clear();
    thumbs.replaceChildren();
    byId('empty').hidden = true;
    byId('editor').hidden = false;
    byId('filename').textContent = file.name;
    byId('filename').title = file.name;
    updateOrder();
    viewport.scrollTo(0, 0);
    renderPreview();
    previous?.pdf.destroy().catch(() => {});
    message();
  } catch (error) {
    loading?.destroy().catch(() => {});
    const encrypted = error.name === 'PasswordException' || /encrypted/i.test(error.message);
    message(encrypted ? '暂不支持编辑加密 PDF。请打开已解除加密的文件。' : '无法读取此 PDF。文件可能已损坏或格式不受支持。', true);
  } finally {
    opening = false;
    syncControls();
  }
}

function makeCanvas(page, size, maximumPixels) {
  const view = page.getViewport({ scale: size });
  const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(maximumPixels / (view.width * view.height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(view.width * ratio));
  canvas.height = Math.max(1, Math.floor(view.height * ratio));
  canvas.style.width = `${view.width}px`;
  canvas.style.height = `${view.height}px`;
  const task = page.render({
    canvasContext: canvas.getContext('2d'),
    viewport: view,
    transform: [canvas.width / view.width, 0, 0, canvas.height / view.height, 0, 0],
  });
  return { canvas, task };
}

async function renderPreview() {
  const version = ++previewVersion;
  previewTask?.cancel();
  viewport.setAttribute('aria-busy', 'true');
  try {
    const page = await documentData.pdf.getPage(selected);
    if (version !== previewVersion) return;
    if (fit) {
      const padding = parseFloat(getComputedStyle(viewport).paddingLeft) * 2;
      scale = Math.max(0.05, (viewport.clientWidth - padding) / page.getViewport({ scale: 1 }).width);
    }
    byId('zoom').textContent = `${Math.round(scale * 100)}%`;
    const { canvas, task } = makeCanvas(page, scale, 16000000);
    previewTask = task;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `原始第 ${selected} 页的预览`);
    await task.promise;
    if (version === previewVersion) paper.replaceChildren(canvas);
  } catch (error) {
    if (version === previewVersion && error.name !== 'RenderingCancelledException') {
      paper.textContent = '此页无法预览。';
    }
  } finally {
    if (version === previewVersion) viewport.setAttribute('aria-busy', 'false');
  }
}

const thumbnailObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    thumbnailObserver.unobserve(entry.target);
    renderThumbnail(entry.target, documentData);
  }
}, { root: thumbs, rootMargin: '140px 0px' });

async function renderThumbnail(row, data) {
  const tile = row.firstElementChild;
  try {
    const page = await data.pdf.getPage(Number(row.dataset.page));
    if (data !== documentData) return;
    const view = page.getViewport({ scale: 1 });
    const size = Math.min(tile.clientWidth / view.width, tile.clientHeight / view.height);
    if (size <= 0) return;
    const { canvas, task } = makeCanvas(page, size, 100000);
    row.renderTask = task;
    await task.promise;
    if (data === documentData) tile.replaceChildren(canvas);
  } catch {
    if (data === documentData) tile.textContent = '预览不可用';
  } finally {
    row.renderTask = null;
  }
}

function updateOrder() {
  const activeRow = thumbs.contains(document.activeElement) ? document.activeElement : null;
  const fragment = document.createDocumentFragment();
  order.forEach((id, index) => {
    let row = rows.get(id);
    if (!row) {
      row = document.createElement('button');
      row.type = 'button';
      row.className = 'thumb';
      row.dataset.page = id;
      row.draggable = true;
      const tile = document.createElement('span');
      tile.className = 'tile';
      tile.setAttribute('aria-hidden', 'true');
      row.append(tile, document.createElement('span'));
      rows.set(id, row);
      thumbnailObserver.observe(row);
    }
    row.lastElementChild.textContent = `第 ${index + 1} 页`;
    fragment.append(row);
  });
  thumbs.append(fragment);
  activeRow?.focus({ preventScroll: true });
  syncSelection();
}

function syncSelection() {
  for (const [id, row] of rows) row.setAttribute('aria-current', id === selected);
  byId('target').value = '';
  syncControls();
  rows.get(selected)?.scrollIntoView({ block: 'nearest' });
}

function select(id) {
  if (!id || selected === id) return;
  selected = id;
  syncSelection();
  viewport.scrollTo(0, 0);
  paper.replaceChildren();
  renderPreview();
}

function movePage(id, index) {
  const from = order.indexOf(id);
  if (from < 0 || index < 0 || index >= order.length || from === index) return;
  past.push({ order, selected });
  future = [];
  order = order.slice();
  order.splice(from, 1);
  order.splice(index, 0, id);
  const changed = selected !== id;
  selected = id;
  updateOrder();
  if (changed) renderPreview();
}

function restore(from, to) {
  if (!from.length) return;
  to.push({ order, selected });
  const state = from.pop();
  const changed = selected !== state.selected;
  ({ order, selected } = state);
  updateOrder();
  if (changed) renderPreview();
}

function showInsertion(y) {
  marker?.row.classList.remove(marker.edge);
  let low = 0;
  let high = order.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const rect = thumbs.children[mid].getBoundingClientRect();
    if (y < rect.top + rect.height / 2) high = mid;
    else low = mid + 1;
  }
  const target = thumbs.children[low] || thumbs.lastElementChild;
  const edge = low < order.length ? 'before' : 'after';
  marker = { row: target, edge };
  target.classList.add(edge);
}

function autoscroll() {
  const bounds = thumbs.getBoundingClientRect();
  const edge = 44;
  const amount = Math.max(0, edge - (bounds.bottom - pointerY)) - Math.max(0, edge - (pointerY - bounds.top));
  if (amount) {
    thumbs.scrollTop += amount / 3;
    showInsertion(pointerY);
  }
  scrollFrame = requestAnimationFrame(autoscroll);
}

function stopDrag() {
  rows.get(dragged)?.classList.remove('dragging');
  marker?.row.classList.remove(marker.edge);
  cancelAnimationFrame(scrollFrame);
  scrollFrame = null;
  marker = null;
  dragged = null;
}

thumbs.addEventListener('click', event => select(Number(event.target.closest('.thumb')?.dataset.page)));
thumbs.addEventListener('dragstart', event => {
  const row = event.target.closest('.thumb');
  if (!row) return;
  dragged = Number(row.dataset.page);
  row.classList.add('dragging');
  event.dataTransfer.setData('text/plain', String(dragged));
  event.dataTransfer.effectAllowed = 'move';
});
thumbs.addEventListener('dragover', event => {
  if (!dragged) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  pointerY = event.clientY;
  showInsertion(pointerY);
  if (!scrollFrame) scrollFrame = requestAnimationFrame(autoscroll);
});
thumbs.addEventListener('dragleave', event => {
  if (thumbs.contains(event.relatedTarget)) return;
  marker?.row.classList.remove(marker.edge);
  marker = null;
  cancelAnimationFrame(scrollFrame);
  scrollFrame = null;
});
thumbs.addEventListener('drop', event => {
  if (!dragged) return;
  event.preventDefault();
  showInsertion(event.clientY);
  if (marker) {
    const slot = order.indexOf(Number(marker.row.dataset.page)) + Number(marker.edge === 'after');
    movePage(dragged, slot - Number(order.indexOf(dragged) < slot));
  }
  stopDrag();
});
thumbs.addEventListener('dragend', stopDrag);

byId('move').addEventListener('submit', event => {
  event.preventDefault();
  movePage(selected, byId('target').valueAsNumber - 1);
});
byId('undo').onclick = () => restore(past, future);
byId('redo').onclick = () => restore(future, past);
byId('prev').onclick = () => select(order[order.indexOf(selected) - 1]);
byId('next').onclick = () => select(order[order.indexOf(selected) + 1]);
function zoom(factor) {
  fit = false;
  scale = Math.max(0.1, Math.min(5, scale * factor));
  syncControls();
  renderPreview();
}
byId('out').onclick = () => zoom(1 / 1.2);
byId('in').onclick = () => zoom(1.2);
byId('fit').onclick = () => {
  fit = true;
  syncControls();
  renderPreview();
};
let previewWidth;
new ResizeObserver(() => {
  if (previewWidth === viewport.clientWidth) return;
  previewWidth = viewport.clientWidth;
  if (fit && documentData) renderPreview();
}).observe(viewport);

const fileInput = byId('file');
byId('open').onclick = byId('choose').onclick = () => fileInput.click();
fileInput.onchange = () => {
  openFile(fileInput.files[0]);
  fileInput.value = '';
};
const dropZone = byId('drop');
window.addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
dropZone.addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('Files')) dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', event => {
  if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('drag-over');
});
window.addEventListener('drop', event => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  dropZone.classList.remove('drag-over');
  openFile(event.dataTransfer.files[0]);
});

byId('export').onclick = async () => {
  const { original, name } = documentData;
  const pages = order.map(id => id - 1);
  exporting = true;
  syncControls();
  message('正在生成 PDF…');
  try {
    const output = await PDFDocument.create();
    for (const page of await output.copyPages(original, pages)) output.addPage(page);
    const bytes = await output.save();
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name.replace(/\.pdf$/i, '')}-已编辑.pdf`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    message('已生成 PDF。');
  } catch {
    message('导出失败。当前页面顺序已保留，可以重试。', true);
  } finally {
    exporting = false;
    syncControls();
  }
};
