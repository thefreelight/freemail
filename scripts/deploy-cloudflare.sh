#!/usr/bin/env bash
set -euo pipefail

WORKER_NAME="${WORKER_NAME:-freemail}"
D1_DB_NAME="${D1_DB_NAME:-mail_free_db}"
R2_BUCKET_NAME="${R2_BUCKET_NAME:-mail-eml}"
MAIL_DOMAIN="${MAIL_DOMAIN:-freemail.123kele.com}"
CONFIG_FILE="${CONFIG_FILE:-wrangler-deploy.toml}"
WRANGLER="${WRANGLER:-wrangler}"

if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
  echo "ADMIN_PASSWORD is required." >&2
  exit 1
fi

if [[ -z "${JWT_TOKEN:-}" ]]; then
  echo "JWT_TOKEN is required." >&2
  exit 1
fi

cp wrangler.toml "$CONFIG_FILE"

CONFIG_FILE="$CONFIG_FILE" \
WORKER_NAME="$WORKER_NAME" \
D1_DB_NAME="$D1_DB_NAME" \
R2_BUCKET_NAME="$R2_BUCKET_NAME" \
MAIL_DOMAIN="$MAIL_DOMAIN" \
ADMIN_NAME="${ADMIN_NAME:-admin}" \
ADMIN_PASSWORD="$ADMIN_PASSWORD" \
GUEST_PASSWORD="${GUEST_PASSWORD:-guest}" \
JWT_TOKEN="$JWT_TOKEN" \
JWT_TOKENGUEST_PASSWORD="${JWT_TOKENGUEST_PASSWORD:-}" \
SESSION_EXPIRE_DAYS="${SESSION_EXPIRE_DAYS:-365}" \
RESEND_API_KEY="${RESEND_API_KEY:-}" \
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.env.CONFIG_FILE;
let text = readFileSync(file, 'utf8');

const quote = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const replaceAssignment = (key, value) => {
  const line = `${key}=${quote(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(text)) {
    text = text.replace(pattern, line);
  } else {
    text = text.replace(/^MAIL_DOMAIN=.*$/m, `$&\n${line}`);
  }
};

text = text.replace(/^name = .*$/m, `name = ${quote(process.env.WORKER_NAME)}`);
text = text.replace(/^[ \t]*database_name = .*$/m, `database_name = ${quote(process.env.D1_DB_NAME)}`);
text = text.replace(/^[ \t]*database_id = .*$/m, 'database_id = "PLACEHOLDER_D1_ID"');
text = text.replace(/^[ \t]*bucket_name = .*$/m, `bucket_name = ${quote(process.env.R2_BUCKET_NAME)}`);
text = text.replace(/^pattern = ".*"$/m, `pattern = ${quote(process.env.MAIL_DOMAIN)}`);

replaceAssignment('ADMIN_NAME', process.env.ADMIN_NAME);
replaceAssignment('ADMIN_PASSWORD', process.env.ADMIN_PASSWORD);
replaceAssignment('GUEST_PASSWORD', process.env.GUEST_PASSWORD);
replaceAssignment('JWT_TOKEN', process.env.JWT_TOKEN);
replaceAssignment('JWT_TOKENGUEST_PASSWORD', process.env.JWT_TOKENGUEST_PASSWORD);
replaceAssignment('SESSION_EXPIRE_DAYS', process.env.SESSION_EXPIRE_DAYS);
replaceAssignment('MAIL_DOMAIN', process.env.MAIL_DOMAIN);

if (process.env.RESEND_API_KEY) {
  replaceAssignment('RESEND_API_KEY', process.env.RESEND_API_KEY);
}

writeFileSync(file, text);
NODE

D1_LIST="$("$WRANGLER" d1 list --json)"
if ! printf '%s' "$D1_LIST" | node -e "
const fs = require('node:fs');
const name = process.argv[1];
const list = JSON.parse(fs.readFileSync(0, 'utf8'));
process.exit(list.some((item) => item.name === name) ? 0 : 1);
" "$D1_DB_NAME"; then
  "$WRANGLER" d1 create "$D1_DB_NAME"
  D1_LIST="$("$WRANGLER" d1 list --json)"
fi

D1_ID="$(printf '%s' "$D1_LIST" | node -e "
const fs = require('node:fs');
const name = process.argv[1];
const db = JSON.parse(fs.readFileSync(0, 'utf8')).find((item) => item.name === name);
if (!db) process.exit(1);
console.log(db.uuid);
" "$D1_DB_NAME")"

CONFIG_FILE="$CONFIG_FILE" D1_ID="$D1_ID" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const file = process.env.CONFIG_FILE;
const text = readFileSync(file, 'utf8').replaceAll('PLACEHOLDER_D1_ID', process.env.D1_ID);
writeFileSync(file, text);
NODE

WRANGLER="$WRANGLER" node scripts/check-d1-drift.mjs "$D1_DB_NAME" "$CONFIG_FILE"

if ! "$WRANGLER" r2 bucket list | grep -q "^${R2_BUCKET_NAME}$"; then
  "$WRANGLER" r2 bucket create "$R2_BUCKET_NAME"
fi

"$WRANGLER" d1 execute "$D1_DB_NAME" -c "$CONFIG_FILE" --file=d1-init.sql --remote
"$WRANGLER" deploy -c "$CONFIG_FILE"
