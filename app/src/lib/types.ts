export type Tag = '直系' | '独立系' | '資本系';
export type ShopImageType = 'slot1' | 'slot2' | 'slot3';

export type ShopImage = {
  id: string;
  shopId: string;
  imageType: ShopImageType;
  storagePath: string;
  publicUrl: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type Shop = {
  id: string;
  name: string;
  origin: string;
  genealogy: string;
  tag: Tag;
  address: string;
  station: string;
  hours: string;
  holiday: string;
  phone: string;
  seats: string;
  parking: boolean;
  officialUrl: string;
  officialAccount: string;
  lat: number;
  lng: number;
  image: string;
  images: ShopImage[];
  memo: string;
  updatedAt: string;
  parentId: string | null;
  nodoId: string;
};

export type ShopDraft = Omit<Shop, 'id' | 'updatedAt' | 'images'> & {
  id?: string;
  updatedAt?: string;
};

export type CsvImportError = {
  lineNumber: number;
  shopName: string;
  reasons: string[];
};

export type CsvImportAction = 'create' | 'update';

export type CsvImportPreviewRow = {
  lineNumber: number;
  id: string;
  name: string;
  address: string;
  status: CsvImportAction | 'error';
  reasons: string[];
};

export type CsvImportPreparedRow = {
  lineNumber: number;
  raw: Record<string, string>;
  draft: ShopDraft;
  action: CsvImportAction;
};

export type CsvImportPreview = {
  header: string[];
  previewRows: CsvImportPreviewRow[];
  validRows: CsvImportPreparedRow[];
  errors: CsvImportError[];
  totalRows: number;
  createCount: number;
  updateCount: number;
  errorCount: number;
};

export const CSV_HEADERS = ['id','name','tag','address','station','hours','holiday','phone','seats','parking','official_url','official_account','lat','lng','image','memo','updated_at','origin','genealogy','parent_id','nodo_id'] as const;
export type CsvHeader = typeof CSV_HEADERS[number];