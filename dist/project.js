import { t } from './i18n.js';
const magic = 'PDFBOARD';
const rootId = 'root';
export const id = () => crypto.randomUUID();
export const createProject = () => ({
  nodes: { [rootId]: { id: rootId, kind: 'group', name: t("主画布"), children: [], links: {} } },
  inbox: [],
  pageLinks: true,
  materialFolders: {},
  materialLocations: {},
  settings: { name: t("未命名工程"), autoMinutes: 10, lastSaved: null },
});

export function automatic(group, project) {
  return group.id !== rootId && !group.freeLayout && group.children.every(child => Boolean(project.nodes[child].pages));
}

export function unlink(group, ids) {
  for (const [from, to] of Object.entries(group.links)) {
    if (ids.includes(from) || ids.includes(to)) delete group.links[from];
  }
}

export function parentOf(project, key) {
  return Object.values(project.nodes).find(item => item.children?.includes(key));
}

export function layerOrder(scope) {
  const children = new Set(scope.children);
  const saved = (scope.layerOrder || []).filter(key => children.has(key));
  const known = new Set(saved);
  return [...saved, ...scope.children.filter(key => !known.has(key))];
}

export function removeNode(project, parent, key) {
  for (const child of [...(project.nodes[key].children || [])]) removeNode(project, project.nodes[key], child);
  parent.children = parent.children.filter(child => child !== key);
  if (parent.layerOrder) parent.layerOrder = parent.layerOrder.filter(child => child !== key);
  unlink(parent, [key]);
  delete project.nodes[key];
}

export function cleanPageOrigin(project, origin, owner) {
  if (!origin) return;
  if (owner && project.nodes[owner.id] && !owner.pages.length) removeNode(project, origin, owner.id);
  if (origin.id === rootId || origin.children.length) return;
  const parent = parentOf(project, origin.id);
  if (parent) removeNode(project, parent, origin.id);
}

export function migrateLegacy(project) {
  let changed = false;
  for (const parent of Object.values(project.nodes)) {
    if (parent.kind !== 'group') continue;
    for (const [from, to] of Object.entries(parent.links)) {
      if (project.pageLinks) continue;
      if (project.nodes[from].kind === 'group' && project.nodes[to].kind === 'group') continue;
      delete parent.links[from];
      changed = true;
    }
    for (const key of parent.children) {
      if (project.nodes[key].pages?.length === 0 && !project.nodes[key].placeholder) {
        removeNode(project, parent, key);
        changed = true;
      }
    }
  }
  project.pageLinks = true;
  return changed;
}

export function moveNodes(project, ids, destination, before, point) {
  const target = project.nodes[destination];
  function contains(nodeId) {
    return nodeId === destination || project.nodes[nodeId].children?.some(contains);
  }
  if (ids.some(contains) || ids.includes(before)) return false;
  const targetLayers = layerOrder(target);
  const movingLayers = Object.values(project.nodes)
    .filter(item => item.kind === 'group' && item.children.some(key => ids.includes(key)))
    .flatMap(item => layerOrder(item).filter(key => ids.includes(key)));
  const transferred = ids.some(key => !target.children.includes(key));
  const repositioning = point && ids.every(child => target.children.includes(child)) && !automatic(target, project);
  for (const node of Object.values(project.nodes)) {
    if (node.kind !== 'group' || !node.children.some(child => ids.includes(child))) continue;
    if (repositioning && node === target) continue;
    if (node !== target) unlink(node, ids);
    node.children = node.children.filter(child => !ids.includes(child));
    if (node !== target && node.layerOrder) node.layerOrder = node.layerOrder.filter(child => !ids.includes(child));
  }
  project.inbox = project.inbox.filter(child => !ids.includes(child));
  const index = before ? target.children.indexOf(before) : target.children.length;
  if (!repositioning) target.children.splice(index < 0 ? target.children.length : index, 0, ...ids);
  if (transferred) {
    const known = new Set(movingLayers);
    target.layerOrder = [...targetLayers.filter(key => !ids.includes(key)), ...movingLayers, ...ids.filter(key => !known.has(key))];
  }
  if (point) ids.forEach((nodeId, i) => Object.assign(project.nodes[nodeId], {
    x: point.x + i * 230, y: point.y,
  }));
  return true;
}

export function connect(group, from, to, project) {
  if (from === to || !group.children.includes(from) || !group.children.includes(to)) return false;
  if (project?.nodes[from].kind === 'over' || project?.nodes[to].kind === 'start') return false;
  if (group.links[from] && group.links[from] !== to) return false;
  if (Object.entries(group.links).some(([other, end]) => other !== from && end === to)) return false;
  for (let cursor = to; cursor; cursor = group.links[cursor]) {
    if (cursor === from) return false;
  }
  group.links[from] = to;
  return true;
}

export function workflow(project, scope, endpoint) {
  const previous = new Map(Object.entries(scope.links).map(([from, to]) => [to, from]));
  let start = endpoint;
  while (previous.has(start)) start = previous.get(start);
  const path = [];
  for (let key = start; key; key = scope.links[key]) path.push(project.nodes[key]);
  const complete = path[0]?.kind === 'start' && path.at(-1)?.kind === 'over';
  const issue = path[0]?.kind !== 'start' ? t("这条路径尚未连接到 Start。")
    : t("路径在「{0}」处结束，尚未到达 Over。", path.at(-1)?.name);
  return { ...expandPlan(project, scope, path), complete, issue };
}

export function allPages(project) {
  const root = project.nodes.root;
  return { ...expandPlan(project, root, visualChainOrder(project, root), true), complete: true };
}

function visualChainOrder(project, scope) {
  let ordered = scope.children;
  if (!automatic(scope, project)) {
    const positions = ordered.map((key, index) => {
      const node = project.nodes[key];
      return { key, x: node.x ?? 20 + index % 3 * 225, y: node.y ?? 20 + Math.floor(index / 3) * 300 };
    }).sort((a, b) => a.y - b.y);
    ordered = [];
    for (let index = 0; index < positions.length;) {
      let end = index + 1;
      while (end < positions.length && positions[end].y - positions[index].y <= 24) end++;
      ordered.push(...positions.slice(index, end).sort((a, b) => a.x - b.x).map(item => item.key));
      index = end;
    }
  }
  const incoming = new Set(Object.values(scope.links));
  const result = [];
  for (const head of ordered) {
    if (incoming.has(head)) continue;
    for (let key = head; key; key = scope.links[key]) result.push(project.nodes[key]);
  }
  return result;
}

function expandPlan(project, scope, path, visual = false) {
  const pages = [];
  const emptyPages = [];
  function expand(item, trail = []) {
    const children = [];
    if (item.kind === 'group') {
      if (visual) {
        for (const child of visualChainOrder(project, item)) children.push(expand(child, [...trail, item.id]));
        return { item, children };
      }
      const incoming = new Set(Object.values(item.links));
      const heads = item.children.filter(key => !incoming.has(key) && (item.links[key] || project.nodes[key].kind === 'start'));
      const visited = new Set();
      for (const head of heads) {
        for (let key = head; key; key = item.links[key]) {
          visited.add(key);
          children.push(expand(project.nodes[key], [...trail, item.id]));
        }
      }
      for (const key of item.children) {
        if (!visited.has(key)) children.push(expand(project.nodes[key], [...trail, item.id]));
      }
    } else if (item.pages) {
      if (item.kind === 'page' && !item.pages.length) {
        const parent = project.nodes[trail.at(-1)] || scope;
        emptyPages.push({ key: item.id, trail,
          label: [scope.id === rootId ? t('主画布') : scope.name, ...trail.map(key => project.nodes[key].name), t("{0}（节点 {1}）", item.name, parent.children.indexOf(item.id) + 1)].join(' / '),
        });
      }
      for (const page of item.pages) {
        pages.push(page);
        children.push({ page });
      }
    }
    return { item, children };
  }
  const outline = path.map(item => expand(item));
  return { pages, outline, emptyPages };
}

export function pack(project, sources) {
  const files = [...sources].map(([key, file]) => ({
    key, name: file.name, size: (file.imageBytes || file.bytes).byteLength,
    format: file.format, paper: file.paper, background: file.background,
  }));
  const metadata = new TextEncoder().encode(JSON.stringify({ version: 1, project, files }));
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode(magic));
  new DataView(header.buffer).setUint32(8, metadata.length);
  return new Blob([header, metadata, ...[...sources.values()].map(file => file.imageBytes || file.bytes)], {
    type: 'application/octet-stream',
  });
}

export async function unpack(file) {
  const header = await file.slice(0, 12).arrayBuffer();
  const decoder = new TextDecoder();
  if (header.byteLength !== 12 || decoder.decode(header.slice(0, 8)) !== magic) throw Error(t("工程格式无效。"));
  const length = new DataView(header).getUint32(8);
  let offset = 12 + length;
  if (offset > file.size) throw Error(t("工程文件不完整。"));
  const { version, project, files } = JSON.parse(await file.slice(12, offset).text());
  if (version !== 1 || !Array.isArray(files) || !project?.nodes?.root || !Array.isArray(project.inbox)) throw Error(t("工程版本或结构无效。"));
  const sources = new Map();
  for (const entry of files) {
    if (typeof entry.name !== 'string' || typeof entry.key !== 'string' || sources.has(entry.key) ||
        !Number.isSafeInteger(entry.size) || entry.size <= 0 || offset + entry.size > file.size) throw Error(t("工程内的 PDF 索引无效。"));
    sources.set(entry.key, { name: entry.name, format: entry.format || 'pdf', paper: entry.paper, background: entry.background,
      bytes: new Uint8Array(await file.slice(offset, offset + entry.size).arrayBuffer()) });
    offset += entry.size;
  }
  if (offset !== file.size) throw Error(t("工程文件长度不匹配。"));
  return { project, sources };
}

export function validate(project, sources) {
  const seen = new Set();
  const seenPages = new Set();
  function visit(key) {
    if (typeof key !== 'string' || (key !== rootId && !/^[0-9a-f-]{36}$/i.test(key))) throw Error(t("工程节点标识无效。"));
    const node = Object.hasOwn(project.nodes, key) && project.nodes[key];
    if (!node || seen.has(key) || node.id !== key || typeof node.name !== 'string') throw Error(t("工程节点无效。"));
    seen.add(key);
    if (node.kind === 'group') {
      if (!Array.isArray(node.children) || !node.links || typeof node.links !== 'object') throw Error(t("工程集合无效。"));
      if (node.layerOrder !== undefined && (!Array.isArray(node.layerOrder) ||
          new Set(node.layerOrder).size !== node.layerOrder.length || node.layerOrder.some(key => !node.children.includes(key)))) {
        throw Error(t('工程叠放顺序无效。'));
      }
      const links = Object.entries(node.links);
      node.links = {};
      node.children.forEach(visit);
      for (const [from, to] of links) {
        if (!connect(node, from, to, project)) throw Error(t("工程连线无效。"));
      }
    } else if (!['start', 'over'].includes(node.kind)) {
      if (!['pdf', 'page'].includes(node.kind) || !Array.isArray(node.pages)) throw Error(t("工程页面无效。"));
      for (const page of node.pages) {
        if (typeof page.id !== 'string' || seenPages.has(page.id) || !Number.isInteger(page.index) ||
            page.index < 0 || !(page.index < sources.get(page.source)?.original.getPageCount())) throw Error(t("工程页面来源无效。"));
        seenPages.add(page.id);
      }
    }
  }
  if (project.nodes.root.kind !== 'group') throw Error(t("工程主画布无效。"));
  visit(rootId);
  project.inbox.forEach(visit);
  if (seen.size !== Object.keys(project.nodes).length) throw Error(t("工程包含孤立节点。"));
}
