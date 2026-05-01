import { hasSupabaseEnv, supabase } from './supabase';
import type { Tag } from './types';

export type ShopSubmissionStatus = 'pending' | 'approved' | 'rejected';

export type NewShopSubmissionInput = {
  userId: string;
  name: string;
  tag: Tag;
  address: string;
  station?: string;
  hours?: string;
  holiday?: string;
  parking?: boolean | null;
  officialUrl?: string;
  image?: string;
  origin?: string;
  genealogy?: string;
};

export type UpdateShopSubmissionInput = {
  userId: string;
  targetShopId: string;
  name: string;
  tag: Tag;
  address: string;
  station?: string;
  hours?: string;
  holiday?: string;
  parking?: boolean | null;
  officialUrl?: string;
  image?: string;
  origin?: string;
  genealogy?: string;
  phone?: string;
  officialAccount?: string;
  seats?: string;
  memo?: string;
};

const TABLE_NAME = 'shop_submissions';

function isReady() {
  return Boolean(hasSupabaseEnv && supabase);
}

function cleanOptionalText(value: string | undefined) {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

export async function createNewShopSubmission(input: NewShopSubmissionInput) {
  if (!isReady() || !supabase) {
    throw new Error('Supabase接続が未設定です。.env.local の設定を確認してください。');
  }

  const payload = {
    user_id: input.userId,
    submission_type: 'new',
    name: input.name.trim(),
    tag: input.tag,
    address: input.address.trim(),
    station: cleanOptionalText(input.station),
    hours: cleanOptionalText(input.hours),
    holiday: cleanOptionalText(input.holiday),
    parking: input.parking,
    official_url: cleanOptionalText(input.officialUrl),
    image: cleanOptionalText(input.image),
    origin: cleanOptionalText(input.origin),
    genealogy: cleanOptionalText(input.genealogy),
    status: 'pending',
  };

  const { error } = await supabase.from(TABLE_NAME).insert(payload);
  if (error) {
    throw new Error(getErrorMessage(error, '店舗情報の送信に失敗しました。'));
  }
}


export async function createUpdateShopSubmission(input: UpdateShopSubmissionInput) {
  if (!isReady() || !supabase) {
    throw new Error('Supabase接続が未設定です。.env.local の設定を確認してください。');
  }

  const payload = {
    user_id: input.userId,
    submission_type: 'update',
    target_shop_id: input.targetShopId,
    name: input.name.trim(),
    tag: input.tag,
    address: input.address.trim(),
    station: cleanOptionalText(input.station),
    hours: cleanOptionalText(input.hours),
    holiday: cleanOptionalText(input.holiday),
    parking: input.parking,
    official_url: cleanOptionalText(input.officialUrl),
    image: cleanOptionalText(input.image),
    origin: cleanOptionalText(input.origin),
    genealogy: cleanOptionalText(input.genealogy),
    phone: cleanOptionalText(input.phone),
    official_account: cleanOptionalText(input.officialAccount),
    seats: cleanOptionalText(input.seats),
    memo: cleanOptionalText(input.memo),
    status: 'pending',
  };

  const { error } = await supabase.from(TABLE_NAME).insert(payload);
  if (error) {
    throw new Error(getErrorMessage(error, '店舗情報の修正提案に失敗しました。'));
  }
}



export type ShopSubmissionType = 'new' | 'update';

export type ShopSubmission = {
  id: string;
  userId: string;
  submissionType: ShopSubmissionType;
  targetShopId: string | null;
  name: string;
  tag: Tag;
  address: string;
  station: string;
  hours: string;
  holiday: string;
  seats: string;
  parking: boolean | null;
  officialUrl: string;
  lat: number | null;
  lng: number | null;
  image: string;
  memo: string;
  origin: string;
  genealogy: string;
  phone: string;
  officialAccount: string;
  parentId: string | null;
  nodoId: string | null;
  isClosed: boolean | null;
  nodeName: string;
  status: ShopSubmissionStatus;
  adminReason: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  importedShopId: string | null;
  importedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ShopSubmissionDraftInput = {
  name: string;
  tag: Tag;
  address: string;
  station?: string;
  hours?: string;
  holiday?: string;
  seats?: string;
  parking?: boolean | null;
  officialUrl?: string;
  lat?: number | null;
  lng?: number | null;
  image?: string;
  memo?: string;
  origin?: string;
  genealogy?: string;
  phone?: string;
  officialAccount?: string;
  parentId?: string | null;
  nodoId?: string | null;
  isClosed?: boolean | null;
  nodeName?: string;
};

function nullableNumber(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mapSubmission(row: Record<string, any>): ShopSubmission {
  return {
    id: row.id,
    userId: row.user_id,
    submissionType: row.submission_type,
    targetShopId: row.target_shop_id,
    name: row.name ?? '',
    tag: row.tag,
    address: row.address ?? '',
    station: row.station ?? '',
    hours: row.hours ?? '',
    holiday: row.holiday ?? '',
    seats: row.seats ?? '',
    parking: row.parking,
    officialUrl: row.official_url ?? '',
    lat: row.lat ?? null,
    lng: row.lng ?? null,
    image: row.image ?? '',
    memo: row.memo ?? '',
    origin: row.origin ?? '',
    genealogy: row.genealogy ?? '',
    phone: row.phone ?? '',
    officialAccount: row.official_account ?? '',
    parentId: row.parent_id ?? null,
    nodoId: row.nodo_id ?? null,
    isClosed: row.is_closed ?? null,
    nodeName: row.node_name ?? '',
    status: row.status,
    adminReason: row.admin_reason ?? '',
    reviewedBy: row.reviewed_by ?? null,
    reviewedAt: row.reviewed_at ?? null,
    importedShopId: row.imported_shop_id ?? null,
    importedAt: row.imported_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildAdminPayload(input: ShopSubmissionDraftInput) {
  return {
    name: input.name.trim(),
    tag: input.tag,
    address: input.address.trim(),
    station: cleanOptionalText(input.station),
    hours: cleanOptionalText(input.hours),
    holiday: cleanOptionalText(input.holiday),
    seats: cleanOptionalText(input.seats),
    parking: input.parking ?? null,
    official_url: cleanOptionalText(input.officialUrl),
    lat: nullableNumber(input.lat),
    lng: nullableNumber(input.lng),
    image: cleanOptionalText(input.image),
    memo: cleanOptionalText(input.memo),
    origin: cleanOptionalText(input.origin),
    genealogy: cleanOptionalText(input.genealogy),
    phone: cleanOptionalText(input.phone),
    official_account: cleanOptionalText(input.officialAccount),
    parent_id: input.parentId || null,
    nodo_id: input.nodoId || null,
    is_closed: input.isClosed ?? false,
    node_name: cleanOptionalText(input.nodeName),
    updated_at: new Date().toISOString(),
  };
}

export async function listShopSubmissions(status?: ShopSubmissionStatus | 'all') {
  if (!isReady() || !supabase) throw new Error('Supabase接続が未設定です。');
  let query = supabase.from(TABLE_NAME).select('*').order('created_at', { ascending: false });
  if (status && status !== 'all') query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new Error(getErrorMessage(error, '店舗情報提供一覧の取得に失敗しました。'));
  return (data ?? []).map((row) => mapSubmission(row as Record<string, any>));
}

export async function listMyShopSubmissions(userId: string) {
  if (!isReady() || !supabase) throw new Error('Supabase接続が未設定です。');
  const { data, error } = await supabase
    .from(TABLE_NAME)
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(getErrorMessage(error, '提供した店舗情報の取得に失敗しました。'));
  return (data ?? []).map((row) => mapSubmission(row as Record<string, any>));
}

export async function getShopSubmission(id: string) {
  if (!isReady() || !supabase) throw new Error('Supabase接続が未設定です。');
  const { data, error } = await supabase.from(TABLE_NAME).select('*').eq('id', id).single();
  if (error) throw new Error(getErrorMessage(error, '店舗情報提供の取得に失敗しました。'));
  return mapSubmission(data as Record<string, any>);
}

export async function updateShopSubmissionDraft(id: string, input: ShopSubmissionDraftInput) {
  if (!isReady() || !supabase) throw new Error('Supabase接続が未設定です。');
  const { error } = await supabase.from(TABLE_NAME).update(buildAdminPayload(input)).eq('id', id);
  if (error) throw new Error(getErrorMessage(error, '店舗情報提供の保存に失敗しました。'));
}

export async function reviewShopSubmission(id: string, status: 'approved' | 'rejected', adminReason: string, reviewedBy: string | null) {
  if (!isReady() || !supabase) throw new Error('Supabase接続が未設定です。');
  const { error } = await supabase.from(TABLE_NAME).update({
    status,
    admin_reason: cleanOptionalText(adminReason),
    reviewed_by: reviewedBy,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) throw new Error(getErrorMessage(error, '審査結果の保存に失敗しました。'));
}

function textForShop(value: string | null | undefined) {
  return value?.trim() ?? '';
}

function requiredText(value: string | null | undefined, label: string) {
  const cleaned = textForShop(value);
  if (!cleaned) throw new Error(`${label}を入力してください。`);
  return cleaned;
}

function buildShopPayloadFromSubmission(item: ShopSubmission) {
  const lat = nullableNumber(item.lat);
  const lng = nullableNumber(item.lng);
  if (lat === null) throw new Error('緯度 lat を入力してください。');
  if (lng === null) throw new Error('経度 lng を入力してください。');

  return {
    name: requiredText(item.name, '店舗名'),
    tag: item.tag,
    address: requiredText(item.address, '住所'),
    station: textForShop(item.station),
    hours: textForShop(item.hours),
    holiday: textForShop(item.holiday),
    seats: textForShop(item.seats),
    parking: Boolean(item.parking),
    official_url: textForShop(item.officialUrl),
    lat,
    lng,
    image: textForShop(item.image),
    memo: textForShop(item.memo),
    updated_at: new Date().toISOString().slice(0, 10),
    origin: textForShop(item.origin),
    genealogy: textForShop(item.genealogy),
    phone: textForShop(item.phone) || null,
    official_account: textForShop(item.officialAccount) || null,
    parent_id: item.parentId || null,
    nodo_id: item.nodoId || null,
    is_closed: Boolean(item.isClosed),
    node_name: textForShop(item.nodeName) || null,
  };
}

function normalizeShopValue(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim();
  return value;
}

function hasDifferentValue(currentShop: Record<string, unknown>, columnName: string, nextValue: unknown) {
  return normalizeShopValue(currentShop[columnName]) !== normalizeShopValue(nextValue);
}

function addTextUpdate(payload: Record<string, unknown>, currentShop: Record<string, unknown>, columnName: string, value: string | null | undefined) {
  const cleaned = textForShop(value);
  if (!cleaned) return;
  if (hasDifferentValue(currentShop, columnName, cleaned)) payload[columnName] = cleaned;
}

function addUuidUpdate(payload: Record<string, unknown>, currentShop: Record<string, unknown>, columnName: string, value: string | null | undefined) {
  if (!value) return;
  if (hasDifferentValue(currentShop, columnName, value)) payload[columnName] = value;
}

function buildPartialShopUpdatePayloadFromSubmission(item: ShopSubmission, currentShop: Record<string, unknown>) {
  const payload: Record<string, unknown> = {};

  addTextUpdate(payload, currentShop, 'name', item.name);
  addTextUpdate(payload, currentShop, 'tag', item.tag);
  addTextUpdate(payload, currentShop, 'address', item.address);
  addTextUpdate(payload, currentShop, 'station', item.station);
  addTextUpdate(payload, currentShop, 'hours', item.hours);
  addTextUpdate(payload, currentShop, 'holiday', item.holiday);
  addTextUpdate(payload, currentShop, 'seats', item.seats);
  addTextUpdate(payload, currentShop, 'official_url', item.officialUrl);
  addTextUpdate(payload, currentShop, 'image', item.image);
  addTextUpdate(payload, currentShop, 'memo', item.memo);
  addTextUpdate(payload, currentShop, 'origin', item.origin);
  addTextUpdate(payload, currentShop, 'genealogy', item.genealogy);
  addTextUpdate(payload, currentShop, 'phone', item.phone);
  addTextUpdate(payload, currentShop, 'official_account', item.officialAccount);
  addUuidUpdate(payload, currentShop, 'parent_id', item.parentId);
  addUuidUpdate(payload, currentShop, 'nodo_id', item.nodoId);
  addTextUpdate(payload, currentShop, 'node_name', item.nodeName);

  const lat = nullableNumber(item.lat);
  if (lat !== null && hasDifferentValue(currentShop, 'lat', lat)) payload.lat = lat;

  const lng = nullableNumber(item.lng);
  if (lng !== null && hasDifferentValue(currentShop, 'lng', lng)) payload.lng = lng;

  if (item.parking !== null && item.parking !== undefined && hasDifferentValue(currentShop, 'parking', item.parking)) {
    payload.parking = item.parking;
  }

  if (item.isClosed !== null && item.isClosed !== undefined && hasDifferentValue(currentShop, 'is_closed', item.isClosed)) {
    payload.is_closed = item.isClosed;
  }

  if (Object.keys(payload).length > 0) {
    payload.updated_at = new Date().toISOString().slice(0, 10);
  }

  return payload;
}

export async function importApprovedSubmissionToShops(id: string) {
  if (!isReady() || !supabase) throw new Error('Supabase接続が未設定です。');

  const submission = await getShopSubmission(id);
  if (submission.status !== 'approved') {
    throw new Error('承認済みの提供内容だけ本番DBへ反映できます。');
  }
  if (submission.importedShopId || submission.importedAt) {
    throw new Error('この提供内容はすでに本番DBへ反映済みです。');
  }

  let shopId = submission.targetShopId;

  if (submission.submissionType === 'update') {
    if (!shopId) throw new Error('修正対象店舗IDがないため、本番DBへ反映できません。');

    const { data: currentShop, error: fetchError } = await supabase
      .from('shops')
      .select('*')
      .eq('id', shopId)
      .single();

    if (fetchError) throw new Error(getErrorMessage(fetchError, '修正対象店舗の取得に失敗しました。'));

    const payload = buildPartialShopUpdatePayloadFromSubmission(submission, currentShop as Record<string, unknown>);
    if (Object.keys(payload).length === 0) {
      throw new Error('本番DBへ反映する変更項目がありません。');
    }

    const { error } = await supabase.from('shops').update(payload).eq('id', shopId);
    if (error) throw new Error(getErrorMessage(error, '本番DBへの反映に失敗しました。'));
  } else {
    const payload = buildShopPayloadFromSubmission(submission);
    const { data, error } = await supabase.from('shops').insert(payload).select('id').single();
    if (error) throw new Error(getErrorMessage(error, '本番DBへの追加に失敗しました。'));
    shopId = String((data as Record<string, unknown>).id ?? '');
  }

  const { error: updateError } = await supabase.from(TABLE_NAME).update({
    imported_shop_id: shopId,
    imported_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', id);

  if (updateError) throw new Error(getErrorMessage(updateError, '反映済み情報の保存に失敗しました。'));
  return shopId;
}
