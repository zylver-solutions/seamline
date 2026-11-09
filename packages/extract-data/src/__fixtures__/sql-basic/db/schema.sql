-- Core application schema, hand-written DDL.
CREATE SCHEMA IF NOT EXISTS app;

CREATE TYPE user_role AS ENUM ('admin', 'member', 'guest');

CREATE TABLE app.organizations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        varchar(64) NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now()
);

/* The main user table. Deliberately mixes every column shape the
   extractor has to get right. */
CREATE TABLE app.users (
    id                bigserial PRIMARY KEY,
    org_id            uuid NOT NULL REFERENCES app.organizations (id) ON DELETE CASCADE,
    email             character varying(255) NOT NULL,
    phone_number      text,
    password_hash     text NOT NULL,
    role              user_role NOT NULL DEFAULT 'member',
    age               integer CHECK (age >= 0),
    balance           numeric(12,2) NOT NULL DEFAULT 0,
    is_active         boolean NOT NULL DEFAULT true,
    email_verified_at timestamptz,
    tags              text[],
    profile           jsonb,
    created_at        timestamp(3) with time zone NOT NULL DEFAULT now(),
    CONSTRAINT users_email_key UNIQUE (email)
);

COMMENT ON COLUMN app.users.phone_number IS 'Primary contact phone number';

CREATE UNIQUE INDEX users_email_ci_idx ON app.users (email);

-- Not DDL; must be ignored rather than fail the file.
GRANT SELECT ON app.users TO readonly;
