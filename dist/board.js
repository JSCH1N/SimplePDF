import { t, locale, currentLanguage, setLanguage } from './i18n.js';
import * as pdfjs from './vendor/pdf.mjs';
import { PDFDocument } from './vendor/pdf-lib.esm.min.js';
import { visibleSize, pointsPerMillimeter } from './page-size.js';
import { folderContents, imagePattern, loadSource, validateFolders } from './material.js';
import { setupPanels } from './panels.js';
import { composePdf, imagePng, watermarkChoices } from './pdf-output.js';
import { id, createProject, automatic, moveNodes, connect, workflow, allPages, pack, unpack, validate, layerOrder,
  parentOf, removeNode, cleanPageOrigin, migrateLegacy } from './project.js';

pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.mjs';
const $ = key => document.getElementById(key);
const board = $('board');
const scene = $('scene');
const nodes = $('nodes');
const wires = $('wires');
let project = createProject();
let sources = new Map();
let path = ['root'];
let selected;
let pickedPage;
let pickedWire;
let selectedKeys = new Set();
let selectedWires = new Set();
let fromPort;
let materialSelection = [];
let materialAnchor;
const openMaterials = new Set();
const openFolders = new Set();
let past = [];
let future = [];
let views = new Map();
const collapsed = new Set();
const previewScales = new Map();
let revision = 0;
let savedRevision = 0;
let handle;
let busy = false;
let saving;
let dragging;
let panMode = false;
let pan;
let rightGesture;
let pointerLayers;
let marquee;
let spaceHeld = false;
let menuPoint;
let creationPoint;
let noticeTimer;
let previewTask;
let previewVersion = 0;
let exportScope;
let exportName;
let exportPlan;
let exportPath;
let activeExportPanel = null;
let preparedBytes;
let exportGeneration = 0;
let watermarkGeneration = 0;
let watermarkData;
let watermarkPending = false;
const watermarkUrls = [];
let renameTarget;
let autoTimer;

const group = () => project.nodes[path.at(-1)];
const flow = () => automatic(group(), project);
const node = key => project.nodes[key];
const selectedNode = () => node(selected);
function view() {
  if (!views.has(group().id)) views.set(group().id, { x: 0, y: 0, zoom: 1 });
  return views.get(group().id);
}

function element(tag, text, className) {
  const result = document.createElement(tag);
  if (text != null) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function button(label, action, className) {
  const result = element('button', label, className);
  result.type = 'button';
  result.onclick = action;
  return result;
}
function notify(text) {
  clearTimeout(noticeTimer);
  $('notice').textContent = text;
  $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6000);
}
function snapshot() {
  return { project: structuredClone(project), sources, path: [...path], selected, pickedPage };
}
function commit(change) {
  if (busy) return false;
  const before = snapshot();
  if (change() === false) return false;
  past.push(before);
  if (past.length > 40) past.shift();
  future = [];
  revision++;
  render();
  return true;
}
function restore(from, to) {
  if (busy || !from.length) return;
  to.push(snapshot());
  const settings = project.settings;
  ({ project, sources, path, selected, pickedPage } = from.pop());
  project.settings = settings;
  fromPort = pickedWire = null;
  selectedKeys = new Set(selected ? [selected] : []);
  selectedWires.clear();
  thumbnailCache.clear();
  revision++;
  render();
}
function status() {
  const { name, autoMinutes, lastSaved } = project.settings;
  $('project-name').textContent = name;
  const current = saving ? t("正在写入磁盘…") : revision !== savedRevision ? t("有未保存的更改") : handle ? t("已保存") : t("未绑定文件");
  const last = lastSaved ? t("最近保存 {0}", new Date(lastSaved).toLocaleString(locale())) : t("尚未保存");
  $('save-state').textContent = `${current} · ${last} · ${autoMinutes ? t("每 {0} 分钟保存", autoMinutes) : t("自动保存已关闭")}`;
  $('project-name').disabled = busy || Boolean(saving);
  $('project-settings').disabled = busy || Boolean(saving);
  $('save-project').disabled = busy || Boolean(saving);
  $('exit').disabled = busy || Boolean(saving);
  $('open-project').disabled = busy || Boolean(saving);
  $('import').disabled = busy;
  $('export-all').disabled = busy;
}
function describe(item) {
  return item.kind === 'group' ? t("{0} 个节点", item.children.length) : t("{0} 页", item.pages?.length || 0);
}
function pageName(page) {
  const file = sources.get(page.source);
  return file.format === 'pdf' ? t("{0} · 原第 {1} 页", file.name, page.index + 1) : file.name;
}
function startDrag(event, payload) {
  if (board.contains(event.target) && (panMode || spaceHeld)) {
    event.preventDefault();
    return;
  }
  dragging = payload;
  event.dataTransfer.setData('text/plain', payload.kind);
  event.dataTransfer.effectAllowed = payload.kind === 'material' ? (payload.source || payload.folder ? 'copyMove' : 'copy') : 'move';
}
function clearDrop() {
  for (const item of document.querySelectorAll('.drop-target,.before,.after,.make-room,.insert-page')) {
    item.classList.remove('drop-target', 'before', 'after', 'make-room', 'insert-page');
  }
}
function allowDrop(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = dragging?.kind === 'material' ? 'copy' : 'move';
}
function choose(key, pageId, additive = false) {
  if (panMode || spaceHeld) return;
  if (key) raiseNodes([key]);
  if (!additive) {
    selectedKeys.clear();
    selectedWires.clear();
  }
  if (additive && selectedKeys.has(key)) selectedKeys.delete(key);
  else selectedKeys.add(key);
  key = selectedKeys.has(key) ? key : [...selectedKeys].at(-1);
  selected = key;
  pickedPage = pageId;
  pickedWire = null;
  updateSelection();
  renderInspector();
}
function applyLayers() {
  const order = layerOrder(group());
  const ranks = new Map(order.map((key, index) => [key, index + 2]));
  for (const card of nodes.children) card.style.zIndex = ranks.get(card.dataset.node);
}
function raiseNodes(ids, baseline = layerOrder(group())) {
  if (!ids.length) return;
  const current = layerOrder(group());
  const chosen = new Set(ids);
  const lifted = baseline.filter(key => chosen.has(key) && group().children.includes(key));
  const next = [...current.filter(key => !chosen.has(key)), ...lifted];
  if (next.length !== current.length || next.every((key, index) => key === current[index])) return;
  group().layerOrder = next;
  revision++;
  applyLayers();
  status();
}
function enter(index) {
  path = path.slice(0, index + 1);
  selected = pickedPage = pickedWire = fromPort = null;
  selectedKeys.clear();
  selectedWires.clear();
  render();
}
function openGroup(key) {
  path.push(key);
  enter(path.length - 1);
}
function updateSelection() {
  for (const card of nodes.children) card.classList.toggle('selected', selectedKeys.has(card.dataset.node) || card.dataset.node === selected);
  for (const line of wires.querySelectorAll('[data-edge]')) line.classList.toggle('active-wire', selectedWires.has(line.dataset.edge));
}
function renderInbox() {
  const list = $('inbox-list');
  const scroll = list.scrollTop;
  inboxObserver.disconnect();
  list.replaceChildren();
  const inboxIds = new Set(project.inbox);
  const used = new Map();
  for (const item of Object.values(project.nodes)) {
    if (inboxIds.has(item.id) || !item.pages) continue;
    for (const page of item.pages) {
      const key = materialKey(page);
      used.set(key, (used.get(key) || 0) + 1);
    }
  }
  function statistics(keys) {
    let count = 0, included = 0, repeated = 0;
    for (const source of keys) {
      const pages = sources.get(source).original.getPageCount();
      count += pages;
      for (let index = 0; index < pages; index++) {
        const copies = used.get(materialKey({ source, index })) || 0;
        included += Number(copies > 0);
        repeated += Number(copies > 1);
      }
    }
    return { count, included, repeated };
  }
  const summary = ({ count, included, repeated }) => t("已加入 {0} / {1} 页 · {2} 页有重复", included, count, repeated);
  function renderFile(container, source, file) {
    const count = file.original.getPageCount();
    const info = statistics([source]);
    const isImage = file.format !== 'pdf';
    const header = button('', () => {
      if (openMaterials.has(source)) openMaterials.delete(source);
      else openMaterials.add(source);
      renderInbox();
      [...list.querySelectorAll('.material-file')].find(item => item.dataset.source === source)?.focus({ preventScroll: true });
    }, 'material-file');
    header.dataset.source = source;
    header.draggable = true;
    header.ondragstart = event => startDrag(event, { kind: 'material', source,
      pages: Array.from({ length: count }, (_, index) => ({ source, index })),
    });
    header.append(element('span', `${openMaterials.has(source) ? '▾' : '▸'} ${file.name}${isImage ? '' : t(" · {0} 页", count)}`),
      element('small', isImage ? (info.repeated ? t("有重复") : t("无重复")) : summary(info)));
    header.title = file.name;
    header.setAttribute('aria-expanded', openMaterials.has(source));
    container.append(header);
    if (!openMaterials.has(source)) return;
    for (let index = 0; index < count; index++) {
      const reference = { source, index };
      const key = materialKey(reference);
      const copies = used.get(key);
      const row = button('', event => {
        const first = event.shiftKey && materialAnchor?.source === source ? materialAnchor.index : index;
        if (!event.shiftKey || materialAnchor?.source !== source) materialAnchor = reference;
        const start = Math.min(first, index);
        materialSelection = Array.from({ length: Math.abs(first - index) + 1 }, (_, i) => ({ source, index: start + i }));
        updateMaterialSelection();
      }, 'material-page');
      row.dataset.material = key;
      row.draggable = true;
      row.title = `${pageName(reference)}${copies ? t(" · 已加入 {0} 次", copies) : ''}`;
      row.append(thumbnail(reference, inboxObserver), element('span', isImage ? t("图片预览") : t("第 {0} 页", index + 1)));
      if (copies && !isImage) row.append(element('small', t("已加入 ×{0}", copies), 'used-page'));
      row.ondragstart = event => {
        const pages = materialSelection.some(page => materialKey(page) === key) ? materialSelection : [reference];
        startDrag(event, { kind: 'material', pages });
      };
      container.append(row);
    }
  }
  function renderFolder(container, parent) {
    for (const folder of Object.values(project.materialFolders)) {
      if (folder.parent !== parent) continue;
      const key = folder.id;
      const wrapper = element('div', null, 'material-folder');
      wrapper.dataset.folder = key;
      const top = element('div', null, 'material-folder-top');
      const header = button('', () => {
        if (openFolders.has(key)) openFolders.delete(key);
        else openFolders.add(key);
        renderInbox();
      }, 'material-file folder-name');
      header.setAttribute('aria-expanded', openFolders.has(key));
      header.draggable = true;
      const files = folderContents(project, sources, key);
      header.ondragstart = event => startDrag(event, { kind: 'material', folder: key,
        pages: files.flatMap(source => Array.from({ length: sources.get(source).original.getPageCount() }, (_, index) => ({ source, index }))),
      });
      header.append(element('span', `${openFolders.has(key) ? '▾' : '▸'} ${folder.name}`),
        element('small', summary(statistics(files))));
      const rename = button('✎', () => showNameDialog(`folder:${key}`));
      rename.setAttribute('aria-label', t("重命名文件夹 {0}", folder.name));
      const remove = button('×', () => deleteMaterialFolder(key), 'danger');
      remove.setAttribute('aria-label', t("删除文件夹 {0}", folder.name));
      top.append(header, rename, remove);
      wrapper.append(top);
      if (openFolders.has(key)) {
        const contents = element('div', null, 'material-folder-contents');
        renderFolder(contents, key);
        wrapper.append(contents);
      }
      attachFolderDrop(wrapper, key);
      container.append(wrapper);
    }
    for (const [source, file] of sources) {
      if ((project.materialLocations[source] || null) === parent) renderFile(container, source, file);
    }
  }
  if (Object.keys(project.materialFolders).length) {
    const root = element('div', t("素材根目录 · 拖到此处移出文件夹"), 'material-root');
    attachFolderDrop(root, null);
    list.append(root);
  }
  renderFolder(list, null);
  if (!sources.size && !Object.keys(project.materialFolders).length) list.append(element('p', t("素材库为空")));
  updateMaterialSelection();
  list.scrollTop = scroll;
}
function attachFolderDrop(target, folder) {
  function canMove() {
    if (!dragging?.source && !dragging?.folder) return false;
    for (let ancestor = folder; ancestor; ancestor = project.materialFolders[ancestor].parent) {
      if (ancestor === dragging.folder) return false;
    }
    return true;
  }
  target.ondragover = event => {
    event.stopPropagation();
    if (!canMove()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearDrop();
    target.classList.add('drop-target');
  };
  target.ondragleave = event => { if (!target.contains(event.relatedTarget)) target.classList.remove('drop-target'); };
  target.ondrop = event => {
    event.stopPropagation();
    if (!canMove()) return;
    event.preventDefault();
    const { source, folder: moving } = dragging;
    dragging = null;
    clearDrop();
    commit(() => {
      if (folder) openFolders.add(folder);
      if (moving) project.materialFolders[moving].parent = folder;
      else if (folder) project.materialLocations[source] = folder;
      else delete project.materialLocations[source];
    });
  };
}
function deleteMaterialFolder(key) {
  commit(() => {
    const parent = project.materialFolders[key].parent;
    for (const item of Object.values(project.materialFolders)) if (item.parent === key) item.parent = parent;
    for (const [source, folder] of Object.entries(project.materialLocations)) {
      if (folder !== key) continue;
      if (parent) project.materialLocations[source] = parent;
      else delete project.materialLocations[source];
    }
    delete project.materialFolders[key];
    openFolders.delete(key);
  });
}
function materialKey(page) {
  return `${page.source}:${page.index}`;
}
function updateMaterialSelection() {
  const selectedKeys = new Set(materialSelection.map(materialKey));
  for (const row of $('inbox-list').querySelectorAll('.material-page')) {
    row.setAttribute('aria-pressed', selectedKeys.has(row.dataset.material));
  }
}
function renderCrumbs() {
  const crumbs = $('crumbs');
  crumbs.replaceChildren();
  path.forEach((key, index) => {
    const crumb = button(key === 'root' ? t('主画布') : node(key).name, () => enter(index));
    crumb.setAttribute('aria-current', index === path.length - 1);
    crumb.dataset.group = key;
    crumb.ondragover = event => {
      if (!dragging || dragging.kind === 'wire') return;
      allowDrop(event);
      clearDrop();
      crumb.classList.add('drop-target');
    };
    crumb.ondrop = event => {
      if (!dragging) return;
      event.preventDefault();
      applyDrop({ destination: key });
    };
    crumbs.append(crumb);
  });
}
function layout() {
  const auto = flow();
  const available = board.clientWidth / view().zoom - 20;
  let x = 20, y = 20, rowHeight = 0;
  group().children.forEach((key, index) => {
    const item = node(key);
    const card = nodes.children[index];
    if (auto && x > 20 && x + card.offsetWidth > available) {
      x = 20;
      y += rowHeight + 24;
      rowHeight = 0;
    }
    card.style.left = `${auto ? x : item.x ?? 20 + index % 3 * 225}px`;
    card.style.top = `${auto ? y : item.y ?? 20 + Math.floor(index / 3) * 300}px`;
    if (auto) {
      x += card.offsetWidth + 26;
      rowHeight = Math.max(rowHeight, card.offsetHeight);
    }
  });
  drawWires();
}
function transform() {
  const { x, y, zoom } = view();
  scene.style.transform = `translate(${x}px,${y}px) scale(${zoom})`;
  $('reset-view').textContent = `${Math.round(zoom * 100)}%`;
}
function finishWire(to) {
  const from = fromPort;
  fromPort = null;
  if (!from) return;
  if (!commit(() => {
    const scope = group();
    const previous = scope.links[from];
    if (previous === to) return false;
    delete scope.links[from];
    if (connect(scope, from, to, project)) return true;
    if (previous) scope.links[from] = previous;
    return false;
  })) {
    notify(t("无法连接。每个节点只允许一个入口和出口，且路径不能成环。"));
    renderBoard();
  }
}
function attachResize(card, item) {
  const resize = button('', null, 'resize-group');
  resize.title = t("拖动调整 {0} 大小", item.kind === 'group' ? 'Collection' : item.kind === 'page' ? 'Page' : item.name);
  resize.setAttribute('aria-label', resize.title);
  resize.ondblclick = event => event.stopPropagation();
  const size = (width, height) => {
    card.style.width = `${Math.max(198, width)}px`;
    card.style.height = `${Math.max(item.kind === 'group' ? 148 : item.kind === 'page' ? 190 : 95, height)}px`;
  };
  size(Number.isFinite(item.width) ? item.width : 224,
    Number.isFinite(item.height) ? item.height : item.kind === 'start' ? 170 : item.kind === 'over' ? 115 : 250);
  const commitSize = () => commit(() => {
    item.width = card.offsetWidth;
    item.height = card.offsetHeight;
  });
  resize.onkeydown = event => {
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (busy || !Object.hasOwn(directions, event.key)) return;
    event.preventDefault();
    const [x, y] = directions[event.key];
    size(card.offsetWidth + x * 16, card.offsetHeight + y * 16);
    if (commitSize()) nodes.querySelector('.resize-group[data-owner="' + item.id + '"]')?.focus();
  };
  resize.dataset.owner = item.id;
  resize.onpointerdown = event => {
    if (busy || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const { clientX, clientY, pointerId } = event;
    const width = card.offsetWidth, height = card.offsetHeight, zoom = view().zoom;
    resize.setPointerCapture(pointerId);
    resize.onpointermove = move => {
      size(width + (move.clientX - clientX) / zoom, height + (move.clientY - clientY) / zoom);
      drawWires();
    };
    resize.onlostpointercapture = () => {
      resize.onpointermove = null;
      if (card.offsetWidth !== width || card.offsetHeight !== height) commitSize();
    };
    resize.onpointercancel = () => size(width, height);
  };
  card.append(resize);
}
const thumbnailCache = new Map();
function watchThumbnails(root) {
  return new IntersectionObserver((entries, observer) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      observer.unobserve(target);
      paintThumbnail(target, target.reference);
    }
  }, { root, rootMargin: '80px' });
}
const thumbnailObserver = watchThumbnails(board);
const inboxObserver = watchThumbnails($('inbox-list'));
const inspectorObserver = watchThumbnails($('inspector'));
function thumbnail(reference, observer = thumbnailObserver) {
  const canvas = element('canvas', null, 'page-thumb');
  canvas.reference = reference;
  canvas.setAttribute('aria-hidden', 'true');
  observer.observe(canvas);
  return canvas;
}

async function getPdfPage(reference) {
  const file = sources.get(reference.source);
  file.preview ||= pdfjs.getDocument({
    data: file.bytes.slice(), cMapUrl: './vendor/cmaps/', cMapPacked: true,
    standardFontDataUrl: './vendor/standard_fonts/', isEvalSupported: false,
  }).promise;
  return (await file.preview).getPage(reference.index + 1);
}
async function makeThumbnail(reference) {
  const page = await getPdfPage(reference);
  const natural = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(480 / natural.width, 480 / natural.height) });
  const canvas = element('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}
async function paintThumbnail(canvas, reference) {
  const key = `${reference.source}:${reference.index}`;
  try {
    if (!canvas.isConnected) return;
    if (!thumbnailCache.has(key)) {
      if (thumbnailCache.size >= 128) thumbnailCache.delete(thumbnailCache.keys().next().value);
      thumbnailCache.set(key, makeThumbnail(reference));
    }
    const image = await thumbnailCache.get(key);
    if (!canvas.isConnected) return;
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d').drawImage(image, 0, 0);
    canvas.dataset.ready = 'true';
  } catch {
    if (canvas.isConnected) canvas.replaceWith(element('span', t("预览不可用"), 'thumb-error'));
  }
}
function textPreview(item) {
  function listFor(items) {
    const list = element('ul');
    for (const child of items) {
      if (child.kind === 'group') {
        const row = element('li', child.name);
        row.append(listFor(child.children.map(node)));
        list.append(row);
      } else if (child.pages) {
        if (!child.pages.length) list.append(element('li', t("空 Page")));
        for (const page of child.pages) list.append(element('li', pageName(page)));
      }
    }
    return list;
  }
  const preview = element('div', null, 'text-preview');
  preview.append(listFor(item.kind === 'group' ? item.children.map(node) : [item]));
  if (!preview.firstChild.children.length) preview.textContent = t("暂无页面");
  return preview;
}
function renderBoard() {
  thumbnailObserver.disconnect();
  nodes.replaceChildren();
  for (const key of group().children) {
    const item = node(key);
    const card = element('article', null, `node ${item.kind}`);
    const compact = collapsed.has(key) && ['page', 'group'].includes(item.kind);
    card.classList.toggle('compact', compact);
    card.dataset.node = key;
    card.draggable = true;
    card.addEventListener('pointerdown', event => {
      if (event.button !== 0 || panMode || spaceHeld || event.target.closest('.card-actions')) return;
      pointerLayers = { scope: group().id, order: layerOrder(group()) };
      raiseNodes([key]);
    }, { capture: true });
    card.onclick = event => choose(key, undefined, event.shiftKey);
    card.ondblclick = event => {
      if (event.target.closest('.card-actions,.port,.resize-group') || panMode || spaceHeld) return;
      if (item.kind === 'group') openGroup(key);
    };
    card.ondragstart = event => {
      if (event.target !== card) return;
      dragNodes(event, card);
    };
    const title = button(item.name, event => { event.stopPropagation(); choose(key, undefined, event.shiftKey); }, 'node-title');
    title.title = item.name;
    const endpoint = ['start', 'over'].includes(item.kind);
    if (!endpoint && (!compact || item.kind === 'group')) card.append(element('span', item.kind === 'group' ? 'COLLECTION' : item.kind === 'page' ? 'PAGE' : 'PDF', 'eyebrow'));
    card.append(title);
    if (!endpoint) card.append(element('small', describe(item)));
    if (endpoint || ['group', 'page'].includes(item.kind)) {
      const actions = element('div', null, 'card-actions');
      if (!endpoint) {
        const toggle = button('', event => {
          event.stopPropagation();
          if (compact) collapsed.delete(key);
          else collapsed.add(key);
          renderBoard();
        }, compact ? 'icon-expand' : 'icon-collapse');
        toggle.setAttribute('aria-label', compact ? t("查看缩略图") : t("收起缩略图"));
        toggle.title = compact ? t("查看缩略图") : t("收起缩略图");
        actions.append(toggle);
      }
      const remove = button('', event => {
        event.stopPropagation();
        choose(key);
        deleteSelection();
      }, 'danger icon-delete');
      remove.setAttribute('aria-label', t("删除此元件"));
      remove.title = t("删除此元件");
      actions.append(remove);
      card.append(actions);
      if (compact && Number.isFinite(item.width)) card.style.width = `${item.width}px`;
    }
    if (endpoint) {
      appendWorkflow(card, item, true);
      attachResize(card, item);
    }
    if (compact) card.append(textPreview(item));
    if (item.kind === 'group' && !compact) {
      const previews = element('div', null, 'group-previews');
      previews.style.setProperty('--tile', `${previewScales.get(key) || 76}px`);
      const visit = child => {
        if (child.kind === 'group') child.children.forEach(childId => visit(node(childId)));
        else child.pages?.forEach(page => {
          const tile = element('div', null, 'group-preview');
          tile.title = pageName(page);
          tile.append(thumbnail(page));
          tile.draggable = true;
          tile.ondragstart = event => {
            event.stopPropagation();
            startDrag(event, { kind: 'page', owner: child.id, page: page.id });
          };
          previews.append(tile);
        });
      };
      item.children.forEach(child => visit(node(child)));
      if (previews.childElementCount) card.append(previews);
      attachResize(card, item);
    }
    if (item.kind === 'page' && !compact) attachResize(card, item);
    if (item.kind === 'page' && !compact && !item.pages.length) card.append(element('div', t("拖入一页或一张图片"), 'empty-page'));
    if (item.kind === 'pdf') {
      card.append(button(collapsed.has(key) ? t("展开页面") : t("收起页面"), event => {
        event.stopPropagation();
        if (collapsed.has(key)) collapsed.delete(key);
        else collapsed.add(key);
        renderBoard();
      }, 'enter'));
    }
    if (!compact && (item.kind === 'page' || (item.kind === 'pdf' && !collapsed.has(key)))) {
        const slots = element('div', null, 'card-pages');
        for (const [index, page] of item.pages.entries()) {
          const row = button(`${index + 1} · ${pageName(page)}`, event => {
            event.stopPropagation();
            choose(key, page.id, event.shiftKey);
          }, 'card-page');
          row.title = pageName(page);
          row.setAttribute('aria-label', pageName(page));
          const caption = element('span', row.textContent);
          row.replaceChildren(thumbnail(page), caption);
          row.dataset.slot = page.id;
          row.draggable = true;
          row.ondragstart = event => {
            event.stopPropagation();
            if (item.kind === 'page' && selectedKeys.has(key) && selectedKeys.size > 1) {
              dragNodes(event, card);
              return;
            }
            startDrag(event, { kind: 'page', owner: key, page: page.id });
          };
          slots.append(row);
        }
        card.append(slots);
    }
    if (item.kind !== 'pdf') {
      const input = button('', event => { event.stopPropagation(); finishWire(key); }, 'port input');
      const output = button('', event => {
        event.stopPropagation();
        fromPort = fromPort === key ? null : key;
        for (const port of nodes.querySelectorAll('.port.output')) {
          port.classList.toggle('armed', port.closest('.node').dataset.node === fromPort);
        }
        if (fromPort) notify(t("选择下一个节点的左侧端口。"));
      }, 'port output');
      input.setAttribute('aria-label', t("{0} 的入口", item.name));
      const incoming = Object.keys(group().links).find(from => group().links[from] === key);
      if (incoming) {
        input.draggable = true;
        input.title = t("拖动到另一个入口以重接");
        input.ondragstart = event => {
          event.stopPropagation();
          fromPort = incoming;
          startDrag(event, { kind: 'wire' });
        };
      }
      output.setAttribute('aria-label', t("{0} 的出口", item.name));
      output.classList.toggle('armed', fromPort === key);
      output.draggable = true;
      output.ondragstart = event => {
        event.stopPropagation();
        fromPort = key;
        startDrag(event, { kind: 'wire' });
      };
      if (item.kind !== 'start') card.append(input);
      if (item.kind !== 'over') card.append(output);
    }
    card.classList.toggle('selected', selectedKeys.has(key) || key === selected);
    nodes.append(card);
  }
  $('mode').textContent = panMode ? t("左键拖动画布") : t("左键框选 · Shift 多选 · 空格＋拖动平移");
  $('hint').hidden = group().children.length > 0;
  $('hint').textContent = flow() ? t("将页面拖到集合中，或手动创建子集合。") : t("从左侧拖入独立页面，或从「添加」创建集合。");
  transform();
  layout();
  applyLayers();
}
function dragNodes(event, card) {
  const key = card.dataset.node;
  const ids = selectedKeys.has(key) ? group().children.filter(child => selectedKeys.has(child)) : [key];
  const baseline = pointerLayers?.scope === group().id ? pointerLayers.order : layerOrder(group());
  raiseNodes(ids, baseline);
  pointerLayers = null;
  const rect = card.getBoundingClientRect();
  const zoom = view().zoom;
  startDrag(event, { kind: 'nodes', ids, anchor: key,
    offset: { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom },
    positions: new Map([...nodes.children].filter(item => ids.includes(item.dataset.node))
      .map(item => [item.dataset.node, { x: item.offsetLeft - card.offsetLeft, y: item.offsetTop - card.offsetTop }])),
  });
}
function freeCurrentLayout() {
  if (!flow()) return;
  for (const card of nodes.children) {
    Object.assign(node(card.dataset.node), { x: card.offsetLeft, y: card.offsetTop });
  }
  group().freeLayout = true;
}
function appendWorkflow(container, item, compact) {
  const plan = workflow(project, group(), item.id);
  container.append(element('small', plan.complete
    ? t("已连通 · {0} 页{1}", plan.pages.length, plan.emptyPages.length ? t(" · {0} 个空 Page", plan.emptyPages.length) : '') : plan.issue, 'workflow-state'));
  if (item.kind === 'over') {
    const action = button(t("导出此工作流"), event => {
      event.stopPropagation();
      showExport(item.id);
    }, 'primary workflow-export');
    action.disabled = !plan.complete || (!plan.pages.length && !plan.emptyPages.length);
    container.append(action);
    return;
  }
  function tree(entries) {
    const list = element('ul');
    for (const entry of entries) {
      const row = element('li', entry.page ? pageName(entry.page) : entry.item.name);
      if (entry.item?.kind !== 'page' && entry.children?.length) row.append(tree(entry.children));
      list.append(row);
    }
    return list;
  }
  const outline = element('div', null, compact ? 'workflow-outline' : 'workflow-detail');
  outline.append(tree(plan.outline));
  container.append(outline);
}
function drawWires() {
  wires.replaceChildren();
  const ns = 'http://www.w3.org/2000/svg';
  const cards = new Map([...nodes.children].map(card => [card.dataset.node, card]));
  for (const [from, to] of Object.entries(group().links)) {
    const a = cards.get(from);
    const b = cards.get(to);
    const outlet = a?.querySelector('.output'), inlet = b?.querySelector('.input');
    if (!outlet || !inlet) continue;
    const x1 = a.offsetLeft + a.offsetWidth, y1 = a.offsetTop + outlet.offsetTop + 9;
    const x2 = b.offsetLeft, y2 = b.offsetTop + inlet.offsetTop + 9;
    const bend = Math.max(30, Math.abs(x2 - x1) * 0.45);
    const curve = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
    const line = document.createElementNS(ns, 'path');
    line.setAttribute('d', `${curve} m-9,-5 l9,5 -9,5`);
    line.dataset.edge = from;
    if (selectedWires.has(from) || pickedWire === from) line.setAttribute('class', 'active-wire');
    const hit = document.createElementNS(ns, 'path');
    hit.setAttribute('d', curve);
    hit.setAttribute('class', 'wire-hit');
    hit.dataset.edgeHit = from;
    hit.onclick = event => {
      if (panMode || spaceHeld) return;
      selected = pickedPage = null;
      if (!event.shiftKey) {
        selectedKeys.clear();
        selectedWires.clear();
      }
      if (selectedWires.has(from)) selectedWires.delete(from);
      else selectedWires.add(from);
      pickedWire = selectedWires.has(from) ? from : [...selectedWires].at(-1);
      updateSelection();
      renderInspector();
    };
    hit.ondblclick = () => commit(() => {
      delete group().links[from];
      pickedWire = null;
      selectedWires.delete(from);
    });
    wires.append(line, hit);
  }
}
function renderInspector() {
  const panel = $('inspector');
  const oldScroll = $('page-list')?.scrollTop ?? 0;
  const item = selectedNode();
  $('delete-selection').disabled = busy || (!item && !selectedKeys.size && !selectedWires.size);
  previewVersion++;
  previewTask?.cancel();
  inspectorObserver.disconnect();
  panel.replaceChildren();
  if (selectedKeys.size + selectedWires.size > 1) {
    panel.append(element('h2', t("已选中 {0} 个组件 · {1} 条连线", selectedKeys.size, selectedWires.size)),
      button(t("删除选中项"), deleteSelection, 'danger'));
    return;
  }
  if (pickedWire && group().links[pickedWire]) {
    panel.append(element('h2', t("合并连线")), element('p', `${node(pickedWire).name} → ${node(group().links[pickedWire]).name}`),
      button(t("断开连线"), deleteSelection, 'danger'));
    return;
  }
  if (!item) {
    panel.append(element('h2', t("属性")), element('p', t("选择页面查看属性，或进入集合编辑内部顺序。")));
    return;
  }
  panel.append(element('h2', item.name));
  if (item.kind === 'start' || item.kind === 'over') {
    appendWorkflow(panel, item, false);
    panel.append(button(t("删除组件"), deleteSelection, 'danger'));
    return;
  }
  if (item.kind === 'group') {
    const actions = element('div', null, 'detail-actions');
    actions.append(button(t("进入集合"), () => openGroup(item.id)),
      button(t("重命名"), () => showNameDialog(item.id)),
      button(t("删除集合"), deleteSelection, 'danger'));
    panel.append(element('p', `${describe(item)} · ${automatic(item, project) ? t("自动排序") : t("连线排序")}`), actions,
      element('h3', t('集合内容')), collectionThumbnails(item));
    return;
  }
  if (!item.pages.some(page => page.id === pickedPage)) pickedPage = item.pages[0]?.id;
  const actions = element('div', null, 'detail-actions');
  actions.append(button(item.kind === 'page' ? t("删除页面") : t("删除 PDF 节点"), deleteSelection, 'danger'));
  if (item.kind === 'pdf' && pickedPage) actions.append(button(t("删除选中页"), () => deleteSelection(true), 'danger'));
  panel.append(actions);
  panel.append(element('p', t("拖动页面行到 PDF 节点或集合，也可以在列表内重排。")));
  const preview = element('canvas');
  preview.id = 'preview';
  preview.hidden = true;
  panel.append(preview);
  const list = element('div');
  list.id = 'page-list';
  for (const [index, page] of item.pages.entries()) {
    const row = button('', () => choose(item.id, page.id), `page-row${page.id === pickedPage ? ' selected' : ''}`);
    row.draggable = true;
    row.title = pageName(page);
    row.dataset.page = page.id;
    row.append(element('strong', String(index + 1)), element('span', pageName(page)));
    row.ondragstart = event => startDrag(event, { kind: 'page', owner: item.id, page: page.id });
    row.ondragover = event => {
      if (dragging?.kind !== 'page') return;
      allowDrop(event);
      clearDrop();
      row.classList.add('insert-page');
    };
    row.ondrop = event => {
      event.preventDefault();
      if (dragging?.kind === 'page') applyDrop({ pdf: item.id, before: page.id });
    };
    list.append(row);
  }
  panel.append(list);
  list.scrollTop = oldScroll;
  const active = item.pages.find(page => page.id === pickedPage);
  if (active) renderPreview(preview, active);
  else panel.append(element('p', t("此 PDF 节点暂时没有页面。可将其他页面拖入。")));
}
function collectionThumbnails(collection) {
  const contents = element('div', null, 'inspector-collection');
  function append(items, container) {
    for (const item of items) {
      if (item.kind === 'group') {
        const section = element('section', null, 'inspector-subcollection');
        section.append(element('strong', item.name));
        const children = element('div', null, 'inspector-collection');
        append(item.children.map(node), children);
        if (!item.children.length) children.append(element('small', t("暂无页面")));
        section.append(children);
        container.append(section);
      } else if (item.pages) {
        if (!item.pages.length) container.append(element('div', t("空 Page"), 'inspector-marker'));
        for (const page of item.pages) {
          const figure = element('figure');
          figure.title = pageName(page);
          figure.dataset.previewPage = page.id;
          figure.append(thumbnail(page, inspectorObserver), element('figcaption', pageName(page)));
          container.append(figure);
        }
      } else {
        container.append(element('div', item.name, 'inspector-marker'));
      }
    }
  }
  append(collection.children.map(node), contents);
  if (!collection.children.length) contents.append(element('small', t("暂无页面")));
  return contents;
}
function deleteSelection(pageOnly = false) {
  const item = selectedNode();
  const removed = commit(() => {
    if (pageOnly === true && item?.kind === 'pdf') {
      const parent = parentOf(project, item.id);
      if (!parent) return false;
      item.pages = item.pages.filter(page => page.id !== pickedPage);
      cleanPageOrigin(project, parent, item);
    } else {
      const scope = group();
      const keys = scope.children.filter(key => selectedKeys.has(key) || key === selected);
      if (!keys.length && !selectedWires.size) return false;
      for (const from of selectedWires) delete scope.links[from];
      const removesPage = keys.some(key => Boolean(node(key).pages));
      for (const key of keys) removeNode(project, scope, key);
      if (removesPage) cleanPageOrigin(project, scope);
    }
    normalizePath();
    selectedKeys.clear();
    selectedWires.clear();
    selected = pickedPage = pickedWire = fromPort = null;
  });
  if (removed) notify(t("已删除，可撤销。"));
}
$('delete-selection').onclick = deleteSelection;
window.addEventListener('keydown', event => {
  if (event.key !== 'Delete' || event.defaultPrevented || document.querySelector('dialog[open]') ||
      event.target.closest?.('input,textarea,select,[contenteditable]') || $('delete-selection').disabled) return;
  event.preventDefault();
  deleteSelection();
});
async function renderPreview(canvas, reference) {
  const version = previewVersion;
  try {
    const page = await getPdfPage(reference);
    if (version !== previewVersion) return;
    const natural = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(360 / natural.width, 430 / natural.height) });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.setAttribute('aria-label', pageName(reference));
    previewTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
    await previewTask.promise;
    if (version === previewVersion) canvas.hidden = false;
  } catch {
    if (version === previewVersion) notify(t("此页无法预览。"));
  }
}
function render() {
  renderInbox();
  renderCrumbs();
  renderBoard();
  renderInspector();
  $('undo').disabled = busy || !past.length;
  $('redo').disabled = busy || !future.length;
  status();
}

function localPoint(event) {
  const rect = board.getBoundingClientRect();
  const { x, y, zoom } = view();
  return { x: (event.clientX - rect.left - x) / zoom, y: (event.clientY - rect.top - y) / zoom };
}
function dropLocation(event) {
  const card = event.target.closest('.node');
  const key = card?.dataset.node;
  const item = node(key);
  if (dragging.kind === 'wire') return event.target.closest('.port.input') ? { wire: key, card } : null;
  if (item?.kind === 'page') {
    const single = dragging.kind === 'page' && dragging.owner !== key ||
      dragging.kind === 'material' && dragging.pages.length === 1 ||
      dragging.kind === 'nodes' && dragging.ids.length === 1 && dragging.ids[0] !== key &&
      node(dragging.ids[0]).kind === 'page' && node(dragging.ids[0]).pages.length === 1;
    const bounds = card.getBoundingClientRect();
    const inside = event.clientX > bounds.left + 12 && event.clientX < bounds.right - 12;
    if (single && (item.placeholder || !flow() || inside)) return { fill: key, card };
  }
  if (item?.kind === 'group' && !dragging.ids?.includes(key)) return { destination: key, card };
  if (dragging.kind === 'page' && item?.kind === 'pdf') {
    const slot = event.target.closest('.card-page');
    if (slot) {
      const rect = slot.getBoundingClientRect();
      const after = event.clientY >= rect.top + rect.height / 2;
      const index = item.pages.findIndex(page => page.id === slot.dataset.slot);
      return { pdf: key, before: item.pages[index + Number(after)]?.id, slot, edge: after ? 'after' : 'before' };
    }
    const rect = card.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2 ? item.pages[0]?.id : undefined;
    return { pdf: key, before, card, edge: before ? 'before' : 'after' };
  }
  if (!flow() && dragging.kind === 'material' && item?.pages && group().id !== 'root') {
    const rect = card.getBoundingClientRect();
    const after = event.clientX >= rect.left + rect.width / 2;
    const before = after ? group().children[group().children.indexOf(key) + 1] : key;
    return { destination: group().id, before, card, edge: after ? 'after' : 'before',
      point: { x: card.offsetLeft + (after ? card.offsetWidth + 26 : 0), y: card.offsetTop } };
  }
  if (flow() && card) {
    if (dragging.kind === 'nodes' && dragging.ids.length > 1 && dragging.ids.includes(key)) {
      const point = localPoint(event);
      return { destination: group().id, free: true, point: {
        x: point.x - dragging.offset.x, y: point.y - dragging.offset.y,
      } };
    }
    const rect = card.getBoundingClientRect();
    const after = event.clientX >= rect.left + rect.width / 2;
    const before = after ? group().children[group().children.indexOf(key) + 1] : key;
    return { destination: group().id, before, card, edge: after ? 'after' : 'before' };
  }
  const point = localPoint(event);
  if (dragging.offset) {
    point.x -= dragging.offset.x;
    point.y -= dragging.offset.y;
  }
  const free = flow() && dragging.kind === 'nodes' && dragging.ids.length > 1;
  return { destination: group().id, free, point: flow() && !free ? undefined : point };
}
function applyDrop(target) {
  const payload = dragging;
  dragging = null;
  clearDrop();
  if (!payload || !target) return;
  if (target.wire) {
    finishWire(target.wire);
    return;
  }
  if (target.fill) {
    commit(() => {
      if (payload.kind === 'material') fillPage(target.fill, { ...payload.pages[0], id: id() });
      else {
        const origin = node(payload.owner || payload.ids[0]);
        const parent = parentOf(project, origin.id);
        const index = payload.owner ? origin.pages.findIndex(page => page.id === payload.page) : 0;
        if (index < 0) return false;
        const [page] = origin.pages.splice(index, 1);
        fillPage(target.fill, page);
        cleanPageOrigin(project, parent, origin);
        normalizePath();
      }
    });
    return;
  }
  if (payload.kind === 'nodes') {
    commit(() => {
      const origin = parentOf(project, payload.ids[0]);
      const targetGroup = node(target.destination);
      const edges = origin?.id !== target.destination ? Object.entries(origin?.links || {})
        .filter(([from, to]) => payload.ids.includes(from) && payload.ids.includes(to)) : [];
      if (target.free) freeCurrentLayout();
      let point = target.point;
      if (!point && origin?.id !== target.destination && payload.ids.length > 1 && payload.positions) {
        const minX = Math.min(...[...payload.positions.values()].map(delta => delta.x));
        const minY = Math.min(...[...payload.positions.values()].map(delta => delta.y));
        const bottom = Math.max(20, ...targetGroup.children.map(key => (node(key).y || 20) + (node(key).height || 250) + 24));
        point = { x: 20 - minX, y: bottom - minY };
      }
      if (!moveNodes(project, payload.ids, target.destination, target.before, point)) return false;
      if (point && origin?.id !== target.destination && payload.ids.length > 1) targetGroup.freeLayout = true;
      for (const [from, to] of edges) connect(targetGroup, from, to, project);
      if (point && payload.positions) {
        for (const key of payload.ids) {
          const delta = payload.positions.get(key);
          Object.assign(node(key), { x: point.x + delta.x, y: point.y + delta.y });
        }
      }
      if (origin?.id !== target.destination && payload.ids.some(key => Boolean(node(key).pages))) cleanPageOrigin(project, origin);
      normalizePath();
      selected = target.destination === group().id ? payload.ids[0] : target.card?.dataset.node;
      selectedKeys = new Set(target.destination === group().id ? payload.ids : selected ? [selected] : []);
      selectedWires.clear();
      pickedPage = pickedWire = null;
    });
    return;
  }
  if (payload.kind === 'material') {
    if (!payload.pages.length) return;
    commit(() => {
      const keys = payload.pages.map(reference => makePageNode({ ...reference, id: id() }));
      if (target.edge && target.point) {
        for (const card of nodes.children) {
          if (card.offsetTop === target.point.y && card.offsetLeft >= target.point.x) {
            node(card.dataset.node).x = card.offsetLeft + keys.length * 250;
          }
        }
      }
      moveNodes(project, keys, target.destination, target.before, target.point);
      if (target.point) {
        const camera = view();
        const right = (board.clientWidth - camera.x) / camera.zoom;
        const columns = target.edge ? keys.length : Math.max(1, Math.floor((right - target.point.x) / 250));
        keys.forEach((key, index) => Object.assign(node(key), {
          x: target.point.x + index % columns * 250,
          y: target.point.y + Math.floor(index / columns) * 276,
        }));
      }
      selected = target.destination === group().id ? keys[0] : target.card?.dataset.node;
      selectedKeys = new Set(selected ? [selected] : []);
      selectedWires.clear();
      pickedPage = pickedWire = null;
    });
    return;
  }
  if (payload.kind !== 'page') return;
  commit(() => {
    const origin = node(payload.owner);
    const originGroup = parentOf(project, origin.id);
    const index = origin.pages.findIndex(page => page.id === payload.page);
    if (index < 0 || target.before === payload.page) return false;
    const [page] = origin.pages.splice(index, 1);
    if (target.pdf) {
      const targetNode = node(target.pdf);
      const at = targetNode.pages.findIndex(reference => reference.id === target.before);
      targetNode.pages.splice(at < 0 ? targetNode.pages.length : at, 0, page);
      selected = target.pdf;
    } else {
      const key = origin.kind === 'page' && !origin.pages.length ? origin.id : makePageNode(page);
      if (key === origin.id) {
        origin.pages.push(page);
        if (!moveNodes(project, [key], target.destination, target.before, target.point)) return false;
      } else {
        moveNodes(project, [key], target.destination, target.before, target.point);
      }
      selected = target.destination === group().id ? key : target.card?.dataset.node;
    }
    cleanPageOrigin(project, originGroup, origin);
    normalizePath();
    selectedKeys = new Set(selected ? [selected] : []);
    selectedWires.clear();
    pickedPage = page.id;
    pickedWire = null;
  });
}
function fillPage(key, page) {
  const target = node(key);
  target.pages = [page];
  target.name = pageName(page);
  selected = key;
  selectedKeys = new Set([key]);
  selectedWires.clear();
  pickedPage = page.id;
  pickedWire = fromPort = null;
}

function makePageNode(page) {
  const key = id();
  project.nodes[key] = { id: key, kind: 'page', name: pageName(page), pages: [page] };
  return key;
}
function normalizePath() {
  while (!node(path.at(-1))) path.pop();
}

board.ondragover = event => {
  if (!busy && !panMode && event.dataTransfer.types.includes('Files') && event.target.closest('.node.page')) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    clearDrop();
    event.target.closest('.node.page').classList.add('drop-target');
    return;
  }
  if (!dragging || busy || panMode || spaceHeld) return;
  const target = dropLocation(event);
  if (!target) return;
  allowDrop(event);
  clearDrop();
  if (target.edge) {
    (target.slot || target.card).classList.add(target.edge);
    if (flow() && target.destination && target.before) {
      for (let index = group().children.indexOf(target.before); index < nodes.children.length; index++) {
        nodes.children[index].classList.add('make-room');
      }
    }
  } else target.card?.classList.add('drop-target');
};
board.ondragleave = event => {
  if (!board.contains(event.relatedTarget)) clearDrop();
};
board.ondrop = event => {
  const card = event.target.closest('.node.page');
  const files = [...event.dataTransfer.files];
  if (!busy && !panMode && card && files.length === 1 && imagePattern.test(files[0].name)) {
    event.preventDefault();
    event.stopPropagation();
    clearDrop();
    importFiles(files, card.dataset.node);
    return;
  }
  if (!dragging || busy || panMode || spaceHeld) return;
  event.preventDefault();
  applyDrop(dropLocation(event));
};
window.addEventListener('dragend', () => {
  pointerLayers = null;
  if (dragging?.kind === 'wire') {
    fromPort = null;
    renderBoard();
  }
  dragging = null;
  clearDrop();
});
window.addEventListener('pointerup', () => { pointerLayers = null; });

function zoom(factor, x = board.clientWidth / 2, y = board.clientHeight / 2) {
  const camera = view();
  const next = Math.max(0.15, Math.min(3, camera.zoom * factor));
  const ratio = next / camera.zoom;
  camera.x = x - (x - camera.x) * ratio;
  camera.y = y - (y - camera.y) * ratio;
  camera.zoom = next;
  revision++;
  status();
  transform();
  layout();
}
board.addEventListener('wheel', event => {
  if (!event.ctrlKey && !event.metaKey && event.target.closest('.card-pages,.group-previews,.text-preview,.workflow-outline')) return;
  event.preventDefault();
  const previews = event.target.closest('.group-previews');
  if (event.ctrlKey && previews && !panMode) {
    const key = previews.closest('.node').dataset.node;
    const size = Math.min(260, Math.max(36, (previewScales.get(key) || 76) * Math.exp(-event.deltaY / 400)));
    previewScales.set(key, size);
    previews.style.setProperty('--tile', `${size}px`);
    return;
  }
  const rect = board.getBoundingClientRect();
  if (event.ctrlKey || event.metaKey) zoom(Math.exp(-event.deltaY / 400), event.clientX - rect.left, event.clientY - rect.top);
  else {
    view().x -= event.deltaX;
    view().y -= event.deltaY;
    revision++;
    status();
    transform();
  }
}, { passive: false });
board.onpointerdown = event => {
  if (event.target.closest('#canvas-menu')) return;
  $('canvas-menu').hidden = true;
  rightGesture = event.button === 2 ? { moved: false, overNode: Boolean(event.target.closest('.node,.wire-hit')) } : null;
  const shouldPan = event.button === 1 || event.button === 2 || (event.button === 0 && (panMode || spaceHeld));
  if (!shouldPan && (event.button !== 0 || event.target.closest('.node,.wire-hit'))) return;
  event.preventDefault();
  board.focus({ preventScroll: true });
  board.setPointerCapture(event.pointerId);
  if (shouldPan) {
    pan = { clientX: event.clientX, clientY: event.clientY, x: view().x, y: view().y };
    board.classList.add('panning');
  } else {
    marquee = { x: event.clientX, y: event.clientY, extend: event.shiftKey };
    drawMarquee(event);
  }
};
board.onpointermove = event => {
  if (marquee) drawMarquee(event);
  if (!pan) return;
  if (rightGesture && !rightGesture.moved) {
    if (Math.hypot(event.clientX - pan.clientX, event.clientY - pan.clientY) < 4) return;
    rightGesture.moved = true;
  }
  view().x = pan.x + event.clientX - pan.clientX;
  view().y = pan.y + event.clientY - pan.clientY;
  transform();
};
board.onlostpointercapture = () => {
  marquee = null;
  $('selection-box').hidden = true;
  if (!pan) return;
  if (view().x !== pan.x || view().y !== pan.y) revision++;
  pan = null;
  status();
  board.classList.remove('panning');
};
function selectionRect(event) {
  return { left: Math.min(marquee.x, event.clientX), right: Math.max(marquee.x, event.clientX),
    top: Math.min(marquee.y, event.clientY), bottom: Math.max(marquee.y, event.clientY) };
}
function drawMarquee(event) {
  const box = $('selection-box');
  const rect = selectionRect(event);
  const origin = board.getBoundingClientRect();
  Object.assign(box.style, {
    left: `${rect.left - origin.left}px`, top: `${rect.top - origin.top}px`,
    width: `${rect.right - rect.left}px`, height: `${rect.bottom - rect.top}px`,
  });
  box.hidden = false;
}
function touchesWire(line, rect) {
  const matrix = line.getScreenCTM();
  const length = line.getTotalLength();
  const steps = Math.max(1, Math.ceil(length * view().zoom / 4));
  for (let i = 0; i <= steps; i++) {
    const { x, y } = line.getPointAtLength(length * i / steps).matrixTransform(matrix);
    if (x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 3 && y <= rect.bottom + 3) return true;
  }
  return false;
}
board.onpointerup = event => {
  if (!marquee) return;
  const rect = selectionRect(event);
  if (!marquee.extend) {
    selectedKeys.clear();
    selectedWires.clear();
  }
  if (rect.right - rect.left >= 3 || rect.bottom - rect.top >= 3) {
    for (const card of nodes.children) {
      const box = card.getBoundingClientRect();
      if (box.right >= rect.left && box.left <= rect.right && box.bottom >= rect.top && box.top <= rect.bottom) {
        selectedKeys.add(card.dataset.node);
      }
    }
    for (const line of wires.querySelectorAll('.wire-hit')) {
      if (touchesWire(line, rect)) selectedWires.add(line.dataset.edgeHit);
    }
  }
  selected = [...selectedKeys].at(-1);
  pickedWire = [...selectedWires].at(-1);
  pickedPage = null;
  updateSelection();
  renderInspector();
};
function isTyping(target) {
  return target.closest?.('input,textarea,select,[contenteditable],dialog');
}
window.addEventListener('keydown', event => {
  if (event.code === 'Space' && !isTyping(event.target) && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    spaceHeld = true;
    board.classList.add('space-pan');
  }
});
function releaseSpace() {
  spaceHeld = false;
  board.classList.remove('space-pan');
}
window.addEventListener('keyup', event => { if (event.code === 'Space') releaseSpace(); });
window.addEventListener('blur', releaseSpace);
new ResizeObserver(layout).observe(board);
function setPanMode(enabled) {
  panMode = enabled;
  $('pan').setAttribute('aria-pressed', panMode);
  $('edit').setAttribute('aria-pressed', !panMode);
  board.classList.toggle('pan-mode', panMode);
  $('mode').textContent = panMode ? t("左键拖动画布") : t("左键框选 · Shift 多选 · 空格＋拖动平移");
  board.focus({ preventScroll: true });
}
$('pan').onclick = () => setPanMode(true);
$('edit').onclick = () => setPanMode(false);
$('zoom-in').onclick = () => zoom(1.2);
$('zoom-out').onclick = () => zoom(1 / 1.2);
$('reset-view').onclick = () => {
  views.delete(group().id);
  revision++;
  status();
  transform();
  layout();
};
function showNameDialog(key, point) {
  if (busy || saving) return;
  renameTarget = key;
  creationPoint = point;
  const folder = key === 'new-folder' || key?.startsWith('folder:');
  $('name-title').textContent = folder ? (key === 'new-folder' ? t("添加文件夹") : t("重命名文件夹"))
    : key === 'project' ? t("重命名工程") : key ? t("重命名集合") : t("新建集合");
  $('name-label').textContent = folder ? t("文件夹名称") : key === 'project' ? t("工程名称") : t("集合名称");
  $('submit-name').textContent = key && key !== 'new-folder' ? t("保存名称") : t("创建");
  const input = $('group-name');
  input.value = folder ? (key === 'new-folder' ? t("新文件夹") : project.materialFolders[key.slice(7)].name)
    : key === 'project' ? project.settings.name : key ? node(key).name : 'Collection';
  input.setCustomValidity('');
  $('name-dialog').showModal();
  input.select();
}
$('new-group').onclick = () => showNameDialog();
$('new-folder').onclick = () => showNameDialog('new-folder');
$('project-name').onclick = () => showNameDialog('project');
$('cancel-name').onclick = () => $('name-dialog').close();
$('group-name').oninput = event => event.target.setCustomValidity('');
$('name-form').onsubmit = event => {
  event.preventDefault();
  const input = $('group-name');
  const name = input.value.trim();
  if (!name) {
    input.setCustomValidity(t("请输入名称。"));
    input.reportValidity();
    return;
  }
  if (renameTarget === 'project' && !validProjectName(name)) {
    input.setCustomValidity(t("请输入可用作文件名的名称。"));
    input.reportValidity();
    return;
  }
  $('name-dialog').close();
  if (renameTarget === 'project') {
    renameProject(name);
    return;
  }
  if (renameTarget === 'new-folder' || renameTarget?.startsWith('folder:')) {
    commit(() => {
      if (renameTarget === 'new-folder') {
        const key = id();
        project.materialFolders[key] = { id: key, name, parent: null };
        openFolders.add(key);
      } else project.materialFolders[renameTarget.slice(7)].name = name;
    });
    return;
  }
  if (renameTarget) {
    const item = node(renameTarget);
    if (item && name !== item.name) commit(() => { item.name = name; });
    return;
  }
  addComponent('group', name, creationPoint);
};
function addComponent(kind, name, point) {
  commit(() => {
    if (point || kind !== 'group') freeCurrentLayout();
    const key = id();
    project.nodes[key] = { id: key, kind, name,
      ...(kind === 'group' ? { children: [], links: {} } : kind === 'page' ? { pages: [], placeholder: true } : {}) };
    const index = group().children.length;
    const camera = view();
    const x = (20 - camera.x) / camera.zoom + index % 3 * 280;
    let y = (20 - camera.y) / camera.zoom;
    for (const card of nodes.children) {
      if (card.offsetLeft < x + 244 && card.offsetLeft + card.offsetWidth + 20 > x) {
        y = Math.max(y, card.offsetTop + card.offsetHeight + 24);
      }
    }
    moveNodes(project, [key], group().id, undefined, point || { x, y });
    selected = key;
    selectedKeys = new Set([key]);
    selectedWires.clear();
    pickedWire = null;
  });
}
function addEndpoint(kind, point) {
  addComponent(kind, kind === 'start' ? 'Start' : 'Over', point);
}
$('new-start').onclick = () => addEndpoint('start');
$('new-over').onclick = () => addEndpoint('over');
$('new-page').onclick = () => addComponent('page', 'Page');
board.oncontextmenu = event => {
  event.preventDefault();
  if (rightGesture?.moved || rightGesture?.overNode || event.target.closest('.node,.wire-hit')) return;
  const menu = $('canvas-menu');
  menuPoint = localPoint(event);
  menu.hidden = false;
  const rect = board.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(event.clientX - rect.left, rect.width - menu.offsetWidth))}px`;
  menu.style.top = `${Math.max(0, Math.min(event.clientY - rect.top, rect.height - menu.offsetHeight))}px`;
  menu.querySelector('button').focus();
};
function setAddMenu(open) {
  $('add-menu').hidden = !open;
  $('add-toggle').setAttribute('aria-expanded', open);
}
function setSettingsMenu(open) {
  $('settings-menu').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', open);
}
$('settings-toggle').onclick = () => setSettingsMenu($('settings-menu').hidden);
$('settings-menu').addEventListener('click', () => setSettingsMenu(false));
$('image-settings').onclick = () => $('image-settings-dialog').showModal();
$('language-settings').onclick = () => {
  $('interface-language').value = currentLanguage();
  $('language-dialog').showModal();
};
$('cancel-language').onclick = () => $('language-dialog').close();
$('language-form').onsubmit = event => {
  event.preventDefault();
  setLanguage($('interface-language').value);
  $('language-dialog').close();
  pickerTypes[0].description = t('页序工程');
  render();
};
window.addEventListener('pointerdown', event => {
  if (!event.target.closest('#settings-control')) setSettingsMenu(false);
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('settings-menu').hidden) {
    setSettingsMenu(false);
    $('settings-toggle').focus();
  }
});
$('add-toggle').onclick = () => setAddMenu($('add-menu').hidden);
$('add-menu').addEventListener('click', () => setAddMenu(false));
window.addEventListener('pointerdown', event => {
  if (!event.target.closest('#add-control')) setAddMenu(false);
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('add-menu').hidden) {
    setAddMenu(false);
    $('add-toggle').focus();
  }
});
$('canvas-menu').onclick = event => {
  const kind = event.target.closest('[data-add]')?.dataset.add;
  if (!kind) return;
  $('canvas-menu').hidden = true;
  if (kind === 'group') showNameDialog(undefined, menuPoint);
  else if (kind === 'page') addComponent('page', 'Page', menuPoint);
  else addEndpoint(kind, menuPoint);
};
window.addEventListener('pointerdown', event => {
  if (!event.target.closest('#canvas-menu')) $('canvas-menu').hidden = true;
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('canvas-menu').hidden) {
    $('canvas-menu').hidden = true;
    board.focus();
  }
});
$('undo').onclick = () => restore(past, future);
$('redo').onclick = () => restore(future, past);

async function importFiles(files, target) {
  if (!files.length || busy) return;
  busy = true;
  status();
  const incoming = [];
  const failed = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (/\.fig$/i.test(file.name)) throw Error(t("请先从设计工具导出 PDF 或 PNG"));
      const material = await loadSource({ name: file.name, bytes, paper: $('image-paper').value, background: $('image-background').value });
      if (!material.original.getPageCount()) throw Error(t("没有页面"));
      incoming.push(material);
    } catch (error) {
      const reason = /\.fig$/i.test(file.name) ? error.message : /\.ai$/i.test(file.name)
        ? t("需要含 PDF 兼容数据的 AI 文件") : /encrypted/i.test(error.message) ? t("已加密") : t("无法读取");
      failed.push(`${file.name}（${reason}）`);
    }
  }
  busy = false;
  if (incoming.length) commit(() => {
    sources = new Map(sources);
    for (const file of incoming) {
      const key = id();
      sources.set(key, file);
      project.nodes[key] = { id: key, kind: 'pdf', name: file.name,
        pages: Array.from({ length: file.original.getPageCount() }, (_, index) => ({ id: id(), source: key, index })),
      };
      project.inbox.push(key);
      if (target) fillPage(target, { id: id(), source: key, index: 0 });
    }
  });
  else render();
  notify(t("已导入 {0} 个素材{1}", incoming.length, failed.length ? t("。未导入：{0}", failed.join('、')) : '。'));
}
$('import').onclick = () => $('pdf-input').click();
$('pdf-input').onchange = event => {
  importFiles([...event.target.files]);
  event.target.value = '';
};
window.addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
window.addEventListener('drop', event => {
  const files = [...event.dataTransfer.files];
  if (!files.length) return;
  event.preventDefault();
  if (files.length === 1 && /\.pdfboard$/i.test(files[0].name)) openFile(files[0]);
  else importFiles(files);
});

function showExport(key) {
  if (busy) return;
  const plan = key ? workflow(project, group(), key) : allPages(project);
  if (!plan.complete || (!plan.pages.length && !plan.emptyPages.length)) {
    if (!key) notify(t("请先将页面加入画布。"));
    return;
  }
  exportPath = key ? [...path] : ['root'];
  exportScope = key ? (group().id === 'root' ? t('主画布') : group().name) : t("全部页面");
  const endpoints = group().children.filter(child => node(child).kind === 'over');
  const name = group().id === 'root' ? project.settings.name : group().name;
  exportName = !key ? t("{0}-全部", project.settings.name) : endpoints.length > 1 ? t("{0}-版本 {1}", name, endpoints.indexOf(key) + 1) : name;
  exportPlan = plan;
  activeExportPanel = null;
  $('target-width').value = '';
  $('target-mb').value = '';
  $('page-number').value = '';
  $('number-start').value = 1;
  $('skip-cover').checked = false;
  $('watermark-kind').value = '';
  $('watermark-text').value = '';
  $('watermark-upload').value = '';
  $('watermark-page').value = 1;
  for (const [key, value] of [['angle', 30], ['opacity', 15], ['size', 45], ['gap', 25]]) {
    $(`watermark-${key}`).value = value;
  }
  $('watermark-source').replaceChildren(element('option', t("请选择素材")));
  $('watermark-source').firstElementChild.value = '';
  for (const [source, file] of sources) {
    const option = element('option', file.name);
    option.value = source;
    $('watermark-source').append(option);
  }
  updateWatermarkFields();
  resetWatermarkChoices();
  invalidateExport();
  renderExport();
  $('export-dialog').showModal();
}
$('export-all').onclick = () => showExport();
function renderExport() {
  $('export-count').textContent = t("{0} · 预计导出 {1} 页", exportScope, exportPlan.pages.length);
  renderExportSizes();
  updateDownload();
}
const millimeters = points => new Intl.NumberFormat(locale(), { maximumFractionDigits: 4, useGrouping: false }).format(points / pointsPerMillimeter);
function targetWidth() {
  return $('target-width').valueAsNumber * pointsPerMillimeter;
}
function validWidth(width) {
  return Number.isFinite(width) && width > 0 && exportPlan.sizes.every(size => {
    const height = size.height * (width / size.width);
    return Number.isFinite(height) && height > 0;
  });
}
function renderExportSizes() {
  const resizing = activeExportPanel === 'export-size' || Boolean($('target-width').value);
  const list = $('page-plan');
  const widthList = $('original-widths');
  const scroll = list.scrollTop;
  list.replaceChildren();
  widthList.replaceChildren();
  exportPlan.sizes = resizing ? exportPlan.pages.map(page => visibleSize(sources.get(page.source).original.getPage(page.index))) : [];
  const width = targetWidth();
  const ready = resizing && validWidth(width);
  const groups = new Map();
  for (const [index, page] of exportPlan.pages.entries()) {
    const row = element('li', pageName(page));
    if (resizing) {
      const size = exportPlan.sizes[index];
      const key = Number(size.width.toPrecision(12));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(index + 1);
      const original = `${millimeters(size.width)} × ${millimeters(size.height)} mm`;
      const result = ready ? ` → ${millimeters(width)} × ${millimeters(size.height * (width / size.width))} mm` : '';
      row.append(element('small', original + result));
    }
    list.append(row);
  }
  for (const [size, positions] of [...groups].sort(([a], [b]) => a - b)) {
    widthList.append(element('li', t("{0} mm · 导出第 {1} 页", millimeters(size), positions.join(currentLanguage() === 'en' ? ', ' : '、'))));
  }
  $('width-help').textContent = $('target-width').value && !ready
    ? t("请输入有效的正数页宽。") : t("所有页面都会等比缩放到目标宽度。");
  list.scrollTop = scroll;
}
function updateDownload() {
  const disabled = busy || !exportPlan.pages.length || Boolean(exportPlan.emptyPages.length) || !currentExportOptions();
  $('download').disabled = disabled;
  $('precompose').disabled = disabled;
  $('download').textContent = preparedBytes ? t("确认导出") : t("直接导出");
  $('resize-export').disabled = busy || !exportPlan.pages.length || Boolean(exportPlan.emptyPages.length);
  $('limit-export').disabled = $('resize-export').disabled;
  $('number-export').disabled = busy;
  $('watermark-export').disabled = busy;
  $('close-export').disabled = busy;
  $('target-width').disabled = busy;
  updateExportTabs();
}
const exportPanels = { 'resize-export': 'export-size', 'limit-export': 'export-limit',
  'number-export': 'number-settings', 'watermark-export': 'watermark-settings' };
function updateExportTabs() {
  const modified = { 'resize-export': Boolean($('target-width').value), 'limit-export': Boolean($('target-mb').value),
    'number-export': Boolean($('page-number').value), 'watermark-export': Boolean($('watermark-kind').value) };
  for (const [buttonId, panelId] of Object.entries(exportPanels)) {
    const active = activeExportPanel === panelId;
    $(panelId).hidden = !active;
    $(buttonId).setAttribute('aria-selected', active);
    $(buttonId).classList.toggle('modified', modified[buttonId]);
  }
}
function openExportPanel(id) {
  activeExportPanel = activeExportPanel === id ? null : id;
  updateExportTabs();
  renderExportSizes();
}
for (const [buttonId, panelId] of Object.entries(exportPanels)) {
  $(buttonId).onclick = () => openExportPanel(panelId);
  $(buttonId).onkeydown = event => {
    const buttons = Object.keys(exportPanels).filter(id => !$(id).disabled);
    const index = buttons.indexOf(buttonId);
    let next;
    if (event.key === 'ArrowRight') next = buttons[(index + 1) % buttons.length];
    if (event.key === 'ArrowLeft') next = buttons[(index + buttons.length - 1) % buttons.length];
    if (event.key === 'Home') next = buttons[0];
    if (event.key === 'End') next = buttons.at(-1);
    if (!next) return;
    event.preventDefault();
    $(next).focus();
    activeExportPanel = exportPanels[next];
    updateExportTabs();
    renderExportSizes();
  };
}
function invalidateExport() {
  preparedBytes = null;
  exportGeneration++;
  const result = $('export-result');
  result.replaceChildren();
  if (exportPlan.emptyPages.length) {
    result.append(element('strong', t("请先填充或移除空 Page")));
    const list = element('ul');
    for (const { key, trail, label } of exportPlan.emptyPages) {
      const row = element('li');
      row.append(button(label, () => {
        $('export-dialog').close();
        path = [...exportPath, ...trail];
        enter(path.length - 1);
        choose(key);
        const card = [...nodes.children].find(item => item.dataset.node === key);
        if (card) {
          const camera = view();
          camera.x = (board.clientWidth - card.offsetWidth * camera.zoom) / 2 - card.offsetLeft * camera.zoom;
          camera.y = (board.clientHeight - card.offsetHeight * camera.zoom) / 2 - card.offsetTop * camera.zoom;
          revision++;
          status();
          transform();
        }
      }));
      list.append(row);
    }
    result.append(list);
  }
}
function updateWatermarkFields() {
  const kind = $('watermark-kind').value;
  $('watermark-text-field').hidden = kind !== 'text';
  $('watermark-upload-field').hidden = kind !== 'upload';
  $('watermark-material-field').hidden = kind !== 'material';
  $('watermark-options').hidden = !kind;
}
function resetWatermarkChoices() {
  watermarkGeneration++;
  watermarkData = null;
  watermarkPending = false;
  for (const url of watermarkUrls.splice(0)) URL.revokeObjectURL(url);
  $('watermark-image').replaceChildren();
  $('watermark-samples').replaceChildren();
  $('watermark-page-field').hidden = true;
  $('watermark-image-field').hidden = true;
  $('watermark-image-info').textContent = '';
}
async function loadWatermarkSource() {
  resetWatermarkChoices();
  invalidateExport();
  const version = watermarkGeneration;
  const kind = $('watermark-kind').value;
  const source = $('watermark-source').value;
  const material = sources.get(source);
  const upload = $('watermark-upload').files[0];
  if (kind === 'material' && !material || kind === 'upload' && !upload || !['material', 'upload'].includes(kind)) {
    updateDownload();
    return;
  }
  const isPdf = kind === 'material' && material.format === 'pdf';
  if (isPdf) {
    $('watermark-page-field').hidden = false;
    $('watermark-page').max = material.original.getPageCount();
    if (!$('watermark-page').checkValidity() || !$('watermark-page').value) {
      $('watermark-image-info').textContent = t("请输入有效的 PDF 页码。");
      updateDownload();
      return;
    }
  }
  watermarkPending = true;
  if (kind === 'material') $('watermark-image-info').textContent = t("正在读取水印素材…");
  updateDownload();
  try {
    let choices;
    if (isPdf) {
      const page = await getPdfPage({ source, index: $('watermark-page').valueAsNumber - 1 });
      choices = await watermarkChoices(page);
    } else if (kind === 'upload') {
      if (!imagePattern.test(upload.name)) throw Error(t("请选择 PNG、JPG 或 JPEG 图片。"));
      const png = await imagePng(new Uint8Array(await upload.arrayBuffer()), /\.png$/i.test(upload.name) ? 'png' : 'jpeg');
      choices = { images: [png] };
    } else choices = { images: [await imagePng(material.imageBytes, material.format)] };
    if (version !== watermarkGeneration) return;
    watermarkData = choices;
    if (!isPdf) {
      $('watermark-image-info').textContent = kind === 'material' ? t("已选择图片。") : '';
      return;
    }
    $('watermark-image-field').hidden = false;
    const select = $('watermark-image');
    for (const [index, png] of choices.images.entries()) {
      const label = t("图片 {0}", index + 1);
      const option = element('option', label);
      option.value = String(index);
      select.append(option);
      const sample = button('', () => {
        select.value = String(index);
        invalidateExport();
        updateDownload();
      });
      const image = element('img');
      image.alt = label;
      const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
      watermarkUrls.push(url);
      image.src = url;
      sample.append(image);
      $('watermark-samples').append(sample);
    }
    const full = element('option', t("使用整页作为水印"));
    full.value = 'full';
    select.append(full);
    $('watermark-image-info').textContent = choices.images.length ? t("选择一张图片，或使用整页。")
      : t("本页没有可单独选择的图片。可使用整页、改选其他页，或上传图片。");
  } catch (error) {
    if (version === watermarkGeneration) {
      if (kind === 'upload') $('export-result').textContent = t("水印图片无法读取：{0}", error.message);
      else $('watermark-image-info').textContent = t("无法读取此页，请换一页或上传图片。");
    }
  } finally {
    if (version === watermarkGeneration) {
      watermarkPending = false;
      updateDownload();
    }
  }
}
function currentExportOptions() {
  const width = $('target-width').value ? targetWidth() : null;
  if (width !== null && !validWidth(width)) return null;
  const mb = $('target-mb').value ? $('target-mb').valueAsNumber : null;
  if (mb !== null && (!Number.isFinite(mb) || mb < 0.01)) return null;
  const number = { format: $('page-number').value, start: $('number-start').valueAsNumber, skipCover: $('skip-cover').checked };
  if (number.format && (!Number.isInteger(number.start) || !$('number-start').checkValidity())) return null;
  const kind = $('watermark-kind').value;
  let watermark = null;
  if (kind) {
    if (watermarkPending) return null;
    const text = kind === 'text' ? $('watermark-text').value.trim() : '';
    const selectedImage = $('watermark-image').value;
    const png = selectedImage === 'full' ? watermarkData?.fullPage : watermarkData?.images[Number(selectedImage)];
    if (kind === 'text' ? !text : !png) return null;
    watermark = { text, png };
    for (const key of ['angle', 'opacity', 'size', 'gap']) {
      const input = $(`watermark-${key}`);
      if (!Number.isFinite(input.valueAsNumber) || !input.checkValidity()) return null;
      watermark[key] = input.valueAsNumber;
    }
  }
  return { width, limit: mb === null ? null : Math.round(mb * 1000000), number, watermark };
}
$('target-width').oninput = () => {
  invalidateExport();
  renderExportSizes();
  updateDownload();
};
function resetExportValue(id) {
  $(id).value = '';
  invalidateExport();
  renderExportSizes();
  updateDownload();
}
$('reset-width').onclick = () => resetExportValue('target-width');
$('reset-limit').onclick = () => resetExportValue('target-mb');
for (const id of ['target-mb', 'page-number', 'number-start', 'skip-cover', 'watermark-text', 'watermark-image',
  'watermark-angle', 'watermark-opacity', 'watermark-size', 'watermark-gap']) {
  $(id).oninput = () => { invalidateExport(); updateDownload(); };
}
$('watermark-kind').onchange = () => { updateWatermarkFields(); loadWatermarkSource(); };
$('watermark-upload').onchange = loadWatermarkSource;
$('watermark-source').onchange = () => { $('watermark-page').value = 1; loadWatermarkSource(); };
$('watermark-page').onchange = loadWatermarkSource;
$('watermark-page').oninput = () => {
  resetWatermarkChoices();
  $('watermark-page-field').hidden = false;
  invalidateExport();
  updateDownload();
};
$('close-export').onclick = () => { if (!busy) $('export-dialog').close(); };
$('export-dialog').oncancel = event => { if (busy) event.preventDefault(); };
$('export-dialog').onclose = resetWatermarkChoices;
function downloadPdf(bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = element('a');
  link.href = url;
  link.download = t("{0}-合并.pdf", exportName);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  $('export-dialog').close();
  notify(t("已导出合并 PDF。"));
}
async function prepareExport(direct) {
  const options = currentExportOptions();
  if (!options || busy || exportPlan.emptyPages.length || !exportPlan.pages.length) return;
  const generation = exportGeneration;
  busy = true;
  $('export-result').textContent = t("正在合成 PDF…");
  updateDownload();
  status();
  try {
    const bytes = await composePdf(exportPlan.pages, sources, options);
    if (generation !== exportGeneration) return;
    const exceeded = options.limit && bytes.byteLength > options.limit;
    if (direct && !exceeded) downloadPdf(bytes);
    else {
      preparedBytes = bytes;
      $('export-result').textContent = t("实际大小 {0} MB（{1} 字节）", (bytes.byteLength / 1000000).toFixed(3), bytes.byteLength.toLocaleString()) +
        (exceeded ? t("，超过目标 {0} MB。可修改设置或确认导出。", options.limit / 1000000) : t("，可确认导出。"));
    }
  } catch (error) {
    if (generation === exportGeneration) $('export-result').textContent = t("合成失败：{0}。可修改设置后重试。", error.message);
  } finally {
    busy = false;
    updateDownload();
    status();
  }
}
$('precompose').onclick = () => prepareExport(false);
$('download').onclick = () => preparedBytes ? downloadPdf(preparedBytes) : prepareExport(true);

const pickerTypes = [{ description: t("页序工程"), accept: { 'application/octet-stream': ['.pdfboard'] } }];
function validProjectName(name) {
  return name.length <= 120 && !/[<>:"/\\|?*\u0000-\u001f]/.test(name) && !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}
const fileName = name => `${name.replace(/\.pdfboard$/i, '')}.pdfboard`;
function scheduleAutosave() {
  clearInterval(autoTimer);
  if (handle && project.settings.autoMinutes) {
    autoTimer = setInterval(() => save(true), project.settings.autoMinutes * 60 * 1000);
  }
}
$('project-settings').onclick = () => {
  $('auto-enabled').checked = Boolean(project.settings.autoMinutes);
  $('auto-minutes').value = project.settings.autoMinutes || 10;
  $('auto-minutes').disabled = !$('auto-enabled').checked;
  $('settings-dialog').showModal();
};
$('auto-enabled').onchange = () => { $('auto-minutes').disabled = !$('auto-enabled').checked; };
$('cancel-settings').onclick = () => $('settings-dialog').close();
$('settings-form').onsubmit = event => {
  event.preventDefault();
  const minutes = $('auto-enabled').checked ? $('auto-minutes').valueAsNumber : null;
  if (project.settings.autoMinutes !== minutes) {
    project.settings.autoMinutes = minutes;
    revision++;
    scheduleAutosave();
  }
  $('settings-dialog').close();
  status();
};
async function writeProject(fileHandle, settings) {
  const data = pack({ ...project, settings, views: Object.fromEntries(views) }, sources);
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}
async function renameProject(name) {
  if (busy || saving || name === project.settings.name) return;
  if (!handle || handle.name === fileName(name)) {
    project.settings.name = name;
    revision++;
    status();
    return;
  }
  busy = true;
  $('workspace').inert = true;
  status();
  try {
    if (!window.showDirectoryPicker) throw Error(t("此浏览器无法访问工程所在文件夹。"));
    const folder = await window.showDirectoryPicker({ mode: 'readwrite', startIn: handle });
    const old = await folder.getFileHandle(handle.name);
    if (!(await old.isSameEntry(handle))) throw Error(t("请选择当前工程所在的文件夹。"));
    const nextName = fileName(name);
    try {
      await folder.getFileHandle(nextName);
      throw Error(t("同名文件已存在，请使用其他名称。"));
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
    }
    const next = await folder.getFileHandle(nextName, { create: true });
    const settings = { ...project.settings, name, lastSaved: new Date().toISOString() };
    await writeProject(next, settings);
    // Verify the original still refers to the bound file before removing its old name.
    const current = await folder.getFileHandle(handle.name);
    if (!(await current.isSameEntry(handle))) throw Error(t("原文件已变化。新文件已写入，原文件未删除。"));
    await folder.removeEntry(handle.name);
    handle = next;
    project.settings = settings;
    savedRevision = ++revision;
    scheduleAutosave();
    notify(t("工程及磁盘文件已重命名。"));
  } catch (error) {
    if (error.name !== 'AbortError') notify(t("工程改名未完成：{0}", error.message));
  } finally {
    busy = false;
    $('workspace').inert = false;
    status();
  }
}
function save(automaticSave = false) {
  if (saving) return saving;
  if (busy || (automaticSave && (!handle || !project.settings.autoMinutes || revision === savedRevision))) return Promise.resolve(false);
  saving = (async () => {
    try {
      if (!handle) {
        if (!window.showSaveFilePicker) throw Error(t("当前浏览器无法持续写入工程文件。请使用支持文件系统访问的桌面浏览器。"));
        handle = await window.showSaveFilePicker({ suggestedName: fileName(project.settings.name), types: pickerTypes });
        scheduleAutosave();
      }
      if (!automaticSave && handle.requestPermission &&
          await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') {
        throw Error(t("没有此工程文件的写入权限。"));
      }
      const writingRevision = revision;
      const settings = { ...project.settings, lastSaved: new Date().toISOString() };
      await writeProject(handle, settings);
      project.settings.lastSaved = settings.lastSaved;
      savedRevision = writingRevision;
      scheduleAutosave();
      notify(automaticSave ? t("已自动更新磁盘上的工程文件。") : t("已保存工程。"));
      return true;
    } catch (error) {
      if (error.name !== 'AbortError') notify(t("工程保存失败：{0}", error.message));
      return false;
    }
  })().finally(() => {
    saving = null;
    status();
  });
  status();
  return saving;
}
function confirmReplace() {
  return revision === savedRevision || window.confirm(t("当前工程有未保存的更改，确定要打开另一份工程吗？"));
}
async function openFile(file, fileHandle) {
  if (!file || busy || saving || !confirmReplace()) return;
  busy = true;
  status();
  try {
    const opened = await unpack(file);
    for (const [key, item] of opened.sources) opened.sources.set(key, await loadSource(item));
    validateFolders(opened.project, opened.sources);
    validate(opened.project, opened.sources);
    let migrated = migrateLegacy(opened.project);
    for (const item of Object.values(opened.project.nodes)) {
      for (const page of item.pages || []) {
        if (Object.hasOwn(page, 'edit')) {
          delete page.edit;
          migrated = true;
        }
      }
    }
    const entries = Object.entries(opened.project.views || {}).filter(([key, camera]) =>
      opened.project.nodes[key]?.kind === 'group' && Number.isFinite(camera?.x) &&
      Number.isFinite(camera?.y) && camera.zoom >= 0.15 && camera.zoom <= 3);
    project = opened.project;
    const settings = project.settings;
    project.settings = {
      name: typeof settings?.name === 'string' && validProjectName(settings.name) && settings.name ? settings.name : file.name.replace(/\.pdfboard$/i, ''),
      autoMinutes: settings?.autoMinutes === null ? null : Number.isInteger(settings?.autoMinutes) && settings.autoMinutes >= 1 && settings.autoMinutes <= 1440 ? settings.autoMinutes : 10,
      lastSaved: Number.isFinite(Date.parse(settings?.lastSaved)) ? settings.lastSaved : null,
    };
    delete project.views;
    sources = opened.sources;
    views = new Map(entries);
    handle = fileHandle;
    scheduleAutosave();
    savedRevision = 0;
    revision = Number(migrated);
    resetNavigation();
    notify(t("已打开工程。"));
  } catch (error) {
    notify(t("无法打开工程：{0}", error.message));
  } finally {
    busy = false;
    render();
  }
}
function resetNavigation() {
  path = ['root'];
  selected = pickedPage = pickedWire = fromPort = null;
  selectedKeys.clear();
  selectedWires.clear();
  materialSelection = [];
  materialAnchor = null;
  openMaterials.clear();
  openFolders.clear();
  collapsed.clear();
  previewScales.clear();
  thumbnailCache.clear();
  past = [];
  future = [];
}
$('open-project').onclick = async () => {
  if (!window.showOpenFilePicker) {
    $('project-input').click();
    return;
  }
  try {
    const [fileHandle] = await window.showOpenFilePicker({ types: pickerTypes });
    if (fileHandle.requestPermission) {
      await fileHandle.requestPermission({ mode: 'readwrite' }).catch(() => {});
    }
    await openFile(await fileHandle.getFile(), fileHandle);
  } catch (error) {
    if (error.name !== 'AbortError') $('project-input').click();
  }
};
$('project-input').onchange = event => {
  openFile(event.target.files[0]);
  event.target.value = '';
};
$('save-project').onclick = () => save();
$('exit').onclick = async () => {
  $('workspace').inert = true;
  try {
    if (!(await save()) || revision !== savedRevision) return;
    project = createProject();
    sources = new Map();
    views.clear();
    handle = null;
    scheduleAutosave();
    revision = savedRevision = 0;
    resetNavigation();
    render();
    notify(t("工程已保存并关闭。"));
  } finally {
    $('workspace').inert = false;
  }
};
window.addEventListener('beforeunload', event => {
  if (revision === savedRevision) return;
  event.preventDefault();
  event.returnValue = true;
});
setupPanels($('workspace'), $('left-divider'), $('right-divider'));
render();
