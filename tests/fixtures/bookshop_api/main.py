"""Routes. Everything here is reached by the framework, never by our own code."""

from flask import Flask, request

from .orders import OrderService
from . import inventory

app = Flask(__name__)


@app.post("/orders")
def place_order_route():
    """Take a checkout and turn it into an order."""
    service = OrderService(request.db)
    return {"id": service.place_order(request.json["email"], request.json["cart"])}


@app.get("/stock/<code>")
def stock_route(code):
    return {"rows": inventory.warehouse_stock(request.db, code)}
