-- Keep the public operation identity with durable destination acceptance.
-- Older receipts remain untagged. Typed recovery returns their outcome without
-- reinterpreting the old result or resubmitting their effect.
ALTER TABLE fleet_command_receipts
  ADD COLUMN command_tag TEXT CHECK(command_tag IS NULL OR length(command_tag) BETWEEN 1 AND 100);
