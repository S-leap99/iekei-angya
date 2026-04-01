# 家系行脚アプリ

## 起動
```bash
npm install
npm run dev
```

## Supabase 接続
1. `.env.example` をコピーして `.env.local` を作る
2. `VITE_SUPABASE_URL` と `VITE_SUPABASE_PUBLISHABLE_KEY` を設定する
3. `supabase/shops_schema.sql` を Supabase の SQL Editor で実行する

## 管理画面の権限制御
この版では、管理画面のログインに Supabase Auth を使います。

1. Supabase の Authentication → Users で管理者ユーザーを作成する
2. そのユーザーの `id` とメールアドレスを確認する
3. SQL Editor で次の SQL を実行して管理者として登録する

```sql
insert into public.admin_users (user_id, email)
values ('ここに auth.users の id', 'ここに管理者メールアドレス');
```

これで、店舗の閲覧はだれでも可能、追加・編集・削除は管理者だけ可能になります。
