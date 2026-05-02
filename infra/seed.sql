begin;

-- Drop-only seed data. Users and balances are intentionally not seeded here.
insert into drops (tier, price, cards_per_pack, inventory, starts_at, ends_at, rarity_weights)
values
  ('Basic', 5.00, 3, 180, now() - interval '1 hour', now() + interval '10 hour', '{"Common":0.72,"Uncommon":0.22,"Rare":0.05,"Holo Rare":0.01}'::jsonb),
  ('Pro', 15.00, 5, 90, now() - interval '1 hour', now() + interval '10 hour', '{"Common":0.55,"Uncommon":0.25,"Rare":0.12,"Holo Rare":0.06,"Ultra Rare/EX/GX":0.02}'::jsonb),
  ('Elite', 40.00, 7, 35, now() - interval '1 hour', now() + interval '10 hour', '{"Common":0.32,"Uncommon":0.24,"Rare":0.20,"Holo Rare":0.14,"Ultra Rare/EX/GX":0.08,"Secret Rare":0.02}'::jsonb)
on conflict (tier) do update
set
  price = excluded.price,
  cards_per_pack = excluded.cards_per_pack,
  inventory = excluded.inventory,
  starts_at = excluded.starts_at,
  ends_at = excluded.ends_at,
  rarity_weights = excluded.rarity_weights;

commit;
