BEGIN;

-- Every financial table identified its network by the integer EVM chain id, typed every address as
-- char(42) lowercase hex and every hash as char(66), and keyed primary keys, unique indexes and the
-- two SECURITY DEFINER wallet resolvers on that integer. Solana has no numeric chain id, its
-- addresses are 32-44 characters of case-significant base58 and its signatures up to 88, so none
-- of that shape can hold a second rail. This migration makes the chain a text key -- `base`,
-- `base_sepolia`, `solana`, `solana_devnet` -- carried beside a now-nullable `chain_id`, and moves
-- every key, index, CHECK and resolver onto it. Column NAMES do not change: on Solana
-- transaction_hash is the signature, log_index the instruction ordinal, block_number the slot and
-- block_hash the blockhash. Base rows are byte-identical: chain_id stays populated, the hex
-- CHECKs are the same regular expressions keyed on the row's family, and identities derived from
-- them elsewhere do not move.
--
-- Rolling upgrades (the failure 050 documents) are why chain_key is derived rather than demanded:
-- the image serving while this lands still inserts bindings, funding rows, chain events, cursors
-- and halts with chain_id only. A BEFORE trigger derives chain_key from chain_id on every table,
-- so both images satisfy the NOT NULL, and the raw-SQL live fixtures that insert chain_id alone
-- keep working for the same reason.

-- ---------------------------------------------------------------------------------------------
-- Chain helpers. IMMUTABLE so they are usable inside CHECK constraints; the literals here are
-- pinned to packages/chain-domain/src/chain.ts by a migration test in the private application.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION meowwa_chain_family(chain_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT CASE
    WHEN chain_key IN ('base', 'base_sepolia') THEN 'evm'
    WHEN chain_key IN ('solana', 'solana_devnet') THEN 'solana'
  END
$function$;

CREATE OR REPLACE FUNCTION meowwa_chain_key_for_id(chain_id integer)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT CASE chain_id
    WHEN 8453 THEN 'base'
    WHEN 84532 THEN 'base_sepolia'
  END
$function$;

-- Deliberately never NULL: a CHECK treats NULL as satisfied, and `chain_key = 'base'` beside a
-- NULL chain_id would otherwise pass.
CREATE OR REPLACE FUNCTION meowwa_chain_key_consistent(chain_key text, chain_id integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT COALESCE(
    (chain_key = 'base' AND chain_id = 8453)
    OR (chain_key = 'base_sepolia' AND chain_id = 84532)
    OR (chain_key IN ('solana', 'solana_devnet') AND chain_id IS NULL),
    false
  )
$function$;

-- The EVM patterns are the exact expressions the char(42)/char(66) CHECKs used, so a Base row
-- accepted before is accepted now and nothing else is. Base58 excludes 0, O, I and l.
CREATE OR REPLACE FUNCTION meowwa_chain_address_ok(chain_key text, value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE public.meowwa_chain_family(chain_key)
    WHEN 'evm' THEN value ~ '^0x[0-9a-f]{40}$'
    WHEN 'solana' THEN value ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    ELSE false
  END
$function$;

CREATE OR REPLACE FUNCTION meowwa_chain_tx_ok(chain_key text, value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE public.meowwa_chain_family(chain_key)
    WHEN 'evm' THEN value ~ '^0x[0-9a-f]{64}$'
    WHEN 'solana' THEN value ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'
    ELSE false
  END
$function$;

CREATE OR REPLACE FUNCTION meowwa_chain_block_hash_ok(chain_key text, value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE public.meowwa_chain_family(chain_key)
    WHEN 'evm' THEN value ~ '^0x[0-9a-f]{64}$'
    WHEN 'solana' THEN value ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
    ELSE false
  END
$function$;

-- Canonical USDC per chain: the ERC-20 contract (lowercase, as the ledger stores EVM addresses)
-- or the SPL mint. Replaces the two literals baked into the 011 and 028 CHECKs.
CREATE OR REPLACE FUNCTION meowwa_chain_usdc_asset(chain_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT CASE chain_key
    WHEN 'base' THEN '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    WHEN 'base_sepolia' THEN '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
    WHEN 'solana' THEN 'EPjFWdd5AufqSSqeM4tf7UfF2h3kRFzJMbPfEqTLu3bT'
    WHEN 'solana_devnet' THEN '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
  END
$function$;

-- The rollout bridge described above. Fires on UPDATE as well as INSERT for the wallet bindings
-- because the previous wallet-provisioner image attests production funding with
-- `SET funding_chain_id = 8453` and nothing else, and the all-or-none CHECK below would refuse
-- that row without a derived funding_chain_key.
CREATE OR REPLACE FUNCTION meowwa_derive_chain_key()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.chain_key IS NULL THEN
    NEW.chain_key := public.meowwa_chain_key_for_id(NEW.chain_id);
  END IF;
  IF TG_TABLE_NAME = 'meowwa_pet_wallet_bindings' THEN
    IF NEW.funding_chain_key IS NULL THEN
      NEW.funding_chain_key := public.meowwa_chain_key_for_id(NEW.funding_chain_id);
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

-- ---------------------------------------------------------------------------------------------
-- meowwa_pet_wallet_bindings: the control-plane binding (base_sepolia | solana_devnet) and its
-- production funding attestation (base | solana). One binding per pet per chain, so a pet can
-- hold one EVM and one Solana wallet.
-- ---------------------------------------------------------------------------------------------

-- The revision trigger names smart_wallet_address in its UPDATE OF list, which blocks changing
-- that column's type; it is recreated below with the chain_key columns added.
DROP TRIGGER IF EXISTS meowwa_pet_wallet_bindings_revision ON meowwa_pet_wallet_bindings;

ALTER TABLE meowwa_pet_wallet_bindings
  ADD COLUMN IF NOT EXISTS chain_key text,
  ADD COLUMN IF NOT EXISTS funding_chain_key text;

UPDATE meowwa_pet_wallet_bindings
  SET chain_key = meowwa_chain_key_for_id(chain_id)
  WHERE chain_key IS NULL;
UPDATE meowwa_pet_wallet_bindings
  SET funding_chain_key = meowwa_chain_key_for_id(funding_chain_id)
  WHERE funding_chain_key IS NULL AND funding_chain_id IS NOT NULL;

ALTER TABLE meowwa_pet_wallet_bindings
  ALTER COLUMN chain_key SET NOT NULL,
  ALTER COLUMN chain_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS meowwa_pet_wallet_bindings_chain_id_check,
  DROP CONSTRAINT IF EXISTS meowwa_pet_wallet_bindings_chain_key_check,
  DROP CONSTRAINT IF EXISTS meowwa_pet_wallet_bindings_smart_wallet_address_check,
  DROP CONSTRAINT IF EXISTS meowwa_pet_wallet_bindings_chain_id_smart_wallet_address_key,
  DROP CONSTRAINT IF EXISTS meowwa_pet_wallet_bindings_chain_key_smart_wallet_address_key,
  DROP CONSTRAINT IF EXISTS meowwa_pet_wallet_bindings_tenant_id_pet_id_key,
  DROP CONSTRAINT IF EXISTS meowwa_pet_wallet_bindings_tenant_id_pet_id_chain_key_key,
  DROP CONSTRAINT IF EXISTS meowwa_pet_wallet_production_funding_all_or_none;

DROP INDEX IF EXISTS meowwa_pet_wallet_production_funding;

ALTER TABLE meowwa_pet_wallet_bindings
  ALTER COLUMN smart_wallet_address TYPE text USING rtrim(smart_wallet_address);

ALTER TABLE meowwa_pet_wallet_bindings
  ADD CONSTRAINT meowwa_pet_wallet_bindings_chain_key_check CHECK (
    chain_key IN ('base_sepolia', 'solana_devnet')
    AND meowwa_chain_key_consistent(chain_key, chain_id)
  ),
  ADD CONSTRAINT meowwa_pet_wallet_bindings_smart_wallet_address_check CHECK (
    meowwa_chain_address_ok(chain_key, smart_wallet_address)
  ),
  ADD CONSTRAINT meowwa_pet_wallet_bindings_chain_key_smart_wallet_address_key
    UNIQUE (chain_key, smart_wallet_address),
  ADD CONSTRAINT meowwa_pet_wallet_bindings_tenant_id_pet_id_chain_key_key
    UNIQUE (tenant_id, pet_id, chain_key),
  ADD CONSTRAINT meowwa_pet_wallet_production_funding_all_or_none CHECK (
    (funding_chain_key IS NULL AND funding_chain_id IS NULL AND funding_environment IS NULL
      AND custody_classification IS NULL AND funding_verified_at IS NULL)
    OR
    (funding_chain_key IN ('base', 'solana')
      AND meowwa_chain_key_consistent(funding_chain_key, funding_chain_id)
      AND funding_environment = 'production'
      AND custody_classification = 'owner_controlled' AND funding_verified_at IS NOT NULL)
  );

-- Serves meowwa_list_active_wallet_addresses per chain. COLLATE "C" so the index order is the
-- bytewise order the resolver pages in, which is also the order the worker's cursor compares in.
CREATE INDEX IF NOT EXISTS meowwa_pet_wallet_production_funding
  ON meowwa_pet_wallet_bindings (funding_chain_key, smart_wallet_address COLLATE "C")
  WHERE funding_chain_key IS NOT NULL
    AND funding_environment = 'production'
    AND custody_classification = 'owner_controlled'
    AND funding_verified_at IS NOT NULL
    AND status IN ('active', 'provisioning');

-- One global wallet-set revision for both families: an indexer that rescans because the other
-- family's set changed does harmless extra work, whereas a per-chain revision the previous image
-- does not bump would let a new wallet be skipped by an in-flight page.
CREATE OR REPLACE FUNCTION meowwa_bump_wallet_set_revision()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  old_eligible boolean := false;
  new_eligible boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_eligible := OLD.status IN ('active', 'provisioning')
      AND OLD.funding_chain_key IS NOT NULL
      AND OLD.funding_environment = 'production'
      AND OLD.custody_classification = 'owner_controlled'
      AND OLD.funding_verified_at IS NOT NULL;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_eligible := NEW.status IN ('active', 'provisioning')
      AND NEW.funding_chain_key IS NOT NULL
      AND NEW.funding_environment = 'production'
      AND NEW.custody_classification = 'owner_controlled'
      AND NEW.funding_verified_at IS NOT NULL;
  END IF;
  IF old_eligible IS DISTINCT FROM new_eligible OR
     (old_eligible AND new_eligible AND (
       OLD.smart_wallet_address IS DISTINCT FROM NEW.smart_wallet_address OR
       OLD.funding_chain_key IS DISTINCT FROM NEW.funding_chain_key
     )) THEN
    UPDATE public.meowwa_wallet_set_revision
    SET revision = revision + 1, updated_at = transaction_timestamp()
    WHERE singleton = true;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$function$;

DROP TRIGGER IF EXISTS meowwa_pet_wallet_bindings_derive_chain_key ON meowwa_pet_wallet_bindings;
CREATE TRIGGER meowwa_pet_wallet_bindings_derive_chain_key
BEFORE INSERT OR UPDATE ON meowwa_pet_wallet_bindings
FOR EACH ROW EXECUTE FUNCTION meowwa_derive_chain_key();

CREATE TRIGGER meowwa_pet_wallet_bindings_revision
AFTER INSERT OR DELETE OR UPDATE OF
  status, smart_wallet_address, chain_key, funding_chain_key, funding_chain_id,
  funding_environment, custody_classification, funding_verified_at
ON meowwa_pet_wallet_bindings
FOR EACH ROW EXECUTE FUNCTION meowwa_bump_wallet_set_revision();

GRANT UPDATE (funding_chain_key) ON meowwa_pet_wallet_bindings TO meowwa_wallet_provisioner;

-- ---------------------------------------------------------------------------------------------
-- meowwa_funding_transactions (base | solana)
-- ---------------------------------------------------------------------------------------------

-- A policy that names a column pins its type. These three read transaction_hash; they come back
-- unchanged below except for the direct-funding chain predicate.
DROP POLICY IF EXISTS app_create_pending_funding_transactions ON meowwa_funding_transactions;
DROP POLICY IF EXISTS app_update_pending_funding_session ON meowwa_funding_transactions;
DROP POLICY IF EXISTS financial_worker_create_direct_funding ON meowwa_funding_transactions;

ALTER TABLE meowwa_funding_transactions
  ADD COLUMN IF NOT EXISTS chain_key text;

UPDATE meowwa_funding_transactions
  SET chain_key = meowwa_chain_key_for_id(chain_id)
  WHERE chain_key IS NULL;

ALTER TABLE meowwa_funding_transactions
  ALTER COLUMN chain_key SET NOT NULL,
  ALTER COLUMN chain_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS meowwa_funding_transactions_chain_id_check,
  DROP CONSTRAINT IF EXISTS meowwa_funding_transactions_chain_key_check,
  DROP CONSTRAINT IF EXISTS meowwa_funding_transactions_wallet_address_check,
  DROP CONSTRAINT IF EXISTS meowwa_funding_transactions_transaction_hash_check;

ALTER TABLE meowwa_funding_transactions
  ALTER COLUMN wallet_address TYPE text USING rtrim(wallet_address),
  ALTER COLUMN transaction_hash TYPE text USING rtrim(transaction_hash);

ALTER TABLE meowwa_funding_transactions
  ADD CONSTRAINT meowwa_funding_transactions_chain_key_check CHECK (
    chain_key IN ('base', 'solana') AND meowwa_chain_key_consistent(chain_key, chain_id)
  ),
  ADD CONSTRAINT meowwa_funding_transactions_wallet_address_check CHECK (
    meowwa_chain_address_ok(chain_key, wallet_address)
  ),
  ADD CONSTRAINT meowwa_funding_transactions_transaction_hash_check CHECK (
    transaction_hash IS NULL OR meowwa_chain_tx_ok(chain_key, transaction_hash)
  );

CREATE POLICY app_create_pending_funding_transactions ON meowwa_funding_transactions
  FOR INSERT TO meowwa_app
  WITH CHECK (
    status = 'pending'
    AND reconciliation_status IN ('awaiting_provider', 'awaiting_chain')
    AND destination_amount_atomic IS NULL
    AND transaction_hash IS NULL
    AND failure_code IS NULL
  );
CREATE POLICY app_update_pending_funding_session ON meowwa_funding_transactions
  FOR UPDATE TO meowwa_app
  USING (status = 'pending' AND reconciliation_status = 'awaiting_provider')
  WITH CHECK (
    status = 'pending'
    AND reconciliation_status = 'awaiting_provider'
    AND destination_amount_atomic IS NULL
    AND transaction_hash IS NULL
    AND failure_code IS NULL
  );
CREATE POLICY financial_worker_create_direct_funding ON meowwa_funding_transactions
  FOR INSERT TO meowwa_financial_worker
  WITH CHECK (
    rail = 'direct_usdc'
    AND status = 'settled'
    AND reconciliation_status = 'confirmed'
    AND source_currency IS NULL
    AND source_amount_minor IS NULL
    AND destination_currency = 'usdc'
    AND destination_amount_atomic > 0
    AND chain_key IN ('base', 'solana')
    AND provider IS NULL
    AND provider_session_id IS NULL
    AND transaction_hash IS NOT NULL
    AND failure_code IS NULL
  );

DROP TRIGGER IF EXISTS meowwa_funding_transactions_derive_chain_key ON meowwa_funding_transactions;
CREATE TRIGGER meowwa_funding_transactions_derive_chain_key
BEFORE INSERT ON meowwa_funding_transactions
FOR EACH ROW EXECUTE FUNCTION meowwa_derive_chain_key();

-- ---------------------------------------------------------------------------------------------
-- meowwa_wallet_chain_events: the event identity moves onto chain_key because a primary key
-- cannot hold the NULL chain_id a Solana row carries.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE meowwa_wallet_chain_events
  ADD COLUMN IF NOT EXISTS chain_key text;

UPDATE meowwa_wallet_chain_events
  SET chain_key = meowwa_chain_key_for_id(chain_id)
  WHERE chain_key IS NULL;

DROP INDEX IF EXISTS meowwa_wallet_chain_events_log_direction_unique;

-- A column still inside a primary key cannot drop NOT NULL, so the key goes first, on its own.
ALTER TABLE meowwa_wallet_chain_events
  DROP CONSTRAINT IF EXISTS meowwa_wallet_chain_events_pkey;

ALTER TABLE meowwa_wallet_chain_events
  ALTER COLUMN chain_key SET NOT NULL,
  ALTER COLUMN chain_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS meowwa_wallet_chain_events_chain_id_check,
  DROP CONSTRAINT IF EXISTS meowwa_wallet_chain_events_chain_key_check,
  DROP CONSTRAINT IF EXISTS meowwa_wallet_chain_events_transaction_hash_check,
  DROP CONSTRAINT IF EXISTS meowwa_wallet_chain_events_block_hash_check,
  DROP CONSTRAINT IF EXISTS meowwa_wallet_chain_events_counterparty_address_check;

ALTER TABLE meowwa_wallet_chain_events
  ALTER COLUMN transaction_hash TYPE text USING rtrim(transaction_hash),
  ALTER COLUMN block_hash TYPE text USING rtrim(block_hash),
  ALTER COLUMN counterparty_address TYPE text USING rtrim(counterparty_address);

ALTER TABLE meowwa_wallet_chain_events
  ADD CONSTRAINT meowwa_wallet_chain_events_chain_key_check CHECK (
    chain_key IN ('base', 'solana') AND meowwa_chain_key_consistent(chain_key, chain_id)
  ),
  ADD CONSTRAINT meowwa_wallet_chain_events_transaction_hash_check CHECK (
    meowwa_chain_tx_ok(chain_key, transaction_hash)
  ),
  ADD CONSTRAINT meowwa_wallet_chain_events_block_hash_check CHECK (
    meowwa_chain_block_hash_ok(chain_key, block_hash)
  ),
  ADD CONSTRAINT meowwa_wallet_chain_events_counterparty_address_check CHECK (
    counterparty_address IS NULL OR meowwa_chain_address_ok(chain_key, counterparty_address)
  ),
  ADD CONSTRAINT meowwa_wallet_chain_events_pkey
    PRIMARY KEY (tenant_id, chain_key, transaction_hash, log_index, wallet_id, direction);

-- One log (or instruction) may produce one managed credit and one managed debit, but it must
-- never credit two wallets or tenants in the same direction (019).
CREATE UNIQUE INDEX IF NOT EXISTS meowwa_wallet_chain_events_log_direction_unique
  ON meowwa_wallet_chain_events (chain_key, transaction_hash, log_index, direction);

DROP TRIGGER IF EXISTS meowwa_wallet_chain_events_derive_chain_key ON meowwa_wallet_chain_events;
CREATE TRIGGER meowwa_wallet_chain_events_derive_chain_key
BEFORE INSERT ON meowwa_wallet_chain_events
FOR EACH ROW EXECUTE FUNCTION meowwa_derive_chain_key();

-- ---------------------------------------------------------------------------------------------
-- meowwa_chain_scan_cursors and meowwa_chain_scan_checkpoints: one cursor per (chain, asset).
-- The checkpoint FK follows the cursor key, so it is dropped first and re-added last.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE meowwa_chain_scan_checkpoints
  DROP CONSTRAINT IF EXISTS meowwa_chain_scan_checkpoints_chain_id_contract_address_fkey,
  DROP CONSTRAINT IF EXISTS meowwa_chain_scan_checkpoints_chain_key_contract_address_fkey,
  DROP CONSTRAINT IF EXISTS meowwa_chain_scan_checkpoints_pkey;

ALTER TABLE meowwa_chain_scan_cursors
  ADD COLUMN IF NOT EXISTS chain_key text;
ALTER TABLE meowwa_chain_scan_checkpoints
  ADD COLUMN IF NOT EXISTS chain_key text;

UPDATE meowwa_chain_scan_cursors
  SET chain_key = meowwa_chain_key_for_id(chain_id)
  WHERE chain_key IS NULL;
UPDATE meowwa_chain_scan_checkpoints
  SET chain_key = meowwa_chain_key_for_id(chain_id)
  WHERE chain_key IS NULL;

ALTER TABLE meowwa_chain_scan_cursors
  DROP CONSTRAINT IF EXISTS meowwa_chain_scan_cursors_pkey;

ALTER TABLE meowwa_chain_scan_cursors
  ALTER COLUMN chain_key SET NOT NULL,
  ALTER COLUMN chain_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS meowwa_chain_scan_cursors_chain_id_check,
  DROP CONSTRAINT IF EXISTS meowwa_chain_scan_cursors_chain_key_check,
  DROP CONSTRAINT IF EXISTS meowwa_chain_scan_cursors_contract_address_check;

ALTER TABLE meowwa_chain_scan_cursors
  ALTER COLUMN contract_address TYPE text USING rtrim(contract_address);

ALTER TABLE meowwa_chain_scan_cursors
  ADD CONSTRAINT meowwa_chain_scan_cursors_chain_key_check CHECK (
    chain_key IN ('base', 'solana') AND meowwa_chain_key_consistent(chain_key, chain_id)
  ),
  ADD CONSTRAINT meowwa_chain_scan_cursors_contract_address_check CHECK (
    meowwa_chain_address_ok(chain_key, contract_address)
  ),
  ADD CONSTRAINT meowwa_chain_scan_cursors_pkey PRIMARY KEY (chain_key, contract_address);

DROP TRIGGER IF EXISTS meowwa_chain_scan_cursors_derive_chain_key ON meowwa_chain_scan_cursors;
CREATE TRIGGER meowwa_chain_scan_cursors_derive_chain_key
BEFORE INSERT ON meowwa_chain_scan_cursors
FOR EACH ROW EXECUTE FUNCTION meowwa_derive_chain_key();

ALTER TABLE meowwa_chain_scan_checkpoints
  ALTER COLUMN chain_key SET NOT NULL,
  ALTER COLUMN chain_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS meowwa_chain_scan_checkpoints_chain_id_check,
  DROP CONSTRAINT IF EXISTS meowwa_chain_scan_checkpoints_chain_key_check,
  DROP CONSTRAINT IF EXISTS meowwa_chain_scan_checkpoints_contract_address_check,
  DROP CONSTRAINT IF EXISTS meowwa_chain_scan_checkpoints_block_hash_check;

ALTER TABLE meowwa_chain_scan_checkpoints
  ALTER COLUMN contract_address TYPE text USING rtrim(contract_address),
  ALTER COLUMN block_hash TYPE text USING rtrim(block_hash);

ALTER TABLE meowwa_chain_scan_checkpoints
  ADD CONSTRAINT meowwa_chain_scan_checkpoints_chain_key_check CHECK (
    chain_key IN ('base', 'solana') AND meowwa_chain_key_consistent(chain_key, chain_id)
  ),
  ADD CONSTRAINT meowwa_chain_scan_checkpoints_contract_address_check CHECK (
    meowwa_chain_address_ok(chain_key, contract_address)
  ),
  ADD CONSTRAINT meowwa_chain_scan_checkpoints_block_hash_check CHECK (
    meowwa_chain_block_hash_ok(chain_key, block_hash)
  ),
  ADD CONSTRAINT meowwa_chain_scan_checkpoints_pkey
    PRIMARY KEY (chain_key, contract_address, block_number),
  ADD CONSTRAINT meowwa_chain_scan_checkpoints_chain_key_contract_address_fkey
    FOREIGN KEY (chain_key, contract_address)
    REFERENCES meowwa_chain_scan_cursors(chain_key, contract_address) ON DELETE CASCADE;

DROP TRIGGER IF EXISTS meowwa_chain_scan_checkpoints_derive_chain_key ON meowwa_chain_scan_checkpoints;
CREATE TRIGGER meowwa_chain_scan_checkpoints_derive_chain_key
BEFORE INSERT ON meowwa_chain_scan_checkpoints
FOR EACH ROW EXECUTE FUNCTION meowwa_derive_chain_key();

-- ---------------------------------------------------------------------------------------------
-- meowwa_chain_reorg_halts: a halt is per chain, so one chain's divergence is recorded and
-- gated on its own key.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE meowwa_chain_reorg_halts
  ADD COLUMN IF NOT EXISTS chain_key text;

UPDATE meowwa_chain_reorg_halts
  SET chain_key = meowwa_chain_key_for_id(chain_id)
  WHERE chain_key IS NULL;

DROP INDEX IF EXISTS meowwa_chain_reorg_halts_open;

ALTER TABLE meowwa_chain_reorg_halts
  ALTER COLUMN chain_key SET NOT NULL,
  ALTER COLUMN chain_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS meowwa_chain_reorg_halts_chain_id_check,
  DROP CONSTRAINT IF EXISTS meowwa_chain_reorg_halts_chain_key_check,
  DROP CONSTRAINT IF EXISTS meowwa_chain_reorg_halts_checkpoint_block_hash_check;

ALTER TABLE meowwa_chain_reorg_halts
  ALTER COLUMN checkpoint_block_hash TYPE text USING rtrim(checkpoint_block_hash);

ALTER TABLE meowwa_chain_reorg_halts
  ADD CONSTRAINT meowwa_chain_reorg_halts_chain_key_check CHECK (
    chain_key IN ('base', 'solana') AND meowwa_chain_key_consistent(chain_key, chain_id)
  ),
  ADD CONSTRAINT meowwa_chain_reorg_halts_checkpoint_block_hash_check CHECK (
    meowwa_chain_block_hash_ok(chain_key, checkpoint_block_hash)
  );

-- Dedup scopes to OPEN rows only, as 040 made it, now keyed on the chain.
CREATE UNIQUE INDEX IF NOT EXISTS meowwa_chain_reorg_halts_open
  ON meowwa_chain_reorg_halts (chain_key, checkpoint_block_number, checkpoint_block_hash)
  WHERE resolved_at IS NULL;

-- The previous financial-worker image records a halt with
-- `ON CONFLICT (chain_id, checkpoint_block_number, checkpoint_block_hash) WHERE resolved_at IS NULL`,
-- and an arbiter no unique index matches is a runtime error on the one path that must not fail.
-- This index keeps that statement valid through the rollout. For a Base row it agrees with the
-- chain_key index exactly (the CHECK ties chain_id 8453 to 'base'); for a Solana row chain_id is
-- NULL, which never conflicts, so the chain_key index alone decides.
CREATE UNIQUE INDEX IF NOT EXISTS meowwa_chain_reorg_halts_open_legacy_chain_id
  ON meowwa_chain_reorg_halts (chain_id, checkpoint_block_number, checkpoint_block_hash)
  WHERE resolved_at IS NULL;

DROP TRIGGER IF EXISTS meowwa_chain_reorg_halts_derive_chain_key ON meowwa_chain_reorg_halts;
CREATE TRIGGER meowwa_chain_reorg_halts_derive_chain_key
BEFORE INSERT ON meowwa_chain_reorg_halts
FOR EACH ROW EXECUTE FUNCTION meowwa_derive_chain_key();

-- ---------------------------------------------------------------------------------------------
-- meowwa_withdrawal_destinations (base | solana): one active registration per (tenant, chain,
-- address). 026 refused to repoint a destination across networks; backfilling the key from the
-- chain_id it already has is the same network, so nothing is repointed here either.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE meowwa_withdrawal_destinations
  ADD COLUMN IF NOT EXISTS chain_key text;

UPDATE meowwa_withdrawal_destinations
  SET chain_key = meowwa_chain_key_for_id(chain_id)
  WHERE chain_key IS NULL;

DROP INDEX IF EXISTS meowwa_withdrawal_destinations_active_address;

ALTER TABLE meowwa_withdrawal_destinations
  ALTER COLUMN chain_key SET NOT NULL,
  ALTER COLUMN chain_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS meowwa_withdrawal_destinations_chain_id_check,
  DROP CONSTRAINT IF EXISTS meowwa_withdrawal_destinations_chain_key_check,
  DROP CONSTRAINT IF EXISTS meowwa_withdrawal_destinations_address_check;

ALTER TABLE meowwa_withdrawal_destinations
  ALTER COLUMN address TYPE text USING rtrim(address);

ALTER TABLE meowwa_withdrawal_destinations
  ADD CONSTRAINT meowwa_withdrawal_destinations_chain_key_check CHECK (
    chain_key IN ('base', 'solana') AND meowwa_chain_key_consistent(chain_key, chain_id)
  ),
  ADD CONSTRAINT meowwa_withdrawal_destinations_address_check CHECK (
    meowwa_chain_address_ok(chain_key, address)
  );

CREATE UNIQUE INDEX IF NOT EXISTS meowwa_withdrawal_destinations_active_address
  ON meowwa_withdrawal_destinations (tenant_id, chain_key, address)
  WHERE status = 'active';

DROP TRIGGER IF EXISTS meowwa_withdrawal_destinations_derive_chain_key ON meowwa_withdrawal_destinations;
CREATE TRIGGER meowwa_withdrawal_destinations_derive_chain_key
BEFORE INSERT ON meowwa_withdrawal_destinations
FOR EACH ROW EXECUTE FUNCTION meowwa_derive_chain_key();

-- ---------------------------------------------------------------------------------------------
-- meowwa_withdrawals (base | solana): the token is the chain's canonical USDC, the broadcast
-- leg is unique per (tenant, chain, hash).
-- ---------------------------------------------------------------------------------------------

-- Every per-transition policy (028, 034, 035, 038) reads transaction_hash and so pins its type.
-- They are recreated below verbatim.
DROP POLICY IF EXISTS app_prepare_withdrawals ON meowwa_withdrawals;
DROP POLICY IF EXISTS app_dispatch_withdrawals ON meowwa_withdrawals;
DROP POLICY IF EXISTS app_broadcast_withdrawals ON meowwa_withdrawals;
DROP POLICY IF EXISTS app_cancel_withdrawals ON meowwa_withdrawals;
DROP POLICY IF EXISTS app_expire_withdrawals ON meowwa_withdrawals;
DROP POLICY IF EXISTS app_flag_withdrawal_review ON meowwa_withdrawals;

ALTER TABLE meowwa_withdrawals
  ADD COLUMN IF NOT EXISTS chain_key text;

UPDATE meowwa_withdrawals
  SET chain_key = meowwa_chain_key_for_id(chain_id)
  WHERE chain_key IS NULL;

DROP INDEX IF EXISTS meowwa_withdrawals_transaction_leg;

ALTER TABLE meowwa_withdrawals
  ALTER COLUMN chain_key SET NOT NULL,
  ALTER COLUMN chain_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS meowwa_withdrawals_chain_id_check,
  DROP CONSTRAINT IF EXISTS meowwa_withdrawals_chain_key_check,
  DROP CONSTRAINT IF EXISTS meowwa_withdrawals_destination_address_check,
  DROP CONSTRAINT IF EXISTS meowwa_withdrawals_token_address_check,
  DROP CONSTRAINT IF EXISTS meowwa_withdrawals_transaction_hash_check;

ALTER TABLE meowwa_withdrawals
  ALTER COLUMN destination_address TYPE text USING rtrim(destination_address),
  ALTER COLUMN token_address TYPE text USING rtrim(token_address),
  ALTER COLUMN transaction_hash TYPE text USING rtrim(transaction_hash);

ALTER TABLE meowwa_withdrawals
  ADD CONSTRAINT meowwa_withdrawals_chain_key_check CHECK (
    chain_key IN ('base', 'solana') AND meowwa_chain_key_consistent(chain_key, chain_id)
  ),
  ADD CONSTRAINT meowwa_withdrawals_destination_address_check CHECK (
    meowwa_chain_address_ok(chain_key, destination_address)
  ),
  ADD CONSTRAINT meowwa_withdrawals_token_address_check CHECK (
    token_address = meowwa_chain_usdc_asset(chain_key)
  ),
  ADD CONSTRAINT meowwa_withdrawals_transaction_hash_check CHECK (
    transaction_hash IS NULL OR meowwa_chain_tx_ok(chain_key, transaction_hash)
  );

-- Per tenant, as 034 made it: one tenant's row must never block another from recording that
-- its own funds moved.
CREATE UNIQUE INDEX IF NOT EXISTS meowwa_withdrawals_transaction_leg
  ON meowwa_withdrawals (tenant_id, chain_key, transaction_hash)
  WHERE transaction_hash IS NOT NULL;

CREATE POLICY app_prepare_withdrawals ON meowwa_withdrawals
  FOR INSERT TO meowwa_app
  WITH CHECK (
    submission_status = 'awaiting_owner_signature' AND transaction_hash IS NULL AND broadcast_at IS NULL
  );

CREATE POLICY app_dispatch_withdrawals ON meowwa_withdrawals
  FOR UPDATE TO meowwa_app
  USING (
    submission_status = 'awaiting_owner_signature' AND
    transaction_hash IS NULL AND
    broadcast_at IS NULL AND
    cancelled_at IS NULL AND
    expired_at IS NULL AND
    dispatched_at IS NULL
  )
  WITH CHECK (
    submission_status = 'awaiting_owner_signature' AND
    transaction_hash IS NULL AND
    broadcast_at IS NULL AND
    cancelled_at IS NULL AND
    expired_at IS NULL AND
    dispatched_at IS NOT NULL
  );

CREATE POLICY app_broadcast_withdrawals ON meowwa_withdrawals
  FOR UPDATE TO meowwa_app
  USING (
    submission_status = 'awaiting_owner_signature' AND
    transaction_hash IS NULL AND
    cancelled_at IS NULL AND
    dispatched_at IS NOT NULL
  )
  WITH CHECK (
    submission_status = 'broadcast' AND
    transaction_hash IS NOT NULL AND
    broadcast_at IS NOT NULL AND
    cancelled_at IS NULL AND
    dispatched_at IS NOT NULL
  );

CREATE POLICY app_cancel_withdrawals ON meowwa_withdrawals
  FOR UPDATE TO meowwa_app
  USING (
    submission_status = 'awaiting_owner_signature' AND
    transaction_hash IS NULL AND
    broadcast_at IS NULL AND
    cancelled_at IS NULL AND
    expired_at IS NULL
  )
  WITH CHECK (
    submission_status = 'awaiting_owner_signature' AND
    transaction_hash IS NULL AND
    broadcast_at IS NULL AND
    cancelled_at IS NOT NULL AND
    expired_at IS NULL
  );

CREATE POLICY app_expire_withdrawals ON meowwa_withdrawals
  FOR UPDATE TO meowwa_app
  USING (
    submission_status = 'awaiting_owner_signature' AND
    transaction_hash IS NULL AND
    broadcast_at IS NULL AND
    cancelled_at IS NULL AND
    expired_at IS NULL AND
    dispatched_at IS NULL
  )
  WITH CHECK (
    submission_status = 'awaiting_owner_signature' AND
    transaction_hash IS NULL AND
    broadcast_at IS NULL AND
    cancelled_at IS NULL AND
    expired_at IS NOT NULL AND
    dispatched_at IS NULL
  );

CREATE POLICY app_flag_withdrawal_review ON meowwa_withdrawals
  FOR UPDATE TO meowwa_app
  USING (
    submission_status = 'awaiting_owner_signature' AND
    transaction_hash IS NULL AND
    broadcast_at IS NULL AND
    cancelled_at IS NULL AND
    expired_at IS NULL AND
    dispatched_at IS NOT NULL AND
    review_required_at IS NULL
  )
  WITH CHECK (
    submission_status = 'awaiting_owner_signature' AND
    transaction_hash IS NULL AND
    broadcast_at IS NULL AND
    cancelled_at IS NULL AND
    expired_at IS NULL AND
    dispatched_at IS NOT NULL AND
    review_required_at IS NOT NULL
  );

DROP TRIGGER IF EXISTS meowwa_withdrawals_derive_chain_key ON meowwa_withdrawals;
CREATE TRIGGER meowwa_withdrawals_derive_chain_key
BEFORE INSERT ON meowwa_withdrawals
FOR EACH ROW EXECUTE FUNCTION meowwa_derive_chain_key();

-- ---------------------------------------------------------------------------------------------
-- meowwa_wallet_execution_submissions: agent execution stays on Base Sepolia. The key is added
-- so the row names its chain like every other, and the constraint says the rail is not built.
-- The ERC-20 CHECKs (contract, calldata, hashes) are deliberately unchanged.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE meowwa_wallet_execution_submissions
  ADD COLUMN IF NOT EXISTS chain_key text;

UPDATE meowwa_wallet_execution_submissions
  SET chain_key = meowwa_chain_key_for_id(chain_id)
  WHERE chain_key IS NULL;

DROP INDEX IF EXISTS meowwa_wallet_execution_chain_log_unique;

ALTER TABLE meowwa_wallet_execution_submissions
  ALTER COLUMN chain_key SET NOT NULL,
  ALTER COLUMN chain_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS meowwa_wallet_execution_submissions_chain_id_check,
  DROP CONSTRAINT IF EXISTS meowwa_wallet_execution_submissions_chain_key_check;

ALTER TABLE meowwa_wallet_execution_submissions
  ADD CONSTRAINT meowwa_wallet_execution_submissions_chain_key_check CHECK (
    chain_key = 'base_sepolia' AND meowwa_chain_key_consistent(chain_key, chain_id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS meowwa_wallet_execution_chain_log_unique
  ON meowwa_wallet_execution_submissions (chain_key, transaction_hash, log_index)
  WHERE transaction_hash IS NOT NULL AND log_index IS NOT NULL;

DROP TRIGGER IF EXISTS meowwa_wallet_execution_submissions_derive_chain_key ON meowwa_wallet_execution_submissions;
CREATE TRIGGER meowwa_wallet_execution_submissions_derive_chain_key
BEFORE INSERT ON meowwa_wallet_execution_submissions
FOR EACH ROW EXECUTE FUNCTION meowwa_derive_chain_key();

-- ---------------------------------------------------------------------------------------------
-- meowwa_ledger_discrepancies: comparison_block_number is a slot on Solana, so the row has to
-- say which chain it compared against.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE meowwa_ledger_discrepancies
  ADD COLUMN IF NOT EXISTS chain_key text NOT NULL DEFAULT 'base'
    CHECK (chain_key IN ('base', 'solana'));

-- ---------------------------------------------------------------------------------------------
-- meowwa_public_receive_links: one link per pet per control chain, so the Solana wallet gets
-- its own receive token. token_hash stays globally unique and a wallet still has at most one.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE meowwa_public_receive_links
  ADD COLUMN IF NOT EXISTS chain_key text NOT NULL DEFAULT 'base_sepolia'
    CHECK (chain_key IN ('base_sepolia', 'solana_devnet'));

ALTER TABLE meowwa_public_receive_links
  DROP CONSTRAINT IF EXISTS meowwa_public_receive_links_pkey;
ALTER TABLE meowwa_public_receive_links
  ADD CONSTRAINT meowwa_public_receive_links_pkey PRIMARY KEY (tenant_id, pet_id, chain_key);

-- ---------------------------------------------------------------------------------------------
-- The worker's wallet resolvers, keyed on the funding chain. Parameter types change, so the old
-- signatures are dropped rather than replaced; migrate.ts tolerates them pre-migration.
-- ---------------------------------------------------------------------------------------------

DROP FUNCTION IF EXISTS meowwa_resolve_wallet_tenant(integer, char(42));
CREATE OR REPLACE FUNCTION meowwa_resolve_wallet_tenant(
  requested_chain_key text,
  requested_wallet_address text
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT wallet.tenant_id
  FROM public.meowwa_pet_wallet_bindings AS wallet
  WHERE wallet.funding_chain_key = requested_chain_key
    AND wallet.funding_environment = 'production'
    AND wallet.custody_classification = 'owner_controlled'
    AND wallet.funding_verified_at IS NOT NULL
    AND wallet.smart_wallet_address = requested_wallet_address
    AND wallet.status IN ('active', 'provisioning')
  LIMIT 1
$function$;

-- Pages in COLLATE "C" so the database order is the code-unit order the worker's cursor check
-- uses; hex is unaffected, and mixed-case base58 would otherwise disagree with it mid-scan.
DROP FUNCTION IF EXISTS meowwa_list_active_wallet_addresses(char(42), integer);
CREATE OR REPLACE FUNCTION meowwa_list_active_wallet_addresses(
  requested_chain_key text,
  after_address text,
  result_limit integer
)
RETURNS TABLE(wallet_address text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF result_limit IS NULL OR result_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'active wallet page limit is invalid';
  END IF;
  RETURN QUERY
    SELECT wallet.smart_wallet_address
    FROM public.meowwa_pet_wallet_bindings AS wallet
    WHERE wallet.funding_chain_key = requested_chain_key
      AND wallet.funding_environment = 'production'
      AND wallet.custody_classification = 'owner_controlled'
      AND wallet.funding_verified_at IS NOT NULL
      AND wallet.status IN ('active', 'provisioning')
      AND (after_address IS NULL
        OR wallet.smart_wallet_address COLLATE "C" > after_address COLLATE "C")
    ORDER BY wallet.smart_wallet_address COLLATE "C"
    LIMIT result_limit;
END
$function$;

REVOKE ALL ON FUNCTION meowwa_resolve_wallet_tenant(text, text)
  FROM PUBLIC, meowwa_app, meowwa_worker, meowwa_identity_resolver,
       meowwa_wallet_provisioner, meowwa_merchant_worker;
REVOKE ALL ON FUNCTION meowwa_list_active_wallet_addresses(text, text, integer)
  FROM PUBLIC, meowwa_app, meowwa_worker, meowwa_identity_resolver,
       meowwa_wallet_provisioner, meowwa_merchant_worker;
GRANT EXECUTE ON FUNCTION meowwa_resolve_wallet_tenant(text, text) TO meowwa_financial_worker;
GRANT EXECUTE ON FUNCTION meowwa_list_active_wallet_addresses(text, text, integer) TO meowwa_financial_worker;

-- ---------------------------------------------------------------------------------------------
-- meowwa_pet_deletion_blockers and meowwa_finalize_pet_deletion were written when a pet had one
-- binding: each read `SELECT * INTO v_binding ... WHERE tenant_id AND pet_id`, which is an
-- arbitrary pick once a pet holds one binding per family, so the archive, revocation, balance
-- and discrepancy checks would judge one wallet and the deletion stamp would land on one row.
-- Both now walk every binding row of the pet, and finalization stamps pet_deleted_at and
-- deletion_receipt_id on all of them -- the read inspectPetDeletion makes. The blockers function
-- also matched a broadcast withdrawal to its debit on chain_id; with a NULL chain_id
-- `NULL = NULL` is never true, so every broadcast Solana withdrawal would read as unsettled and
-- the pet could never be deleted: that join moves to chain_key. Everything else is migration
-- 049's body (blockers) and 046's (finalize).
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION meowwa_pet_deletion_blockers(p_tenant_id uuid, p_pet_id text)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_binding public.meowwa_pet_wallet_bindings%ROWTYPE;
  v_blockers text[] := ARRAY[]::text[];
  v_balance numeric(78, 0);
  v_bindings integer := 0;
  v_undeleted integer := 0;
  v_not_archived boolean := false;
  v_signer_not_revoked boolean := false;
  v_nonzero_balance boolean := false;
  v_discrepancy_open boolean := false;
BEGIN
  IF p_tenant_id IS NULL
    OR p_tenant_id::text IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')
    OR p_pet_id IS NULL OR length(p_pet_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'pet deletion tenant context mismatch' USING ERRCODE = '42501';
  END IF;

  -- One binding per family: every row is judged, and a row already stamped deleted contributes
  -- nothing, exactly as the single deleted binding used to return no blockers.
  FOR v_binding IN
    SELECT *
    FROM public.meowwa_pet_wallet_bindings
    WHERE tenant_id = p_tenant_id AND pet_id = p_pet_id
    ORDER BY chain_key
  LOOP
    v_bindings := v_bindings + 1;
    IF v_binding.pet_deleted_at IS NOT NULL THEN CONTINUE; END IF;
    v_undeleted := v_undeleted + 1;

    IF v_binding.archived_at IS NULL THEN v_not_archived := true; END IF;
    IF v_binding.status <> 'revoked' THEN v_signer_not_revoked := true; END IF;

    SELECT COALESCE(SUM(CASE direction WHEN 'credit' THEN amount_atomic ELSE -amount_atomic END), 0)
      INTO v_balance
    FROM public.meowwa_wallet_ledger_entries
    WHERE tenant_id = p_tenant_id AND wallet_id = v_binding.wallet_id;
    IF v_balance <> 0 THEN v_nonzero_balance := true; END IF;

    IF EXISTS (
      SELECT 1 FROM public.meowwa_ledger_discrepancies
      WHERE tenant_id = p_tenant_id AND wallet_id = v_binding.wallet_id AND resolved_at IS NULL
    ) THEN v_discrepancy_open := true; END IF;
  END LOOP;

  IF v_bindings = 0 THEN RETURN ARRAY['not_found']; END IF;
  IF v_undeleted = 0 THEN RETURN v_blockers; END IF;

  IF v_not_archived THEN v_blockers := array_append(v_blockers, 'not_archived'); END IF;
  IF v_signer_not_revoked THEN v_blockers := array_append(v_blockers, 'signer_not_revoked'); END IF;
  IF v_nonzero_balance THEN v_blockers := array_append(v_blockers, 'nonzero_balance'); END IF;

  IF EXISTS (
    SELECT 1 FROM public.meowwa_funding_transactions
    WHERE tenant_id = p_tenant_id AND pet_id = p_pet_id
      AND (status = 'pending' OR reconciliation_status IN (
        'awaiting_provider', 'awaiting_chain', 'chargeback_review', 'manual_review'
      ))
  ) THEN v_blockers := array_append(v_blockers, 'funding_unsettled'); END IF;

  IF EXISTS (
    SELECT 1 FROM public.meowwa_wallet_execution_submissions
    WHERE tenant_id = p_tenant_id AND pet_id = p_pet_id
      AND (status IN ('prepared', 'submitting', 'submitted', 'provider_confirmed', 'unknown', 'review_required')
        OR (status = 'confirmed' AND application_settled_at IS NULL))
  ) THEN v_blockers := array_append(v_blockers, 'payment_unsettled'); END IF;

  IF EXISTS (
    SELECT 1 FROM public.meowwa_merchant_orders
    WHERE tenant_id = p_tenant_id AND pet_id = p_pet_id
      AND (status IN ('prepared', 'submitting', 'submitted', 'unknown', 'cancel_pending', 'review_required')
        OR (status IN ('confirmed', 'fulfilled') AND application_settled_at IS NULL))
  ) OR EXISTS (
    SELECT 1
    FROM public.meowwa_merchant_refunds AS refund
    JOIN public.meowwa_merchant_orders AS merchant_order
      ON merchant_order.tenant_id = refund.tenant_id AND merchant_order.order_id = refund.order_id
    WHERE merchant_order.tenant_id = p_tenant_id AND merchant_order.pet_id = p_pet_id
      AND (refund.status IN ('prepared', 'submitting', 'submitted', 'provider_confirmed', 'unknown', 'review_required')
        OR (refund.status = 'chain_confirmed' AND refund.application_settled_at IS NULL))
  ) THEN v_blockers := array_append(v_blockers, 'merchant_unsettled'); END IF;

  IF EXISTS (
    SELECT 1
    FROM public.meowwa_withdrawals AS withdrawal
    WHERE withdrawal.tenant_id = p_tenant_id AND withdrawal.pet_id = p_pet_id
      AND (
        withdrawal.review_required_at IS NOT NULL
        OR (withdrawal.submission_status = 'awaiting_owner_signature'
          AND withdrawal.cancelled_at IS NULL AND withdrawal.expired_at IS NULL)
        OR (withdrawal.submission_status = 'broadcast' AND NOT EXISTS (
          SELECT 1 FROM public.meowwa_wallet_chain_events AS chain
          WHERE chain.tenant_id = withdrawal.tenant_id
            AND chain.chain_key = withdrawal.chain_key
            AND chain.transaction_hash = withdrawal.transaction_hash
            AND chain.wallet_id = withdrawal.wallet_id
            AND chain.direction = 'debit'
            AND chain.amount_atomic = withdrawal.amount_atomic
            AND chain.counterparty_address = withdrawal.destination_address
            AND chain.canonical_status = 'canonical'
        ))
      )
  ) THEN v_blockers := array_append(v_blockers, 'withdrawal_unsettled'); END IF;

  IF EXISTS (
    SELECT 1 FROM public.meowwa_chain_reorg_halts WHERE resolved_at IS NULL
  ) OR v_discrepancy_open THEN v_blockers := array_append(v_blockers, 'financial_review_open'); END IF;

  RETURN v_blockers;
END
$function$;

-- Finalization locks every binding row of the pet and repeats the canonical check in the same
-- transaction. It is idempotent: a retry after commit returns the original receipt rather than
-- mutating evidence a second time. The caller-generated receipt is opaque and contains no owner
-- or pet identity. Migration 046's body, generalised from one binding row to all of them.
CREATE OR REPLACE FUNCTION meowwa_finalize_pet_deletion(
  p_tenant_id uuid,
  p_pet_id text,
  p_deletion_receipt_id char(64)
)
RETURNS TABLE(deleted_at timestamptz, deletion_receipt_id char(64), newly_deleted boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_undeleted integer;
  v_blockers text[];
  v_subject text := 'deleted-pet:' || p_tenant_id::text;
  v_resource_prefix text := 'deleted:' || p_tenant_id::text || ':';
  v_deleted_at timestamptz := transaction_timestamp();
BEGIN
  IF p_tenant_id IS NULL
    OR p_tenant_id::text IS DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), '')
    OR p_pet_id IS NULL OR length(p_pet_id) NOT BETWEEN 1 AND 255
    OR p_deletion_receipt_id IS NULL OR p_deletion_receipt_id !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'pet deletion input is invalid' USING ERRCODE = '22023';
  END IF;

  -- Every binding of the pet (one per family) is locked before the canonical re-check.
  PERFORM 1
  FROM public.meowwa_pet_wallet_bindings
  WHERE tenant_id = p_tenant_id AND pet_id = p_pet_id
  ORDER BY chain_key
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pet wallet binding was not found' USING ERRCODE = 'P0002'; END IF;

  SELECT count(*) INTO v_undeleted
  FROM public.meowwa_pet_wallet_bindings
  WHERE tenant_id = p_tenant_id AND pet_id = p_pet_id AND pet_deleted_at IS NULL;

  IF v_undeleted = 0 THEN
    -- Every binding already carries a receipt: the replay returns the one inspectPetDeletion reads.
    RETURN QUERY
      SELECT binding.pet_deleted_at, binding.deletion_receipt_id, false
      FROM public.meowwa_pet_wallet_bindings AS binding
      WHERE binding.tenant_id = p_tenant_id AND binding.pet_id = p_pet_id
      ORDER BY binding.pet_deleted_at DESC, binding.chain_key
      LIMIT 1;
    RETURN;
  END IF;

  v_blockers := public.meowwa_pet_deletion_blockers(p_tenant_id, p_pet_id);
  IF cardinality(v_blockers) <> 0 THEN
    RAISE EXCEPTION 'pet deletion is blocked: %', array_to_string(v_blockers, ',') USING ERRCODE = '55000';
  END IF;

  -- Remove encrypted/raw identity and every live provider control handle from every binding of
  -- the pet. The public chain address and internal wallet/pet keys remain because immutable
  -- transaction rows use them as their pseudonymous join; the replacement provider handle is
  -- keyed on each row's own wallet id, which is what kept it unique for one binding.
  UPDATE public.meowwa_pet_wallet_bindings
  SET privy_embedded_wallet_id = v_resource_prefix || left(wallet_id, 200),
      owner_quorum_id = NULL,
      agent_signer_id = NULL,
      agent_policy_id = NULL,
      policy_digest = NULL,
      policy_valid_until = NULL,
      control_verified_at = NULL,
      owner_identity_ciphertext = NULL,
      status = 'revoked',
      revocation_reason = 'pet_deleted',
      pet_deleted_at = v_deleted_at,
      deletion_receipt_id = p_deletion_receipt_id,
      updated_at = v_deleted_at
  WHERE tenant_id = p_tenant_id AND pet_id = p_pet_id AND pet_deleted_at IS NULL;

  -- Pseudonymize identity/provider fields inside retained financial evidence. Transaction hashes,
  -- amounts, counterparties, timestamps, policy digests and status history stay intact.
  UPDATE public.meowwa_wallet_execution_submissions
  SET owner_subject = v_subject,
      provider_wallet_id = v_resource_prefix || left(wallet_id, 200),
      owner_quorum_id = 'deleted', agent_signer_id = 'deleted', agent_policy_id = 'deleted',
      updated_at = v_deleted_at
  WHERE tenant_id = p_tenant_id AND pet_id = p_pet_id;

  UPDATE public.meowwa_withdrawals
  SET owner_subject = v_subject, updated_at = v_deleted_at
  WHERE tenant_id = p_tenant_id AND pet_id = p_pet_id;

  UPDATE public.meowwa_merchant_orders
  SET owner_subject = v_subject, updated_at = v_deleted_at
  WHERE tenant_id = p_tenant_id AND pet_id = p_pet_id;

  UPDATE public.meowwa_merchant_refunds AS refund
  SET owner_subject = v_subject, updated_at = v_deleted_at
  FROM public.meowwa_merchant_orders AS merchant_order
  WHERE merchant_order.tenant_id = refund.tenant_id
    AND merchant_order.order_id = refund.order_id
    AND merchant_order.tenant_id = p_tenant_id AND merchant_order.pet_id = p_pet_id;

  -- These encrypted outcomes are application content, not required financial evidence. Their old
  -- schema has no pet key, so clearing the tenant ledger is the only deletion-safe choice.
  DELETE FROM public.meowwa_evidence_interpretation_claims WHERE tenant_id = p_tenant_id;

  DELETE FROM public.meowwa_shopify_checkout_claims AS claim
  WHERE claim.tenant_id = p_tenant_id AND EXISTS (
    SELECT 1 FROM public.meowwa_wallet_execution_submissions AS execution
    WHERE execution.tenant_id = claim.tenant_id AND execution.request_id = claim.request_id
      AND execution.pet_id = p_pet_id
  );

  RETURN QUERY SELECT v_deleted_at, p_deletion_receipt_id, true;
END
$function$;

REVOKE ALL ON FUNCTION meowwa_pet_deletion_blockers(uuid, text)
  FROM PUBLIC, meowwa_app, meowwa_worker, meowwa_identity_resolver,
       meowwa_wallet_provisioner, meowwa_financial_worker, meowwa_merchant_worker;
REVOKE ALL ON FUNCTION meowwa_finalize_pet_deletion(uuid, text, char(64))
  FROM PUBLIC, meowwa_app, meowwa_worker, meowwa_identity_resolver,
       meowwa_wallet_provisioner, meowwa_financial_worker, meowwa_merchant_worker;
GRANT EXECUTE ON FUNCTION meowwa_pet_deletion_blockers(uuid, text) TO meowwa_app;
GRANT EXECUTE ON FUNCTION meowwa_finalize_pet_deletion(uuid, text, char(64)) TO meowwa_app;

COMMIT;
