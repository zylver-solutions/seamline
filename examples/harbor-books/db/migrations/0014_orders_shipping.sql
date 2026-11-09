-- 0014_orders_shipping.sql
--
-- Adds shipment tracking to orders.

CREATE TABLE orders (
  id UUID PRIMARY KEY,
  shipped_at TIMESTAMPTZ,
  customer_email TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
