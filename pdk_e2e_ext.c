/**
 * pdk_e2e_ext.c — Lua C extension for pdk_e2e.
 *
 * Wraps pdk_e2e.h internals and registers playdate.e2e.* functions into the
 * Lua runtime via kEventInitLua. Lua games call playdate.e2e.update() and
 * playdate.e2e.crank() — the rest (TCP, framebuffer, input injection) is
 * handled by pdk_e2e.c under the hood.
 *
 * State exposure uses a companion Lua file (pdk_e2e.lua) that stores callbacks
 * in a Lua table. When QUERY_STATE arrives, the C hook calls playdate.e2e._dispatch()
 * to invoke the Lua callback and read the return value.
 *
 * On device builds, eventHandler is a no-op and the playdate.e2e namespace is
 * never registered. The Lua guard `if playdate.e2e then` evaluates to nil.
 */

#include "pdk_e2e.h"

#if TARGET_SIMULATOR

static PlaydateAPI *pd = NULL;

// --- Lua-callable C functions ---

/**
 * playdate.e2e.update() — poll TCP commands and snapshot button transitions.
 * Call once per frame in playdate.update().
 */
static int lua_e2e_update(lua_State *L) {
    (void)L;
    pdk_e2e_update();
    return 0;
}

/**
 * playdate.e2e.crank() — returns injected crank angle, or real hardware angle
 * if none injected. Drop-in replacement for playdate.getCrankPosition().
 */
static int lua_e2e_crank(lua_State *L) {
    (void)L;
    float angle = pdk_e2e_crank();
    pd->lua->pushFloat(angle);
    return 1;
}

// --- State query hook (Lua callback dispatch) ---

// AIDEV-NOTE: When QUERY_STATE arrives and the C pointer registry has no match,
// pdk_e2e.c calls this hook. We push the name onto the Lua stack, call
// playdate.e2e._dispatch(name) (defined in pdk_e2e.lua), and read the return
// value. The _dispatch function looks up the Lua callback table and calls the
// user's callback, returning its result.

static pdk_e2e_state_result lua_state_query_hook(const char *name) {
    pdk_e2e_state_result result = {.found = false};
    const char *err = NULL;

    pd->lua->pushString(name);
    if (!pd->lua->callFunction("playdate.e2e._dispatch", 1, &err)) {
        pd->system->logToConsole("pdk_e2e_ext: _dispatch error: %s", err ? err : "(unknown)");
        return result;
    }

    // Read the return value — type determines wire protocol encoding
    const char *out_class = NULL;
    enum LuaType ret_type = pd->lua->getArgType(1, &out_class);

    switch (ret_type) {
    case kTypeInt:
        result.found = true;
        result.type = PDK_E2E_STATE_INT32;
        result.value.i = pd->lua->getArgInt(1);
        break;
    case kTypeFloat:
        result.found = true;
        result.type = PDK_E2E_STATE_FLOAT32;
        result.value.f = pd->lua->getArgFloat(1);
        break;
    case kTypeString:
        result.found = true;
        result.type = PDK_E2E_STATE_STRING;
        // AIDEV-NOTE: getArgString returns a pointer valid until the next Lua
        // API call. Safe here because send_state_string() in pdk_e2e.c copies
        // the string into a send buffer immediately (same call frame).
        result.value.s = pd->lua->getArgString(1);
        break;
    case kTypeNil:
        // Callback not registered for this name — leave found = false
        break;
    default:
        pd->system->logToConsole("pdk_e2e_ext: _dispatch returned unsupported type %d for '%s'",
                                 ret_type, name);
        break;
    }

    return result;
}

// --- Event handler ---

#ifdef _WINDLL
__declspec(dllexport)
#endif
int eventHandler(PlaydateAPI *playdate, PDSystemEvent event, uint32_t arg) {
    (void)arg;

    if (event == kEventInit) {
        pd = playdate;
        // AIDEV-NOTE: Port 54321 matches the TypeScript runner default.
        // A future enhancement could read from a compile-time define.
        pdk_e2e_init(playdate, 54321);
    } else if (event == kEventInitLua) {
        const char *err = NULL;

        if (!pd->lua->addFunction(lua_e2e_update, "playdate.e2e.update", &err)) {
            pd->system->logToConsole("pdk_e2e_ext: failed to register update: %s",
                                     err ? err : "(unknown)");
        }

        if (!pd->lua->addFunction(lua_e2e_crank, "playdate.e2e.crank", &err)) {
            pd->system->logToConsole("pdk_e2e_ext: failed to register crank: %s",
                                     err ? err : "(unknown)");
        }

        // Install Lua state query hook — QUERY_STATE tries C registry first,
        // then falls through to Lua _dispatch via this hook.
        pdk_e2e_set_state_query_hook(lua_state_query_hook);
    }

    return 0;
}

#else // !TARGET_SIMULATOR — device build: no-op

#ifdef _WINDLL
__declspec(dllexport)
#endif
int eventHandler(PlaydateAPI *playdate, PDSystemEvent event, uint32_t arg) {
    (void)playdate;
    (void)event;
    (void)arg;
    return 0;
}

#endif // TARGET_SIMULATOR
