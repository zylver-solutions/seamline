// Drizzle schema fixture.
//
// This file is `.js` rather than `.ts` on purpose: it lives under the
// package's own `src/`, and a `.ts` file here would be pulled into
// `tsc --build` and fail on the unresolvable `drizzle-orm` import. The
// extractor treats both extensions identically, and `drizzle.test.ts` covers
// the TypeScript-only syntax (`.$type<T>()`) directly against a source string.
import { boolean, integer, numeric, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey(),
  slug: varchar('slug', { length: 64 }).notNull().unique(),
});

export const members = pgTable('members', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => orgs.id),
  email: varchar('email', { length: 255 }).notNull(),
  address: text('address'), // Home postal address on file.
  age: integer('age'),
  balance: numeric('balance', { precision: 12, scale: 2 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 6 }).notNull().defaultNow(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, precision: 6 }),
});
