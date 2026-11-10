#!/usr/bin/env bash
# Creates a self-signed certificate for LAN testing, so a phone gets a secure
# origin and can use the microphone. Development only; never ship this cert.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$DIR"

IP="${1:-}"
if [ -z "$IP" ]; then
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
if [ -z "$IP" ]; then
  IP="127.0.0.1"
fi

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$DIR/dev-key.pem" -out "$DIR/dev-cert.pem" \
  -days 365 -subj "/CN=bolti-bahi-dev" \
  -addext "subjectAltName=IP:$IP,IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1

chmod 600 "$DIR/dev-key.pem"
echo "Created $DIR/dev-cert.pem for https://$IP:3443"
echo "Run: HTTPS=1 PORT=3443 npm start"
