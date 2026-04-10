alter table public.shops
  drop constraint if exists shops_child_not_self;

alter table public.shops
  drop constraint if exists shops_child_id_not_self;

alter table public.shops
  drop constraint if exists shops_child_id_fkey;

drop index if exists shops_child_id_idx;

alter table public.shops
  drop column if exists child_id;
