/**
 * test_integration.c — Standalone C binary for integration tests.
 *
 * Implements a minimal "game" that connects to the TypeScript TCP server
 * using POSIX sockets (via posix_tcp_shim.h) and runs the pdk_e2e state
 * machine. The TypeScript test spawns this binary, sends protocol commands,
 * and verifies the C side responds correctly.
 *
 * Usage: ./test_integration <port>
 *
 * The binary:
 *  1. Calls pdk_e2e_init() with the given port
 *  2. Exposes test state: int "score", float "speed", string "name"
 *  3. Loops pdk_e2e_update() until the TCP connection drops
 *  4. Exits 0 on clean disconnect
 *
 * AIDEV-NOTE: This is NOT a test that asserts things. It is a test harness —
 * the assertions live in the TypeScript integration.test.ts file.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "posix_tcp_shim.h"

#include "../../pdk_e2e.h"

// --- Exposed test state ---

static int test_score = 42;
static float test_speed = 3.14f;
static const char *test_name = "alice";

int main(int argc, char *argv[]) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s <port>\n", argv[0]);
        return 1;
    }

    int port = atoi(argv[1]);
    if (port <= 0 || port > 65535) {
        fprintf(stderr, "invalid port: %s\n", argv[1]);
        return 1;
    }

    // pdk_e2e_init calls requestAccess (immediate grant in shim), then
    // drive_connection on subsequent update() calls does open().
    pdk_e2e_init(&shim_pd, port);

    // Expose test state for QUERY_STATE verification
    pdk_e2e_expose_int("score", &test_score);
    pdk_e2e_expose_float("speed", &test_speed);
    pdk_e2e_expose_string("name", &test_name);

    // Simulate game loop: call update() repeatedly.
    // pdk_e2e_update() drives the connection state machine and processes
    // one command per call. We loop until the connection drops.
    //
    // AIDEV-NOTE: The shim's getBytesAvailable returns -1 when the socket
    // is closed by the TS side, which causes pdk_e2e_update() to set
    // conn_state = IDLE. We detect this by checking if shim_conn_storage.fd
    // becomes -1 after having been connected.

    bool was_connected = false;
    int idle_after_connect = 0;

    for (;;) {
        // Fire deferred callbacks (e.g. connect callback from open())
        // before update(), matching the real SDK's async behavior.
        shim_tcp_poll();
        pdk_e2e_update();

        // Detect connection established
        if (!was_connected && shim_conn_storage.fd >= 0) {
            was_connected = true;
        }

        // After connection, if getBytesAvailable returns -1 or the socket
        // was closed, pdk_e2e sets conn_state to IDLE. We detect this
        // indirectly: if we were connected and now getBytesAvailable returns
        // -1, the TS side has closed the connection.
        if (was_connected) {
            int avail = shim_tcp_get_bytes_available(&shim_conn_storage);
            if (avail < 0) {
                idle_after_connect++;
                // Give a few frames for any final processing
                if (idle_after_connect > 3) {
                    break;
                }
            } else {
                idle_after_connect = 0;
            }
        }

        // Small sleep to avoid busy-spinning (1ms)
        usleep(1000);
    }

    fprintf(stderr, "test_integration: clean exit\n");
    return 0;
}
