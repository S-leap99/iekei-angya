# 電話番号カラムの追加方法

Supabase の SQL Editor で、`db_add_phone_column.sql` の中身をそのまま実行してください。

```sql
ALTER TABLE public.shops
ADD COLUMN IF NOT EXISTS phone text;

COMMENT ON COLUMN public.shops.phone IS '店舗の電話番号';
```

## 反映後にやること

1. Supabase の `shops` テーブルに `phone` カラムが追加されていることを確認する
2. 管理画面の店舗登録・編集で電話番号を保存する
3. CSVを使う場合は、列順を次に変更する

```text
id,name,tag,address,station,hours,holiday,phone,seats,parking,official_url,lat,lng,image,memo,origin,genealogy
```

## 補足

- `text` は文字列を保存する型です
- 電話番号は `-` ありでも保存できます
- 画面では `tel:` リンクに変換しているため、ユーザーがタップすると発信できます
