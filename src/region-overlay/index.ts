/**
 * 区域选择器 overlay（产品记忆点）：由主进程注入到 BrowserView 目标页面执行的
 * 截图工具式拖拽框选层。z-index 9999、pointer-events auto、cursor crosshair；
 * 8 手柄编辑、Shift 等比 / Alt 中心锚、Delete 删除、Esc 退出、方向键微调；
 * 变化防抖 300ms 写 IndexedDB regions 表；保存经 llm:region:save 回写 SQLite。
 */
import type { RegionRecord } from '../shared/types';

interface Bootstrap {
  providerId: string;
  providerName: string;
  dpr: number;
  regions: RegionRecord[];
}

declare global {
  interface Window {
    __LLM_REGION_BOOTSTRAP__?: Bootstrap;
    __LLM_REGION_BRIDGE__?: {
      invoke(channel: string, payload?: unknown): Promise<{ code: number | string; data?: unknown; message?: string }>;
    };
    __llmRegionOverlayMounted?: boolean;
  }
}

const BLUE = '#2D7FF9';
const FILL = 'rgba(45,127,249,0.15)';
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

let providerId = 'unknown';
let regions: RegionRecord[] = [];
let selectedIds = new Set<string>();
let editingId: string | null = null;
let idCounter = 0;

let svg: SVGSVGElement;
let drawRect: SVGRectElement;
let hintBanner: HTMLDivElement;
let coordEl: HTMLDivElement;
let countEl: HTMLDivElement;
let drawer: HTMLDivElement;
let nameInput: HTMLInputElement;
let toastEl: HTMLDivElement;
let regionLayer: SVGGElement;

let drag: null | {
  kind: 'draw' | 'move' | 'resize';
  handle?: (typeof HANDLES)[number];
  startX: number;
  startY: number;
  orig?: { x: number; y: number; w: number; h: number };
  regionId?: string;
  moved: boolean;
} = null;
let shiftDown = false;
let altDown = false;
let nameInputTarget: string | null = null;

/* ---------------- IndexedDB regions 表（防抖 300ms 持久化） ---------------- */

const DB_NAME = 'llm-regions';
const STORE = 'regions';
let idbPromise: Promise<IDBDatabase> | null = null;

function openIdb(): Promise<IDBDatabase> {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('providerId', 'providerId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idbPromise;
}

export async function idbPutRegions(records: RegionRecord[]): Promise<void> {
  const db = await openIdb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const r of records) store.put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbLoadRegions(pid: string): Promise<RegionRecord[]> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const idx = tx.objectStore(STORE).index('providerId');
    const req = idx.getAll(pid);
    req.onsuccess = () => resolve(req.result as RegionRecord[]);
    req.onerror = () => reject(req.error);
  });
}

export interface RegionPersist {
  /** 每次拖拽/缩放变化调用：防抖 debounceMs 后把最新选区集合写入存储 */
  notify(records: RegionRecord[]): void;
  /** 跳过剩余等待立即写入（保存前确保草稿不丢） */
  flush(): Promise<void>;
  /** 是否存在未落库的挂起写入（防抖窗口内为 true） */
  pending(): boolean;
}

/**
 * 防抖持久化（P0-002 判据 4）：每次变化后 300ms 窗口内不写库，≥300ms 写入最新值；
 * 窗口内连续变化合并为一次写入。导出工厂以便单元测试用虚拟时钟精确断言窗口边界。
 */
export function createRegionPersist(put: (records: RegionRecord[]) => Promise<void>, debounceMs = 300): RegionPersist {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: RegionRecord[] = [];
  return {
    notify(records) {
      latest = records;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void put(latest).catch(() => undefined);
      }, debounceMs);
    },
    flush: async () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      await put(latest).catch(() => undefined);
    },
    pending: () => timer !== undefined,
  };
}

const regionPersist = createRegionPersist((records) => idbPutRegions(records), 300);

function schedulePersist(): void {
  regionPersist.notify(regions);
}

/* ---------------- 工具 ---------------- */

function genRegionId(): string {
  idCounter += 1;
  return `rgn_${Date.now().toString(36)}_${idCounter}`;
}

/** 由元素生成 CSS 路径（body > div:nth-of-type(2) > … 或 #id 终止），用于落库 selector 字段 */
function cssPath(elm: Element): string {
  const parts: string[] = [];
  let cur: Element | null = elm;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    let part = cur.tagName.toLowerCase();
    if (cur.id) {
      parts.unshift(`${part}#${cur.id}`);
      return parts.join(' > ');
    }
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.length ? parts.join(' > ') : 'body';
}

/** 选区中心点正下方（overlay 自身元素除外）的页面元素 CSS 路径，作为 DOM 模式的选择器种子 */
function selectorForRegion(x: number, y: number, w: number, h: number): string {
  const cx = Math.max(0, Math.min(x + w / 2, window.innerWidth - 1));
  const cy = Math.max(0, Math.min(y + h / 2, window.innerHeight - 1));
  const stack = document.elementsFromPoint(cx, cy);
  const target = stack.find(
    (elm) => !elm.closest('#__llm-overlay-svg, #__llm-overlay-statusbar, #__llm-overlay-hint, #__llm-overlay-drawer, #__llm-region-name-input'),
  );
  return cssPath(target ?? document.body);
}

function pageScroll(): { x: number; y: number } {
  return { x: window.scrollX, y: window.scrollY };
}

function clampToViewport(x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const vw = document.documentElement.scrollWidth;
  const vh = document.documentElement.scrollHeight;
  let nx = Math.max(0, Math.min(x, vw - 10));
  let ny = Math.max(0, Math.min(y, vh - 10));
  let nw = Math.max(10, Math.min(w, vw - nx));
  let nh = Math.max(10, Math.min(h, vh - ny));
  if (nx + nw > vw) nw = vw - nx;
  if (ny + nh > vh) nh = vh - ny;
  return { x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) };
}

function el<T extends HTMLElement>(tag: string, style: Partial<CSSStyleDeclaration>, attrs?: Record<string, string>): T {
  const e = document.createElement(tag) as T;
  Object.assign(e.style, style);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  }
  return e;
}

/* ---------------- UI 构建 ---------------- */

function buildOverlay(): void {
  // 容器样式
  const style = document.createElement('style');
  style.textContent = `
    #__llm-overlay-svg { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 9999; pointer-events: auto; cursor: crosshair; }
    #__llm-overlay-svg .region-rect { fill: ${FILL}; stroke: ${BLUE}; stroke-width: 2; stroke-dasharray: 6 4; }
    #__llm-overlay-svg .region-rect.editing { stroke-dasharray: none; }
    #__llm-overlay-svg .region-handle { fill: #ffffff; stroke: ${BLUE}; stroke-width: 1.5; pointer-events: all; }
    #__llm-overlay-svg .region-label { fill: #1F2937; font: 12px 'JetBrains Mono', Consolas, monospace; paint-order: stroke; stroke: #ffffff; stroke-width: 3px; user-select: none; }
    #__llm-overlay-statusbar { position: fixed; left: 0; right: 0; bottom: 0; height: 30px; background: #111827; color: #E5E7EB; display: flex; align-items: center; gap: 24px; padding: 0 16px; z-index: 10000; font: 12px 'JetBrains Mono', Consolas, monospace; pointer-events: auto; }
    #__llm-overlay-hint { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); background: #EFF6FF; color: #1D4ED8; border: 1px solid #BFDBFE; border-radius: 6px; padding: 8px 16px; font: 14px system-ui; z-index: 10000; pointer-events: none; }
    #__llm-overlay-drawer { position: fixed; top: 48px; right: 0; width: 320px; max-height: calc(100vh - 90px); background: #FFFFFF; border-left: 1px solid #E5E7EB; box-shadow: -8px 0 24px rgba(0,0,0,.12); border-radius: 8px 0 0 8px; z-index: 10001; font: 14px system-ui; display: flex; flex-direction: column; pointer-events: auto; }
    #__llm-overlay-drawer .head { padding: 12px 16px; border-bottom: 1px solid #E5E7EB; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
    #__llm-overlay-drawer .body { overflow: auto; padding: 12px 16px; }
    #__llm-overlay-drawer .btn { background: #2D7FF9; color: #fff; border: none; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 13px; margin: 2px; }
    #__llm-overlay-drawer .btn.secondary { background: #F3F4F6; color: #374151; border: 1px solid #E5E7EB; }
    #__llm-overlay-drawer .btn.mini { padding: 3px 8px; font-size: 12px; }
    #__llm-overlay-drawer .row { display: flex; gap: 8px; align-items: center; border: 1px solid #E5E7EB; border-radius: 8px; padding: 8px; margin-bottom: 8px; }
    #__llm-overlay-drawer .row .thumb { width: 80px; height: 60px; background: #F3F4F6; border-radius: 4px; flex: none; }
    #__llm-overlay-drawer .row .name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #__llm-region-name-input { position: absolute; z-index: 10002; font: 13px system-ui; padding: 4px 8px; border: 2px solid ${BLUE}; border-radius: 6px; outline: none; width: 180px; }
    #__llm-region-toast { position: fixed; right: 16px; top: 60px; background: #10B981; color: #fff; border-radius: 6px; padding: 8px 14px; z-index: 10002; font: 13px system-ui; pointer-events: none; opacity: 0; transition: opacity .2s; }
    @keyframes __llm-pulse { 0%,100% { stroke: ${BLUE}; stroke-width: 2; } 50% { stroke: #F59E0B; stroke-width: 5; } }
    .__llm-pulsing { animation: __llm-pulse .5s ease-in-out 3; }
  `;
  document.documentElement.appendChild(style);

  // SVG 画布（覆盖整个文档高度）
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = '__llm-overlay-svg';
  document.documentElement.appendChild(svg);
  syncSvgSize();
  svg.addEventListener('mousedown', onSvgMouseDown);
  svg.addEventListener('mousemove', onSvgMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  // 滚轮穿透：overlay 覆盖页面时仍可滚动浏览长页面
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    window.scrollBy(0, e.deltaY);
  }, { passive: false });

  regionLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svg.appendChild(regionLayer);
  drawRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  drawRect.setAttribute('class', 'region-rect');
  drawRect.setAttribute('visibility', 'hidden');
  svg.appendChild(drawRect);

  // 底部状态栏
  const status = el<HTMLDivElement>('div', { position: 'fixed', pointerEvents: 'auto' }, { id: '__llm-overlay-statusbar' });
  coordEl = el<HTMLDivElement>('div', {}, { 'data-testid': 'overlay-coord' });
  coordEl.textContent = '0,0';
  countEl = el<HTMLDivElement>('div', {}, { 'data-testid': 'overlay-count' });
  countEl.textContent = '选区 0';
  const tip = el<HTMLDivElement>('div', { marginLeft: 'auto' });
  tip.textContent = '拖拽框选 · Shift 等比 · Alt 中心锚 · Delete 删除 · Esc 退出';
  status.append(coordEl, countEl, tip);
  document.documentElement.appendChild(status);

  // 空态提示条
  hintBanner = el<HTMLDivElement>('div', {}, { id: '__llm-overlay-hint', 'data-testid': 'overlay-hint' });
  hintBanner.textContent = '按住鼠标左键拖拽框选需要监控的区域';
  document.documentElement.appendChild(hintBanner);

  // 右侧工具抽屉
  drawer = el<HTMLDivElement>('div', {}, { id: '__llm-overlay-drawer' });
  drawer.innerHTML = `
    <div class="head"><span>区域选择器</span><span style="font-weight:400;font-size:12px;color:#6B7280">${(window.__LLM_REGION_BOOTSTRAP__?.providerName || '').slice(0, 14)}</span></div>
    <div class="body">
      <div style="margin-bottom:8px">
        <button class="btn" id="__llm-btn-new">新建选区</button>
        <button class="btn secondary" id="__llm-btn-clear">清空</button>
        <button class="btn" id="__llm-btn-save" data-testid="region-save">保存</button>
        <button class="btn secondary" id="__llm-btn-cancel">取消</button>
      </div>
      <div id="__llm-align-row" style="display:none;margin-bottom:8px">
        <button class="btn secondary mini" id="__llm-align-left">左对齐</button>
        <button class="btn secondary mini" id="__llm-align-top">顶对齐</button>
        <button class="btn secondary mini" id="__llm-align-w">等宽</button>
        <button class="btn secondary mini" id="__llm-align-h">等高</button>
      </div>
      <div id="__llm-region-list"></div>
    </div>`;
  document.documentElement.appendChild(drawer);
  drawer.querySelector('#__llm-btn-new')!.addEventListener('click', () => toast('在页面上按住左键拖拽即可新建选区'));
  drawer.querySelector('#__llm-btn-clear')!.addEventListener('click', () => {
    regions = [];
    selectedIds.clear();
    editingId = null;
    renderRegions();
    schedulePersist();
  });
  drawer.querySelector('#__llm-btn-save')!.addEventListener('click', () => void saveAll());
  drawer.querySelector('#__llm-btn-cancel')!.addEventListener('click', () => {
    // 取消 = 退出本次框选会话：解除 BrowserView 附着并让宿主页复位（仅拆画布会把页面留在原地）
    document.querySelectorAll('#__llm-overlay-svg,#__llm-overlay-statusbar,#__llm-overlay-hint,#__llm-overlay-drawer,#__llm-region-name-input,#__llm-region-toast').forEach((n) => n.remove());
    window.__llmRegionOverlayMounted = false;
    void window.__LLM_REGION_BRIDGE__?.invoke('llm:region:exit', { providerId }).catch(() => undefined);
  });
  (['left', 'top', 'w', 'h'] as const).forEach((kind) => {
    drawer.querySelector(`#__llm-align-${kind}`)!.addEventListener('click', () => alignSelected(kind));
  });

  // 命名输入框
  nameInput = el<HTMLInputElement>('input', { position: 'absolute' }, { id: '__llm-region-name-input', 'data-testid': 'region-name-input', placeholder: '输入选区名称，回车确认' });
  nameInput.style.display = 'none';
  document.documentElement.appendChild(nameInput);
  nameInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      confirmName();
    } else if (e.key === 'Escape') {
      hideNameInput();
    }
  });
  nameInput.addEventListener('blur', () => confirmName());

  toastEl = el<HTMLDivElement>('div', {}, { id: '__llm-region-toast' });
  document.documentElement.appendChild(toastEl);

  // 键盘
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
}

function syncSvgSize(): void {
  const h = Math.max(document.documentElement.scrollHeight, window.innerHeight);
  svg.setAttribute('width', String(Math.max(document.documentElement.scrollWidth, window.innerWidth)));
  svg.setAttribute('height', String(h));
  svg.style.height = `${h}px`;
}

function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.style.opacity = '1';
  window.setTimeout(() => (toastEl.style.opacity = '0'), 2000);
}

/* ---------------- 渲染 ---------------- */

function renderRegions(): void {
  regionLayer.innerHTML = '';
  for (const r of regions) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.dataset.regionId = r.id;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', `region-rect${editingId === r.id ? ' editing' : ''}`);
    rect.setAttribute('x', String(r.x));
    rect.setAttribute('y', String(r.y));
    rect.setAttribute('width', String(r.w));
    rect.setAttribute('height', String(r.h));
    rect.dataset.testid = `region-rect-${r.id}`;
    g.appendChild(rect);
    if (editingId === r.id || selectedIds.has(r.id)) {
      HANDLES.forEach((hd, n) => {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        c.setAttribute('class', 'region-handle');
        c.dataset.testid = `region-handle-${n}`;
        c.dataset.handle = hd;
        c.dataset.regionId = r.id;
        c.setAttribute('r', '4');
        c.setAttribute('cx', String(handlePos(r, hd).x));
        c.setAttribute('cy', String(handlePos(r, hd).y));
        c.style.cursor = cursorFor(hd);
        g.appendChild(c);
      });
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('class', 'region-label');
      label.setAttribute('x', String(r.x + r.w / 2));
      label.setAttribute('y', String(r.y + r.h / 2 + 4));
      label.setAttribute('text-anchor', 'middle');
      label.textContent = `${r.x},${r.y} ${r.w}×${r.h}`;
      g.appendChild(label);
    }
    rect.addEventListener('mousedown', (e) => onRectMouseDown(e, r.id));
    regionLayer.appendChild(g);
  }
  countEl.textContent = `选区 ${regions.length}`;
  hintBanner.style.display = regions.length ? 'none' : 'block';
  const alignRow = drawer.querySelector('#__llm-align-row') as HTMLElement;
  alignRow.style.display = selectedIds.size >= 2 ? 'block' : 'none';
  renderDrawerList();
  syncSvgSize();
}

function handlePos(r: RegionRecord, hd: (typeof HANDLES)[number]): { x: number; y: number } {
  const { x, y, w, h } = r;
  switch (hd) {
    case 'nw': return { x, y };
    case 'n': return { x: x + w / 2, y };
    case 'ne': return { x: x + w, y };
    case 'e': return { x: x + w, y: y + h / 2 };
    case 'se': return { x: x + w, y: y + h };
    case 's': return { x: x + w / 2, y: y + h };
    case 'sw': return { x, y: y + h };
    case 'w': return { x, y: y + h / 2 };
  }
}

function cursorFor(hd: string): string {
  switch (hd) {
    case 'nw':
    case 'se': return 'nwse-resize';
    case 'ne':
    case 'sw': return 'nesw-resize';
    case 'n':
    case 's': return 'ns-resize';
    default: return 'ew-resize';
  }
}

function renderDrawerList(): void {
  const list = drawer.querySelector('#__llm-region-list') as HTMLElement;
  list.innerHTML = '';
  const w = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  const h = Math.max(document.documentElement.scrollHeight, window.innerHeight);
  for (const r of regions) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.testid = `region-row-${r.id}`;
    const thumb = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    thumb.setAttribute('class', 'thumb');
    thumb.setAttribute('viewBox', `0 0 ${w} ${h}`);
    thumb.style.width = '80px';
    thumb.style.height = '60px';
    const tr = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    tr.setAttribute('x', String(r.x));
    tr.setAttribute('y', String(r.y));
    tr.setAttribute('width', String(r.w));
    tr.setAttribute('height', String(r.h));
    tr.setAttribute('fill', FILL);
    tr.setAttribute('stroke', BLUE);
    tr.setAttribute('stroke-width', String(Math.max(4, w / 60)));
    thumb.appendChild(tr);
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${r.name}（${r.mode}）`;
    const actions = document.createElement('div');
    actions.dataset.testid = `region-row-actions-${r.id}`;
    const locate = document.createElement('button');
    locate.className = 'btn secondary mini';
    locate.textContent = '定位';
    locate.addEventListener('click', () => locateRegion(r.id));
    const edit = document.createElement('button');
    edit.className = 'btn secondary mini';
    edit.textContent = '编辑';
    edit.addEventListener('click', () => {
      editingId = r.id;
      selectedIds = new Set([r.id]);
      renderRegions();
    });
    const del = document.createElement('button');
    del.className = 'btn secondary mini';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      regions = regions.filter((x) => x.id !== r.id);
      selectedIds.delete(r.id);
      if (editingId === r.id) editingId = null;
      renderRegions();
      schedulePersist();
    });
    actions.append(locate, edit, del);
    row.append(thumb, name, actions);
    list.appendChild(row);
  }
}

/* ---------------- 交互 ---------------- */

function pagePoint(e: MouseEvent): { x: number; y: number } {
  const s = pageScroll();
  return { x: Math.round(e.pageX), y: Math.round(e.pageY) };
}

function onSvgMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  const target = e.target as Element;
  if (target.classList.contains('region-handle')) {
    const rid = target.getAttribute('data-region-id')!;
    const handle = target.getAttribute('data-handle') as (typeof HANDLES)[number];
    const r = regions.find((x) => x.id === rid)!;
    drag = { kind: 'resize', handle, startX: e.pageX, startY: e.pageY, orig: { x: r.x, y: r.y, w: r.w, h: r.h }, regionId: rid, moved: false };
    editingId = rid;
    e.preventDefault();
    return;
  }
  if (target.classList.contains('region-rect')) {
    // 已由 onRectMouseDown 处理
    return;
  }
  // 空白处：开始绘制
  hideNameInput();
  const p = pagePoint(e);
  selectedIds.clear();
  editingId = null;
  drag = { kind: 'draw', startX: p.x, startY: p.y, moved: false };
  drawRect.setAttribute('x', String(p.x));
  drawRect.setAttribute('y', String(p.y));
  drawRect.setAttribute('width', '0');
  drawRect.setAttribute('height', '0');
  drawRect.setAttribute('visibility', 'visible');
  renderRegions();
  e.preventDefault();
}

function onRectMouseDown(e: MouseEvent, regionId: string): void {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const r = regions.find((x) => x.id === regionId)!;
  if (e.shiftKey) {
    // Shift 单击多选
    if (selectedIds.has(regionId)) selectedIds.delete(regionId);
    else selectedIds.add(regionId);
    renderRegions();
    return;
  }
  editingId = regionId;
  selectedIds = new Set([regionId]);
  hideNameInput();
  drag = { kind: 'move', startX: e.pageX, startY: e.pageY, orig: { x: r.x, y: r.y, w: r.w, h: r.h }, regionId, moved: false };
  renderRegions();
}

function onSvgMouseMove(e: MouseEvent): void {
  const p = pagePoint(e);
  coordEl.textContent = `${p.x},${p.y}`;
  if (!drag) return;
  drag.moved = true;
  if (drag.kind === 'draw') {
    let x = Math.min(drag.startX, p.x);
    let y = Math.min(drag.startY, p.y);
    let w = Math.abs(p.x - drag.startX);
    let h = Math.abs(p.y - drag.startY);
    if (shiftDown) {
      // 等比绘制
      const size = Math.max(w, h);
      w = size;
      h = Math.round(size * 0.6);
    }
    ({ x, y, w, h } = clampToViewport(x, y, Math.max(w, 1), Math.max(h, 1)));
    drawRect.setAttribute('x', String(x));
    drawRect.setAttribute('y', String(y));
    drawRect.setAttribute('width', String(w));
    drawRect.setAttribute('height', String(h));
    return;
  }
  const r = regions.find((x) => x.id === drag!.regionId);
  if (!r || !drag.orig) return;
  const dx = p.x - drag.startX;
  const dy = p.y - drag.startY;
  let { x, y, w, h } = drag.orig;
  if (drag.kind === 'move') {
    x += dx;
    y += dy;
  } else if (drag.kind === 'resize') {
    const hd = drag.handle!;
    if (hd.includes('w')) {
      x += dx;
      w -= dx;
    }
    if (hd.includes('e')) w += dx;
    if (hd.includes('n')) {
      y += dy;
      h -= dy;
    }
    if (hd.includes('s')) h += dy;
    // Shift 等比缩放
    if (shiftDown) {
      const ratio = drag.orig.w / Math.max(drag.orig.h, 1);
      if (hd === 'se' || hd === 'ne' || hd === 'sw' || hd === 'nw') {
        h = Math.round(w / ratio);
        if (hd.includes('n')) y = drag.orig.y + (drag.orig.h - h);
      }
    }
    // Alt 以中心为锚点缩放
    if (altDown && (hd === 'se' || hd === 'nw' || hd === 'ne' || hd === 'sw')) {
      const cx = drag.orig.x + drag.orig.w / 2;
      const cy = drag.orig.y + drag.orig.h / 2;
      w = Math.max(10, w);
      h = Math.max(10, h);
      x = Math.round(cx - w / 2);
      y = Math.round(cy - h / 2);
    }
    if (w < 10) w = 10;
    if (h < 10) h = 10;
  }
  const c = clampToViewport(x, y, w, h);
  r.x = c.x;
  r.y = c.y;
  r.w = c.w;
  r.h = c.h;
  r.lastModified = Date.now();
  renderRegions();
  schedulePersist();
}

function onMouseUp(e: MouseEvent): void {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind === 'draw') {
    drawRect.setAttribute('visibility', 'hidden');
    const x = Number(drawRect.getAttribute('x'));
    const y = Number(drawRect.getAttribute('y'));
    const w = Number(drawRect.getAttribute('width'));
    const h = Number(drawRect.getAttribute('height'));
    if (w < 10 || h < 10) {
      toast('选区过小（最小 10×10），请重新拖拽');
      renderRegions();
      return;
    }
    // 松开瞬间进入编辑态并自动弹出命名输入框，回车确认
    const rec: RegionRecord = {
      id: genRegionId(),
      providerId,
      name: `选区 ${regions.length + 1}`,
      x,
      y,
      w,
      h,
      mode: 'OCR',
      selector: selectorForRegion(x, y, w, h),
      lastModified: Date.now(),
    };
    regions.push(rec);
    editingId = rec.id;
    selectedIds = new Set([rec.id]);
    renderRegions();
    showNameInput(rec);
    schedulePersist();
  }
  void e;
}

function showNameInput(r: RegionRecord): void {
  nameInputTarget = r.id;
  nameInput.value = r.name;
  nameInput.style.display = 'block';
  nameInput.style.left = `${Math.max(4, r.x + r.w - 190)}px`;
  nameInput.style.top = `${Math.max(4, r.y - 34)}px`;
  window.setTimeout(() => nameInput.focus(), 0);
}

function hideNameInput(): void {
  nameInputTarget = null;
  nameInput.style.display = 'none';
}

function confirmName(): void {
  if (!nameInputTarget) return;
  const r = regions.find((x) => x.id === nameInputTarget);
  if (r) {
    r.name = nameInput.value.trim() || r.name;
    r.lastModified = Date.now();
  }
  hideNameInput();
  renderRegions();
  schedulePersist();
}

function onKeyDown(e: KeyboardEvent): void {
  shiftDown = e.shiftKey;
  altDown = e.altKey;
  if (document.activeElement === nameInput) return;
  if (e.key === 'Escape') {
    editingId = null;
    selectedIds.clear();
    hideNameInput();
    renderRegions();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (editingId) {
      regions = regions.filter((x) => x.id !== editingId);
      selectedIds.delete(editingId);
      editingId = null;
      renderRegions();
      schedulePersist();
      e.preventDefault();
    }
    return;
  }
  if (e.key.startsWith('Arrow') && (editingId || selectedIds.size)) {
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    for (const id of selectedIds) {
      const r = regions.find((x) => x.id === id);
      if (r) {
        const c = clampToViewport(r.x + dx, r.y + dy, r.w, r.h);
        Object.assign(r, c, { lastModified: Date.now() });
      }
    }
    renderRegions();
    schedulePersist();
    e.preventDefault();
  }
}

function onKeyUp(e: KeyboardEvent): void {
  shiftDown = e.shiftKey;
  altDown = e.altKey;
  void e;
}

function alignSelected(kind: 'left' | 'top' | 'w' | 'h'): void {
  const sel = regions.filter((r) => selectedIds.has(r.id));
  if (sel.length < 2) return;
  if (kind === 'left') {
    const minX = Math.min(...sel.map((r) => r.x));
    sel.forEach((r) => (r.x = minX));
  } else if (kind === 'top') {
    const minY = Math.min(...sel.map((r) => r.y));
    sel.forEach((r) => (r.y = minY));
  } else if (kind === 'w') {
    const w = sel[0].w;
    sel.forEach((r) => (r.w = w));
  } else {
    const h = sel[0].h;
    sel.forEach((r) => (r.h = h));
  }
  sel.forEach((r) => (r.lastModified = Date.now()));
  renderRegions();
  schedulePersist();
}

function locateRegion(regionId: string): void {
  const r = regions.find((x) => x.id === regionId);
  if (!r) return;
  window.scrollTo({ top: Math.max(0, r.y - window.innerHeight / 2), behavior: 'smooth' });
  window.setTimeout(() => {
    const rect = regionLayer.querySelector(`[data-testid="region-rect-${regionId}"]`) as SVGRectElement | null;
    if (rect) {
      rect.classList.add('__llm-pulsing');
      window.setTimeout(() => rect.classList.remove('__llm-pulsing'), 1600);
    }
  }, 350);
}

/* ---------------- 保存 ---------------- */

async function saveAll(): Promise<void> {
  const bridge = window.__LLM_REGION_BRIDGE__;
  if (!bridge) {
    toast('区域桥不可用：请确认由应用内打开');
    return;
  }
  const payload = regions.map((r) => ({
    id: r.id,
    name: r.name,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    mode: r.mode,
    selector: r.selector,
    lastModified: r.lastModified,
  }));
  const res = await bridge.invoke('llm:region:save', { providerId, regions: payload });
  if (res && (res.code === 0 || res.code === '0')) {
    await idbPutRegions(regions).catch(() => undefined);
    toast('已保存并回写到 Provider 配置（一次配置终身复用）');
  } else {
    toast(`保存失败：${res?.message ?? '未知错误'}`);
  }
}

/* ---------------- 启动 ---------------- */

// 注入式加载（esbuild iife 无导出面）：脚本被执行即挂载
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  mountRegionOverlay();
}

export function mountRegionOverlay(): void {
  if (window.__llmRegionOverlayMounted) {
    // 重复注入：先卸载旧实例
    document.querySelectorAll('#__llm-overlay-svg,#__llm-overlay-statusbar,#__llm-overlay-hint,#__llm-overlay-drawer,#__llm-region-name-input,#__llm-region-toast').forEach((n) => n.remove());
    window.__llmRegionOverlayMounted = false;
  }
  const boot2 = window.__LLM_REGION_BOOTSTRAP__ ?? { providerId: 'unknown', providerName: '', dpr: 1, regions: [] };
  providerId = boot2.providerId;
  regions = [...boot2.regions];
  buildOverlay();
  window.__llmRegionOverlayMounted = true;
  renderRegions();
  // 加载 IndexedDB 草稿（防抖持久化的工作集），与主进程下发合并
  void idbLoadRegions(providerId)
    .then((drafts) => {
      if (drafts.length) {
        const byId = new Map(regions.map((r) => [r.id, r]));
        for (const d of drafts) byId.set(d.id, d);
        regions = [...byId.values()].sort((a, b) => a.lastModified - b.lastModified);
        renderRegions();
      }
    })
    .catch(() => undefined);
}
