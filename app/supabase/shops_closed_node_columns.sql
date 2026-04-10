alter table public.shops
  add column if not exists is_closed boolean not null default false,
  add column if not exists node_name text null;

update public.shops
set node_name = name
where node_name is null or btrim(node_name) = '';

create or replace function public.set_shop_genealogy_defaults()
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

  if new.node_name is null or btrim(new.node_name) = '' then
    new.node_name := new.name;
  end if;

  if new.is_closed is null then
    new.is_closed := false;
  end if;

  return new;
end;
$$;

drop trigger if exists set_shop_genealogy_defaults_trigger on public.shops;
create trigger set_shop_genealogy_defaults_trigger
before insert or update on public.shops
for each row
execute function public.set_shop_genealogy_defaults();
