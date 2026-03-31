import { defaultShops } from './shopSeeds';
import { noPhotoDataUrl } from './placeholders';
import { hasSupabaseEnv, supabase } from './supabase';
import type { CsvImportError, CsvImportPreparedRow, CsvImportPreview, Shop, ShopDraft, ShopImage, ShopImageType, Tag } from './types';
import { CSV_HEADERS } from './types';

const STORAGE_KEY = 'iekei-local-shops';
const TABLE_NAME = 'shops';
const IMAGE_TABLE_NAME = 'shop_images';
const IMAGE_BUCKET = 'shop-images';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: ShopImageType[] = ['slot1', 'slot2', 'slot3'];
const VALID_TAGS: Tag[] = ['直系', '独立系', '資本系'];

function generateUuidFallback() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.floor(Math.random() * 16);
    const value = char === 'x' ? random : ((random & 0x3) | 0x8);
    return value.toString(16);
  });
}

function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return generateUuidFallback();
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeTag(value: string): Tag {
  if (value === '直系' || value === '独立系' || value === '資本系') return value;
  return '独立系';
}

function sortImages(images: ShopImage[]) {
  const typeWeight: Record<ShopImageType, number> = { slot1: 0, slot2: 1, slot3: 2 };
  return [...images].sort((a, b) => {
    const orderDiff = a.sortOrder - b.sortOrder;
    if (orderDiff !== 0) return orderDiff;
    return typeWeight[a.imageType] - typeWeight[b.imageType];
  });
}

function getPrimaryImageUrl(images: ShopImage[]) {
  const first = sortImages(images)[0]?.publicUrl?.trim();
  if (first) return first;
  return noPhotoDataUrl;
}

function cleanShop(raw: Partial<ShopDraft> & { id?: string; updatedAt?: string; lineage?: string; images?: ShopImage[] }): Shop {
  const origin = raw.origin?.trim() || raw.lineage?.trim() || '源流未設定';
  const images = sortImages(raw.images ?? []);
  return {
    id: raw.id ?? generateId(),
    name: raw.name?.trim() || '名称未設定',
    origin,
    genealogy: raw.genealogy?.trim() || '',
    tag: normalizeTag(raw.tag || '独立系'),
    address: raw.address?.trim() || '',
    station: raw.station?.trim() || '',
    hours: String(raw.hours ?? '').replace(/\r\n/g, '\n').trim(),
    holiday: raw.holiday?.trim() || '',
    seats: raw.seats?.trim() || '',
    parking: Boolean(raw.parking),
    officialUrl: raw.officialUrl?.trim() || '',
    lat: Number(raw.lat ?? 35.681236),
    lng: Number(raw.lng ?? 139.767125),
    image: getPrimaryImageUrl(images),
    images,
    memo: raw.memo?.trim() || '',
    updatedAt: raw.updatedAt || todayString(),
  };
}

function readLocal(): Shop[] {
  const text = localStorage.getItem(STORAGE_KEY);
  if (!text) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultShops));
    return defaultShops;
  }

  try {
    const parsed = JSON.parse(text) as Shop[];
    return parsed.length ? parsed : defaultShops;
  } catch {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaultShops));
    return defaultShops;
  }
}

function writeLocal(shops: Shop[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(shops));
}

function mapDbImage(row: Record<string, unknown>): ShopImage {
  return {
    id: String(row.id ?? generateId()),
    shopId: String(row.shop_id ?? ''),
    imageType: String(row.image_type ?? 'slot1') as ShopImageType,
    storagePath: String(row.storage_path ?? ''),
    publicUrl: String(row.public_url ?? ''),
    sortOrder: Number(row.sort_order ?? 0),
    createdAt: String(row.created_at ?? nowIso()),
    updatedAt: String(row.updated_at ?? nowIso()),
  };
}

function mapDbShop(row: Record<string, unknown>, images: ShopImage[]): Shop {
  return cleanShop({
    id: String(row.id ?? generateId()),
    name: String(row.name ?? ''),
    origin: String(row.origin ?? row.lineage ?? ''),
    genealogy: String(row.genealogy ?? ''),
    tag: normalizeTag(String(row.tag ?? '独立系')),
    address: String(row.address ?? ''),
    station: String(row.station ?? ''),
    hours: String(row.hours ?? ''),
    holiday: String(row.holiday ?? ''),
    seats: String(row.seats ?? ''),
    parking: Boolean(row.parking),
    officialUrl: String(row.official_url ?? ''),
    lat: Number(row.lat ?? 35.681236),
    lng: Number(row.lng ?? 139.767125),
    image: String(row.image ?? ''),
    images,
    memo: String(row.memo ?? ''),
    updatedAt: String(row.updated_at ?? todayString()),
  });
}

function toDbShop(shop: Shop) {
  return {
    id: shop.id,
    name: shop.name,
    origin: shop.origin,
    genealogy: shop.genealogy,
    tag: shop.tag,
    address: shop.address,
    station: shop.station,
    hours: shop.hours,
    holiday: shop.holiday,
    seats: shop.seats,
    parking: shop.parking,
    official_url: shop.officialUrl,
    lat: shop.lat,
    lng: shop.lng,
    image: shop.image,
    memo: shop.memo,
    updated_at: shop.updatedAt,
  };
}

function toDbShopInsertPayload(shop: Shop) {
  return {
    name: shop.name,
    origin: shop.origin,
    genealogy: shop.genealogy,
    tag: shop.tag,
    address: shop.address,
    station: shop.station,
    hours: shop.hours,
    holiday: shop.holiday,
    seats: shop.seats,
    parking: shop.parking,
    official_url: shop.officialUrl,
    lat: shop.lat,
    lng: shop.lng,
    image: shop.image,
    memo: shop.memo,
  };
}

function toDbImage(image: ShopImage) {
  return {
    id: image.id,
    shop_id: image.shopId,
    image_type: image.imageType,
    storage_path: image.storagePath,
    public_url: image.publicUrl,
    sort_order: image.sortOrder,
    created_at: image.createdAt,
    updated_at: image.updatedAt,
  };
}

function attachImages(shops: Record<string, unknown>[], imageRows: Record<string, unknown>[]) {
  const imagesByShopId = new Map<string, ShopImage[]>();
  imageRows.forEach((row) => {
    const image = mapDbImage(row);
    const list = imagesByShopId.get(image.shopId) ?? [];
    list.push(image);
    imagesByShopId.set(image.shopId, list);
  });

  return shops.map((row) => mapDbShop(row, imagesByShopId.get(String(row.id ?? '')) ?? []));
}

export async function listShops(): Promise<Shop[]> {
  if (!hasSupabaseEnv || !supabase) {
    return readLocal();
  }

  const [{ data: shopRows, error: shopsError }, { data: imageRows, error: imagesError }] = await Promise.all([
    supabase.from(TABLE_NAME).select('*').order('updated_at', { ascending: false }),
    supabase.from(IMAGE_TABLE_NAME).select('*').order('sort_order', { ascending: true }),
  ]);

  if (shopsError) throw shopsError;
  if (imagesError) throw imagesError;
  return attachImages(shopRows ?? [], imageRows ?? []);
}

export async function getShop(shopId: string): Promise<Shop | null> {
  const shops = await listShops();
  return shops.find((shop) => shop.id === shopId) ?? null;
}

export async function upsertShop(draft: ShopDraft): Promise<Shop> {
  const shop = cleanShop(draft);

  if (!hasSupabaseEnv || !supabase) {
    const shops = readLocal();
    const next = shops.some((item) => item.id === shop.id)
      ? shops.map((item) => (item.id === shop.id ? { ...shop, images: item.images ?? [] } : item))
      : [{ ...shop, images: [] }, ...shops];
    writeLocal(next);
    return next.find((item) => item.id === shop.id) ?? { ...shop, images: [] };
  }

  const payload = toDbShop(shop);
  const hasExistingId = Boolean(draft.id);
  const query = hasExistingId
    ? supabase.from(TABLE_NAME).update(payload).eq('id', shop.id)
    : supabase.from(TABLE_NAME).insert(payload);

  const { error } = await query;
  if (error) throw error;
  return getShop(shop.id).then((item) => item ?? shop);
}

export async function removeShop(shopId: string): Promise<void> {
  if (!hasSupabaseEnv || !supabase) {
    const shops = readLocal().filter((shop) => shop.id !== shopId);
    writeLocal(shops);
    return;
  }

  const { data: imageRows, error: imageQueryError } = await supabase
    .from(IMAGE_TABLE_NAME)
    .select('storage_path')
    .eq('shop_id', shopId);

  if (imageQueryError) throw imageQueryError;

  const paths = (imageRows ?? []).map((row) => String(row.storage_path)).filter(Boolean);
  if (paths.length) {
    const { error: storageError } = await supabase.storage.from(IMAGE_BUCKET).remove(paths);
    if (storageError) throw storageError;
  }

  const { error } = await supabase.from(TABLE_NAME).delete().eq('id', shopId);
  if (error) throw error;
}

function parseCsv(text: string): string[][] {
  const normalized = text.replace(/^\ufeff/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      const isMeaningful = row.some((item) => item !== '');
      if (isMeaningful) rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((item) => item !== '')) rows.push(row);
  return rows;
}

function validateUrl(value: string) {
  if (!value.trim()) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function parseParking(value: string) {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return false;
  if (normalized === 'TRUE') return true;
  if (normalized === 'FALSE') return false;
  throw new Error('parking は TRUE または FALSE を入れてください。');
}

function buildCsvDraft(raw: Record<string, string>): ShopDraft {
  return {
    name: raw.name.trim(),
    origin: (raw.origin || '').trim() || '源流未設定',
    genealogy: (raw.genealogy || '').trim(),
    tag: normalizeTag(raw.tag.trim()),
    address: raw.address.trim(),
    station: (raw.station || '').trim(),
    hours: (raw.hours || '').replace(/\r\n/g, '\n').trim(),
    holiday: (raw.holiday || '').trim(),
    seats: (raw.seats || '').trim(),
    parking: parseParking(raw.parking || ''),
    officialUrl: (raw.official_url || '').trim(),
    lat: Number(raw.lat),
    lng: Number(raw.lng),
    image: '',
    memo: (raw.memo || '').trim(),
  };
}

export async function previewCsvImport(text: string): Promise<CsvImportPreview> {
  const parsed = parseCsv(text);
  if (!parsed.length) {
    throw new Error('CSVが空です。テンプレートの1行目に列名を入れてください。');
  }

  const [headerRow, ...bodyRows] = parsed;
  const normalizedHeader = headerRow.map((item) => item.trim());
  const expectedHeader = [...CSV_HEADERS];

  if (normalizedHeader.length !== expectedHeader.length || normalizedHeader.some((value, index) => value !== expectedHeader[index])) {
    throw new Error(`CSVの列名が想定と異なります。1行目は ${expectedHeader.join(',')} の順で入力してください。`);
  }

  const existingShops = await listShops();
  const existingKeys = new Set(existingShops.map((shop) => `${shop.name.trim()}__${shop.address.trim()}`));
  const fileSeenKeys = new Set<string>();
  const previewRows = [] as CsvImportPreview['previewRows'];
  const errors: CsvImportError[] = [];
  const validRows: CsvImportPreparedRow[] = [];

  bodyRows.forEach((values, rowIndex) => {
    const lineNumber = rowIndex + 2;
    const padded = [...values];
    while (padded.length < expectedHeader.length) padded.push('');
    const raw = Object.fromEntries(expectedHeader.map((header, index) => [header, String(padded[index] ?? '')])) as Record<string, string>;
    const reasons: string[] = [];

    const requiredFields: Array<keyof typeof raw> = ['name', 'tag', 'address', 'hours', 'holiday', 'lat', 'lng'];
    requiredFields.forEach((field) => {
      if (!raw[field]?.trim()) reasons.push(`${field} は必須です。`);
    });

    if (raw.tag?.trim() && !VALID_TAGS.includes(raw.tag.trim() as Tag)) {
      reasons.push('tag は 直系 / 独立系 / 資本系 のどれかを入れてください。');
    }

    const parkingValue = raw.parking?.trim();
    if (parkingValue && !['TRUE', 'FALSE'].includes(parkingValue.toUpperCase())) {
      reasons.push('parking は TRUE または FALSE を入れてください。');
    }

    if (raw.lat?.trim() && !Number.isFinite(Number(raw.lat))) {
      reasons.push('lat は数字で入れてください。');
    }

    if (raw.lng?.trim() && !Number.isFinite(Number(raw.lng))) {
      reasons.push('lng は数字で入れてください。');
    }

    if (raw.official_url?.trim() && !validateUrl(raw.official_url.trim())) {
      reasons.push('official_url は http:// または https:// で始まるURLを入れてください。');
    }

    const duplicateKey = `${raw.name.trim()}__${raw.address.trim()}`;
    if (raw.name.trim() && raw.address.trim()) {
      if (existingKeys.has(duplicateKey)) {
        reasons.push('name と address が同じ店舗がすでに登録されています。CSV取込は新規追加のみです。');
      } else if (fileSeenKeys.has(duplicateKey)) {
        reasons.push('同じCSV内で name と address が重複しています。');
      } else {
        fileSeenKeys.add(duplicateKey);
      }
    }

    if (reasons.length) {
      const error = { lineNumber, shopName: raw.name.trim(), reasons };
      errors.push(error);
      previewRows.push({ lineNumber, name: raw.name.trim() || '店舗名未入力', address: raw.address.trim(), status: 'error', reasons });
      return;
    }

    const draft = buildCsvDraft(raw);
    validRows.push({ lineNumber, raw, draft });
    previewRows.push({ lineNumber, name: draft.name, address: draft.address, status: 'ready', reasons: [] });
  });

  return {
    header: normalizedHeader,
    previewRows,
    validRows,
    errors,
    totalRows: bodyRows.length,
    readyCount: validRows.length,
    errorCount: errors.length,
  };
}

export async function executeCsvImport(validRows: CsvImportPreparedRow[]): Promise<{ importedCount: number; shops: Shop[] }> {
  if (!validRows.length) {
    return { importedCount: 0, shops: [] };
  }

  const imported = validRows.map(({ draft }) => cleanShop({ ...draft, images: [] }));

  if (!hasSupabaseEnv || !supabase) {
    const current = readLocal();
    const next = [...imported.map((shop) => ({ ...shop, images: [] })), ...current];
    writeLocal(next);
    return { importedCount: imported.length, shops: imported };
  }

  const payload = imported.map(toDbShopInsertPayload);
  const { data, error } = await supabase.from(TABLE_NAME).insert(payload).select('*');
  if (error) {
    const message = error.message?.trim() || '';
    if (message) {
      throw new Error(`CSV取込に失敗しました。${message}`);
    }
    throw new Error('CSV取込に失敗しました。DBへ保存する時にエラーが発生しました。');
  }
  const savedRows = (data ?? []) as Record<string, unknown>[];
  const savedShops = savedRows.map((row) => mapDbShop(row, []));
  return { importedCount: savedShops.length, shops: savedShops };
}

export async function compressImageFile(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) {
    throw new Error('画像ファイルを選択してください。');
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('画像の読み込みに失敗しました。'));
    reader.readAsDataURL(file);
  });

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を開けませんでした。'));
    img.src = dataUrl;
  });

  const maxEdge = 1600;
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('画像圧縮の準備に失敗しました。');
  }
  context.drawImage(image, 0, 0, width, height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/jpeg', 0.82);
  });

  if (!blob) {
    throw new Error('画像圧縮に失敗しました。');
  }

  const normalizedName = file.name.replace(/\.[^.]+$/, '') || 'upload';
  return new File([blob], `${normalizedName}.jpg`, { type: 'image/jpeg' });
}

function buildStoragePath(shopId: string, imageType: ShopImageType, filename: string) {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  return `${shopId}/${imageType}-${Date.now()}-${safeName}`;
}

function getPublicUrl(path: string) {
  const result = supabase?.storage.from(IMAGE_BUCKET).getPublicUrl(path);
  return result?.data.publicUrl ?? '';
}

function imageTypeToSortOrder(imageType: ShopImageType) {
  const index = IMAGE_TYPES.indexOf(imageType);
  return index >= 0 ? index + 1 : 99;
}

function describeStorageError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'object' && error !== null) {
    const candidate = (error as { message?: unknown; error?: unknown }).message;
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    const nested = (error as { error?: unknown }).error;
    if (typeof nested === 'string' && nested.trim()) return nested;
  }
  return fallback;
}

export async function uploadShopImage(shopId: string, imageType: ShopImageType, file: File): Promise<ShopImage> {
  if (!hasSupabaseEnv || !supabase) {
    throw new Error('画像アップロードはSupabase接続後に利用できます。');
  }

  const compressed = await compressImageFile(file);
  if (compressed.size > MAX_IMAGE_BYTES) {
    throw new Error('圧縮後も画像サイズが大きすぎます。別の画像を選んでください。');
  }

  const existing = await listShopImages(shopId);
  const current = existing.find((item) => item.imageType === imageType);

  const storagePath = buildStoragePath(shopId, imageType, compressed.name);
  const { error: uploadError } = await supabase.storage
    .from(IMAGE_BUCKET)
    .upload(storagePath, compressed, {
      upsert: false,
      cacheControl: '3600',
      contentType: compressed.type,
    });

  if (uploadError) throw new Error(describeStorageError(uploadError, '画像のアップロードに失敗しました。Storage設定と権限を確認してください。'));

  const image: ShopImage = {
    id: current?.id ?? generateId(),
    shopId,
    imageType,
    storagePath,
    publicUrl: getPublicUrl(storagePath),
    sortOrder: imageTypeToSortOrder(imageType),
    createdAt: current?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
  };

  if (current?.storagePath) {
    const { error: oldFileError } = await supabase.storage.from(IMAGE_BUCKET).remove([current.storagePath]);
    if (oldFileError) {
      await supabase.storage.from(IMAGE_BUCKET).remove([storagePath]);
      throw new Error(describeStorageError(oldFileError, '既存画像の差し替えに失敗しました。'));
    }
  }

  const payload = current ? toDbImage(image) : {
    shop_id: image.shopId,
    image_type: image.imageType,
    storage_path: image.storagePath,
    public_url: image.publicUrl,
    sort_order: image.sortOrder,
    updated_at: image.updatedAt,
  };
  const query = current
    ? supabase.from(IMAGE_TABLE_NAME).update(payload).eq('id', current.id)
    : supabase.from(IMAGE_TABLE_NAME).insert(payload);
  const { error: upsertError } = await query;
  if (upsertError) {
    await supabase.storage.from(IMAGE_BUCKET).remove([storagePath]);
    throw new Error(describeStorageError(upsertError, '画像情報の保存に失敗しました。DB設定を確認してください。'));
  }

  return image;
}

export async function listShopImages(shopId: string): Promise<ShopImage[]> {
  if (!hasSupabaseEnv || !supabase) {
    const shop = readLocal().find((item) => item.id === shopId);
    return sortImages(shop?.images ?? []);
  }

  const { data, error } = await supabase.from(IMAGE_TABLE_NAME).select('*').eq('shop_id', shopId).order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => mapDbImage(row as Record<string, unknown>));
}

export async function deleteShopImage(imageId: string): Promise<void> {
  if (!hasSupabaseEnv || !supabase) {
    const shops = readLocal().map((shop) => ({ ...shop, images: (shop.images ?? []).filter((image) => image.id !== imageId) }));
    writeLocal(shops.map((shop) => ({ ...shop, image: getPrimaryImageUrl(shop.images) })));
    return;
  }

  const { data, error: fetchError } = await supabase.from(IMAGE_TABLE_NAME).select('*').eq('id', imageId).maybeSingle();
  if (fetchError) throw new Error(describeStorageError(fetchError, '画像情報の読み込みに失敗しました。'));
  if (!data) return;

  const image = mapDbImage(data as Record<string, unknown>);
  const { error: removeStorageError } = await supabase.storage.from(IMAGE_BUCKET).remove([image.storagePath]);
  if (removeStorageError) throw new Error(describeStorageError(removeStorageError, '画像ファイルの削除に失敗しました。'));

  const { error } = await supabase.from(IMAGE_TABLE_NAME).delete().eq('id', imageId);
  if (error) throw error;
}

export function getConnectionLabel() {
  return hasSupabaseEnv ? 'Supabase接続中' : '接続設定前のためローカル保存モード';
}

export function getImageBucketName() {
  return IMAGE_BUCKET;
}
