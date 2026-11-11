#!/usr/bin/env python3
"""Civil Service portal access-code admin (CSE track).

Mirrors how SASE order hashes are managed, but for the SEPARATE CSE
registry: api/_cse-hashes.json maps sha256(access code) -> {order_id,
created_at}. CSE buyers get TWO credentials: their PDF keeps its own
unique password, and the portal uses a CSE7 access code managed here.
Codes are never stored in plaintext; only their sha256 lands in the file.

Access code format: CSE7-XXXX-XXXX where each X is an uppercase letter or
digit EXCLUDING 0/O/1/l/I (no look-alike characters).

Usage:
  python3 scripts/cse-admin.py add CSE-XXXXXX CSE7-XXXX-XXXX
      Register an operator-chosen code for an order.
  python3 scripts/cse-admin.py gen CSE-XXXXXX
      Generate a compliant code for an order, register it, and print it
      ONCE (this print is the operator's only copy; send it to the buyer).
  python3 scripts/cse-admin.py list
      List registered order ids (never codes or hashes beyond the file).

After any change: commit api/_cse-hashes.json and push; the Vercel deploy
picks the registry up (same flow as SASE order hashes).
"""
import hashlib
import json
import re
import secrets
import sys
from datetime import datetime, timezone
from pathlib import Path

REGISTRY = Path(__file__).resolve().parent.parent / "api" / "_cse-hashes.json"
ORDER_RE = re.compile(r"^CSE-[A-Z0-9]{6}$")
# Alphabet excludes 0/O/1/l/I look-alikes: digits 2-9, letters minus I and O.
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_RE = re.compile(r"^CSE7-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$")


def load_registry() -> dict:
    if REGISTRY.exists():
        return json.loads(REGISTRY.read_text() or "{}")
    return {}


def save_registry(reg: dict) -> None:
    REGISTRY.write_text(json.dumps(reg, indent=2, sort_keys=True) + "\n")


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def add(order_id: str, code: str) -> None:
    if not ORDER_RE.match(order_id):
        sys.exit(f"error: order id must look like CSE-XXXXXX, got: {order_id}")
    if not CODE_RE.match(code):
        sys.exit("error: code must match CSE7-XXXX-XXXX with no 0/O/1/l/I characters")
    reg = load_registry()
    digest = sha256(code)
    if digest in reg:
        sys.exit(f"error: that code is already registered to {reg[digest].get('order_id')}")
    for entry in reg.values():
        if entry.get("order_id") == order_id:
            sys.exit(f"error: order {order_id} already has a code registered")
    reg[digest] = {
        "order_id": order_id,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    save_registry(reg)
    print(f"registered {order_id} in {REGISTRY.name} (sha256 stored, code not saved)")


def gen(order_id: str) -> None:
    if not ORDER_RE.match(order_id):
        sys.exit(f"error: order id must look like CSE-XXXXXX, got: {order_id}")
    reg = load_registry()
    for entry in reg.values():
        if entry.get("order_id") == order_id:
            sys.exit(f"error: order {order_id} already has a code registered")
    while True:
        part = lambda: "".join(secrets.choice(ALPHABET) for _ in range(4))  # noqa: E731
        code = f"CSE7-{part()}-{part()}"
        if sha256(code) not in reg:
            break
    add(order_id, code)
    # The operator's only copy of the generated code. Send it to the buyer.
    print(f"access code for {order_id}: {code}")


def list_orders() -> None:
    reg = load_registry()
    if not reg:
        print("no CSE codes registered yet")
        return
    for entry in sorted(reg.values(), key=lambda e: e.get("order_id", "")):
        print(f"{entry.get('order_id')}  created {entry.get('created_at')}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 3 and args[0] == "add":
        add(args[1], args[2])
    elif len(args) == 2 and args[0] == "gen":
        gen(args[1])
    elif len(args) == 1 and args[0] == "list":
        list_orders()
    else:
        print(__doc__)
        sys.exit(2)
