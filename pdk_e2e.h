/**
 * pdk_e2e.h — End-to-end testing module for Playdate games.
 *
 * Drop-in replacement for getButtonState/getCrankAngle that adds TCP-based
 * test control. Compiles to nothing on device builds.
 *
 * See README.md "Wire Protocol" for the full specification.
 */

#ifndef PDK_E2E_H
#define PDK_E2E_H

#include "pd_api.h"

#include <stdbool.h>
#include <stdint.h>

// --- Protocol constants ---
// Must match TypeScript types.ts byte-for-byte.

// Commands (runner -> game)
#define PDK_E2E_MSG_PING          0x01
#define PDK_E2E_MSG_CAPTURE_FRAME 0x02
#define PDK_E2E_MSG_INJECT_INPUT  0x03
#define PDK_E2E_MSG_QUERY_STATE   0x04
#define PDK_E2E_MSG_RELEASE_INPUT 0x05

// Responses (game -> runner)
#define PDK_E2E_MSG_PONG           0x81
#define PDK_E2E_MSG_FRAME_DATA     0x82
#define PDK_E2E_MSG_INPUT_ACK      0x83
#define PDK_E2E_MSG_STATE_VALUE    0x84
#define PDK_E2E_MSG_STATE_NOT_FOUND 0x85
#define PDK_E2E_MSG_READY          0xFE
#define PDK_E2E_MSG_ERROR          0xFF

// Framing: [1B type][2B payload length BE][payload]
#define PDK_E2E_HEADER_SIZE     3
#define PDK_E2E_MAX_PAYLOAD     0xFFFF

// Framebuffer: 52 bytes/row (50 data + 2 padding) x 240 rows
#define PDK_E2E_FRAME_DATA_SIZE 12480

// State value type tags
#define PDK_E2E_STATE_INT32   0
#define PDK_E2E_STATE_FLOAT32 1
#define PDK_E2E_STATE_STRING  2

// Exposed-state registry limit
#define PDK_E2E_MAX_EXPOSED_STATES 32

// Crank sentinel: no injection — pass through real hardware angle
#define PDK_E2E_CRANK_NO_INJECT (-1.0f)

// Button bitmask values (match PlaydateButton enum in TypeScript)
#define PDK_E2E_BUTTON_A     0x01
#define PDK_E2E_BUTTON_B     0x02
#define PDK_E2E_BUTTON_UP    0x04
#define PDK_E2E_BUTTON_DOWN  0x08
#define PDK_E2E_BUTTON_LEFT  0x10
#define PDK_E2E_BUTTON_RIGHT 0x20

#if TARGET_SIMULATOR

// --- Connection state machine ---

typedef enum {
    PDK_E2E_STATE_IDLE,
    PDK_E2E_STATE_REQUESTING_ACCESS,
    PDK_E2E_STATE_ACCESS_GRANTED,
    PDK_E2E_STATE_WAITING_CONNECT,
    PDK_E2E_STATE_CONNECTED
} pdk_e2e_conn_state;

// --- Public API (simulator builds) ---

/**
 * Initialize the e2e module. Call once during kEventInit.
 * Begins TCP connection to the runner's server on localhost:port.
 */
void pdk_e2e_init(PlaydateAPI *pd, int port);

/**
 * Poll for and process TCP commands. Call once per frame in update().
 * Processes at most one command per call. Also snapshots button transitions.
 */
void pdk_e2e_update(void);

/**
 * Drop-in replacement for pd->system->getButtonState().
 * Combines real hardware buttons with injected test input.
 * Returns consistent values within a frame (snapshotted in pdk_e2e_update).
 * NULL output pointers are skipped.
 */
void pdk_e2e_get_buttons(PDButtons *current, PDButtons *pushed, PDButtons *released);

/**
 * Drop-in replacement for pd->system->getCrankAngle().
 * Returns injected angle if set, otherwise real hardware angle.
 */
float pdk_e2e_crank(void);

/**
 * Expose an int value for test queries. Pointer must be global/static/heap.
 */
void pdk_e2e_expose_int(const char *name, const int *ptr);

/**
 * Expose a float value for test queries. Pointer must be global/static/heap.
 */
void pdk_e2e_expose_float(const char *name, const float *ptr);

/**
 * Expose a string value for test queries. Pointer must be global/static/heap.
 */
void pdk_e2e_expose_string(const char *name, const char **ptr);

// AIDEV-NOTE: Device macros below reference `pd` directly — the game must have
// a `PlaydateAPI *pd` variable in scope wherever these are called.
#else // !TARGET_SIMULATOR — device builds compile to nothing

#define pdk_e2e_init(pd, port)           ((void)0)
#define pdk_e2e_update()                 ((void)0)
#define pdk_e2e_get_buttons(c, p, r)     pd->system->getButtonState(c, p, r)
#define pdk_e2e_crank()                  (pd->system->getCrankAngle())
#define pdk_e2e_expose_int(name, ptr)    ((void)0)
#define pdk_e2e_expose_float(name, ptr)  ((void)0)
#define pdk_e2e_expose_string(name, ptr) ((void)0)

#endif // TARGET_SIMULATOR

#endif // PDK_E2E_H
