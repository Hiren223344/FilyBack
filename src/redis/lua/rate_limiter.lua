-- Rate Limiter Token Bucket Lua Script
-- KEYS[1]: Redis rate limit key
-- ARGV[1]: capacity (number)
-- ARGV[2]: refill_rate_per_ms (number)
-- ARGV[3]: cost (number)
-- ARGV[4]: now_ms (number)
-- ARGV[5]: ttl_sec (number)

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now_ms = tonumber(ARGV[4])
local ttl_sec = tonumber(ARGV[5])

local data = redis.call('HMGET', key, 'tokens', 'last_updated')
local last_tokens = tonumber(data[1])
local last_updated = tonumber(data[2])

if last_tokens == nil or last_updated == nil then
  last_tokens = capacity
  last_updated = now_ms
end

local delta_ms = math.max(0, now_ms - last_updated)
local current_tokens = math.min(capacity, last_tokens + (delta_ms * refill_rate))

local allowed = 0
local retry_after = 0
local remaining = 0

if current_tokens >= cost then
  allowed = 1
  current_tokens = current_tokens - cost
  remaining = math.floor(current_tokens)
  redis.call('HMSET', key, 'tokens', current_tokens, 'last_updated', now_ms)
  redis.call('EXPIRE', key, ttl_sec)
else
  allowed = 0
  remaining = math.floor(current_tokens)
  local missing = cost - current_tokens
  retry_after = math.ceil(missing / (refill_rate * 1000))
  if retry_after < 1 then retry_after = 1 end
  redis.call('HMSET', key, 'tokens', current_tokens, 'last_updated', now_ms)
  redis.call('EXPIRE', key, ttl_sec)
end

local reset_after = 0
if refill_rate > 0 then
  reset_after = math.ceil((capacity - current_tokens) / (refill_rate * 1000))
end

return { allowed, remaining, retry_after, reset_after }
