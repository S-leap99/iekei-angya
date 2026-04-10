alter table public.shops
  add column if not exists parent_id uuid null references public.shops(id) on delete set null,
  add column if not exists nodo_id uuid null references public.shops(id) on delete set null;

alter table public.shops
  add constraint shops_parent_id_not_self check (parent_id is null or parent_id <> id);

create index if not exists shops_parent_id_idx on public.shops(parent_id);
create index if not exists shops_nodo_id_idx on public.shops(nodo_id);

create or replace function public.set_shop_nodo_id_default()
returns trigger
language plpgsql
as $$
begin
  if new.id is null then
    new.id := gen_random_uuid();
  end if;

  if new.nodo_id is null then
    new.nodo_id := new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists set_shop_nodo_id_default_trigger on public.shops;
create trigger set_shop_nodo_id_default_trigger
before insert or update on public.shops
for each row
execute function public.set_shop_nodo_id_default();

update public.shops
set nodo_id = id
where nodo_id is null;
