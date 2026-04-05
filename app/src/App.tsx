import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
};

type MapEntrySource = 'home' | 'searchResults' | 'detail';

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
    const hitKeyword = shopMatchesKeyword(shop, filters.q);
    const hitOrigin = !filters.origin || shop.origin === filters.origin;
    const hitTag = !filters.tag || shop.tag === filters.tag;
    const hitParking = filters.parking === null || shop.parking === filters.parking;
    return hitKeyword && hitOrigin && hitTag && hitParking;
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
  };
}

function buildSearchParams(filters: SearchFilters) {
  const next = new URLSearchParams();
  if (filters.q.trim()) next.set('q', filters.q.trim());
  if (filters.origin) next.set('origin', filters.origin);
  if (filters.tag) next.set('tag', filters.tag);
  if (filters.parking !== null) next.set('parking', String(filters.parking));
  return next;
}

function buildSearchUrl(filters: SearchFilters) {
  const query = buildSearchParams(filters).toString();
  return `/shops${query ? `?${query}` : ''}`;
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
        <Route path="/shops/:shopId" element={<ShopDetailPage shops={shopState.shops} />} />
        <Route path="/areas" element={<Navigate to="/shops" replace />} />
        <Route path="/admin/login" element={<AdminLoginPage />} />
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
  const location = useLocation();
  const locationState = (location.state as { backTo?: string; backState?: Record<string, unknown> } | null) ?? null;
  const resolvedBackTo = backTo ?? locationState?.backTo;
  const resolvedBackState = backState ?? locationState?.backState;

  return (
    <header className={`page-header ${className}`.trim()}>
      <div>
        {resolvedBackTo ? <Link to={resolvedBackTo} state={resolvedBackState} className="back-link">{backLabel}</Link> : <span className="eyebrow">{eyebrow}</span>}
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
          <div className="search-box home-search-box">
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="店名 / 住所 / 最寄り駅で検索"
          />
          <button className="primary-button" onClick={() => navigate(`/shops?q=${encodeURIComponent(keyword)}`)}>検索</button>
          </div>
          <div className="cta-grid single-grid home-cta-grid">
            <Link className="primary-button block" to="/map" state={{ autoLocate: true }}>近くで探す</Link>
          </div>
        </div>
      </section>
      <BottomNav />
    </main>
  );
}

function ShopSearchPage({ shops, loading }: { shops: Shop[]; loading: boolean }) {
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
      <Header title="検索結果" backTo="/" />
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
  const locationState = (location.state as { backTo?: string; backState?: Record<string, unknown>; autoLocate?: boolean; entrySource?: MapEntrySource } | null) ?? null;
  const initialEntrySource: MapEntrySource = locationState?.entrySource ?? (locationState?.backTo?.startsWith('/shops') ? 'searchResults' : 'home');
  const [entrySource, setEntrySource] = useState<MapEntrySource>(initialEntrySource);
  const [hasMapSearched, setHasMapSearched] = useState(false);
  const [selectedShopId, setSelectedShopId] = useState(initialSelected);
  const [searchText, setSearchText] = useState(initialFilters.q);
  const [activeFilters, setActiveFilters] = useState<SearchFilters>(initialFilters);
  const [draftFilters, setDraftFilters] = useState<SearchFilters>(initialFilters);
  const [expanded, setExpanded] = useState(initialEntrySource === 'searchResults' && !!(initialFilters.q || initialFilters.origin || initialFilters.tag || initialFilters.parking !== null));
  const [visibleShops, setVisibleShops] = useState<Shop[]>(() => ids.length ? shops.filter((shop) => ids.includes(shop.id)) : filterShops(shops, initialFilters));
  const [mapCenter, setMapCenter] = useState<[number, number]>(defaultCenter);
  const [mapZoom, setMapZoom] = useState(12);
  const [fitToShops, setFitToShops] = useState<boolean>(() => !ids.length);
  const [userPosition, setUserPosition] = useState<[number, number] | null>(null);
  const [searchMessage, setSearchMessage] = useState('');
  const [isOsmSearching, setIsOsmSearching] = useState(false);
  const lastOsmRequestAtRef = useRef(0);

  useEffect(() => {
    setEntrySource(initialEntrySource);
  }, [initialEntrySource]);

  useEffect(() => {
    setSelectedShopId(initialSelected);
  }, [initialSelected]);

  useEffect(() => {
    setSearchText(initialFilters.q);
    setActiveFilters(initialFilters);
    setDraftFilters(initialFilters);
    if (ids.length) {
      setVisibleShops(shops.filter((shop) => ids.includes(shop.id)));
      setFitToShops(false);
    } else {
      const nextVisible = filterShops(shops, initialFilters);
      setVisibleShops(nextVisible);
      setFitToShops(true);
    }
    setSearchMessage('');
  }, [ids, initialFilters, shops]);

  useEffect(() => {
    if (selectedShopId && !visibleShops.some((shop) => shop.id === selectedShopId)) {
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
    if (selectedShopId) params.set('selected', selectedShopId);
    else params.delete('selected');
    const query = params.toString();
    return `/map${query ? `?${query}` : ''}`;
  }, [activeFilters, hasMapSearched, searchParams, selectedShopId]);

  const backTarget = hasMapSearched ? '/' : (entrySource === 'searchResults' ? (locationState?.backTo ?? buildSearchUrl(activeFilters)) : '/');
  const backState = hasMapSearched ? undefined : locationState?.backState;

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

  const handleCloseCard = () => {
    setSelectedShopId('');
  };

  const applyMapSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    const nextFilters: SearchFilters = { ...draftFilters, q: searchText };
    setDraftFilters(nextFilters);
    setActiveFilters(nextFilters);
    setHasMapSearched(true);
    setEntrySource('home');
    setSelectedShopId('');
    setSearchMessage('');
    setUserPosition(null);

    const nextVisibleShops = filterShops(shops, nextFilters);
    setVisibleShops(nextVisibleShops);
    setSearchParams(buildSearchParams(nextFilters), { replace: true });

    if (nextVisibleShops.length) {
      setFitToShops(true);
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
      setMapCenter(result.center);
      setMapZoom(15);
      setFitToShops(false);
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
        onBack={() => navigate(backTarget, backState ? { state: backState } : undefined)}
        onClear={() => setSearchText('')}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((current) => !current)}
        onCollapse={() => setExpanded(false)}
        filters={draftFilters}
        onFiltersChange={setDraftFilters}
        onSearch={applyMapSearch}
        searching={isOsmSearching}
        message={searchMessage}
      />
      <section className="map-frame full-bleed-map-frame">
        <div className="map-canvas full-bleed-map with-overlay-card has-map-search-ui">
          <MapContainer center={mapCenter} zoom={mapZoom} zoomControl={false} scrollWheelZoom touchZoom className="leaflet-map">
            <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <MapViewportController center={userPosition ?? mapCenter} targetZoom={userPosition ? mapZoom : mapZoom} shops={visibleShops} fitToShops={fitToShops} selectedShop={selectedShop} />
            {visibleShops.map((shop) => {
              const selected = selectedShopId === shop.id;
              return (
                <Marker
                  key={shop.id}
                  position={[shop.lat, shop.lng]}
                  icon={createShopMarkerIcon(selected)}
                  eventHandlers={{ click: () => setSelectedShopId((current) => current === shop.id ? '' : shop.id) }}
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
              <ShopCard shop={selectedShop} compact backTo={currentMapUrl} backState={{ backTo: backTarget, backState, entrySource: hasMapSearched ? 'home' : entrySource }} />
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

function MapViewportController({ center, targetZoom, shops, fitToShops, selectedShop }: { center: [number, number]; targetZoom?: number; shops: Shop[]; fitToShops: boolean; selectedShop: Shop | null }) {
  const map = useMap();
  const initializedRef = useRef(false);
  const prevCenterRef = useRef<string>('');
  const prevZoomRef = useRef<number | null>(null);
  const prevFitToShopsRef = useRef<boolean>(fitToShops);
  const prevShopIdsRef = useRef<string>('');

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

    if (fitToShops && shops.length) {
      const shouldRefit = !initializedRef.current || !prevFitToShopsRef.current || prevShopIdsRef.current !== shopIdsKey;
      prevFitToShopsRef.current = true;
      prevShopIdsRef.current = shopIdsKey;
      prevCenterRef.current = centerKey;
      prevZoomRef.current = zoomValue;
      initializedRef.current = true;

      if (shouldRefit) {
        const bounds = L.latLngBounds(shops.map((shop) => [shop.lat, shop.lng] as [number, number]));
        map.fitBounds(bounds, { padding: [36, 36], animate: true, maxZoom: shops.length === 1 ? 15 : 13 });
      }
      return;
    }

    const shouldMove = !initializedRef.current || prevCenterRef.current !== centerKey || prevZoomRef.current !== zoomValue || prevFitToShopsRef.current !== fitToShops;
    prevFitToShopsRef.current = fitToShops;
    prevShopIdsRef.current = shopIdsKey;
    prevCenterRef.current = centerKey;
    prevZoomRef.current = zoomValue;
    initializedRef.current = true;

    if (shouldMove) {
      map.setView(center, zoomValue, { animate: true });
    }
  }, [center, fitToShops, map, selectedShop, shops, targetZoom]);
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
        <DetailItem label="席数" value={shop.seats || '未設定'} />
        <DetailItem label="駐車場" value={shop.parking ? 'あり' : 'なし'} />
        <DetailItem label="公式URL" value={shop.officialUrl || '未設定'} multiline />
      </section>
      <div className="action-row section compact">
        <Link className="secondary-button block" to={mapLink} state={{ backTo: detailUrl, backState: { backTo } }}>{'地図で見る'}</Link>
      </div>
      <BottomNav />
    </main>
  );
}

function AdminLoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/admin';
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
        <p className="csv-help">列名は id,name,tag,address,station,hours,holiday,seats,parking,official_url,lat,lng,image,memo,origin,genealogy の順で入力してください。id がある行は既存店舗を更新し、id が空の行は新規追加します。画像ファイルはCSVでは取り込みません。</p>
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

  const handleChange = (key: keyof ShopDraft, value: string | boolean | number) => {
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
        <label>席数<input value={form.seats} onChange={(e) => handleChange('seats', e.target.value)} /></label>
        <label>駐車場<select value={form.parking ? 'あり' : 'なし'} onChange={(e) => handleChange('parking', e.target.value === 'あり')}><option>あり</option><option>なし</option></select></label>
        <label>公式URL<input value={form.officialUrl} onChange={(e) => handleChange('officialUrl', e.target.value)} /></label>
        <label>緯度<input value={String(form.lat)} onChange={(e) => handleChange('lat', Number(e.target.value))} /></label>
        <label>経度<input value={String(form.lng)} onChange={(e) => handleChange('lng', Number(e.target.value))} /></label>
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
    seats: shop?.seats ?? '',
    parking: shop?.parking ?? false,
    officialUrl: shop?.officialUrl ?? '',
    lat: shop?.lat ?? 35.681236,
    lng: shop?.lng ?? 139.767125,
    image: shop?.image ?? '',
    memo: shop?.memo ?? '',
    id: shop?.id,
    updatedAt: shop?.updatedAt,
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

function DetailItem({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  return (
    <article className="detail-item">
      <span>{label}</span>
      <strong className={multiline ? 'multiline-text' : ''}>{value}</strong>
    </article>
  );
}

function BottomNav({ className = '' }: { className?: string }) {
  return (
    <nav className={`bottom-nav three-col ${className}`.trim()}>
      <Link to="/">トップ</Link>
      <Link to="/map">マップ</Link>
      <Link to="/shops">結果一覧</Link>
    </nav>
  );
}
