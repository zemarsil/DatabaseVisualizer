// Routes. Everything here is reached by the framework, never by our own code.

import express from 'express';
import { OrderService } from './orders.js';
import { warehouseStock } from './inventory.js';

const app = express();

/** Take a checkout and turn it into an order. */
app.post('/orders', async (req, res) => {
  const service = new OrderService(req.db);
  const id = await service.placeOrder(req.body.email, req.body.cart);
  res.json({ id });
});

app.get('/stock/:code', async (req, res) => {
  res.json({ rows: await warehouseStock(req.db, req.params.code) });
});

export function start(port: number): void {
  app.listen(port);
}
