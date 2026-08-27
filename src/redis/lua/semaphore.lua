-- Admission Control Concurrency Semaphore Lua Script
-- KEYS[1]: Semaphore key (e.g. filybase:sem:model:llama-3.3-70b)
-- ARGV[1]: action ("acquire" | "release" | "count")
-- ARGV[2]: max_concurrency (number)
-- ARGV[3]: request_id (string)
-- ARGV[4]: now_ms (number)
-- ARGV[5]: ttl_ms (number, e.g. 300000 = 5 min safety TTL)

local key = KEYS[1]
local action = ARGV[1]
local max_concurrency = tonumber(ARGV[2]) or 16
local request_id = ARGV[3] or ""
local now_ms = tonumber(ARGV[4]) or 0
local ttl_ms = tonumber(ARGV[5]) or 300000

-- Always prune expired items first
redis.call('ZREMRANGEBYSCORE', key, '-inf', now_ms)

if action == "acquire" then
  local count = redis.call('ZCARD', key)
  if count < max_concurrency then
    redis.call('ZADD', key, now_ms + ttl_ms, request_id)
    -- Set an overall expiration on the key if idle
    redis.call('EXPIRE', key, math.ceil(ttl_ms / 1000) * 2)
    return { 1, count + 1, max_concurrency }
  else
    return { 0, count, max_concurrency }
  end
elseif action == "release" then
  redis.call('ZREM', key, request_id)
  local count = redis.call('ZCARD', key)
  return { 1, count, max_concurrency }
elseif action == "count" then
  local count = redis.call('ZCARD', key)
  return { 1, count, max_concurrency }
else
  return redis.error_reply("Unknown semaphore action: " .. tostring(action))
end
