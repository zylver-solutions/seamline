/**
 * Domain model for a harbor-books order.
 *
 * Mirrors `public.orders` (db/migrations/0014_orders_shipping.sql). `shippedAt`
 * is declared optional here because a code author reasonably models "we don't
 * know yet" as absence — the database agrees (the column is nullable). The
 * API contract does not: see contracts/order-response.schema.json.
 */
export interface Order {
  id: string;
  shippedAt?: Date;
  customerEmail: string;
  totalCents: number;
  createdAt: Date;
}
