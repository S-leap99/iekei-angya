create extension if not exists pgcrypto;

create table if not exists public.shops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  lineage text not null default '',
  origin text not null default '',
  genealogy text not null default '',
  tag text not null check (tag in ('直系', '独立系', '資本系')),
  address text not null default '',
  station text not null default '',
  hours text not null default '',
  holiday text not null default '',
  seats text not null default '',
  parking boolean not null default false,
  official_url text not null default '',
  lat double precision not null default 35.681236,
  lng double precision not null default 139.767125,
  image text not null default '',
  memo text not null default '',
  updated_at date not null default current_date
);

alter table public.shops
  add column if not exists lineage text not null default '',
  add column if not exists origin text not null default '',
  add column if not exists genealogy text not null default '';

update public.shops
set origin = coalesce(nullif(origin, ''), lineage)
where coalesce(origin, '') = '';

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.shop_images (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  image_type text not null check (image_type in ('slot1', 'slot2', 'slot3')),
  storage_path text not null unique,
  public_url text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, image_type)
);

alter table public.shop_images drop constraint if exists shop_images_image_type_check;
alter table public.shop_images
  add constraint shop_images_image_type_check
  check (image_type in ('slot1', 'slot2', 'slot3'));

update public.shop_images set image_type = 'slot1' where image_type = 'exterior';
update public.shop_images set image_type = 'slot2' where image_type = 'interior';
update public.shop_images set image_type = 'slot3' where image_type = 'ramen';

update public.shop_images set sort_order = 1 where image_type = 'slot1';
update public.shop_images set sort_order = 2 where image_type = 'slot2';
update public.shop_images set sort_order = 3 where image_type = 'slot3';

create or replace function public.is_admin_user()
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.admin_users
    where admin_users.user_id = auth.uid()
  );
$$;

alter table public.shops enable row level security;
alter table public.admin_users enable row level security;
alter table public.shop_images enable row level security;

-- ストレージバケット
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'shop-images',
  'shop-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- 古い試作用ポリシーを削除
DROP POLICY IF EXISTS "public can read shops" ON public.shops;
DROP POLICY IF EXISTS "public can insert shops during prototype" ON public.shops;
DROP POLICY IF EXISTS "public can update shops during prototype" ON public.shops;
DROP POLICY IF EXISTS "public can delete shops during prototype" ON public.shops;
DROP POLICY IF EXISTS "admins can insert shops" ON public.shops;
DROP POLICY IF EXISTS "admins can update shops" ON public.shops;
DROP POLICY IF EXISTS "admins can delete shops" ON public.shops;
DROP POLICY IF EXISTS "admins can read own admin row" ON public.admin_users;
DROP POLICY IF EXISTS "service role manages admin users" ON public.admin_users;
DROP POLICY IF EXISTS "public can read shop images" ON public.shop_images;
DROP POLICY IF EXISTS "admins can insert shop images" ON public.shop_images;
DROP POLICY IF EXISTS "admins can update shop images" ON public.shop_images;
DROP POLICY IF EXISTS "admins can delete shop images" ON public.shop_images;
DROP POLICY IF EXISTS "public can read shop image objects" ON storage.objects;
DROP POLICY IF EXISTS "admins can upload shop image objects" ON storage.objects;
DROP POLICY IF EXISTS "admins can update shop image objects" ON storage.objects;
DROP POLICY IF EXISTS "admins can delete shop image objects" ON storage.objects;

create policy "public can read shops"
on public.shops
for select
to anon, authenticated
using (true);

create policy "admins can insert shops"
on public.shops
for insert
to authenticated
with check (public.is_admin_user());

create policy "admins can update shops"
on public.shops
for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

create policy "admins can delete shops"
on public.shops
for delete
to authenticated
using (public.is_admin_user());

create policy "admins can read own admin row"
on public.admin_users
for select
to authenticated
using (user_id = auth.uid());

create policy "public can read shop images"
on public.shop_images
for select
to anon, authenticated
using (true);

create policy "admins can insert shop images"
on public.shop_images
for insert
to authenticated
with check (public.is_admin_user());

create policy "admins can update shop images"
on public.shop_images
for update
to authenticated
using (public.is_admin_user())
with check (public.is_admin_user());

create policy "admins can delete shop images"
on public.shop_images
for delete
to authenticated
using (public.is_admin_user());

create policy "public can read shop image objects"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'shop-images');

create policy "admins can upload shop image objects"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'shop-images'
  and public.is_admin_user()
);

create policy "admins can update shop image objects"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'shop-images'
  and public.is_admin_user()
)
with check (
  bucket_id = 'shop-images'
  and public.is_admin_user()
);

create policy "admins can delete shop image objects"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'shop-images'
  and public.is_admin_user()
);

-- admin_users の追加・更新・削除は SQL Editor からだけ実行する想定


alter table public.shops drop column if exists access;
alter table public.shops drop column if exists area;
