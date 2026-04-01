-- pdk_e2e.lua — Lua-side companion for the pdk_e2e C extension.
--
-- The C extension registers playdate.e2e.update() and playdate.e2e.crank()
-- during kEventInitLua. This file adds expose() and _dispatch() to the same
-- namespace. Import with: import "pdk_e2e"
--
-- On device builds, the C extension never registers playdate.e2e, so the
-- guard below exits immediately — zero overhead.

if not playdate.e2e then return end

local _callbacks = {}

--- Register a named state callback for QUERY_STATE dispatch.
--- The callback takes no arguments and returns a single value (int, float,
--- or string). The type is inferred automatically.
---
--- Example:
---   playdate.e2e.expose("score", function() return gameState.score end)
function playdate.e2e.expose(name, callback)
    _callbacks[name] = callback
end

--- Internal: called by the C extension's state query hook when QUERY_STATE
--- arrives and the name is not in the C pointer registry.
--- Returns the callback's return value, or nil if no callback is registered.
function playdate.e2e._dispatch(name)
    local cb = _callbacks[name]
    if cb then return cb() end
    return nil
end
