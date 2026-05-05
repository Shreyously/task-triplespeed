import { PoolClient } from "pg";

export async function getActiveCommitmentForUser(client: PoolClient, userId: string) {
  const { rows } = await client.query(
    `select *
     from pack_fairness_commitments
     where reserved_by = $1
       and status = 'RESERVED'
       and expires_at > now()
     order by reserved_at desc
     limit 1`,
    [userId]
  );
  return rows[0] ?? null;
}

export async function createCommitment(client: PoolClient, userId: string, serverSeed: string, serverSeedHash: string) {
  const { rows } = await client.query(
    `insert into pack_fairness_commitments(server_seed, server_seed_hash, status, reserved_by)
     values($1, $2, 'RESERVED', $3)
     returning *`,
    [serverSeed, serverSeedHash, userId]
  );
  return rows[0];
}

export async function getCommitmentForUpdate(client: PoolClient, commitmentId: string) {
  const { rows } = await client.query(
    "select * from pack_fairness_commitments where id = $1 for update",
    [commitmentId]
  );
  return rows[0] ?? null;
}

export async function consumeCommitment(
  client: PoolClient,
  commitmentId: string,
  purchaseId: string,
  clientSeed: string
) {
  await client.query(
    `update pack_fairness_commitments
     set status = 'CONSUMED',
         consumed_at = now(),
         purchase_id = $2,
         client_seed = $3
     where id = $1`,
    [commitmentId, purchaseId, clientSeed]
  );
}

export async function markCommitmentRevealed(client: PoolClient, commitmentId: string) {
  await client.query(
    `update pack_fairness_commitments
     set status = case when status = 'REVEALED' then status else 'REVEALED' end,
         revealed_at = coalesce(revealed_at, now())
     where id = $1`,
    [commitmentId]
  );
}

export async function upsertCardPoolSnapshot(client: PoolClient, hash: string, snapshot: unknown) {
  await client.query(
    `insert into pack_card_pool_snapshots(hash, snapshot)
     values($1, $2::jsonb)
     on conflict (hash) do nothing`,
    [hash, JSON.stringify(snapshot)]
  );
}

export async function createOpeningFairnessRecord(
  client: PoolClient,
  data: {
    purchaseId: string;
    commitmentId: string;
    serverSeedHash: string;
    clientSeed: string;
    nonce: number;
    dropId: string;
    configVersionId: string | null;
    rarityWeightMicros: Record<string, number>;
    cardPoolHash: string;
    cardsPerPack: number;
    selectedCardsHash: string;
  }
) {
  await client.query(
    `insert into pack_opening_fairness(
      purchase_id, commitment_id, server_seed_hash, client_seed, nonce, drop_id,
      config_version_id, rarity_weight_micros, card_pool_hash, cards_per_pack, selected_cards_hash
    ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
    [
      data.purchaseId,
      data.commitmentId,
      data.serverSeedHash,
      data.clientSeed,
      data.nonce,
      data.dropId,
      data.configVersionId,
      JSON.stringify(data.rarityWeightMicros),
      data.cardPoolHash,
      data.cardsPerPack,
      data.selectedCardsHash
    ]
  );
}

export async function getOpeningFairnessByPurchaseId(client: PoolClient, purchaseId: string) {
  const { rows } = await client.query(
    "select * from pack_opening_fairness where purchase_id = $1",
    [purchaseId]
  );
  return rows[0] ?? null;
}

export async function getCommitmentById(client: PoolClient, commitmentId: string) {
  const { rows } = await client.query(
    "select * from pack_fairness_commitments where id = $1",
    [commitmentId]
  );
  return rows[0] ?? null;
}

export async function getCardPoolSnapshot(client: PoolClient, hash: string) {
  const { rows } = await client.query(
    "select * from pack_card_pool_snapshots where hash = $1",
    [hash]
  );
  return rows[0] ?? null;
}

export async function getLatestAuditEventHash(client: PoolClient) {
  const { rows } = await client.query(
    "select event_hash from pack_opening_audit_events order by id desc limit 1"
  );
  return rows[0]?.event_hash ?? null;
}

export async function createAuditEvent(
  client: PoolClient,
  purchaseId: string,
  eventHash: string,
  previousEventHash: string | null,
  payload: unknown
) {
  await client.query(
    `insert into pack_opening_audit_events(purchase_id, event_hash, previous_event_hash, payload)
     values($1, $2, $3, $4::jsonb)`,
    [purchaseId, eventHash, previousEventHash, JSON.stringify(payload)]
  );
}

export async function listAuditEvents(client: PoolClient, limit: number, offset: number) {
  const { rows } = await client.query(
    `select id, purchase_id, created_at, event_hash, previous_event_hash, payload
     from pack_opening_audit_events
     order by id desc
     limit $1 offset $2`,
    [limit, offset]
  );
  return rows;
}
