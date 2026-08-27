-- Atomic Credit Reserve and Reconcile Lua Script
-- KEYS[1]: Balance key (filybase:balance:{account_id})
-- KEYS[2]: Reservation key (filybase:res:{account_id}:{reserve_id})
-- KEYS[3]: Total reserved key (filybase:res_total:{account_id})
-- ARGV[1]: Action ("reserve" | "reconcile" | "release" | "set_balance" | "get_balance")
-- ARGV[2]: Amount (estimated_credits, actual_credits, or new_balance)
-- ARGV[3]: Parameter (ttl_sec for reserve)
-- ARGV[4]: Fallback balance (if not cached in Redis)

local balance_key = KEYS[1]
local res_key = KEYS[2]
local res_total_key = KEYS[3]
local action = ARGV[1]

if action == "reserve" then
  local estimated = tonumber(ARGV[2]) or 0
  local ttl_sec = tonumber(ARGV[3]) or 300
  local fallback_balance = ARGV[4]

  local balance_val = redis.call('GET', balance_key)
  if balance_val == false or balance_val == nil then
    if fallback_balance ~= nil and fallback_balance ~= "" then
      balance_val = fallback_balance
      redis.call('SET', balance_key, balance_val)
    else
      return { -1, 0, 0 } -- -1 indicates cache miss, must initialize from database
    end
  end

  local balance = tonumber(balance_val) or 0
  local total_reserved_val = redis.call('GET', res_total_key)
  local total_reserved = tonumber(total_reserved_val) or 0
  if total_reserved < 0 then
    total_reserved = 0
    redis.call('SET', res_total_key, 0)
  end

  local available = balance - total_reserved

  if available >= estimated then
    redis.call('SET', res_key, estimated, 'EX', ttl_sec)
    redis.call('INCRBY', res_total_key, estimated)
    redis.call('EXPIRE', res_total_key, 86400)
    return { 1, available - estimated, balance }
  else
    return { 0, available, balance }
  end

elseif action == "reconcile" then
  local actual = tonumber(ARGV[2]) or 0
  local res_val = redis.call('GET', res_key)
  local reserved_amt = 0
  if res_val ~= false and res_val ~= nil then
    reserved_amt = tonumber(res_val) or 0
    redis.call('DEL', res_key)
    local new_total = redis.call('DECRBY', res_total_key, reserved_amt)
    if new_total < 0 then
      redis.call('SET', res_total_key, 0)
    end
  end

  local new_balance = redis.call('DECRBY', balance_key, actual)
  return { 1, new_balance, reserved_amt }

elseif action == "release" then
  local res_val = redis.call('GET', res_key)
  if res_val ~= false and res_val ~= nil then
    local reserved_amt = tonumber(res_val) or 0
    redis.call('DEL', res_key)
    local new_total = redis.call('DECRBY', res_total_key, reserved_amt)
    if new_total < 0 then
      redis.call('SET', res_total_key, 0)
    end
    return { 1, reserved_amt }
  end
  return { 0, 0 }

elseif action == "set_balance" then
  local new_balance = tonumber(ARGV[2]) or 0
  redis.call('SET', balance_key, new_balance)
  return { 1, new_balance }

elseif action == "get_balance" then
  local balance_val = redis.call('GET', balance_key)
  if balance_val == false or balance_val == nil then
    return { -1, 0, 0 }
  end
  local balance = tonumber(balance_val) or 0
  local total_reserved = tonumber(redis.call('GET', res_total_key) or 0)
  if total_reserved < 0 then total_reserved = 0 end
  return { 1, balance - total_reserved, balance }

else
  return redis.error_reply("Unknown credit action: " .. tostring(action))
end
