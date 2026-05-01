import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { defaultShops } from './lib/shopSeeds';
import { noPhotoDataUrl } from './lib/placeholders';
import { deleteShopImage, executeCsvImport, getConnectionLabel, getImageBucketName, listShops, previewCsvImport, removeShop, upsertShop, uploadShopImage } from './lib/shopService';
import { createNewShopSubmission, createUpdateShopSubmission, getShopSubmission, importApprovedSubmissionToShops, listMyShopSubmissions, listShopSubmissions, reviewShopSubmission, updateShopSubmissionDraft, uploadShopSubmissionImage } from './lib/submissionService';
import type { ShopSubmission, ShopSubmissionDraftInput, ShopSubmissionStatus } from './lib/submissionService';
import { getAdminAuthState, signInAdmin, signOutAdmin } from './lib/authService';
import { hasSupabaseEnv, supabase } from './lib/supabase';
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
        ? { kind: 'list', to: `/shops?nodoId=${encodeURIComponent(nodeId)}&q=${encodeURIComponent(getNodeDisplayName(representative))}` }
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
  saved: SavedKind | '';
};

type MapEntrySource = 'home' | 'searchResults' | 'detail';
type MapViewSnapshot = { center: [number, number]; zoom: number };
type MapSelectionDisplayMode = 'preserve' | 'centered';

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

function filterShopsBySaved(shops: Shop[], filters: SearchFilters, store: MemberStore) {
  const filtered = filterShops(shops, filters);
  if (!filters.saved) return filtered;
  const savedIds = new Set(store[filters.saved]);
  return filtered.filter((shop) => savedIds.has(shop.id));
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
    saved: (searchParams.get('saved') as SavedKind | null) ?? '',
  };
}

function buildSearchParams(filters: SearchFilters) {
  const next = new URLSearchParams();
  if (filters.q.trim()) next.set('q', filters.q.trim());
  if (filters.origin) next.set('origin', filters.origin);
  if (filters.tag) next.set('tag', filters.tag);
  if (filters.parking !== null) next.set('parking', String(filters.parking));
  if (filters.nodoId) next.set('nodoId', filters.nodoId);
  if (filters.saved) next.set('saved', filters.saved);
  return next;
}

function buildSearchUrl(filters: SearchFilters) {
  const query = buildSearchParams(filters).toString();
  return `/shops${query ? `?${query}` : ''}`;
}

function readMapView(searchParams: URLSearchParams): MapViewSnapshot | null {
  const lat = Number(searchParams.get('lat'));
  const lng = Number(searchParams.get('lng'));
  const zoom = Number(searchParams.get('z'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(zoom)) return null;
  return {
    center: [lat, lng],
    zoom: clamp(zoom, 3, 18),
  };
}

function writeMapView(searchParams: URLSearchParams, snapshot: MapViewSnapshot) {
  searchParams.set('lat', String(Number(snapshot.center[0].toFixed(6))));
  searchParams.set('lng', String(Number(snapshot.center[1].toFixed(6))));
  searchParams.set('z', String(Number(snapshot.zoom.toFixed(2))));
}

function readSelectionDisplayMode(searchParams: URLSearchParams): MapSelectionDisplayMode {
  return searchParams.get('selmode') === 'centered' ? 'centered' : 'preserve';
}

function writeSelectionDisplayMode(searchParams: URLSearchParams, mode: MapSelectionDisplayMode | null) {
  if (!mode) {
    searchParams.delete('selmode');
    return;
  }
  searchParams.set('selmode', mode);
}

function createMapParams({
  filters,
  ids,
  selectedShopId,
  isOsmSearchMode,
  view,
  selectionDisplayMode,
}: {
  filters: SearchFilters;
  ids?: string[];
  selectedShopId?: string;
  isOsmSearchMode?: boolean;
  view?: MapViewSnapshot | null;
  selectionDisplayMode?: MapSelectionDisplayMode | null;
}) {
  const params = buildSearchParams(filters);
  if (ids?.length) params.set('ids', ids.join(','));
  if (selectedShopId) params.set('selected', selectedShopId);
  if (isOsmSearchMode) params.set('osm', '1');
  if (view) writeMapView(params, view);
  if (selectionDisplayMode) writeSelectionDisplayMode(params, selectionDisplayMode);
  return params;
}

function createEmptySearchFilters(): SearchFilters {
  return { q: '', origin: '', tag: '', parking: null, nodoId: '', saved: '' };
}

function hasSearchFilters(filters: SearchFilters) {
  return Boolean(filters.q.trim() || filters.origin.trim() || filters.tag || filters.parking !== null || filters.nodoId || filters.saved);
}

function shouldFitMapOnInitialLoad({
  ids,
  filters,
  isOsmSearchMode,
  initialSelectedShopId,
}: {
  ids: string[];
  filters: SearchFilters;
  isOsmSearchMode: boolean;
  initialSelectedShopId?: string;
}) {
  if (isOsmSearchMode) return false;
  if (initialSelectedShopId) return false;
  if (ids.length > 1) return true;
  if (ids.length === 1) return false;
  if (hasSearchFilters(filters)) return true;
  return true;
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
  options?: { preferExplicitTarget?: boolean },
) {
  if (!options?.preferExplicitTarget && canUseBrowserBack()) {
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

type MemberSession = {
  loggedIn: boolean;
  userId: string;
  email: string;
  nickname: string;
};

type SavedKind = 'want' | 'visited' | 'favorite';

type MemberStore = {
  want: string[];
  visited: string[];
  favorite: string[];
  history: string[];
};

type MemberReview = {
  id: string;
  userId: string;
  shopId: string;
  nickname: string;
  rating: number;
  comment: string;
  hasPhoto: boolean;
  imageUrls: string[];
};

type MemberNews = {
  id: string;
  date: string;
  title: string;
  body: string;
};

const defaultMemberSession: MemberSession = {
  loggedIn: false,
  userId: '',
  email: '',
  nickname: '家系ビギナー',
};

const defaultMemberStore: MemberStore = { want: [], visited: [], favorite: [], history: [] };

const savedLabels: Record<SavedKind, string> = {
  want: '行きたい',
  visited: '行った',
  favorite: 'お気に入り',
};

const savedFilterOptions: Array<{ value: SavedKind; label: string }> = [
  { value: 'want', label: '行きたい' },
  { value: 'visited', label: '行った' },
];

const sampleNews: MemberNews[] = [
  { id: 'n1', date: '2026.04.21', title: '会員機能を追加しました', body: '行きたい・行った・お気に入り、レビュー投稿、閲覧履歴が使えるようになりました。' },
  { id: 'n2', date: '2026.04.18', title: '新店舗情報提供の受付を開始しました', body: '未掲載の家系ラーメン店を見つけたら、マイページから運営へお知らせください。' },
  { id: 'n3', date: '2026.04.12', title: '店舗情報の修正提案に対応しました', body: '営業時間や定休日などの変更情報を、店舗詳細からかんたんに送れるようになりました。' },
];

const sampleReviews: MemberReview[] = [
  { id: 'r1', userId: 'sample-1', shopId: '1', nickname: '家系ビギナー', rating: 5, comment: 'スープの厚みがすごく、初めてでも迷わず行けました。', hasPhoto: true, imageUrls: [] },
  { id: 'r2', userId: 'sample-2', shopId: '2', nickname: '麺かため派', rating: 4, comment: '朝ラーで利用。駅から行きやすく、回転も早かったです。', hasPhoto: false, imageUrls: [] },
];

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function formatNewsDate(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10).replace(/-/g, '.');
  return date.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '.');
}

function isSupabaseReady() {
  return Boolean(hasSupabaseEnv && supabase);
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

async function getCurrentMemberUser() {
  if (!isSupabaseReady() || !supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  return data.user;
}

async function loadMemberProfile(userId: string, fallbackNickname = defaultMemberSession.nickname) {
  if (!supabase) return { nickname: fallbackNickname };
  const { data, error } = await supabase.from('users_profile').select('nickname,is_deleted').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(getErrorMessage(error, 'プロフィールの取得に失敗しました。'));
  if (!data) {
    await upsertMemberProfile(userId, fallbackNickname);
    return { nickname: fallbackNickname };
  }
  return { nickname: data.is_deleted ? '退会済みユーザー' : (data.nickname || fallbackNickname) };
}

async function upsertMemberProfile(userId: string, nickname: string) {
  if (!supabase) return;
  const { error } = await supabase.from('users_profile').upsert({ user_id: userId, nickname, is_deleted: false }, { onConflict: 'user_id' });
  if (error) throw new Error(getErrorMessage(error, 'プロフィールの保存に失敗しました。'));
}

async function loadMemberStore(userId: string): Promise<MemberStore> {
  if (!supabase) return defaultMemberStore;
  const { data: listRows, error: listError } = await supabase.from('user_shop_lists').select('shop_id,list_type').eq('user_id', userId).order('created_at', { ascending: false });
  if (listError) throw listError;
  const { data: historyRows, error: historyError } = await supabase.from('user_shop_view_histories').select('shop_id').eq('user_id', userId).order('viewed_at', { ascending: false }).limit(10);
  if (historyError) throw historyError;
  const store: MemberStore = { want: [], visited: [], favorite: [], history: [] };
  (listRows ?? []).forEach((row) => {
    const kind = row.list_type as SavedKind;
    if (kind === 'want' || kind === 'visited' || kind === 'favorite') store[kind].push(row.shop_id);
  });
  store.history = (historyRows ?? []).map((row) => row.shop_id);
  return store;
}

async function loadReviews(): Promise<MemberReview[]> {
  if (!isSupabaseReady() || !supabase) return sampleReviews;
  const { data, error } = await supabase.from('reviews').select('id,shop_id,user_id,rating,comment,review_images(public_url)').eq('is_deleted', false).order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => {
    const imageUrls = ((row.review_images ?? []) as { public_url: string | null }[]).map((image) => image.public_url).filter(Boolean) as string[];
    return { id: row.id, userId: row.user_id, shopId: row.shop_id, nickname: '投稿ユーザー', rating: Number(row.rating), comment: row.comment ?? '', hasPhoto: imageUrls.length > 0, imageUrls };
  });
}

async function loadNews(): Promise<MemberNews[]> {
  if (!isSupabaseReady() || !supabase) return sampleNews;
  const { data, error } = await supabase.from('announcements').select('id,title,body,published_at,created_at').eq('is_published', true).order('published_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  const rows = (data ?? []).map((row) => ({ id: row.id, title: row.title, body: row.body, date: formatNewsDate(row.published_at || row.created_at) }));
  return rows.length ? rows : sampleNews;
}

async function uploadReviewImage(reviewId: string, userId: string, file: File) {
  if (!supabase) return null;
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const storagePath = `${userId}/${reviewId}/${fileName}`;
  const { error: uploadError } = await supabase.storage.from('review-images').upload(storagePath, file, { upsert: false });
  if (uploadError) throw uploadError;
  const { data } = supabase.storage.from('review-images').getPublicUrl(storagePath);
  return { storagePath, publicUrl: data.publicUrl };
}

function useMemberAccount() {
  const [session, setSession] = useState<MemberSession>(() => isSupabaseReady() ? defaultMemberSession : readJson('iekei-member-session', defaultMemberSession));
  const [store, setStore] = useState<MemberStore>(() => isSupabaseReady() ? defaultMemberStore : readJson('iekei-member-store', defaultMemberStore));
  const [reviews, setReviews] = useState<MemberReview[]>(() => isSupabaseReady() ? [] : sampleReviews);
  const [news, setNews] = useState<MemberNews[]>(() => isSupabaseReady() ? [] : sampleNews);
  const [ready, setReady] = useState(false);

  const refreshReviews = useCallback(async () => { setReviews(await loadReviews()); }, []);
  const refreshNews = useCallback(async () => { setNews(await loadNews()); }, []);
  const refreshMember = useCallback(async () => {
    if (!isSupabaseReady() || !supabase) { setReady(true); return; }
    const user = await getCurrentMemberUser();
    if (!user) { setSession(defaultMemberSession); setStore(defaultMemberStore); setReady(true); return; }
    const metadataNickname = typeof user.user_metadata?.nickname === 'string' && user.user_metadata.nickname.trim() ? user.user_metadata.nickname.trim() : defaultMemberSession.nickname;
    const profile = await loadMemberProfile(user.id, metadataNickname);
    setSession({ loggedIn: true, userId: user.id, email: user.email ?? '', nickname: profile.nickname });
    setStore(await loadMemberStore(user.id));
    setReady(true);
  }, []);

  useEffect(() => {
    refreshMember().catch(console.error);
    refreshReviews().catch(console.error);
    refreshNews().catch(console.error);
    if (!isSupabaseReady() || !supabase) return;
    const { data } = supabase.auth.onAuthStateChange(() => { refreshMember().catch(console.error); });
    return () => data.subscription.unsubscribe();
  }, [refreshMember, refreshReviews, refreshNews]);

  useEffect(() => { if (!isSupabaseReady()) window.localStorage.setItem('iekei-member-session', JSON.stringify(session)); }, [session]);
  useEffect(() => { if (!isSupabaseReady()) window.localStorage.setItem('iekei-member-store', JSON.stringify(store)); }, [store]);

  const login = async (email: string, password: string) => {
    if (!isSupabaseReady() || !supabase) { setSession((current) => ({ ...current, loggedIn: true, email })); return; }
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await refreshMember();
  };

  const signup = async (email: string, password: string, nickname: string) => {
    const trimmedEmail = email.trim();
    const trimmedNickname = nickname.trim();

    if (!trimmedNickname) throw new Error('ユーザーネームを入力してください。');
    if (trimmedNickname.length > 30) throw new Error('ユーザーネームは30文字以内で入力してください。');
    if (!trimmedEmail) throw new Error('メールアドレスを入力してください。');
    if (password.length < 6) throw new Error('パスワードは6文字以上で入力してください。');
    if (!isSupabaseReady() || !supabase) {
      throw new Error('Supabase接続情報が見つかりません。.env.localを確認してください。');
    }

    console.log('SIGNUP REQUEST:', { email: trimmedEmail, nickname: trimmedNickname });

    const { data, error } = await supabase.auth.signUp({
      email: trimmedEmail,
      password,
      options: {
        data: { nickname: trimmedNickname },
      },
    });

    console.log('SIGNUP RESPONSE:', {
      userId: data.user?.id ?? null,
      email: data.user?.email ?? null,
      hasSession: Boolean(data.session),
      error: error ? { name: error.name, message: error.message, status: error.status } : null,
    });

    if (error) throw new Error(getErrorMessage(error, '登録に失敗しました。'));
    if (!data.user) {
      throw new Error('Supabaseからユーザー作成結果が返りませんでした。Authentication設定を確認してください。');
    }

    // Supabase側で「Confirm email」をOFFにしている前提。
    // 登録直後にログイン状態になるため、入力されたユーザーネームでプロフィールを作成してマイページへ進める。
    if (data.session) {
      await upsertMemberProfile(data.user.id, trimmedNickname);
      await refreshMember();
      return;
    }

    // 環境設定によってセッションが返らない場合に備えて、明示的にログインする。
    const { error: loginError } = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    });
    if (loginError) throw new Error(getErrorMessage(loginError, '登録後のログインに失敗しました。'));
    await upsertMemberProfile(data.user.id, trimmedNickname);
    await refreshMember();
  };
  const logout = async () => {
    if (!isSupabaseReady() || !supabase) { setSession((current) => ({ ...current, loggedIn: false })); return; }
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    setSession(defaultMemberSession);
    setStore(defaultMemberStore);
  };

  const updateProfile = async (next: Pick<MemberSession, 'nickname'>) => {
    if (!isSupabaseReady() || !supabase) { setSession((current) => ({ ...current, ...next })); return; }
    const user = await getCurrentMemberUser();
    if (!user) throw new Error('ログインが必要です。');
    await upsertMemberProfile(user.id, next.nickname);
    setSession((current) => ({ ...current, ...next }));
  };

  const toggleSaved = async (kind: SavedKind, shopId: string) => {
    if (!isSupabaseReady() || !supabase) {
      setStore((current) => {
        const exists = current[kind].includes(shopId);
        return { ...current, [kind]: exists ? current[kind].filter((id) => id !== shopId) : [shopId, ...current[kind]] };
      });
      return;
    }
    const user = await getCurrentMemberUser();
    if (!user) throw new Error('ログインが必要です。');
    const exists = store[kind].includes(shopId);
    if (exists) {
      const { error } = await supabase.from('user_shop_lists').delete().eq('user_id', user.id).eq('shop_id', shopId).eq('list_type', kind);
      if (error) throw error;
    } else {
      const { error } = await supabase.from('user_shop_lists').insert({ user_id: user.id, shop_id: shopId, list_type: kind });
      if (error) throw error;
    }
    setStore(await loadMemberStore(user.id));
  };

  const addHistory = async (shopId: string) => {
    if (!shopId) return;
    if (!isSupabaseReady() || !supabase || !session.loggedIn) { setStore((current) => ({ ...current, history: [shopId, ...current.history.filter((id) => id !== shopId)].slice(0, 10) })); return; }
    const user = await getCurrentMemberUser();
    if (!user) return;
    const { error } = await supabase.from('user_shop_view_histories').upsert({ user_id: user.id, shop_id: shopId, viewed_at: new Date().toISOString() }, { onConflict: 'user_id,shop_id' });
    if (error) throw error;
    setStore(await loadMemberStore(user.id));
  };

  const clearHistory = async () => {
    if (!isSupabaseReady() || !supabase) { setStore((current) => ({ ...current, history: [] })); return; }
    const user = await getCurrentMemberUser();
    if (!user) return;
    const { error } = await supabase.from('user_shop_view_histories').delete().eq('user_id', user.id);
    if (error) throw error;
    setStore((current) => ({ ...current, history: [] }));
  };

  const submitReview = async (shopId: string, rating: number, comment: string, file?: File | null) => {
    if (!isSupabaseReady() || !supabase) {
      const next: MemberReview = { id: String(Date.now()), userId: session.userId || 'local-user', shopId, nickname: session.nickname, rating, comment, hasPhoto: Boolean(file), imageUrls: [] };
      setReviews((current) => [next, ...current.filter((review) => !(review.shopId === shopId && review.nickname === session.nickname))]);
      return;
    }
    const user = await getCurrentMemberUser();
    if (!user) throw new Error('ログインが必要です。');
    const { data, error } = await supabase.from('reviews').upsert({ user_id: user.id, shop_id: shopId, rating, comment: comment.trim() || null, is_deleted: false }, { onConflict: 'user_id,shop_id' }).select('id').single();
    if (error) throw error;
    if (file && data?.id) {
      const uploaded = await uploadReviewImage(data.id, user.id, file);
      if (uploaded) {
        const { error: imageError } = await supabase.from('review_images').insert({ review_id: data.id, storage_path: uploaded.storagePath, public_url: uploaded.publicUrl, sort_order: 0 });
        if (imageError) throw imageError;
      }
    }
    await refreshReviews();
  };

  const resetPassword = async (email: string) => {
    if (!isSupabaseReady() || !supabase) return;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/password-update` });
    if (error) throw error;
  };

  const withdraw = async () => {
    if (!isSupabaseReady() || !supabase) { setSession(defaultMemberSession); setStore(defaultMemberStore); return; }
    const user = await getCurrentMemberUser();
    if (user) {
      const { error } = await supabase.from('users_profile').update({ is_deleted: true, nickname: '退会済みユーザー' }).eq('user_id', user.id);
      if (error) throw error;
    }
    await logout();
  };

  const updatePassword = async (password: string) => {
    if (password.length < 6) throw new Error('パスワードは6文字以上で入力してください。');
    if (!isSupabaseReady() || !supabase) throw new Error('Supabase接続情報が見つかりません。.env.localを確認してください。');
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    await refreshMember();
  };

  return { ready, session, store, reviews, news, login, signup, logout, updateProfile, toggleSaved, addHistory, clearHistory, submitReview, resetPassword, updatePassword, withdraw };
}

type SupportNotificationSettings = {
  enabled: boolean;
  toEmail: string;
  ccEmail: string;
};

const defaultSupportNotificationSettings: SupportNotificationSettings = {
  enabled: true,
  toEmail: '',
  ccEmail: '',
};

function useSupportNotificationSettings() {
  const [settings, setSettings] = useState<SupportNotificationSettings>(() => readJson('iekei-support-notification-settings', defaultSupportNotificationSettings));

  useEffect(() => {
    window.localStorage.setItem('iekei-support-notification-settings', JSON.stringify(settings));
  }, [settings]);

  const updateSettings = (next: SupportNotificationSettings) => {
    setSettings({
      enabled: next.enabled,
      toEmail: next.toEmail.trim(),
      ccEmail: next.ccEmail.trim(),
    });
  };

  return { settings, updateSettings };
}

function appendSupportSubmission(payload: Record<string, string>) {
  try {
    const raw = window.localStorage.getItem('iekei-support-submissions');
    const current = raw ? JSON.parse(raw) as Record<string, string>[] : [];
    window.localStorage.setItem('iekei-support-submissions', JSON.stringify([{ ...payload, createdAt: new Date().toISOString() }, ...current].slice(0, 50)));
  } catch {
    // ローカル保存に失敗しても、メール作成導線は止めない
  }
}

async function sendSupportMail(title: string, payload: Record<string, string>, settings: SupportNotificationSettings) {
  const response = await fetch('/api/send-mail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      payload,
      // 宛先はサーバー側の CONTACT_TO_EMAIL で管理します。
      // フロントから運営メールアドレスは送らないため、ユーザーには見えません。
    }),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.error || 'メール送信に失敗しました。');
  }
}

function collectFormPayload(form: HTMLFormElement) {
  const formData = new FormData(form);
  const payload: Record<string, string> = {};
  formData.forEach((value, key) => {
    if (value instanceof File) {
      payload[key] = value.name || '選択なし';
    } else {
      payload[key] = value;
    }
  });
  return payload;
}

function createShopMarkerIcon(selected: boolean, favorite = false) {
  return L.divIcon({
    className: 'custom-marker-wrapper',
    html: `<span class="custom-marker-dot ${favorite ? 'favorite' : ''} ${selected ? 'selected' : ''}"></span>`,
    iconSize: [20, 20],
    iconAnchor: [10, 20],
    popupAnchor: [0, -16]
  });
}

export default function App() {
  const shopState = useShops();
  const member = useMemberAccount();
  const supportNotifications = useSupportNotificationSettings();

  return (
    <div className="app-shell">
      <ScrollToTopOnRouteChange />
      <Routes>
        <Route path="/" element={<HomePage shops={shopState.shops} />} />
        <Route path="/shops" element={<ShopSearchPage shops={shopState.shops} loading={shopState.loading} member={member} />} />
        <Route path="/map" element={<MapPage shops={shopState.shops} member={member} />} />
        <Route path="/genealogy" element={<GenealogyPage shops={shopState.shops} loading={shopState.loading} />} />
        <Route path="/shops/:shopId" element={<ShopDetailPage shops={shopState.shops} member={member} />} />
        <Route path="/login" element={<MemberLoginPage member={member} />} />
        <Route path="/signup" element={<MemberSignupPage member={member} />} />
        <Route path="/password-reset" element={<PasswordResetPage member={member} />} />
        <Route path="/password-update" element={<PasswordUpdatePage member={member} />} />
        <Route path="/mypage" element={<MyPage shops={shopState.shops} member={member} />} />
        <Route path="/mypage/profile" element={<ProfileEditPage member={member} />} />
        <Route path="/mypage/saved" element={<SavedListPage shops={shopState.shops} member={member} />} />
        <Route path="/mypage/history" element={<HistoryPage shops={shopState.shops} member={member} />} />
        <Route path="/mypage/reviews" element={<MyReviewsPage shops={shopState.shops} member={member} />} />
        <Route path="/mypage/submissions" element={<MySubmissionsPage member={member} />} />
        <Route path="/mypage/submissions/:submissionId" element={<MySubmissionDetailPage member={member} />} />
        <Route path="/mypage/news" element={<NewsListPage member={member} />} />
        <Route path="/mypage/news/:newsId" element={<NewsDetailPage member={member} />} />
        <Route path="/contact" element={<ContactPage member={member} notification={supportNotifications.settings} />} />
        <Route path="/shops/new-suggestion" element={<NewShopSuggestionPage member={member} notification={supportNotifications.settings} />} />
        <Route path="/shops/:shopId/edit-suggestion" element={<ShopCorrectionPage shops={shopState.shops} member={member} notification={supportNotifications.settings} />} />
        <Route path="/shops/:shopId/review" element={<ReviewPage shops={shopState.shops} member={member} />} />
        <Route path="/withdraw" element={<WithdrawPage member={member} />} />
        <Route path="/areas" element={<Navigate to="/shops" replace />} />
        <Route path="/admin/login" element={<Navigate to="/admin-8fj3k2-3me77nfcb6c0/login" replace />} />
        <Route path="/admin" element={<Navigate to="/admin-8fj3k2-3me77nfcb6c0" replace />} />
        <Route path="/admin-8fj3k2-3me77nfcb6c0/login" element={<AdminLoginPage />} />
        <Route path="/admin-8fj3k2-3me77nfcb6c0" element={<AdminRoute><AdminTopPage shops={shopState.shops} notification={supportNotifications.settings} onSaveNotification={supportNotifications.updateSettings} /></AdminRoute>} />
        <Route path="/admin-8fj3k2-3me77nfcb6c0/settings" element={<Navigate to="/admin-8fj3k2-3me77nfcb6c0" replace />} />
        <Route path="/admin-8fj3k2-3me77nfcb6c0/shops" element={<AdminRoute><AdminShopsPage shops={shopState.shops} loading={shopState.loading} onDeleted={shopState.refresh} onRefresh={shopState.refresh} /></AdminRoute>} />
        <Route path="/admin-8fj3k2-3me77nfcb6c0/submissions" element={<AdminRoute><AdminSubmissionsPage /></AdminRoute>} />
        <Route path="/admin-8fj3k2-3me77nfcb6c0/submissions/:submissionId" element={<AdminRoute><AdminSubmissionDetailPage /></AdminRoute>} />
        <Route path="/admin-8fj3k2-3me77nfcb6c0/shops/:shopId" element={<AdminRoute><AdminEditPage shops={shopState.shops} onSaved={shopState.refresh} /></AdminRoute>} />
        <Route path="/admin/settings" element={<Navigate to="/admin-8fj3k2-3me77nfcb6c0" replace />} />
        <Route path="/admin/shops" element={<Navigate to="/admin-8fj3k2-3me77nfcb6c0/shops" replace />} />
        <Route path="/admin/shops/:shopId" element={<AdminLegacyShopRedirect />} />
      </Routes>
    </div>
  );
}

function ScrollToTopOnRouteChange() {
  const location = useLocation();
  const previousRef = useRef<{ pathname: string; search: string; state: unknown } | null>(null);

  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = { pathname: location.pathname, search: location.search, state: location.state };
    if (!previous) return;

    const nextState = (location.state as { entrySource?: MapEntrySource } | null) ?? null;
    const isMapDestination = location.pathname === '/map';
    const shouldKeepPosition =
      (previous.pathname.startsWith('/shops/') && isMapDestination && nextState?.entrySource === 'detail') ||
      (previous.pathname.startsWith('/shops/') && location.pathname === '/genealogy') ||
      (previous.pathname === '/genealogy' && isMapDestination) ||
      (previous.pathname === '/shops' && isMapDestination && nextState?.entrySource === 'searchResults');

    if (!shouldKeepPosition) {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }, [location.pathname, location.search, location.state]);

  return null;
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
    return <Navigate to="/admin-8fj3k2-3me77nfcb6c0/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return children;
}

function AdminLegacyShopRedirect() {
  const { shopId } = useParams();
  return <Navigate to={`/admin-8fj3k2-3me77nfcb6c0/shops/${shopId ?? ''}`} replace />;
}

function Header({ title, backTo, backState, eyebrow = '家系行脚', backLabel = '← 戻る', className = '', hideTitle = false, preferExplicitBackTarget = false }: { title: string; backTo?: string; backState?: Record<string, unknown>; eyebrow?: string; backLabel?: string; className?: string; hideTitle?: boolean; preferExplicitBackTarget?: boolean }) {
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
            onClick={() => navigateBack(navigate, resolvedBackTo, resolvedBackState, { preferExplicitTarget: preferExplicitBackTarget && Boolean(backTo || locationState?.backTo) })}
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
              placeholder="店名で検索"
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

function ShopSearchPage({ shops, loading, member }: { shops: Shop[]; loading: boolean; member: ReturnType<typeof useMemberAccount> }) {
  const location = useLocation();
  const locationState = (location.state as { backTo?: string; backState?: Record<string, unknown> } | null) ?? null;
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readSearchFilters(searchParams);
  const [searchText, setSearchText] = useState(filters.q);

  useEffect(() => {
    setSearchText(filters.q);
  }, [filters.q]);

  const filtered = useMemo(() => filterShopsBySaved(shops, filters, member.store), [filters, member.store, shops]);

  const updateFilters = (nextValues: Partial<SearchFilters>) => {
    const nextFilters: SearchFilters = {
      q: nextValues.q ?? filters.q,
      origin: nextValues.origin ?? filters.origin,
      tag: nextValues.tag ?? filters.tag,
      parking: nextValues.parking === undefined ? filters.parking : nextValues.parking,
      nodoId: nextValues.nodoId ?? filters.nodoId,
      saved: nextValues.saved ?? filters.saved,
    };
    setSearchParams(buildSearchParams(nextFilters), { replace: true });
  };

  const handleSearchSubmit = (event: FormEvent) => {
    event.preventDefault();
    updateFilters({ q: searchText });
  };

  const currentSearchUrl = buildSearchUrl(filters);
  const mapLink = `/map${(() => {
    if (filtered.length === 1) {
      const params = createMapParams({
        filters,
        ids: [filtered[0].id],
        selectedShopId: filtered[0].id,
        isOsmSearchMode: false,
        selectionDisplayMode: 'centered',
      });
      const query = params.toString();
      return query ? `?${query}` : '';
    }

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
        <div className="filter-inline-row search-filter-row">
          <FilterDropdown
            placeholder="保存"
            value={filters.saved}
            options={savedFilterOptions}
            onChange={(value) => updateFilters({ saved: value as SavedKind | '' })}
          />
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

function MapPage({ shops, member }: { shops: Shop[]; member: ReturnType<typeof useMemberAccount> }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFilters = useMemo(() => readSearchFilters(searchParams), [searchParams]);
  const ids = useMemo(() => (searchParams.get('ids') ?? '').split(',').filter(Boolean), [searchParams]);
  const initialSelected = searchParams.get('selected') ?? '';
  const initialOsmMode = searchParams.get('osm') === '1';
  const initialMapView = useMemo(() => readMapView(searchParams), [searchParams]);
  const initialSelectionDisplayMode = useMemo(() => readSelectionDisplayMode(searchParams), [searchParams]);
  const locationState = (location.state as { backTo?: string; backState?: Record<string, unknown>; autoLocate?: boolean; entrySource?: MapEntrySource } | null) ?? null;
  const initialEntrySource: MapEntrySource = locationState?.entrySource ?? 'home';
  const [entrySource, setEntrySource] = useState<MapEntrySource>(initialEntrySource);
  const [hasMapSearched, setHasMapSearched] = useState(false);
  const [selectedShopId, setSelectedShopId] = useState(initialSelected);
  const [selectionDisplayMode, setSelectionDisplayMode] = useState<MapSelectionDisplayMode>(initialSelectionDisplayMode);
  const [isOsmSearchMode, setIsOsmSearchMode] = useState(initialOsmMode);
  const [searchText, setSearchText] = useState(initialFilters.q);
  const [activeFilters, setActiveFilters] = useState<SearchFilters>(initialFilters);
  const [draftFilters, setDraftFilters] = useState<SearchFilters>(initialFilters);
  const [expanded, setExpanded] = useState(initialEntrySource === 'searchResults' && !!(initialFilters.q || initialFilters.origin || initialFilters.tag || initialFilters.parking !== null));
  const [visibleShops, setVisibleShops] = useState<Shop[]>(() => ids.length ? shops.filter((shop) => ids.includes(shop.id) && isPublicShop(shop)) : filterShopsBySaved(shops, initialFilters, member.store));
  const [mapCenter, setMapCenter] = useState<[number, number]>(initialMapView?.center ?? defaultCenter);
  const [mapZoom, setMapZoom] = useState(initialMapView?.zoom ?? 12);
  const [fitToShops, setFitToShops] = useState<boolean>(() => shouldFitMapOnInitialLoad({ ids, filters: initialFilters, isOsmSearchMode: initialOsmMode, initialSelectedShopId: initialSelected }));
  const [fitRequestKey, setFitRequestKey] = useState(0);
  const [suppressViewportMoveKey, setSuppressViewportMoveKey] = useState(0);
  const [userPosition, setUserPosition] = useState<[number, number] | null>(null);
  const [searchMessage, setSearchMessage] = useState('');
  const [isOsmSearching, setIsOsmSearching] = useState(false);
  const lastOsmRequestAtRef = useRef(0);
  const mapViewRef = useRef<MapViewSnapshot>(initialMapView ?? { center: defaultCenter, zoom: 12 });
  const leafletMapRef = useRef<L.Map | null>(null);
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
    setSelectionDisplayMode(initialSelectionDisplayMode);
  }, [initialSelected, initialSelectionDisplayMode]);

  useEffect(() => {
    setSearchText(initialFilters.q);
    setActiveFilters(initialFilters);
    setDraftFilters(initialFilters);
    if (initialMapView) {
      setMapCenter(initialMapView.center);
      setMapZoom(initialMapView.zoom);
    }
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
      const filteredShops = filterShopsBySaved(shops, initialFilters, member.store);
      const nextVisible = isOsmSearchMode ? allPublicShops : filteredShops;
      setVisibleShops(nextVisible);
      const shouldPreserveView = preserveViewOnNextSyncRef.current;
      if (shouldPreserveView) {
        preserveViewOnNextSyncRef.current = false;
      }
      const hasInitialFilters = hasSearchFilters(initialFilters);
      const hasInitialSelection = Boolean(initialSelected);
      const shouldAutoSelectSingle = !isOsmSearchMode && hasInitialFilters && filteredShops.length === 1 && !skipAutoSelectOnNextSyncRef.current;
      const shouldFitAll = shouldPreserveView
        ? false
        : (isOsmSearchMode ? false : (hasInitialFilters ? (!hasInitialSelection && filteredShops.length > 1) : hasInitialSelection ? false : !hasMapSearched));
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
  }, [allPublicShops, hasMapSearched, ids, initialFilters, initialMapView, initialSelected, isOsmSearchMode, member.store, shops]);

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
    const params = createMapParams({
      filters: hasMapSearched ? activeFilters : readSearchFilters(searchParams),
      ids,
      selectedShopId,
      isOsmSearchMode,
      view: { center: mapCenter, zoom: mapZoom },
      selectionDisplayMode: selectedShopId ? selectionDisplayMode : null,
    });
    const query = params.toString();
    return `/map${query ? `?${query}` : ''}`;
  }, [activeFilters, hasMapSearched, ids, isOsmSearchMode, mapCenter, mapZoom, searchParams, selectedShopId, selectionDisplayMode]);

  const buildMapUrlFromSnapshot = useCallback((snapshot: MapViewSnapshot, nextSelectedShopId?: string | null, nextSelectionDisplayMode?: MapSelectionDisplayMode | null) => {
    const params = createMapParams({
      filters: hasMapSearched ? activeFilters : readSearchFilters(searchParams),
      ids,
      selectedShopId: nextSelectedShopId ?? undefined,
      isOsmSearchMode,
      view: snapshot,
      selectionDisplayMode: nextSelectedShopId ? (nextSelectionDisplayMode ?? selectionDisplayMode) : null,
    });
    const query = params.toString();
    return `/map${query ? `?${query}` : ''}`;
  }, [activeFilters, hasMapSearched, ids, isOsmSearchMode, searchParams, selectionDisplayMode]);

  const mapReturnUrl = useMemo(() => {
    const params = createMapParams({
      filters: hasMapSearched ? activeFilters : readSearchFilters(searchParams),
      ids,
      isOsmSearchMode,
      view: { center: mapCenter, zoom: mapZoom },
      selectionDisplayMode: null,
    });
    const query = params.toString();
    return `/map${query ? `?${query}` : ''}`;
  }, [activeFilters, hasMapSearched, ids, isOsmSearchMode, mapCenter, mapZoom, searchParams]);

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
        setSelectionDisplayMode('preserve');
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

  const getLatestMapSnapshot = useCallback((): MapViewSnapshot => {
    const map = leafletMapRef.current;
    if (!map) return mapViewRef.current;
    const currentCenter = map.getCenter();
    const snapshot = {
      center: [currentCenter.lat, currentCenter.lng] as [number, number],
      zoom: map.getZoom(),
    };
    mapViewRef.current = snapshot;
    return snapshot;
  }, []);

  const handleCloseCard = useCallback(() => {
    const currentView = getLatestMapSnapshot();
    const hadIdFilter = ids.length > 0;
    const hadSearchFilter = hasSearchFilters(activeFilters) && !isOsmSearchMode;
    const hadSubsetFilter = hadIdFilter || hadSearchFilter;
    const hadMultipleFilteredShops = visibleShops.length > 1;

    selectedShopSourceRef.current = 'other';
    setSelectedShopId('');
    setSelectionDisplayMode('preserve');

    if (!hadSubsetFilter || !hadMultipleFilteredShops) {
      preserveViewOnNextSyncRef.current = true;
      skipAutoSelectOnNextSyncRef.current = true;
      setVisibleShops(allPublicShops);
      setFitToShops(false);
      setMapCenter(currentView.center);
      setMapZoom(currentView.zoom);
      setSearchParams(createMapParams({
        filters: createEmptySearchFilters(),
        isOsmSearchMode: false,
        view: currentView,
      }), { replace: true });
      return;
    }

    preserveViewOnNextSyncRef.current = true;
    skipAutoSelectOnNextSyncRef.current = true;
    setFitToShops(false);
    setMapCenter(currentView.center);
    setMapZoom(currentView.zoom);
    setSearchParams(createMapParams({
      filters: activeFilters,
      ids,
      isOsmSearchMode,
      view: currentView,
    }), { replace: true });
  }, [activeFilters, allPublicShops, ids, isOsmSearchMode, setSearchParams, visibleShops.length]);

  const handleClearMapSearch = useCallback(() => {
    const clearedFilters = createEmptySearchFilters();
    const currentView = getLatestMapSnapshot();
    preserveViewOnNextSyncRef.current = true;
    setSearchText('');
    setDraftFilters(clearedFilters);
    setActiveFilters(clearedFilters);
    setHasMapSearched(false);
    setIsOsmSearchMode(false);
    selectedShopSourceRef.current = 'other';
    setSelectedShopId('');
    setSelectionDisplayMode('preserve');
    setVisibleShops(allPublicShops);
    setFitToShops(false);
    setUserPosition(null);
    setSearchMessage('');
    setMapCenter(currentView.center);
    setMapZoom(currentView.zoom);
    setSearchParams(createMapParams({ filters: clearedFilters, view: currentView }), { replace: true });
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
    setSelectionDisplayMode('preserve');
    setSearchMessage('');
    setUserPosition(null);
    setSuppressViewportMoveKey((current) => current + 1);

    const nextVisibleShops = filterShopsBySaved(shops, { ...nextFilters, q: searchText }, member.store);
    setVisibleShops(nextVisibleShops);
    setFitToShops(false);

    const nextParams = createMapParams({
      filters: { ...nextFilters, q: searchText },
      view: getLatestMapSnapshot(),
      selectionDisplayMode: null,
    });
    nextParams.delete('osm');
    nextParams.delete('selected');
    setSearchParams(nextParams, { replace: true });
  }, [member.store, searchText, setSearchParams, shops]);

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
    setSelectionDisplayMode('preserve');
    setSearchMessage('');
    setUserPosition(null);

    const nextVisibleShops = filterShopsBySaved(shops, nextFilters, member.store);
    setVisibleShops(nextVisibleShops);

    const currentView = getLatestMapSnapshot();
    const nextParams = createMapParams({ filters: nextFilters, view: currentView });
    nextParams.delete('osm');
    if (nextVisibleShops.length === 1) {
      nextParams.set('selected', nextVisibleShops[0].id);
      writeSelectionDisplayMode(nextParams, 'centered');
      selectedShopSourceRef.current = 'other';
      setSelectedShopId(nextVisibleShops[0].id);
      setSelectionDisplayMode('centered');
      setMapCenter([nextVisibleShops[0].lat, nextVisibleShops[0].lng]);
      setMapZoom(Math.max(currentView.zoom, 15));
      writeMapView(nextParams, { center: [nextVisibleShops[0].lat, nextVisibleShops[0].lng], zoom: Math.max(currentView.zoom, 15) });
      setFitToShops(false);
    } else {
      writeSelectionDisplayMode(nextParams, null);
      setSelectionDisplayMode('preserve');
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
      setSearchParams(createMapParams({ filters: nextFilters, view: { center: defaultCenter, zoom: 12 } }), { replace: true });
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
      writeMapView(nextParams, { center: result.center, zoom: 15 });
      nextParams.set('osm', '1');
      writeSelectionDisplayMode(nextParams, null);
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
        onBack={() => navigateBack(navigate, backTarget, backState, { preferExplicitTarget: true })}
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
            <MapViewportController center={mapCenter} targetZoom={mapZoom} shops={visibleShops} fitToShops={fitToShops} fitRequestKey={fitRequestKey} suppressMoveKey={suppressViewportMoveKey} selectedShop={selectedShop} selectionDisplayMode={selectionDisplayMode} onMapReady={(mapInstance) => { leafletMapRef.current = mapInstance; }} onViewChange={(snapshot) => { mapViewRef.current = snapshot; }} />
            {visibleShops.map((shop) => {
              const selected = selectedShopId === shop.id;
              return (
                <Marker
                  key={shop.id}
                  position={[shop.lat, shop.lng]}
                  icon={createShopMarkerIcon(selected, member.store.favorite.includes(shop.id))}
                  eventHandlers={{
                    click: () => {
                      const currentView = getLatestMapSnapshot();
                      const nextParams = createMapParams({
                        filters: activeFilters,
                        ids,
                        isOsmSearchMode,
                        view: currentView,
                      });

                      if (selectedShopId === shop.id) {
                        selectedShopSourceRef.current = 'other';
                        setSelectedShopId('');
                        setSelectionDisplayMode('preserve');
                        nextParams.delete('selected');
                        writeSelectionDisplayMode(nextParams, null);
                        setSearchParams(nextParams, { replace: true });
                        return;
                      }

                      selectedShopSourceRef.current = 'mapPin';
                      setSelectedShopId(shop.id);
                      setSelectionDisplayMode('preserve');
                      nextParams.set('selected', shop.id);
                      writeSelectionDisplayMode(nextParams, 'preserve');
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
            <div className="map-overlay-card" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
              <button type="button" className="map-card-close-button" aria-label="店舗カードを閉じる" onPointerDown={(event) => event.stopPropagation()} onClick={handleCloseCard}>×</button>
              <ShopCard
                shop={selectedShop}
                compact
                backTo={buildMapUrlFromSnapshot(getLatestMapSnapshot(), selectedShop.id, selectionDisplayMode)}
                backState={{ backTo: backTarget, backState, entrySource }}
              />
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
                placeholder="保存"
                value={filters.saved}
                options={savedFilterOptions}
                onChange={(value) => onFiltersChange({ ...filters, saved: value as SavedKind | '' })}
              />
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

function MapViewportController({ center, targetZoom, shops, fitToShops, fitRequestKey, suppressMoveKey, selectedShop, selectionDisplayMode, onMapReady, onViewChange }: { center: [number, number]; targetZoom?: number; shops: Shop[]; fitToShops: boolean; fitRequestKey: number; suppressMoveKey: number; selectedShop: Shop | null; selectionDisplayMode: MapSelectionDisplayMode; onMapReady?: (map: L.Map) => void; onViewChange?: (snapshot: MapViewSnapshot) => void }) {
  const map = useMap();
  const initializedRef = useRef(false);
  const prevCenterRef = useRef<string>('');
  const prevZoomRef = useRef<number | null>(null);
  const prevFitToShopsRef = useRef<boolean>(fitToShops);
  const prevShopIdsRef = useRef<string>('');
  const prevFitRequestKeyRef = useRef<number>(fitRequestKey);
  const prevSuppressMoveKeyRef = useRef<number>(suppressMoveKey);

  useEffect(() => {
    onMapReady?.(map);
  }, [map, onMapReady]);

  useEffect(() => {
    const syncSnapshot = () => {
      const currentCenter = map.getCenter();
      onViewChange?.({ center: [currentCenter.lat, currentCenter.lng], zoom: map.getZoom() });
    };

    syncSnapshot();
    map.on('move', syncSnapshot);
    map.on('zoom', syncSnapshot);
    map.on('moveend', syncSnapshot);
    map.on('zoomend', syncSnapshot);

    return () => {
      map.off('move', syncSnapshot);
      map.off('zoom', syncSnapshot);
      map.off('moveend', syncSnapshot);
      map.off('zoomend', syncSnapshot);
    };
  }, [map, onViewChange]);

  useEffect(() => {
    if (selectedShop && selectionDisplayMode === 'centered') {
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
  }, [center, fitRequestKey, fitToShops, map, selectedShop, selectionDisplayMode, shops, suppressMoveKey, targetZoom]);
  return null;
}

function ShopDetailPage({ shops, member }: { shops: Shop[]; member: ReturnType<typeof useMemberAccount> }) {
  const location = useLocation();
  const { shopId } = useParams();
  const shop = shops.find((item) => item.id === shopId) ?? null;
  const locationState = (location.state as { backTo?: string; backState?: Record<string, unknown> } | null) ?? null;
  const backTo = locationState?.backTo ?? '/shops';
  const mapLink = shop
    ? `/map?ids=${encodeURIComponent(shop.id)}&selected=${encodeURIComponent(shop.id)}&q=${encodeURIComponent(getNodeDisplayName(shop))}&selmode=centered`
    : '/map';
  const detailUrl = shop ? `/shops/${shop.id}` : '/shops';
  const genealogyLink = shop ? buildGenealogyUrl({ tag: shop.tag, focusNodeId: shop.nodoId || shop.id, zoom: 1 }) : '/genealogy';
  useEffect(() => {
    if (shop) member.addHistory(shop.id);
  }, [shop?.id]);

  if (!shop) return <main className="page"><Header title="店舗詳細" backTo={backTo} preferExplicitBackTarget /><p>店舗が見つかりませんでした。</p></main>;
  const promptTo = `/login?next=${encodeURIComponent(detailUrl)}`;
  const handleSave = (kind: SavedKind) => {
    if (!member.session.loggedIn) {
      window.location.href = `${promptTo}&action=${kind}`;
      return;
    }
    member.toggleSaved(kind, shop.id);
  };
  return (
    <main className="page detail-page">
      <Header title="店舗詳細" backTo={backTo} preferExplicitBackTarget />
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
      <div className="detail-quick-actions">
        <Link className="secondary-button block" to={mapLink} state={{ backTo: detailUrl, backState: { backTo }, entrySource: 'detail' as MapEntrySource }}>地図で見る</Link>
        <Link className="secondary-button block" to={genealogyLink} state={{ backTo: detailUrl, backState: { backTo }, focusNodeId: shop.nodoId || shop.id }}>系譜図で見る</Link>
        <Link className="secondary-button block" to={`/shops/${shop.id}/edit-suggestion`}>情報修正</Link>
      </div>
      <section className="detail-summary">
        <h2>{shop.name}</h2>
        <div className="tag-row">
          <TagChip tag={shop.tag} />
          <span className="lineage-chip">{shop.origin}</span>
        </div>
        <p className="lead">{shop.station || shop.address}</p>
      </section>
      <section className="member-save-panel" aria-label="保存アクション">
        {(Object.keys(savedLabels) as SavedKind[]).map((kind) => {
          const active = member.store[kind].includes(shop.id);
          return (
            <button key={kind} type="button" className={`save-pill ${active ? 'is-active' : ''}`} onClick={() => handleSave(kind)}>
              <span>{active ? '✓' : '+'}</span>{savedLabels[kind]}
            </button>
          );
        })}
      </section>
      {!member.session.loggedIn ? <LoginGuideCard actionLabel="保存・レビュー" /> : null}
      <section className="section compact">
        <div className="section-head"><h2>レビュー</h2><Link className="text-link" to={`/shops/${shop.id}/review`}>レビューを書く</Link></div>
        <div className="review-list">
          {member.reviews.filter((review) => review.shopId === shop.id).map((review) => <ReviewCard key={review.id} review={review} />)}
          {!member.reviews.some((review) => review.shopId === shop.id) ? <p className="empty-text">まだレビューはありません。最初のレビューを書いてみましょう。</p> : null}
        </div>
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
        <Link className="secondary-button block" to={`/shops/${shop.id}/edit-suggestion`}>情報修正を提案</Link>
      </div>
      <BottomNav />
    </main>
  );
}


function RequireMember({ member, children, message = 'この機能を使うにはログインが必要です。' }: { member: ReturnType<typeof useMemberAccount>; children: ReactNode; message?: string }) {
  const location = useLocation();
  if (!member.session.loggedIn) {
    return <LoginRequiredPage message={message} next={`${location.pathname}${location.search}`} />;
  }
  return <>{children}</>;
}

function LoginGuideCard({ actionLabel }: { actionLabel: string }) {
  return <section className="info-card member-guide-card section compact"><strong>{actionLabel}にはログインが必要です</strong><p>ログインすると、気になるお店をあとからすぐ見返せます。</p><Link className="primary-button block" to="/login">ログインする</Link></section>;
}

function LoginRequiredPage({ message, next }: { message: string; next: string }) {
  return <main className="page"><Header title="ログインが必要です" backTo="/" /><section className="info-card member-guide-card"><strong>{message}</strong><p>会員登録は無料です。保存一覧、閲覧履歴、レビュー、運営への連絡が使えるようになります。</p><Link className="primary-button block" to={`/login?next=${encodeURIComponent(next)}`}>ログインする</Link><Link className="secondary-button admin-secondary block" to="/signup">新規登録する</Link></section><BottomNav /></main>;
}

 function MemberLoginPage({ member }: { member: ReturnType<typeof useMemberAccount> }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const next = searchParams.get('next') || '/mypage';
  const action = searchParams.get('action');
  const verified = searchParams.get('verified') === '1';
  const [email, setEmail] = useState(member.session.email || '');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState(() => {
    if (verified) return 'パスワード再設定が完了している場合は、登録したメールアドレスと新しいパスワードでログインしてください。';
    return '';
  });
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      setMessage('');
      await member.login(email, password);
      navigate(next, { replace: true });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ログインに失敗しました。');
    } finally {
      setBusy(false);
    }
  };
  return <main className="page admin-login-page"><Header title="ログイン" backTo="/" /><section className="hero-card login-card">{action ? <p className="page-message">{savedLabels[action as SavedKind] ?? 'この操作'}を使うにはログインしてください。</p> : null}<form className="form-stack" onSubmit={submit}><label>メールアドレス<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="member@example.com" /></label><label>パスワード<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="パスワード" /></label><button className="primary-button block" type="submit" disabled={busy}>{busy ? 'ログイン中...' : 'ログイン'}</button></form>{message ? <p className="page-message">{message}</p> : null}<div className="member-link-row"><Link to="/signup">新規登録</Link><Link to="/password-reset">パスワードを忘れた方</Link></div></section></main>;
}

function MemberSignupPage({ member }: { member: ReturnType<typeof useMemberAccount> }) {
  const navigate = useNavigate();
  const [nickname, setNickname] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    try {
      setBusy(true);
      setMessage('');
      await member.signup(email, password, nickname);
      navigate('/mypage', { replace: true });
    } catch (error) {
      setMessage(getErrorMessage(error, '登録に失敗しました。'));
    } finally {
      setBusy(false);
    }
  };
  return <main className="page"><Header title="会員登録" backTo="/login" /><section className="hero-card login-card"><form className="form-stack" onSubmit={submit}><label>ユーザーネーム<input type="text" value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="例：家系ビギナー" autoComplete="nickname" required maxLength={30} /></label><label>メールアドレス<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></label><label>パスワード<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="6文字以上" autoComplete="new-password" required minLength={6} /></label><p className="lead">登録後、そのままマイページを利用できます。ユーザーネームは後からプロフィール編集で変更できます。</p><button className="primary-button block" type="submit" disabled={busy}>{busy ? '登録中...' : '登録する'}</button></form>{message ? <p className="page-message">{message}</p> : null}</section></main>;
}
function PasswordResetPage({ member }: { member: ReturnType<typeof useMemberAccount> }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      setMessage('');
      await member.resetPassword(email);
      setSent(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '送信に失敗しました。');
    } finally {
      setBusy(false);
    }
  };
  return <main className="page"><Header title="パスワード再設定" backTo="/login" /><section className="hero-card login-card"><p className="lead">登録メールアドレスに、再設定用の案内を送ります。</p><form className="form-stack" onSubmit={submit}><label>メールアドレス<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="member@example.com" /></label><button className="primary-button block" type="submit" disabled={busy}>{busy ? '送信中...' : '再設定メールを送る'}</button></form>{sent ? <p className="page-message">送信しました。メールをご確認ください。</p> : null}{message ? <p className="page-message">{message}</p> : null}</section></main>;
}


function PasswordUpdatePage({ member }: { member: ReturnType<typeof useMemberAccount> }) {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmPassword) {
      setMessage('確認用パスワードが一致しません。');
      return;
    }

    try {
      setBusy(true);
      setMessage('');
      await member.updatePassword(password);
      setMessage('パスワードを更新しました。ログイン画面へ移動します。');
      window.setTimeout(() => navigate('/login', { replace: true }), 800);
    } catch (error) {
      setMessage(getErrorMessage(error, 'パスワード更新に失敗しました。再設定メールのリンクを開き直してください。'));
    } finally {
      setBusy(false);
    }
  };

  return <main className="page"><Header title="新しいパスワード" backTo="/login" /><section className="hero-card login-card"><p className="lead">新しいパスワードを入力してください。</p><form className="form-stack" onSubmit={submit}><label>新しいパスワード<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="6文字以上" autoComplete="new-password" required minLength={6} /></label><label>確認用パスワード<input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="もう一度入力" autoComplete="new-password" required minLength={6} /></label><button className="primary-button block" type="submit" disabled={busy}>{busy ? '更新中...' : 'パスワードを更新する'}</button></form>{message ? <p className="page-message">{message}</p> : null}</section></main>;
}

 function MyPage({ member }: { shops: Shop[]; member: ReturnType<typeof useMemberAccount> }) {
  const myReviewCount = member.reviews.filter((review) => review.userId === member.session.userId || (!member.session.userId && review.nickname === member.session.nickname)).length;
  const savedSummary = `行きたい${member.store.want.length}件・行った${member.store.visited.length}件・お気に入り${member.store.favorite.length}件`;
  return <RequireMember member={member}><main className="page"><Header title="マイページ" backTo="/" /><section className="hero-card mypage-profile"><span className="eyebrow">プロフィール</span><strong>{member.session.nickname}</strong><span className="mypage-profile-email">{member.session.email || 'メールアドレス未取得'}</span><Link className="primary-button mypage-profile-edit" to="/mypage/profile">プロフィール編集</Link></section><section className="member-menu-grid section"><MemberMenu to="/mypage/saved" title="保存一覧" desc={savedSummary} /><MemberMenu to="/mypage/history" title="閲覧履歴" desc={`最近見たお店 ${member.store.history.length}件`} /><MemberMenu to="/mypage/reviews" title="投稿したレビュー" desc={`${myReviewCount}件のレビュー`} /><MemberMenu to="/mypage/news" title="お知らせ" desc="運営からの最新情報" /><MemberMenu to="/mypage/submissions" title="提供した店舗情報" desc="承認状況と運営コメントを確認" /><MemberMenu to="/contact" title="問い合わせ" desc="困ったことを運営へ送る" /><MemberMenu to="/shops/new-suggestion" title="新店舗情報提供" desc="未掲載店舗を知らせる" /><MemberMenu to="/withdraw" title="退会" desc="アカウントを削除する" /></section><button className="ghost-button block mypage-logout-button" type="button" onClick={member.logout}>ログアウト</button><BottomNav /></main></RequireMember>;
}

function MemberMenu({ to, title, desc }: { to: string; title: string; desc: string }) { return <Link className="info-card member-menu-card" to={to}><strong>{title}</strong><span>{desc}</span></Link>; }

function ProfileEditPage({ member }: { member: ReturnType<typeof useMemberAccount> }) {
  const navigate = useNavigate();
  const [nickname, setNickname] = useState(member.session.nickname);
  return <RequireMember member={member}><main className="page"><Header title="プロフィール編集" backTo="/mypage" /><form className="form-stack" onSubmit={async (e) => { e.preventDefault(); await member.updateProfile({ nickname }); navigate('/mypage'); }}><label>ユーザーネーム<input value={nickname} onChange={(e) => setNickname(e.target.value)} /></label><button className="primary-button block" type="submit">保存する</button></form><BottomNav /></main></RequireMember>;
}

function SavedListPage({ shops, member }: { shops: Shop[]; member: ReturnType<typeof useMemberAccount> }) {
  const [tab, setTab] = useState<SavedKind>('want');
  const listed = member.store[tab].map((id) => shops.find((shop) => shop.id === id)).filter(Boolean) as Shop[];
  return <RequireMember member={member}><main className="page"><Header title="保存一覧" backTo="/mypage" /><div className="save-tabs">{(Object.keys(savedLabels) as SavedKind[]).map((kind) => <button key={kind} className={tab === kind ? 'is-active' : ''} onClick={() => setTab(kind)}>{savedLabels[kind]}</button>)}</div><ShopMiniList shops={listed} empty={`${savedLabels[tab]}に保存したお店はまだありません。`} /><BottomNav /></main></RequireMember>;
}

function HistoryPage({ shops, member }: { shops: Shop[]; member: ReturnType<typeof useMemberAccount> }) {
  const listed = member.store.history.map((id) => shops.find((shop) => shop.id === id)).filter(Boolean) as Shop[];
  return <RequireMember member={member}><main className="page"><Header title="閲覧履歴" backTo="/mypage" /><div className="section-head"><p className="lead">最近見た店舗を10件まで表示します。</p><button className="small-danger" onClick={member.clearHistory}>削除</button></div><ShopMiniList shops={listed} empty="閲覧履歴はまだありません。" /><BottomNav /></main></RequireMember>;
}

function ShopMiniList({ shops, empty }: { shops: Shop[]; empty: string }) { if (!shops.length) return <p className="empty-text section">{empty}</p>; return <section className="section">{shops.map((shop) => <Link key={shop.id} className="info-card shop-mini-card" to={`/shops/${shop.id}`}><strong>{shop.name}</strong><span>{shop.station || shop.address}</span></Link>)}</section>; }

function MyReviewsPage({ shops, member }: { shops: Shop[]; member: ReturnType<typeof useMemberAccount> }) {
  const myReviews = member.reviews.filter((review) => review.userId === member.session.userId || (!member.session.userId && review.nickname === member.session.nickname));
  return <RequireMember member={member}><main className="page"><Header title="投稿したレビュー" backTo="/mypage" />{myReviews.length ? <section className="section">{myReviews.map((review) => { const shop = shops.find((item) => item.id === review.shopId); return <Link key={review.id} className="info-card review-list-card" to={shop ? `/shops/${shop.id}` : '/shops'}><strong>{shop?.name ?? '店舗情報なし'}</strong><span>{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}{review.hasPhoto ? '・写真あり' : ''}</span><p>{review.comment || 'コメントなし'}</p></Link>; })}</section> : <p className="empty-text section">投稿したレビューはまだありません。</p>}<BottomNav /></main></RequireMember>;
}

function ReviewCard({ review }: { review: { nickname: string; rating: number; comment: string; hasPhoto: boolean; imageUrls?: string[] } }) {
  const [expanded, setExpanded] = useState(false);
  const comment = review.comment || 'コメントなし';
  const shouldClamp = comment.length > 72;

  return (
    <article className={`info-card review-card ${expanded ? 'is-expanded' : ''}`}>
      <strong>{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</strong>
      {review.imageUrls?.length ? <div className="review-image-strip">{review.imageUrls.map((url) => <img key={url} src={url} alt="レビュー画像" />)}</div> : null}
      <p className="review-comment">{comment}</p>
      {shouldClamp ? (
        <button type="button" className="review-more-button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? '閉じる' : 'もっと見る'}
        </button>
      ) : null}
      {review.hasPhoto ? <span>写真あり</span> : null}
    </article>
  );
}

function ReviewPage({ shops, member }: { shops: Shop[]; member: ReturnType<typeof useMemberAccount> }) {
  const { shopId } = useParams();
  const shop = shops.find((item) => item.id === shopId);
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!shop) return;
    try {
      setBusy(true);
      setMessage('');
      await member.submitReview(shop.id, rating, comment, file);
      setDone(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'レビュー投稿に失敗しました。');
    } finally {
      setBusy(false);
    }
  };
  return <RequireMember member={member} message="レビューを書くにはログインが必要です。"><main className="page"><Header title="レビューを書く" backTo={shop ? `/shops/${shop.id}` : '/shops'} /><section className="hero-card"><h2>{shop?.name ?? '店舗'}</h2><p className="lead">★評価は必須、コメントと写真は任意です。</p></section><form className="form-stack section" onSubmit={submit}><label>★評価<select value={rating} onChange={(e) => setRating(Number(e.target.value))}><option value={5}>★★★★★ 5</option><option value={4}>★★★★☆ 4</option><option value={3}>★★★☆☆ 3</option><option value={2}>★★☆☆☆ 2</option><option value={1}>★☆☆☆☆ 1</option></select></label><label>コメント<textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="味・雰囲気・行きやすさなど" /></label><label>写真<input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label><button className="primary-button block" disabled={busy}>{busy ? '投稿中...' : '投稿する'}</button></form>{done ? <p className="page-message">レビューを投稿しました。</p> : null}{message ? <p className="page-message">{message}</p> : null}<BottomNav /></main></RequireMember>;
}


function MySubmissionsPage({ member }: { member: ReturnType<typeof useMemberAccount> }) {
  const [items, setItems] = useState<ShopSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    if (!member.session.userId) return;
    try {
      setLoading(true);
      setMessage('');
      setItems(await listMyShopSubmissions(member.session.userId));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '提供した店舗情報の取得に失敗しました。');
    } finally {
      setLoading(false);
    }
  }, [member.session.userId]);

  useEffect(() => { void load(); }, [load]);

  const statusLabel = (value: ShopSubmissionStatus) => value === 'approved' ? '承認' : value === 'rejected' ? '否認' : '確認中';
  const typeLabel = (value: ShopSubmission['submissionType']) => value === 'update' ? '店舗情報の修正' : '新店舗情報の提供';

  return (
    <RequireMember member={member}>
      <main className="page">
        <Header title="提供した店舗情報" backTo="/mypage" />
        <section className="hero-card">
          <span className="eyebrow">あなたの投稿</span>
          <h2>承認状況を確認できます</h2>
          <p className="lead">承認・否認後も一覧に残ります。否認された場合は、運営からの理由もここに表示されます。</p>
        </section>
        {message ? <p className="page-message">{message}</p> : null}
        <section className="section compact">
          {loading ? <p>読み込み中です...</p> : null}
          {!loading && items.length === 0 ? <p className="empty-text">提供した店舗情報はまだありません。</p> : null}
          {!loading && items.map((item) => (
            <Link key={item.id} className="info-card review-list-card" to={`/mypage/submissions/${item.id}`}>
              <strong>{item.name || '店舗名未入力'}</strong>
              <span>情報提供の種類: {typeLabel(item.submissionType)}</span>
              <span>ステータス: {statusLabel(item.status)}</span>
              {item.status !== 'pending' && item.adminReason ? <p><strong>運営コメント：</strong>{item.adminReason}</p> : null}
              <p className="csv-help">送信日時: {new Date(item.createdAt).toLocaleString('ja-JP')}</p>
            </Link>
          ))}
        </section>
        <BottomNav />
      </main>
    </RequireMember>
  );
}

function MySubmissionDetailPage({ member }: { member: ReturnType<typeof useMemberAccount> }) {
  const { submissionId } = useParams();
  const [submission, setSubmission] = useState<ShopSubmission | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!submissionId) return;
      try {
        setLoading(true);
        setMessage('');
        const item = await getShopSubmission(submissionId);
        if (!active) return;
        if (item.userId !== member.session.userId) {
          setSubmission(null);
          setMessage('この情報提供は表示できません。');
          return;
        }
        setSubmission(item);
      } catch (err) {
        if (active) setMessage(err instanceof Error ? err.message : '提供した店舗情報の取得に失敗しました。');
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [member.session.userId, submissionId]);

  const statusLabel = (value: ShopSubmissionStatus) => value === 'approved' ? '承認' : value === 'rejected' ? '否認' : '確認中';
  const typeLabel = (value: ShopSubmission['submissionType']) => value === 'update' ? '店舗情報の修正' : '新店舗情報の提供';
  const formatParking = (value: boolean | null) => value === null ? '' : value ? 'あり' : 'なし';
  const rows = submission ? [
    ['店舗名', submission.name],
    ['情報提供の種類', typeLabel(submission.submissionType)],
    ['ステータス', statusLabel(submission.status)],
    ['送信日時', new Date(submission.createdAt).toLocaleString('ja-JP')],
    ['住所', submission.address],
    ['分類', submission.tag],
    ['最寄駅', submission.station],
    ['営業時間', submission.hours],
    ['定休日', submission.holiday],
    ['電話番号', submission.phone],
    ['席数', submission.seats],
    ['駐車場', formatParking(submission.parking)],
    ['公式URL', submission.officialUrl],
    ['公式SNS', submission.officialAccount],
    ['画像URL', submission.image],
    ['源流', submission.origin],
    ['系譜', submission.genealogy],
    ['補足', submission.memo],
  ] : [];

  return (
    <RequireMember member={member}>
      <main className="page">
        <Header title="提供した店舗情報" backTo="/mypage/submissions" />
        {loading ? <section className="section compact"><p>読み込み中です...</p></section> : null}
        {message ? <p className="page-message">{message}</p> : null}
        {submission ? (
          <section className="section compact info-card submission-detail-card">
            {rows.filter(([, value]) => String(value ?? '').trim()).map(([label, value]) => (
              <div key={label} className="submission-detail-row">
                <strong>{label}</strong>
                <span>{value}</span>
              </div>
            ))}
            {submission.status !== 'pending' && submission.adminReason ? (
              <div className="submission-detail-row">
                <strong>運営コメント</strong>
                <span>{submission.adminReason}</span>
              </div>
            ) : null}
          </section>
        ) : null}
        <BottomNav />
      </main>
    </RequireMember>
  );
}

function NewsListPage({ member }: { member: ReturnType<typeof useMemberAccount> }) { return <main className="page"><Header title="お知らせ" backTo="/mypage" /><section className="section">{member.news.map((news) => <Link key={news.id} className="info-card member-menu-card" to={`/mypage/news/${news.id}`}><strong>{news.title}</strong><span>{news.date}</span></Link>)}</section><BottomNav /></main>; }

function NewsDetailPage({ member }: { member: ReturnType<typeof useMemberAccount> }) { const { newsId } = useParams(); const news = member.news.find((item) => item.id === newsId) ?? member.news[0] ?? sampleNews[0]; return <main className="page"><Header title="お知らせ詳細" backTo="/mypage/news" /><section className="hero-card"><p className="eyebrow">{news.date}</p><h2>{news.title}</h2><p className="lead">{news.body}</p></section><BottomNav /></main>; }

function ContactPage({ member, notification }: { member: ReturnType<typeof useMemberAccount>; notification: SupportNotificationSettings }) {
  return <SupportForm member={member} notification={notification} title="問い合わせ" backTo="/mypage" fields={<><label>種別<select name="category"><option>店舗情報について</option><option>アプリの使い方</option><option>その他</option></select></label><label>件名<input name="subject" placeholder="例：表示内容について" /></label><label>内容<textarea name="body" placeholder="困っていることや確認したいことを書いてください" /></label></>} />;
}

type NewShopSuggestionFormState = {
  name: string;
  tag: Tag;
  address: string;
  station: string;
  hours: string;
  holiday: string;
  parking: '' | 'true' | 'false';
  officialUrl: string;
  origin: string;
  genealogy: string;
  informationSource: string;
};

const defaultNewShopSuggestionForm: NewShopSuggestionFormState = {
  name: '',
  tag: '独立系',
  address: '',
  station: '',
  hours: '',
  holiday: '',
  parking: '',
  officialUrl: '',
  origin: '',
  genealogy: '',
  informationSource: '',
};

function NewShopSuggestionPage({ member }: { member: ReturnType<typeof useMemberAccount>; notification: SupportNotificationSettings }) {
  const [form, setForm] = useState<NewShopSuggestionFormState>(defaultNewShopSuggestionForm);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const navigate = useNavigate();

  const canSubmit = form.name.trim().length > 0 && form.tag.trim().length > 0 && form.address.trim().length > 0;

  const updateForm = (key: keyof NewShopSuggestionFormState, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit || busy) return;

    try {
      setBusy(true);
      setMessage('');
      const uploadedImageUrl = imageFile ? await uploadShopSubmissionImage(member.session.userId, imageFile) : '';
      await createNewShopSubmission({
        userId: member.session.userId,
        name: form.name,
        tag: form.tag,
        address: form.address,
        station: form.station,
        hours: form.hours,
        holiday: form.holiday,
        parking: form.parking === '' ? null : form.parking === 'true',
        officialUrl: form.officialUrl,
        image: uploadedImageUrl,
        origin: form.origin,
        genealogy: form.genealogy,
        informationSource: form.informationSource,
      });
      setForm(defaultNewShopSuggestionForm);
      setImageFile(null);
      navigate('/mypage/submissions', { replace: true });
    } catch (err) {
      setMessage(getErrorMessage(err, '送信に失敗しました。時間をおいて再度お試しください。'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <RequireMember member={member} message="新店舗情報提供にはログインが必要です。">
      <main className="page">
        <Header title="新店舗情報提供" backTo="/mypage" />
        <form className="form-stack section compact" onSubmit={submit}>
          <label>店舗名 <span className="required-badge">必須</span><input value={form.name} onChange={(e) => updateForm('name', e.target.value)} placeholder="例：家系ラーメン 〇〇家" required /></label>
          <label>分類 <span className="required-badge">必須</span><select value={form.tag} onChange={(e) => updateForm('tag', e.target.value)}>{tags.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>住所 <span className="required-badge">必須</span><input value={form.address} onChange={(e) => updateForm('address', e.target.value)} placeholder="例：神奈川県横浜市..." required /></label>
          <label>最寄駅<input value={form.station} onChange={(e) => updateForm('station', e.target.value)} placeholder="例：横浜駅" /></label>
          <label>営業時間<textarea value={form.hours} onChange={(e) => updateForm('hours', e.target.value)} placeholder="例：11:00〜15:00 / 17:00〜22:00" /></label>
          <label>定休日<input value={form.holiday} onChange={(e) => updateForm('holiday', e.target.value)} placeholder="例：月曜日" /></label>
          <label>駐車場<select value={form.parking} onChange={(e) => updateForm('parking', e.target.value)}><option value="">不明</option><option value="true">あり</option><option value="false">なし</option></select></label>
          <label>公式URL<input value={form.officialUrl} onChange={(e) => updateForm('officialUrl', e.target.value)} placeholder="https://..." inputMode="url" /></label>
          <label>画像アップロード<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} /></label>
          {imageFile ? <p className="form-hint">選択中: {imageFile.name}</p> : null}
          <label>源流<input value={form.origin} onChange={(e) => updateForm('origin', e.target.value)} placeholder="例：吉村家系。わからなければ空欄でOK" /></label>
          <label>系譜<input value={form.genealogy} onChange={(e) => updateForm('genealogy', e.target.value)} placeholder="例：吉村家 → ○○家。わからなければ空欄でOK" /></label>
          <label>情報ソース<textarea value={form.informationSource} onChange={(e) => updateForm('informationSource', e.target.value)} placeholder="例：公式サイト、店舗掲示、SNS投稿など" /></label>
          {!canSubmit ? <p className="form-hint">店舗名・分類・住所を入力すると送信できます。</p> : null}
          <div className="action-row">
            <button className="primary-button block" type="submit" disabled={!canSubmit || busy}>{busy ? '送信中...' : '送信する'}</button>
            <button className="secondary-button block admin-secondary" type="button" onClick={() => navigate('/mypage')} disabled={busy}>戻る</button>
          </div>
        </form>
        {message ? <p className="page-message">{message}</p> : null}
        <BottomNav />
      </main>
    </RequireMember>
  );
}

type ShopCorrectionFormState = {
  name: string;
  tag: '' | Tag;
  address: string;
  station: string;
  hours: string;
  holiday: string;
  phone: string;
  seats: string;
  parking: '' | 'true' | 'false';
  officialUrl: string;
  officialAccount: string;
  origin: string;
  genealogy: string;
  memo: string;
  informationSource: string;
};

const defaultShopCorrectionForm: ShopCorrectionFormState = {
  name: '',
  tag: '',
  address: '',
  station: '',
  hours: '',
  holiday: '',
  phone: '',
  seats: '',
  parking: '',
  officialUrl: '',
  officialAccount: '',
  origin: '',
  genealogy: '',
  memo: '',
  informationSource: '',
};

function ShopCorrectionPage({ shops, member }: { shops: Shop[]; member: ReturnType<typeof useMemberAccount>; notification: SupportNotificationSettings }) {
  const { shopId } = useParams();
  const shop = shops.find((item) => item.id === shopId);
  const [form, setForm] = useState<ShopCorrectionFormState>(defaultShopCorrectionForm);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const navigate = useNavigate();

  const canSubmit = Object.values(form).some((value) => value.trim().length > 0) || Boolean(imageFile);

  const updateForm = (key: keyof ShopCorrectionFormState, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!shop || !canSubmit || busy) return;

    try {
      setBusy(true);
      setMessage('');
      const uploadedImageUrl = imageFile ? await uploadShopSubmissionImage(member.session.userId, imageFile) : '';
      await createUpdateShopSubmission({
        userId: member.session.userId,
        targetShopId: shop.id,
        name: form.name.trim() || shop.name,
        tag: form.tag || shop.tag,
        address: form.address.trim() || shop.address || '住所未確認',
        station: form.station,
        hours: form.hours,
        holiday: form.holiday,
        phone: form.phone,
        seats: form.seats,
        parking: form.parking === '' ? null : form.parking === 'true',
        officialUrl: form.officialUrl,
        officialAccount: form.officialAccount,
        image: uploadedImageUrl,
        origin: form.origin,
        genealogy: form.genealogy,
        memo: form.memo,
        informationSource: form.informationSource,
      });
      setForm(defaultShopCorrectionForm);
      setImageFile(null);
      navigate('/mypage/submissions', { replace: true });
    } catch (err) {
      setMessage(getErrorMessage(err, '送信に失敗しました。時間をおいて再度お試しください。'));
    } finally {
      setBusy(false);
    }
  };

  if (!shop) {
    return <main className="page"><Header title="店舗情報の修正提案" backTo="/shops" /><p className="empty-text section">対象店舗が見つかりません。</p><BottomNav /></main>;
  }

  return (
    <RequireMember member={member} message="店舗情報の修正提案にはログインが必要です。">
      <main className="page">
        <Header title="店舗情報の修正提案" backTo={`/shops/${shop.id}`} />
        <section className="info-card section compact">
          <strong>{shop.name}</strong>
          <p>修正したい項目だけ入力してください</p>
        </section>
        <form className="form-stack section compact" onSubmit={submit}>
          <label>店名<input value={form.name} onChange={(e) => updateForm('name', e.target.value)} placeholder={shop.name} /></label>
          <label>分類<select value={form.tag} onChange={(e) => updateForm('tag', e.target.value)}><option value="">変更なし（{shop.tag}）</option>{tags.map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>住所<input value={form.address} onChange={(e) => updateForm('address', e.target.value)} placeholder={shop.address || '例：神奈川県横浜市...'} /></label>
          <label>最寄駅<input value={form.station} onChange={(e) => updateForm('station', e.target.value)} placeholder={shop.station || '例：横浜駅'} /></label>
          <label>営業時間<textarea value={form.hours} onChange={(e) => updateForm('hours', e.target.value)} placeholder={shop.hours || '例：11:00〜15:00 / 17:00〜22:00'} /></label>
          <label>定休日<input value={form.holiday} onChange={(e) => updateForm('holiday', e.target.value)} placeholder={shop.holiday || '例：月曜日'} /></label>
          <label>電話番号<input value={form.phone} onChange={(e) => updateForm('phone', e.target.value)} placeholder={shop.phone || '例：045-000-0000'} inputMode="tel" /></label>
          <label>席数<input value={form.seats} onChange={(e) => updateForm('seats', e.target.value)} placeholder={shop.seats || '例：カウンター10席'} /></label>
          <label>駐車場<select value={form.parking} onChange={(e) => updateForm('parking', e.target.value)}><option value="">変更なし（{shop.parking ? 'あり' : 'なし'}）</option><option value="true">あり</option><option value="false">なし</option></select></label>
          <label>公式URL<input value={form.officialUrl} onChange={(e) => updateForm('officialUrl', e.target.value)} placeholder={shop.officialUrl || 'https://...'} inputMode="url" /></label>
          <label>公式SNS<input value={form.officialAccount} onChange={(e) => updateForm('officialAccount', e.target.value)} placeholder={shop.officialAccount || 'X / Instagram など'} /></label>
          <label>画像アップロード<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} /></label>
          {imageFile ? <p className="form-hint">選択中: {imageFile.name}</p> : null}
          <label>源流<input value={form.origin} onChange={(e) => updateForm('origin', e.target.value)} placeholder={shop.origin || '例：吉村家系'} /></label>
          <label>系譜<input value={form.genealogy} onChange={(e) => updateForm('genealogy', e.target.value)} placeholder={shop.genealogy || '例：吉村家 → ○○家'} /></label>
          <label>情報ソース<textarea value={form.informationSource} onChange={(e) => updateForm('informationSource', e.target.value)} placeholder="例：公式サイト、店舗掲示、SNS投稿など" /></label>
          <label>補足<textarea value={form.memo} onChange={(e) => updateForm('memo', e.target.value)} placeholder="補足、気づいたことなど" /></label>
          {!canSubmit ? <p className="form-hint">修正したい項目を1つ以上入力すると送信できます。</p> : null}
          <div className="action-row">
            <button className="primary-button block" type="submit" disabled={!canSubmit || busy}>{busy ? '送信中...' : '送信する'}</button>
            <button className="secondary-button block admin-secondary" type="button" onClick={() => navigate(`/shops/${shop.id}`)} disabled={busy}>戻る</button>
          </div>
        </form>
        {message ? <p className="page-message">{message}</p> : null}
        <BottomNav />
      </main>
    </RequireMember>
  );
}

function SupportForm({ member, notification, title, backTo, fields, intro, canSubmit = true, disabledMessage }: { member: ReturnType<typeof useMemberAccount>; notification: SupportNotificationSettings; title: string; backTo: string; fields: ReactNode; intro?: string; canSubmit?: boolean; disabledMessage?: string }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    setDone(false);
    setMessage('');
    const form = event.currentTarget;
    const payload = {
      種別: title,
      送信者: member.session.email || '未取得',
      ...collectFormPayload(form),
    };
    try {
      await sendSupportMail(title, payload, notification);
      appendSupportSubmission(payload);
      setDone(true);
      form.reset();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '送信に失敗しました。時間をおいて再度お試しください。');
    } finally {
      setBusy(false);
    }
  };

  return <RequireMember member={member} message={`${title}にはログインが必要です。`}><main className="page"><Header title={title} backTo={backTo} />{intro ? <section className="info-card section compact"><p>{intro}</p></section> : null}<form className="form-stack" onSubmit={submit}>{fields}{!canSubmit && disabledMessage ? <p className="form-hint">{disabledMessage}</p> : null}<button className="primary-button block" disabled={!canSubmit || busy}>{busy ? '送信中...' : '送信する'}</button></form>{done ? <section className="page-message"><p>送信しました。運営からの返信をお待ちください。</p></section> : null}{message ? <p className="page-message">{message}</p> : null}<BottomNav /></main></RequireMember>;
}

function WithdrawPage({ member }: { member: ReturnType<typeof useMemberAccount> }) {
  const navigate = useNavigate();
  return <RequireMember member={member}><main className="page"><Header title="退会確認" backTo="/mypage" /><section className="hero-card login-card"><h2>退会しますか？</h2><p className="lead">保存一覧、閲覧履歴、レビュー情報が使えなくなります。</p><button className="small-danger block" onClick={async () => { await member.withdraw(); navigate('/'); }}>退会する</button></section><BottomNav /></main></RequireMember>;
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

function AdminTopPage({ shops }: { shops: Shop[]; notification: SupportNotificationSettings; onSaveNotification: (next: SupportNotificationSettings) => void }) {
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
    navigate('/admin-8fj3k2-3me77nfcb6c0/login', { replace: true });
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
        <Link className="primary-button block" to="/admin-8fj3k2-3me77nfcb6c0/submissions">店舗情報提供の確認へ</Link>
        <Link className="primary-button block" to="/admin-8fj3k2-3me77nfcb6c0/shops">店舗一覧へ</Link>
        <Link className="primary-button block" to="/admin-8fj3k2-3me77nfcb6c0/shops/new">店舗登録へ</Link>
      </section>
      <section className="section compact">
        <button className="ghost-button block" onClick={logout}>ログアウト</button>
      </section>
    </main>
  );
}


function AdminSubmissionsPage() {
  const [items, setItems] = useState<ShopSubmission[]>([]);
  const [status, setStatus] = useState<ShopSubmissionStatus | 'all'>('pending');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setMessage('');
      setItems(await listShopSubmissions(status));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '店舗情報提供の取得に失敗しました。');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  const statusLabel = (value: ShopSubmissionStatus) => value === 'approved' ? '承認済み' : value === 'rejected' ? '否認' : '確認待ち';
  const typeLabel = (value: ShopSubmission['submissionType']) => value === 'update' ? '既存店舗の修正' : '新規店舗提供';

  return (
    <main className="page">
      <Header title="管理画面: 店舗情報提供" backTo="/admin-8fj3k2-3me77nfcb6c0" />
      <section className="section compact info-card form-stack">
        <label>表示する状態<select value={status} onChange={(event) => setStatus(event.target.value as ShopSubmissionStatus | 'all')}><option value="pending">確認待ち</option><option value="approved">承認済み</option><option value="rejected">否認</option><option value="all">すべて</option></select></label>
        <span>{loading ? '読み込み中' : `${items.length}件を表示中`}</span>
        <button type="button" className="secondary-button block admin-secondary" onClick={() => void load()} disabled={loading}>再読み込み</button>
      </section>
      {message ? <p className="page-message">{message}</p> : null}
      <section className="section compact">
        {loading ? <p>読み込み中です...</p> : items.map((item) => (
          <article key={item.id} className="admin-row">
            <div>
              <strong>{item.name || '店舗名未入力'}</strong>
              <p>{typeLabel(item.submissionType)} / {statusLabel(item.status)}</p>
              <p>{item.address || '住所未入力'}</p>
              {item.informationSource ? <p>情報ソース: {item.informationSource}</p> : null}
              <p className="csv-help">投稿日時: {new Date(item.createdAt).toLocaleString('ja-JP')}</p>
            </div>
            <div className="row-actions"><Link className="primary-button small" to={`/admin-8fj3k2-3me77nfcb6c0/submissions/${item.id}`}>確認</Link></div>
          </article>
        ))}
        {!loading && items.length === 0 ? <p className="empty-text">対象の店舗情報提供はありません。</p> : null}
      </section>
    </main>
  );
}

function buildSubmissionDraftInput(item: ShopSubmission | null): ShopSubmissionDraftInput & { adminReason: string } {
  return {
    name: item?.name ?? '',
    tag: item?.tag ?? '独立系',
    address: item?.address ?? '',
    station: item?.station ?? '',
    hours: item?.hours ?? '',
    holiday: item?.holiday ?? '',
    seats: item?.seats ?? '',
    parking: item?.parking ?? null,
    officialUrl: item?.officialUrl ?? '',
    lat: item?.lat ?? null,
    lng: item?.lng ?? null,
    image: item?.image ?? '',
    memo: item?.memo ?? '',
    origin: item?.origin ?? '',
    genealogy: item?.genealogy ?? '',
    phone: item?.phone ?? '',
    officialAccount: item?.officialAccount ?? '',
    parentId: item?.parentId ?? null,
    nodoId: item?.nodoId ?? null,
    isClosed: item?.isClosed ?? false,
    nodeName: item?.nodeName ?? '',
    adminReason: item?.adminReason ?? '',
  };
}

function AdminSubmissionDetailPage() {
  const { submissionId } = useParams();
  const [submission, setSubmission] = useState<ShopSubmission | null>(null);
  const [form, setForm] = useState<ShopSubmissionDraftInput & { adminReason: string }>(buildSubmissionDraftInput(null));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    if (!submissionId) return;
    try {
      setLoading(true);
      setMessage('');
      const row = await getShopSubmission(submissionId);
      setSubmission(row);
      setForm(buildSubmissionDraftInput(row));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '店舗情報提供の取得に失敗しました。');
    } finally {
      setLoading(false);
    }
  }, [submissionId]);

  useEffect(() => { void load(); }, [load]);

  const handleChange = (key: keyof (ShopSubmissionDraftInput & { adminReason: string }), value: string | boolean | number | null) => setForm((current) => ({ ...current, [key]: value }));
  const saveDraft = async () => { if (submissionId) await updateShopSubmissionDraft(submissionId, form); };

  const handleSave = async () => {
    try {
      setBusy(true);
      setMessage('');
      await saveDraft();
      setMessage('入力内容を保存しました。');
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '保存に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleReview = async (nextStatus: 'approved' | 'rejected') => {
    if (!submissionId) return;
    if (nextStatus === 'rejected' && !form.adminReason.trim()) {
      setMessage('否認する場合は、ユーザーに表示する理由を入力してください。');
      return;
    }
    if (!window.confirm(nextStatus === 'approved' ? 'この内容で承認しますか？' : 'この内容で否認しますか？')) return;
    try {
      setBusy(true);
      setMessage('');
      await saveDraft();
      await getAdminAuthState().catch(() => null);
      await reviewShopSubmission(submissionId, nextStatus, form.adminReason, null);
      setMessage(nextStatus === 'approved' ? '承認しました。本番DBへ反映する場合は「本番DBへ反映」を押してください。' : '否認しました。理由はユーザーのマイページに表示されます。');
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '審査結果の保存に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  const handleImportToShops = async () => {
    if (!submissionId) return;
    const actionLabel = submission?.submissionType === 'update' ? '既存店舗へ反映' : '新規店舗として追加';
    if (!window.confirm(`${actionLabel}します。よろしいですか？`)) return;
    try {
      setBusy(true);
      setMessage('');
      await saveDraft();
      const shopId = await importApprovedSubmissionToShops(submissionId);
      setMessage(`本番DBへ反映しました。店舗ID: ${shopId}`);
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '本番DBへの反映に失敗しました。');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <main className="page"><Header title="店舗情報提供を確認中" backTo="/admin-8fj3k2-3me77nfcb6c0/submissions" /><section className="section compact"><p>読み込み中です...</p></section></main>;
  if (!submission) return <main className="page"><Header title="店舗情報提供" backTo="/admin-8fj3k2-3me77nfcb6c0/submissions" /><section className="section compact"><p>対象データが見つかりません。</p></section></main>;

  return (
    <main className="page">
      <Header title="管理画面: 提供内容確認" backTo="/admin-8fj3k2-3me77nfcb6c0/submissions" />
      <section className="section compact info-card">
        <strong>{submission.submissionType === 'update' ? '既存店舗の修正' : '新規店舗提供'}</strong>
        <span>現在の状態: {submission.status}</span>
        {submission.targetShopId ? <span>修正対象店舗ID: {submission.targetShopId}</span> : null}
        {submission.informationSource ? <span>情報ソース: {submission.informationSource}</span> : null}
        {submission.importedAt ? <span>本番DB反映済み: {new Date(submission.importedAt).toLocaleString('ja-JP')}</span> : null}
        {submission.importedShopId ? <span>反映先店舗ID: {submission.importedShopId}</span> : null}
      </section>
      {message ? <p className="page-message">{message}</p> : null}
      <form className="section compact form-stack" onSubmit={(event) => event.preventDefault()}>
        <label>店舗名<input value={form.name} onChange={(e) => handleChange('name', e.target.value)} /></label>
        <label>タグ<select value={form.tag} onChange={(e) => handleChange('tag', e.target.value as Tag)}>{tags.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>住所<input value={form.address} onChange={(e) => handleChange('address', e.target.value)} /></label>
        <label>最寄駅<input value={form.station ?? ''} onChange={(e) => handleChange('station', e.target.value)} /></label>
        <label>営業時間<textarea value={form.hours ?? ''} onChange={(e) => handleChange('hours', e.target.value)} rows={4} /></label>
        <label>定休日<input value={form.holiday ?? ''} onChange={(e) => handleChange('holiday', e.target.value)} /></label>
        <label>席数<input value={form.seats ?? ''} onChange={(e) => handleChange('seats', e.target.value)} /></label>
        <label>駐車場<select value={form.parking === null || form.parking === undefined ? '' : (form.parking ? 'true' : 'false')} onChange={(e) => handleChange('parking', e.target.value === '' ? null : e.target.value === 'true')}><option value="">未確認</option><option value="true">あり</option><option value="false">なし</option></select></label>
        <label>公式URL<input value={form.officialUrl ?? ''} onChange={(e) => handleChange('officialUrl', e.target.value)} /></label>
        <label>画像URL<input value={form.image ?? ''} onChange={(e) => handleChange('image', e.target.value)} /></label>
        <label>源流<input value={form.origin ?? ''} onChange={(e) => handleChange('origin', e.target.value)} /></label>
        <label>系譜<textarea value={form.genealogy ?? ''} onChange={(e) => handleChange('genealogy', e.target.value)} rows={3} /></label>
        <label>電話番号<input value={form.phone ?? ''} onChange={(e) => handleChange('phone', e.target.value)} /></label>
        <label>公式SNS<input value={form.officialAccount ?? ''} onChange={(e) => handleChange('officialAccount', e.target.value)} /></label>
        <label>緯度 lat<input type="number" step="0.000001" value={form.lat ?? ''} onChange={(e) => handleChange('lat', e.target.value === '' ? null : Number(e.target.value))} /></label>
        <label>経度 lng<input type="number" step="0.000001" value={form.lng ?? ''} onChange={(e) => handleChange('lng', e.target.value === '' ? null : Number(e.target.value))} /></label>
        <label>親店舗ID<input value={form.parentId ?? ''} onChange={(e) => handleChange('parentId', e.target.value || null)} /></label>
        <label>ノードID<input value={form.nodoId ?? ''} onChange={(e) => handleChange('nodoId', e.target.value || null)} /></label>
        <label>ノード名<input value={form.nodeName ?? ''} onChange={(e) => handleChange('nodeName', e.target.value)} /></label>
        <label className="checkbox-line"><input type="checkbox" checked={Boolean(form.isClosed)} onChange={(e) => handleChange('isClosed', e.target.checked)} />閉店済み</label>
        <label>管理メモ<textarea value={form.memo ?? ''} onChange={(e) => handleChange('memo', e.target.value)} rows={3} /></label>
        <label>ユーザーに表示する理由・コメント<textarea value={form.adminReason} onChange={(e) => handleChange('adminReason', e.target.value)} rows={4} placeholder="否認時は必須。承認時の補足にも使えます。" /></label>
        <div className="action-row">
          <button type="button" className="secondary-button block admin-secondary" onClick={() => void handleSave()} disabled={busy}>{busy ? '保存中...' : '下書き保存'}</button>
          <button type="button" className="primary-button block" onClick={() => void handleReview('approved')} disabled={busy}>承認する</button>
          <button type="button" className="ghost-button small-danger" onClick={() => void handleReview('rejected')} disabled={busy}>否認する</button>
          {submission.status === 'approved' && !submission.importedAt ? <button type="button" className="primary-button block" onClick={() => void handleImportToShops()} disabled={busy}>{submission.submissionType === 'update' ? '本番DBへ反映' : '本番DBへ追加'}</button> : null}
          {submission.importedAt ? <span className="page-message">本番DBへ反映済みです。</span> : null}
        </div>
      </form>
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
              <Link className="primary-button small" to={`/admin-8fj3k2-3me77nfcb6c0/shops/${shop.id}`}>編集</Link>
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
      navigate('/admin-8fj3k2-3me77nfcb6c0/shops', { replace: true });
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
      <Header title="管理画面: 店舗登録・編集" backTo="/admin-8fj3k2-3me77nfcb6c0/shops" />
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
          <button type="button" className="secondary-button block admin-secondary" onClick={() => navigate('/admin-8fj3k2-3me77nfcb6c0/shops')} disabled={busy}>一覧へ戻る</button>
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
    <nav className={`bottom-nav four-col ${className}`.trim()}>
      <Link to="/">トップ</Link>
      <Link to="/map">マップ</Link>
      <Link to="/genealogy">系譜図</Link>
      <Link to="/mypage">マイページ</Link>
    </nav>
  );
}
