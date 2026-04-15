import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { defaultShops } from './lib/shopSeeds';
import { noPhotoDataUrl } from './lib/placeholders';
import { deleteShopImage, executeCsvImport, getConnectionLabel, getImageBucketName, listShops, previewCsvImport, removeShop, upsertShop, uploadShopImage } from './lib/shopService';
import { getAdminAuthState, signInAdmin, signOutAdmin } from './lib/authService';
import type { CsvImportPreview, Shop, ShopDraft, ShopImage, ShopImageType, Tag } from './lib/types';

const originOptions = ['吉村家系', '本牧家系', '六角家系'];
const tags: Tag[] = ['直系', '独立系', '資本系'];
const defaultCenter: [number, number] = [35.681236, 139.767125];
const imageTypeLabels: Record<ShopImageType, string> = { slot1: '1', slot2: '2', slot3: '3' };
const imageTypeOrder: ShopImageType[] = ['slot1', 'slot2', 'slot3'];

type GenealogyNodeLink = {
  kind: 'shop' | 'list';
  to: string;
};

type GenealogyNodeAccent = 'origin' | 'direct' | 'independent' | 'capital';

type GenealogyGraphNode = {
  id: string;
  nodoId: string;
  name: string;
  subtitle: string;
  depth: number;
  accent: GenealogyNodeAccent;
  link: GenealogyNodeLink;
  shopIds: string[];
  shopCount: number;
  tag: Tag;
  isClosed: boolean;
};

type GenealogyGraphEdge = {
  from: string;
  to: string;
};

type GenealogyGraph = {
  columns: GenealogyGraphNode[][];
  edges: GenealogyGraphEdge[];
  nodesById: Map<string, GenealogyGraphNode>;
  parentsByNodeId: Map<string, string[]>;
  childrenByNodeId: Map<string, string[]>;
  roots: string[];
};

function getGenealogyAccent(tag: Tag): GenealogyNodeAccent {
  if (tag === '直系') return 'direct';
  if (tag === '資本系') return 'capital';
  return 'independent';
}

function getNodeDisplayName(shop: Pick<Shop, 'name' | 'nodeName'>) {
  return shop.nodeName?.trim() || shop.name.trim() || '名称未設定';
}

function blurActiveElement() {
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    active.blur();
  }
}

function isPublicShop(shop: Shop) {
  return !shop.isClosed;
}

function getCommonNodeName(shops: Shop[]) {
  if (shops.length === 1) return getNodeDisplayName(shops[0]);
  const names = shops.map((shop) => getNodeDisplayName(shop)).filter(Boolean);
  if (!names.length) return '名称未設定';

  let prefix = names[0];
  for (const name of names.slice(1)) {
    while (prefix && !name.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }

  const trimmed = prefix.replace(/[\s\-–ー・]+$/, '').trim();
  if (trimmed.length >= 2) return trimmed;
  return `${names[0]} ほか`;
}


function getTouchDistance(touches: { clientX: number; clientY: number }[]) {
  if (touches.length < 2) return 0;
  const [a, b] = touches;
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const GENEALOGY_BASE_SCALE = 0.7;
const GENEALOGY_MIN_ZOOM = 0.3;
const GENEALOGY_MAX_ZOOM = 2.4;

function buildGenealogyUrl({
  tag,
  query,
  focusNodeId,
  zoom,
}: {
  tag: Tag;
  query?: string;
  focusNodeId?: string | null;
  zoom?: number;
}) {
  const params = new URLSearchParams();
  params.set('tag', tag);
  if (query?.trim()) params.set('q', query.trim());
  if (focusNodeId) params.set('focus', focusNodeId);
  if (zoom !== undefined) params.set('zoom', String(Number(zoom.toFixed(2))));
  const queryString = params.toString();
  return `/genealogy${queryString ? `?${queryString}` : ''}`;
}

function buildGenealogyGraph(shops: Shop[], activeTag: Tag): GenealogyGraph {
  const tagShops = shops.filter((shop) => shop.tag === activeTag);
  const nodesMap = new Map<string, GenealogyGraphNode>();
  const shopToNodeId = new Map<string, string>();

  const groups = new Map<string, Shop[]>();
  tagShops.forEach((shop) => {
    const nodeId = shop.nodoId || shop.id;
    const list = groups.get(nodeId) ?? [];
    list.push(shop);
    groups.set(nodeId, list);
    shopToNodeId.set(shop.id, nodeId);
  });

  groups.forEach((groupShops, nodeId) => {
    const sorted = [...groupShops].sort((a, b) => getNodeDisplayName(a).localeCompare(getNodeDisplayName(b), 'ja'));
    const publicShops = sorted.filter(isPublicShop);
    const closedShops = sorted.filter((shop) => shop.isClosed);
    const representative = publicShops[0] ?? sorted[0];
    const isClosedNode = publicShops.length === 0 && closedShops.length > 0;
    const displayShops = isClosedNode ? closedShops : (publicShops.length ? publicShops : sorted);
    const isMulti = !isClosedNode && publicShops.length > 1;
    nodesMap.set(nodeId, {
      id: nodeId,
      nodoId: nodeId,
      name: getCommonNodeName(displayShops),
      subtitle: isClosedNode ? '閉店済み' : (isMulti ? `${publicShops.length}店舗をまとめて表示` : '店舗詳細へ'),
      depth: 0,
      accent: getGenealogyAccent(representative.tag),
      link: isMulti
        ? { kind: 'list', to: `/shops?nodoId=${encodeURIComponent(nodeId)}` }
        : { kind: 'shop', to: `/shops/${representative.id}` },
      shopIds: displayShops.map((shop) => shop.id),
      shopCount: displayShops.length,
      tag: representative.tag,
      isClosed: isClosedNode,
    });
  });

  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  const edgeKeys = new Set<string>();

  const addEdge = (fromShopId: string | null, toShopId: string | null) => {
    if (!fromShopId || !toShopId || fromShopId === toShopId) return;
    const fromNodeId = shopToNodeId.get(fromShopId);
    const toNodeId = shopToNodeId.get(toShopId);
    if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return;

    const key = `${fromNodeId}->${toNodeId}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);

    const nextOutgoing = outgoing.get(fromNodeId) ?? new Set<string>();
    nextOutgoing.add(toNodeId);
    outgoing.set(fromNodeId, nextOutgoing);

    const nextIncoming = incoming.get(toNodeId) ?? new Set<string>();
    nextIncoming.add(fromNodeId);
    incoming.set(toNodeId, nextIncoming);
  };

  tagShops.forEach((shop) => {
    addEdge(shop.parentId, shop.id);
  });

  const nodeIds = [...nodesMap.keys()].sort((a, b) => {
    const aName = nodesMap.get(a)?.name ?? '';
    const bName = nodesMap.get(b)?.name ?? '';
    return aName.localeCompare(bName, 'ja');
  });

  const roots = nodeIds.filter((nodeId) => (incoming.get(nodeId)?.size ?? 0) === 0);
  const depthByNodeId = new Map<string, number>();
  roots.forEach((nodeId) => depthByNodeId.set(nodeId, 0));

  const traverseDepth = (nodeId: string, depth: number, trail: Set<string>) => {
    const currentDepth = depthByNodeId.get(nodeId);
    if (currentDepth === undefined || depth > currentDepth) {
      depthByNodeId.set(nodeId, depth);
    }

    if (trail.has(nodeId)) return;
    trail.add(nodeId);

    const children = [...(outgoing.get(nodeId) ?? new Set<string>())].sort((a, b) => {
      const aName = nodesMap.get(a)?.name ?? '';
      const bName = nodesMap.get(b)?.name ?? '';
      return aName.localeCompare(bName, 'ja');
    });

    children.forEach((childId) => traverseDepth(childId, depth + 1, new Set(trail)));
  };

  roots.forEach((rootId) => traverseDepth(rootId, 0, new Set()));

  nodeIds.forEach((nodeId) => {
    if (!depthByNodeId.has(nodeId)) {
      depthByNodeId.set(nodeId, incoming.get(nodeId)?.size ? 1 : 0);
    }
  });

  const parentsByNodeId = new Map<string, string[]>();
  const childrenByNodeId = new Map<string, string[]>();

  nodeIds.forEach((nodeId) => {
    parentsByNodeId.set(nodeId, [...(incoming.get(nodeId) ?? new Set<string>())].sort((a, b) => {
      const aName = nodesMap.get(a)?.name ?? '';
      const bName = nodesMap.get(b)?.name ?? '';
      return aName.localeCompare(bName, 'ja');
    }));
    childrenByNodeId.set(nodeId, [...(outgoing.get(nodeId) ?? new Set<string>())].sort((a, b) => {
      const aName = nodesMap.get(a)?.name ?? '';
      const bName = nodesMap.get(b)?.name ?? '';
      return aName.localeCompare(bName, 'ja');
    }));
  });

  const visited = new Set<string>();
  const orderedNodeIds: string[] = [];

  const visitForOrder = (nodeId: string) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    orderedNodeIds.push(nodeId);
    (childrenByNodeId.get(nodeId) ?? []).forEach((childId) => visitForOrder(childId));
  };

  roots.forEach((rootId) => visitForOrder(rootId));
  nodeIds.forEach((nodeId) => visitForOrder(nodeId));

  const maxDepth = orderedNodeIds.reduce((max, nodeId) => Math.max(max, depthByNodeId.get(nodeId) ?? 0), 0);
  const columns: GenealogyGraphNode[][] = Array.from({ length: maxDepth + 1 }, () => []);

  orderedNodeIds
    .map((nodeId) => {
      const node = nodesMap.get(nodeId)!;
      return { ...node, depth: depthByNodeId.get(nodeId) ?? 0 };
    })
    .forEach((node) => {
      columns[node.depth] ??= [];
      columns[node.depth].push(node);
    });

  const edges: GenealogyGraphEdge[] = [...edgeKeys].map((key) => {
    const [from, to] = key.split('->');
    return { from, to };
  }).filter((edge) => {
    const fromDepth = depthByNodeId.get(edge.from);
    const toDepth = depthByNodeId.get(edge.to);
    return fromDepth !== undefined && toDepth !== undefined && toDepth > fromDepth;
  });

  const nodesById = new Map<string, GenealogyGraphNode>();
  columns.flat().forEach((node) => nodesById.set(node.id, node));

  return { columns, edges, nodesById, parentsByNodeId, childrenByNodeId, roots };
}

function getShopImagesInDisplayOrder(images: ShopImage[]) {

  return [...images].sort((a, b) => imageTypeOrder.indexOf(a.imageType) - imageTypeOrder.indexOf(b.imageType));
}

function getPrimaryShopImage(shop: Shop) {
  return getShopImagesInDisplayOrder(shop.images)[0]?.publicUrl || noPhotoDataUrl;
}

function getDetailHeroImages(shop: Shop) {
  const uploadedImages = getShopImagesInDisplayOrder(shop.images).filter((item) => item.publicUrl?.trim());
  if (uploadedImages.length) return uploadedImages;
  return [{ id: 'no-photo', shopId: shop.id, imageType: 'slot1' as ShopImageType, storagePath: '', publicUrl: noPhotoDataUrl, sortOrder: 1, createdAt: '', updatedAt: '' }];
}


function useShops() {
  const [shops, setShops] = useState<Shop[]>(defaultShops);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      setLoading(true);
      const items = await listShops();
      setShops(items);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '店舗データの読み込みに失敗しました。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  return { shops, loading, error, refresh };
}

function normalizeText(value: string) {
  return value.trim().toLowerCase();
}

type SearchFilters = {
  q: string;
  origin: string;
  tag: Tag | '';
  parking: boolean | null;
  nodoId: string;
};

type MapEntrySource = 'home' | 'searchResults' | 'detail';
type MapViewSnapshot = { center: [number, number]; zoom: number };

type OsmSearchResult = {
  name: string;
  center: [number, number];
};

const osmRequestCooldownMs = 1800;

function shopMatchesKeyword(shop: Shop, keyword: string) {
  const term = normalizeText(keyword);
  if (!term) return true;
  const target = [shop.name, shop.address, shop.station].join(' ').toLowerCase();
  return target.includes(term);
}

function filterShops(shops: Shop[], filters: SearchFilters) {
  return shops.filter((shop) => {
    if (!isPublicShop(shop)) return false;
    const hitKeyword = shopMatchesKeyword(shop, filters.q);
    const hitOrigin = !filters.origin || shop.origin === filters.origin;
    const hitTag = !filters.tag || shop.tag === filters.tag;
    const hitParking = filters.parking === null || shop.parking === filters.parking;
    const hitNodo = !filters.nodoId || shop.nodoId === filters.nodoId;
    return hitKeyword && hitOrigin && hitTag && hitParking && hitNodo;
  });
}

function readSearchFilters(searchParams: URLSearchParams): SearchFilters {
  const tag = (searchParams.get('tag') as Tag | null) ?? '';
  const parkingParam = searchParams.get('parking');
  return {
    q: searchParams.get('q') ?? '',
    origin: searchParams.get('origin') ?? '',
    tag,
    parking: parkingParam === 'true' ? true : parkingParam === 'false' ? false : null,
    nodoId: searchParams.get('nodoId') ?? '',
  };
}

function buildSearchParams(filters: SearchFilters) {
  const next = new URLSearchParams();
  if (filters.q.trim()) next.set('q', filters.q.trim());
  if (filters.origin) next.set('origin', filters.origin);
  if (filters.tag) next.set('tag', filters.tag);
  if (filters.parking !== null) next.set('parking', String(filters.parking));
  if (filters.nodoId) next.set('nodoId', filters.nodoId);
  return next;
}

function buildSearchUrl(filters: SearchFilters) {
  const query = buildSearchParams(filters).toString();
  return `/shops${query ? `?${query}` : ''}`;
}

function createEmptySearchFilters(): SearchFilters {
  return { q: '', origin: '', tag: '', parking: null, nodoId: '' };
}

function hasSearchFilters(filters: SearchFilters) {
  return Boolean(filters.q.trim() || filters.origin.trim() || filters.tag || filters.parking !== null || filters.nodoId);
}

function canUseBrowserBack() {
  if (typeof window === 'undefined') return false;
  const historyState = window.history.state as { idx?: number } | null;
  return typeof historyState?.idx === 'number' && historyState.idx > 0;
}

function navigateBack(
  navigate: ReturnType<typeof useNavigate>,
  fallbackTo = '/',
  fallbackState?: Record<string, unknown>,
) {
  if (canUseBrowserBack()) {
    navigate(-1);
    return;
  }

  navigate(fallbackTo, fallbackState ? { replace: true, state: fallbackState } : { replace: true });
}

function useClickOutside<T extends HTMLElement>(onOutsideClick: () => void, enabled = true) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (!ref.current) return;
      const target = event.target;
      if (target instanceof Node && !ref.current.contains(target)) {
        onOutsideClick();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [enabled, onOutsideClick]);

  return ref;
}

async function searchOsmPlace(keyword: string): Promise<OsmSearchResult | null> {
  const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(keyword)}`, {
    headers: {
      'Accept': 'application/json',
      'Accept-Language': 'ja',
    },
  });

  if (!response.ok) {
    throw new Error('地点検索に失敗しました。時間をおいてもう一度お試しください。');
  }

  const rows = await response.json() as Array<{ lat?: string; lon?: string; display_name?: string }>;
  const first = rows[0];
  if (!first?.lat || !first?.lon) return null;

  return {
    name: first.display_name?.trim() || keyword,
    center: [Number(first.lat), Number(first.lon)],
  };
}

function formatHoursInline(hours: string) {
  return hours.replace(/\n+/g, ' / ').trim();
}

function buildTelHref(phone: string) {
  const sanitized = phone.replace(/[^\d+]/g, '');
  if (!sanitized) return '';
  return `tel:${sanitized}`;
}

function renderExternalLink(url: string) {
  if (!url) return '未設定';
  return <a href={url} target="_blank" rel="noreferrer" className="detail-link">{url}</a>;
}

function renderPhoneLink(phone: string) {
  if (!phone) return '未設定';
  const telHref = buildTelHref(phone);
  if (!telHref) return phone;
  return <a href={telHref} className="detail-link">{phone}</a>;
}

function createShopMarkerIcon(selected: boolean) {
  return L.divIcon({
    className: 'custom-marker-wrapper',
    html: `<span class="custom-marker-dot ${selected ? 'selected' : ''}"></span>`,
    iconSize: [20, 20],
    iconAnchor: [10, 20],
    popupAnchor: [0, -16]
  });
}

export default function App() {
  const shopState = useShops();

  return (
    <div className="app-shell">
      <Routes>
        <Route path="/" element={<HomePage shops={shopState.shops} />} />
        <Route path="/shops" element={<ShopSearchPage shops={shopState.shops} loading={shopState.loading} />} />
        <Route path="/map" element={<MapPage shops={shopState.shops} />} />
        <Route path="/genealogy" element={<GenealogyPage shops={shopState.shops} loading={shopState.loading} />} />
        <Route path="/shops/:shopId" element={<ShopDetailPage shops={shopState.shops} />} />
        <Route path="/areas" element={<Navigate to="/shops" replace />} />
        <Route path="/admin/login" element={<AdminLoginPage />} />
        <Route path="/admin" element={<AdminRoute><Navigate to="/admin-8fj3k2-3me77nfcb6c0" replace /></AdminRoute>} />
        <Route path="/admin-8fj3k2-3me77nfcb6c0" element={<AdminRoute><AdminTopPage shops={shopState.shops} /></AdminRoute>} />
        <Route path="/admin/shops" element={<AdminRoute><AdminShopsPage shops={shopState.shops} loading={shopState.loading} onDeleted={shopState.refresh} onRefresh={shopState.refresh} /></AdminRoute>} />
        <Route path="/admin/shops/:shopId" element={<AdminRoute><AdminEditPage shops={shopState.shops} onSaved={shopState.refresh} /></AdminRoute>} />
      </Routes>
    </div>
  );
}

function AdminRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const state = await getAdminAuthState();
        if (!active) return;
        setAllowed(state.loggedIn && state.isAdmin);
      } catch {
        if (!active) return;
        setAllowed(false);
      } finally {
        if (active) setLoading(false);
      }
    };
    void run();
    return () => {
      active = false;
    };
  }, [location.pathname]);

  if (loading) {
    return <main className="page"><Header title="管理画面を確認中" /><section className="section compact"><p>ログイン状態を確認しています...</p></section></main>;
  }

  if (!allowed) {
    return <Navigate to="/admin/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return children;
}

function Header({ title, backTo, backState, eyebrow = '家系行脚', backLabel = '← 戻る', className = '', hideTitle = false }: { title: string; backTo?: string; backState?: Record<string, unknown>; eyebrow?: string; backLabel?: string; className?: string; hideTitle?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = (location.state as { backTo?: string; backState?: Record<string, unknown> } | null) ?? null;
  const resolvedBackTo = backTo ?? locationState?.backTo ?? '/';
  const resolvedBackState = backState ?? locationState?.backState;

  return (
    <header className={`page-header ${className}`.trim()}>
      <div>
        {(backTo || locationState?.backTo || canUseBrowserBack()) ? (
          <button
            type="button"
            className="back-link back-link-button"
            onClick={() => navigateBack(navigate, resolvedBackTo, resolvedBackState)}
          >
            {backLabel}
          </button>
        ) : <span className="eyebrow">{eyebrow}</span>}
        {hideTitle ? null : <h1>{title}</h1>}
      </div>
    </header>
  );
}

function HomePage(_: { shops: Shop[] }) {
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState('');

  return (
    <main className="page home-page home-page-compact">
      <section className="home-hero-card">
        <img className="home-logo" src="/iekei-angya-logo.png" alt="家系行脚" />
        <p className="home-title">家系ラーメンを探す</p>
        <div className="home-action-frame">
          <form
            className="search-box home-search-box"
            onSubmit={(event) => {
              event.preventDefault();
              navigate(`/shops?q=${encodeURIComponent(keyword)}`);
            }}
          >
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="店名 / 住所 / 最寄り駅で検索"
            />
            <button type="submit" className="primary-button">検索</button>
          </form>
          <div className="cta-grid home-cta-grid">
            <Link className="primary-button block" to="/map" state={{ autoLocate: true }}>近くで探す</Link>
            <Link className="secondary-button home-secondary-button block" to="/genealogy">系譜図を見る</Link>
          </div>
        </div>
      </section>
      <BottomNav />
    </main>
  );
}

function ShopSearchPage({ shops, loading }: { shops: Shop[]; loading: boolean }) {
  const location = useLocation();
  const locationState = (location.state as { backTo?: string; backState?: Record<string, unknown> } | null) ?? null;
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readSearchFilters(searchParams);
  const [searchText, setSearchText] = useState(filters.q);

  useEffect(() => {
    setSearchText(filters.q);
  }, [filters.q]);

  const filtered = useMemo(() => filterShops(shops, filters), [filters, shops]);

  const updateFilters = (nextValues: Partial<SearchFilters>) => {
    const nextFilters: SearchFilters = {
      q: nextValues.q ?? filters.q,
      origin: nextValues.origin ?? filters.origin,
      tag: nextValues.tag ?? filters.tag,
      parking: nextValues.parking === undefined ? filters.parking : nextValues.parking,
      nodoId: nextValues.nodoId ?? filters.nodoId,
    };
    setSearchParams(buildSearchParams(nextFilters), { replace: true });
  };

  const handleSearchSubmit = (event: FormEvent) => {
    event.preventDefault();
    updateFilters({ q: searchText });
  };

  const currentSearchUrl = buildSearchUrl(filters);
  const mapLink = `/map${(() => {
    const query = buildSearchParams(filters).toString();
    return query ? `?${query}` : '';
  })()}`;

  return (
    <main className="page">
      <Header title="検索結果" backTo={locationState?.backTo ?? "/"} backState={locationState?.backState} />
      <section className="sticky-panel">
        <form onSubmit={handleSearchSubmit} className="search-box stacked-mobile">
          <input className="full-input" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="店名 / 住所 / 最寄り駅" />
          <button type="submit" className="primary-button">検索</button>
        </form>
        <div className="filter-inline-row">
          <FilterDropdown
            placeholder="源流"
            value={filters.origin}
            options={originOptions.map((item) => ({ value: item, label: item }))}
            onChange={(value) => updateFilters({ origin: value })}
          />
          <FilterDropdown
            placeholder="直/独/資"
            value={filters.tag}
            options={tags.map((item) => ({ value: item, label: item }))}
            onChange={(value) => updateFilters({ tag: value as Tag | '' })}
          />
          <div className={`toggle-filter ${filters.parking !== null ? 'is-active' : ''}`}>
            <button type="button" className={filters.parking === true ? 'is-selected' : ''} onClick={() => updateFilters({ parking: filters.parking === true ? null : true })}>駐車場あり</button>
            <button type="button" className={filters.parking === false ? 'is-selected' : ''} onClick={() => updateFilters({ parking: filters.parking === false ? null : false })}>駐車場なし</button>
          </div>
        </div>
      </section>
      <section className="section compact">
        <div className="section-head">
          <h2>検索結果</h2>
          <div className="section-head-actions">
            <span>{loading ? '読み込み中' : `${filtered.length}件`}</span>
            <Link to={mapLink} state={{ backTo: currentSearchUrl, entrySource: 'searchResults' as MapEntrySource }} className="text-link">地図で見る</Link>
          </div>
        </div>
        {filtered.map((shop) => <ShopCard key={shop.id} shop={shop} backTo={currentSearchUrl} />)}
        {!loading && filtered.length === 0 ? <p className="empty-text">条件に合う店舗が見つかりませんでした。</p> : null}
      </section>
      <BottomNav />
    </main>
  );
}

function MapPage({ shops }: { shops: Shop[] }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFilters = useMemo(() => readSearchFilters(searchParams), [searchParams]);
  const ids = useMemo(() => (searchParams.get('ids') ?? '').split(',').filter(Boolean), [searchParams]);
  const initialSelected = searchParams.get('selected') ?? '';
  const initialOsmMode = searchParams.get('osm') === '1';
  const locationState = (location.state as { backTo?: string; backState?: Record<string, unknown>; autoLocate?: boolean; entrySource?: MapEntrySource } | null) ?? null;
  const initialEntrySource: MapEntrySource = locationState?.entrySource ?? 'home';
  const [entrySource, setEntrySource] = useState<MapEntrySource>(initialEntrySource);
  const [hasMapSearched, setHasMapSearched] = useState(false);
  const [selectedShopId, setSelectedShopId] = useState(initialSelected);
  const [isOsmSearchMode, setIsOsmSearchMode] = useState(initialOsmMode);
  const [searchText, setSearchText] = useState(initialFilters.q);
  const [activeFilters, setActiveFilters] = useState<SearchFilters>(initialFilters);
  const [draftFilters, setDraftFilters] = useState<SearchFilters>(initialFilters);
  const [expanded, setExpanded] = useState(initialEntrySource === 'searchResults' && !!(initialFilters.q || initialFilters.origin || initialFilters.tag || initialFilters.parking !== null));
  const [visibleShops, setVisibleShops] = useState<Shop[]>(() => ids.length ? shops.filter((shop) => ids.includes(shop.id) && isPublicShop(shop)) : filterShops(shops, initialFilters));
  const [mapCenter, setMapCenter] = useState<[number, number]>(defaultCenter);
  const [mapZoom, setMapZoom] = useState(12);
  const [fitToShops, setFitToShops] = useState<boolean>(() => !ids.length);
  const [fitRequestKey, setFitRequestKey] = useState(0);
  const [suppressViewportMoveKey, setSuppressViewportMoveKey] = useState(0);
  const [userPosition, setUserPosition] = useState<[number, number] | null>(null);
  const [searchMessage, setSearchMessage] = useState('');
  const [isOsmSearching, setIsOsmSearching] = useState(false);
  const lastOsmRequestAtRef = useRef(0);
  const mapViewRef = useRef<MapViewSnapshot>({ center: defaultCenter, zoom: 12 });
  const preserveViewOnNextSyncRef = useRef(false);
  const skipAutoSelectOnNextSyncRef = useRef(false);
  const selectedShopSourceRef = useRef<'mapPin' | 'other'>('other');
  const allPublicShops = useMemo(() => shops.filter(isPublicShop), [shops]);

  useEffect(() => {
    setEntrySource(initialEntrySource);
  }, [initialEntrySource]);

  useEffect(() => {
    setIsOsmSearchMode(initialOsmMode);
  }, [initialOsmMode]);

  useEffect(() => {
    selectedShopSourceRef.current = 'other';
    setSelectedShopId(initialSelected);
  }, [initialSelected]);

  useEffect(() => {
    setSearchText(initialFilters.q);
    setActiveFilters(initialFilters);
    setDraftFilters(initialFilters);
    if (ids.length) {
      const nextVisible = shops.filter((shop) => ids.includes(shop.id) && isPublicShop(shop));
      setVisibleShops(nextVisible);
      setFitToShops(false);
      preserveViewOnNextSyncRef.current = false;
      if (nextVisible.length === 1 && initialSelected) {
        selectedShopSourceRef.current = 'other';
        setSelectedShopId(initialSelected);
      }
    } else {
      const filteredShops = filterShops(shops, initialFilters);
      const nextVisible = isOsmSearchMode ? allPublicShops : filteredShops;
      setVisibleShops(nextVisible);
      const shouldPreserveView = preserveViewOnNextSyncRef.current;
      if (shouldPreserveView) {
        preserveViewOnNextSyncRef.current = false;
      }
      const hasInitialFilters = hasSearchFilters(initialFilters);
      const shouldAutoSelectSingle = !isOsmSearchMode && hasInitialFilters && filteredShops.length === 1 && !skipAutoSelectOnNextSyncRef.current;
      const shouldFitAll = shouldPreserveView
        ? false
        : (isOsmSearchMode ? false : (hasInitialFilters ? filteredShops.length > 1 : selectedShopId ? false : !hasMapSearched));
      setFitToShops(shouldFitAll);
      if (skipAutoSelectOnNextSyncRef.current) {
        skipAutoSelectOnNextSyncRef.current = false;
      }
      if (shouldAutoSelectSingle) {
        selectedShopSourceRef.current = 'other';
        setSelectedShopId(filteredShops[0]?.id ?? '');
      }
    }
    setSearchMessage('');
  }, [allPublicShops, hasMapSearched, ids, initialFilters, isOsmSearchMode, selectedShopId, shops]);

  useEffect(() => {
    if (selectedShopId && !visibleShops.some((shop) => shop.id === selectedShopId)) {
      selectedShopSourceRef.current = 'other';
      setSelectedShopId('');
    }
  }, [selectedShopId, visibleShops]);

  const selectedShop = visibleShops.find((shop) => shop.id === selectedShopId) ?? null;

  useEffect(() => {
    if (!searchMessage) return;
    const timer = window.setTimeout(() => setSearchMessage(''), 3000);
    return () => window.clearTimeout(timer);
  }, [searchMessage]);

  const currentMapUrl = useMemo(() => {
    const params = hasMapSearched ? buildSearchParams(activeFilters) : new URLSearchParams(searchParams);
    if (isOsmSearchMode) params.set('osm', '1');
    else params.delete('osm');
    if (selectedShopId) params.set('selected', selectedShopId);
    else params.delete('selected');
    const query = params.toString();
    return `/map${query ? `?${query}` : ''}`;
  }, [activeFilters, hasMapSearched, isOsmSearchMode, searchParams, selectedShopId]);

  const mapReturnUrl = useMemo(() => {
    const params = hasMapSearched ? buildSearchParams(activeFilters) : new URLSearchParams(searchParams);
    if (isOsmSearchMode) params.set('osm', '1');
    else params.delete('osm');
    params.delete('selected');
    const query = params.toString();
    return `/map${query ? `?${query}` : ''}`;
  }, [activeFilters, hasMapSearched, isOsmSearchMode, searchParams]);

  const backTarget = entrySource === 'detail'
    ? (locationState?.backTo ?? '/')
    : entrySource === 'searchResults'
      ? (locationState?.backTo ?? buildSearchUrl(activeFilters))
      : '/';
  const backState = locationState?.backState;

  const handleCurrentLocation = useCallback(() => {
    if (!navigator.geolocation) {
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const nextPosition: [number, number] = [position.coords.latitude, position.coords.longitude];
        setUserPosition(nextPosition);
        setMapCenter(nextPosition);
        setMapZoom(15);
        setFitToShops(false);
        selectedShopSourceRef.current = 'other';
        setSelectedShopId('');
        setSearchMessage('');
      },
      undefined,
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  }, []);

  useEffect(() => {
    if (!locationState?.autoLocate || userPosition) return;
    handleCurrentLocation();
  }, [handleCurrentLocation, locationState?.autoLocate, userPosition]);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });

    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyOverscroll = document.body.style.overscrollBehavior;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousHtmlOverscroll = document.documentElement.style.overscrollBehavior;

    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';
    document.documentElement.style.overflow = 'hidden';
    document.documentElement.style.overscrollBehavior = 'none';

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.overscrollBehavior = previousBodyOverscroll;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.documentElement.style.overscrollBehavior = previousHtmlOverscroll;
    };
  }, []);

  const hasActiveMapFilter = hasSearchFilters(activeFilters) || ids.length > 0;

  const handleCloseCard = useCallback(() => {
    const currentView = mapViewRef.current;
    const hadIdFilter = ids.length > 0;
    const hadSearchFilter = hasSearchFilters(activeFilters) && !isOsmSearchMode;
    const hadSubsetFilter = hadIdFilter || hadSearchFilter;
    const hadMultipleFilteredShops = visibleShops.length > 1;

    selectedShopSourceRef.current = 'other';
    setSelectedShopId('');

    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('selected');

    if (!hadSubsetFilter || !hadMultipleFilteredShops) {
      preserveViewOnNextSyncRef.current = true;
      skipAutoSelectOnNextSyncRef.current = true;
      setVisibleShops(allPublicShops);
      setFitToShops(false);
      setMapCenter(currentView.center);
      setMapZoom(currentView.zoom);
      nextParams.delete('ids');
      setSearchParams(nextParams, { replace: true });
      return;
    }

    setFitToShops(true);
    setFitRequestKey((current) => current + 1);
    setSearchParams(nextParams, { replace: true });
  }, [activeFilters, allPublicShops, ids.length, isOsmSearchMode, searchParams, setSearchParams, visibleShops.length]);

  const handleClearMapSearch = useCallback(() => {
    const clearedFilters = createEmptySearchFilters();
    const currentView = mapViewRef.current;
    preserveViewOnNextSyncRef.current = true;
    setSearchText('');
    setDraftFilters(clearedFilters);
    setActiveFilters(clearedFilters);
    setHasMapSearched(false);
    setIsOsmSearchMode(false);
    selectedShopSourceRef.current = 'other';
    setSelectedShopId('');
    setVisibleShops(allPublicShops);
    setFitToShops(false);
    setUserPosition(null);
    setSearchMessage('');
    setMapCenter(currentView.center);
    setMapZoom(currentView.zoom);
    setSearchParams(new URLSearchParams(), { replace: true });
  }, [allPublicShops, setSearchParams]);

  const applyMapFilters = useCallback((nextFilters: SearchFilters) => {
    setDraftFilters(nextFilters);
    setActiveFilters(nextFilters);
    setHasMapSearched(true);
    setIsOsmSearchMode(false);
    preserveViewOnNextSyncRef.current = true;
    skipAutoSelectOnNextSyncRef.current = true;
    selectedShopSourceRef.current = 'other';
    setSelectedShopId('');
    setSearchMessage('');
    setUserPosition(null);
    setSuppressViewportMoveKey((current) => current + 1);

    const nextVisibleShops = filterShops(shops, { ...nextFilters, q: searchText });
    setVisibleShops(nextVisibleShops);
    setFitToShops(false);

    const nextParams = buildSearchParams({ ...nextFilters, q: searchText });
    nextParams.delete('osm');
    nextParams.delete('selected');
    setSearchParams(nextParams, { replace: true });
  }, [searchText, setSearchParams, shops]);

  const applyMapSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    blurActiveElement();
    const nextFilters: SearchFilters = { ...draftFilters, q: searchText };
    setDraftFilters(nextFilters);
    setActiveFilters(nextFilters);
    setHasMapSearched(true);
    setIsOsmSearchMode(false);
    selectedShopSourceRef.current = 'other';
    setSelectedShopId('');
    setSearchMessage('');
    setUserPosition(null);

    const nextVisibleShops = filterShops(shops, nextFilters);
    setVisibleShops(nextVisibleShops);

    const nextParams = buildSearchParams(nextFilters);
    nextParams.delete('osm');
    if (nextVisibleShops.length === 1) {
      nextParams.set('selected', nextVisibleShops[0].id);
      selectedShopSourceRef.current = 'other';
      setSelectedShopId(nextVisibleShops[0].id);
      setFitToShops(false);
    } else {
      setFitToShops(nextVisibleShops.length > 1);
    }
    setSearchParams(nextParams, { replace: true });

    if (nextVisibleShops.length) {
      setUserPosition(null);
      return;
    }

    const keyword = nextFilters.q.trim();
    if (!keyword) {
      setFitToShops(false);
      setMapCenter(defaultCenter);
      setMapZoom(12);
      return;
    }

    const now = Date.now();
    const waitMs = lastOsmRequestAtRef.current ? osmRequestCooldownMs - (now - lastOsmRequestAtRef.current) : 0;
    if (waitMs > 0) {
      await new Promise((resolve) => window.setTimeout(resolve, waitMs));
    }

    try {
      setIsOsmSearching(true);
      lastOsmRequestAtRef.current = Date.now();
      const result = await searchOsmPlace(keyword);
      if (!result) {
        setSearchMessage('登録のない地点のため、場所が見つかりませんでした');
        setFitToShops(false);
        return;
      }
      setVisibleShops(allPublicShops);
      setMapCenter(result.center);
      setMapZoom(15);
      setFitToShops(false);
      setIsOsmSearchMode(true);
      nextParams.set('osm', '1');
      setSearchParams(nextParams, { replace: true });
    } catch (err) {
      setSearchMessage(err instanceof Error ? err.message : '地点検索に失敗しました。');
      setFitToShops(false);
    } finally {
      setIsOsmSearching(false);
    }
  };

  return (
    <main className="page map-page">
      <MapSearchHeader
        value={searchText}
        onValueChange={setSearchText}
        onBack={() => navigateBack(navigate, backTarget, backState)}
        onClear={handleClearMapSearch}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((current) => !current)}
        onCollapse={() => setExpanded(false)}
        filters={draftFilters}
        onFiltersChange={applyMapFilters}
        onSearch={applyMapSearch}
        searching={isOsmSearching}
        message={searchMessage}
      />
      <section className="map-frame full-bleed-map-frame">
        <div className="map-canvas full-bleed-map with-overlay-card has-map-search-ui">
          <MapContainer center={mapCenter} zoom={mapZoom} zoomControl={false} scrollWheelZoom touchZoom className="leaflet-map">
            <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapViewportController center={userPosition ?? mapCenter} targetZoom={userPosition ? mapZoom : mapZoom} shops={visibleShops} fitToShops={fitToShops} fitRequestKey={fitRequestKey} suppressMoveKey={suppressViewportMoveKey} selectedShop={selectedShop} onViewChange={(snapshot) => { mapViewRef.current = snapshot; }} />
            {visibleShops.map((shop) => {
              const selected = selectedShopId === shop.id;
              return (
                <Marker
                  key={shop.id}
                  position={[shop.lat, shop.lng]}
                  icon={createShopMarkerIcon(selected)}
                  eventHandlers={{
                    click: () => {
                      const nextParams = new URLSearchParams(searchParams);

                      if (selectedShopId === shop.id) {
                        selectedShopSourceRef.current = 'other';
                        setSelectedShopId('');
                        nextParams.delete('selected');
                        setSearchParams(nextParams, { replace: true });
                        return;
                      }

                      selectedShopSourceRef.current = 'mapPin';
                      setSelectedShopId(shop.id);
                      nextParams.set('selected', shop.id);
                      setSearchParams(nextParams, { replace: true });
                    }
                  }}
                />
              );
            })}
            {userPosition ? <Marker position={userPosition} icon={currentLocationIcon} /> : null}
          </MapContainer>
          <div className="fab-group fab-group-single">
            <button className="fab" onClick={handleCurrentLocation}>現在地</button>
          </div>
          {selectedShop ? (
            <div className="map-overlay-card">
              <button type="button" className="map-card-close-button" aria-label="店舗カードを閉じる" onClick={handleCloseCard}>×</button>
              <ShopCard shop={selectedShop} compact backTo={currentMapUrl} backState={{ backTo: backTarget, backState, entrySource }} />
            </div>
          ) : null}
        </div>
      </section>
      <BottomNav className="map-bottom-nav" />
    </main>
  );
}

function MapSearchHeader({
  value,
  onValueChange,
  onClear,
  onBack,
  expanded,
  onToggleExpanded,
  onCollapse,
  filters,
  onFiltersChange,
  onSearch,
  searching,
  message,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onClear: () => void;
  onBack: () => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  onCollapse: () => void;
  filters: SearchFilters;
  onFiltersChange: (value: SearchFilters) => void;
  onSearch: (event?: FormEvent) => Promise<void>;
  searching: boolean;
  message: string;
}) {
  const shellRef = useClickOutside<HTMLDivElement>(() => onCollapse(), expanded);

  return (
    <header className="map-search-shell" ref={shellRef}>
      <form className={`map-search-header ${expanded ? 'is-expanded' : ''}`} onSubmit={(event) => { void onSearch(event); }}>
        <button type="button" className="map-back-button" aria-label="戻る" onClick={onBack}>＜</button>
        <div className="map-search-input-wrap" onClick={() => { if (!expanded) onToggleExpanded(); }}>
          <input
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            onFocus={() => { if (!expanded) onToggleExpanded(); }}
            placeholder="店名 / 住所 / 最寄り駅 / 地点名"
          />
          {value ? (
            <button
              type="button"
              className="map-search-clear"
              aria-label="検索バーをクリア"
              onClick={(event) => {
                event.stopPropagation();
                onClear();
              }}
            >
              ×
            </button>
          ) : null}
        </div>
        <button type="submit" className="map-search-submit" disabled={searching}>{searching ? '検索中...' : '検索'}</button>
        {expanded ? (
          <div className="map-search-filters">
            <div className="filter-inline-row map-filter-inline-row">
              <FilterDropdown
                placeholder="源流"
                value={filters.origin}
                options={originOptions.map((item) => ({ value: item, label: item }))}
                onChange={(value) => onFiltersChange({ ...filters, origin: value })}
              />
              <FilterDropdown
                placeholder="直/独/資"
                value={filters.tag}
                options={tags.map((item) => ({ value: item, label: item }))}
                onChange={(value) => onFiltersChange({ ...filters, tag: value as Tag | '' })}
              />
              <div className={`toggle-filter ${filters.parking !== null ? 'is-active' : ''}`}>
                <button type="button" className={filters.parking === true ? 'is-selected' : ''} onClick={() => onFiltersChange({ ...filters, parking: filters.parking === true ? null : true })}>駐車場あり</button>
                <button type="button" className={filters.parking === false ? 'is-selected' : ''} onClick={() => onFiltersChange({ ...filters, parking: filters.parking === false ? null : false })}>駐車場なし</button>
              </div>
            </div>
          </div>
        ) : null}
      </form>
      {message ? <p className="map-search-message">{message}</p> : null}
    </header>
  );
}


type FilterOption = {
  value: string;
  label: string;
};

function FilterDropdown({
  placeholder,
  value,
  options,
  onChange,
}: {
  placeholder: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useClickOutside<HTMLDivElement>(() => setOpen(false), open);
  const selected = options.find((item) => item.value === value);

  return (
    <div className={`filter-dropdown ${value ? 'is-active' : ''}`} ref={wrapperRef}>
      <button
        type="button"
        className={`filter-select-button ${value ? 'is-active' : ''}`}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{selected?.label ?? placeholder}</span>
        <span className="filter-select-caret">▾</span>
      </button>
      {open ? (
        <div className="filter-dropdown-menu" role="listbox">
          <button
            type="button"
            className={`filter-dropdown-option ${!value ? 'is-selected' : ''}`}
            onClick={() => { onChange(''); setOpen(false); }}
          >
            {placeholder}
          </button>
          {options.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`filter-dropdown-option ${value === item.value ? 'is-selected' : ''}`}
              onClick={() => { onChange(item.value); setOpen(false); }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const currentLocationIcon = L.divIcon({
  className: 'current-location-wrapper',
  html: '<span class="current-location-dot"></span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9]
});

function MapViewportController({ center, targetZoom, shops, fitToShops, fitRequestKey, suppressMoveKey, selectedShop, onViewChange }: { center: [number, number]; targetZoom?: number; shops: Shop[]; fitToShops: boolean; fitRequestKey: number; suppressMoveKey: number; selectedShop: Shop | null; onViewChange?: (snapshot: MapViewSnapshot) => void }) {
  const map = useMap();
  const initializedRef = useRef(false);
  const prevCenterRef = useRef<string>('');
  const prevZoomRef = useRef<number | null>(null);
  const prevFitToShopsRef = useRef<boolean>(fitToShops);
  const prevShopIdsRef = useRef<string>('');
  const prevFitRequestKeyRef = useRef<number>(fitRequestKey);
  const prevSuppressMoveKeyRef = useRef<number>(suppressMoveKey);

  useEffect(() => {
    const syncSnapshot = () => {
      const currentCenter = map.getCenter();
      onViewChange?.({ center: [currentCenter.lat, currentCenter.lng], zoom: map.getZoom() });
    };

    syncSnapshot();
    map.on('moveend', syncSnapshot);
    map.on('zoomend', syncSnapshot);

    return () => {
      map.off('moveend', syncSnapshot);
      map.off('zoomend', syncSnapshot);
    };
  }, [map, onViewChange]);

  useEffect(() => {
    if (selectedShop) {
      const nextZoom = Math.max(map.getZoom(), 15);
      const mapRect = map.getContainer().getBoundingClientRect();
      const searchRect = document.querySelector('.map-search-shell')?.getBoundingClientRect();
      const cardRect = document.querySelector('.map-overlay-card')?.getBoundingClientRect();
      const navRect = document.querySelector('.map-bottom-nav')?.getBoundingClientRect();

      const topBoundary = Math.max(12, (searchRect?.bottom ?? mapRect.top) - mapRect.top + 12);
      const lowerLimit = Math.min(cardRect?.top ?? Number.POSITIVE_INFINITY, navRect?.top ?? Number.POSITIVE_INFINITY);
      const bottomBoundary = Math.min(mapRect.height - 12, lowerLimit - mapRect.top - 12);
      const targetX = mapRect.width / 2;
      const targetY = bottomBoundary > topBoundary ? topBoundary + ((bottomBoundary - topBoundary) / 2) : mapRect.height / 2;

      const size = map.getSize();
      const projectedPin = map.project(L.latLng(selectedShop.lat, selectedShop.lng), nextZoom);
      const desiredCenterPoint = projectedPin.add(L.point((size.x / 2) - targetX, (size.y / 2) - targetY));
      const desiredCenter = map.unproject(desiredCenterPoint, nextZoom);

      map.setView(desiredCenter, nextZoom, { animate: true });
      return;
    }

    const centerKey = `${center[0].toFixed(6)},${center[1].toFixed(6)}`;
    const zoomValue = targetZoom ?? map.getZoom();
    const shopIdsKey = shops.map((shop) => shop.id).join(',');
    const shouldSuppressMove = prevSuppressMoveKeyRef.current !== suppressMoveKey;

    if (shouldSuppressMove) {
      prevFitToShopsRef.current = fitToShops;
      prevShopIdsRef.current = shopIdsKey;
      prevCenterRef.current = centerKey;
      prevZoomRef.current = zoomValue;
      prevFitRequestKeyRef.current = fitRequestKey;
      prevSuppressMoveKeyRef.current = suppressMoveKey;
      initializedRef.current = true;
      return;
    }

    prevSuppressMoveKeyRef.current = suppressMoveKey;

    if (fitToShops && shops.length) {
      const shouldRefit = !initializedRef.current || !prevFitToShopsRef.current || prevShopIdsRef.current !== shopIdsKey || prevFitRequestKeyRef.current !== fitRequestKey;
      prevFitToShopsRef.current = true;
      prevShopIdsRef.current = shopIdsKey;
      prevCenterRef.current = centerKey;
      prevZoomRef.current = zoomValue;
      prevFitRequestKeyRef.current = fitRequestKey;
      initializedRef.current = true;

      if (shouldRefit) {
        const bounds = L.latLngBounds(shops.map((shop) => [shop.lat, shop.lng] as [number, number]));
        const mapRect = map.getContainer().getBoundingClientRect();
        const searchRect = document.querySelector('.map-search-shell')?.getBoundingClientRect();
        const navRect = document.querySelector('.map-bottom-nav')?.getBoundingClientRect();
        const topPadding = Math.max(36, ((searchRect?.bottom ?? mapRect.top) - mapRect.top) + 24);
        const bottomPadding = Math.max(36, (mapRect.bottom - (navRect?.top ?? mapRect.bottom)) + 24);
        map.fitBounds(bounds, {
          paddingTopLeft: [36, topPadding],
          paddingBottomRight: [36, bottomPadding],
          animate: true,
          maxZoom: shops.length === 1 ? 15 : 13,
        });
      }
      return;
    }

    const shouldMove = !initializedRef.current || prevCenterRef.current !== centerKey || prevZoomRef.current !== zoomValue || prevFitToShopsRef.current !== fitToShops;
    prevFitToShopsRef.current = fitToShops;
    prevShopIdsRef.current = shopIdsKey;
    prevCenterRef.current = centerKey;
    prevZoomRef.current = zoomValue;
    prevFitRequestKeyRef.current = fitRequestKey;
    initializedRef.current = true;

    if (shouldMove) {
      map.setView(center, zoomValue, { animate: true });
    }
  }, [center, fitRequestKey, fitToShops, map, selectedShop, shops, suppressMoveKey, targetZoom]);
  return null;
}

function ShopDetailPage({ shops }: { shops: Shop[] }) {
  const location = useLocation();
  const { shopId } = useParams();
  const shop = shops.find((item) => item.id === shopId) ?? null;
  const locationState = (location.state as { backTo?: string; backState?: Record<string, unknown> } | null) ?? null;
  const backTo = locationState?.backTo ?? '/shops';
  const mapLink = shop ? `/map?ids=${encodeURIComponent(shop.id)}&selected=${encodeURIComponent(shop.id)}` : '/map';
  const detailUrl = shop ? `/shops/${shop.id}` : '/shops';
  const genealogyLink = shop ? buildGenealogyUrl({ tag: shop.tag, focusNodeId: shop.nodoId || shop.id, zoom: 1 }) : '/genealogy';
  if (!shop) return <main className="page"><Header title="店舗詳細" backTo={backTo} /><p>店舗が見つかりませんでした。</p></main>;
  return (
    <main className="page detail-page">
      <Header title="店舗詳細" backTo={backTo} />
      <section className="detail-hero-carousel" aria-label="店舗画像">
        <div className="detail-hero-track">
          {getDetailHeroImages(shop).map((image, index) => {
            const isNoPhoto = !image.storagePath && image.publicUrl === noPhotoDataUrl;
            return (
              <article key={image.id || `${image.imageType}-${index}`} className="detail-hero-slide">
                <img className="hero-image" src={image.publicUrl} alt={isNoPhoto ? `${shop.name} No Photo` : `${shop.name} 写真${index + 1}`} />
                <span className="hero-slide-badge">{isNoPhoto ? 'No Photo' : `写真 ${index + 1}`}</span>
              </article>
            );
          })}
        </div>
      </section>
      <section className="detail-summary">
        <h2>{shop.name}</h2>
        <div className="tag-row">
          <TagChip tag={shop.tag} />
          <span className="lineage-chip">{shop.origin}</span>
        </div>
        <p className="lead">{shop.station || shop.address}</p>
      </section>
      <section className="detail-grid section compact">
        <DetailItem label="系譜" value={shop.genealogy || '未設定'} multiline />
        <DetailItem label="住所" value={shop.address} />
        <DetailItem label="最寄駅" value={shop.station} />
        <DetailItem label="営業時間" value={shop.hours || '未設定'} multiline />
        <DetailItem label="定休日" value={shop.holiday || '未設定'} />
        <DetailItem label="電話番号" value={renderPhoneLink(shop.phone)} />
        <DetailItem label="席数" value={shop.seats || '未設定'} />
        <DetailItem label="駐車場" value={shop.parking ? 'あり' : 'なし'} />
        <DetailItem label="公式URL" value={renderExternalLink(shop.officialUrl)} multiline />
        <DetailItem label="公式SNS" value={renderExternalLink(shop.officialAccount)} multiline />
      </section>
      <div className="action-row section compact">
        <Link className="secondary-button block" to={mapLink} state={{ backTo: detailUrl, backState: { backTo }, entrySource: 'detail' as MapEntrySource }}>{'地図で見る'}</Link>
        <Link className="secondary-button block" to={genealogyLink} state={{ backTo: detailUrl, backState: { backTo }, focusNodeId: shop.nodoId || shop.id }}>系譜図を見る</Link>
      </div>
      <BottomNav />
    </main>
  );
}

function AdminLoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/admin-8fj3k2-3me77nfcb6c0';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      setError('');
      await signInAdmin(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ログインに失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page admin-login-page">
      <Header title="管理画面ログイン" eyebrow="管理用URL" />
      <section className="hero-card login-card">
        <p className="hero-copy">管理画面を見るにはログインが必要です。Supabaseの管理者アカウントでログインすると、管理画面だけが開けます。</p>
        <form className="form-stack" onSubmit={handleLogin}>
          <label>メールアドレス<input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="例: admin@example.com" /></label>
          <label>パスワード<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="管理者用パスワード" /></label>
          {error ? <p className="error-text">{error}</p> : null}
          <button type="submit" className="primary-button block" disabled={busy}>{busy ? 'ログイン中...' : 'ログイン'}</button>
        </form>
        <div className="login-note">
          <strong>この画面で使うもの</strong>
          <span>Supabaseの Authentication で作成した管理者メールアドレス</span>
          <span>そのアカウントに設定したパスワード</span>
        </div>
      </section>
    </main>
  );
}

function AdminTopPage({ shops }: { shops: Shop[] }) {
  const navigate = useNavigate();
  const [adminEmail, setAdminEmail] = useState('');

  useEffect(() => {
    let active = true;
    void getAdminAuthState().then((state) => {
      if (active) setAdminEmail(state.email);
    }).catch(() => {
      if (active) setAdminEmail('');
    });
    return () => {
      active = false;
    };
  }, []);

  const logout = async () => {
    await signOutAdmin();
    navigate('/admin/login', { replace: true });
  };

  return (
    <main className="page">
      <Header title="管理画面トップ" eyebrow="ログイン済み" />
      <section className="section compact info-card">
        <strong>{getConnectionLabel()}</strong>
        <span>Supabaseの接続情報が入ると、店舗データはクラウドに保存されます。</span>
        <span>画像アップロードを使う場合は、Storage に <code>{getImageBucketName()}</code> バケットを用意してから使ってください。</span>
        {adminEmail ? <span>ログイン中: {adminEmail}</span> : null}
      </section>
      <section className="stats-grid section compact">
        <article className="info-card"><strong>{shops.length}</strong><span>登録店舗数</span></article>
        <article className="info-card"><strong>{shops.filter((shop) => shop.updatedAt >= '2026-03-23').length}</strong><span>今週の更新</span></article>
        <article className="info-card"><strong>{shops.filter((shop) => !shop.officialUrl).length}</strong><span>要確認URL</span></article>
      </section>
      <section className="section compact admin-links">
        <Link className="primary-button block" to="/admin/shops">店舗一覧へ</Link>
        <Link className="secondary-button block admin-secondary" to="/admin/shops/new">店舗登録へ</Link>
      </section>
      <section className="section compact">
        <button className="ghost-button block" onClick={logout}>ログアウト</button>
      </section>
    </main>
  );
}

function AdminShopsPage({ shops, loading, onDeleted, onRefresh }: { shops: Shop[]; loading: boolean; onDeleted: () => Promise<void>; onRefresh: () => Promise<void> }) {
  const [busyId, setBusyId] = useState('');
  const [message, setMessage] = useState('');
  const [searchText, setSearchText] = useState('');
  const [csvPreview, setCsvPreview] = useState<CsvImportPreview | null>(null);
  const [csvStatus, setCsvStatus] = useState('CSVをまだ読み込んでいません');
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvFileName, setCsvFileName] = useState('');

  const filteredShops = useMemo(() => {
    const term = searchText.trim().toLowerCase();
    if (!term) return shops;
    return shops.filter((shop) => shop.name.toLowerCase().includes(term));
  }, [searchText, shops]);

  const handleDelete = async (shopId: string) => {
    if (!window.confirm('この店舗を削除しますか？')) return;
    try {
      setBusyId(shopId);
      await removeShop(shopId);
      await onDeleted();
      setMessage('店舗を削除しました。');
    } catch (err) {
      const message = err instanceof Error ? err.message : '削除に失敗しました。';
      setMessage(message.includes('row-level security') || message.includes('permission') ? '管理者権限がないため削除できません。' : message);
    } finally {
      setBusyId('');
    }
  };

  const handleCsvSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setCsvBusy(true);
      setCsvPreview(null);
      const text = await file.text();
      const preview = await previewCsvImport(text);
      setCsvPreview(preview);
      setCsvFileName(file.name);
      setCsvStatus(`プレビュー完了: 追加 ${preview.createCount}件 / 更新 ${preview.updateCount}件 / エラー ${preview.errorCount}件`);
    } catch (err) {
      setCsvStatus(err instanceof Error ? err.message : 'CSVの読み込みに失敗しました。');
      setCsvPreview(null);
      setCsvFileName('');
    } finally {
      setCsvBusy(false);
      event.target.value = '';
    }
  };

  const handleCsvImport = async () => {
    if (!csvPreview?.validRows.length) return;
    try {
      setCsvBusy(true);
      const result = await executeCsvImport(csvPreview.validRows);
      await onRefresh();
      setCsvStatus(`取込完了: 追加 ${result.createdCount}件 / 更新 ${result.updatedCount}件 / エラー ${csvPreview.errorCount}件`);
      setCsvPreview(null);
      setCsvFileName('');
      window.alert(`CSV取込が完了しました。
追加: ${result.createdCount}件
更新: ${result.updatedCount}件
エラー: ${csvPreview.errorCount}件`);
    } catch (err) {
      setCsvStatus(err instanceof Error ? err.message : 'CSV取込に失敗しました。');
    } finally {
      setCsvBusy(false);
    }
  };

  return (
    <main className="page">
      <Header title="管理画面: 店舗一覧" backTo="/admin-8fj3k2-3me77nfcb6c0" />
      {message ? <p className="page-message">{message}</p> : null}
      <section className="section compact info-card form-stack">
        <label>店舗名で検索<input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="店舗名を部分一致で検索" /></label>
        <span>{loading ? '読み込み中' : `${filteredShops.length}件を表示中`}</span>
      </section>
      <section className="section compact csv-panel">
        <div className="section-head"><h2>CSV一括インポート</h2><span>追加・更新対応</span></div>
        <p>{csvStatus}</p>
        <p className="csv-help">列名は id,name,tag,address,station,hours,holiday,phone,seats,parking,official_url,official_account,lat,lng,image,memo,updated_at,origin,genealogy,parent_id,nodo_id,node_name,is_closed の順で入力してください。id がある行は既存店舗を更新し、id が空の行は新規追加します。parent_id / nodo_id もCSVで追加・更新できます。画像ファイルはCSVでは取り込みません。</p>
        <input type="file" accept=".csv" onChange={handleCsvSelect} disabled={csvBusy} />
        {csvFileName ? <p className="csv-help">選択中: {csvFileName}</p> : null}
        {csvPreview ? (
          <div className="csv-preview-box">
            <div className="csv-preview-summary">
              <strong>取込前プレビュー</strong>
              <span>追加予定 {csvPreview.createCount}件 / 更新予定 {csvPreview.updateCount}件 / エラー {csvPreview.errorCount}件 / 読み込み {csvPreview.totalRows}件</span>
            </div>
            <div className="csv-preview-list">
              {csvPreview.previewRows.map((row) => (
                <article key={`${row.lineNumber}-${row.name}-${row.address}`} className={`csv-preview-row ${row.status === 'error' ? 'has-error' : 'is-ready'}`}>
                  <div>
                    <strong>{row.lineNumber}行目: {row.name}</strong>
                    <p>{row.address || '住所未入力'}</p>
                    {row.id ? <p className="csv-help">ID: {row.id}</p> : null}
                  </div>
                  <div>
                    {row.status === 'create' ? <span className="csv-ready-badge">追加予定</span> : row.status === 'update' ? <span className="csv-ready-badge">更新予定</span> : <ul>{row.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
                  </div>
                </article>
              ))}
            </div>
            <div className="action-row">
              <button type="button" className="primary-button block" onClick={handleCsvImport} disabled={csvBusy || (csvPreview.createCount + csvPreview.updateCount) === 0}>{csvBusy ? '取込中...' : 'この内容で取り込む'}</button>
              <button type="button" className="secondary-button block admin-secondary" onClick={() => { setCsvPreview(null); setCsvStatus('CSVをまだ読み込んでいません'); setCsvFileName(''); }} disabled={csvBusy}>プレビューを閉じる</button>
            </div>
          </div>
        ) : null}
      </section>
      <section className="section compact">
        {loading ? <p>読み込み中です...</p> : filteredShops.map((shop) => (
          <article key={shop.id} className="admin-row">
            <div>
              <strong>{shop.name}</strong>
              <p>{shop.origin} / {shop.updatedAt}</p>
              <p className="csv-help">parent: {shop.parentId || '未設定'} / nodo: {shop.nodoId || '未設定'}</p>
            </div>
            <div className="row-actions">
              <Link className="secondary-button small admin-secondary" to={`/shops/${shop.id}`}>公開画面</Link>
              <Link className="primary-button small" to={`/admin/shops/${shop.id}`}>編集</Link>
              <button className="ghost-button small-danger" onClick={() => void handleDelete(shop.id)} disabled={busyId === shop.id}>{busyId === shop.id ? '削除中...' : '削除'}</button>
            </div>
          </article>
        ))}
        {!loading && filteredShops.length === 0 ? <p className="empty-text">条件に合う店舗がありません。</p> : null}
      </section>
    </main>
  );
}

function AdminEditPage({ shops, onSaved }: { shops: Shop[]; onSaved: () => Promise<void> }) {
  const { shopId } = useParams();
  const navigate = useNavigate();
  const isNew = shopId === 'new';
  const shop = isNew ? null : (shops.find((item) => item.id === shopId) ?? null);
  const [message, setMessage] = useState('');
  const [imageMessage, setImageMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Partial<Record<ShopImageType, File>>>({});
  const [form, setForm] = useState<ShopDraft>(buildDraft(shop));

  useEffect(() => {
    setForm(buildDraft(shop));
    setSelectedFiles({});
    setImageMessage('');
  }, [shop?.id]);

  const handleChange = (key: keyof ShopDraft, value: string | boolean | number | null) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      setMessage('');
      setImageMessage('');
      const savedShop = await upsertShop(form);

      const pendingUploads = imageTypeOrder.filter((imageType) => selectedFiles[imageType]);
      for (const imageType of pendingUploads) {
        const file = selectedFiles[imageType];
        if (!file) continue;
        await uploadShopImage(savedShop.id, imageType, file);
      }

      await onSaved();
      const uploadSummary = pendingUploads.length ? ` 画像${pendingUploads.length}枚も反映しました。` : '';
      window.alert(`変更完了。${uploadSummary}`.trim());
      navigate('/admin/shops', { replace: true });
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : '';
      const nextMessage = rawMessage.trim() || '保存に失敗しました。Storage設定と画像権限を確認してください。';
      setMessage(nextMessage.includes('row-level security') || nextMessage.includes('permission') ? '管理者権限がないため保存できません。管理者アカウントでログインしているか確認してください。' : nextMessage);
    } finally {
      setBusy(false);
    }
  };

  const handleFileSelect = (imageType: ShopImageType, file: File | null) => {
    setSelectedFiles((current) => {
      const next = { ...current };
      if (file) next[imageType] = file;
      else delete next[imageType];
      return next;
    });
  };

  const handleImageDelete = async (imageId: string) => {
    if (!window.confirm('この写真を削除しますか？')) return;
    try {
      setBusy(true);
      setImageMessage('');
      await deleteShopImage(imageId);
      await onSaved();
      setImageMessage('写真を削除しました。');
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : '';
      const nextMessage = rawMessage.trim() || '写真の削除に失敗しました。Storage設定と画像権限を確認してください。';
      setImageMessage(nextMessage.includes('row-level security') || nextMessage.includes('permission') ? '管理者権限がないため写真を削除できません。' : nextMessage);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <Header title="管理画面: 店舗登録・編集" backTo="/admin/shops" />
      {message ? <p className="page-message">{message}</p> : null}
      <form className="section compact form-stack" onSubmit={handleSubmit}>
        <label>店舗名<input value={form.name} onChange={(e) => handleChange('name', e.target.value)} /></label>
        <label>源流<select value={form.origin} onChange={(e) => handleChange('origin', e.target.value)}>{originOptions.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>系譜<input value={form.genealogy} onChange={(e) => handleChange('genealogy', e.target.value)} placeholder="例: 吉村家 → ○○家 → この店舗" /></label>
        <label>タグ<select value={form.tag} onChange={(e) => handleChange('tag', e.target.value as Tag)}>{tags.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>住所<input value={form.address} onChange={(e) => handleChange('address', e.target.value)} /></label>
        <label>最寄駅<input value={form.station} onChange={(e) => handleChange('station', e.target.value)} /></label>
        <label>営業時間<textarea value={form.hours} onChange={(e) => handleChange('hours', e.target.value)} rows={4} placeholder="例:
11:00-15:00
17:00-22:00" /></label>
        <label>定休日<input value={form.holiday} onChange={(e) => handleChange('holiday', e.target.value)} /></label>
        <label>電話番号<input value={form.phone} onChange={(e) => handleChange('phone', e.target.value)} placeholder="例: 045-123-4567" inputMode="tel" /></label>
        <label>席数<input value={form.seats} onChange={(e) => handleChange('seats', e.target.value)} /></label>
        <label>駐車場<select value={form.parking ? 'あり' : 'なし'} onChange={(e) => handleChange('parking', e.target.value === 'あり')}><option>あり</option><option>なし</option></select></label>
        <label>公式URL<input value={form.officialUrl} onChange={(e) => handleChange('officialUrl', e.target.value)} /></label>
        <label>公式SNS<input value={form.officialAccount} onChange={(e) => handleChange('officialAccount', e.target.value)} placeholder="例: https://instagram.com/xxxx または https://x.com/xxxx" /></label>
        <label>緯度<input value={String(form.lat)} onChange={(e) => handleChange('lat', Number(e.target.value))} /></label>
        <label>経度<input value={String(form.lng)} onChange={(e) => handleChange('lng', Number(e.target.value))} /></label>
        <label>親店舗ID（parent_id）<input value={form.parentId ?? ''} onChange={(e) => handleChange('parentId', e.target.value || null)} placeholder="親ノードにしたい店舗の id" /></label>
        <label>ノードID（nodo_id）<input value={form.nodoId ?? ''} onChange={(e) => handleChange('nodoId', e.target.value)} placeholder="同じノードにまとめたい店舗で共通の id" /></label>
        <label>ノード名（node_name）<input value={form.nodeName} onChange={(e) => handleChange('nodeName', e.target.value)} placeholder="未入力なら店舗名をそのまま使います" /></label>
        <label className="checkbox-row"><input type="checkbox" checked={form.isClosed} onChange={(e) => handleChange('isClosed', e.target.checked)} />閉店済み</label>
        <label>管理メモ<textarea value={form.memo} onChange={(e) => handleChange('memo', e.target.value)} rows={4} /></label>
        <section className="image-admin-panel">
          <div className="section-head"><h2>店舗写真</h2><span>最大3枚（1 / 2 / 3）</span></div>
          <p className="csv-help">写真は保存ボタンを押したタイミングでアップロードされます。アップロード前に自動でサイズを小さくしてから送信します。1 が店舗詳細の先頭写真・店舗カード画像になります。</p>
          {imageMessage ? <p className="page-message">{imageMessage}</p> : null}
          <div className="admin-image-grid">
            {imageTypeOrder.map((imageType) => {
              const currentImage = shop?.images.find((item) => item.imageType === imageType);
              return (
                <article key={imageType} className="admin-image-card">
                  <img src={currentImage?.publicUrl || noPhotoDataUrl} alt={`${imageTypeLabels[imageType]}プレビュー`} />
                  <strong>写真 {imageTypeLabels[imageType]}</strong>
                  <span>{currentImage ? '登録済み' : '未登録'}</span>
                  <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => handleFileSelect(imageType, e.target.files?.[0] ?? null)} />
                  <small>{selectedFiles[imageType]?.name ?? '新しい画像が未選択です'}</small>
                  {currentImage ? <button type="button" className="ghost-button small-danger" onClick={() => void handleImageDelete(currentImage.id)} disabled={busy}>この写真を削除</button> : null}
                </article>
              );
            })}
          </div>
          {!shop?.id ? <p className="csv-help">新規店舗は保存と同時に画像を追加できます。1回目の保存後に管理画面へ戻っても問題ありません。</p> : null}
          <p className="csv-help">画像が1枚もない店舗には、自動で「No Photo」画像が表示されます。</p>
        </section>
        <div className="action-row">
          <button type="submit" className="primary-button block" disabled={busy}>{busy ? '保存中...' : '保存'}</button>
          <button type="button" className="secondary-button block admin-secondary" onClick={() => navigate('/admin/shops')} disabled={busy}>一覧へ戻る</button>
        </div>
      </form>
    </main>
  );
}

function buildDraft(shop: Shop | null): ShopDraft {
  return {
    name: shop?.name ?? '',
    origin: shop?.origin ?? originOptions[0],
    genealogy: shop?.genealogy ?? '',
    tag: shop?.tag ?? '独立系',
    address: shop?.address ?? '',
    station: shop?.station ?? '',
    hours: shop?.hours ?? '',
    holiday: shop?.holiday ?? '',
    phone: shop?.phone ?? '',
    seats: shop?.seats ?? '',
    parking: shop?.parking ?? false,
    officialUrl: shop?.officialUrl ?? '',
    officialAccount: shop?.officialAccount ?? '',
    lat: shop?.lat ?? 35.681236,
    lng: shop?.lng ?? 139.767125,
    image: shop?.image ?? '',
    memo: shop?.memo ?? '',
    id: shop?.id,
    updatedAt: shop?.updatedAt,
    parentId: shop?.parentId ?? null,
    nodoId: shop?.nodoId ?? shop?.id ?? '',
    nodeName: shop?.nodeName ?? shop?.name ?? '',
    isClosed: shop?.isClosed ?? false,
  };
}

function ShopCard({ shop, compact = false, backTo, backState }: { shop: Shop; compact?: boolean; backTo?: string; backState?: Record<string, unknown> }) {
  return (
    <Link to={`/shops/${shop.id}`} state={backTo ? { backTo, backState } : undefined} className={`shop-card ${compact ? 'compact-card' : ''}`}>
      <img src={getPrimaryShopImage(shop)} alt={shop.name} />
      <div className="shop-content">
        <div className="shop-meta">
          <TagChip tag={shop.tag} />
          <span>{shop.origin}</span>
        </div>
        <h3>{shop.name}</h3>
        <p>{shop.station}</p>
        <p>{formatHoursInline(shop.hours)} / 定休日:{shop.holiday || '未設定'}</p>
      </div>
    </Link>
  );
}

function TagChip({ tag }: { tag: Tag }) {
  return <span className={`tag-chip tag-${tag}`}>{tag}</span>;
}

function DetailItem({ label, value, multiline = false }: { label: string; value: ReactNode; multiline?: boolean }) {
  return (
    <article className="detail-item">
      <span>{label}</span>
      <strong className={multiline ? 'multiline-text' : ''}>{value}</strong>
    </article>
  );
}


function GenealogyPage({ shops, loading }: { shops: Shop[]; loading: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const locationState = (location.state as { backTo?: string; backState?: Record<string, unknown>; focusNodeId?: string } | null) ?? null;
  const initialTag = (searchParams.get('tag') as Tag | null) ?? null;
  const initialQuery = searchParams.get('q') ?? '';
  const initialFocusNodeId = searchParams.get('focus') ?? locationState?.focusNodeId ?? null;
  const initialZoom = Number(searchParams.get('zoom') ?? '1');
  const [activeTag, setActiveTag] = useState<Tag>(tags.includes(initialTag as Tag) ? (initialTag as Tag) : '直系');
  const [query, setQuery] = useState(initialQuery);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(initialFocusNodeId);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(initialFocusNodeId);
  const [zoom, setZoom] = useState(Number.isFinite(initialZoom) ? clamp(initialZoom, GENEALOGY_MIN_ZOOM, GENEALOGY_MAX_ZOOM) : 1);
  const graph = useMemo(() => buildGenealogyGraph(shops, activeTag), [activeTag, shops]);
  const boardViewportRef = useRef<HTMLDivElement | null>(null);
  const pinchStateRef = useRef<{ distance: number; zoom: number; scrollLeft: number; scrollTop: number; centerX: number; centerY: number } | null>(null);
  const hasAppliedInitialFocusRef = useRef(false);
  const searchAutofocusKeyRef = useRef('');

  const normalizedQuery = normalizeText(query);
  const visibleNodes = useMemo(() => graph.columns.flat(), [graph.columns]);
  const visibleEdges = useMemo(() => graph.edges, [graph.edges]);
  const genealogyBackTo = locationState?.backTo ?? '/';
  const genealogyBackState = locationState?.backState;

  const matchedNodeIds = useMemo(() => {
    if (!normalizedQuery) return new Set<string>();
    const matches = new Set<string>();
    graph.nodesById.forEach((node) => {
      const searchableText = [node.name, node.subtitle, node.shopCount > 1 ? '複数店' : '店舗'].join(' ').toLowerCase();
      if (searchableText.includes(normalizedQuery)) {
        matches.add(node.id);
      }
    });
    return matches;
  }, [graph.nodesById, normalizedQuery]);

  const matchedNodes = useMemo(() => visibleNodes.filter((node) => matchedNodeIds.has(node.id)), [matchedNodeIds, visibleNodes]);
  const visibleColumns = useMemo(() => graph.columns, [graph.columns]);
  const highlightMode = normalizedQuery.length > 0 || Boolean(highlightedNodeId);

  const layout = useMemo(() => {
    const colWidth = 232;
    const colGap = 28;
    const rowHeight = 132;
    const rowGap = 24;
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 390;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 844;
    const paddingX = Math.max(96, Math.ceil(viewportWidth / (GENEALOGY_BASE_SCALE * 2)) + 40);
    const paddingY = Math.max(96, Math.ceil(viewportHeight / (GENEALOGY_BASE_SCALE * 2)) + 40);

    const visibleNodeMap = new Map(visibleNodes.map((node) => [node.id, node] as const));
    const primaryChildren = new Map<string, string[]>();
    visibleNodes.forEach((node) => primaryChildren.set(node.id, []));

    visibleNodes.forEach((node) => {
      const parents = (graph.parentsByNodeId.get(node.id) ?? []).filter((parentId) => visibleNodeMap.has(parentId));
      if (!parents.length) return;
      const primaryParentId = [...parents].sort((a, b) => {
        const aDepth = graph.nodesById.get(a)?.depth ?? 0;
        const bDepth = graph.nodesById.get(b)?.depth ?? 0;
        if (aDepth !== bDepth) return aDepth - bDepth;
        const aName = graph.nodesById.get(a)?.name ?? '';
        const bName = graph.nodesById.get(b)?.name ?? '';
        return aName.localeCompare(bName, 'ja');
      })[0];
      const next = primaryChildren.get(primaryParentId) ?? [];
      next.push(node.id);
      primaryChildren.set(primaryParentId, next);
    });

    primaryChildren.forEach((children, nodeId) => {
      children.sort((a, b) => {
        const aNode = graph.nodesById.get(a);
        const bNode = graph.nodesById.get(b);
        return (aNode?.name ?? '').localeCompare(bNode?.name ?? '', 'ja');
      });
      primaryChildren.set(nodeId, children);
    });

    const hasVisibleParent = (nodeId: string) => (graph.parentsByNodeId.get(nodeId) ?? []).some((parentId) => visibleNodeMap.has(parentId));
    const rootIds = visibleNodes
      .filter((node) => !hasVisibleParent(node.id))
      .sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth;
        return a.name.localeCompare(b.name, 'ja');
      })
      .map((node) => node.id);

    const targetRowByNodeId = new Map<string, number>();
    let leafCursor = 0;
    const resolving = new Set<string>();

    const assignTargetRow = (nodeId: string): number => {
      const saved = targetRowByNodeId.get(nodeId);
      if (saved !== undefined) return saved;
      if (resolving.has(nodeId)) {
        const fallback = leafCursor;
        leafCursor += 1;
        targetRowByNodeId.set(nodeId, fallback);
        return fallback;
      }

      resolving.add(nodeId);
      const childIds = primaryChildren.get(nodeId) ?? [];
      if (!childIds.length) {
        const row = leafCursor;
        leafCursor += 1;
        targetRowByNodeId.set(nodeId, row);
        resolving.delete(nodeId);
        return row;
      }

      const childRows = childIds.map((childId) => assignTargetRow(childId));
      const row = (Math.min(...childRows) + Math.max(...childRows)) / 2;
      targetRowByNodeId.set(nodeId, row);
      resolving.delete(nodeId);
      return row;
    };

    rootIds.forEach((nodeId) => assignTargetRow(nodeId));
    visibleNodes.forEach((node) => assignTargetRow(node.id));

    const slotRowByNodeId = new Map<string, number>();
    visibleColumns.forEach((column) => {
      const ordered = [...column].sort((a, b) => {
        const rowDiff = (targetRowByNodeId.get(a.id) ?? 0) - (targetRowByNodeId.get(b.id) ?? 0);
        if (rowDiff !== 0) return rowDiff;
        return a.name.localeCompare(b.name, 'ja');
      });

      let cursor = 0;
      ordered.forEach((node) => {
        const desired = Math.round(targetRowByNodeId.get(node.id) ?? 0);
        const slot = Math.max(cursor, desired);
        slotRowByNodeId.set(node.id, slot);
        cursor = slot + 1;
      });
    });

    const positions = new Map<string, { x: number; y: number }>();
    visibleNodes.forEach((node) => {
      const row = slotRowByNodeId.get(node.id) ?? 0;
      const x = paddingX + node.depth * (colWidth + colGap);
      const y = paddingY + row * (rowHeight + rowGap);
      positions.set(node.id, { x, y });
    });

    const maxDepth = visibleNodes.reduce((max, node) => Math.max(max, node.depth), 0);
    const maxRow = visibleNodes.reduce((max, node) => Math.max(max, slotRowByNodeId.get(node.id) ?? 0), 0);

    return {
      positions,
      boardWidth: paddingX * 2 + (maxDepth + 1) * colWidth + maxDepth * colGap,
      boardHeight: paddingY * 2 + (Math.max(1, maxRow + 1)) * rowHeight + Math.max(0, maxRow) * rowGap,
      colWidth,
      rowHeight,
    };
  }, [graph.childrenByNodeId, graph.columns, graph.nodesById, graph.parentsByNodeId, visibleColumns, visibleNodes]);

  const linePaths = useMemo(() => visibleEdges.map((edge) => {
    const from = layout.positions.get(edge.from);
    const to = layout.positions.get(edge.to);
    if (!from || !to) return null;

    const startX = from.x + layout.colWidth - 10;
    const startY = from.y + layout.rowHeight / 2;
    const endX = to.x + 10;
    const endY = to.y + layout.rowHeight / 2;
    const curve = Math.max(42, (endX - startX) * 0.35);
    return `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`;
  }).filter((path): path is string => Boolean(path)), [layout.colWidth, layout.positions, layout.rowHeight, visibleEdges]);

  const actualScale = zoom * GENEALOGY_BASE_SCALE;
  const currentGenealogyUrl = buildGenealogyUrl({ tag: activeTag, query, focusNodeId: highlightedNodeId ?? focusedNodeId, zoom });

  useEffect(() => {
    const nextTag = (searchParams.get('tag') as Tag | null) ?? null;
    const nextQuery = searchParams.get('q') ?? '';
    const nextFocusNodeId = searchParams.get('focus') ?? locationState?.focusNodeId ?? null;
    const nextZoomParam = Number(searchParams.get('zoom') ?? '1');
    const nextZoom = Number.isFinite(nextZoomParam) ? clamp(nextZoomParam, GENEALOGY_MIN_ZOOM, GENEALOGY_MAX_ZOOM) : 1;

    if (tags.includes(nextTag as Tag) && nextTag !== activeTag) {
      setActiveTag(nextTag as Tag);
    }
    if (nextQuery !== query) {
      setQuery(nextQuery);
    }
    if (Math.abs(nextZoom - zoom) > 0.001) {
      setZoom(nextZoom);
    }
    if (nextFocusNodeId !== focusedNodeId) {
      setFocusedNodeId(nextFocusNodeId);
      setHighlightedNodeId(nextFocusNodeId);
      hasAppliedInitialFocusRef.current = false;
      searchAutofocusKeyRef.current = '';
    }
    if (!nextFocusNodeId && highlightedNodeId) {
      setHighlightedNodeId(null);
    }
  }, [location.key, locationState?.focusNodeId, searchParams]);

  const focusNode = useCallback((nodeId: string, options?: { behavior?: ScrollBehavior; nextZoom?: number; highlight?: boolean }) => {
    const container = boardViewportRef.current;
    const position = layout.positions.get(nodeId);
    const requestedZoom = clamp(options?.nextZoom ?? zoom, GENEALOGY_MIN_ZOOM, GENEALOGY_MAX_ZOOM);
    const targetScale = requestedZoom * GENEALOGY_BASE_SCALE;

    setFocusedNodeId(nodeId);
    if (options?.highlight === true) setHighlightedNodeId(nodeId);
    if (options?.highlight === false) setHighlightedNodeId(null);
    if (Math.abs(requestedZoom - zoom) > 0.001) {
      setZoom(requestedZoom);
    }

    if (!container || !position) {
      return;
    }

    const targetLeft = position.x * targetScale - container.clientWidth / 2 + (layout.colWidth * targetScale) / 2;
    const targetTop = position.y * targetScale - container.clientHeight / 2 + (layout.rowHeight * targetScale) / 2;
    container.scrollTo({
      left: Math.max(0, targetLeft),
      top: Math.max(0, targetTop),
      behavior: options?.behavior ?? 'smooth',
    });
  }, [layout.colWidth, layout.positions, layout.rowHeight, zoom]);

  useEffect(() => {
    if (normalizedQuery && matchedNodes.length > 0) {
      const nextFocusId = matchedNodeIds.has(focusedNodeId ?? '') ? (focusedNodeId ?? matchedNodes[0].id) : matchedNodes[0].id;
      const searchKey = `${activeTag}:${normalizedQuery}:${nextFocusId}`;
      if (nextFocusId && searchAutofocusKeyRef.current !== searchKey) {
        searchAutofocusKeyRef.current = searchKey;
        window.requestAnimationFrame(() => focusNode(nextFocusId, { behavior: 'smooth', nextZoom: 1, highlight: true }));
      }
      return;
    }

    searchAutofocusKeyRef.current = '';
    if (focusedNodeId && !graph.nodesById.has(focusedNodeId)) {
      setFocusedNodeId(visibleNodes[0]?.id ?? null);
    }
    if (highlightedNodeId && !graph.nodesById.has(highlightedNodeId)) {
      setHighlightedNodeId(null);
    }
  }, [activeTag, focusNode, focusedNodeId, graph.nodesById, highlightedNodeId, matchedNodeIds, matchedNodes, normalizedQuery, visibleNodes]);

  useEffect(() => {
    if (hasAppliedInitialFocusRef.current) return;
    const targetNodeId = focusedNodeId ?? visibleNodes[0]?.id;
    if (!targetNodeId) return;
    hasAppliedInitialFocusRef.current = true;
    window.requestAnimationFrame(() => {
      focusNode(targetNodeId, { behavior: 'auto', nextZoom: zoom });
    });
  }, [focusNode, focusedNodeId, visibleNodes, zoom]);

  useEffect(() => {
    const container = boardViewportRef.current;
    if (!container) return;

    const readTouches = (touchList: TouchList) => Array.from(touchList).map((touch) => ({ clientX: touch.clientX, clientY: touch.clientY }));

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        pinchStateRef.current = null;
        return;
      }

      const rect = container.getBoundingClientRect();
      const touches = readTouches(event.touches);
      pinchStateRef.current = {
        distance: getTouchDistance(touches),
        zoom,
        scrollLeft: container.scrollLeft,
        scrollTop: container.scrollTop,
        centerX: ((touches[0].clientX + touches[1].clientX) / 2) - rect.left,
        centerY: ((touches[0].clientY + touches[1].clientY) / 2) - rect.top,
      };
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !pinchStateRef.current) return;

      const touches = readTouches(event.touches);
      const nextDistance = getTouchDistance(touches);
      const pinch = pinchStateRef.current;
      const nextZoom = clamp((nextDistance / pinch.distance) * pinch.zoom, GENEALOGY_MIN_ZOOM, GENEALOGY_MAX_ZOOM);
      const prevScale = pinch.zoom * GENEALOGY_BASE_SCALE;
      const nextScale = nextZoom * GENEALOGY_BASE_SCALE;
      const contentX = (pinch.scrollLeft + pinch.centerX) / prevScale;
      const contentY = (pinch.scrollTop + pinch.centerY) / prevScale;

      event.preventDefault();
      setZoom(nextZoom);
      window.requestAnimationFrame(() => {
        const viewport = boardViewportRef.current;
        if (!viewport) return;
        viewport.scrollLeft = Math.max(0, contentX * nextScale - pinch.centerX);
        viewport.scrollTop = Math.max(0, contentY * nextScale - pinch.centerY);
      });
    };

    const clearPinchState = () => {
      pinchStateRef.current = null;
    };

    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: false });
    container.addEventListener('touchend', clearPinchState, { passive: true });
    container.addEventListener('touchcancel', clearPinchState, { passive: true });

    return () => {
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', clearPinchState);
      container.removeEventListener('touchcancel', clearPinchState);
    };
  }, [zoom]);

  const emptyText = loading
    ? '系譜を読み込み中です。'
    : normalizedQuery
      ? '検索に一致するノードがありません。'
      : `${activeTag}の系譜データがまだありません。`;

  return (
    <main className="page genealogy-page genealogy-page-v2 genealogy-page-v3">
      <section className="section compact genealogy-chart-section genealogy-chart-section-v2">
        <div className="sticky-panel genealogy-control-panel">
          <div className="genealogy-tab-row" role="tablist" aria-label="系統タブ">
            {tags.map((tag) => (
              <button
                key={tag}
                type="button"
                role="tab"
                aria-selected={activeTag === tag}
                className={`genealogy-tab-button ${activeTag === tag ? 'is-active' : ''}`.trim()}
                onClick={() => {
                  setActiveTag(tag);
                  setQuery('');
                  setFocusedNodeId(null);
                  setHighlightedNodeId(null);
                  setZoom(1);
                  hasAppliedInitialFocusRef.current = false;
                  searchAutofocusKeyRef.current = '';
                }}
              >
                {tag}
              </button>
            ))}
          </div>

          <div className="genealogy-search-row genealogy-search-row-with-back">
            <button
              type="button"
              className="map-back-button genealogy-back-button"
              aria-label="戻る"
              onClick={() => navigateBack(navigate, genealogyBackTo, genealogyBackState)}
            >
              ＜
            </button>
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                hasAppliedInitialFocusRef.current = false;
                searchAutofocusKeyRef.current = '';
                setHighlightedNodeId(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  blurActiveElement();
                }
              }}
              className="full-input genealogy-search-input"
              placeholder="店名・ノード名で検索"
              aria-label="系譜ノードを検索"
            />
            <button type="button" className="secondary-button genealogy-clear-button" onClick={() => { setQuery(''); setHighlightedNodeId(null); searchAutofocusKeyRef.current = ''; }}>
              クリア
            </button>
          </div>

          <div className="genealogy-summary-row genealogy-zoom-row">
            <span>{normalizedQuery ? `${matchedNodes.length}件ヒット` : `${visibleNodes.length}ノード`}</span>
            <span>{Math.round(zoom * 100)}%</span>
          </div>

          {matchedNodes.length > 0 && (
            <div className="genealogy-match-list" aria-label="検索結果ノード一覧">
              {matchedNodes.slice(0, 24).map((node, index) => (
                <button
                  key={node.id}
                  type="button"
                  className={`genealogy-match-chip ${focusedNodeId === node.id ? 'is-active' : ''}`.trim()}
                  onClick={() => {
                    searchAutofocusKeyRef.current = `${activeTag}:${normalizedQuery}:${node.id}`;
                    focusNode(node.id, { nextZoom: 1, highlight: true });
                  }}
                >
                  {matchedNodes.length > 1 ? `${index + 1}. ${node.name}` : node.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {visibleNodes.length === 0 ? (
          <div className="hero-card genealogy-empty-card">{emptyText}</div>
        ) : (
          <div
            ref={boardViewportRef}
            className="genealogy-board-viewport"
            aria-label="家系ラーメンの系譜図"
          >
            <div className="genealogy-zoom-surface" style={{ width: `${layout.boardWidth * actualScale}px`, height: `${layout.boardHeight * actualScale}px` }}>
              <div
                className="genealogy-chart-board genealogy-chart-board-v2"
                style={{ width: `${layout.boardWidth}px`, height: `${layout.boardHeight}px`, transform: `scale(${actualScale})`, transformOrigin: 'top left' }}
              >
                <svg className="genealogy-chart-lines genealogy-chart-lines-v2" viewBox={`0 0 ${layout.boardWidth} ${layout.boardHeight}`} preserveAspectRatio="none" aria-hidden="true">
                  {linePaths.map((path, index) => <path key={`${path}-${index}`} d={path} />)}
                </svg>

                {visibleNodes.map((node) => {
                  const position = layout.positions.get(node.id);
                  if (!position) return null;
                  const isFocused = focusedNodeId === node.id;
                  const isHighlighted = !node.isClosed && highlightedNodeId === node.id;
                  const isDimmed = node.isClosed || (highlightMode && !isHighlighted);
                  const nodeBackTo = buildGenealogyUrl({ tag: activeTag, query, focusNodeId: node.id, zoom });
                  return (
                    <div
                      key={node.id}
                      className="genealogy-node-slot"
                      style={{ left: `${position.x}px`, top: `${position.y}px`, width: `${layout.colWidth}px` }}
                    >
                      <GenealogyNodeCard
                        node={node}
                        compact={node.shopCount > 1}
                        isMatched={isHighlighted}
                        isDimmed={isDimmed}
                        isFocused={isFocused}
                        onFocus={() => { setFocusedNodeId(node.id); setHighlightedNodeId(node.id); }}
                        onPrepareBackEntry={() => {
                          if (typeof window !== 'undefined') {
                            window.history.replaceState(window.history.state, '', nodeBackTo);
                          }
                        }}
                        backTo={nodeBackTo}
                        backState={{ backTo: genealogyBackTo, backState: genealogyBackState }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </section>

      <BottomNav />
    </main>
  );
}

function GenealogyNodeCard({
  node,
  compact = false,
  isMatched = false,
  isDimmed = false,
  isFocused = false,
  onFocus,
  onPrepareBackEntry,
  backTo,
  backState,
}: {
  node: GenealogyGraphNode;
  compact?: boolean;
  isMatched?: boolean;
  isDimmed?: boolean;
  isFocused?: boolean;
  onFocus?: () => void;
  onPrepareBackEntry?: () => void;
  backTo?: string;
  backState?: Record<string, unknown>;
}) {
  const isList = node.link.kind === 'list';
  const className = `genealogy-node-card depth-${node.depth} accent-${node.accent} ${compact ? 'is-compact' : ''} ${isMatched ? 'is-matched' : ''} ${isDimmed ? 'is-dimmed' : ''} ${isFocused ? 'is-focused' : ''} ${node.isClosed ? 'is-closed' : ''}`.trim();

  if (node.isClosed) {
    return (
      <div className={className} aria-label={`${node.name} 閉店済み`}>
        <strong>{node.name}</strong>
        <small>閉店済み</small>
      </div>
    );
  }

  return (
    <Link
      to={node.link.to}
      className={className}
      state={backTo ? { backTo, backState, focusNodeId: node.id } : { focusNodeId: node.id }}
      aria-label={`${node.name} ${isList ? '結果一覧へ' : '店舗詳細へ'}`}
      onClick={() => {
        onPrepareBackEntry?.();
        onFocus?.();
      }}
    >
      <strong>{node.name}</strong>
      <small>{node.subtitle}</small>
      <div className="genealogy-node-meta-row">
        <span className="genealogy-node-count">{node.shopCount > 1 ? `${node.shopCount}店舗` : '1店舗'}</span>
        <span className="genealogy-node-arrow">{isList ? '一覧へ' : '詳細へ'} ↗</span>
      </div>
    </Link>
  );
}

function BottomNav({ className = '' }: { className?: string }) {
  return (
    <nav className={`bottom-nav three-col ${className}`.trim()}>
      <Link to="/">トップ</Link>
      <Link to="/map">マップ</Link>
      <Link to="/genealogy">系譜図</Link>
    </nav>
  );
}
