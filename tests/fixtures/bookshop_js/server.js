// Routes. Everything here is reached by the framework, never by our own code.

const express = require('express');
const { OrderService } = require('./orders');
const inventory = require('./inventory');

const app = express();

/** Take a checkout and turn it into an order. */
app.post('/orders', async (req, res) => {
  const service = new OrderService(req.db);
  res.json({ id: await service.placeOrder(req.body.email, req.body.cart) });
});

app.get('/stock/:code', async (req, res) => {
  res.json({ rows: await inventory.warehouseStock(req.db, req.params.code) });
});

module.exports = { app };
