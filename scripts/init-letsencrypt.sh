#!/usr/bin/env bash
# ==============================================================================
# FilyBase SSL Certificate Initializer (Certbot + Nginx)
# ==============================================================================
set -e

DOMAINS=("api.filybase.io")
EMAIL="admin@filybase.io" # Change to your actual email for renewal notices
STAGING=0 # Set to 1 if you are testing to avoid Let's Encrypt rate limits
RSA_KEY_SIZE=4096
DATA_PATH="./certbot"

if [ -d "$DATA_PATH/conf/live/${DOMAINS[0]}" ]; then
  read -p "Existing data found for ${DOMAINS[0]}. Continue and replace existing certificate? (y/N) " decision
  if [ "$decision" != "Y" ] && [ "$decision" != "y" ]; then
    exit 0
  fi
fi

echo "### 0. Cleaning up any conflicting old containers..."
docker rm -f filybase-caddy 2>/dev/null || true

echo "### 1. Creating directory structure ..."
mkdir -p "$DATA_PATH/conf/live/${DOMAINS[0]}"
mkdir -p "$DATA_PATH/www"

echo "### 2. Creating temporary dummy certificate for ${DOMAINS[0]} ..."
path="/etc/letsencrypt/live/${DOMAINS[0]}"
docker compose run --rm --remove-orphans --entrypoint "\
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout '$path/privkey.pem' \
    -out '$path/fullchain.pem' \
    -subj '/CN=localhost'" certbot

# Also create chain.pem for OCSP stapling if needed
docker compose run --rm --remove-orphans --entrypoint "\
  cp '$path/fullchain.pem' '$path/chain.pem'" certbot

echo "### 3. Starting Nginx container ..."
docker compose up --remove-orphans --force-recreate -d nginx

echo "### 4. Deleting temporary dummy certificate ..."
docker compose run --rm --entrypoint "\
  rm -Rf /etc/letsencrypt/live/${DOMAINS[0]} && \
  rm -Rf /etc/letsencrypt/archive/${DOMAINS[0]} && \
  rm -Rf /etc/letsencrypt/renewal/${DOMAINS[0]}.conf" certbot

echo "### 5. Requesting Let's Encrypt certificate for ${DOMAINS[0]} ..."
domain_args=""
for domain in "${DOMAINS[@]}"; do
  domain_args="$domain_args -d $domain"
done

# Email arg
if [ -z "$EMAIL" ]; then
  email_arg="--register-unsafely-without-email"
else
  email_arg="--email $EMAIL"
fi

# Enable staging if testing
if [ $STAGING != "0" ]; then
  staging_arg="--staging"
fi

docker compose run --rm --entrypoint "\
  certbot certonly --webroot -w /var/www/certbot \
    $staging_arg \
    $email_arg \
    $domain_args \
    --rsa-key-size $RSA_KEY_SIZE \
    --agree-tos \
    --force-renewal \
    --no-eff-email" certbot

# Create chain.pem copy if required by OCSP stapling
docker compose run --rm --entrypoint "\
  sh -c 'if [ ! -f /etc/letsencrypt/live/${DOMAINS[0]}/chain.pem ]; then cp /etc/letsencrypt/live/${DOMAINS[0]}/fullchain.pem /etc/letsencrypt/live/${DOMAINS[0]}/chain.pem; fi'" certbot

echo "### 6. Reloading Nginx with real certificates ..."
docker compose exec nginx nginx -s reload

echo "=========================================================================="
echo "✅ SSL Certificate successfully installed for ${DOMAINS[0]}!"
echo "=========================================================================="
