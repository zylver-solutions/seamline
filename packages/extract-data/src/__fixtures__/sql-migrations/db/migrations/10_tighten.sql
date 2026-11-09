ALTER TABLE accounts ALTER COLUMN phone TYPE character varying(32);
ALTER TABLE accounts ALTER COLUMN phone SET NOT NULL;
ALTER TABLE accounts DROP COLUMN nickname;
ALTER TABLE accounts ADD CONSTRAINT accounts_email_key UNIQUE (email);
