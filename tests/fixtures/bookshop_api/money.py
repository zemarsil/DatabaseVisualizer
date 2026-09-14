"""Money, in the only unit the database stores it in. Touches nothing."""


def to_cents(amount):
    return int(round(float(amount) * 100))
