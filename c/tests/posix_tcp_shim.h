/**
 * posix_tcp_shim.h — POSIX socket implementation of PlaydateTCP.
 *
 * Allows pdk_e2e.c to run over real TCP without the Playdate simulator.
 * Used by test_integration.c to verify the C client talks correctly to
 * the TypeScript server.
 *
 * AIDEV-NOTE: macOS/Linux only. Windows would need Winsock (not in scope —
 * real simulator integration via Phase 5 will handle cross-platform).
 */

#ifndef POSIX_TCP_SHIM_H
#define POSIX_TCP_SHIM_H

#include <stdbool.h>

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

#include "stubs/pd_api.h"

// --- Socket-backed PDTCPConnection ---

struct PDTCPConnection {
    int fd;
};

static struct PDTCPConnection shim_conn_storage;

static PDTCPConnection *shim_tcp_new_connection(void) {
    shim_conn_storage.fd = -1;
    return &shim_conn_storage;
}

// AIDEV-NOTE: The real SDK's open() is async — the callback fires on a
// subsequent frame, AFTER open() returns. pdk_e2e.c relies on this:
// drive_connection() sets conn_state = WAITING_CONNECT after calling open().
// If we call cb() synchronously inside open(), the callback sets state to
// CONNECTED, which then gets overwritten to WAITING_CONNECT → deadlock.
//
// Fix: defer the callback. open() does the connect() but stores the result.
// The main loop calls shim_tcp_poll() before pdk_e2e_update() to fire it.

static PDConnectCallback shim_deferred_connect_cb = NULL;
static int shim_deferred_connect_result = 0;

static void shim_tcp_open(PDTCPConnection *conn, const char *host, int port,
                          PDConnectCallback cb) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        shim_deferred_connect_cb = cb;
        shim_deferred_connect_result = 0;
        return;
    }

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    inet_pton(AF_INET, host, &addr.sin_addr);

    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd);
        shim_deferred_connect_cb = cb;
        shim_deferred_connect_result = 0;
        return;
    }

    conn->fd = fd;
    shim_deferred_connect_cb = cb;
    shim_deferred_connect_result = 1;
}

/**
 * Fire any deferred callbacks. Call before pdk_e2e_update() each frame.
 */
static void shim_tcp_poll(void) {
    if (shim_deferred_connect_cb != NULL) {
        PDConnectCallback cb = shim_deferred_connect_cb;
        shim_deferred_connect_cb = NULL;
        cb(shim_deferred_connect_result);
    }
}

static void shim_tcp_request_access(PDAccessCallback cb) {
    cb(1); // always grant
}

static int shim_tcp_get_bytes_available(PDTCPConnection *conn) {
    if (conn->fd < 0)
        return -1;
    int available = 0;
    if (ioctl(conn->fd, FIONREAD, &available) < 0)
        return -1;
    return available;
}

static int shim_tcp_read(PDTCPConnection *conn, void *buf, int len) {
    if (conn->fd < 0)
        return -1;
    ssize_t n = recv(conn->fd, buf, (size_t)len, 0);
    if (n < 0)
        return -1;
    return (int)n;
}

static int shim_tcp_write(PDTCPConnection *conn, const void *buf, int len) {
    if (conn->fd < 0)
        return -1;
    ssize_t n = send(conn->fd, buf, (size_t)len, 0);
    if (n < 0)
        return -1;
    return (int)n;
}

static void shim_tcp_close(PDTCPConnection *conn) {
    if (conn->fd >= 0) {
        close(conn->fd);
        conn->fd = -1;
    }
}

// --- Stub PlaydateSystem ---

static void shim_log(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fprintf(stderr, "\n");
}

static void shim_error(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "FATAL: ");
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fprintf(stderr, "\n");
    exit(1);
}

// --- Stub button/crank state ---

static PDButtons shim_real_buttons = 0;

static void shim_get_button_state(PDButtons *current, PDButtons *pushed, PDButtons *released) {
    if (current != NULL)
        *current = shim_real_buttons;
    if (pushed != NULL)
        *pushed = 0;
    if (released != NULL)
        *released = 0;
}

static float shim_get_crank_angle(void) {
    return 0.0f;
}

// --- Stub framebuffer ---
// 52 bytes/row x 240 rows = 12480 bytes
// Fill with a known test pattern: alternating 0xAA / 0x55 rows

static uint8_t shim_framebuffer[12480];
static bool shim_framebuffer_initialized = false;

static void shim_init_framebuffer(void) {
    if (shim_framebuffer_initialized)
        return;
    for (int row = 0; row < 240; row++) {
        uint8_t fill = (row % 2 == 0) ? 0xAA : 0x55;
        memset(shim_framebuffer + (size_t)row * 52, fill, 52);
    }
    shim_framebuffer_initialized = true;
}

static uint8_t *shim_get_display_frame(void) {
    shim_init_framebuffer();
    return shim_framebuffer;
}

// --- Assemble PlaydateAPI ---

static PlaydateTCP shim_tcp = {
    .newConnection = shim_tcp_new_connection,
    .open = shim_tcp_open,
    .requestAccess = shim_tcp_request_access,
    .getBytesAvailable = shim_tcp_get_bytes_available,
    .read = shim_tcp_read,
    .write = shim_tcp_write,
    .close = shim_tcp_close,
};

static PlaydateNetwork shim_network = {.tcp = &shim_tcp};

static PlaydateSystem shim_system = {
    .getButtonState = shim_get_button_state,
    .getCrankAngle = shim_get_crank_angle,
    .logToConsole = shim_log,
    .error = shim_error,
};

static PlaydateGraphics shim_graphics = {
    .getDisplayFrame = shim_get_display_frame,
};

static PlaydateAPI shim_pd = {
    .system = &shim_system,
    .graphics = &shim_graphics,
    .network = &shim_network,
};

#endif // POSIX_TCP_SHIM_H
