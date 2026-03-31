/**
 * pdk_e2e.c — End-to-end testing module implementation.
 *
 * TCP client that connects to the TypeScript test runner, responds to
 * commands one per frame, and provides input injection + state exposure.
 *
 * See README.md "Wire Protocol" for the full specification.
 */

#include "pdk_e2e.h"

#if TARGET_SIMULATOR

#include <string.h>

// --- File-scoped state ---

static PlaydateAPI *pd = NULL;
static pdk_e2e_conn_state conn_state = PDK_E2E_STATE_IDLE;
static PDTCPConnection *tcp_conn = NULL;
static int target_port = 0;

// Receive buffer — accumulates across frames (TCP doesn't guarantee message boundaries)
static uint8_t recv_buf[PDK_E2E_HEADER_SIZE + PDK_E2E_MAX_PAYLOAD];
static int recv_buf_len = 0;

// Input injection state
static PDButtons injected_buttons = 0;
static PDButtons prev_injected_buttons = 0;
static float injected_crank = PDK_E2E_CRANK_NO_INJECT;
static bool input_injected = false;

// Snapshotted button state (computed in update, read in get_buttons)
static PDButtons snapshot_current = 0;
static PDButtons snapshot_pushed = 0;
static PDButtons snapshot_released = 0;

// Exposed-state registry
typedef enum {
    EXPOSED_INT,
    EXPOSED_FLOAT,
    EXPOSED_STRING
} exposed_type;

typedef struct {
    const char *name;
    exposed_type type;
    union {
        const int *i;
        const float *f;
        const char **s;
    } ptr;
} exposed_state_entry;

static exposed_state_entry exposed_states[PDK_E2E_MAX_EXPOSED_STATES];
static int exposed_state_count = 0;

// --- Message encoding ---

// AIDEV-NOTE: encode_message and parse helpers are pure functions over buffers,
// making them testable without the Playdate SDK. The test harness calls them
// directly via the pdk_e2e_test_* wrappers at the bottom of this file.

/**
 * Encode a protocol message into the output buffer.
 * Returns the total number of bytes written (header + payload).
 * The caller must ensure out has room for at least PDK_E2E_HEADER_SIZE + payload_len bytes.
 */
static int encode_message(uint8_t *out, uint8_t type, const uint8_t *payload, uint16_t payload_len) {
    out[0] = type;
    out[1] = (uint8_t)(payload_len >> 8);
    out[2] = (uint8_t)(payload_len & 0xFF);
    if (payload != NULL && payload_len > 0) {
        memcpy(out + PDK_E2E_HEADER_SIZE, payload, payload_len);
    }
    return PDK_E2E_HEADER_SIZE + payload_len;
}

/**
 * Send a protocol message over TCP.
 */
static void send_message(uint8_t type, const uint8_t *payload, uint16_t payload_len) {
    uint8_t header[PDK_E2E_HEADER_SIZE];
    header[0] = type;
    header[1] = (uint8_t)(payload_len >> 8);
    header[2] = (uint8_t)(payload_len & 0xFF);

    pd->network->tcp->write(tcp_conn, header, PDK_E2E_HEADER_SIZE);
    if (payload != NULL && payload_len > 0) {
        pd->network->tcp->write(tcp_conn, payload, payload_len);
    }
}

/**
 * Send an empty-payload message (PONG, INPUT_ACK, READY, STATE_NOT_FOUND).
 */
static void send_empty(uint8_t type) {
    send_message(type, NULL, 0);
}

/**
 * Send an ERROR response with a null-terminated message string.
 */
static void send_error(const char *msg) {
    uint16_t len = (uint16_t)(strlen(msg) + 1); // include null terminator
    send_message(PDK_E2E_MSG_ERROR, (const uint8_t *)msg, len);
}

// --- Message encoding for STATE_VALUE ---

static void send_state_int32(int32_t value) {
    uint8_t payload[5];
    payload[0] = PDK_E2E_STATE_INT32;
    // Little-endian int32
    payload[1] = (uint8_t)(value & 0xFF);
    payload[2] = (uint8_t)((value >> 8) & 0xFF);
    payload[3] = (uint8_t)((value >> 16) & 0xFF);
    payload[4] = (uint8_t)((value >> 24) & 0xFF);
    send_message(PDK_E2E_MSG_STATE_VALUE, payload, 5);
}

static void send_state_float32(float value) {
    uint8_t payload[5];
    payload[0] = PDK_E2E_STATE_FLOAT32;
    // Little-endian float32
    memcpy(payload + 1, &value, 4);
    send_message(PDK_E2E_MSG_STATE_VALUE, payload, 5);
}

static void send_state_string(const char *value) {
    uint16_t str_len = (uint16_t)strlen(value);
    // 1B type tag + string + null terminator
    uint16_t payload_len = 1 + str_len + 1;
    uint8_t payload[1 + 256 + 1]; // reasonable max for state strings
    if (payload_len > sizeof(payload)) {
        send_error("state string too long");
        return;
    }
    payload[0] = PDK_E2E_STATE_STRING;
    memcpy(payload + 1, value, str_len);
    payload[1 + str_len] = 0; // null terminator
    send_message(PDK_E2E_MSG_STATE_VALUE, payload, payload_len);
}

// --- Message parsing ---

/**
 * Parse result from try_parse_message.
 */
typedef struct {
    uint8_t type;
    uint16_t payload_len;
    const uint8_t *payload; // points into recv_buf
    int total_len;          // header + payload bytes consumed
} parsed_message;

/**
 * Try to parse a complete message from the receive buffer.
 * Returns true if a complete message was found, false if more data needed.
 * On true, result is filled with the parsed message details.
 */
static bool try_parse_message(const uint8_t *buf, uint16_t buf_len, parsed_message *result) {
    if (buf_len < PDK_E2E_HEADER_SIZE) {
        return false;
    }

    uint16_t payload_len = (uint16_t)((buf[1] << 8) | buf[2]);
    int total_len = PDK_E2E_HEADER_SIZE + payload_len;

    if (buf_len < total_len) {
        return false; // partial message
    }

    result->type = buf[0];
    result->payload_len = payload_len;
    result->payload = buf + PDK_E2E_HEADER_SIZE;
    result->total_len = total_len;
    return true;
}

// --- Command handlers ---

static void handle_ping(void) {
    send_empty(PDK_E2E_MSG_PONG);
}

static void handle_capture_frame(void) {
    uint8_t *framebuffer = pd->graphics->getDisplayFrame();
    if (framebuffer == NULL) {
        send_error("getDisplayFrame returned NULL");
        return;
    }
    send_message(PDK_E2E_MSG_FRAME_DATA, framebuffer, PDK_E2E_FRAME_DATA_SIZE);
}

static void handle_inject_input(const uint8_t *payload, uint16_t payload_len) {
    if (payload_len != 5) {
        send_error("INJECT_INPUT payload must be 5 bytes");
        return;
    }
    injected_buttons = (PDButtons)payload[0];
    // AIDEV-NOTE: memcpy assumes host is little-endian (matching wire format).
    // Playdate simulator runs on x86/ARM — both LE — so this holds.
    memcpy(&injected_crank, payload + 1, 4);
    input_injected = true;
    send_empty(PDK_E2E_MSG_INPUT_ACK);
}

static void handle_query_state(const uint8_t *payload, uint16_t payload_len) {
    if (payload_len < 1 || payload[payload_len - 1] != 0) {
        send_error("QUERY_STATE name must be null-terminated");
        return;
    }

    const char *name = (const char *)payload;

    for (int i = 0; i < exposed_state_count; i++) {
        if (strcmp(exposed_states[i].name, name) == 0) {
            switch (exposed_states[i].type) {
                case EXPOSED_INT:
                    send_state_int32(*exposed_states[i].ptr.i);
                    return;
                case EXPOSED_FLOAT:
                    send_state_float32(*exposed_states[i].ptr.f);
                    return;
                case EXPOSED_STRING:
                    send_state_string(*exposed_states[i].ptr.s);
                    return;
            }
        }
    }

    send_empty(PDK_E2E_MSG_STATE_NOT_FOUND);
}

static void handle_release_input(void) {
    injected_buttons = 0;
    injected_crank = PDK_E2E_CRANK_NO_INJECT;
    input_injected = false;
    send_empty(PDK_E2E_MSG_INPUT_ACK);
}

/**
 * Dispatch a parsed command to its handler.
 */
static void dispatch_command(const parsed_message *msg) {
    switch (msg->type) {
        case PDK_E2E_MSG_PING:
            handle_ping();
            break;
        case PDK_E2E_MSG_CAPTURE_FRAME:
            handle_capture_frame();
            break;
        case PDK_E2E_MSG_INJECT_INPUT:
            handle_inject_input(msg->payload, msg->payload_len);
            break;
        case PDK_E2E_MSG_QUERY_STATE:
            handle_query_state(msg->payload, msg->payload_len);
            break;
        case PDK_E2E_MSG_RELEASE_INPUT:
            handle_release_input();
            break;
        default:
            pd->system->logToConsole("pdk_e2e: unknown message type 0x%02x, skipping", msg->type);
            break;
    }
}

// --- Connection state machine callbacks ---

static void on_access_granted(int granted) {
    if (granted) {
        conn_state = PDK_E2E_STATE_ACCESS_GRANTED;
    } else {
        pd->system->logToConsole("pdk_e2e: network access denied");
        conn_state = PDK_E2E_STATE_IDLE;
    }
}

static void on_connected(int success) {
    if (success) {
        conn_state = PDK_E2E_STATE_CONNECTED;
        send_empty(PDK_E2E_MSG_READY);
        pd->system->logToConsole("pdk_e2e: connected, sent READY");
    } else {
        pd->system->logToConsole("pdk_e2e: connection failed");
        conn_state = PDK_E2E_STATE_IDLE;
    }
}

/**
 * Drive the connection state machine forward.
 * Called each frame from pdk_e2e_update() until CONNECTED.
 */
static void drive_connection(void) {
    switch (conn_state) {
        case PDK_E2E_STATE_REQUESTING_ACCESS:
            // Waiting for requestAccess callback — nothing to do
            break;

        case PDK_E2E_STATE_ACCESS_GRANTED:
            // Access granted — create connection and open
            tcp_conn = pd->network->tcp->newConnection();
            if (tcp_conn == NULL) {
                pd->system->logToConsole("pdk_e2e: failed to create TCP connection");
                conn_state = PDK_E2E_STATE_IDLE;
                return;
            }
            pd->network->tcp->open(tcp_conn, "127.0.0.1", target_port, on_connected);
            conn_state = PDK_E2E_STATE_WAITING_CONNECT;
            break;

        case PDK_E2E_STATE_WAITING_CONNECT:
            // Waiting for open callback — nothing to do
            break;

        case PDK_E2E_STATE_IDLE:
        case PDK_E2E_STATE_CONNECTED:
            break;
    }
}

// --- Snapshot button transitions ---

/**
 * Compute button transition deltas and snapshot them.
 * Called once per frame at the start of pdk_e2e_update().
 * pdk_e2e_get_buttons() reads these snapshots — multiple calls per frame
 * return consistent results.
 */
static void snapshot_buttons(void) {
    PDButtons real_current = 0, real_pushed = 0, real_released = 0;
    pd->system->getButtonState(&real_current, &real_pushed, &real_released);

    // Compute injected transitions from previous frame
    PDButtons inj_pushed = injected_buttons & ~prev_injected_buttons;
    PDButtons inj_released = prev_injected_buttons & ~injected_buttons;

    snapshot_current = real_current | injected_buttons;
    snapshot_pushed = real_pushed | inj_pushed;
    snapshot_released = real_released | inj_released;

    prev_injected_buttons = injected_buttons;
}

// --- Public API ---

void pdk_e2e_init(PlaydateAPI *playdate, int port) {
    pd = playdate;
    target_port = port;
    conn_state = PDK_E2E_STATE_REQUESTING_ACCESS;

    // Reset all state
    recv_buf_len = 0;
    injected_buttons = 0;
    prev_injected_buttons = 0;
    injected_crank = PDK_E2E_CRANK_NO_INJECT;
    input_injected = false;
    snapshot_current = 0;
    snapshot_pushed = 0;
    snapshot_released = 0;
    exposed_state_count = 0;

    pd->network->tcp->requestAccess(on_access_granted);
    pd->system->logToConsole("pdk_e2e: requesting network access (port %d)", port);
}

void pdk_e2e_update(void) {
    if (conn_state != PDK_E2E_STATE_CONNECTED) {
        drive_connection();
        return;
    }

    // Snapshot button transitions at start of frame
    snapshot_buttons();

    // Read available TCP data into receive buffer
    int available = pd->network->tcp->getBytesAvailable(tcp_conn);
    if (available < 0) {
        pd->system->logToConsole("pdk_e2e: connection lost (getBytesAvailable returned %d)", available);
        conn_state = PDK_E2E_STATE_IDLE;
        recv_buf_len = 0;
        return;
    }

    if (available > 0) {
        // Cap read to remaining buffer space
        int space = (int)sizeof(recv_buf) - recv_buf_len;
        int to_read = available < space ? available : space;
        if (to_read <= 0) {
            send_error("receive buffer full");
            recv_buf_len = 0;
            return;
        }

        int read = pd->network->tcp->read(tcp_conn, recv_buf + recv_buf_len, to_read);
        if (read < 0) {
            pd->system->logToConsole("pdk_e2e: read error (%d)", read);
            conn_state = PDK_E2E_STATE_IDLE;
            recv_buf_len = 0;
            return;
        }
        recv_buf_len += read;
    }

    // Try to parse and process ONE command
    parsed_message msg;
    if (try_parse_message(recv_buf, recv_buf_len, &msg)) {
        dispatch_command(&msg);

        // Compact buffer — shift remaining data to front
        int remaining = recv_buf_len - msg.total_len;
        if (remaining > 0) {
            memmove(recv_buf, recv_buf + msg.total_len, remaining);
        }
        recv_buf_len = remaining;
    }
}

void pdk_e2e_get_buttons(PDButtons *current, PDButtons *pushed, PDButtons *released) {
    if (current != NULL) *current = snapshot_current;
    if (pushed != NULL) *pushed = snapshot_pushed;
    if (released != NULL) *released = snapshot_released;
}

float pdk_e2e_crank(void) {
    // Exact float compare is intentional: -1.0f is exactly representable and only set via `=`
    if (injected_crank != PDK_E2E_CRANK_NO_INJECT) {
        return injected_crank;
    }
    return pd->system->getCrankAngle();
}

void pdk_e2e_expose_int(const char *name, const int *ptr) {
    if (exposed_state_count >= PDK_E2E_MAX_EXPOSED_STATES) {
        pd->system->logToConsole("pdk_e2e: exposed state registry full (%d max)", PDK_E2E_MAX_EXPOSED_STATES);
        return;
    }
    exposed_states[exposed_state_count].name = name;
    exposed_states[exposed_state_count].type = EXPOSED_INT;
    exposed_states[exposed_state_count].ptr.i = ptr;
    exposed_state_count++;
}

void pdk_e2e_expose_float(const char *name, const float *ptr) {
    if (exposed_state_count >= PDK_E2E_MAX_EXPOSED_STATES) {
        pd->system->logToConsole("pdk_e2e: exposed state registry full (%d max)", PDK_E2E_MAX_EXPOSED_STATES);
        return;
    }
    exposed_states[exposed_state_count].name = name;
    exposed_states[exposed_state_count].type = EXPOSED_FLOAT;
    exposed_states[exposed_state_count].ptr.f = ptr;
    exposed_state_count++;
}

void pdk_e2e_expose_string(const char *name, const char **ptr) {
    if (exposed_state_count >= PDK_E2E_MAX_EXPOSED_STATES) {
        pd->system->logToConsole("pdk_e2e: exposed state registry full (%d max)", PDK_E2E_MAX_EXPOSED_STATES);
        return;
    }
    exposed_states[exposed_state_count].name = name;
    exposed_states[exposed_state_count].type = EXPOSED_STRING;
    exposed_states[exposed_state_count].ptr.s = ptr;
    exposed_state_count++;
}

// --- Test-only API ---
// These wrappers expose internal functions for unit testing without the SDK.
// They are compiled into the test binary but not into game builds (the test
// Makefile defines PDK_E2E_TESTING).

#ifdef PDK_E2E_TESTING

int pdk_e2e_test_encode_message(uint8_t *out, uint8_t type, const uint8_t *payload, uint16_t payload_len) {
    return encode_message(out, type, payload, payload_len);
}

bool pdk_e2e_test_try_parse(const uint8_t *buf, uint16_t buf_len, uint8_t *out_type, uint16_t *out_payload_len, int *out_total_len) {
    parsed_message msg;
    bool ok = try_parse_message(buf, buf_len, &msg);
    if (ok) {
        *out_type = msg.type;
        *out_payload_len = msg.payload_len;
        *out_total_len = msg.total_len;
    }
    return ok;
}

// Expose button transition logic for testing without real SDK calls.
// The test provides injected_buttons directly and calls this to compute transitions.

void pdk_e2e_test_set_injected_buttons(PDButtons buttons) {
    injected_buttons = buttons;
    input_injected = true;
}

void pdk_e2e_test_clear_injection(void) {
    injected_buttons = 0;
    injected_crank = PDK_E2E_CRANK_NO_INJECT;
    input_injected = false;
}

void pdk_e2e_test_snapshot_buttons_no_real(void) {
    // Like snapshot_buttons() but without calling pd->system->getButtonState()
    // (no SDK available in tests). Only considers injected state.
    PDButtons inj_pushed = injected_buttons & ~prev_injected_buttons;
    PDButtons inj_released = prev_injected_buttons & ~injected_buttons;

    snapshot_current = injected_buttons;
    snapshot_pushed = inj_pushed;
    snapshot_released = inj_released;

    prev_injected_buttons = injected_buttons;
}

void pdk_e2e_test_get_buttons(PDButtons *current, PDButtons *pushed, PDButtons *released) {
    if (current != NULL) *current = snapshot_current;
    if (pushed != NULL) *pushed = snapshot_pushed;
    if (released != NULL) *released = snapshot_released;
}

void pdk_e2e_test_reset_button_state(void) {
    injected_buttons = 0;
    prev_injected_buttons = 0;
    injected_crank = PDK_E2E_CRANK_NO_INJECT;
    input_injected = false;
    snapshot_current = 0;
    snapshot_pushed = 0;
    snapshot_released = 0;
}

// Encode helpers for STATE_VALUE — tests verify exact byte output.

int pdk_e2e_test_encode_state_int32(uint8_t *out, int32_t value) {
    uint8_t payload[5];
    payload[0] = PDK_E2E_STATE_INT32;
    payload[1] = (uint8_t)(value & 0xFF);
    payload[2] = (uint8_t)((value >> 8) & 0xFF);
    payload[3] = (uint8_t)((value >> 16) & 0xFF);
    payload[4] = (uint8_t)((value >> 24) & 0xFF);
    return encode_message(out, PDK_E2E_MSG_STATE_VALUE, payload, 5);
}

int pdk_e2e_test_encode_state_float32(uint8_t *out, float value) {
    uint8_t payload[5];
    payload[0] = PDK_E2E_STATE_FLOAT32;
    memcpy(payload + 1, &value, 4);
    return encode_message(out, PDK_E2E_MSG_STATE_VALUE, payload, 5);
}

int pdk_e2e_test_encode_state_string(uint8_t *out, const char *value) {
    uint16_t str_len = (uint16_t)strlen(value);
    uint16_t payload_len = 1 + str_len + 1;
    uint8_t payload[258]; // 1 + 256 + 1
    payload[0] = PDK_E2E_STATE_STRING;
    memcpy(payload + 1, value, str_len);
    payload[1 + str_len] = 0;
    return encode_message(out, PDK_E2E_MSG_STATE_VALUE, payload, payload_len);
}

int pdk_e2e_test_encode_error(uint8_t *out, const char *msg) {
    uint16_t len = (uint16_t)(strlen(msg) + 1);
    return encode_message(out, PDK_E2E_MSG_ERROR, (const uint8_t *)msg, len);
}

#endif // PDK_E2E_TESTING

#endif // TARGET_SIMULATOR
