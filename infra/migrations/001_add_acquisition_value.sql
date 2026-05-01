alter table cards
add column if not exists acquisition_value numeric(18,2) not null default 0;
