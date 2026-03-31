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
  seats: string;
  parking: boolean;
  officialUrl: string;
  lat: number;
  lng: number;
  image: string;
  images: ShopImage[];
  memo: string;
  updatedAt: string;
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

export type CsvImportPreviewRow = {
  lineNumber: number;
  name: string;
  address: string;
  status: 'ready' | 'error';
  reasons: string[];
};

export type CsvImportPreparedRow = {
  lineNumber: number;
  raw: Record<string, string>;
  draft: ShopDraft;
};

export type CsvImportPreview = {
  header: string[];
  previewRows: CsvImportPreviewRow[];
  validRows: CsvImportPreparedRow[];
  errors: CsvImportError[];
  totalRows: number;
  readyCount: number;
  errorCount: number;
};

export const CSV_HEADERS = ['name','tag','address','station','hours','holiday','seats','parking','official_url','lat','lng','image','memo','origin','genealogy'] as const;
export type CsvHeader = typeof CSV_HEADERS[number];
