-- Supabase / PostgreSQL 用
-- shops テーブルへ電話番号カラムを追加するSQL
ALTER TABLE public.shops
ADD COLUMN IF NOT EXISTS phone text;

COMMENT ON COLUMN public.shops.phone IS '店舗の電話番号';
