import { withTx, pool } from "./pool";

async function cleanupTestData() {
  await withTx(async (client) => {
    const { rows } = await client.query<{ id: string }>(`
      with ranked as (
        select
          id,
          tier,
          row_number() over (partition by tier order by created_at desc, id desc) as rn
        from drops
      )
      select id
      from ranked
      where tier not in ('Basic', 'Pro', 'Elite') or rn > 1
    `);

    const dropIds = rows.map((r) => r.id);
    if (!dropIds.length) {
      console.log("No duplicate/test drops found");
      return;
    }

    await client.query(
      `
      with target_drops as (
        select unnest($1::uuid[]) as id
      ),
      target_purchases as (
        select p.id
        from pack_purchases p
        join target_drops d on d.id = p.drop_id
      ),
      target_cards as (
        select c.id
        from cards c
        join target_purchases p on p.id = c.purchase_id
      ),
      target_listings as (
        select l.id
        from listings l
        join target_cards c on c.id = l.card_id
      ),
      target_auctions as (
        select a.id
        from auctions a
        join target_cards c on c.id = a.card_id
      )
      delete from bids
      where auction_id in (select id from target_auctions)
    `,
      [dropIds]
    );

    await client.query(
      `
      with target_drops as (
        select unnest($1::uuid[]) as id
      ),
      target_purchases as (
        select p.id
        from pack_purchases p
        join target_drops d on d.id = p.drop_id
      ),
      target_cards as (
        select c.id
        from cards c
        join target_purchases p on p.id = c.purchase_id
      ),
      target_auctions as (
        select a.id
        from auctions a
        join target_cards c on c.id = a.card_id
      )
      delete from auction_settlements
      where auction_id in (select id from target_auctions)
    `,
      [dropIds]
    );

    await client.query(
      `
      with target_drops as (
        select unnest($1::uuid[]) as id
      ),
      target_purchases as (
        select p.id
        from pack_purchases p
        join target_drops d on d.id = p.drop_id
      ),
      target_cards as (
        select c.id
        from cards c
        join target_purchases p on p.id = c.purchase_id
      )
      delete from auctions
      where card_id in (select id from target_cards)
    `,
      [dropIds]
    );

    await client.query(
      `
      with target_drops as (
        select unnest($1::uuid[]) as id
      ),
      target_purchases as (
        select p.id
        from pack_purchases p
        join target_drops d on d.id = p.drop_id
      ),
      target_cards as (
        select c.id
        from cards c
        join target_purchases p on p.id = c.purchase_id
      ),
      target_listings as (
        select l.id
        from listings l
        join target_cards c on c.id = l.card_id
      )
      delete from trade_transactions
      where listing_id in (select id from target_listings)
    `,
      [dropIds]
    );

    await client.query(
      `
      with target_drops as (
        select unnest($1::uuid[]) as id
      ),
      target_purchases as (
        select p.id
        from pack_purchases p
        join target_drops d on d.id = p.drop_id
      ),
      target_cards as (
        select c.id
        from cards c
        join target_purchases p on p.id = c.purchase_id
      )
      delete from listings
      where card_id in (select id from target_cards)
    `,
      [dropIds]
    );

    await client.query(
      `
      with target_drops as (
        select unnest($1::uuid[]) as id
      ),
      target_purchases as (
        select p.id
        from pack_purchases p
        join target_drops d on d.id = p.drop_id
      ),
      target_cards as (
        select c.id
        from cards c
        join target_purchases p on p.id = c.purchase_id
      )
      delete from card_market_state
      where card_id in (select id from target_cards)
    `,
      [dropIds]
    );

    await client.query(
      `
      with target_drops as (
        select unnest($1::uuid[]) as id
      ),
      target_purchases as (
        select p.id
        from pack_purchases p
        join target_drops d on d.id = p.drop_id
      )
      delete from ledger
      where reference_id in (select id from target_purchases)
    `,
      [dropIds]
    );

    await client.query(
      `
      with target_drops as (
        select unnest($1::uuid[]) as id
      ),
      target_purchases as (
        select p.id
        from pack_purchases p
        join target_drops d on d.id = p.drop_id
      )
      delete from cards
      where purchase_id in (select id from target_purchases)
    `,
      [dropIds]
    );

    await client.query("delete from pack_purchases where drop_id = any($1::uuid[])", [dropIds]);
    await client.query("delete from drops where id = any($1::uuid[])", [dropIds]);
    await client.query("create unique index if not exists ux_drops_tier on drops(tier)");

    console.log(`Removed ${dropIds.length} duplicate/test drops`);
  });
}

cleanupTestData()
  .then(async () => {
    await pool.end();
  })
  .catch(async (e) => {
    console.error(e);
    await pool.end();
    process.exit(1);
  });
